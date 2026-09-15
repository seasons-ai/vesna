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

// A proxied server needs `http_proxy`, the conventional Unix spelling: a
// name is a name whatever its case.
test("env accepts lower-case names", async () => {
  await withRoot(async (root, home) => {
    await writeConfig(root, ["mcp:", "  x:", "    command: npx", "    env: [http_proxy, HTTPS_PROXY, _x1]"].join("\n"));
    const config = await loadConfig(root, {}, home);
    expect(config.mcpProblems).toBeUndefined();
    expect(config.mcp!.x!.env).toEqual(["http_proxy", "HTTPS_PROXY", "_x1"]);
  });
});

test("env still refuses what is not a name", async () => {
  await withRoot(async (root, home) => {
    await writeConfig(root, ["mcp:", "  x:", "    command: npx", "    env: [1x, a-b]"].join("\n"));
    const config = await loadConfig(root, {}, home);
    expect(config.mcpProblems).toEqual(["mcp x: env must be a list of names"]);
  });
});

test("args must be a list of strings, or the server is skipped with a problem", async () => {
  await withRoot(async (root, home) => {
    await writeConfig(
      root,
      ["mcp:", "  nums:", "    command: x", "    args: [1]", "  str:", "    command: x", "    args: -y", "  ok:", "    command: x", "    args: [-y, x]"].join("\n"),
    );
    const config = await loadConfig(root, {}, home);
    expect(Object.keys(config.mcp!)).toEqual(["ok"]);
    expect(config.mcpProblems).toEqual([
      "mcp nums: args must be a list of strings",
      "mcp str: args must be a list of strings",
    ]);
  });
});
