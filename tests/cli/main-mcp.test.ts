import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createSpec, specPaths, writeSpecFile } from "../../src/spec/store";

/**
 * The real binary with an `mcp:` section: every path out of `main` must leave
 * no server behind, and `vesna do` must run under the config's policy. The
 * fixture lingers after its stdin closes (`FAKE_MCP_LINGER=1`), so a server
 * that was merely orphaned stays visible to `pgrep`; it is started behind
 * `tee` so every frame Vesna sent it is on disk.
 */

const BIN = join(import.meta.dir, "..", "..", "bin", "vesna");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "mcp-server.ts");

/** A scriptable OpenAI-compatible provider: a tool call first, then text. */
function fakeProvider(call: { name: string; arguments: Record<string, unknown> } | null) {
  let turn = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      turn += 1;
      const message =
        turn === 1 && call !== null
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
              ],
            }
          : { role: "assistant", content: "done" };
      return Response.json({
        model: "m",
        choices: [{ finish_reason: turn === 1 && call !== null ? "tool_calls" : "stop", message }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

async function project(options: { baseUrl: string; mode?: "plan" | "ask" | "auto" }) {
  const root = await mkdtemp(join(tmpdir(), "vesna-main-mcp-"));
  const home = await mkdtemp(join(tmpdir(), "vesna-main-mcp-home-"));
  const probe = `probe-${Math.random().toString(36).slice(2)}`;
  const wire = join(root, "wire.log");
  await mkdir(join(root, ".vesna"), { recursive: true });
  await writeFile(
    join(root, ".vesna", "config.yaml"),
    [
      "provider: ollama",
      "model: m",
      `baseUrl: ${options.baseUrl}`,
      ...(options.mode ? ["permissions:", `  mode: ${options.mode}`] : []),
      "mcp:",
      "  fake:",
      "    command: sh",
      `    args: ["-c", "FAKE_MCP_LINGER=1 exec bun ${FIXTURE} ${probe}"]`,
      "",
    ].join("\n"),
  );
  return { root, home, probe, wire };
}

async function run(
  argv: string[],
  p: { root: string; home: string },
  input: "closed" | "none" = "closed",
): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  const child = Bun.spawn(["bun", BIN, ...argv], {
    cwd: p.root,
    env: { PATH: process.env.PATH ?? "", HOME: p.home, VESNA_HOME: join(p.home, ".vesna") },
    stdin: input === "closed" ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr, ms: Date.now() - started };
}

function alive(probe: string): number {
  const found = Bun.spawnSync(["pgrep", "-f", probe]);
  return found.stdout.toString().split("\n").filter((line) => line.trim() !== "").length;
}

async function methodsOn(wire: string): Promise<string[]> {
  if (!existsSync(wire)) return [];
  const text = await readFile(wire, "utf8");
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l).method as string);
}

function killLeftovers(probe: string): void {
  Bun.spawnSync(["pkill", "-9", "-f", probe]);
}

test("chat --plain under a non-TTY refuses, exits, and leaves no server", async () => {
  const provider = fakeProvider(null);
  const p = await project({ baseUrl: provider.url });
  try {
    const out = await run(["chat", "--plain"], p);
    expect(out.stderr).toContain("vesna chat needs a terminal");
    expect(out.code).toBe(2);
    expect(out.ms).toBeLessThan(2_000);
    expect(alive(p.probe)).toBe(0);
  } finally {
    killLeftovers(p.probe);
    provider.stop();
  }
}, 15_000);

test("bare vesna do prints the usage, exits, and leaves no server", async () => {
  const provider = fakeProvider(null);
  const p = await project({ baseUrl: provider.url });
  try {
    const out = await run(["do"], p);
    expect(out.stderr).toContain("usage:");
    expect(out.code).toBe(2);
    expect(out.ms).toBeLessThan(2_000);
    expect(alive(p.probe)).toBe(0);
  } finally {
    killLeftovers(p.probe);
    provider.stop();
  }
}, 15_000);

test("build with an unapproved plan refuses, exits, and leaves no server", async () => {
  const provider = fakeProvider(null);
  const p = await project({ baseUrl: provider.url });
  const specs = join(p.root, ".vesna", "specs");
  createSpec(specs, "work");
  appendEvent(specs, "work", { t: "task.added", id: "T1", title: "First" });
  appendEvent(specs, "work", { t: "approved", what: "spec" });
  writeSpecFile(specPaths(specs, "work").plan, "# Plan\n\n### Task 1: First\nDo it.\n");
  try {
    const out = await run(["build", "work"], p);
    expect(out.stderr).toContain("the plan is not approved");
    expect(out.code).toBe(2);
    expect(out.ms).toBeLessThan(2_000);
    expect(alive(p.probe)).toBe(0);
  } finally {
    killLeftovers(p.probe);
    provider.stop();
  }
}, 15_000);

/** `vesna do` with a teed server, so the wire says whether the tool ran. */
async function doWith(mode: "plan" | "ask" | "auto", call: { name: string; arguments: Record<string, unknown> }) {
  const provider = fakeProvider(call);
  const p = await project({ baseUrl: provider.url, mode });
  await writeFile(
    join(p.root, ".vesna", "config.yaml"),
    (await readFile(join(p.root, ".vesna", "config.yaml"), "utf8")).replace(
      `"-c", "FAKE_MCP_LINGER=1 exec bun ${FIXTURE} ${p.probe}"`,
      `"-c", "tee -a ${p.wire} | FAKE_MCP_LINGER=1 bun ${FIXTURE} ${p.probe}"`,
    ),
  );
  try {
    const out = await run(["do", "go"], p);
    return { ...out, methods: await methodsOn(p.wire), root: p.root, left: alive(p.probe) };
  } finally {
    killLeftovers(p.probe);
    provider.stop();
  }
}

test("do in plan mode refuses an MCP tool: no call on the wire, the refusal on stderr", async () => {
  const out = await doWith("plan", { name: "fake__hint", arguments: {} });
  expect(out.code).toBe(0);
  expect(out.methods).toContain("tools/list");
  expect(out.methods).not.toContain("tools/call");
  expect(out.stderr).toContain("vesna: fake__hint refused: plan mode changes nothing");
  expect(out.stdout).not.toContain("fake__hint");
  expect(out.left).toBe(0);
}, 15_000);

test("do in ask mode refuses what would have been a question, and says where to ask it", async () => {
  const out = await doWith("ask", { name: "fake__hint", arguments: {} });
  expect(out.code).toBe(0);
  expect(out.methods).not.toContain("tools/call");
  expect(out.stderr).toContain("vesna: fake__hint would ask — run it in the chat, or set permissions.mode: auto");
  expect(out.left).toBe(0);
}, 15_000);

test("do in auto mode runs the MCP tool: one call on the wire", async () => {
  const out = await doWith("auto", { name: "fake__hint", arguments: {} });
  expect(out.code).toBe(0);
  expect(out.methods.filter((m) => m === "tools/call")).toHaveLength(1);
  expect(out.stdout).toContain("fake__hint");
  expect(out.left).toBe(0);
}, 15_000);

test("do in plan mode does not let a builtin write either", async () => {
  const out = await doWith("plan", { name: "write", arguments: { path: "made.txt", text: "x" } });
  expect(out.code).toBe(0);
  expect(existsSync(join(out.root, "made.txt"))).toBe(false);
  expect(out.stderr).toContain("vesna: write refused: plan mode changes nothing");
}, 15_000);
