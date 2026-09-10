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
import type { ProviderHandle } from "../../src/cli/context";
import { CODEX_BASE_URL, findPreset, type Preset } from "../../src/providers/catalog";
import { readSettings, settingsPath } from "../../src/cli/settings";
import { listSessions, openSession, readSession } from "../../src/store/sessions";
import { createPlanNodes } from "../../src/nodes/plan";
import { createSink } from "../../src/spec/sink";
import { specsRoot } from "../../src/spec/store";

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
 * A ProviderHandle whose `switch` is observed rather than actually talking to
 * anything, so /provider and /model can be driven end to end: what each was
 * asked to become, what a host that refuses the connection looks like (via
 * `fail`), and — via `requests`, the `model` field of every completion
 * request actually sent — whether a switch that *says* it worked also
 * changed what the next turn asks for.
 */
function providerHandle(options: { fail?: string } = {}) {
  let preset = findPreset("codex")!;
  let model = preset.model;
  // Mirrors what a real startup resolves when nothing overrides it
  // (src/cli/config.ts): the preset's own address.
  let baseUrl = preset.baseUrl;
  const calls: { preset: Preset; model: string; baseUrl?: string }[] = [];
  const requests: string[] = [];
  const handle: ProviderHandle = {
    id: "fake",
    get preset() {
      return preset;
    },
    get model() {
      return model;
    },
    get baseUrl() {
      return baseUrl;
    },
    async complete(request) {
      requests.push(request.model);
      return done("x");
    },
    async switch(next, nextModel, nextBaseUrl) {
      calls.push({ preset: next, model: nextModel, ...(nextBaseUrl ? { baseUrl: nextBaseUrl } : {}) });
      if (options.fail !== undefined) throw new Error(options.fail);
      preset = next;
      model = nextModel;
      baseUrl = nextBaseUrl;
    },
  };
  return { handle, calls, requests };
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
    preset: findPreset("codex")!,
    pinned: true,
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
  size: { rows: number; cols: number } = { rows: 12, cols: 46 },
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
  // The listing is taller than a 12-row window, so check the newest line: the
  // rest is reachable by scrolling, which is the point of having scrolling.
  await until(() => app.screen().includes("alt-enter"), "the help listing");
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

test("the wheel scrolls the conversation instead of walking the input history", async () => {
  const app = await start(reply("answered"));
  for (let i = 0; i < 12; i += 1) {
    app.input.type(`message ${i}\r`);
    await until(() => app.screen().includes(`message ${i}`), `message ${i} to land`);
  }
  await until(() => !app.screen().includes("message 0"), "the top to scroll away");
  expect(app.screen()).toContain("message 11");

  // Wheel up: the newest goes off the bottom, without touching the box.
  for (let i = 0; i < 4; i += 1) app.input.type("\x1b[<64;5;5M");
  await until(() => !app.screen().includes("message 11"), "the newest to scroll away");

  // Lines are padded to the full canvas width, so compare the content.
  const rows = app.screen().split("\n");
  expect(rows[rows.length - 2]!.trimEnd()).toBe("›");
  await quit(app);
});

test("wheel down returns to the newest, and stops there", async () => {
  const app = await start(reply("answered"));
  for (let i = 0; i < 12; i += 1) {
    app.input.type(`message ${i}\r`);
    await until(() => app.screen().includes(`message ${i}`), `message ${i}`);
  }
  for (let i = 0; i < 4; i += 1) app.input.type("\x1b[<64;5;5M");
  await until(() => !app.screen().includes("message 11"), "scrolled up");

  // Far more notches than there is conversation: it must stop at the newest,
  // not keep going and leave the answer hanging off the top.
  for (let i = 0; i < 40; i += 1) app.input.type("\x1b[<65;5;5M");
  await until(() => app.screen().includes("message 11"), "back at the bottom");
  expect(app.screen()).not.toMatch(/more below/);
  await quit(app);
});

test("scrolled back, the frame says how much is below", async () => {
  const app = await start(reply("answered"));
  for (let i = 0; i < 12; i += 1) {
    app.input.type(`message ${i}\r`);
    await until(() => app.screen().includes(`message ${i}`), `message ${i}`);
  }
  for (let i = 0; i < 4; i += 1) app.input.type("\x1b[<64;5;5M");
  await until(() => /\d+ more below/.test(app.screen()), "the scroll indicator");
  await quit(app);
});

test("at the bottom there is no indicator to distract from the answer", async () => {
  const app = await start(reply("answered"));
  app.input.type("hello\r");
  await until(() => app.screen().includes("answered"), "the answer");
  expect(app.screen()).not.toMatch(/more below/);
  await quit(app);
});

test("clicking the button under an answer copies the markdown the model sent", async () => {
  const copied: string[] = [];
  const app = await start(reply("## Result\n\n- one"), undefined, { copy: (text) => void copied.push(text) });
  app.input.type("go\r");
  await until(() => app.screen().includes("Result"), "the answer");

  const rows = app.screen().split("\n");
  const row = rows.map((line) => line.includes("copy")).lastIndexOf(true);
  expect(row).toBeGreaterThan(0);

  app.input.type(`\x1b[<0;2;${row + 1}M`);
  await until(() => copied.length > 0, "the copy");
  expect(copied[0]).toBe("## Result\n\n- one");
  await quit(app);
});

test("copying says so, so the click is not silent", async () => {
  const app = await start(reply("answered"), undefined, { copy: () => {} });
  app.input.type("go\r");
  await until(() => app.screen().includes("answered"), "the answer");
  const row = app.screen().split("\n").map((l) => l.includes("copy")).lastIndexOf(true);
  app.input.type(`\x1b[<0;2;${row + 1}M`);
  await until(() => /copied/i.test(app.screen()), "the confirmation");
  await quit(app);
});

test("a click on ordinary text copies nothing", async () => {
  const copied: string[] = [];
  const app = await start(reply("answered"), undefined, { copy: (text) => void copied.push(text) });
  app.input.type("go\r");
  await until(() => app.screen().includes("answered"), "the answer");
  const row = app.screen().split("\n").findIndex((line) => line.includes("answered"));
  app.input.type(`\x1b[<0;2;${row + 1}M`);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(copied).toEqual([]);
  await quit(app);
});

test("the user's own message can be copied back too", async () => {
  const copied: string[] = [];
  const app = await start(reply("answered"), undefined, { copy: (text) => void copied.push(text) });
  app.input.type("my exact words\r");
  await until(() => app.screen().includes("answered"), "the answer");

  const rows = app.screen().split("\n");
  const row = rows.findIndex((line) => line.includes("copy"));
  app.input.type(`\x1b[<0;2;${row + 1}M`);
  await until(() => copied.length > 0, "the copy");
  expect(copied[0]).toBe("my exact words");
  await quit(app);
});

test("/copy takes the last answer without needing a mouse", async () => {
  const copied: string[] = [];
  const app = await start(reply("the answer text"), undefined, { copy: (text) => void copied.push(text) });
  app.input.type("go\r");
  await until(() => app.screen().includes("the answer text"), "the answer");
  app.input.type("/copy\r");
  await until(() => copied.length > 0, "the copy");
  expect(copied[0]).toBe("the answer text");
  await quit(app);
});

test("/copy with nothing to copy says so instead of copying blank", async () => {
  const copied: string[] = [];
  const app = await start(reply("x"), undefined, { copy: (text) => void copied.push(text) });
  app.input.type("/copy\r");
  await until(() => /nothing to copy/i.test(app.screen()), "the refusal");
  expect(copied).toEqual([]);
  await quit(app);
});

test("/theme with no name lists what there is and marks the current one", async () => {
  const app = await start(reply("x"));
  app.input.type("/theme\r");
  await until(() => app.screen().includes("hanami"), "the listing");
  const screen = app.screen();
  for (const name of ["vesna", "hanami", "washi", "mono"]) expect(screen).toContain(name);
  expect(screen).toMatch(/vesna.*current|current.*vesna/s);
  await quit(app);
});

test("/theme switches the whole screen, history included", async () => {
  const app = await start(reply("an answer"), { rows: 16, cols: 60 }, { theme: PAINTED });
  app.input.type("earlier message\r");
  await until(() => app.screen().includes("an answer"), "the answer");

  app.input.type("/theme washi\r");
  await until(() => /washi/.test(app.screen()), "the confirmation");

  // The message from before the switch is still there, and still readable.
  expect(app.screen()).toContain("earlier message");
  await quit(app);
});

test("an unknown theme is refused, and the current one is left alone", async () => {
  const app = await start(reply("x"));
  app.input.type("/theme nonsense\r");
  await until(() => /no theme called/i.test(app.screen()), "the refusal");
  expect(app.screen()).toContain("nonsense");
  await quit(app);
});

test("switching says how to make it stick, because it does not", async () => {
  const app = await start(reply("x"));
  app.input.type("/theme mono\r");
  await until(() => /config/i.test(app.screen()), "the note about persistence");
  await quit(app);
});

test("/provider with no name lists the catalog and marks the current service", async () => {
  const { handle } = providerHandle();
  const app = await start(reply("x"), { rows: 24, cols: 100 }, { provider: handle });
  app.input.type("/provider\r");
  await until(() => app.screen().includes("ollama"), "the listing");
  const screen = app.screen();
  for (const id of ["anthropic", "openai", "codex", "ollama"]) expect(screen).toContain(id);
  expect(screen).toMatch(/codex.*current|current.*codex/s);
  await quit(app);
});

test("/provider switches, remembers it on the machine, and carries the conversation", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle, calls } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: settingsHome,
  });

  app.input.type("hi\r");
  await until(() => app.screen().includes("x"), "the first answer");

  app.input.type("/provider ollama\r");
  await until(() => /provider: ollama/.test(app.screen()), "the switch confirmation");

  expect(calls).toEqual([{ preset: findPreset("ollama")!, model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1" }]);
  const written = readSettings(settingsPath({}, settingsHome));
  expect(written).toEqual({ provider: "ollama", model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1" });

  // Switching does not clear the transcript: what was said stays on screen.
  expect(app.screen()).toContain("hi");
  await quit(app);
});

test("an unreachable provider leaves the settings file and the running session untouched", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle, calls } = providerHandle({ fail: "connection refused" });
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: settingsHome,
  });

  app.input.type("hi\r");
  await until(() => app.screen().includes("x"), "the first answer");

  app.input.type("/provider ollama\r");
  await until(() => /connection refused/.test(app.screen()), "the failure notice");

  expect(calls).toHaveLength(1);
  expect(handle.preset.id).toBe("codex");
  expect(app.screen()).not.toContain("provider: ollama");
  expect(readSettings(settingsPath({}, settingsHome))).toEqual({});
  // A failed switch is not a fresh start: what was said before it stays put.
  expect(app.screen()).toContain("hi");
  await quit(app);
});

