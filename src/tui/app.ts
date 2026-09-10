import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { applyParameters } from "../crystallize/apply";
import { proposeFlow } from "../crystallize/propose";
import { CHAT_COMMANDS, describeProviders, parseChatInput, switchFailed, switchOutcome } from "../cli/chatcmd";
import { describeDropped } from "../cli/dropped";
import { EXIT } from "../cli/exit";
import { formatParameter } from "../cli/format";
import { settingsPath, writeSettings } from "../cli/settings";
import { carryHistory } from "../loop/carry";
import { createSession, type Session } from "../loop/session";
import { findPreset } from "../providers/catalog";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import type { TraceStore } from "../store/types";
import { permits, type VesnaConfig } from "../cli/config";
import type { ProviderHandle } from "../cli/context";
import { createEditor, applyKey, type EditorState } from "./editor";
import { emptyState } from "./emptystate";
import { resolveGlyphs, type Glyphs } from "./glyphs";
import { decodeKeys, type Key } from "./keys";
import { layout, panelWidths, type Frame, type ViewState } from "./layout";
import { chatsPane, gardenPane } from "./panes";
import { createSpec, listSpecs, readSpec, specsRoot } from "../spec/store";
import type { SpecTree } from "../spec/project";
import type { SpecSink } from "../spec/sink";
import { wrapAnsi } from "./wrap";
import { spinnerFrame } from "./render";
import { createScreen, type Terminal } from "./screen";
import { resolveTheme, themeNames, type Theme } from "./theme";
import { copyToClipboard, systemCopyIo } from "./clipboard";
import { decide, facetOf, MODES, type Mode, type Policy } from "../policy/decide";
import { rememberAllow, suggestPattern } from "../policy/store";
import {
  listSessions,
  listSessionsSync,
  readSession,
  type OpenSession,
  type SessionEvent,
  type SessionSummary,
} from "../store/sessions";
import type { AgentMessage } from "../providers/types";
import { createTranscript, type Transcript } from "./transcript";

export interface AppDeps {
  registry: Registry;
  provider: Provider;
  store: TraceStore;
  config: VesnaConfig;
  theme: Theme;
  root: string;
  /** The project's own instructions, from .vesna/AGENTS.md. */
  notes?: string;
  /** Puts text on the clipboard. Injected so a test never touches the real one. */
  copy?: (text: string) => void | Promise<void>;
  /** Where this conversation is written down as it happens. */
  record?: OpenSession;
  /** Prior turns, when this run resumed a stored conversation. */
  resumed?: AgentMessage[];
  /** Where conversations are stored, for /history and /resume. */
  sessionsRoot?: string;
  /** Which actions may proceed without asking. */
  policy?: Policy;
  /** Where the plan nodes write. Told which spec is open. */
  sink?: SpecSink;
  /** Where `/provider` writes the machine-wide default. Defaults to the real environment and home. */
  env?: Record<string, string | undefined>;
  home?: string;
}

export interface AppIo {
  terminal: Terminal;
  /** Raw terminal input. Chunks may split escape sequences. */
  input: AsyncIterable<string>;
  setRawMode?(enabled: boolean): void;
  /** Returns an unsubscribe function. */
  onResize?(handler: () => void): () => void;
}

/** One notch of the wheel. */
const WHEEL_LINES = 3;

/** How far page-up moves, as a fraction of the visible conversation. */
const PAGE_FRACTION = 0.8;

