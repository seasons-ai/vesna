import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config";

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vesna-cfg-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("defaults to claude-opus-5 when there is no config file", async () => {
  await withRoot(async (root) => {
    const config = await loadConfig(root);
    expect(config.model).toBe("claude-opus-5");
  });
});

test("reads model and permissions from .agent/config.yaml", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, ".agent"), { recursive: true });
    await writeFile(
      join(root, ".agent", "config.yaml"),
      "model: claude-sonnet-5\npermissions:\n  nodes: [read, write]\n",
    );
    const config = await loadConfig(root);
    expect(config.model).toBe("claude-sonnet-5");
    expect(config.permissions.nodes).toEqual(["read", "write"]);
  });
});