test("a pinned project changes the machine default and says this directory is unchanged", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle, calls } = providerHandle();
  // The default test config already sets pinned: true.
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    provider: handle,
    env: {},
    home: settingsHome,
  });

  app.input.type("/provider ollama\r");
  await until(() => /unchanged here/.test(app.screen()), "the pinned notice");

  expect(calls).toHaveLength(0);
  expect(handle.preset.id).toBe("codex");
  const written = readSettings(settingsPath({}, settingsHome));
  expect(written.provider).toBe("ollama");
  await quit(app);
});

test("/model with no name lists the roster and marks the current one", async () => {
  const { handle } = providerHandle();
  const app = await start(reply("x"), { rows: 24, cols: 100 }, { provider: handle });
  app.input.type("/model\r");
  await until(() => app.screen().includes("gpt-5.6-sol"), "the listing");
  expect(app.screen()).toMatch(/gpt-5.6-sol.*current|current.*gpt-5.6-sol/s);
  await quit(app);
});

test("/model switches, remembers it on the machine, and leaves the conversation running", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle, calls } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: settingsHome,
  });

  app.input.type("hi\r");
  await until(() => app.screen().includes("x"), "the first answer");

  app.input.type("/model gpt-5.6-sol-mini\r");
  await until(() => /model: gpt-5\.6-sol-mini/.test(app.screen()), "the switch confirmation");

  // The preset's own address rides along too, now that the handle (not the
  // stale startup config) is the source for it.
  expect(calls).toEqual([
    { preset: findPreset("codex")!, model: "gpt-5.6-sol-mini", baseUrl: CODEX_BASE_URL },
  ]);
  const written = readSettings(settingsPath({}, settingsHome));
  expect(written).toEqual({
    provider: "codex",
    model: "gpt-5.6-sol-mini",
    baseUrl: CODEX_BASE_URL,
  });

  // Switching the model does not restart the conversation.
  expect(app.screen()).toContain("hi");
  await quit(app);
});

