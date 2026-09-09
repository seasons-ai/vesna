import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApp, type AppDeps } from "../../src/tui/app";
import type { Terminal } from "../../src/tui/screen";
import { resolveTheme } from "../../src/tui/theme";
import { fg24 } from "../../src/tui/color";
import { PALETTES, type Token } from "../../src/tui/palette";
import { createRegistry } from "../../src/registry/registry";
import type { NodeDef } from "../../src/registry/types";
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
      // A row's payload runs until the next cursor move. Stopping at the first
      // escape instead would drop every painted line on the floor, which is
      // how a frame with no foreground at all survived nine reviews.
      const pattern = /\x1b\[(\d+);1H\x1b\[2K((?:(?!\x1b\[\d+;\d+H)[\s\S])*)/g;
      for (const match of text.matchAll(pattern)) {
        grid[Number(match[1]) - 1] = match[2]!;
      }
    },
  };
  /** The frame as written, escape codes and all, for assertions about colour. */
  const raw = () => grid.join("\n");
  // Escape codes are colour; most tests care about the words.
  const plain = () => raw().replace(/\x1b\[[0-9;]*m/g, "");
  return { terminal, screen: plain, raw };
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

async function deps(p: Provider, overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const root = await mkdtemp(join(tmpdir(), "vesna-app-"));
  const config: VesnaConfig = {
    configured: true,
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
    ...overrides,
  };
}

async function start(
  p: Provider,
  size = { rows: 12, cols: 46 },
  overrides: Partial<AppDeps> = {},
) {
  const host = fakeTerminal(size.rows, size.cols);
  const input = keyboard();
  const finished = runApp(await deps(p, overrides), { terminal: host.terminal, input });
  await until(() => host.screen().includes("vesna"), "the first frame");
  return { ...host, input, finished };
}

/** The default theme at full depth: what a contributor actually looks at. */
const PAINTED = resolveTheme("vesna", { depth: 24 });

/** The exact foreground the `vesna` palette emits for a token. */
function fg(token: Token): string {
  return fg24(PALETTES.vesna!.tokens[token]);
}

/**
 * The row whose *visible* text contains `needle`, returned with its escapes
 * intact. Matching on the raw row directly would miss, because a painted run
 * closes before the padding that follows it.
 */
function rowWith(host: { screen(): string; raw(): string }, needle: string): string {
  const index = host.screen().split("\n").findIndex((row) => row.includes(needle));
  if (index < 0) throw new Error(`no row contains ${JSON.stringify(needle)}`);
  return host.raw().split("\n")[index]!;
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

/**
 * Everything below runs the app on a real theme at a real depth. Every other
 * test here uses `mono` at depth 0, where `paint` is the identity function —
 * which is exactly why a frame that painted backgrounds and no foregrounds
 * looked fine to the suite and unreadable on a terminal.
 */

test("the frame paints its own canvas when the theme is real", async () => {
  const app = await start(reply("hi"), { rows: 12, cols: 46 }, { theme: PAINTED });
  expect(app.raw()).toContain(PAINTED.surface);
  await quit(app);
});

test("the answer and the user's own words carry a foreground, not the terminal's", async () => {
  const app = await start(reply("All done."), { rows: 12, cols: 46 }, { theme: PAINTED });
  app.input.type("do it\r");
  await until(() => app.screen().includes("All done."), "the answer");

  expect(rowWith(app, "All done.")).toContain(fg("text"));
  const asked = rowWith(app, "do it");
  expect(asked).toContain(fg("petal")); // the marker
  expect(asked).toContain(fg("text")); // and the words after it
  await quit(app);
});

test("the separator and the input line carry a foreground too", async () => {
  const app = await start(reply("hi"), { rows: 12, cols: 46 }, { theme: PAINTED });
  app.input.type("draft");
  await until(() => app.screen().includes("› draft"), "the typed text");

  expect(rowWith(app, "─")).toContain(fg("rule"));

  const box = rowWith(app, "draft");
  expect(box).toContain(fg("petal")); // the prompt glyph
  expect(box).toContain(fg("text")); // what is being typed
  await quit(app);
});

test("a genuine failure is painted error, which an interruption is not", async () => {
  const app = await start(
    provider(async () => {
      throw new Error("the provider fell over");
    }),
    { rows: 12, cols: 60 },
    { theme: PAINTED },
  );
  app.input.type("go\r");
  await until(() => app.screen().includes("the provider fell over"), "the failure notice");
  const row = rowWith(app, "the provider fell over");
  expect(row).toContain(fg("error"));
  expect(row).not.toContain(fg("warn"));
  await quit(app);
});

test("an interruption stays warn, because it is the user's own doing", async () => {
  const turn = halfway("work", "ing");
  const app = await start(turn.provider, { rows: 12, cols: 60 }, { theme: PAINTED });
  app.input.type("go\r");
  await until(() => app.screen().includes("work"), "the turn to start");
  app.input.type("\x03");
  await until(
    () => app.screen().split("\n").some((row) => row.trim() === "interrupted"),
    "the interruption notice",
  );
  const row = rowWith(app, "interrupted");
  expect(row).toContain(fg("warn"));
  expect(row).not.toContain(fg("error"));
  await quit(app);
});

/** A node the fake model can call, so a turn leaves a step worth freezing. */
const ECHO: NodeDef = {
  type: "echo",
  effect: "pure",
  description: "echoes its input",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  run: async (input) => input,
};

/** Calls the tool once, then answers. */
function usesATool(): Provider {
  let calls = 0;
  return provider(async () => {
    calls += 1;
    if (calls > 1) return done("finished");
    return {
      content: [{ type: "tool_call", id: "call-1", name: "echo", input: { path: "a.txt" } }],
      stopReason: "tool_use",
      model: "fake",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  });
}

test("crystallising is painted ice, the cold half of frost and blossom", async () => {
  const registry = createRegistry();
  registry.register(ECHO);
  const base = await deps(usesATool(), { registry, theme: PAINTED });
  const host = fakeTerminal(20, 90);
  const input = keyboard();
  const finished = runApp(
    { ...base, config: { ...base.config, permissions: { nodes: ["echo"] } } },
    { terminal: host.terminal, input },
  );
  await until(() => host.screen().includes("vesna"), "the first frame");

  input.type("go\r");
  await until(() => host.screen().includes("finished"), "the answer");
  input.type("/crystallize report\r");
  await until(() => host.screen().includes("wrote "), "the crystallise notice");

  const row = rowWith(host, "wrote ");
  expect(row).toContain(fg("ice"));
  expect(row).not.toContain(fg("ok"));

  input.type("\x03\x03\x03");
  await finished;
});

/**
 * The frame's real invariant, which is per character and not per row.
 *
 * `paint` closes a run with SGR 39, which restores the TERMINAL's default
 * foreground, and the screen driver re-establishes only the background for
 * each row. So a bare span that follows a painted span on the same line has
 * no foreground at all — the F1 defect exactly, surviving inside a line whose
 * other half is painted. A per-row check ("does this line carry a foreground
 * anywhere?") passes on such a line and is what let two of these through.
 */
function unpainted(line: string): string {
  const sgr = /\x1b\[([0-9;]*)m/y;
  let painted = false;
  let bare = "";
  let index = 0;

  while (index < line.length) {
    sgr.lastIndex = index;
    const match = sgr.exec(line);
    if (match !== null) {
      const codes = (match[1] === "" ? "0" : match[1]!).split(";").map(Number);
      for (let k = 0; k < codes.length; k += 1) {
        const code = codes[k]!;
        // 38 and 48 carry their colour as following parameters; stepping over
        // them keeps a blue channel of 39 from reading as "close foreground".
        if (code === 38 || code === 48) {
          if (code === 38) painted = true;
          k += codes[k + 1] === 2 ? 4 : codes[k + 1] === 5 ? 2 : 1;
          k -= 1;
          continue;
        }
        if (code === 0 || code === 39) painted = false;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) painted = true;
      }
      index += match[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(index)!);
    // A space shows only the background, so it needs no foreground of its own.
    if (!painted && char.trim() !== "") bare += char;
    index += char.length;
  }
  return bare;
}

/** Every row of the frame, named, that has a character with no foreground. */
function bareSpans(host: { raw(): string }, moment: string): string[] {
  return host
    .raw()
    .split("\n")
    .map((row, index) => ({ index, bare: unpainted(row) }))
    .filter((row) => row.bare !== "")
    .map((row) => `${moment} row ${row.index}: ${JSON.stringify(row.bare)}`);
}

/** Calls a tool, streams an answer, then holds mid-turn until released. */
function auditTurn() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  return {
    release,
    provider: provider(async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: [{ type: "tool_call", id: "call-1", name: "echo", input: { path: "a.txt" } }],
          stopReason: "tool_use",
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      request.onText?.("Reading the file.");
      await gate;
      return done("Reading the file.");
    }),
  };
}

test("every visible character in the frame has a foreground in force", async () => {
  const registry = createRegistry();
  registry.register(ECHO);
  const turn = auditTurn();
  const base = await deps(turn.provider, { registry, theme: PAINTED });
  const host = fakeTerminal(16, 76);
  const input = keyboard();
  const finished = runApp(
    { ...base, config: { ...base.config, permissions: { nodes: ["echo"] } } },
    { terminal: host.terminal, input },
  );

  const offenders: string[] = [];

  // The header, the empty state, an empty input box, and the idle status.
  await until(() => host.screen().includes("v e s n a"), "the empty state");
  offenders.push(...bareSpans(host, "empty state"));

  // Mid-turn: a conversation with a tool step, and the busy status with its
  // spinner — the one branch of `status` that does not paint its own body.
  input.type("go\r");
  await until(() => host.screen().includes("Reading the file."), "the streamed answer");
  offenders.push(...bareSpans(host, "mid-turn"));

  turn.release();
  await until(() => !host.screen().includes("ctrl-c interrupt"), "the turn to finish");
  offenders.push(...bareSpans(host, "after the turn"));

  // The input box with text in it, over a settled conversation.
  input.type("and again");
  await until(() => host.screen().includes("› and again"), "the typed text");
  offenders.push(...bareSpans(host, "typing"));

  expect(offenders).toEqual([]);

  input.type("\x03\x03\x03");
  await finished;
});
