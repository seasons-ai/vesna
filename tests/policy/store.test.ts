import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, rememberAllow, suggestPattern } from "../../src/policy/store";
import type { VesnaConfig } from "../../src/cli/config";

const root = () => mkdtemp(join(tmpdir(), "vesna-policy-"));
const config = (over: Partial<VesnaConfig["permissions"]> = {}) =>
  ({
    permissions: { nodes: ["read", "write", "shell"], ...over },
  }) as VesnaConfig;

async function learned(dir: string, body: string) {
  await mkdir(join(dir, ".vesna"), { recursive: true });
  await writeFile(join(dir, ".vesna", "permissions.yaml"), body);
}

test("with nothing configured the mode is ask, which is the safe default", async () => {
  const policy = await loadPolicy(await root(), config());
  expect(policy.mode).toBe("ask");
});

test("the mode comes from the hand-written config", async () => {
  const policy = await loadPolicy(await root(), config({ mode: "auto" }));
  expect(policy.mode).toBe("auto");
});

test("an unknown mode falls back to ask rather than to the permissive one", async () => {
  const policy = await loadPolicy(await root(), config({ mode: "yolo" as never }));
  expect(policy.mode).toBe("ask");
});

test("hand-written rules are read", async () => {
  const policy = await loadPolicy(
    await root(),
    config({ allow: { write: ["src/**"] }, deny: { shell: ["rm*"] } }),
  );
  expect(policy.allow.write).toEqual(["src/**"]);
  expect(policy.deny.shell).toEqual(["rm*"]);
});

test("learned rules live in their own file, and both are honoured", async () => {
  const dir = await root();
  await learned(dir, "allow:\n  shell:\n    - bun test*\n");
  const policy = await loadPolicy(dir, config({ allow: { write: ["src/**"] } }));
  expect(policy.allow.write).toEqual(["src/**"]);
  expect(policy.allow.shell).toEqual(["bun test*"]);
});

test("both sources contribute to the same node without one erasing the other", async () => {
  const dir = await root();
  await learned(dir, "allow:\n  write:\n    - docs/**\n");
  const policy = await loadPolicy(dir, config({ allow: { write: ["src/**"] } }));
  expect([...(policy.allow.write ?? [])].sort()).toEqual(["docs/**", "src/**"]);
});

test("a broken learned file is ignored rather than taken as permission", async () => {
  const dir = await root();
  await learned(dir, "allow: [this is not: valid\n");
  const policy = await loadPolicy(dir, config());
  expect(policy.allow).toEqual({});
});

test("remembering a rule writes it where Vesna is allowed to rewrite", async () => {
  const dir = await root();
  await rememberAllow(dir, "shell", "bun test*");

  const text = await readFile(join(dir, ".vesna", "permissions.yaml"), "utf8");
  expect(text).toContain("bun test*");
  // The file says whose it is, so nobody hand-edits it and loses the edit.
  expect(text).toContain("#");

  const policy = await loadPolicy(dir, config());
  expect(policy.allow.shell).toEqual(["bun test*"]);
});

test("remembering twice does not duplicate the rule", async () => {
  const dir = await root();
  await rememberAllow(dir, "shell", "bun test*");
  await rememberAllow(dir, "shell", "bun test*");
  expect((await loadPolicy(dir, config())).allow.shell).toEqual(["bun test*"]);
});

test("remembering keeps what was already learned for other nodes", async () => {
  const dir = await root();
  await rememberAllow(dir, "shell", "bun test*");
  await rememberAllow(dir, "write", "src/**");
  const policy = await loadPolicy(dir, config());
  expect(policy.allow.shell).toEqual(["bun test*"]);
  expect(policy.allow.write).toEqual(["src/**"]);
});

test("the suggested pattern for a file is its directory, not the one file", () => {
  expect(suggestPattern("write", "src/auth/token.ts")).toBe("src/auth/**");
});

test("a file at the top level suggests only itself, not the whole project", () => {
  expect(suggestPattern("write", "README.md")).toBe("README.md");
});

test("the suggested pattern for a command is its first two words", () => {
  expect(suggestPattern("shell", "bun test tests/a.ts --watch")).toBe("bun test*");
  expect(suggestPattern("shell", "ls")).toBe("ls*");
});
