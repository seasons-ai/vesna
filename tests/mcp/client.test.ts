import { test, expect, spyOn } from "bun:test";
import { join } from "node:path";
import { bunSpawner, createMcpClient, type ChildLike, type Spawner } from "../../src/mcp/client";
import type { McpServerConfig } from "../../src/mcp/types";

/**
 * The client against a real server process: the fixture speaks MCP on stdio
 * and misbehaves on request (dies, stays mute, asks for a sample), so every
 * state the client can end up in is reached the way it would be in a
 * session, not by faking the wire.
 */

const FIXTURE = join(import.meta.dir, "..", "fixtures", "mcp-server.ts");

/** A config for the fixture; `env` names what the child may see. */
function config(env: string[] = []): McpServerConfig {
  return { command: "bun", args: [FIXTURE], env, tools: {} };
}

/** Vesna's environment as the client sees it, with the fixture's toggles on top. */
function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, ...extra };
}

/** A spawner that hands the test the child, for its `exited` and its stderr. */
function capturing(): { spawn: Spawner; child: () => ChildLike } {
  let captured: ChildLike | undefined;
  return {
    spawn: (command, args, options) => {
      captured = bunSpawner(command, args, { ...options, stderr: "pipe" });
      return captured;
    },
    child: () => {
      if (captured === undefined) throw new Error("nothing spawned yet");
      return captured;
    },
  };
}

