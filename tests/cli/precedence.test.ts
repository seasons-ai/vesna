import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config";
import { buildProviderFor } from "../../src/cli/context";
import { findPreset } from "../../src/providers/catalog";
import { settingsPath, writeSettings } from "../../src/cli/settings";

function withDirs(fn: (root: string, home: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "vesna-prec-root-"));
  const home = mkdtempSync(join(tmpdir(), "vesna-prec-home-"));
  return fn(root, home).finally(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

function project(root: string, yaml: string) {
  mkdirSync(join(root, ".vesna"), { recursive: true });
  writeFileSync(join(root, ".vesna", "config.yaml"), yaml);
}

test("with nothing anywhere, the built-in default applies and nothing is configured", async () => {
  await withDirs(async (root, home) => {
    const config = await loadConfig(root, {}, home);
    expect(config.preset.id).toBe("anthropic");
    expect(config.configured).toBe(false);
  });
});

test("global settings supply the provider when the project says nothing", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "groq", model: "llama-3.3-70b-versatile" });
    const config = await loadConfig(root, {}, home);
    expect(config.preset.id).toBe("groq");
    expect(config.model).toBe("llama-3.3-70b-versatile");
    expect(config.configured).toBe(true);
  });
});

/**
 * Provider, model and address are one tuple, not three keys that happen to sit
 * in the same file. A project that names only the provider must take the whole
 * tuple from the service it named — never half of it from a different one.
 */
test("the project config beats global settings, model and address included", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      baseUrl: "https://api.groq.com/openai/v1",
    });
    project(root, "provider: anthropic\n");
    const config = await loadConfig(root, {}, home);
    expect(config.preset.id).toBe("anthropic");
    expect(config.model).toBe(findPreset("anthropic")!.model);
    expect(config.baseUrl).toBeUndefined();
  });
});

/**
 * The same rule, watched at the wire instead of in the resolved object, and
 * with the pair that makes it a credential leak rather than a wrong answer:
 * the machine points at Groq, the project pins OpenAI, and the only key on the
 * machine is OpenAI's. The address and the key must belong to one service.
 */
test("a project pinning only the provider never sends its key to the machine's address", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      baseUrl: "https://api.groq.com/openai/v1",
    });
    project(root, "provider: openai\n");

    const env = { OPENAI_API_KEY: "sk-openai-secret" };
    const config = await loadConfig(root, env, home);
    const provider = await buildProviderFor(config.preset, config.baseUrl, env);

    const sent = await onTheWire(() =>
      provider.complete({
        model: config.model,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    );

    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent.url).not.toContain("groq");
    expect(sent.auth).toBe("Bearer sk-openai-secret");
  });
});

/**
 * The network, replaced for the duration of one call, so "where did it go and
 * what did it carry" is answerable without either a live host or a real
 * request escaping the test run. Returns the single request that was sent.
 */
async function onTheWire(fn: () => Promise<unknown>): Promise<{ url: string; auth: string | null }> {
  const real = globalThis.fetch;
  const seen: { url: string; auth: string | null }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({
      model: "m",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: {},
    });
  }) as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }

  if (seen.length !== 1) throw new Error(`expected exactly one request, saw ${seen.length}`);
  return seen[0]!;
}

test("a project model applies over a global one", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "groq", model: "global-model" });
    project(root, "provider: groq\nmodel: project-model\n");
    expect((await loadConfig(root, {}, home)).model).toBe("project-model");
  });
});

test("a preset supplies the model when neither file names one", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "ollama" });
    expect((await loadConfig(root, {}, home)).model).toBe("llama3.2");
  });
});

test("a preset supplies the base URL, and the project can override it", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "ollama" });
    expect((await loadConfig(root, {}, home)).baseUrl).toBe("http://127.0.0.1:11434/v1");

    project(root, "provider: ollama\nbaseUrl: http://10.0.0.2:11434/v1\n");
    expect((await loadConfig(root, {}, home)).baseUrl).toBe("http://10.0.0.2:11434/v1");
  });
});

test("a config written before the catalog still resolves", async () => {
  await withDirs(async (root, home) => {
    project(root, "provider: openai\nauth: codex\n");
    const config = await loadConfig(root, {}, home);
    expect(config.preset.id).toBe("codex");
    expect(config.provider).toBe("openai");
    expect(config.auth).toBe("codex");
  });
});

test("a project that pins a provider is reported, so a command can say so", async () => {
  await withDirs(async (root, home) => {
    project(root, "provider: anthropic\n");
    expect((await loadConfig(root, {}, home)).pinned).toBe(true);

    const other = mkdtempSync(join(tmpdir(), "vesna-prec-none-"));
    expect((await loadConfig(other, {}, home)).pinned).toBe(false);
    rmSync(other, { recursive: true, force: true });
  });
});
