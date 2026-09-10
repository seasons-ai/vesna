import { test, expect } from "bun:test";
import { createProviderHandle } from "../../src/cli/context";
import { findPreset } from "../../src/providers/catalog";
import type { CompletionRequest, CompletionResult, Provider } from "../../src/providers/types";

function stub(id: string): Provider {
  return {
    id,
    async complete(_request: CompletionRequest): Promise<CompletionResult> {
      return {
        content: [{ type: "text", text: id }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: id,
      };
    },
  };
}

const anthropic = findPreset("anthropic")!;
const ollama = findPreset("ollama")!;

test("the handle answers as the provider it currently holds", async () => {
  const handle = await createProviderHandle(anthropic, "claude-opus-5", undefined, async (p) =>
    stub(p.id),
  );
  const result = await handle.complete({ model: "m", messages: [] });
  expect(result.model).toBe("anthropic");
  expect(handle.id).toBe("anthropic");
});

test("switching changes who answers, without a new handle", async () => {
  const handle = await createProviderHandle(anthropic, "claude-opus-5", undefined, async (p) =>
    stub(p.id),
  );
  await handle.switch(ollama, "qwen3");
  expect((await handle.complete({ model: "m", messages: [] })).model).toBe("ollama");
  expect(handle.preset.id).toBe("ollama");
  expect(handle.model).toBe("qwen3");
});

test("a build that throws leaves the working provider in place", async () => {
  const handle = await createProviderHandle(anthropic, "claude-opus-5", undefined, async (p) => {
    if (p.id === "ollama") throw new Error("refused");
    return stub(p.id);
  });
  await expect(handle.switch(ollama, "qwen3")).rejects.toThrow("refused");
  expect(handle.preset.id).toBe("anthropic");
  expect((await handle.complete({ model: "m", messages: [] })).model).toBe("anthropic");
});
