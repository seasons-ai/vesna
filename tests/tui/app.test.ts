import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApp, type AppDeps } from "../../src/tui/app";
import { createCore } from "../../src/core/core";
import type { Core } from "../../src/core/types";
import { allowing, buildFakes, deps, done, halfway, provider, providerHandle, reply, toolCaller, until, writing } from "../helpers/chat";
import type { Terminal } from "../../src/tui/screen";
import { resolveTheme } from "../../src/tui/theme";
import { fg24 } from "../../src/tui/color";
import { PALETTES, type Token } from "../../src/tui/palette";
import { createRegistry } from "../../src/registry/registry";
import type { NodeDef } from "../../src/registry/types";
import type { Provider } from "../../src/providers/types";
import { loadConfig } from "../../src/cli/config";
import { saveAuth, authPath } from "../../src/auth/store";
import { CODEX_BASE_URL, findPreset } from "../../src/providers/catalog";
import { readSettings, settingsPath, writeSettings } from "../../src/cli/settings";
import { listSessions, openSession, readSession } from "../../src/store/sessions";
import { createPlanNodes } from "../../src/nodes/plan";
import { project, type SpecEvent } from "../../src/spec/project";
import { createSink } from "../../src/spec/sink";
import { appendEvent, createSpec, digestOf, readEvents, specPaths, specsRoot, writeSpecFile } from "../../src/spec/store";
import type { BuildResult } from "../../src/work/builder";
import { branchName, worktreePath } from "../../src/work/worktree";
import { pidAlive } from "../../src/sdd/recover";

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

test("the header names the model and the service answering it", async () => {
  const app = await start(reply("hi"));
  expect(app.screen()).toContain("test-model");
  // The service, not the dialect: "openai/codex" named the wire format, which
  // is the same string for every openai-compatible host in the catalog.
  expect(app.screen()).toContain("codex");
  expect(app.screen()).not.toContain("openai/codex");
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
  expect(app.screen()).toContain("pick what answers");
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

/**
 * `vesna auth`, the check before a conversation and onboarding all route
 * through `inspectCredential`. `/provider` consulted nothing: it reported
 * success, wrote the machine default, and the next bare `vesna` exited 1 with
 * "GROQ_API_KEY is not set". The user had disabled their own CLI from inside a
 * chat, and nothing on screen named the fix — though the listing above it
 * already prints `needs $GROQ_API_KEY`.
 */
test("/provider refuses a service whose credential is missing, rather than disabling the next run", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle, calls } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 20, cols: 80 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: settingsHome,
  });

  app.input.type("/provider groq\r");
  await until(() => /GROQ_API_KEY/.test(app.screen()), "the refusal");

  expect(calls).toHaveLength(0);
  expect(handle.preset.id).toBe("codex");
  expect(readSettings(settingsPath({}, settingsHome))).toEqual({});
  expect(app.screen()).not.toContain("provider: groq");
  await quit(app);
});

/**
 * `/provider custom` built a provider without touching the network, reported
 * success, and persisted `{provider: custom, model: local-model}` with no
 * address — so every later run went to api.openai.com unauthenticated.
 */
test("/provider custom refuses instead of persisting a service with nowhere to send", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle, calls } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 20, cols: 96 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: settingsHome,
  });

  app.input.type("/provider custom\r");
  await until(() => /no address of its own/.test(app.screen()), "the refusal");

  expect(calls).toHaveLength(0);
  expect(handle.preset.id).toBe("codex");
  expect(readSettings(settingsPath({}, settingsHome))).toEqual({});
  await quit(app);
});

/**
 * The repro, one directory over.
 *
 * `subscription` needs an `oauth` block, and only a hand-written
 * `.vesna/config.yaml` carries one. In a repo that has it — and with a token
 * on disk, so the credential check says yes — `/provider subscription`
 * reported `provider: subscription  model gpt-5.6-sol` and wrote exactly that
 * to `~/.vesna/settings.yaml`. Every other directory then read a machine
 * default it had no oauth block to build, and threw at startup.
 *
 * So the assertion that matters is not the notice on screen: it is what a
 * second directory resolves out of the machine file afterwards.
 */
test("/provider subscription is refused, rather than making every other folder unstartable", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  // Signed in: without this the credential check refuses first and the test
  // would pass for a reason that has nothing to do with the fix.
  await saveAuth(authPath({}, settingsHome), {
    provider: "openai",
    accessToken: "token-on-disk",
  });
  const { handle, calls } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 20, cols: 100 }, {
    ...base,
    provider: handle,
    config: {
      ...base.config,
      pinned: false,
      // The project-scoped fact the old verdict was drawn from.
      oauth: { issuer: "https://issuer.test", clientId: "cid", baseUrl: "https://api.test/v1" },
    },
    env: {},
    home: settingsHome,
  });

  app.input.type("/provider subscription\r");
  await until(() => /set up by hand/.test(app.screen()), "the refusal");

  expect(calls).toHaveLength(0);
  expect(handle.preset.id).toBe("codex");
  expect(readSettings(settingsPath({}, settingsHome))).toEqual({});

  // A different directory, with no oauth block of its own: it inherits
  // nothing from the machine file, so it still resolves to a service it can
  // actually build.
  const elsewhere = await mkdtemp(join(tmpdir(), "vesna-elsewhere-"));
  const config = await loadConfig(elsewhere, {}, settingsHome);
  expect(config.preset.id).toBe("anthropic");
  expect(config.configured).toBe(false);
  await quit(app);
});

test("/provider switches when the credential the preset names is there", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle, calls } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 20, cols: 80 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: { GROQ_API_KEY: "gk-present" },
    home: settingsHome,
  });

  app.input.type("/provider groq\r");
  await until(() => /provider: groq/.test(app.screen()), "the switch confirmation");

  expect(calls).toHaveLength(1);
  expect(handle.preset.id).toBe("groq");
  expect(readSettings(settingsPath({}, settingsHome)).provider).toBe("groq");
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
  // The header names the current model too, now that it follows the handle —
  // so waiting for the model id alone would win before the listing is drawn.
  await until(() => app.screen().includes("(current)"), "the listing");
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

/**
 * The repro: a machine default of ollama, a directory pinning codex, and
 * `/model gpt-5.6-sol-mini`. The roster came from codex — the service
 * answering here — and the write landed on ollama, so every other directory
 * went on to ask Ollama for a ChatGPT model id.
 *
 * The assertion is the file as a second directory reads it, not the notice:
 * a message that honestly names ollama does not make the pair it wrote real.
 */