/** Reads the child's stderr until a line matches, or the stream ends. */
async function stderrLine(child: ChildLike, pattern: RegExp): Promise<string | undefined> {
  if (child.stderr === undefined) throw new Error("stderr is not piped");
  let buffer = "";
  for await (const chunk of child.stderr) {
    buffer += Buffer.from(chunk).toString("utf8");
    for (const line of buffer.split("\n")) if (pattern.test(line)) return line;
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("initialize lists every tool across both pages and is up", async () => {
  const client = createMcpClient("fake", config(), { spawn: bunSpawner, env: env(), cwd: process.cwd() });
  try {
    expect(client.status()).toBe("starting");
    const { tools } = await client.initialize();
    expect(client.status()).toBe("up");
    expect(client.problem()).toBeUndefined();
    expect(tools.map((t) => t.name)).toEqual(["echo", "slow", "fail", "hint"]);
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.description).toBe("returns the text it is given");
    expect(echo.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
    expect(echo.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "hint")!.readOnlyHint).toBe(true);
  } finally {
    await client.close();
  }
});

test("a call returns the tool's text, and isError passes through", async () => {
  const client = createMcpClient("fake", config(), { spawn: bunSpawner, env: env(), cwd: process.cwd() });
  try {
    await client.initialize();
    expect(await client.call("echo", { text: "hello" })).toEqual({ text: "hello", isError: false });
    expect(await client.call("fail", {})).toEqual({ text: "it failed", isError: true });
  } finally {
    await client.close();
  }
});

test("a JSON-RPC error becomes an error result with its code and message", async () => {
  const client = createMcpClient("fake", config(), { spawn: bunSpawner, env: env(), cwd: process.cwd() });
  try {
    await client.initialize();
    expect(await client.call("nope", {})).toEqual({ text: '-32602: unknown tool "nope"', isError: true });
  } finally {
    await client.close();
  }
});

test("a call past the ceiling is an error result, and the server still answers the next one", async () => {
  const client = createMcpClient("fake", config(), {
    spawn: bunSpawner,
    env: env(),
    cwd: process.cwd(),
    callCeilingMs: 200,
  });
  try {
    await client.initialize();
    const started = Date.now();
    expect(await client.call("slow", { ms: 1500 })).toEqual({ text: "slow did not answer in 0.2 s", isError: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client.status()).toBe("up");
    expect(await client.call("echo", { text: "still here" })).toEqual({ text: "still here", isError: false });
    // The late answer to `slow` arrives with an id nobody waits for; it must
    // not disturb anything.
    await sleep(1500);
    expect(await client.call("echo", { text: "and now" })).toEqual({ text: "and now", isError: false });
  } finally {
    await client.close();
  }
});

test("an abort mid-call is 'interrupted', and the server keeps serving", async () => {
  const client = createMcpClient("fake", config(), { spawn: bunSpawner, env: env(), cwd: process.cwd() });
  try {
    await client.initialize();
    const controller = new AbortController();
    const running = client.call("slow", { ms: 1500 }, controller.signal);
    await sleep(100);
    controller.abort();
    expect(await running).toEqual({ text: "interrupted", isError: true });
    expect(client.status()).toBe("up");
    expect(await client.call("echo", { text: "after" })).toEqual({ text: "after", isError: false });
    // A signal already aborted never reaches the wire.
    expect(await client.call("echo", { text: "never" }, AbortSignal.abort())).toEqual({ text: "interrupted", isError: true });
  } finally {
    await client.close();
  }
});

test("the child sees the named variables and nothing else of Vesna's environment", async () => {
  const named = createMcpClient("fake", config(["FAKE_MCP_PRINT_ENV", "SECRET_X"]), {
    spawn: bunSpawner,
    env: env({ FAKE_MCP_PRINT_ENV: "SECRET_X", SECRET_X: "s3cret-value", OTHER_Y: "must-not-leak" }),
    cwd: process.cwd(),
  });
  const unnamed = createMcpClient("fake", config(["FAKE_MCP_PRINT_ENV"]), {
    spawn: bunSpawner,
    env: env({ FAKE_MCP_PRINT_ENV: "OTHER_Y", OTHER_Y: "must-not-leak" }),
    cwd: process.cwd(),
  });
  try {
    await named.initialize();
    expect(await named.call("echo", { text: "hi" })).toEqual({ text: "hi env:s3cret-value", isError: false });
    await unnamed.initialize();
    expect(await unnamed.call("echo", { text: "hi" })).toEqual({ text: "hi env:unset", isError: false });
  } finally {
    await named.close();
    await unnamed.close();
  }
});

test("a named variable that is not set is simply absent for the child", async () => {
  const client = createMcpClient("fake", config(["FAKE_MCP_PRINT_ENV", "NOT_SET_ANYWHERE"]), {
    spawn: bunSpawner,
    env: env({ FAKE_MCP_PRINT_ENV: "NOT_SET_ANYWHERE" }),
    cwd: process.cwd(),
  });
  try {
    await client.initialize();
    expect(await client.call("echo", { text: "hi" })).toEqual({ text: "hi env:unset", isError: false });
  } finally {
    await client.close();
  }
});

test("a server that exits is down; initialize resolves and every call says so", async () => {
  const client = createMcpClient("fake", config(["FAKE_MCP_DIE"]), {
    spawn: bunSpawner,
    env: env({ FAKE_MCP_DIE: "1" }),
    cwd: process.cwd(),
  });
  try {
    const { tools } = await client.initialize();
    expect(tools).toEqual([]);
    expect(client.status()).toBe("down");
    expect(client.problem()).toBe("exited with code 1");
    expect(await client.call("echo", { text: "hi" })).toEqual({
      text: "server fake is down: exited with code 1",
      isError: true,
    });
  } finally {
    await client.close();
  }
});

test("a server that never answers initialize is down after the ceiling, and killed", async () => {
  const spawner = capturing();
  const client = createMcpClient("fake", config(["FAKE_MCP_MUTE"]), {
    spawn: spawner.spawn,
    env: env({ FAKE_MCP_MUTE: "1" }),
    cwd: process.cwd(),
    initializeCeilingMs: 200,
  });
  try {
    const started = Date.now();
    const { tools } = await client.initialize();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(tools).toEqual([]);
    expect(client.status()).toBe("down");
    expect(client.problem()).toBe("did not answer initialize in time");
    expect(await client.call("echo", { text: "hi" })).toEqual({
      text: "server fake is down: did not answer initialize in time",
      isError: true,
    });
    expect(typeof (await spawner.child().exited)).toBe("number");
  } finally {
    await client.close();
  }
});

test("a server-initiated request is refused with -32601, and the client keeps working", async () => {
  const spawner = capturing();
  const client = createMcpClient("fake", config(["FAKE_MCP_SAMPLE"]), {
    spawn: spawner.spawn,
    env: env({ FAKE_MCP_SAMPLE: "1" }),
    cwd: process.cwd(),
  });
  try {
    await client.initialize();
    const line = await stderrLine(spawner.child(), /sample-response/);
    expect(line).toBeDefined();
    const response = JSON.parse(line!.slice(line!.indexOf("{")));
    expect(response.id).toBe(900);
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toBe("vesna offers no sampling/createMessage");
    expect(client.status()).toBe("up");
    expect(await client.call("echo", { text: "still" })).toEqual({ text: "still", isError: false });
  } finally {
    await client.close();
  }
});

test("close kills the child, is idempotent, and leaves the client down as closed", async () => {
  const spawner = capturing();
  const client = createMcpClient("fake", config(), { spawn: spawner.spawn, env: env(), cwd: process.cwd() });
  await client.initialize();
  expect(client.status()).toBe("up");
  const pending = client.call("slow", { ms: 5000 });
  await sleep(50);
  const closing = client.close();
  await client.close();
  await closing;
  expect(typeof (await spawner.child().exited)).toBe("number");
  expect(client.status()).toBe("down");
  expect(client.problem()).toBe("closed");
  expect(await pending).toEqual({ text: "server fake is down: closed", isError: true });
  expect(await client.call("echo", { text: "hi" })).toEqual({ text: "server fake is down: closed", isError: true });
  await client.close();
});

test("a command that cannot start is down, not an exception", async () => {
  const client = createMcpClient("ghost", { command: "/nonexistent/mcp-server", args: [], env: [], tools: {} }, {
    spawn: bunSpawner,
    env: env(),
    cwd: process.cwd(),
  });
  const { tools } = await client.initialize();
  expect(tools).toEqual([]);
  expect(client.status()).toBe("down");
  expect(client.problem()).toMatch(/could not start/);
  expect(await client.call("x", {})).toEqual({ text: `server ghost is down: ${client.problem()}`, isError: true });
  await client.close();
});

test("closing before initialize spawns nothing", async () => {
  let spawned = 0;
  const client = createMcpClient("fake", config(), {
    spawn: (...a) => {
      spawned += 1;
      return bunSpawner(...a);
    },
    env: env(),
    cwd: process.cwd(),
  });
  await client.close();
  expect(await client.initialize()).toEqual({ tools: [] });
  expect(spawned).toBe(0);
  expect(client.status()).toBe("down");
  expect(client.problem()).toBe("closed");
});

/**
 * An in-memory child: whatever is written to its stdin is answered on its
 * stdout, with lines the test chooses in between — the one way to put a
 * line that is not JSON in front of the client.
 */
function scriptedChild(extraLines: string[]): ChildLike & { received: string[] } {
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
  const received: string[] = [];
  return {
    pid: 0,
    received,
    stdin: {
      write(s: string) {
        for (const line of s.split("\n")) {
          if (line.trim() === "") continue;
          received.push(line);
          const message = JSON.parse(line);
          if (message.method === "initialize") {
            for (const extra of extraLines) push(extra);
            push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "scripted", version: "0" } } }));
          } else if (message.method === "tools/list") {
            push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "t", inputSchema: { type: "object" } }] } }));
          } else if (message.method === "tools/call") {
            push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "a" }, { type: "image", data: "..." }, { type: "text", text: "b" }] } }));
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