test("a model the host refuses leaves the settings file and the running session untouched", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle, calls } = providerHandle({ fail: "connection refused" });
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: settingsHome,
  });

  app.input.type("hi\r");
  await until(() => app.screen().includes("x"), "the first answer");

  app.input.type("/model gpt-5.6-sol-mini\r");
  await until(() => /connection refused/.test(app.screen()), "the failure notice");

  expect(calls).toHaveLength(1);
  expect(handle.model).toBe("gpt-5.6-sol");
  expect(app.screen()).not.toContain("model: gpt-5.6-sol-mini");
  expect(readSettings(settingsPath({}, settingsHome))).toEqual({});
  expect(app.screen()).toContain("hi");
  await quit(app);
});

test("a pinned project changes the machine default model and says this directory is unchanged", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle, calls } = providerHandle();
  // The default test config already sets pinned: true.
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    provider: handle,
    env: {},
    home: settingsHome,
  });

  app.input.type("/model gpt-5.6-sol-mini\r");
  await until(() => /unchanged here/.test(app.screen()), "the pinned notice");

  expect(calls).toHaveLength(0);
  expect(handle.model).toBe("gpt-5.6-sol");
  const written = readSettings(settingsPath({}, settingsHome));
  expect(written.model).toBe("gpt-5.6-sol-mini");
  await quit(app);
});