test("a model listed by one service is not written onto a machine default naming another", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  writeSettings(settingsPath({}, settingsHome), {
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  const { handle, calls } = providerHandle();
  // The default test config already sets pinned: true, on the codex preset.
  const app = await start(reply("x"), { rows: 16, cols: 96 }, {
    provider: handle,
    env: {},
    home: settingsHome,
  });

  app.input.type("/model gpt-5.6-sol-mini\r");
  await until(() => /nothing happened/.test(app.screen()), "the refusal");

  expect(calls).toHaveLength(0);
  expect(handle.model).toBe("gpt-5.6-sol");
  expect(readSettings(settingsPath({}, settingsHome))).toEqual({
    provider: "ollama",
    model: "llama3.2",
    baseUrl: "http://127.0.0.1:11434/v1",
  });

  // What a directory that pins nothing gets out of that file: still the pair
  // Ollama was set up with, not a model it was never asked to serve.
  const elsewhere = await mkdtemp(join(tmpdir(), "vesna-elsewhere-"));
  const config = await loadConfig(elsewhere, {}, settingsHome);
  expect(config.preset.id).toBe("ollama");
  expect(config.model).toBe("llama3.2");
  await quit(app);
});

/**
 * The same command where the two agree: the machine default is codex, this
 * directory pins codex, and the roster the name came from is codex's. There
 * the model moves, because the pair it lands in is one service's.
 */
test("a pinned project moves the machine default model when it is the same service", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  writeSettings(settingsPath({}, settingsHome), {
    provider: "codex",
    model: "gpt-5.6-sol",
    baseUrl: CODEX_BASE_URL,
  });
  const { handle, calls } = providerHandle();
  const app = await start(reply("x"), { rows: 16, cols: 96 }, {
    provider: handle,
    env: {},
    home: settingsHome,
  });

  app.input.type("/model gpt-5.6-sol-mini\r");
  await until(() => /unchanged here/.test(app.screen()), "the pinned notice");

  // Nothing changed here: the project pins its own service and model.
  expect(calls).toHaveLength(0);
  expect(handle.model).toBe("gpt-5.6-sol");

  const elsewhere = await mkdtemp(join(tmpdir(), "vesna-elsewhere-"));
  const config = await loadConfig(elsewhere, {}, settingsHome);
  expect(config.preset.id).toBe("codex");
  expect(config.model).toBe("gpt-5.6-sol-mini");
  await quit(app);
});

test("a pinned project with no machine default writes no half a default", async () => {
  const settingsHome = await mkdtemp(join(tmpdir(), "vesna-settings-"));
  const { handle } = providerHandle();
  const app = await start(reply("x"), { rows: 14, cols: 80 }, {
    provider: handle,
    env: {},
    home: settingsHome,
  });

  app.input.type("/model gpt-5.6-sol-mini\r");
  await until(() => /nothing happened/.test(app.screen()), "the notice");

  // A model with no provider beside it is inherited by nobody: writing one
  // would be a machine default that quietly does nothing.
  expect(readSettings(settingsPath({}, settingsHome))).toEqual({});
  expect(handle.model).toBe("gpt-5.6-sol");
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

/**
 * The header is the one line the user reads to know who is answering, and it
 * was drawn from `deps.config` — a snapshot of how the process started, which
 * nothing mutates. `/provider` moved the connection and left the header saying
 * the old service and the old model.
 *
 * Asserting on the whole screen would prove nothing: the switch confirmation in
 * the transcript names the new model too. Only the header row counts.
 */
test("the header follows the switch, not the config the process started with", async () => {
  const { handle } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: await mkdtemp(join(tmpdir(), "vesna-settings-")),
  });
  const headerRow = () => app.screen().split("\n")[0]!;

  expect(headerRow()).toContain("gpt-5.6-sol");

  app.input.type("/provider ollama\r");
  await until(() => /provider: ollama/.test(app.screen()), "the switch confirmation");

  expect(headerRow()).toContain("llama3.2");
  expect(headerRow()).not.toContain("gpt-5.6-sol");
  await quit(app);
});

test("the stored conversation records the model that answered it, not the one at startup", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-hist-"));
  const record = await openSession({ root: store, cwd: "/w", model: "gpt-5.6-sol" });
  const { handle } = providerHandle();
  const base = await deps(reply("x"));
  const app = await start(reply("x"), { rows: 14, cols: 64 }, {
    ...base,
    provider: handle,
    config: { ...base.config, pinned: false },
    env: {},
    home: await mkdtemp(join(tmpdir(), "vesna-settings-")),
    record,
    sessionsRoot: store,
  });

  app.input.type("/provider ollama\r");
  await until(() => /provider: ollama/.test(app.screen()), "the switch confirmation");

  // The write is a promise the app deliberately does not await, so poll for it
  // — and read it back through the real loader, not the in-memory summary.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stored = await readSession(store, record.id);
    if (stored?.summary.model === "llama3.2") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const stored = await readSession(store, record.id);
  expect(stored!.summary.model).toBe("llama3.2");
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

test("the model is told it is in the spec phase once spec.md exists and nobody has approved it", async () => {
  const systems: string[] = [];
  const p = provider(async (request) => {
    systems.push(request.system ?? "");
    return done("ok");
  });
  const base = await deps(p);
  const sink = createSink(specsRoot(base.root));
  const app = await start(p, { rows: 30, cols: 120 }, { ...base, sink });
  app.input.type("/spec new Phased work\r");
  await until(() => app.screen().includes("Phased work"), "the garden");

  app.input.type("first\r");
  await until(() => systems.length === 1, "the first turn");
  expect(systems[0]).toContain("## Phase: design");

  writeSpecFile(specPaths(specsRoot(base.root), sink.slug!).spec, "# Design\n");
  app.input.type("second\r");
  await until(() => systems.length === 2, "the second turn");
  expect(systems[1]).toContain("## Phase: spec");
  expect(systems[1]).toContain(specPaths(specsRoot(base.root), sink.slug!).spec);

  // A written, unapproved spec is asked about under the answer; y is the
  // approval, and a typed command would only be swallowed by the question.
  await until(() => app.screen().includes("approve the spec?"), "the spec question");
  app.input.type("y");
  await until(() => app.screen().includes("approved: spec"), "the approval");
  app.input.type("third\r");
  await until(() => systems.length === 3, "the third turn");
  expect(systems[2]).toContain("## Phase: plan");
  expect(systems[2]).toContain("Write the plan");

  app.input.type("/approve plan\r");
  await until(() => app.screen().includes("approved: plan"), "the plan approval");
  app.input.type("fourth\r");
  await until(() => systems.length === 4, "the fourth turn");
  expect(systems[3]).toContain("The plan is approved");
  expect(systems[3]).toContain("`/approve plan` again");
  await quit(app);
});

test("/spec new opens a garden on the right", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 130 });
  expect(app.screen()).not.toContain("Reliable cancellation");

  app.input.type("/spec new Reliable cancellation\r");
  await until(() => app.screen().includes("Reliable cancellation"), "the garden");
  // The stages are there from the first moment, so you know where you are.
  expect(app.screen()).toContain("design");
  expect(app.screen()).toContain("done");
  await quit(app);
});

