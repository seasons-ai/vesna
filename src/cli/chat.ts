import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { applyParameters } from "../crystallize/apply";
import { proposeFlow } from "../crystallize/propose";
import { createSession, type Session } from "../loop/session";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import type { TraceStore } from "../store/types";
import { confirmParameters } from "../tui/prompt";
import { createStdioPrompt, isInteractive } from "../tui/stdio";
import type { Theme } from "../tui/theme";
import { permits, type VesnaConfig } from "./config";
import { CHAT_COMMANDS, parseChatInput } from "./chatcmd";
import { EXIT } from "./exit";
import { formatParameter } from "./format";
import { describeDropped } from "./dropped";

export interface ChatDeps {
  registry: Registry;
  provider: Provider;
  store: TraceStore;
  config: VesnaConfig;
  theme: Theme;
  root: string;
  notes?: string;
}

function banner(deps: ChatDeps): string {
  const { theme, config } = deps;
  return [
    `${theme.paint("petal", "vesna")} ${theme.paint("muted", "·")} ${config.model} ${theme.paint("muted", "·")} ${theme.paint("muted", "/help for commands, ctrl-c to interrupt")}`,
    "",
  ].join("\n");
}

/**
 * The conversation surface. Everything under it already exists — history in a
 * session, deltas from the provider, an abort signal through the loop — so this
 * is the thin part: read a line, stream a turn, keep going.
 */
export async function runChat(deps: ChatDeps): Promise<number> {
  if (!isInteractive()) {
    console.error("vesna chat needs a terminal. Use `vesna do \"<task>\"` in a script.");
    return EXIT.error;
  }

  const { theme } = deps;
  const io = createStdioPrompt();
  let session = newSession(deps);
  let turnAbort: AbortController | null = null;

  // First ctrl-c cancels the turn in progress; a second one, while idle, leaves.
  const onSigint = () => {
    if (turnAbort !== null) {
      turnAbort.abort();
      console.log(theme.paint("warn", "\n  interrupted"));
      return;
    }
    console.log("");
    io.close();
    process.exit(EXIT.ok);
  };
  process.on("SIGINT", onSigint);

  console.log(banner(deps));

  try {
    while (true) {
      const line = await io.question(`${theme.paint("petal", "›")} `);
      const input = parseChatInput(line);

      if (input.kind === "blank") continue;
      if (input.kind === "unknown") {
        console.log(theme.paint("warn", `  unknown command /${input.name} — try /help`));
        continue;
      }

      if (input.kind === "command") {
        if (input.name === "exit") return EXIT.ok;
        if (input.name === "help") {
          for (const command of CHAT_COMMANDS) {
            console.log(`  ${theme.paint("petal", `/${command.name}`.padEnd(14))} ${command.help}`);
          }
          continue;
        }
        if (input.name === "cost") {
          const { usage } = session;
          console.log(
            theme.paint(
              "muted",
              `  ${usage.inputTokens} in · ${usage.outputTokens} out · $${session.costUsd.toFixed(4)}`,
            ),
          );
          continue;
        }
        if (input.name === "clear") {
          session = newSession(deps);
          console.log(theme.paint("muted", "  new conversation"));
          continue;
        }
        if (input.name === "crystallize") {
          await crystallize(deps, session, io, input.argument);
          continue;
        }
      }

      turnAbort = new AbortController();
      try {
        await runTurn(deps, session, input.kind === "message" ? input.text : "", turnAbort.signal);
      } catch (error) {
        console.log(theme.paint("warn", `  ${(error as Error).message}`));
      } finally {
        turnAbort = null;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    io.close();
  }
}

function newSession(deps: ChatDeps): Session {
  return createSession(deps.provider, deps.registry, {
    cwd: deps.root,
    model: deps.config.model,
    prices: deps.config.prices,
    notes: deps.notes,
    permit: (type) => permits(deps.config, type),
  });
}

async function runTurn(
  deps: ChatDeps,
  session: Session,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const { theme } = deps;
  let wroteText = false;

  const result = await session.send(text, {
    signal,
    onText(delta) {
      if (!wroteText) {
        process.stdout.write("\n");
        wroteText = true;
      }
      process.stdout.write(delta);
    },
    onStep(step) {
      console.log(
        `  ${theme.paint("petal", "\u00b7")} ${theme.paint("text", step.nodeType.padEnd(8))} ${theme.paint("muted", `${step.durationMs}ms`)}`,
      );
    },
  });

  // A provider without streaming never called onText, so print the turn now.
  if (!wroteText && result.text) console.log(`\n${result.text}`);
  console.log("");
}

async function crystallize(
  deps: ChatDeps,
  session: Session,
  io: { write(text: string): void; question(prompt: string): Promise<string> },
  name: string,
): Promise<void> {
  const { theme, root } = deps;
  if (name === "") {
    console.log(theme.paint("warn", "  /crystallize needs a name"));
    return;
  }

  const trace = await session.toTrace();
  if (trace.steps.length === 0) {
    console.log(theme.paint("warn", "  nothing to crystallise yet — no tools were used"));
    return;
  }

  const traceId = await deps.store.saveLiveTrace(trace);
  const proposal = proposeFlow(trace, name);
  const accepted = await confirmParameters(proposal.parameters, io, theme);
  const flow = applyParameters(proposal.flow, proposal.parameters, accepted);

  await mkdir(join(root, ".vesna", "flows"), { recursive: true });
  const path = join(root, ".vesna", "flows", `${flow.name}.yaml`);
  await writeFile(path, toYaml(flow));

  for (const parameter of proposal.parameters) {
    console.log(theme.paint("muted", `  ${formatParameter(parameter)}`));
  }
  for (const line of describeDropped(proposal.dropped, theme)) console.log(line);
  console.log(theme.paint("ok", `  wrote ${path}`));
  console.log(theme.paint("muted", `  trace ${traceId} · try: vesna run ${flow.name} --dry-run`));
}