/**
 * The announcement and the settings file both said the switch worked before
 * this test existed — the session handed to the *next* turn still carried
 * the model it was built with, because newSession read deps.config.model, a
 * snapshot frozen at startup, instead of the handle that had actually moved.
 * Only a request the fake provider itself receives can catch that: it is the
 * one thing neither the transcript nor settings.yaml can lie about.
 */
test("/model changes the model actually sent on the next request, not just the announcement", async () => {
  const { handle, requests } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: await mkdtemp(join(tmpdir(), "vesna-settings-")),
  });

  app.input.type("hi\r");
  await until(() => requests.length === 1, "the first request");
  expect(requests[0]).toBe("gpt-5.6-sol");

  app.input.type("/model gpt-5.6-sol-mini\r");
  await until(() => /model: gpt-5\.6-sol-mini/.test(app.screen()), "the switch confirmation");

  app.input.type("again\r");
  await until(() => requests.length === 2, "the second request");
  expect(requests[1]).toBe("gpt-5.6-sol-mini");
  await quit(app);
});

test("/provider changes the model actually sent on the next request, not just the announcement", async () => {
  const { handle, requests } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: await mkdtemp(join(tmpdir(), "vesna-settings-")),
  });

  app.input.type("hi\r");
  await until(() => requests.length === 1, "the first request");
  expect(requests[0]).toBe("gpt-5.6-sol");

  app.input.type("/provider ollama\r");
  await until(() => /provider: ollama/.test(app.screen()), "the switch confirmation");

  app.input.type("again\r");
  await until(() => requests.length === 2, "the second request");
  expect(requests[1]).toBe("llama3.2");
  await quit(app);
});

/**
 * The same defect the two tests above cover, one hop further out. `/model`
 * used to read deps.config.baseUrl — a snapshot from process startup — for
 * both the listing and the switch itself. After /provider moved the running
 * connection to a different host, that snapshot was still the address the
 * process started with, so /model's switch rebuilt a provider for the *new*
 * preset pointed at the *old* host. A startup baseUrl of undefined would
 * mask this, because buildProviderFor falls back to the preset's own
 * address — so this test gives the process a real (sentinel) one, the way
 * the reported repro did.
 */
test("/model after /provider addresses the preset it switched to, not the host the process started with", async () => {
  const { handle, calls } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false, baseUrl: "http://sentinel.invalid" },
    env: {},
    home: await mkdtemp(join(tmpdir(), "vesna-settings-")),
  });

  app.input.type("/provider ollama\r");
  await until(() => /provider: ollama/.test(app.screen()), "the provider switch");

  app.input.type("/model llama3.2-mini\r");
  await until(() => /model: llama3\.2-mini/.test(app.screen()), "the model switch");

  expect(calls[calls.length - 1]).toEqual({
    preset: findPreset("ollama")!,
    model: "llama3.2-mini",
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  await quit(app);
});

