import { createSession, type Session } from "../loop/session";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import { createStdioPrompt, isInteractive } from "../tui/stdio";
import type { Theme } from "../tui/theme";
import type { PromptIO } from "../tui/prompt";
import { permits, type VesnaConfig } from "./config";
import {
  CHAT_COMMANDS,
  PLAIN_CHAT_COMMANDS,
  fullScreenOnly,
  moreInFullScreen,
  parseChatInput,
} from "./chatcmd";
import { EXIT } from "./exit";

export interface ChatDeps {
  registry: Registry;
  provider: Provider;
  config: VesnaConfig;
  theme: Theme;
  root: string;
  notes?: string;
  /**
   * Where the lines come from. Injected so a test can drive this loop without
   * a terminal; production passes nothing and gets the real stdin.
   */
  io?: PromptIO & { close(): void };
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
  if (deps.io === undefined && !isInteractive()) {
    console.error("vesna chat needs a terminal. Use `vesna do \"<task>\"` in a script.");
    return EXIT.error;
  }

  const { theme } = deps;
  const io = deps.io ?? createStdioPrompt();
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
          // Only what this surface implements. The shared list is the
          // full-screen chat's, and listing a command here that does nothing
          // is how `/provider` came to be advertised by a chat that has none.
          for (const command of CHAT_COMMANDS) {
            if (!PLAIN_CHAT_COMMANDS.includes(command.name)) continue;
            console.log(`  ${theme.paint("petal", `/${command.name}`.padEnd(14))} ${command.help}`);
          }
          console.log(theme.paint("muted", `  ${moreInFullScreen()}`));
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

        // Every other command belongs to the full-screen chat. Falling through
        // to the turn below sent the model an empty user message — a request
        // paid for, in answer to a command, carrying nothing.
        console.log(theme.paint("warn", `  ${fullScreenOnly(input.name)}`));
        continue;
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
