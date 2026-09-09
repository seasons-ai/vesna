import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config";

async function project(yaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vesna-cfg-"));
  await mkdir(join(root, ".vesna"), { recursive: true });
  await writeFile(join(root, ".vesna", "config.yaml"), yaml);
  return root;
}

test("auth: codex is a recognised mode, not silently downgraded to a key", async () => {
  const config = await loadConfig(await project("provider: openai\nauth: codex\n"));
  expect(config.auth).toBe("codex");
});

test("codex mode defaults to a model the subscription endpoint serves", async () => {
  const config = await loadConfig(await project("provider: openai\nauth: codex\n"));
  expect(config.model).toBe("gpt-5.6-sol");
});

test("an explicit model still wins over the codex default", async () => {
  const config = await loadConfig(await project("provider: openai\nauth: codex\nmodel: gpt-5\n"));
  expect(config.model).toBe("gpt-5");
});

test("an unknown auth mode falls back to key rather than failing every command", async () => {
  const config = await loadConfig(await project("provider: openai\nauth: telepathy\n"));
  expect(config.auth).toBe("key");
});

test("ascii is tri-state: unset means ask the locale", async () => {
  expect((await loadConfig(await project("provider: openai\n"))).ascii).toBeUndefined();
  expect((await loadConfig(await project("ascii: true\n"))).ascii).toBe(true);
  expect((await loadConfig(await project("ascii: false\n"))).ascii).toBe(false);
});

test("a non-boolean ascii is ignored rather than taken as true", async () => {
  expect((await loadConfig(await project("ascii: yes please\n"))).ascii).toBeUndefined();
});

test("a folder with no config file is reported as unconfigured, not as defaults", async () => {
  const bare = await mkdtemp(join(tmpdir(), "vesna-bare-"));
  const config = await loadConfig(bare);
  expect(config.configured).toBe(false);
  // The defaults are still there — callers that do not need credentials work.
  expect(config.provider).toBe("anthropic");
});

test("a config file that exists marks the project configured", async () => {
  const config = await loadConfig(await project("provider: openai\nauth: codex\n"));
  expect(config.configured).toBe(true);
});

test("an empty config file still counts as configured", async () => {
  expect((await loadConfig(await project(""))).configured).toBe(true);
});

test("a config with a YAML syntax error is refused, not silently ignored", async () => {
  const root = await project("provider: openai\n  auth: [unclosed\n");
  await expect(loadConfig(root)).rejects.toThrow(/config\.yaml/);
});

test("the refusal explains what is wrong, so the typo is findable", async () => {
  const root = await project("theme: \"unterminated\n");
  await expect(loadConfig(root)).rejects.toThrow(/config\.yaml/);
});

test("a config whose top level is not a mapping is refused", async () => {
  await expect(loadConfig(await project("- provider: openai\n"))).rejects.toThrow(/mapping/i);
});