export async function runApp(deps: AppDeps, io: AppIo): Promise<number> {
  let theme = deps.theme;
  const glyphs = resolveGlyphs(process.env, deps.config.ascii);
  const screen = createScreen(io.terminal, {
    surface: theme.surface,
    mouse: deps.config.mouse !== false,
  });
  const transcript = createTranscript(theme, glyphs);

  let editor = createEditor();
  let session = newSession(deps, approve, deps.resumed);
  let scroll = 0;
  let busy = false;
  let tick = 0;
  let quitting = false;
  let confirmExit = false;
  let turn: AbortController | null = null;

  const submissions = createQueue<string>();

  // The frame a click lands on is the one the user is looking at, so the
  // mapping from row to message has to be the one most recently drawn.
  let shown: Frame | null = null;

  const draw = () => {
    if (quitting) return;
    shown = layout(currentView(), screen.size());
    screen.draw(shown);
  };

  /** Never scroll past the top, and never past the newest line. */
  function clampScroll(next: number): number {
    const size = screen.size();
    const wrapped = transcript
      .lines(Math.max(1, size.cols))
      .flatMap((line) => wrapAnsi(line, Math.max(1, size.cols)));
    const visible = conversationRows(size.rows);
    return Math.max(0, Math.min(next, Math.max(0, wrapped.length - visible)));
  }

  function currentView(): ViewState {
    const size = screen.size();
    const widths = panelWidths(size.cols, {
      left: showChats,
      // Nothing to show is not a column: the conversation takes the room.
      right: showGarden && spec !== null,
    });
    const paneRows = Math.max(0, size.rows);

    return {
      ...(widths.right > 0 && spec !== null
        ? {
            right: gardenPane(spec, {
              theme,
              glyphs,
              width: widths.right,
              rows: paneRows,
            }),
          }
        : {}),
      ...(widths.left > 0
        ? {
            left: chatsPane(chats, deps.record?.id, deps.root, {
              theme,
              glyphs,
              width: widths.left,
              rows: paneRows,
            }),
          }
        : {}),
      header: header(deps, theme, glyphs),
      transcript: transcript.lines(Math.max(1, size.cols)),
      targets: transcript.copyTargets(Math.max(1, size.cols)),
      empty: emptyState({ theme, glyphs, cols: size.cols, rows: size.rows }),
      editor,
      hint: hint(theme, busy, confirmExit, glyphs),
      status: status(theme, session, busy, tick, glyphs, policy.mode),
      scroll,
      panel: theme.panel,
      // The layout paints its own rule, prompt and input text through this,
      // rather than importing the theme and giving up its purity.
      paint: (role, text) => theme.paint(role, text),
      glyphs,
    };
  }

  /** Changes how much the agent may do without asking. */
  function setMode(mode: Mode): void {
    policy = { ...policy, mode };
    transcript.notice(`mode: ${mode}  ${MODE_HELP[mode]}`, "ok");
    draw();
  }

  /** Swaps the palette everywhere it shows. False when the name is unknown. */
  function applyTheme(name: string): boolean {
    if (!themeNames().includes(name)) return false;
    theme = resolveTheme(name, { depth: deps.theme.depth });
    transcript.setTheme(theme, glyphs);
    screen.setSurface(theme.surface);
    draw();
    return true;
  }

  /** Never lets a write to disk take the conversation down with it. */
  function remember(event: SessionEvent): void {
    void deps.record?.append(event).catch(() => {});
  }

  // While a question is on screen the next key answers it, rather than being
  // typed into a box the user cannot see behind the question.
  let awaiting: ((answer: string) => void) | null = null;
  let policy: Policy = deps.policy ?? { mode: "ask", allow: {}, deny: {} };

  // The left column is asked for; the right one shows the work in hand.
  let showChats = false;
  let chats: SessionSummary[] = [];
  let showGarden = true;
  let spec: SpecTree | null = null;

  const specs = specsRoot(deps.root);

  function openSpec(slug: string): boolean {
    const tree = readSpec(specs, slug);
    if (tree === null) return false;
    spec = tree;
    showGarden = true;
    // The nodes write to whichever spec the user is looking at.
    if (deps.sink !== undefined) deps.sink.slug = slug;
    return true;
  }

  /**
   * The tree is the log reduced, so it is re-read rather than patched. It also
   * picks up a spec the agent opened for itself: planning is what makes the
   * column appear, and the user should not have had to know a command first.
   */
  function refreshSpec(): void {
    const slug = deps.sink?.slug;
    if (slug !== undefined && slug !== null && spec?.id !== slug) {
      const opened = readSpec(specs, slug);
      if (opened !== null) {
        spec = opened;
        showGarden = true;
        transcript.notice(`plan: ${opened.title}  (ctrl-g hides it)`, "ok");
        return;
      }
    }
    if (spec !== null) spec = readSpec(specs, spec.id) ?? spec;
  }

  function refreshChats(): void {
    if (deps.sessionsRoot === undefined) return;
    chats = listSessionsSync(deps.sessionsRoot, { cwd: deps.root });
  }

  function toggleChats(): void {
    showChats = !showChats;
    if (showChats) refreshChats();
    draw();
  }

  /**
   * Asks before an action, and remembers the answer when told to.
   *
   * The remembered rule covers the directory or the command rather than the
   * one file: a rule that answers only this exact path asks again on the next
   * file beside it, which teaches the user to stop reading the question.
   */
  async function approve(action: {
    node: string;
    input: Record<string, unknown>;
    cwd: string;
    effect?: "pure" | "write" | "external";
  }): Promise<"allow" | "deny"> {
    const verdict = decide(action, policy, deps.root);
    if (verdict === "allow") return "allow";
    if (verdict === "deny") {
      transcript.notice(
        policy.mode === "plan"
          ? `${action.node} refused: plan mode changes nothing — shift-tab to leave it`
          : `refused by policy: ${action.node}`,
        "warn",
      );
      draw();
      return "deny";
    }

    const facet = facetOf(action, deps.root) ?? "";
    const pattern = facet === "" ? "" : suggestPattern(action.node, facet);

    transcript.notice(`${action.node}  ${facet}`, "warn");
    transcript.notice(
      pattern === ""
        ? "[y] allow   [n] refuse"
        : `[y] allow once   [a] always ${pattern}   [n] refuse`,
      "muted",
    );
    draw();

    const answer = await new Promise<string>((resolve) => {
      awaiting = resolve;
    });
    awaiting = null;

    if (answer === "a" && pattern === "") {
      transcript.notice("allowed once — there is nothing here to make a rule from", "ok");
      draw();
      return "allow";
    }

    if (answer === "a") {
      policy = {
        ...policy,
        allow: { ...policy.allow, [action.node]: [...(policy.allow[action.node] ?? []), pattern] },
      };
      void rememberAllow(deps.root, action.node, pattern).catch(() => {});
      transcript.notice(`allowed, and remembered: ${pattern}`, "ok");
      draw();
      return "allow";
    }
    if (answer === "y") {
      transcript.notice("allowed once", "ok");
      draw();
      return "allow";
    }

    transcript.notice("refused", "warn");
    draw();
    return "deny";
  }

  function specCommand(argument: string): void {
    const [verb, ...rest] = argument.trim().split(/\s+/);
    const name = rest.join(" ");

    if (verb === "new") {
      if (name === "") {
        transcript.notice("/spec new <name>", "warn");
        return;
      }
      try {
        const made = createSpec(specs, name);
        openSpec(made.slug);
        transcript.notice(`spec ${made.slug}`, "ok");
      } catch (error) {
        transcript.notice((error as Error).message, "warn");
      }
      return;
    }

    if (verb === "open") {
      if (!openSpec(name)) {
        transcript.notice(`no spec called "${name}" — /spec for the list`, "warn");
        return;
      }
      transcript.notice(`spec ${name}`, "ok");
      return;
    }

    const found = listSpecs(specs);
    if (found.length === 0) {
      transcript.notice("no specs yet — /spec new <name>", "muted");
      return;
    }
    for (const entry of found) {
      const here = spec?.id === entry.slug;
      transcript.notice(`${here ? "* " : "  "}${entry.slug}  ${entry.title}`, here ? "ok" : "muted");
    }
    transcript.notice("/spec open <slug>", "muted");
  }

  /** The last listing, so /resume can take a number rather than an id. */
  let listed: SessionSummary[] = [];

  async function showHistory(argument: string): Promise<void> {
    const root = deps.sessionsRoot;
    if (root === undefined) {
      transcript.notice("history is not available in this session", "warn");
      return;
    }

    const everywhere = argument.trim() === "all";
    const all = await listSessions(root, everywhere ? {} : { cwd: deps.root });
    // Resuming the conversation you are already having is not a thing.
    listed = all.filter((entry) => entry.id !== deps.record?.id);

    if (listed.length === 0) {
      transcript.notice(
        everywhere ? "no conversations yet" : "no conversations from this folder — /history all",
        "muted",
      );
      return;
    }

    transcript.notice(everywhere ? "all folders" : deps.root, "muted");
    for (const [index, entry] of listed.entries()) {
      const when = entry.updatedAt.slice(0, 16).replace("T", " ");
      const cost = entry.costUsd > 0 ? `  $${entry.costUsd.toFixed(2)}` : "";
      transcript.notice(
        `${String(index + 1).padStart(2)}  ${when}  ${entry.title}${cost}`,
        "muted",
      );
    }
    transcript.notice(`/resume <number> to reopen${everywhere ? "" : " · /history all"}`, "muted");
  }

  async function resume(argument: string): Promise<void> {
    const which = Number.parseInt(argument.trim(), 10);
    if (Number.isNaN(which) || listed[which - 1] === undefined) {
      transcript.notice("/resume <number> from the last /history listing", "warn");
      return;
    }
    await resumeById(listed[which - 1]!.id);
  }

  /** Reopening by id, whether that came from a listing or from a click. */
  async function resumeById(id: string): Promise<void> {
    const root = deps.sessionsRoot;
    if (root === undefined) {
      transcript.notice("history is not available in this session", "warn");
      return;
    }

    const stored = await readSession(root, id);
    if (stored === null) {
      transcript.notice("that conversation is no longer on disk", "warn");
      return;
    }

    // Rebuilt rather than summarised: the screen shows what was said, and the
    // model is seeded with the messages it actually saw.
    transcript.clear();
    const messages: AgentMessage[] = [];
    for (const event of stored.events) {
      if (event.t === "user") transcript.user(event.text);
      else if (event.t === "answer") {
        transcript.delta(event.raw);
        transcript.endTurn();
      } else if (event.t === "step") {
        transcript.step(event.nodeType, event.durationMs, event.detail);
      } else if (event.t === "messages") messages.push(...event.added);
    }

    session = newSession(deps, approve, messages);
    scroll = 0;
    showChats = false;
    transcript.notice(`resumed · ${stored.summary.title}`, "ok");
    // Called straight from a click as well as from the command loop, so it
    // cannot rely on someone else redrawing afterwards.
    draw();
  }

  async function copy(text: string): Promise<void> {
    try {
      await (deps.copy ?? defaultCopy)(text);
      transcript.notice("copied", "ok");
    } catch (error) {
      transcript.notice(`could not copy: ${(error as Error).message}`, "error");
    }
    draw();
  }

  function dispatch(key: Key): void {
    // A question owns the keyboard until it is answered. Only the three
    // answers decide: a stray key must not refuse an action by accident.
    if (awaiting !== null) {
      const typed = key.type === "text" ? key.text.trim().slice(0, 1).toLowerCase() : "";
      const answer =
        typed === "y" || typed === "a" || typed === "n"
          ? typed
          : key.type === "interrupt" || key.type === "escape"
            ? "n"
            : key.type === "enter"
              ? "y"
              : "";
      if (answer !== "") awaiting(answer);
      return;
    }

    if (key.type !== "interrupt") confirmExit = false;

    switch (key.type) {
      case "interrupt":
        if (turn !== null) {
          turn.abort();
          return;
        }
        if (editor.text !== "") {
          editor = createEditor(editor.history);
          draw();
          return;
        }
        if (confirmExit) {
          quitting = true;
          submissions.close();
          return;
        }
        confirmExit = true;
        draw();
        return;

      case "eof":
        if (editor.text === "" && turn === null) {
          quitting = true;
          submissions.close();
        }
        return;

      case "click": {
        const column = key.column;
        const target =
          column < (shown?.columns.left ?? 0)
            ? shown?.leftTargets?.[key.row]
            : column >= (shown?.columns.right ?? Number.MAX_SAFE_INTEGER)
              ? shown?.rightTargets?.[key.row]
              : shown?.targets?.[key.row];

        if (target === undefined) return;
        if (target.startsWith("session:")) {
          void resumeById(target.slice("session:".length));
          return;
        }
        const text = transcript.rawOf(target);
        if (text !== undefined) void copy(text);
        return;
      }

      case "wheel-up":
      case "wheel-down": {
        // Three lines a notch: what every other scrollable surface does.
        const step = key.type === "wheel-up" ? WHEEL_LINES : -WHEEL_LINES;
        scroll = clampScroll(scroll + step);
        draw();
        return;
      }

      case "page-up":
      case "page-down": {
        const page = Math.max(1, Math.floor(conversationRows(screen.size().rows) * PAGE_FRACTION));
        scroll = clampScroll(scroll + (key.type === "page-up" ? page : -page));
        draw();
        return;
      }

      case "panel-left":
        toggleChats();
        return;

      case "cycle-mode": {
        const next = MODES[(MODES.indexOf(policy.mode) + 1) % MODES.length]!;
        setMode(next);
        return;
      }

      case "panel-right":
        showGarden = !showGarden;
        draw();
        return;

      case "escape":
        if (turn !== null) turn.abort();
        return;

      default: {
        const applied = applyKey(editor, key);
        editor = applied.state;
        // Typing means the user is done reading back; snap to the newest.
        if (applied.submit !== undefined) {
          scroll = 0;
          submissions.push(applied.submit);
        }
        draw();
      }
    }
  }

  io.setRawMode?.(true);
  screen.enter();
  const stopResize = io.onResize?.(draw);
  draw();

  // Input is read alongside the turn in progress: an interrupt that only
  // arrived after the answer finished would not be an interrupt.
  const reading = (async () => {
    let carry = "";
    for await (const chunk of io.input) {
      const decoded = decodeKeys(carry + chunk);
      carry = decoded.rest;
      for (const key of decoded.keys) dispatch(key);
      if (quitting) break;
    }
    submissions.close();
  })();

  try {
    while (true) {
      const line = await submissions.take();
      if (line === null) break;
      const input = parseChatInput(line);

      if (input.kind === "blank") continue;
      if (input.kind === "unknown") {
        transcript.user(line);
        transcript.notice(`unknown command /${input.name} - try /help`, "warn");
        transcript.endTurn();
        draw();
        continue;
      }

      transcript.user(line);
      // A slash command is control, not conversation: recording it would make
      // "/history" the title of the session and put it in its own listing.
      if (input.kind === "message") remember({ t: "user", text: line });
      draw();

      if (input.kind === "command") {
        if (input.name === "exit") break;

        if (input.name === "mode") {
          const wanted = input.argument.trim();
          if ((MODES as readonly string[]).includes(wanted)) setMode(wanted as Mode);
          else transcript.notice(`/mode plan, ask or auto — not "${wanted}"`, "warn");
          transcript.endTurn();
          draw();
          continue;
        }

        if (input.name === "spec") {
          specCommand(input.argument);
          transcript.endTurn();
          draw();
          continue;
        }

        if (input.name === "chats") {
          toggleChats();
          continue;
        }

        if (input.name === "history") {
          await showHistory(input.argument);
          transcript.endTurn();
          draw();
          continue;
        }

        if (input.name === "resume") {
          await resume(input.argument);
          transcript.endTurn();
          draw();
          continue;
        }

        session = await command(
          input.name,
          input.argument,
          deps,
          session,
          transcript,
          glyphs,
          copy,
          theme,
          applyTheme,
          (messages) => newSession(deps, approve, messages),
        );
        transcript.endTurn();
        draw();
        continue;
      }

      busy = true;
      turn = new AbortController();
      const spinner = setInterval(() => {
        tick += 1;
        draw();
      }, 90);

      const before = session.messages.length;
      try {
        await runTurn(session, input.text, transcript, turn.signal, draw, remember, refreshSpec);
      } catch (error) {
        // An abort is the user's own doing, and reads as a warning. A provider
        // that fell over is a failure, and gets the colour that says so.
        const aborted = turn.signal.aborted;
        transcript.notice(
          aborted ? "interrupted" : (error as Error).message,
          aborted ? "warn" : "error",
        );
      } finally {
        clearInterval(spinner);
        turn = null;
        busy = false;

        const answer = transcript.lastAnswer();
        if (answer !== undefined) remember({ t: "answer", raw: answer });
        const added = session.messages.slice(before);
        if (added.length > 0) remember({ t: "messages", added });
        remember({
          t: "usage",
          inputTokens: session.usage.inputTokens,
          outputTokens: session.usage.outputTokens,
          costUsd: session.costUsd,
        });

        refreshSpec();
        transcript.endTurn();
        draw();
      }
    }
  } finally {
    quitting = true;
    stopResize?.();
    screen.leave();
    io.setRawMode?.(false);
    submissions.close();
    await Promise.race([reading, Promise.resolve()]);
  }

  return EXIT.ok;
}

