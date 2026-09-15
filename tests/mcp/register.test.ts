import { test, expect } from "bun:test";
import { join } from "node:path";
import { bunSpawner, type ChildLike, type Spawner } from "../../src/mcp/client";
import { registerMcp, reviewerTools } from "../../src/mcp/register";
import type { McpServerConfig } from "../../src/mcp/types";
import { createRegistry } from "../../src/registry/registry";
import type { NodeContext } from "../../src/registry/types";

/**
 * Registration against the real fixture server where the wire matters, and
 * against an in-memory child where the shape of a listed tool matters — a
 * name that does not fit, a schema that is missing, an initialize that
 * takes its time.
 */

const FIXTURE = join(import.meta.dir, "..", "fixtures", "mcp-server.ts");

function fixture(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { command: "bun", args: [FIXTURE], env: [], tools: {}, ...overrides };
}

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, ...extra };
}

function ctx(signal: AbortSignal = new AbortController().signal): NodeContext {
  return { cwd: process.cwd(), signal };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A spawner that keeps every child it made, in order. */
function capturing(): { spawn: Spawner; children: ChildLike[] } {
  const children: ChildLike[] = [];
  return {
    spawn: (command, args, options) => {
      const child = bunSpawner(command, args, { ...options, stderr: "pipe" });
      children.push(child);
      return child;
    },
    children,
  };
}

/**
 * An in-memory child that lists the tools it is given and answers every
 * call with `called <name>`; `initializeDelayMs` holds the initialize
 * answer back, to see two servers start side by side.
 */
function scriptedChild(tools: unknown[], initializeDelayMs = 0): ChildLike {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const push = (line: string) => {
    queue.push(line);
    wake?.();
  };
  let exit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  return {
    pid: 0,
    stdin: {
      write(s: string) {
        for (const line of s.split("\n")) {
          if (line.trim() === "") continue;
          const message = JSON.parse(line);
          if (message.method === "initialize") {
            const answer = JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "scripted", version: "0" } },
            });
            if (initializeDelayMs > 0) setTimeout(() => push(answer), initializeDelayMs);
            else push(answer);
          } else if (message.method === "tools/list") {
            push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }));
          } else if (message.method === "tools/call") {
            push(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: `called ${message.params.name}` }] },
              }),
            );
          }
        }
      },
      end() {
        ended = true;
        wake?.();
      },
    },
    stdout: (async function* () {
      const encoder = new TextEncoder();
      for (;;) {
        while (queue.length > 0) yield encoder.encode(`${queue.shift()!}\n`);
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    })(),
    exited,
    kill() {
      ended = true;
      wake?.();
      exit(0);
    },
  };
}