test("a conversation is written down as it happens, not at exit", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-hist-"));
  const record = await openSession({ root: store, cwd: "/w", model: "m" });
  const app = await start(reply("an answer"), undefined, { record, sessionsRoot: store });

  app.input.type("remember this\r");
  await until(() => app.screen().includes("an answer"), "the answer");
  // The write is a promise the app deliberately does not await, so poll for it.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await listSessions(store)).length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const [summary] = await listSessions(store);
  expect(summary!.title).toBe("remember this");
  const stored = await readSession(store, record.id);
  expect(stored!.events.some((e) => e.t === "user" && e.text === "remember this")).toBe(true);
  expect(stored!.events.some((e) => e.t === "answer" && e.raw === "an answer")).toBe(true);
  await quit(app);
});

test("/history lists what was said in this folder", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-hist-"));
  const base = await deps(reply("x"));
  const earlier = await openSession({ root: store, cwd: base.root, model: "m" });
  await earlier.append({ t: "user", text: "an earlier conversation" });

  // Wide enough that a listing row is not split by wrapping mid-title.
  const app = await start(reply("x"), { rows: 24, cols: 96 }, { ...base, sessionsRoot: store });
  app.input.type("/history\r");
  await until(() => app.screen().includes("an earlier conversation"), "the listing");
  await quit(app);
});

test("/history in a folder with none says so instead of showing nothing", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-hist-"));
  const app = await start(reply("x"), undefined, { sessionsRoot: store });
  app.input.type("/history\r");
  await until(() => /no conversations from this folder/.test(app.screen()), "the notice");
  await quit(app);
});

test("/resume brings back what was said, not a summary of it", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-hist-"));
  const base = await deps(reply("x"));
  const old = await openSession({ root: store, cwd: base.root, model: "m" });
  await old.append({ t: "user", text: "the original question" });
  await old.append({ t: "answer", raw: "## The original answer\n\n- with a bullet" });

  const app = await start(reply("x"), { rows: 24, cols: 96 }, { ...base, sessionsRoot: store });
  app.input.type("/history\r");
  await until(() => app.screen().includes("the original question"), "the listing");
  app.input.type("/resume 1\r");
  await until(() => app.screen().includes("The original answer"), "the restored answer");

  // Rendered as markdown, and the user's line is back too.
  expect(app.screen()).toContain("with a bullet");
  expect(app.screen()).not.toContain("##");
  expect(app.screen()).toContain("the original question");
  await quit(app);
});

test("/resume with a number nobody listed refuses instead of guessing", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-hist-"));
  const app = await start(reply("x"), { rows: 24, cols: 96 }, { sessionsRoot: store });
  app.input.type("/resume 7\r");
  await until(() => /from the last \/history listing/.test(app.screen()), "the refusal");
  await quit(app);
});

test("the model is given the resumed conversation, not just the screen", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-hist-"));
  const base = await deps(reply("x"));
  const old = await openSession({ root: store, cwd: base.root, model: "m" });
  await old.append({ t: "user", text: "earlier" });
  await old.append({
    t: "messages",
    added: [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "an earlier reply" }] },
    ],
  });

  const seen: string[] = [];
  const spy = provider(async (request) => {
    seen.push(JSON.stringify(request.messages));
    return done("new answer");
  });

  // `...base` carries a provider of its own; the spy has to win.
  const app = await start(spy, { rows: 24, cols: 96 }, { ...base, provider: spy, sessionsRoot: store });
  app.input.type("/history\r");
  await until(() => app.screen().includes("earlier"), "the listing");
  app.input.type("/resume 1\r");
  await until(() => /resumed/.test(app.screen()), "the resume");
  app.input.type("and now?\r");
  await until(() => app.screen().includes("new answer"), "the new answer");

  expect(seen[0]).toContain("an earlier reply");
  await quit(app);
});