async function runTurn(
  session: Session,
  text: string,
  transcript: Transcript,
  signal: AbortSignal,
  draw: () => void,
  onRecord: (event: SessionEvent) => void,
  onSpecChanged: () => void,
): Promise<void> {
  let streamed = false;
  const result = await session.send(text, {
    signal,
    onText(delta) {
      streamed = true;
      transcript.delta(delta);
      draw();
    },
    onStep(step) {
      transcript.step(step.nodeType, step.durationMs, detailOf(step.input));
      onSpecChanged();
      onRecord({
        t: "step",
        nodeType: step.nodeType,
        durationMs: step.durationMs,
        ...(detailOf(step.input) ? { detail: detailOf(step.input)! } : {}),
      });
      draw();
    },
  });

  // A provider that does not stream never called onText.
  if (!streamed && result.text) transcript.delta(result.text);
}

/** The one field worth showing next to a step, when there is an obvious one. */
function detailOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const field of ["path", "pattern", "command", "name"]) {
    const value = record[field];
    if (typeof value === "string" && value !== "") {
      return value.length > 48 ? `${value.slice(0, 45)}...` : value;
    }
  }
  return undefined;
}

async function command(
  name: string,
  argument: string,
  deps: AppDeps,
  session: Session,
  transcript: Transcript,
  glyphs: Glyphs,
  onCopy: (text: string) => Promise<void>,
  theme: Theme,
  setTheme: (name: string) => boolean,
  makeSession: (messages?: AgentMessage[]) => Session,
): Promise<Session> {

  if (name === "help") {
    for (const entry of CHAT_COMMANDS) {
      transcript.notice(`${`/${entry.name}`.padEnd(14)} ${entry.help}`, "muted");
    }
    transcript.notice(
      `shift-up/down or pgup/pgdn scroll ${glyphs.bullet} alt-enter newline ${glyphs.bullet} ctrl-c interrupt`,
      "muted",
    );
    return session;
  }

  if (name === "cost") {
    const { usage } = session;
    transcript.notice(
      `${usage.inputTokens} in ${glyphs.bullet} ${usage.outputTokens} out ${glyphs.bullet} $${session.costUsd.toFixed(4)}`,
      "muted",
    );
    return session;
  }

  if (name === "theme") {
    const wanted = argument.trim();
    if (wanted === "") {
      for (const available of themeNames()) {
        const mark = available === theme.name ? "  (current)" : "";
        transcript.notice(`${available.padEnd(8)}${mark}`, available === theme.name ? "ok" : "muted");
      }
      return session;
    }
    if (!setTheme(wanted)) {
      transcript.notice(`no theme called "${wanted}" — try /theme for the list`, "warn");
      return session;
    }
    // Rewriting the user's config would cost them their comments and layout.
    transcript.notice(`theme: ${wanted}  (this session; set theme: in the config to keep it)`, "ok");
    return session;
  }

  if (name === "copy") {
    const answer = transcript.lastAnswer();
    if (answer === undefined) {
      transcript.notice("nothing to copy yet", "warn");
      return session;
    }
    await onCopy(answer);
    return session;
  }

  if (name === "clear") {
    transcript.clear();
    transcript.notice("new conversation", "muted");
    return makeSession();
  }

  if (name === "provider") {
    // The TUI is always handed a ProviderHandle (see buildContext in
    // src/cli/context.ts) — the plain Provider in AppDeps is the interface
    // every other consumer needs, and this is the one place that needs more.
    const handle = deps.provider as ProviderHandle;
    const env = deps.env ?? process.env;
    const wanted = argument.trim();

    if (wanted === "") {
      for (const line of describeProviders(handle.preset.id, env)) {
        transcript.notice(line, "muted");
      }
      return session;
    }

    const carried = carryHistory(session.messages);
    const outcome = switchOutcome(wanted, {
      pinned: deps.config.pinned,
      dropped: carried.dropped,
      active: handle.preset.id,
    });

    if (outcome.kind === "unknown") {
      transcript.notice(outcome.message, "warn");
      return session;
    }

    const preset = findPreset(wanted)!;
    const path = settingsPath(env, deps.home ?? homedir());
    const settings = {
      provider: preset.id,
      model: preset.model,
      ...(preset.baseUrl !== undefined ? { baseUrl: preset.baseUrl } : {}),
    };

    if (outcome.kind === "pinned") {
      // Only the machine default moves. The running conversation, and the
      // provider serving it, are exactly what this project pins them to.
      writeSettings(path, settings);
      transcript.notice(outcome.message, "ok");
      return session;
    }

    // Build the replacement before writing anything or touching the session:
    // a host that refuses the connection must leave both exactly as they
    // were, rather than half-applying a switch that never completed.
    try {
      await handle.switch(preset, preset.model, preset.baseUrl);
    } catch (error) {
      transcript.notice(switchFailed(preset.id, error as Error), "error");
      return session;
    }
    writeSettings(path, settings);
    transcript.notice(outcome.message, "ok");
    return makeSession(carried.messages);
  }

  if (name === "crystallize") {
    if (argument === "") {
      transcript.notice("/crystallize needs a name", "warn");
      return session;
    }
    const trace = await session.toTrace();
    if (trace.steps.length === 0) {
      transcript.notice("nothing to crystallise yet - no tools were used", "warn");
      return session;
    }

    const traceId = await deps.store.saveLiveTrace(trace);
    const proposal = proposeFlow(trace, argument);
    // The full-screen box has no room for a question per parameter, so every
    // proposal is applied and listed; `vesna crystallize <id>` asks one by one.
    const accepted = new Map(proposal.parameters.map((p) => [p.suggestedName, p.suggestedName]));
    const flow = applyParameters(proposal.flow, proposal.parameters, accepted);

    await mkdir(join(deps.root, ".vesna", "flows"), { recursive: true });
    const path = join(deps.root, ".vesna", "flows", `${flow.name}.yaml`);
    await writeFile(path, toYaml(flow));

    for (const parameter of proposal.parameters) transcript.notice(formatParameter(parameter), "muted");
    for (const line of describeDropped(proposal.dropped, theme)) transcript.notice(line.trim(), "muted");
    // Warm petal marks live work; cold ice marks what has been crystallised.
    // This line is the moment the metaphor is about.
    transcript.notice(`wrote ${path}`, "ice");
    transcript.notice(`trace ${traceId} ${glyphs.bullet} vesna run ${flow.name} --dry-run`, "muted");
  }

  return session;
}

