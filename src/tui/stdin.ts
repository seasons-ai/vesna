import { runApp, type AppDeps, type AppIo } from "./app";
import type { Terminal } from "./screen";

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

export async function runTui(deps: AppDeps): Promise<number> {
  const io = processIo();
  try {
    return await runApp(deps, io);
  } finally {
    // Without this the process lingers on an open stdin after the app returns.
    process.stdin.pause();
  }
}
