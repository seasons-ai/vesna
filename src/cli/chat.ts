import { createCore, type CoreDeps } from "../core/core";
import type { Ask, NoticeLevel } from "../core/types";
import { createStdioPrompt, isInteractive } from "../tui/stdio";
import type { Theme } from "../tui/theme";
import type { PromptIO } from "../tui/prompt";
import {
  CHAT_COMMANDS,
  PLAIN_CHAT_COMMANDS,
  fullScreenOnly,
  moreInFullScreen,
  parseChatInput,
} from "./chatcmd";
import { EXIT } from "./exit";

export interface ChatDeps extends CoreDeps {
  theme: Theme;
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
 * The conversation surface for a dumb terminal: a client of the same core
 * the full-screen chat runs on, with stdout for a screen. The core says what
 * happens — deltas, steps, notices, questions — and this side prints each
 * line as it arrives and reads the next one from stdin.
 */
export async function runChat(deps: ChatDeps): Promise<number> {
  if (deps.io === undefined && !isInteractive()) {
    console.error("vesna chat needs a terminal. Use `vesna do \"<task>\"` in a script.");
    return EXIT.error;
  }

  const { theme } = deps;
  const io = deps.io ?? createStdioPrompt();
  const prompt = `${theme.paint("petal", "›")} `;
  const core = createCore(deps);

  // True while a message of the person's is with the model: the blank line
  // under an answer is printed for a turn, not for a command's notices.
  let sending = false;
  // True once the answer has started on its own line, so the first delta
  // opens the line and a notice arriving mid-answer does not land on it.
  let answering = false;
  // A question is answered from the same stdin the loop reads, so the loop
  // waits for the answer before it asks for the next line.
  let asking: Promise<void> | null = null;

  const say = (level: NoticeLevel, text: string): void => {
    console.log(theme.paint(level, `${answering ? "\n" : ""}  ${text}`));
    answering = false;
  };

  /** The question's lines, then one line from stdin until it is an answer. */
  async function answerAsk(ask: Ask): Promise<void> {
    // Painted as the full-screen chat paints them: a permission is its
    // action in warn and its choices muted; an approval lists what is
    // approved muted and asks in warn.
    for (const [index, text] of ask.lines.entries()) {
      const last = index === ask.lines.length - 1;
      say(ask.kind === "permission" ? (index === 0 ? "warn" : "muted") : last ? "warn" : "muted", text);
    }
    // Only the three answers decide; a strict question ignores enter.
    while (true) {
      const typed = (await io.question(prompt)).trim().slice(0, 1).toLowerCase();
      const answer =
        typed === "y" || typed === "n" || (typed === "a" && !ask.strict)
          ? typed
          : typed === "" && !ask.strict
            ? "y"
            : "";
      if (answer === "") continue;
      core.answer(ask.id, answer);
      return;
    }
  }

  const unsubscribe = core.on((notification) => {
    switch (notification.method) {
      case "transcript": {
        const entry = notification.params;
        switch (entry.kind) {
          case "user":
            // The person's own line is already on their terminal.
            break;
          case "delta":
            if (!answering) {
              process.stdout.write("\n");
              answering = true;
            }
            process.stdout.write(entry.text);
            break;
          case "step":
            console.log(
              `  ${theme.paint("petal", "·")} ${theme.paint("text", entry.step.nodeType.padEnd(8))} ${theme.paint("muted", `${entry.step.durationMs}ms`)}`,
            );
            break;
          case "notice":
            say(entry.level, entry.text);
            break;
          case "turn-end":
            if (sending) console.log("");
            answering = false;
            break;
          case "clear":
            break;
        }
        return;
      }
      case "ask":
        asking = answerAsk(notification.params).finally(() => {
          asking = null;
        });
        return;
      case "ask.resolved":
      case "state":
        return;
    }
  });

  // First ctrl-c cancels the turn in progress; a second one, while idle, leaves.
  const onSigint = () => {
    if (core.snapshot().busy) {
      core.interrupt();
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
      // A question up after a turn — the approval — owns stdin until it is
      // answered; the next line is taken after it, never under it.
      while (asking !== null) await asking;

      const line = await io.question(prompt);
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
          const { usage } = core.snapshot();
          console.log(
            theme.paint(
              "muted",
              `  ${usage.inputTokens} in · ${usage.outputTokens} out · $${usage.costUsd.toFixed(4)}`,
            ),
          );
          continue;
        }
        if (input.name === "clear") {
          await core.command(input.name, input.argument, { typed: line });
          continue;
        }

        // Every other command belongs to the full-screen chat. Falling through
        // to the turn below sent the model an empty user message — a request
        // paid for, in answer to a command, carrying nothing.
        console.log(theme.paint("warn", `  ${fullScreenOnly(input.name)}`));
        continue;
      }

      sending = true;
      try {
        await core.send(line);
      } finally {
        sending = false;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    // As leaving the full-screen chat: a question still open is answered no,
    // a turn in flight is cut short, and nothing asked afterwards does anything.
    await core.close();
    unsubscribe();
    io.close();
  }
}
