import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApp, type AppDeps } from "../../src/tui/app";
import type { Terminal } from "../../src/tui/screen";
import { resolveTheme } from "../../src/tui/theme";
import { createRegistry } from "../../src/registry/registry";
import { createTraceStore } from "../../src/store/trace";
import type { CompletionRequest, CompletionResult, Provider } from "../../src/providers/types";
import type { VesnaConfig } from "../../src/cli/config";

/**
 * A terminal that keeps the visible rows, by applying the same move-and-clear
 * sequences a real one would. It makes "what does the user see" assertable.
 */
function fakeTerminal(rows = 12, cols = 46) {
  const grid: string[] = Array(rows).fill("");
  const terminal: Terminal = {
    size: () => ({ rows, cols }),
    write(text) {
      const pattern = /\x1b\[(\d+);1H\x1b\[2K([^\x1b]*)/g;
      for (const match of text.matchAll(pattern)) {
        grid[Number(match[1]) - 1] = match[2]!;
      }
    },
  };
  // Escape codes are colour; the tests care about the words.
  const plain = () => grid.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  return { terminal, screen: plain };
}

function keyboard() {
  const chunks: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    type(text: string) {
      chunks.push(text);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (chunks.length > 0) yield chunks.shift()!;
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = () => {
            wake = null;
            resolve();
          };
        });
      }
    },
  };
}

/** Leaving takes one ctrl-c to clear the box and two more to confirm. */
async function quit(app: { input: { type(text: string): void }; finished: Promise<number> }) {
  app.input.type("\x03\x03\x03");
  return app.finished;
}

/** Waits for the screen to satisfy a predicate, so tests never race the app. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function provider(behaviour: (request: CompletionRequest) => Promise<CompletionResult>): Provider {
  return { id: "fake", complete: behaviour };
}

function done(text: string): CompletionResult {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    model: "fake",
    usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function reply(text: string): Provider {
  return provider(async () => done(text));
}

/**
 * A turn that stops halfway until the test lets it go, so "while the turn is
 * running" is a state the test controls rather than a sleep it hopes wins.
 */
function halfway(first: string, second: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    release,
    provider: provider(async (request) => {
      request.onText?.(first);
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        request.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      });
      request.onText?.(second);
      return done(first + second);
    }),
  };
}

async function deps(p: Provider): Promise<AppDeps> {
  const root = await mkdtemp(join(tmpdir(), "vesna-app-"));
  const config: VesnaConfig = {
    provider: "openai",
    auth: "codex",
    model: "test-model",
    theme: "mono",
    prices: {},
    permissions: { nodes: [] },
    // Deterministic across machines: these tests assert on the real glyphs,
    // regardless of what locale happens to be set where they run.
    ascii: false,
  };
  return {
    registry: createRegistry(),
    provider: p,
    store: createTraceStore(join(root, ".vesna", "traces")),
    config,
    theme: resolveTheme("mono", { depth: 0 }),
    root,
  };
}

async function start(p: Provider, size = { rows: 12, cols: 46 }) {
  const host = fakeTerminal(size.rows, size.cols);
  const input = keyboard();
  const finished = runApp(await deps(p), { terminal: host.terminal, input });
  await until(() => host.screen().includes("vesna"), "the first frame");
  return { ...host, input, finished };
}

test("the header names the model and how it is authenticated", async () => {
  const app = await start(reply("hi"));
  expect(app.screen()).toContain("test-model");
  expect(app.screen()).toContain("openai/codex");
  await quit(app);
});

test("what is typed appears in the input box before it is sent", async () => {
  const app = await start(reply("hi"));
  app.input.type("read a.txt");
  await until(() => app.screen().includes("› read a.txt"), "the typed text");
  await quit(app);
});

test("a sent message and its answer both land in the conversation", async () => {
  const app = await start(reply("All done."));
  app.input.type("do it\r");
  await until(() => app.screen().includes("All done."), "the answer");
  expect(app.screen()).toContain("› do it");
  await quit(app);
});

test("the box is empty again after sending", async () => {
  const app = await start(reply("answered"));
  app.input.type("hello\r");
  await until(() => app.screen().includes("answered"), "the answer");
  // The message moved into the conversation; the box below it is blank.
  const rows = app.screen().split("\n");
  expect(rows.some((row) => row.startsWith("› hello"))).toBe(true);
  expect(rows[rows.length - 2]?.trim()).toBe("›");
  await quit(app);
});

test("streamed text appears while the turn is still running", async () => {
  const turn = halfway("alpha", "beta");
  const app = await start(turn.provider);
  app.input.type("go\r");
  await until(() => app.screen().includes("alpha"), "the first delta");
  expect(app.screen()).not.toContain("beta");
  turn.release();
  await until(() => app.screen().includes("alphabeta"), "the whole answer");
  await quit(app);
});