test("a line that is not JSON is ignored with one note on stderr, and content items render as the spec says", async () => {
  const child = scriptedChild(["this is not json", "", '{"jsonrpc":"2.0","method":"notifications/message","params":{}}']);
  const notes: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    notes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    const client = createMcpClient("scripted", { command: "x", args: [], env: [], tools: {} }, {
      spawn: () => child,
      env: {},
      cwd: process.cwd(),
    });
    const { tools } = await client.initialize();
    expect(tools).toEqual([{ name: "t", description: "", inputSchema: { type: "object" }, readOnlyHint: false }]);
    expect(client.status()).toBe("up");
    expect(await client.call("t", {})).toEqual({ text: "a\n[image]\nb", isError: false });
    await client.close();
  } finally {
    spy.mockRestore();
  }
  const about = notes.filter((n) => n.includes("not JSON"));
  expect(about).toHaveLength(1);
  expect(about[0]).toMatch(/^mcp scripted: /);
  // The initialize params are what the spec asks for.
  const first = JSON.parse(child.received[0]!);
  expect(first.method).toBe("initialize");
  expect(first.params.protocolVersion).toBe("2025-06-18");
  expect(first.params.clientInfo.name).toBe("vesna");
  expect(child.received.some((l) => JSON.parse(l).method === "notifications/initialized")).toBe(true);
});
