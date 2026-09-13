import { test, expect } from "bun:test";
import { createDecoder, frame } from "../src/client";
import type { Notification, State } from "../src/protocol";
import { startServer, stopServer, lastLines, type ChildLike, type Spawner } from "../src/server";
import type { ServerStatus } from "../src/state";

/**
 * A child process the test drives by hand: what the extension writes is
 * decoded into frames, and what the "server" says is emitted as bytes on
 * stdout. No process, no pipes.
 */
class FakeChild implements ChildLike {
  written: Uint8Array[] = [];
  ended = false;
  killed: string[] = [];
  exitCode: number | null = null;
  private handlers: Record<string, ((...args: any[]) => void)[]> = {};
  stdin = {
    write: (chunk: Uint8Array) => {
      this.written.push(chunk);
      return true;
    },
    end: () => {
      this.ended = true;
    },
    on: (_event: string, _handler: (...args: any[]) => void) => this.stdin,
  };
  stdout = { on: (event: string, handler: (...args: any[]) => void) => this.listen(`stdout:${event}`, handler) };
  stderr = { on: (event: string, handler: (...args: any[]) => void) => this.listen(`stderr:${event}`, handler) };
  on(event: string, handler: (...args: any[]) => void): this {
    this.listen(event, handler);
    return this;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(String(signal ?? "SIGTERM"));
    return true;
  }
  private listen(key: string, handler: (...args: any[]) => void): this {
    (this.handlers[key] ??= []).push(handler);
    return this;
  }
  private fire(key: string, ...args: unknown[]): void {
    for (const handler of this.handlers[key] ?? []) handler(...args);
  }
  /** Test helpers below — not part of `ChildLike`. */
  sent(): any[] {
    const decoder = createDecoder();
    return this.written.flatMap((bytes) => decoder.push(bytes));
  }
  say(message: unknown): void {
    this.sayRaw(frame(message));
  }
  sayRaw(bytes: Uint8Array): void {
    this.fire("stdout:data", Buffer.from(bytes));
  }
  complain(text: string): void {
    this.fire("stderr:data", Buffer.from(text));
  }
  exit(code: number | null): void {
    this.exitCode = code;
    this.fire("exit", code, null);
  }
  fail(error: Error): void {
    this.fire("error", error);
  }
}

function makeState(): State {
  return {
    mode: "plan",
    busy: false,
    building: false,
    buildState: "idle",
    model: "llama3.2",
    service: "ollama",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    spec: null,
    specSlug: null,
    chats: null,
    chatId: null,
    root: "/repo",
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  child: FakeChild;
  spawner: Spawner;
  calls: { command: string; args: string[]; cwd: string }[];
  statuses: ServerStatus[];
  notifications: Notification[];
}

function harness(spawn?: Spawner): Harness {
  const child = new FakeChild();
  const calls: Harness["calls"] = [];
  const spawner: Spawner =
    spawn ??
    ((command, args, opts) => {
      calls.push({ command, args: [...args], cwd: opts.cwd });
      return child;
    });
  return { child, spawner, calls, statuses: [], notifications: [] };
}

function start(h: Harness, over: { command?: string; args?: string[] } = {}) {
  return startServer({
    command: over.command ?? "vesna",
    args: over.args ?? [],
    cwd: "/repo",
    extensionVersion: "0.1.0",
    spawn: h.spawner,
    onStatus: (s) => h.statuses.push(s),
    onNotification: (n) => h.notifications.push(n),
  });
}

/** Answers the pending `initialize` on the fake child with the given capabilities. */
function answerInitialize(child: FakeChild, capabilities: Record<string, number>, serverVersion = "0.9.0"): void {
  const [request] = child.sent();
  expect(request.method).toBe("initialize");
  child.say({ jsonrpc: "2.0", id: request.id, result: { serverVersion, capabilities, state: makeState() } });
}

// ---------------------------------------------------------------------------
// A good handshake

test("a good handshake spawns `<command> <args> serve` in the folder, initializes as vscode-vesna, and comes up", async () => {
  const h = harness();
  const started = start(h, { command: "bun", args: ["/x/bin/vesna"] });
  await tick();
  expect(h.calls).toEqual([{ command: "bun", args: ["/x/bin/vesna", "serve"], cwd: "/repo" }]);
  expect(h.statuses).toEqual([{ kind: "starting" }]);

  const [request] = h.child.sent();
  expect(request).toMatchObject({
    method: "initialize",
    params: { clientName: "vscode-vesna", clientVersion: "0.1.0" },
  });
  answerInitialize(h.child, { transcript: 1, state: 1, ask: 1 });
  const { client } = await started;
  expect(client).not.toBeNull();
  expect(h.statuses.map((s) => s.kind)).toEqual(["starting", "up"]);
  // The state that came with the handshake reaches the panel as a notification, before `up`.
  expect(h.notifications).toHaveLength(1);
  expect(h.notifications[0]).toMatchObject({ method: "state", params: { model: "llama3.2", service: "ollama" } });
});

test("notifications after the handshake are forwarded, including ones in the same chunk as the response", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  const [request] = h.child.sent();
  const response = frame({
    jsonrpc: "2.0",
    id: request.id,
    result: { serverVersion: "0.9.0", capabilities: { transcript: 1, state: 1, ask: 1 }, state: makeState() },
  });
  const notice = frame({ jsonrpc: "2.0", method: "transcript", params: { kind: "notice", text: "hello", level: "ok" } });
  // Both frames in one chunk.
  const both = new Uint8Array(response.length + notice.length);
  both.set(response);
  both.set(notice, response.length);
  h.child.sayRaw(both);
  await started;
  h.child.say({ jsonrpc: "2.0", method: "state", params: { ...makeState(), mode: "auto" } });
  expect(h.notifications.map((n) => n.method)).toEqual(["state", "transcript", "state"]);
  expect((h.notifications[2] as any).params.mode).toBe("auto");
});