test("ctrl-c during a turn interrupts it and says so", async () => {
  const turn = halfway("work", "ing");
  const app = await start(turn.provider);
  app.input.type("go\r");
  await until(() => app.screen().includes("work"), "the turn to start");
  app.input.type("\x03");
  // The hint line says "ctrl-c interrupt" throughout, so match the notice itself.
  await until(
    () => app.screen().split("\n").some((row) => row.trim() === "interrupted"),
    "the interruption notice",
  );
  expect(app.screen()).not.toContain("working");
  await quit(app);
});

test("ctrl-c with text in the box clears the box instead of leaving", async () => {
  const app = await start(reply("hi"));
  app.input.type("draft text");
  await until(() => app.screen().includes("draft text"), "the draft");
  app.input.type("\x03");
  await until(() => !app.screen().includes("draft text"), "the cleared box");
  await quit(app);
});

test("one ctrl-c on an empty box asks before leaving", async () => {
  const app = await start(reply("hi"));
  app.input.type("\x03");
  await until(() => app.screen().includes("again to leave"), "the confirmation");
  app.input.type("\x03");
  expect(await app.finished).toBe(0);
});

test("/help lists the commands rather than sending them to the model", async () => {
  let asked = false;
  const app = await start(provider(async () => {
    asked = true;
    throw new Error("the model should not have been called");
  }));
  app.input.type("/help\r");
  await until(() => app.screen().includes("/crystallize"), "the help listing");
  expect(asked).toBe(false);
  await quit(app);
});

test("an unknown command is reported, not sent", async () => {
  const app = await start(reply("hi"));
  app.input.type("/nope\r");
  await until(() => app.screen().includes("unknown command"), "the notice");
  await quit(app);
});

test("/clear empties the conversation", async () => {
  const app = await start(reply("answered"));
  app.input.type("first\r");
  await until(() => app.screen().includes("answered"), "the answer");
  app.input.type("/clear\r");
  await until(() => !app.screen().includes("answered"), "the cleared conversation");
  await quit(app);
});

test("the status line tracks tokens and cost as the conversation grows", async () => {
  const app = await start(reply("hi"));
  expect(app.screen()).toContain("0 tok");
  app.input.type("go\r");
  await until(() => app.screen().includes("7 tok"), "the updated usage");
  await quit(app);
});

test("alt-enter adds a line to the message instead of sending it", async () => {
  let calls = 0;
  const app = await start(provider(async () => {
    calls += 1;
    return done("answered");
  }));
  app.input.type("one\x1b\rtwo");
  await until(() => app.screen().includes("two"), "the second line");
  expect(calls).toBe(0);
  await quit(app);
});

test("a pasted block does not send a message per line", async () => {
  let calls = 0;
  const app = await start(provider(async () => {
    calls += 1;
    return done("answered");
  }));
  app.input.type("\x1b[200~alpha\nbeta\ngamma\x1b[201~");
  await until(() => app.screen().includes("gamma"), "the pasted text");
  expect(calls).toBe(0);
  await quit(app);
});

test("the up arrow recalls the previous message", async () => {
  const app = await start(reply("ok"));
  app.input.type("remembered\r");
  await until(() => app.screen().includes("ok"), "the answer");
  app.input.type("\x1b[A");
  await until(() => app.screen().includes("› remembered"), "the recalled line");
  await quit(app);
});

test("leaving restores the shell screen", async () => {
  const writes: string[] = [];
  const terminal: Terminal = { size: () => ({ rows: 10, cols: 40 }), write: (t) => void writes.push(t) };
  const input = keyboard();
  const finished = runApp(await deps(reply("hi")), { terminal, input });
  await until(() => writes.length > 0, "the first draw");
  input.type("\x03\x03");
  await finished;
  expect(writes.join("")).toContain("\x1b[?1049l");
});

test("in ASCII mode not one non-ascii byte reaches the screen", async () => {
  const host = fakeTerminal();
  const input = keyboard();
  const base = await deps(reply("done"));
  const finished = runApp({ ...base, config: { ...base.config, ascii: true } }, {
    terminal: host.terminal, input,
  });
  await until(() => host.screen().includes("vesna"), "the first frame");
  input.type("hello\r");
  await until(() => host.screen().includes("done"), "the answer");
  expect(host.screen()).toMatch(/^[\x00-\x7f]*$/);
  input.type("\x03\x03\x03");
  await finished;
});

test("the empty screen greets you and then gets out of the way", async () => {
  const app = await start(reply("answered"), { rows: 14, cols: 80 });
  expect(app.screen()).toContain("v e s n a");
  expect(app.screen()).toContain("freeze what worked");
  app.input.type("hello\r");
  await until(() => app.screen().includes("answered"), "the answer");
  expect(app.screen()).not.toContain("freeze what worked");
  await quit(app);
});