test("every listed tool is a node named server__tool, external unless the config lowers it", async () => {
  const registry = createRegistry();
  const report: string[] = [];
  const handle = await registerMcp(registry, { fake: fixture({ tools: { echo: "pure", slow: "write" } }) }, {
    env: env(),
    cwd: process.cwd(),
    report: (line) => report.push(line),
  });
  try {
    expect(registry.list()).toEqual(["fake__echo", "fake__slow", "fake__fail", "fake__hint"]);
    const echo = registry.get("fake__echo")!;
    expect(echo.effect).toBe("pure");
    expect(echo.origin).toBe("mcp");
    expect(echo.description).toBe("fake: echo — returns the text it is given");
    expect(echo.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    expect(registry.get("fake__slow")!.effect).toBe("write");
    expect(registry.get("fake__fail")!.effect).toBe("external");
    expect(registry.get("fake__hint")!.effect).toBe("external");
    expect(handle.servers).toEqual([{ name: "fake", status: "up", tools: 4 }]);
    expect(report).toEqual([]);
  } finally {
    await handle.close();
  }
});

test("a tool the server calls read-only says so at the end of the description's first line", async () => {
  const registry = createRegistry();
  const handle = await registerMcp(registry, { fake: fixture() }, { env: env(), cwd: process.cwd(), report: () => {} });
  try {
    expect(registry.get("fake__hint")!.description).toBe(
      "fake: hint — a tool the server marks read-only (the server says read-only)",
    );
  } finally {
    await handle.close();
  }
});

test("run returns the tool's text; an error result is thrown, so the model sees it as the tool's error", async () => {
  const registry = createRegistry();
  const handle = await registerMcp(registry, { fake: fixture() }, { env: env(), cwd: process.cwd(), report: () => {} });
  try {
    expect(await registry.get("fake__echo")!.run({ text: "hello" }, ctx())).toBe("hello");
    await expect(registry.get("fake__fail")!.run({}, ctx())).rejects.toThrow("it failed");
    // The turn's signal reaches the call.
    await expect(registry.get("fake__slow")!.run({ ms: 5000 }, ctx(AbortSignal.abort()))).rejects.toThrow("interrupted");
  } finally {
    await handle.close();
  }
});

test("a tool whose joined name does not fit is skipped with a line; a missing schema becomes an empty object schema", async () => {
  const registry = createRegistry();
  const report: string[] = [];
  const child = scriptedChild([
    { name: "plain", description: "first line\nsecond line", inputSchema: { type: "object", properties: { a: {} } } },
    { name: "has space", description: "no" },
    { name: "x".repeat(70), description: "no" },
    { name: "bare" },
    { name: "plain" },
  ]);
  const handle = await registerMcp(
    registry,
    { scripted: { command: "scripted", args: [], env: [], tools: {} } },
    { env: {}, cwd: process.cwd(), report: (line) => report.push(line), spawn: () => child },
  );
  try {
    expect(registry.list()).toEqual(["scripted__plain", "scripted__bare"]);
    expect(registry.get("scripted__plain")!.description).toBe("scripted: plain — first line\nsecond line");
    expect(registry.get("scripted__bare")!.description).toBe("scripted: bare");
    expect(registry.get("scripted__bare")!.inputSchema).toEqual({ type: "object", properties: {} });
    expect(report).toEqual([
      "mcp scripted: tool has space skipped — name does not fit",
      `mcp scripted: tool ${"x".repeat(70)} skipped — name does not fit`,
      "mcp scripted: tool plain skipped — already registered",
    ]);
    expect(handle.servers).toEqual([{ name: "scripted", status: "up", tools: 2 }]);
    expect(await registry.get("scripted__bare")!.run({}, ctx())).toBe("called bare");
  } finally {
    await handle.close();
  }
});

test("an unset env name is reported once, by name only; a set one's value appears nowhere", async () => {
  const registry = createRegistry();
  const report: string[] = [];
  const handle = await registerMcp(
    registry,
    { fake: fixture({ env: ["NOT_SET_A", "NOT_SET_A", "SECRET_X", "FAKE_MCP_PRINT_ENV"] }) },
    {
      env: env({ SECRET_X: "s3cret-value", FAKE_MCP_PRINT_ENV: "SECRET_X" }),
      cwd: process.cwd(),
      report: (line) => report.push(line),
    },
  );
  try {
    expect(report).toEqual(["mcp fake: NOT_SET_A is not set"]);
    expect(report.join("\n")).not.toContain("s3cret-value");
    expect(await registry.get("fake__echo")!.run({ text: "hi" }, ctx())).toBe("hi env:s3cret-value");
  } finally {
    await handle.close();
  }
});

test("a server that dies registers nothing and its status says why; the others still register", async () => {
  const registry = createRegistry();
  const report: string[] = [];
  const handle = await registerMcp(
    registry,
    { dead: fixture({ env: ["FAKE_MCP_DIE"] }), live: fixture() },
    { env: env({ FAKE_MCP_DIE: "1" }), cwd: process.cwd(), report: (line) => report.push(line) },
  );
  try {
    expect(registry.list().filter((t) => t.startsWith("dead__"))).toEqual([]);
    expect(registry.list().filter((t) => t.startsWith("live__"))).toHaveLength(4);
    expect(handle.servers).toEqual([
      { name: "dead", status: "down", tools: 0, problem: "exited with code 1" },
      { name: "live", status: "up", tools: 4 },
    ]);
    expect(report).toEqual([]);
  } finally {
    await handle.close();
  }
});

test("a server that never answers initialize is down after the ceiling", async () => {
  const registry = createRegistry();
  const handle = await registerMcp(
    registry,
    { mute: fixture({ env: ["FAKE_MCP_MUTE"] }) },
    { env: env({ FAKE_MCP_MUTE: "1" }), cwd: process.cwd(), report: () => {}, initializeCeilingMs: 200 },
  );
  try {
    expect(registry.list()).toEqual([]);
    expect(handle.servers).toEqual([
      { name: "mute", status: "down", tools: 0, problem: "did not answer initialize in time" },
    ]);
  } finally {
    await handle.close();
  }
});

test("servers start in parallel", async () => {
  const registry = createRegistry();
  const started = Date.now();
  const handle = await registerMcp(
    registry,
    {
      one: { command: "one", args: [], env: [], tools: {} },
      two: { command: "two", args: [], env: [], tools: {} },
    },
    {
      env: {},
      cwd: process.cwd(),
      report: () => {},
      spawn: (command) => scriptedChild([{ name: command }], 400),
    },
  );
  try {
    expect(Date.now() - started).toBeLessThan(750);
    expect(registry.list()).toEqual(["one__one", "two__two"]);
  } finally {
    await handle.close();
  }
});

test("no servers configured: nothing registered, nothing to close", async () => {
  const registry = createRegistry();
  const handle = await registerMcp(registry, undefined, { env: env(), cwd: process.cwd(), report: () => {} });
  expect(registry.list()).toEqual([]);
  expect(handle.servers).toEqual([]);
  await handle.close();
  await handle.close();
});

test("close stops every server, is idempotent, and the statuses say closed", async () => {
  const registry = createRegistry();
  const spawner = capturing();
  const handle = await registerMcp(
    registry,
    { a: fixture(), b: fixture() },
    { env: env(), cwd: process.cwd(), report: () => {}, spawn: spawner.spawn },
  );
  expect(spawner.children).toHaveLength(2);
  const closing = handle.close();
  await handle.close();
  await closing;
  for (const child of spawner.children) expect(typeof (await child.exited)).toBe("number");
  expect(handle.servers).toEqual([
    { name: "a", status: "down", tools: 4, problem: "closed" },
    { name: "b", status: "down", tools: 4, problem: "closed" },
  ]);
  await expect(registry.get("a__echo")!.run({ text: "x" }, ctx())).rejects.toThrow("server a is down: closed");
  await handle.close();
});

/** The pids `pgrep -f` finds running the fixture right now. */
function fixturePids(): number[] {
  const out = Bun.spawnSync(["pgrep", "-f", "mcp-server.ts"]);
  return out.stdout.toString().trim().split("\n").filter(Boolean).map(Number);
}

test("close kills the whole process tree, not only a wrapper that ignores SIGTERM", async () => {
  const registry = createRegistry();
  const spawner = capturing();
  const handle = await registerMcp(
    registry,
    {
      wrapped: {
        command: "bash",
        args: ["-c", `trap "" TERM; bun ${FIXTURE}`],
        env: ["FAKE_MCP_LINGER"],
        tools: {},
      },
    },
    { env: env({ FAKE_MCP_LINGER: "1" }), cwd: process.cwd(), report: () => {}, spawn: spawner.spawn },
  );
  expect(handle.servers).toEqual([{ name: "wrapped", status: "up", tools: 4 }]);
  const shell = spawner.children[0]!.pid;
  const kids = Bun.spawnSync(["pgrep", "-P", String(shell)]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
  expect(kids).toHaveLength(1);
  const server = kids[0]!;
  expect(fixturePids()).toContain(shell);
  expect(fixturePids()).toContain(server);

  await handle.close();

  // A killed orphan is reaped by init a moment later; give it that moment.
  let alive = fixturePids().filter((pid) => pid === shell || pid === server);
  for (let i = 0; i < 20 && alive.length > 0; i += 1) {
    await sleep(100);
    alive = fixturePids().filter((pid) => pid === shell || pid === server);
  }
  expect(alive).toEqual([]);
});

test("reviewerTools picks the pure MCP nodes and nothing else", async () => {
  const registry = createRegistry();
  registry.register({
    type: "read", effect: "pure", description: "builtin", inputSchema: {}, async run() { return ""; },
  });
  const handle = await registerMcp(
    registry,
    { fake: fixture({ tools: { echo: "pure", hint: "write" } }) },
    { env: env(), cwd: process.cwd(), report: () => {} },
  );
  try {
    expect(handle.servers[0]!.tools).toBe(4);
    expect(reviewerTools(registry).map((node) => node.type)).toEqual(["fake__echo"]);
  } finally {
    await handle.close();
  }
});
