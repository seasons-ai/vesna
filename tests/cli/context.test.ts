import { test, expect } from "bun:test";
import { buildProviderFor } from "../../src/cli/context";
import { findPreset } from "../../src/providers/catalog";
import type { Provider } from "../../src/providers/types";

/**
 * A stand-in for any OpenAI-compatible host. Records the Authorization
 * header each request carried, which is the only thing these tests care
 * about — whether the right key (or no key at all) reached the wire.
 */
function fakeHost() {
  const seen: Array<{ auth: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push({ auth: request.headers.get("authorization") });
      return Response.json({
        model: "m",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage: {},
      });
    },
  });
  return { seen, url: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}

function ping(provider: Provider) {
  return provider.complete({
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
}

test("a preset's own env var supplies the key it names", async () => {
  const host = fakeHost();
  try {
    const preset = { ...findPreset("groq")!, baseUrl: host.url };
    const provider = await buildProviderFor(preset, undefined, { GROQ_API_KEY: "groq-secret" });
    await ping(provider);
    expect(host.seen[0]!.auth).toBe("Bearer groq-secret");
  } finally {
    host.stop();
  }
});

test("a preset with no env var sends no Authorization header at all", async () => {
  const host = fakeHost();
  try {
    const preset = { ...findPreset("ollama")!, baseUrl: host.url };
    const provider = await buildProviderFor(preset, undefined, {});
    await ping(provider);
    expect(host.seen[0]!.auth).toBeNull();
  } finally {
    host.stop();
  }
});

test("a stray OPENAI_API_KEY on the machine is never sent to a groq preset", async () => {
  const host = fakeHost();
  try {
    const preset = { ...findPreset("groq")!, baseUrl: host.url };
    // Groq's own key is absent; only an unrelated OpenAI key is set. That
    // key must never leave this process addressed to a different host.
    const provider = await buildProviderFor(preset, undefined, { OPENAI_API_KEY: "leaked" });
    await ping(provider);
    expect(host.seen[0]!.auth).toBeNull();
  } finally {
    host.stop();
  }
});
