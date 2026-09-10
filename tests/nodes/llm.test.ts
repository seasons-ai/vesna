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

test("defaults to claude-opus-5 for a provider that names no model, and honours an explicit one", async () => {
  const provider = fakeProvider();
  const node = createLlmNode(provider);

  await node.run({ prompt: "x" }, ctx);
  expect(provider.lastRequest.model).toBe("claude-opus-5");

  await node.run({ prompt: "x", model: "claude-sonnet-5" }, ctx);
  expect(provider.lastRequest.model).toBe("claude-sonnet-5");
});

/**
 * The agent is offered `llm` as a tool, its `model` field described as
 * "defaults to the configured one" — and it defaulted to `claude-opus-5`
 * whatever was configured. After onboarding onto Ollama, the agent's own tool
 * asked that endpoint for an Anthropic model and 404'd.
 *
 * Read per call, not captured when the node is registered: the node is built
 * once, in `buildContext`, and `/provider` and `/model` move the handle
 * underneath it for the rest of the process.
 */
test("defaults to the model the provider handle currently holds", async () => {
  const provider = fakeProvider();
  let model = "llama3.2";
  Object.defineProperty(provider, "model", { get: () => model });
  const node = createLlmNode(provider);

  await node.run({ prompt: "x" }, ctx);
  expect(provider.lastRequest.model).toBe("llama3.2");

  model = "qwen3";
  await node.run({ prompt: "x" }, ctx);
  expect(provider.lastRequest.model).toBe("qwen3");

  // An explicit model still wins: the agent may ask for a specific one.
  await node.run({ prompt: "x", model: "llama3.2:70b" }, ctx);
  expect(provider.lastRequest.model).toBe("llama3.2:70b");
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
