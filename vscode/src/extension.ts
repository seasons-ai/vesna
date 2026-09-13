/**
 * The extension host: one server per window, the chat view, the status bar,
 * the commands. Everything that can be pure lives next door (`state.ts`,
 * `server.ts`, `status.ts`, `settings.ts`); this file is the wiring.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { diagnostics } from "./diagnostics";
import { applyDiagnostics } from "./diagnosticsView";
import { GARDEN_VIEW_ID, GardenProvider } from "./gardenView";
import { ServerLink } from "./link";
import { CHAT_VIEW_ID, VesnaPanel } from "./panel";
import type { Notification, State } from "./protocol";
import { DEACTIVATE_CEILING_MS, type Spawner } from "./server";
import { readSettings } from "./settings";
import { createStore, type Store } from "./state";
import { CYCLE_MODE_COMMAND, wireStatusBar } from "./status";
import { NEXT_MODE, WORDS } from "./words";

const spawner: Spawner = (command, args, opts) => spawn(command, args, opts);

let link: ServerLink | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const store = createStore();
  const version = String((context.extension.packageJSON as { version?: string }).version ?? "0.0.0");
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = folders[0];
  const root = folder?.uri.fsPath ?? null;

  const panel = new VesnaPanel(context.extensionUri, store, {
    client: () => link?.current() ?? null,
    restart: () => link?.restart() ?? Promise.resolve(),
  });

  const onNotification = (n: Notification): void => {
    store.dispatch({ kind: "notification", n });
    if (n.method === "transcript" && n.params.kind === "user") panel.turnStartedIfQueued(n.params.text);
  };

  if (root !== null && folder !== undefined) {
    link = new ServerLink({
      root,
      extensionVersion: version,
      store,
      onNotification,
      spawn: spawner,
      // The folder's own settings: `vesna.command`/`vesna.args` are
      // resource-scoped, and a multi-root workspace's first folder may name
      // a different command than the window does.
      settings: () => {
        const configuration = vscode.workspace.getConfiguration("vesna", folder.uri);
        return readSettings((key) => configuration.get(key));
      },
    });
  }
  if (folders.length > 1 && folder !== undefined) store.dispatch({ kind: "note", text: WORDS.multiRoot(folder.name) });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, panel, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  const statusItem = vscode.window.createStatusBarItem("vesna.mode", vscode.StatusBarAlignment.Left, 50);
  statusItem.name = WORDS.appName;
  const unwire = wireStatusBar(statusItem, store);
  context.subscriptions.push(statusItem, { dispose: unwire });

  // The garden and the findings follow `state` the same way the status bar
  // does: every `state` notification (the handshake's included, so a restart
  // redraws too) replaces `model.state`, and each new one is drawn once.
  const garden = new GardenProvider(vscode);
  const findings = vscode.languages.createDiagnosticCollection("vesna");
  const drawEditor = (state: State | null): void => {
    garden.refresh(state);
    applyDiagnostics(findings, state === null ? [] : diagnostics(state), existsSync);
  };
  let drawn: State | null = store.model.state;
  drawEditor(drawn);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(GARDEN_VIEW_ID, garden),
    garden,
    findings,
    {
      dispose: store.subscribe((model) => {
        if (model.state === drawn) return;
        drawn = model.state;
        drawEditor(drawn);
      }),
    },
  );

  registerCommands(context, store, panel, root, () => drawEditor(store.model.state));

  // `when: vesna.building` gates Build against Cancel in the garden's title.
  const building = (value: boolean): void => void vscode.commands.executeCommand("setContext", "vesna.building", value);
  building(false);
  context.subscriptions.push({ dispose: store.subscribe((model) => building(model.state?.building === true)) });

  if (root === null) store.dispatch({ kind: "server", status: { kind: "noFolder" } });
  else void link?.start();
}

/** VS Code gives this about five seconds: the server is asked to leave and killed inside three. */
export async function deactivate(): Promise<void> {
  const current = link;
  link = null;
  if (current !== null) await current.stop(DEACTIVATE_CEILING_MS);
}

// ---------------------------------------------------------------------------
// Commands

function registerCommands(
  context: vscode.ExtensionContext,
  store: Store,
  panel: VesnaPanel,
  root: string | null,
  redrawEditor: () => void,
): void {
  /** A command line for the server, or a notice in the panel when there is no server to take it. */
  const command = (name: string, argument: string): void => {
    const client = link?.current() ?? null;
    if (client === null) {
      notice(store, WORDS.notRunning);
      return;
    }
    client.command(name, argument).catch((error: unknown) => notice(store, (error as Error)?.message ?? String(error), "error"));
  };

  const openArtefact = async (file: "spec.md" | "plan.md"): Promise<void> => {
    const state = store.model.state;
    const slug = state?.specSlug ?? state?.spec?.id ?? null;
    if (state === null || slug === null) {
      notice(store, WORDS.noSpecOpen);
      return;
    }
    const path = join(state.root, ".vesna", "specs", slug, file);
    await vscode.window.showTextDocument(vscode.Uri.file(path));
  };

  const commands: Record<string, (argument?: unknown) => void | Promise<void>> = {
    "vesna.newSpec": async () => {
      const title = await vscode.window.showInputBox({ prompt: WORDS.newSpecPrompt, ignoreFocusOut: true });
      if (title === undefined || title.trim() === "") return;
      command("spec", `new ${title.trim()}`);
    },
    "vesna.openSpec": async () => {
      const slugs = await listSpecs(store.model.state?.root ?? root);
      if (slugs.length === 0) {
        notice(store, WORDS.noSpecs);
        return;
      }
      const slug = await vscode.window.showQuickPick(slugs, { placeHolder: WORDS.openSpecPrompt });
      if (slug === undefined) return;
      command("spec", `open ${slug}`);
    },
    "vesna.approveSpec": () => command("approve", "spec"),
    "vesna.approvePlan": () => command("approve", "plan"),
    "vesna.build": () => command("build", ""),
    "vesna.cancelBuild": () => command("build", "cancel"),
    "vesna.restart": async () => {
      if (link === null) {
        notice(store, WORDS.noFolder);
        return;
      }
      await link.restart();
    },
    "vesna.openSpecMd": () => openArtefact("spec.md"),
    "vesna.openPlanMd": () => openArtefact("plan.md"),
    "vesna.showPanel": () => panel.focus(),
    // Refresh redraws the garden and the findings from the last state; Retry
    // runs the `build retry <id>` a task node carries (see `garden.ts` `Node.command`).
    "vesna.refreshGarden": () => redrawEditor(),
    "vesna.retryTask": (node) => {
      const carried = (node as { command?: { name: string; argument: string } } | undefined)?.command;
      if (carried !== undefined) command(carried.name, carried.argument);
    },
    [CYCLE_MODE_COMMAND]: () => {
      const mode = store.model.state?.mode;
      if (mode === undefined) return;
      command("mode", NEXT_MODE[mode]);
    },
  };
  for (const [id, run] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, (argument?: unknown) => void run(argument)));
  }
}

function notice(store: Store, text: string, level: "warn" | "error" = "warn"): void {
  store.dispatch({ kind: "notification", n: { method: "transcript", params: { kind: "notice", text, level } } });
}

/** The folder names under `<root>/.vesna/specs/`, sorted — `[]` when there is no such folder. */
async function listSpecs(root: string | null): Promise<string[]> {
  if (root === null) return [];
  try {
    const entries = await readdir(join(root, ".vesna", "specs"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