test("ctrl-g hides the garden and brings it back", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 130 });
  app.input.type("/spec new Some work\r");
  // "done" only ever appears in the garden; the title also sits in the
  // command the user just typed, so it cannot tell the column apart.
  await until(() => app.screen().includes("done"), "the garden");

  app.input.type("\x07");
  await until(() => !app.screen().includes("done"), "the garden hidden");
  app.input.type("\x07");
  await until(() => app.screen().includes("done"), "the garden back");
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
  await until(() => app.screen().includes("done"), "the garden");
  app.input.type("\x07");
  await until(() => !app.screen().includes("done"), "hidden");

  app.input.type("/spec open cancellation-work\r");
  await until(() => app.screen().includes("done"), "reopened");
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

test("/approve plan writes the approval to the log, and nothing else can", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const app = await start(reply("x"), { rows: 24, cols: 100 }, { ...base, sink });
  app.input.type("/spec new gate\r");
  await until(() => app.screen().includes("gate"), "the spec");
  app.input.type("/approve plan\r");
  await until(() => app.screen().includes("approved: plan"), "the approval");
  const events = readEvents(specsRoot(base.root), "gate");
  expect(events.some((e) => e.t === "approved" && e.what === "plan")).toBe(true);
  await quit(app);
});

test("/classify writes a person's classification to the log, and the garden takes the person's word", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const app = await start(reply("x"), { rows: 30, cols: 120 }, { ...base, sink });
  app.input.type("/spec new Shaped work\r");
  await until(() => app.screen().includes("Shaped work"), "the garden");
  sink.emit({ t: "classified", shape: "architectural", by: "agent" });
  app.input.type("/classify bounded\r");
  await until(() => app.screen().includes("classified: bounded"), "the classification");
  const events = readEvents(specsRoot(base.root), sink.slug!);
  expect(events).toContainEqual({ t: "classified", shape: "bounded", by: "person" });
  expect(project(events)?.shape).toBe("bounded");
  await quit(app);
});

test("/classify with no sink refuses honestly", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 100 });
  app.input.type("/spec new Shaped work\r");
  await until(() => app.screen().includes("Shaped work"), "the garden");
  app.input.type("/classify bounded\r");
  await until(() => /cannot classify/.test(app.screen()), "the refusal");
  expect(app.screen()).not.toContain("classified: bounded");
  await quit(app);
});

test("/approve with no sink refuses honestly instead of claiming an effect it did not have", async () => {
  const app = await start(reply("x"), { rows: 24, cols: 100 });
  app.input.type("/spec new gate\r");
  await until(() => app.screen().includes("gate"), "the spec");
  app.input.type("/approve plan\r");
  await until(() => /cannot approve/.test(app.screen()), "the refusal");
  expect(app.screen()).not.toContain("approved: plan");
  await quit(app);
});

test("/build with nothing open is refused", async () => {
  const app = await start(reply("x"), { rows: 24, cols: 100 });
  app.input.type("/build\r");
  await until(() => /nothing to build/.test(app.screen()), "the refusal");
  await quit(app);
});

test("/build on an unapproved plan is refused, naming the command", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const app = await start(reply("x"), { rows: 24, cols: 100 }, { ...base, sink });
  app.input.type("/spec new gate\r");
  await until(() => app.screen().includes("gate"), "the spec");
  app.input.type("/build\r");
  await until(() => /not approved/.test(app.screen()), "the refusal");
  await quit(app);
});

/**
 * With no sink, a plan can never be approved — the only place that writes
 * the "approved" event is /approve above, and it refuses outright without a
 * sink to write into. So /build never reaches the sink it would need to
 * launch a build, even once a spec is open.
 */
test("/build without a sink never reaches for one, even with a spec open", async () => {
  const app = await start(reply("x"), { rows: 24, cols: 100 });
  app.input.type("/spec new gate\r");
  await until(() => app.screen().includes("gate"), "the spec");
  app.input.type("/build\r");
  await until(() => /not approved/.test(app.screen()), "the refusal");
  await quit(app);
});

test("/build on an approved plan starts, and the garden reflects what runBuild reports", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const app = await start(reply("x"), { rows: 24, cols: 100 }, { ...base, sink });
  app.input.type("/spec new gate\r");
  await until(() => app.screen().includes("gate"), "the spec");
  app.input.type("/approve plan\r");
  await until(() => app.screen().includes("approved: plan"), "the approval");
  app.input.type("/build\r");
  await until(() => /building 0 tasks/.test(app.screen()), "the start message");
  // No plan.md was ever written for this spec, so runBuild resolves right
  // away with a could-not-start outcome — its reason has to reach the
  // transcript, proving the loop's own wording is what is shown, not a
  // string composed here.
  await until(() => /there is no plan\.md to build/.test(app.screen()), "the outcome");
  await quit(app);
});

/** Writes a spec with the tasks and plan.md a real `/build` needs to start. */
function twoTaskSpec(specs: string, slug: string): void {
  createSpec(specs, slug);
  appendEvent(specs, slug, { t: "task.added", id: "T1", title: "First" });
  appendEvent(specs, slug, { t: "task.added", id: "T2", title: "Second" });
  appendEvent(specs, slug, { t: "approved", what: "plan" });
  writeSpecFile(
    specPaths(specs, slug).plan,
    "# Plan\n\n### Task 1: First\nDo it.\n\n### Task 2: Second\nDo it.\n",
  );
}

/** The same, but with only one task — enough for the mid-build tests below. */
function oneTaskSpec(specs: string, slug: string): void {
  createSpec(specs, slug);
  appendEvent(specs, slug, { t: "task.added", id: "T1", title: "First" });
  appendEvent(specs, slug, { t: "approved", what: "plan" });
  writeSpecFile(specPaths(specs, slug).plan, "# Plan\n\n### Task 1: First\nDo it.\n");
}

