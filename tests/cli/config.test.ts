import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config";

async function withRoot(fn: (root: string, home: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vesna-cfg-"));
  // A real developer's ~/.vesna/settings.yaml must never leak into these
  // tests, so every call gets its own empty, never-written-to home.
  const home = await mkdtemp(join(tmpdir(), "vesna-cfg-home-"));
  try {
    await fn(root, home);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

test("defaults to claude-opus-5 when there is no config file", async () => {
  await withRoot(async (root, home) => {
    const config = await loadConfig(root, {}, home);
    expect(config.model).toBe("claude-opus-5");
  });
});

test("reads model and permissions from .vesna/config.yaml", async () => {
  await withRoot(async (root, home) => {
    await mkdir(join(root, ".vesna"), { recursive: true });
    await writeFile(
      join(root, ".vesna", "config.yaml"),
      "model: claude-sonnet-5\npermissions:\n  nodes: [read, write]\n",
    );
    const config = await loadConfig(root, {}, home);
    expect(config.model).toBe("claude-sonnet-5");
    expect(config.permissions.nodes).toEqual(["read", "write"]);
  });
});

test("defaults to the anthropic provider", async () => {
  await withRoot(async (root, home) => {
    const config = await loadConfig(root, {}, home);
    expect(config.provider).toBe("anthropic");
    expect(config.baseUrl).toBeUndefined();
  });
});

test("an openai-compatible endpoint is configured by provider and baseUrl", async () => {
  await withRoot(async (root, home) => {
    await mkdir(join(root, ".vesna"), { recursive: true });
    await writeFile(
      join(root, ".vesna", "config.yaml"),
      [
        "provider: openai",
        "model: llama3.1",
        "baseUrl: http://localhost:11434/v1",
        "prices:",
        '  llama3.1: { input: 0, output: 0 }',
      ].join("\n"),
    );
    const config = await loadConfig(root, {}, home);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("llama3.1");
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.prices["llama3.1"]).toEqual({ input: 0, output: 0 });
  });
});

test("authentication defaults to a key, not a subscription", async () => {
  await withRoot(async (root, home) => {
    expect((await loadConfig(root, {}, home)).auth).toBe("key");
  });
});

test("the subscription mode is opted into explicitly", async () => {
  await withRoot(async (root, home) => {
    await mkdir(join(root, ".vesna"), { recursive: true });
    await writeFile(join(root, ".vesna", "config.yaml"), "provider: openai\nauth: subscription\n");
    const config = await loadConfig(root, {}, home);
    expect(config.provider).toBe("openai");
    expect(config.auth).toBe("subscription");
  });
});