test("a server later exiting reports exited with the code and the last stderr lines", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  answerInitialize(h.child, { transcript: 1, state: 1, ask: 1 });
  await started;
  h.child.complain("warning: something\n");
  h.child.complain("fatal: boom\n");
  h.child.exit(1);
  expect(h.statuses[h.statuses.length - 1]).toEqual({ kind: "exited", code: 1, stderr: "warning: something\nfatal: boom" });
});

// ---------------------------------------------------------------------------
// Too old

test("capabilities missing a required key → tooOld, then shutdown and exit, no client", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  answerInitialize(h.child, { transcript: 1 }, "0.5.0");
  await tick();
  expect(h.child.sent().map((m) => m.method)).toEqual(["initialize", "shutdown", "exit"]);
  h.child.exit(0);
  const { client } = await started;
  expect(client).toBeNull();
  expect(h.statuses).toEqual([{ kind: "starting" }, { kind: "tooOld", server: "0.5.0", extension: "0.1.0" }]);
  // The exit we asked for is not an `exited` status.
  expect(h.statuses.some((s) => s.kind === "exited")).toBe(false);
});

test("a required capability below the required value is tooOld as well", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  answerInitialize(h.child, { transcript: 1, state: 0, ask: 1 }, "0.6.0");
  await tick();
  h.child.exit(0);
  const { client } = await started;
  expect(client).toBeNull();
  expect(h.statuses[1]).toEqual({ kind: "tooOld", server: "0.6.0", extension: "0.1.0" });
});

test("a capability above the required value is fine", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  answerInitialize(h.child, { transcript: 2, state: 1, ask: 3, extra: 1 });
  const { client } = await started;
  expect(client).not.toBeNull();
  expect(h.statuses[1]).toEqual({ kind: "up" });
});

// ---------------------------------------------------------------------------
// Not found, early exit