test("/build runs a real build against fake seams, task by task, in order", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  twoTaskSpec(specs, "gate");

  const app = await start(reply("x"), { rows: 50, cols: 120 }, { ...base, sink, buildSeams: buildFakes() });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /T2\s+merged/.test(app.screen()), "the second task merging");

  const screen = app.screen();
  const at = (needle: string) => screen.indexOf(needle);
  expect(at("T1  building")).toBeGreaterThanOrEqual(0);
  expect(at("T1  review: met, 0 findings")).toBeGreaterThan(at("T1  building"));
  expect(at("T1  merged")).toBeGreaterThan(at("T1  review: met, 0 findings"));
  expect(at("T2  building")).toBeGreaterThan(at("T1  merged"));
  expect(at("T2  review: met, 0 findings")).toBeGreaterThan(at("T2  building"));
  expect(at("T2  merged")).toBeGreaterThan(at("T2  review: met, 0 findings"));
  // The garden keeps the review mark beside a task after it merges.
  expect(screen).toContain("review 0: 0 open");
  await quit(app);
});

// Final fix round, item 2: the check's two runs have a line in the
// transcript, from the same `describeEvent` the shell prints — after the
// review verdict, and again before the merged line (the merge-stage check
// runs first, and `task.done` is written once it passes).
test("/build prints the check's result after the review and after the merge", async () => {
  const base = await deps(reply("x"));
  const specs = specsRoot(base.root);
  const sink = createSink(specs);
  createSpec(specs, "gate");
  appendEvent(specs, "gate", { t: "task.added", id: "T1", title: "First" });
  appendEvent(specs, "gate", { t: "approved", what: "plan" });
  writeSpecFile(specPaths(specs, "gate").plan, "# Plan\n\n### Task 1: First\nverify: bun test\n\nDo it.\n");
  const verify = async (r: { cwd: string }) => ({ code: 0, ms: r.cwd === base.root ? 61_250 : 14, timedOut: false, tail: "" });

  const app = await start(reply("x"), { rows: 50, cols: 120 }, { ...base, sink, buildSeams: { ...buildFakes(), verify } });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => readEvents(specs, "gate").at(-1)?.t === "build.done", "the build");
  await until(() => app.screen().includes("T1  verify (merge): ok in 61.3s"), "the merge-stage line");

  const screen = app.screen();
  const at = (needle: string) => screen.indexOf(needle);
  expect(at("T1  verify (review): ok in 0.0s")).toBeGreaterThan(at("T1  review: met, 0 findings"));
  expect(at("T1  verify (merge): ok in 61.3s")).toBeGreaterThan(at("T1  verify (review): ok in 0.0s"));
  expect(at("T1  merged")).toBeGreaterThan(at("T1  verify (merge): ok in 61.3s"));
  await quit(app);
});

test("/build while one is already running is refused", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  oneTaskSpec(specs, "gate");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seams = buildFakes();
  const build = async (r: { task: string }) => {
    await gate;
    return seams.build(r);
  };

  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: { ...seams, build } });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /T1\s+building/.test(app.screen()), "the task starting");
  app.input.type("/build\r");
  await until(() => /a build is already running/.test(app.screen()), "the refusal");
  release();
  await until(() => /T1\s+merged/.test(app.screen()), "the build finishing, so the run ends cleanly");
  await quit(app);
});

/**
 * A build seam parked on a gate the test opens, so a build can be held in
 * flight while the chat is driven around it.
 */
function gatedBuild() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seams = buildFakes();
  const build = async (r: { task: string }) => {
    await gate;
    return seams.build(r);
  };
  return { seams: { ...seams, build }, release };
}

/** A provider that counts its calls, for asserting that no turn ran. */
function counting(text: string) {
  let calls = 0;
  const p = provider(async () => {
    calls += 1;
    return done(text);
  });
  return { provider: p, calls: () => calls };
}

