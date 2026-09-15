import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat, type ChatDeps } from "../../src/cli/chat";
import { createRegistry } from "../../src/registry/registry";
import { findPreset } from "../../src/providers/catalog";
import type { VesnaConfig } from "../../src/cli/config";
import type { Provider } from "../../src/providers/types";
import { resolveTheme } from "../../src/tui/theme";
import { toolCaller, writing } from "../helpers/chat";

/** Counts every completion, so "did this line reach a model" is answerable. */
function counting() {
  const state = { calls: 0 };
  const provider: Provider = {
    id: "fake",
    async complete() {
      state.calls += 1;
      return {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        model: "fake",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  return { state, provider };
}

/** The typed lines, in order. Anything after them is `/exit`. */
function scripted(lines: string[]) {
  return {
    write() {},
    async question() {
      return lines.shift() ?? "/exit";
    },
    close() {},
  };
}

const CONFIG: VesnaConfig = {
  configured: true,
  preset: findPreset("codex")!,
  pinned: false,
  provider: "openai",
  auth: "codex",
  model: "test-model",
  theme: "mono",
  prices: {},
  permissions: { nodes: [] },
};

/**
 * Runs the chat over the scripted lines and returns what `console.log`
 * printed. The answer itself streams through `process.stdout.write`, which
 * is captured too so the runner's output stays clean.
 */
async function chat(provider: Provider, lines: string[], overrides: Partial<ChatDeps> = {}): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "vesna-plain-"));
  const deps: ChatDeps = {
    registry: createRegistry(),
    provider,
    config: CONFIG,
    theme: resolveTheme("mono", { depth: 0 }),
    root,
    io: scripted(lines),
    ...overrides,
  };

  const printed: string[] = [];
  const real = console.log;
  const write = process.stdout.write;
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await runChat(deps);
  } finally {
    console.log = real;
    process.stdout.write = write;
  }
  return printed;
}

/**
 * `/provider` and `/model` were added to the shared `CHAT_COMMANDS`, so the
 * line-based chat lists them in `/help` — and implements neither. An
 * unimplemented command fell out of the command block and into the turn below
 * it as an empty message: a paid request, sent in answer to a command, with
 * nothing in it.
 */
test("a command this surface does not implement is refused, not sent to the model", async () => {
  const { state, provider } = counting();
  const printed = await chat(provider, ["/provider ollama"]);

  expect(state.calls).toBe(0);
  expect(printed.join("\n")).toContain("/provider needs the full-screen chat");
});

test("the same is true of the other full-screen commands", async () => {
  const { state, provider } = counting();
  const printed = await chat(provider, ["/model qwen3", "/history", "/theme mono"]);

  expect(state.calls).toBe(0);
  const text = printed.join("\n");
  for (const name of ["/model", "/history", "/theme"]) {
    expect(text).toContain(`${name} needs the full-screen chat`);
  }
});

test("/help here lists what this surface can do, and says where the rest are", async () => {
  const { provider } = counting();
  const printed = await chat(provider, ["/help"]);
  const text = printed.join("\n");

  expect(text).toContain("/cost");
  expect(text).toContain("/clear");
  // Not offered as commands of this chat, since typing them does nothing here.
  expect(text).not.toMatch(/^ {2}\/provider\s/m);
  expect(text).not.toMatch(/^ {2}\/model\s/m);
  // Not a secret either: one line says where they live.
  expect(text).toContain("the full-screen chat has more");
});

test("an ordinary message still reaches the model", async () => {
  const { state, provider } = counting();
  await chat(provider, ["do the thing"]);
  expect(state.calls).toBe(1);
});

/**
 * The plain chat is a client of the same core as the full-screen one, so a
 * permission is a question here too: its lines are printed, and the next
 * line typed is the answer — read from the same stdin the loop reads.
 */
test("a permission asks on stdout and takes its answer from the next line", async () => {
  const { registry, ran } = writing();
  const provider = toolCaller("put", { path: "src/a.ts" });
  const printed = await chat(provider, ["run it", "y", "/help"], {
    registry,
    config: { ...CONFIG, permissions: { nodes: ["put"] } },
    policy: { mode: "ask", allow: {}, deny: {} },
  });
  const text = printed.join("\n");

  expect(text).toMatch(/^ {2}put\s/m);
  expect(text).toContain("[y] allow once");
  expect(text).toContain("allowed once");
  expect(ran).toEqual(["src/a.ts"]);
  // The line after the answer is the next input, taken after the answer.
  expect(text.indexOf("allowed once")).toBeLessThan(text.indexOf("/cost"));
});

test("n refuses, and a line that is not an answer does not decide", async () => {
  const { registry, ran } = writing();
  const provider = toolCaller("put", { path: "src/a.ts" });
  const printed = await chat(provider, ["run it", "what?", "n"], {
    registry,
    config: { ...CONFIG, permissions: { nodes: ["put"] } },
    policy: { mode: "ask", allow: {}, deny: {} },
  });

  expect(printed.join("\n")).toContain("refused");
  expect(ran).toEqual([]);
});

/**
 * Idle ctrl-c is the third way out of the plain chat, and it leaves through
 * the same door as `/exit`: the core is closed before the process goes, so
 * a line typed into the leaving is not sent, and nothing runs behind it.
 */
test("idle ctrl-c closes the core before leaving", async () => {
  const { state, provider } = counting();
  const exits: number[] = [];
  const realExit = process.exit;
  process.exit = ((code?: number) => void exits.push(code ?? 0)) as typeof process.exit;
  let asked = 0;
  const io = {
    write() {},
    async question() {
      asked += 1;
      // The person presses ctrl-c at the prompt, then types a line anyway.
      if (asked === 1) {
        process.emit("SIGINT");
        // The handler's close is asynchronous; give it its turn.
        await new Promise((r) => setTimeout(r, 10));
        return "hello";
      }
      return "/exit";
    },
    close() {},
  };
  try {
    await chat(provider, [], { io });
  } finally {
    process.exit = realExit;
  }
  expect(exits).toEqual([0]);
  expect(state.calls).toBe(0);
});

test("/mcp prints the same lines as the full-screen chat, and closes the servers on exit", async () => {
  const { state, provider } = counting();
  const closed = { count: 0 };
  const mcp = {
    servers: [
      { name: "github", status: "up" as const, tools: 12 },
      { name: "db", status: "down" as const, tools: 0, problem: "server db is down: exited with code 1" },
    ],
    async close() {
      closed.count += 1;
    },
  };
  const printed = await chat(provider, ["/mcp"], { mcp });

  expect(state.calls).toBe(0);
  const text = printed.join("\n");
  expect(text).toContain("github       up       12 tools");
  expect(text).toContain("db           down     server db is down: exited with code 1");
  expect(closed.count).toBe(1);
});