test("a spawner that throws ENOENT → notFound with the command", async () => {
  const h = harness(() => {
    const error = new Error("spawn vesna ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  });
  const { client } = await start(h);
  expect(client).toBeNull();
  expect(h.statuses).toEqual([{ kind: "starting" }, { kind: "notFound", command: "vesna" }]);
});

test("a child that reports ENOENT through its error event → notFound", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  const error = new Error("spawn vesna ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  h.child.fail(error);
  const { client } = await started;
  expect(client).toBeNull();
  expect(h.statuses).toEqual([{ kind: "starting" }, { kind: "notFound", command: "vesna" }]);
});

test("a child that exits before answering initialize → exited with the captured stderr", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  h.child.complain("vesna: no config\n       run vesna init\n");
  h.child.exit(2);
  const { client } = await started;
  expect(client).toBeNull();
  expect(h.statuses).toEqual([
    { kind: "starting" },
    { kind: "exited", code: 2, stderr: "vesna: no config\n       run vesna init" },
  ]);
});

test("lastLines keeps only the tail", () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const kept = lastLines(text, 20);
  expect(kept.split("\n")).toHaveLength(20);
  expect(kept.startsWith("line 11\n")).toBe(true);
  expect(kept.endsWith("line 30")).toBe(true);
  expect(lastLines("", 20)).toBe("");
});

// ---------------------------------------------------------------------------
// Stopping

test("stopServer writes shutdown and exit back to back, and does not kill a child that leaves in time", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  answerInitialize(h.child, { transcript: 1, state: 1, ask: 1 });
  const { client, child } = await started;
  const stopping = stopServer(client!, child!, 200);
  await tick();
  // Both are on the wire before the server has answered anything.
  expect(h.child.sent().map((m) => m.method)).toEqual(["initialize", "shutdown", "exit"]);
  h.child.exit(0);
  await stopping;
  expect(h.child.killed).toEqual([]);
  // A stop we asked for does not read as the server dying.
  expect(h.statuses.map((s) => s.kind)).toEqual(["starting", "up"]);
});

test("stopServer kills a child that ignores everything once the ceiling passes", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  answerInitialize(h.child, { transcript: 1, state: 1, ask: 1 });
  const { client, child } = await started;
  const before = Date.now();
  await stopServer(client!, child!, 30);
  expect(Date.now() - before).toBeGreaterThanOrEqual(25);
  expect(h.child.killed).toEqual(["SIGKILL"]);
});

test("stopServer on a process that already exited resolves at once", async () => {
  const h = harness();
  const started = start(h);
  await tick();
  answerInitialize(h.child, { transcript: 1, state: 1, ask: 1 });
  const { client, child } = await started;
  h.child.exit(1);
  await stopServer(client!, child!, 30);
  expect(h.child.killed).toEqual([]);
});

// ---------------------------------------------------------------------------
// A handshake that never comes

test("a child that never answers initialize → unresponsive after the handshake ceiling, and killed", async () => {
  const h = harness();
  const started = startServer({
    command: "vesna",
    args: [],
    cwd: "/repo",
    extensionVersion: "0.1.0",
    spawn: h.spawner,
    handshakeMs: 30,
    onStatus: (s) => h.statuses.push(s),
    onNotification: (n) => h.notifications.push(n),
  });
  const { client } = await started;
  expect(client).toBeNull();
  expect(h.statuses).toEqual([{ kind: "starting" }, { kind: "unresponsive" }]);
  expect(h.child.killed).toEqual(["SIGKILL"]);
  // The kill's exit is ours, not news.
  h.child.exit(null);
  expect(h.statuses).toHaveLength(2);
});

test("onSpawn hands the child over at spawn time, before any handshake", async () => {
  const h = harness();
  const spawned: ChildLike[] = [];
  const started = startServer({
    command: "vesna",
    args: [],
    cwd: "/repo",
    extensionVersion: "0.1.0",
    spawn: h.spawner,
    onSpawn: (child) => spawned.push(child),
    onStatus: (s) => h.statuses.push(s),
    onNotification: (n) => h.notifications.push(n),
  });
  await tick();
  expect(spawned).toEqual([h.child]);
  answerInitialize(h.child, { transcript: 1, state: 1, ask: 1 });
  await started;
});

test("up comes before the handshake's state, so an ask sent right after it is not cleared by up", async () => {
  const h = harness();
  const order: string[] = [];
  const started = startServer({
    command: "vesna",
    args: [],
    cwd: "/repo",
    extensionVersion: "0.1.0",
    spawn: h.spawner,
    onStatus: (s) => order.push(`status:${s.kind}`),
    onNotification: (n) => order.push(`notification:${n.method}`),
  });
  await tick();
  answerInitialize(h.child, { transcript: 1, state: 1, ask: 1 });
  await started;
  expect(order).toEqual(["status:starting", "status:up", "notification:state"]);
});
