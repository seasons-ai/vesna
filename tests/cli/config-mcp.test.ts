import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config";

async function withRoot(fn: (root: string, home: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vesna-cfg-mcp-"));
  const home = await mkdtemp(join(tmpdir(), "vesna-cfg-mcp-home-"));
  try {
    await fn(root, home);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

async function writeConfig(root: string, yaml: string) {
  await mkdir(join(root, ".vesna"), { recursive: true });
  await writeFile(join(root, ".vesna", "config.yaml"), yaml);
}

test("an mcp section parses into servers with defaults", async () => {
  await withRoot(async (root, home) => {
    await writeConfig(
      root,
      [
        "mcp:",
        "  github:",
        "    command: npx",
        '    args: ["-y", "x"]',
        "    env: [GITHUB_TOKEN]",
        "    tools:",
        "      list_issues: pure",
        "  db:",
        "    command: db-mcp",
      ].join("\n"),
    );
    const config = await loadConfig(root, {}, home);
    expect(config.mcp).toEqual({
      github: { command: "npx", args: ["-y", "x"], env: ["GITHUB_TOKEN"], tools: { list_issues: "pure" } },
      db: { command: "db-mcp", args: [], env: [], tools: {} },
    });
    expect(config.mcpProblems).toBeUndefined();
  });
});

test("a bad server is skipped and reported; the others load", async () => {
  await withRoot(async (root, home) => {
    await writeConfig(
      root,
      [
        "mcp:",
        "  Bad:",
        "    command: x",
        "  nocmd: {}",
        "  ext:",
        "    command: x",
        "    tools:",
        "      t: external",
        "  envs:",
        "    command: x",
        "    env: TOKEN",
        "  ok:",
        "    command: x",
      ].join("\n"),
    );
    const config = await loadConfig(root, {}, home);
    expect(Object.keys(config.mcp!)).toEqual(["ok"]);
    expect(config.mcpProblems).toEqual([
      "mcp Bad: key must match ^[a-z][a-z0-9-]*$",
      "mcp nocmd: no command",
      "mcp ext: tools.t: effect must be pure or write",
      "mcp envs: env must be a list of names",
    ]);
  });
});

test("no mcp section is no servers", async () => {
  await withRoot(async (root, home) => {
    await writeConfig(root, "model: claude-sonnet-5\n");
    const config = await loadConfig(root, {}, home);
    expect(config.mcp).toBeUndefined();
  });
});