/**
 * Input is processed off the async iterator, so a keystroke the app answers
 * with nothing visible has no frame to wait for. One tick of the timer is
 * more than the dispatch takes.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 60));

for (const [name, initiate] of [
  ["ctrl-c twice", "\x03\x03"],
  ["/exit", "/exit\r"],
  ["ctrl-d", "\x04"],
] as const) {
  test(`quitting mid-build by ${name} cancels it first, and the log says so`, async () => {
    const base = await deps(reply("x"));
    const sink = createSink(specsRoot(base.root));
    const specs = specsRoot(base.root);
    oneTaskSpec(specs, "gate");
    const { seams, release } = gatedBuild();

    const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: seams });
    app.input.type("/spec open gate\r");
    await until(() => app.screen().includes("spec gate"), "the spec opening");
    app.input.type("/build\r");
    await until(() => /T1\s+building/.test(app.screen()), "the task starting");

    app.input.type(initiate);
    await until(() => app.screen().includes("cancelling the build before leaving"), "the notice");
    const notices = () =>
      app.screen().split("\n").filter((row) => /cancelling the build before leaving/.test(row)).length;
    // Still here while the loop winds down — and a second quit on any path
    // does not start a second wait or say it twice.
    const stillRunning = () =>
      Promise.race([app.finished.then(() => "finished"), new Promise((r) => setTimeout(() => r("running"), 50))]);
    expect(await stillRunning()).toBe("running");
    for (const again of ["\x03\x03", "/exit\r", "\x04"]) {
      app.input.type(again);
      await settled();
    }
    expect(await stillRunning()).toBe("running");
    expect(notices()).toBe(1);

    release();
    expect(await app.finished).toBe(0);
    const events = readEvents(specs, "gate");
    expect(events.some((e) => e.t === "build.stopped" && (e as any).reason === "interrupted")).toBe(true);
    expect(events.filter((e) => e.t === "build.stopped").length).toBe(1);
  });
}

test("a build that will not stop is left after the ceiling, and the last frame says so", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  oneTaskSpec(specs, "gate");
  const seams = buildFakes();
  // Never resolves, and ignores its signal: a worker that will not be stopped.
  const build = () => new Promise<BuildResult>(() => {});

  const app = await start(
    reply("x"),
    { rows: 40, cols: 120 },
    { ...base, sink, buildSeams: { ...seams, build }, quitCeilingMs: 200 },
  );
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /T1\s+building/.test(app.screen()), "the task starting");

  const began = Date.now();
  app.input.type("/exit\r");
  expect(await app.finished).toBe(0);
  expect(Date.now() - began).toBeGreaterThanOrEqual(200);
  expect(app.screen()).toContain("cancelling the build before leaving");
  expect(app.screen()).toContain("did not stop in time");
  // The loop never wrote build.stopped — nothing else may write it either.
  expect(readEvents(specs, "gate").some((e) => e.t === "build.stopped")).toBe(false);
});

test("a message typed during the cancel-before-quit wait is dropped, not answered", async () => {
  const p = counting("x");
  const base = await deps(p.provider);
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  oneTaskSpec(specs, "gate");
  const { seams, release } = gatedBuild();

  const app = await start(p.provider, { rows: 40, cols: 120 }, { ...base, sink, buildSeams: seams });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /T1\s+building/.test(app.screen()), "the task starting");

  app.input.type("/exit\r");
  await until(() => app.screen().includes("cancelling the build before leaving"), "the notice");
  app.input.type("hello there\r");
  await settled();
  release();
  expect(await app.finished).toBe(0);
  expect(p.calls()).toBe(0);
  const notices = app.screen().split("\n").filter((row) => /cancelling the build before leaving/.test(row)).length;
  expect(notices).toBe(1);
  expect(app.screen()).not.toContain("hello there");
});

test("/build cancel on a build another process holds is refused, and nothing is aborted", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  oneTaskSpec(specs, "gate");
  // A build in flight elsewhere: the log says building, and the lock names
  // a pid that is alive — this test's own.
  appendEvent(specs, "gate", { t: "build.started" });
  appendEvent(specs, "gate", { t: "task.started", id: "T1", agent: "vesna build" });
  writeFileSync(join(specPaths(specs, "gate").dir, "build.lock"), JSON.stringify({ pid: process.pid }));
  const before = readEvents(specs, "gate");

  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: buildFakes() });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build cancel\r");
  await until(() => app.screen().includes("that build is running in another process — stop it there"), "the refusal");
  expect(app.screen()).not.toContain("cancelling");
  expect(readEvents(specs, "gate")).toEqual(before);
  await quit(app);
});

test("/build resume sees a build killed in another process after the spec was opened", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  oneTaskSpec(specs, "gate");

  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: buildFakes() });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  // Another process starts a build and is killed: the log moves, the lock
  // names a pid that is gone, and this chat's copy of the spec is stale.
  appendEvent(specs, "gate", { t: "build.started" });
  appendEvent(specs, "gate", { t: "task.started", id: "T1", agent: "vesna build" });
  let pid = 999_999;
  while (pidAlive(pid)) pid += 1;
  writeFileSync(join(specPaths(specs, "gate").dir, "build.lock"), JSON.stringify({ pid }));

  app.input.type("/build resume\r");
  await until(() => app.screen().includes("resuming T1"), "the resume");
  // The checkout was never made, so the loop refuses the resume itself;
  // waiting for that keeps the run from ending mid-launch.
  await until(() => app.screen().includes('the checkout of "T1" is gone'), "the loop's refusal");
  await quit(app);
});

test("/build cancel interrupts the running build and the log ends with build.stopped interrupted", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  twoTaskSpec(specs, "gate");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seams = buildFakes();
  // A worker that honours its signal the way the real one does: the
  // provider's fetch rejects with an AbortError, `work()` catches it, and
  // what comes back is a failed result carrying the abort's text.
  const build = async (r: { task: string; signal?: AbortSignal }): Promise<BuildResult> => {
    await gate;
    if (r.signal?.aborted) {
      return { ...(await seams.build(r)), status: "failed", error: "The operation was aborted." };
    }
    return seams.build(r);
  };

  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: { ...seams, build } });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /T1\s+building/.test(app.screen()), "the first task");
  app.input.type("/build cancel\r");
  await until(() => app.screen().includes("cancelling"), "the cancel line");
  release();
  await until(() => app.screen().includes("stopped: interrupted"), "the stop");
  const events = readEvents(specs, "gate");
  expect(events.at(-1)).toEqual({ t: "build.stopped", reason: "interrupted" });
  // T2 was never started: the cancel landed before it, and nothing rebuilt it.
  expect(events.some((e) => e.t === "task.started" && (e as any).id === "T2")).toBe(false);
  await quit(app);
});

test("/build on a dead build refuses with the three actions, and /build resume continues it", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  // The log a killed process left behind: T1 merged, T2 in flight, no
  // build.stopped, and no lock file — a lock nobody holds reads as dead.
  createSpec(specs, "work");
  const deadAfterT1: SpecEvent[] = [
    { t: "task.added", id: "T1", title: "First" },
    { t: "task.added", id: "T2", title: "Second", dependsOn: ["T1"] },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "task.started", id: "T1", agent: "vesna build" },
    { t: "task.done", id: "T1", commit: "sha-T1" },
    { t: "task.started", id: "T2", agent: "vesna build" },
  ];
  for (const event of deadAfterT1) appendEvent(specs, "work", event);
  writeSpecFile(
    specPaths(specs, "work").plan,
    "# Plan\n\n### Task 1: First\nDo it.\n\n### Task 2: Second\nDo it.\n",
  );
  // Resume refuses a checkout that is not really there, so T2 gets a
  // directory that the git seam reports as a registered worktree.
  const path = worktreePath(base.root, "work", "T2");
  mkdirSync(path, { recursive: true });
  const branch = branchName("work", "T2");
  const seams = buildFakes();
  const git = async (args: string[]) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return {
        code: 0,
        stdout: `worktree ${path}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/${branch}\n\n`,
        stderr: "",
      };
    }
    return seams.git(args);
  };

  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: { ...seams, git } });
  app.input.type("/spec open work\r");
  await until(() => app.screen().includes("spec work"), "the spec opening");
  app.input.type("/build\r");
  await until(() => app.screen().includes("was interrupted"), "the refusal");
  app.input.type("/build resume\r");
  await until(() => app.screen().includes("resuming T2"), "the resume");
  await until(() => /T2\s+merged/.test(app.screen()), "the resumed task merging");
  await until(() => app.screen().split("\n").some((row) => /(^|\s)done\s*$/.test(row)), "the build");
  const events = readEvents(specs, "work");
  expect(events.some((e) => e.t === "build.recovered" && (e as any).action === "resume")).toBe(true);
  expect(events.at(-1)).toEqual({ t: "build.done" });
  await quit(app);
});

test("/spec new refuses while a build is running, and creates nothing", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  oneTaskSpec(specs, "gate");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seams = buildFakes();
  const build = async (r: { task: string }) => {
    await gate;
    return seams.build(r);
  };

  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: { ...seams, build } });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /T1\s+building/.test(app.screen()), "the task starting");
  app.input.type("/spec new Something else\r");
  await until(() => /a build is running — wait for it to stop before switching specs/.test(app.screen()), "the refusal");
  const { listSpecs } = await import("../../src/spec/store");
  expect(listSpecs(specs).map((s) => s.slug)).toEqual(["gate"]);
  expect(sink.slug).toBe("gate");
  release();
  await until(() => /T1\s+merged/.test(app.screen()), "the build finishing, so the run ends cleanly");
  await quit(app);
});

test("/spec open refuses while a build is running, so its events are not redirected", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  oneTaskSpec(specs, "gate");
  createSpec(specs, "other");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seams = buildFakes();
  const build = async (r: { task: string }) => {
    await gate;
    return seams.build(r);
  };

  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: { ...seams, build } });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /T1\s+building/.test(app.screen()), "the task starting");
  app.input.type("/spec open other\r");
  await until(() => /a build is running — wait for it to stop/.test(app.screen()), "the refusal");
  release();
  await until(() => /T1\s+merged/.test(app.screen()), "the build finishing, so the run ends cleanly");
  await quit(app);
});

test("a stopped build's reason is printed once, not once per surface", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  oneTaskSpec(specs, "gate");
  const seams = buildFakes();
  const build = async (r: { task: string }): Promise<BuildResult> => ({
    ...(await seams.build(r)),
    status: "refused",
    refusals: ["write .env"],
  });
  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: { ...seams, build } });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /stopped: T1: the worker was not allowed to: write \.env/.test(app.screen()), "the stop");
  // Give the promise's own handler time to print, if it were going to.
  await new Promise((resolve) => setTimeout(resolve, 30));
  // "T1  failed: …" is the task's own event and stays; the build's reason
  // ("T1: the worker …") must appear once, as "stopped: …", not again bare.
  const mentions = app.screen().split("\n").filter((row) => /T1: the worker was not allowed to: write \.env/.test(row));
  expect(mentions).toHaveLength(1);
  expect(mentions[0]).toMatch(/stopped: T1: the worker/);
  await quit(app);
});

test("a build that could not start says why, since no event carries it", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  createSpec(specs, "gate");
  appendEvent(specs, "gate", { t: "task.added", id: "T1", title: "First" });
  appendEvent(specs, "gate", { t: "approved", what: "plan" });
  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: buildFakes() });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /there is no plan\.md to build/.test(app.screen()), "the reason");
  await quit(app);
});

test("a build that rejects instead of resolving shows up in the transcript, and the process survives it", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  oneTaskSpec(specs, "gate");

  const seams = buildFakes();
  // An ordinary git failure deep inside a real worker's own commit — see
  // src/work/builder.ts's `commit()` — throws a plain Error, which `runBuild`
  // does not catch into a `Stop`. This fakes that exact shape without a real
  // checkout: `build` rejecting is what makes `runBuild`'s own promise
  // reject, which is the case the missing `.catch` in app.ts left unhandled.
  const build = async (): Promise<BuildResult> => {
    throw new Error("git add failed: boom");
  };

  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: { ...seams, build } });
  app.input.type("/spec open gate\r");
  await until(() => app.screen().includes("spec gate"), "the spec opening");
  app.input.type("/build\r");
  await until(() => /build failed: git add failed: boom/.test(app.screen()), "the failure reaching the transcript");
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

test("the idle hint names the mode and the shift-tab that changes it", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 100 });
  await until(() => app.screen().includes("shift-tab: ask → auto"), "the hint");
  expect(app.screen()).toContain("/help · shift-tab: ask → auto · ctrl-c twice to leave");
  await quit(app);
});

test("shift-tab walks the three modes and comes back round", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 100 });
  expect(app.screen()).toContain("ask");

  app.input.type("\x1b[Z");
  // The idle hint always names the next mode, so a bare "auto" is on screen
  // even before the switch (as part of "ask → auto"); wait for the hint that
  // only appears once the mode has actually become auto.
  await until(() => app.screen().includes("shift-tab: auto → plan"), "auto");
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

/** The log a killed process left behind, with T2's checkout registered through the git seam. */
function deadBuildWithCheckout(root: string, specs: string) {
  createSpec(specs, "work");
  const deadAfterT1: SpecEvent[] = [
    { t: "task.added", id: "T1", title: "First" },
    { t: "task.added", id: "T2", title: "Second", dependsOn: ["T1"] },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "task.started", id: "T1", agent: "vesna build" },
    { t: "task.done", id: "T1", commit: "sha-T1" },
    { t: "task.started", id: "T2", agent: "vesna build" },
  ];
  for (const event of deadAfterT1) appendEvent(specs, "work", event);
  writeSpecFile(specPaths(specs, "work").plan, "# Plan\n\n### Task 1: First\nDo it.\n\n### Task 2: Second\nDo it.\n");
  const path = worktreePath(root, "work", "T2");
  mkdirSync(path, { recursive: true });
  return { path, branch: branchName("work", "T2") };
}