test("a slash command is control, not conversation, and is never recorded", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-hist-"));
  const record = await openSession({ root: store, cwd: "/w", model: "m" });
  const app = await start(reply("x"), { rows: 24, cols: 96 }, { record, sessionsRoot: store });

  app.input.type("/theme mono\r");
  await until(() => /theme: mono/.test(app.screen()), "the switch");
  app.input.type("a real question\r");
  await until(() => app.screen().includes("x"), "the answer");

  // The app deliberately does not await its own writes, so poll for the line.
  let said: string[] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stored = await readSession(store, record.id);
    said = (stored?.events ?? [])
      .filter((e) => e.t === "user")
      .map((e) => (e as { text: string }).text);
    if (said.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(said).toEqual(["a real question"]);
  await quit(app);
});

test("the conversation you are in is not offered for resuming", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-hist-"));
  const base = await deps(reply("x"));
  const record = await openSession({ root: store, cwd: base.root, model: "m" });

  const app = await start(reply("x"), { rows: 24, cols: 96 }, {
    ...base,
    record,
    sessionsRoot: store,
  });
  app.input.type("something in the current session\r");
  await until(() => app.screen().includes("x"), "the answer");

  app.input.type("/history\r");
  await until(() => /no conversations|resume <number>/.test(app.screen()), "the listing");
  expect(app.screen()).not.toContain("something in the current session\n");
  expect(app.screen()).toMatch(/no conversations from this folder/);
  await quit(app);
});

test("ctrl-b opens the conversations column and closes it again", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-pane-"));
  const base = await deps(reply("x"));
  const old = await openSession({ root: store, cwd: base.root, model: "m" });
  await old.append({ t: "user", text: "an old chat" });

  const app = await start(reply("x"), { rows: 20, cols: 130 }, { ...base, sessionsRoot: store });
  expect(app.screen()).not.toContain("an old chat");

  app.input.type("\x02");
  await until(() => app.screen().includes("an old chat"), "the column");

  app.input.type("\x02");
  await until(() => !app.screen().includes("an old chat"), "the column closing");
  await quit(app);
});

test("the column is not offered when the window cannot hold it", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-pane-"));
  const base = await deps(reply("x"));
  const old = await openSession({ root: store, cwd: base.root, model: "m" });
  await old.append({ t: "user", text: "an old chat" });

  // Narrow: the conversation matters more than the column.
  const app = await start(reply("x"), { rows: 20, cols: 70 }, { ...base, sessionsRoot: store });
  app.input.type("\x02");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(app.screen()).not.toContain("an old chat");
  await quit(app);
});

test("clicking a conversation in the column opens it", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-pane-"));
  const base = await deps(reply("x"));
  const old = await openSession({ root: store, cwd: base.root, model: "m" });
  await old.append({ t: "user", text: "the older question" });
  await old.append({ t: "answer", raw: "the older answer" });

  const app = await start(reply("x"), { rows: 20, cols: 130 }, { ...base, sessionsRoot: store });
  app.input.type("\x02");
  await until(() => app.screen().includes("the older question"), "the column");

  const row = app.screen().split("\n").findIndex((line) => line.includes("the older question"));
  app.input.type(`\x1b[<0;3;${row + 1}M`);
  await until(() => app.screen().includes("the older answer"), "the resumed conversation");
  await quit(app);
});

test("a click in the conversation still copies, and does not open a chat", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-pane-"));
  const copied: string[] = [];
  const base = await deps(reply("an answer"));
  const old = await openSession({ root: store, cwd: base.root, model: "m" });
  await old.append({ t: "user", text: "an old chat" });

  const app = await start(reply("an answer"), { rows: 20, cols: 130 }, {
    ...base,
    sessionsRoot: store,
    copy: (text) => void copied.push(text),
  });
  app.input.type("go\r");
  await until(() => app.screen().includes("an answer"), "the answer");
  app.input.type("\x02");
  await until(() => app.screen().includes("an old chat"), "the column");

  const rows = app.screen().split("\n");
  const row = rows.map((line) => line.includes("copy")).lastIndexOf(true);
  // Well to the right of the column, inside the conversation.
  app.input.type(`\x1b[<0;40;${row + 1}M`);
  await until(() => copied.length > 0, "the copy");
  expect(copied[0]).toBe("an answer");
  await quit(app);
});