function newSession(
  deps: AppDeps,
  approve: (action: {
    node: string;
    input: Record<string, unknown>;
    cwd: string;
    effect?: "pure" | "write" | "external";
  }) => Promise<"allow" | "deny">,
  resumed?: AgentMessage[],
): Session {
  return createSession(deps.provider, deps.registry, {
    cwd: deps.root,
    model: deps.config.model,
    prices: deps.config.prices,
    notes: deps.notes,

    permit: (type) => permits(deps.config, type),
    approve,
    ...(resumed ? { history: resumed } : {}),
  });
}

function header(deps: AppDeps, theme: Theme, glyphs: Glyphs): string {
  const { config } = deps;
  const mode = config.provider === "openai" ? `${config.provider}/${config.auth}` : config.provider;
  const dot = theme.paint("muted", glyphs.bullet);
  // Every span here paints. A bare one would close the run before it with
  // SGR 39 and then render at the terminal's own default foreground, because
  // only the background is re-established per row.
  return `${theme.paint("petal", glyphs.mark)} ${theme.paint("petal", "vesna")} ${dot} ${theme.paint("text", config.model)} ${dot} ${theme.paint("muted", mode)}`;
}

function hint(theme: Theme, busy: boolean, confirmExit: boolean, glyphs: Glyphs): string {
  if (confirmExit) return theme.paint("warn", "ctrl-c again to leave");
  if (busy) return theme.paint("muted", "ctrl-c interrupt");
  return theme.paint("muted", `/help ${glyphs.bullet} alt-enter newline ${glyphs.bullet} ctrl-c twice to leave`);
}

