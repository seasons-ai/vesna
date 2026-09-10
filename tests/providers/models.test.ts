import { test, expect } from "bun:test";
import { listModels } from "../../src/providers/models";
import { findPreset } from "../../src/providers/catalog";

test("a built-in list is returned for providers with no models endpoint", async () => {
  const models = await listModels(findPreset("anthropic")!, undefined, async () => {
    throw new Error("must not be called");
  });
  expect(models.length).toBeGreaterThan(0);
  expect(models).toContain("claude-opus-5");
});

test("an openai-compatible endpoint is asked for its own list", async () => {
  const models = await listModels(
    findPreset("ollama")!,
    "http://127.0.0.1:11434/v1",
    async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "qwen3" }, { id: "llama3.2" }] }), {
        status: 200,
      });
    },
  );
  expect(models).toEqual(["llama3.2", "qwen3"]);
});

test("an endpoint that is not running falls back to the preset's model", async () => {
  const models = await listModels(findPreset("ollama")!, "http://127.0.0.1:11434/v1", async () => {
    throw new Error("ECONNREFUSED");
  });
  expect(models).toEqual(["llama3.2"]);
});

test("a malformed answer falls back rather than throwing", async () => {
  const models = await listModels(
    findPreset("ollama")!,
    "http://127.0.0.1:11434/v1",
    async () => new Response("not json", { status: 200 }),
  );
  expect(models).toEqual(["llama3.2"]);
});