test("a second /build typed while the first is still before its lock is refused, not launched twice", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const specs = specsRoot(base.root);
  const { path, branch } = deadBuildWithCheckout(base.root, specs);

  // The loop checks the checkout before it takes the lock; holding that
  // answer keeps the first resume in its pre-lock await, where the log and
  // the lock still read as dead.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seams = buildFakes();
  let resumes = 0;
  const resume = async (r: { task: string }) => {
    resumes += 1;
    return seams.resume(r);
  };
  const git = async (args: string[]) => {
    if (args[0] === "worktree" && args[1] === "list") {
      await gate;
      return {
        code: 0,
        stdout: `worktree ${path}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/${branch}\n\n`,
        stderr: "",
      };
    }
    return seams.git(args);
  };

  const app = await start(reply("x"), { rows: 40, cols: 120 }, { ...base, sink, buildSeams: { ...seams, resume, git } });
  app.input.type("/spec open work\r");
  await until(() => app.screen().includes("spec work"), "the spec opening");
  app.input.type("/build resume\r");
  await until(() => app.screen().includes("resuming T2"), "the first resume");
  app.input.type("/build resume\r");
  await until(() => app.screen().includes("a build is already running"), "the refusal");
  release();
  await until(() => /T2\s+merged/.test(app.screen()), "the resumed task merging");
  await until(() => readEvents(specs, "work").at(-1)?.t === "build.done", "the build");

  const rows = app.screen().split("\n");
  expect(rows.filter((row) => row.includes("resuming T2")).length).toBe(1);
  expect(rows.filter((row) => row.includes("a build is already running")).length).toBe(1);
  expect(app.screen()).not.toContain("already running (pid");
  expect(resumes).toBe(1);
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "build.recovered").length).toBe(1);
  expect(events.at(-1)).toEqual({ t: "build.done" });
  await quit(app);
});

