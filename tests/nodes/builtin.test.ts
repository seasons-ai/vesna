import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../../src/registry/registry";
import { registerBuiltins } from "../../src/nodes";

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal });

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vesna-nodes-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("registers the built-in node types", () => {
  const registry = createRegistry();
  registerBuiltins(registry);
  expect(registry.list().sort()).toEqual(["edit", "glob", "grep", "read", "script", "shell", "write"]);
});

test("write then read round-trips a file", async () => {
  await withDir(async (dir) => {
    const registry = createRegistry();
    registerBuiltins(registry);

    const written = await registry.get("write")!.run({ path: "note.txt", text: "hello" }, ctx(dir));
    expect(written).toMatchObject({ bytes: 5 });

    const read = await registry.get("read")!.run({ path: "note.txt" }, ctx(dir));
    expect(read).toEqual({ text: "hello" });
  });
});

test("shell returns stdout and an exit code", async () => {
  await withDir(async (dir) => {
    const registry = createRegistry();
    registerBuiltins(registry);
    const result: any = await registry.get("shell")!.run({ command: "echo hi" }, ctx(dir));
    expect(result.stdout.trim()).toBe("hi");
    expect(result.code).toBe(0);
  });
});

test("rejects a path that escapes the working directory", async () => {
  await withDir(async (dir) => {
    const registry = createRegistry();
    registerBuiltins(registry);
    await expect(registry.get("read")!.run({ path: "../escape.txt" }, ctx(dir))).rejects.toThrow(/outside/);
  });
});

test("effect classes are declared correctly", () => {
  const registry = createRegistry();
  registerBuiltins(registry);
  expect(registry.get("read")!.effect).toBe("pure");
  expect(registry.get("write")!.effect).toBe("write");
  expect(registry.get("shell")!.effect).toBe("write");
});