function status(
  theme: Theme,
  session: Session,
  busy: boolean,
  tick: number,
  glyphs: Glyphs,
  mode: Mode,
): string {
  const { usage } = session;
  const tokens = usage.inputTokens + usage.outputTokens;
  const cost = `$${session.costUsd.toFixed(4)}`;
  // The mode decides what the agent may do, so it is never off screen.
  const body = `${mode} ${glyphs.bullet} ${formatTokens(tokens)} ${glyphs.bullet} ${cost}`;
  // The body is painted in both branches, not just the idle one: after the
  // spinner's own run closes there is no foreground left in force.
  return busy
    ? `${theme.paint("petal", spinnerFrame(tick, glyphs.spinner))} ${theme.paint("muted", body)}`
    : theme.paint("muted", body);
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k tok` : `${count} tok`;
}

function conversationRows(rows: number): number {
  return Math.max(1, rows - 4);
}

/**
 * A one-writer, one-reader queue. `take` resolves with the next item, or null
 * once the writer has closed it and the backlog is drained.
 *
 * Deliberately a plain promise rather than an async generator: handing items
 * over through `for await` leaves the reader waiting on the event loop rather
 * than on the microtask queue, and a submission then sits unhandled until the
 * next keypress happens to wake the loop.
 */
function createQueue<T>() {
  const items: T[] = [];
  let closed = false;
  let waiting: ((value: T | null) => void) | null = null;

  return {
    push(item: T) {
      const resolve = waiting;
      if (resolve !== null) {
        waiting = null;
        resolve(item);
        return;
      }
      items.push(item);
    },
    close() {
      closed = true;
      const resolve = waiting;
      if (resolve !== null) {
        waiting = null;
        resolve(null);
      }
    },
    take(): Promise<T | null> {
      if (items.length > 0) return Promise.resolve(items.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise<T | null>((resolve) => {
        waiting = resolve;
      });
    },
  };
}

/** The real clipboard, used when nothing was injected. */
async function defaultCopy(text: string): Promise<void> {
  const result = await copyToClipboard(text, systemCopyIo());
  if (result === "empty") throw new Error("nothing to copy");
  if (result === "too-large") throw new Error("too large for this terminal");
}

/** One line each, so the notice says what the mode actually means. */
const MODE_HELP: Record<Mode, string> = {
  plan: "look and propose; nothing is changed",
  ask: "you are asked before anything changes",
  auto: "changes go ahead, except the irreversible",
};
