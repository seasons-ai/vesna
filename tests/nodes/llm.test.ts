import { test, expect } from "bun:test";
import { createLlmNode } from "../../src/nodes/llm";
import type { Provider } from "../../src/providers/types";

function fakeProvider(): Provider & { lastRequest: any } {
  const provider: any = {
    id: "fake",
    lastRequest: null,
    async complete(request: any) {
      provider.lastRequest = request;
      return {
        content: [{ type: "text", text: "Report for Acme" }],
        stopReason: "end_turn",
        model: request.model,
        usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  return provider;
}

const ctx = { cwd: ".", signal: new AbortController().signal };

test("returns concatenated text with usage and cost", async () => {
  const result: any = await createLlmNode(fakeProvider()).run({ prompt: "Summarize" }, ctx);
  expect(result.text).toBe("Report for Acme");
  expect(result.usage.outputTokens).toBe(500);
  expect(result.costUsd).toBeGreaterThan(0);
});

test("defaults to claude-opus-5 and honours an explicit model", async () => {
  const provider = fakeProvider();
  const node = createLlmNode(provider);

  await node.run({ prompt: "x" }, ctx);
  expect(provider.lastRequest.model).toBe("claude-opus-5");

  await node.run({ prompt: "x", model: "claude-sonnet-5" }, ctx);
  expect(provider.lastRequest.model).toBe("claude-sonnet-5");
});

test("never sends sampling parameters", async () => {
  const provider = fakeProvider();
  await createLlmNode(provider).run({ prompt: "x" }, ctx);
  expect(provider.lastRequest.temperature).toBeUndefined();
  expect(provider.lastRequest.top_p).toBeUndefined();
  expect(provider.lastRequest.top_k).toBeUndefined();
});

test("is declared as a pure effect", () => {
  expect(createLlmNode(fakeProvider()).effect).toBe("pure");
});
