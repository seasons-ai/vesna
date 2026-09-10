import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config";
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

test("the project config beats global settings", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "groq" });
    project(root, "provider: anthropic\n");
    const config = await loadConfig(root, {}, home);
    expect(config.preset.id).toBe("anthropic");
  });
});

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
