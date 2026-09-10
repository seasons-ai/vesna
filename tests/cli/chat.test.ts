import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChat, type ChatDeps } from "../../src/cli/chat";
import { createRegistry } from "../../src/registry/registry";
import { createTraceStore } from "../../src/store/trace";
import { findPreset } from "../../src/providers/catalog";
import type { VesnaConfig } from "../../src/cli/config";
import type { Provider } from "../../src/providers/types";
import { resolveTheme } from "../../src/tui/theme";

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

async function chat(provider: Provider, lines: string[]): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "vesna-plain-"));
  const config: VesnaConfig = {
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
  const deps: ChatDeps = {
    registry: createRegistry(),
    provider,
    store: createTraceStore(join(root, ".vesna", "traces")),
    config,
    theme: resolveTheme("mono", { depth: 0 }),
    root,
    io: scripted(lines),
  };

  const printed: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
  try {
    await runChat(deps);
  } finally {
    console.log = real;
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

  expect(text).toContain("/crystallize");
  expect(text).toContain("/cost");
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
