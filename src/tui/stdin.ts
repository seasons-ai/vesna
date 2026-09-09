import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { openSession, sessionsRoot, type OpenSession } from "../store/sessions";
import { runApp, type AppDeps, type AppIo } from "./app";
import { restoreSequence, type Terminal } from "./screen";

/** The real terminal, wired to this process. */
export function processIo(): AppIo {
  const terminal: Terminal = {
    write: (text) => void process.stdout.write(text),
    // A pty can report 0 as well as undefined, and `??` would let 0 through.
    size: () => ({
      rows: process.stdout.rows || 24,
      cols: process.stdout.columns || 80,
    }),
  };

  return {
    terminal,
    input: chunks(),
    setRawMode(enabled) {
      if (process.stdin.isTTY) process.stdin.setRawMode(enabled);
    },
    onResize(handler) {
      process.stdout.on("resize", handler);
      return () => void process.stdout.off("resize", handler);
    },
  };
}

/**
 * stdin as strings, fed by data events.
 *
 * Not `for await (const chunk of process.stdin)`: on a TTY that reads on the
 * main thread and holds it, which stops timers and leaves an in-flight request
 * suspended until the next keypress — the spinner freezes and the answer only
 * lands when you touch the keyboard.
 */
function chunks(): AsyncIterable<string> {
  const queued: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;

  const push = (chunk: Buffer | string) => {
    queued.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    wake?.();
  };
  const end = () => {
    ended = true;
    wake?.();
  };

  process.stdin.on("data", push);
  process.stdin.once("end", end);
  process.stdin.once("close", end);
  process.stdin.resume();

  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          while (queued.length > 0) yield queued.shift()!;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = () => {
              wake = null;
              resolve();
            };
          });
        }
      } finally {
        process.stdin.off("data", push);
      }
    },
  };
}

/**
 * Hands the terminal back even when the process does not get to finish.
 *
 * A killed Vesna would otherwise leave the alternate screen up, the cursor
 * hidden and the mouse reporting — a shell the user has to `reset` to recover.
 * The handlers write synchronously, because an exit listener cannot await.
 */
function installTerminalGuard(mouse: boolean): () => void {
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      writeSync(1, restoreSequence({ mouse }));
    } catch {
      // Nothing useful to do if even this fails; do not mask the real exit.
    }
  };

  const onSignal = (signal: NodeJS.Signals) => {
    restore();
    process.kill(process.pid, signal);
  };

  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGQUIT"];
  process.on("exit", restore);
  for (const signal of signals) {
    process.once(signal, () => {
      process.removeListener(signal, onSignal);
      restore();
      // Re-raise with the handler gone, so the exit status is the true one.
      process.kill(process.pid, signal);
    });
  }

  return () => {
    restored = true; // a clean leave() has already restored the terminal
    process.removeListener("exit", restore);
  };
}

export async function runTui(deps: AppDeps): Promise<number> {
  const io = processIo();

  // Opened before the first key: a conversation must survive a kill, and an
  // exit handler is not a place to be writing data.
  const root = sessionsRoot(process.env, homedir());
  let record: OpenSession | undefined;
  try {
    record = await openSession({ root, cwd: deps.root, model: deps.config.model });
  } catch {
    // A home directory that cannot be written to is not a reason to refuse
    // the conversation; it only means this one is not kept.
    record = undefined;
  }

  const release = installTerminalGuard(deps.config.mouse !== false);
  try {
    return await runApp({ ...deps, ...(record ? { record } : {}), sessionsRoot: root }, io);
  } finally {
    release();
    // Without this the process lingers on an open stdin after the app returns.
    process.stdin.pause();
  }
}