/**
 * A spec whose plan is written and waits for a person: the spec approved, two
 * tasks in the log, and a plan.md whose first task declares a check.
 */
async function unapprovedPlanApp(p: Provider = reply("x")) {
  const base = await deps(p);
  const specs = specsRoot(base.root);
  const sink = createSink(specs);
  const slug = "gate";
  createSpec(specs, slug);
  appendEvent(specs, slug, { t: "approved", what: "spec" });
  appendEvent(specs, slug, { t: "task.added", id: "T1", title: "a" });
  appendEvent(specs, slug, { t: "task.added", id: "T2", title: "b" });
  writeSpecFile(specPaths(specs, slug).plan, "### Task 1: a\nverify: bun test\n\n### Task 2: b\n");
  const app = await start(p, { rows: 40, cols: 120 }, { ...base, sink });
  app.input.type(`/spec open ${slug}\r`);
  await until(() => app.screen().includes(`spec ${slug}`), "the spec opening");
  return { app, specs, slug };
}

/** Whether `runApp` has returned, without waiting for it. */
async function stillRunning(app: { finished: Promise<number> }): Promise<boolean> {
  const marker = Symbol("running");
  const raced = await Promise.race([app.finished, new Promise<symbol>((r) => setTimeout(() => r(marker), 100))]);
  return raced === marker;
}

test("after a turn with an unapproved plan the chat asks, y approves with the plan's digest, and the question does not return", async () => {
  const { app, specs, slug } = await unapprovedPlanApp();
  app.input.type("hello\r");
  await until(() => app.screen().includes("approve the plan? [y] yes  [n] not yet"), "the question");
  expect(app.screen()).toContain("verify: bun test");
  app.input.type("y");
  await until(() => app.screen().includes("approved: plan"), "the approval");
  const approved = readEvents(specs, slug).find((e: any) => e.t === "approved" && e.what === "plan") as any;
  expect(approved.digest).toBe(digestOf(join(specs, slug, "plan.md")));
  app.input.type("hello again\r");
  await until(() => app.screen().split("hello again").length > 1, "the second turn");
  expect(app.screen().split("approve the plan?").length).toBe(2); // asked once
  await quit(app);
});

// Final fix round, item 3: the digest names the text whose tasks were
// listed, not whatever plan.md holds at the moment of y. An edit between
// the question and the answer approves the text that was read; the loop's
// refusal then says the plan changed.
test("y writes the digest of the plan the question was asked about, not of a plan edited while it was up", async () => {
  const { app, specs, slug } = await unapprovedPlanApp();
  const asked = digestOf(specPaths(specs, slug).plan);
  app.input.type("hello\r");
  await until(() => app.screen().includes("approve the plan? [y] yes  [n] not yet"), "the question");
  writeSpecFile(specPaths(specs, slug).plan, "### Task 1: a\nverify: bun test tests/other.test.ts\n\n### Task 2: b\n");
  const edited = digestOf(specPaths(specs, slug).plan);
  expect(edited).not.toBe(asked);
  app.input.type("y");
  await until(() => app.screen().includes("approved: plan"), "the approval");
  const approved = readEvents(specs, slug).find((e: any) => e.t === "approved" && e.what === "plan") as any;
  expect(approved.digest).toBe(asked);
  await quit(app);
});