test("/spec new opens a garden on the right", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 130 });
  expect(app.screen()).not.toContain("Reliable cancellation");

  app.input.type("/spec new Reliable cancellation\r");
  await until(() => app.screen().includes("Reliable cancellation"), "the garden");
  // The stages are there from the first moment, so you know where you are.
  expect(app.screen()).toContain("intent");
  expect(app.screen()).toContain("verify");
  await quit(app);
});

test("ctrl-g hides the garden and brings it back", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 130 });
  app.input.type("/spec new Some work\r");
  // "verify" only ever appears in the garden; the title also sits in the
  // command the user just typed, so it cannot tell the column apart.
  await until(() => app.screen().includes("verify"), "the garden");

  app.input.type("\x07");
  await until(() => !app.screen().includes("verify"), "the garden hidden");
  app.input.type("\x07");
  await until(() => app.screen().includes("verify"), "the garden back");
  await quit(app);
});

test("with no spec there is no column, and the conversation has the room", async () => {
  const app = await start(reply("an answer"), { rows: 20, cols: 130 });
  app.input.type("go\r");
  await until(() => app.screen().includes("an answer"), "the answer");
  // No divider means no column.
  expect(app.screen().split("\n")[0]).not.toContain("│");
  await quit(app);
});

test("a spec survives being reopened by name", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 130 });
  app.input.type("/spec new Cancellation work\r");
  await until(() => app.screen().includes("verify"), "the garden");
  app.input.type("\x07");
  await until(() => !app.screen().includes("verify"), "hidden");

  app.input.type("/spec open cancellation-work\r");
  await until(() => app.screen().includes("verify"), "reopened");
  await quit(app);
});

test("/spec lists what there is and marks the open one", async () => {
  const app = await start(reply("x"), { rows: 22, cols: 130 });
  app.input.type("/spec new first thing\r");
  await until(() => app.screen().includes("first thing"), "the first");
  app.input.type("/spec new second thing\r");
  await until(() => app.screen().includes("second thing"), "the second");

  app.input.type("/spec\r");
  await until(() => app.screen().includes("first-thing"), "the listing");
  expect(app.screen()).toContain("second-thing");
  await quit(app);
});

test("creating the same spec twice is refused, not silently appended to", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 130 });
  app.input.type("/spec new same name\r");
  await until(() => app.screen().includes("same name"), "the first");
  app.input.type("/spec new same name\r");
  await until(() => /already exists/.test(app.screen()), "the refusal");
  await quit(app);
});

test("both columns can be open at once, on their own sides", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-both-"));
  const base = await deps(reply("x"));
  const old = await openSession({ root: store, cwd: base.root, model: "m" });
  await old.append({ t: "user", text: "an old chat" });

  const app = await start(reply("x"), { rows: 20, cols: 150 }, { ...base, sessionsRoot: store });
  app.input.type("/spec new Garden work\r");
  await until(() => app.screen().includes("Garden work"), "the garden");
  app.input.type("\x02");
  await until(() => app.screen().includes("an old chat"), "the chats");

  const row = app.screen().split("\n").find((line) => line.includes("an old chat"))!;
  expect(row.indexOf("an old chat")).toBeLessThan(row.length / 2);
  await quit(app);
});

