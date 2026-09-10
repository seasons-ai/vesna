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

test("an Authorization header is sent when the preset names a set env var", async () => {
  const models = await listModels(
    findPreset("openai")!,
    undefined,
    async (input, init) => {
      expect(String(input)).toBe("https://api.openai.com/v1/models");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sk-test");
      return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 });
    },
    { OPENAI_API_KEY: "sk-test" },
  );
  expect(models).toEqual(["gpt-4o"]);
});

test("no Authorization header is sent when the env var is unset", async () => {
  const models = await listModels(
    findPreset("openai")!,
    undefined,
    async (_input, init) => {
      expect(init).toBeUndefined();
      return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 });
    },
    {},
  );
  expect(models).toEqual(["gpt-4o"]);
});

test("no Authorization header is sent for a preset with no env var at all", async () => {
  const models = await listModels(
    findPreset("ollama")!,
    "http://127.0.0.1:11434/v1",
    async (_input, init) => {
      expect(init).toBeUndefined();
      return new Response(JSON.stringify({ data: [{ id: "llama3.2" }] }), { status: 200 });
    },
    { OPENAI_API_KEY: "sk-should-not-matter" },
  );
  expect(models).toEqual(["llama3.2"]);
});