test("n leaves the log alone and the question comes back after the next turn", async () => {
  const { app, specs, slug } = await unapprovedPlanApp();
  app.input.type("hello\r");
  await until(() => app.screen().includes("approve the plan?"), "the question");
  app.input.type("n");
  app.input.type("more\r");
  await until(() => app.screen().split("approve the plan?").length === 3, "asked again");
  expect(readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan")).toBe(false);
  // The question owns the keyboard until it is answered: a ctrl-c now says
  // "not yet", it does not start leaving.
  app.input.type("n");
  // Two questions, each naming "[n] not yet", and two answers saying it.
  await until(() => app.screen().split("not yet").length === 5, "the second not yet");
  await quit(app);
});

test("/approve plan writes the digest too", async () => {
  const { app, specs, slug } = await unapprovedPlanApp();
  app.input.type("/approve plan\r");
  await until(() => app.screen().includes("approved: plan"), "the approval");
  const approved = readEvents(specs, slug).find((e: any) => e.t === "approved" && e.what === "plan") as any;
  expect(approved.digest).toBe(digestOf(specPaths(specs, slug).plan));
  await quit(app);
});

test("enter is not yes for the approval question: /exit and a bare enter leave it standing, only y approves", async () => {
  const { app, specs, slug } = await unapprovedPlanApp();
  app.input.type("hello\r");
  await until(() => app.screen().includes("approve the plan?"), "the question");
  app.input.type("/exit\r");
  expect(await stillRunning(app)).toBe(true);
  expect(readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan")).toBe(false);
  expect(app.screen()).toContain("approve the plan? [y] yes  [n] not yet");
  expect(app.screen()).not.toContain("approved: plan");
  app.input.type("\r");
  expect(await stillRunning(app)).toBe(true);
  expect(readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan")).toBe(false);
  expect(app.screen()).not.toContain("approved: plan");
  app.input.type("y");
  await until(() => app.screen().includes("approved: plan"), "the approval");
  expect(readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan")).toBe(true);
  await quit(app);
});

test("the question is not asked after an interrupted turn, and returns after the next completed one", async () => {
  const turn = halfway("work", "ing");
  const { app } = await unapprovedPlanApp(turn.provider);
  app.input.type("go\r");
  await until(() => app.screen().includes("work"), "the turn to start");
  app.input.type("\x03");
  // The garden shares the row, so match the transcript side of it.
  await until(
    () => app.screen().split("\n").some((row) => row.split("│")[0]!.trim() === "interrupted"),
    "the interruption notice",
  );
  expect(app.screen()).not.toContain("approve the plan?");
  turn.release();
  app.input.type("again\r");
  await until(() => app.screen().includes("approve the plan?"), "the question after a completed turn");
  app.input.type("n");
  await until(() => app.screen().split("not yet").length === 3, "the answer");
  await quit(app);
});

// Fix round 1: what the screen shows once, and what it waits for.

test("a sent message is quoted back exactly once", async () => {
  const app = await start(reply("All done."));
  app.input.type("do it\r");
  await until(() => app.screen().includes("All done."), "the answer");
  const rows = app.screen().split("\n");
  expect(rows.filter((row) => row.includes("› do it")).length).toBe(1);
  expect(rows.filter((row) => row.includes("copy")).length).toBe(2);
  await quit(app);
});

test("a message typed behind the approval question waits for the answer; the question is asked once", async () => {
  const { app, specs, slug } = await unapprovedPlanApp();
  app.input.type("hello\rmore\r");
  await until(() => app.screen().includes("approve the plan?"), "the question");
  await settled();
  const count = (needle: string) => app.screen().split(needle).length - 1;
  expect(count("approve the plan?")).toBe(1);
  expect(count("› more")).toBe(0);
  app.input.type("y");
  await until(() => app.screen().includes("› more"), "the second turn");
  await until(() => count("x") >= 2, "the second answer");
  expect(count("approve the plan?")).toBe(1);
  expect(count("approved: plan")).toBe(1);
  expect(count("› hello")).toBe(1);
  expect(count("› more")).toBe(1);
  expect(readEvents(specs, slug).filter((e: any) => e.t === "approved" && e.what === "plan")).toHaveLength(1);
  await quit(app);
});

test("a refused /spec open leaves a hidden garden hidden", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 130 });
  app.input.type("/spec new first thing\r");
  await until(() => app.screen().includes("done"), "the garden");
  app.input.type("\x07");
  await until(() => !app.screen().includes("done"), "the garden hidden");
  app.input.type("/spec open nothing-here\r");
  await until(() => app.screen().includes('no spec called "nothing-here"'), "the refusal");
  expect(app.screen().split("\n").filter((row) => /(^|\s)done\s*$/.test(row)).length).toBe(0);
  expect(app.screen()).not.toContain("│");
  await quit(app);
});

// Fix round 2: shift-tab is a key, not a typed line; a typed line waits behind a question.

test("shift-tab changes the mode without quoting a command nobody typed; /mode typed is quoted once", async () => {
  const app = await start(reply("x"), { rows: 20, cols: 100 });
  app.input.type("\x1b[Z");
  await until(() => app.screen().includes("shift-tab: auto → plan"), "auto");
  const count = (needle: string) => app.screen().split(needle).length - 1;
  expect(count("› /mode")).toBe(0);
  expect(count("mode: auto  changes go ahead")).toBe(1);
  app.input.type("/mode plan\r");
  await until(() => app.screen().includes("mode: plan"), "plan");
  expect(count("› /mode plan")).toBe(1);
  expect(count("› /mode")).toBe(1);
  await quit(app);
});

test("/help typed behind the approval question waits for the answer", async () => {
  const { app } = await unapprovedPlanApp();
  app.input.type("hello\r/help\r");
  await until(() => app.screen().includes("approve the plan?"), "the question");
  await settled();
  const count = (needle: string) => app.screen().split(needle).length - 1;
  expect(count("alt-enter newline")).toBe(0);
  expect(count("approve the plan?")).toBe(1);
  app.input.type("y");
  await until(() => app.screen().includes("alt-enter newline"), "the listing");
  expect(count("approved: plan")).toBe(1);
  expect(count("alt-enter newline")).toBe(1);
  // The answer's consequence lands before the line that waited behind it.
  expect(app.screen().indexOf("approved: plan")).toBeLessThan(app.screen().indexOf("› /help"));
  await quit(app);
});

test("/exit typed behind the approval question does not leave while it stands", async () => {
  const { app, specs, slug } = await unapprovedPlanApp();
  app.input.type("hello\r/exit\r");
  await until(() => app.screen().includes("approve the plan?"), "the question");
  expect(await stillRunning(app)).toBe(true);
  expect(readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan")).toBe(false);
  app.input.type("n");
  expect(await app.finished).toBe(0);
  expect(readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan")).toBe(false);
});

// Final fix round.

test("the keys after an answer in the same chunk are dropped: y then ctrl-c does not interrupt the turn", async () => {
  const { registry, ran } = writing();
  const caller = toolCaller("put", { path: "src/a.ts" });
  const app = await start(caller, { rows: 20, cols: 90 }, await allowing(caller, registry));
  app.input.type("go\r");
  await until(() => app.screen().includes("[y] allow"), "the question");
  app.input.type("y\x03");
  await until(() => app.screen().includes("finished"), "the turn running on to its end");
  const rows = app.screen().split("\n");
  expect(rows.filter((row) => row.trim() === "interrupted").length).toBe(0);
  expect(rows.filter((row) => row.includes("allowed once")).length).toBe(1);
  expect(ran).toEqual(["src/a.ts"]);
  await quit(app);
});

test("y then ctrl-c in one chunk behind the approval question approves, and arms nothing", async () => {
  const { app, specs, slug } = await unapprovedPlanApp();
  app.input.type("hello\r");
  await until(() => app.screen().includes("approve the plan?"), "the question");
  app.input.type("y\x03");
  await until(() => app.screen().includes("approved: plan"), "the approval");
  await settled();
  expect(app.screen().split("again to leave").length - 1).toBe(0);
  expect(readEvents(specs, slug).filter((e: any) => e.t === "approved" && e.what === "plan")).toHaveLength(1);
  await quit(app);
});

test("a core method that rejects on a key path is a notice, and the terminal is still restored", async () => {
  const writes: string[] = [];
  const terminal: Terminal = { size: () => ({ rows: 20, cols: 100 }), write: (t) => void writes.push(t) };
  const screen = () => writes.join("").replace(/\x1b\[[0-9;]*m/g, "");
  const input = keyboard();
  const base = await deps(reply("x"));
  const real = createCore(base);
  // The real core, except that a mode change fails: what a rejection on a
  // key-driven path — no await, no try — does to the screen.
  const core: Core = { ...real, command: (name, argument, options) => (name === "mode" ? Promise.reject(new Error("boom")) : real.command(name, argument, options)) };
  const finished = runApp({ ...base, core }, { terminal, input });
  await until(() => screen().includes("vesna"), "the first frame");
  input.type("\x1b[Z");
  await until(() => screen().includes("Error: boom"), "the failure as a notice");
  input.type("\x03\x03");
  expect(await finished).toBe(0);
  expect(writes.join("")).toContain("\x1b[?1049l");
});

test("the status line's token count is current while a permission question stands", async () => {
  const { registry } = writing();
  const caller = toolCaller("put", { path: "src/a.ts" });
  const app = await start(caller, { rows: 20, cols: 90 }, await allowing(caller, registry));
  app.input.type("go\r");
  await until(() => app.screen().includes("[y] allow"), "the question");
  // The call that asked cost one token in and one out; the status says so now, not after the answer.
  expect(app.screen().split("\n").filter((row) => /ask · 2 tok/.test(row)).length).toBe(1);
  app.input.type("y");
  await until(() => app.screen().includes("finished"), "the turn");
  await quit(app);
});