/** A node with a path, and one with nothing a rule could match on. */
function toolCaller(name: string, input: Record<string, unknown>): Provider {
  let turn = 0;
  return {
    id: "fake",
    async complete() {
      turn += 1;
      return {
        content:
          turn === 1
            ? [{ type: "tool_call" as const, id: "c1", name, input }]
            : [{ type: "text" as const, text: "finished" }],
        stopReason: "end_turn",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

/** The test deps permit no nodes at all; these tests need one. */
async function allowing(provider: Provider, registry: ReturnType<typeof createRegistry>) {
  const base = await deps(provider, { registry });
  return {
    ...base,
    config: { ...base.config, permissions: { nodes: ["put"] } },
    policy: { mode: "ask" as const, allow: {}, deny: {} },
  };
}

function writing() {
  const registry = createRegistry();
  const ran: string[] = [];
  registry.register({
    type: "put",
    effect: "write",
    description: "write",
    inputSchema: { type: "object" },
    async run(input: any) {
      ran.push(String(input.path ?? input.check ?? "?"));
      return {};
    },
  });
  return { registry, ran };
}

test("pressing a on something with no pattern allows it, never refuses it", async () => {
  const { registry, ran } = writing();
  // `check` is not a path and not a command, so no rule can be made from it.
  const caller = toolCaller("put", { check: "bun test" });
  const app = await start(caller, { rows: 20, cols: 90 }, await allowing(caller, registry));

  app.input.type("go\r");
  await until(() => app.screen().includes("[y] allow"), "the question");
  app.input.type("a");
  await until(() => /allowed/.test(app.screen()), "the approval");

  expect(app.screen()).not.toMatch(/refused/);
  expect(ran).toHaveLength(1);
  await quit(app);
});

test("a stray key does not decide anything — the question stays up", async () => {
  const { registry, ran } = writing();
  const caller = toolCaller("put", { path: "src/a.ts" });
  const app = await start(caller, { rows: 20, cols: 90 }, await allowing(caller, registry));

  app.input.type("go\r");
  await until(() => app.screen().includes("[y] allow"), "the question");

  app.input.type("q");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(app.screen()).not.toMatch(/refused|allowed/);

  app.input.type("y");
  await until(() => /allowed/.test(app.screen()), "the approval");
  expect(ran).toEqual(["src/a.ts"]);
  await quit(app);
});

test("n still refuses, and the action does not happen", async () => {
  const { registry, ran } = writing();
  const caller = toolCaller("put", { path: "src/a.ts" });
  const app = await start(caller, { rows: 20, cols: 90 }, await allowing(caller, registry));

  app.input.type("go\r");
  await until(() => app.screen().includes("[y] allow"), "the question");
  app.input.type("n");
  await until(() => /refused/.test(app.screen()), "the refusal");
  expect(ran).toEqual([]);
  await quit(app);
});

test("the mode is always on screen — switching invisibly would be worse than not switching", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 100 });
  expect(app.screen()).toContain("ask");
  await quit(app);
});

test("shift-tab walks the three modes and comes back round", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 100 });
  expect(app.screen()).toContain("ask");

  app.input.type("\x1b[Z");
  await until(() => app.screen().includes("auto"), "auto");
  app.input.type("\x1b[Z");
  await until(() => app.screen().includes("plan"), "plan");
  app.input.type("\x1b[Z");
  await until(() => app.screen().includes("ask"), "back to ask");
  await quit(app);
});

test("plan mode refuses to change anything, and says why", async () => {
  const { registry, ran } = writing();
  const caller = toolCaller("put", { path: "src/a.ts" });
  const app = await start(caller, { rows: 20, cols: 100 }, await allowing(caller, registry));

  app.input.type("\x1b[Z");
  await until(() => app.screen().includes("auto"), "auto");
  app.input.type("\x1b[Z");
  await until(() => app.screen().includes("plan"), "plan");

  app.input.type("go\r");
  await until(() => /plan mode/i.test(app.screen()), "the refusal");
  expect(ran).toEqual([]);
  await quit(app);
});

test("/mode names a mode directly, for anyone who would rather type", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 100 });
  app.input.type("/mode auto\r");
  await until(() => app.screen().includes("auto"), "the switch");
  await quit(app);
});

test("/mode with a name nobody has is refused, and the mode is left alone", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 100 });
  app.input.type("/mode reckless\r");
  await until(() => /plan, ask or auto/.test(app.screen()), "the refusal");
  await quit(app);
});

test("planning opens the column by itself — no command to know first", async () => {
  const registry = createRegistry();
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  for (const node of createPlanNodes(sink)) registry.register(node);

  const caller = toolCaller("plan", {
    title: "Reliable cancellation",
    tasks: [{ id: "T1", title: "cancel the shell" }],
  });
  const app = await start(caller, { rows: 20, cols: 130 }, {
    ...base,
    provider: caller,
    registry,
    sink,
    config: { ...base.config, permissions: { nodes: ["plan"] } },
    policy: { mode: "auto", allow: {}, deny: {} },
  });

  expect(app.screen()).not.toContain("Reliable cancellation");
  app.input.type("do the work\r");
  await until(() => app.screen().includes("cancel the shell"), "the tree");

  expect(app.screen()).toContain("Reliable cancellation");
  expect(app.screen()).toMatch(/plan: Reliable cancellation/);
  await quit(app);
});
