import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../src/serve/server";
import {
  createDecoder,
  frame,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  NOT_INITIALIZED,
  PARSE_ERROR,
  type RpcMessage,
} from "../../src/serve/rpc";
import type { Core, Notification, State } from "../../src/core/types";
import { until } from "../helpers/chat";

/**
 * The server glues a `Core` to the codec. Layer (a) drives `serve()` in
 * process with a fake core that records every call and lets the test emit
 * notifications; layer (b) spawns `bin/vesna serve` and talks to it over a
 * real pipe, the way an editor would.
 */

const STATE: State = {
  mode: "ask", busy: false, building: false, buildState: "idle",
  model: "m", service: "s",
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  spec: null, specSlug: null, chats: null,
  chatId: null, root: "/repo",
};

function fakeCore() {
  const calls: unknown[][] = [];
  const listeners = new Set<(n: Notification) => void>();
  // Each pending send/command resolves only when the test says so, so the
  // test controls "while a turn is running" rather than racing it.
  const pending: (() => void)[] = [];
  let closed = 0;
  const core: Core = {
    send(text) {
      calls.push(["send", text]);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    command(name, argument) {
      calls.push(["command", name, argument]);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    answer(id, value) {
      calls.push(["answer", id, value]);
      return id === "open";
    },
    interrupt() {
      calls.push(["interrupt"]);
    },
    snapshot: () => STATE,
    on(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async close() {
      closed += 1;
      calls.push(["close"]);
    },
  };
  return {
    core,
    calls,
    emit: (n: Notification) => { for (const l of listeners) l(n); },
    release: () => pending.shift()?.(),
    pendingCount: () => pending.length,
    closedCount: () => closed,
  };
}

/** A stdin the test feeds and closes, and a stdout it reads decoded. */
function harness() {
  const chunks: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const input: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (chunks.length > 0) { yield chunks.shift()!; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
  const out: RpcMessage[] = [];
  const decoder = createDecoder();
  const exits: number[] = [];
  const io = {
    input,
    write: (bytes: Uint8Array) => {
      for (const r of decoder.push(bytes)) {
        if (r.kind !== "message") throw new Error(`server wrote a bad frame: ${r.message}`);
        out.push(r.message);
      }
    },
    exit: (code: number) => { exits.push(code); },
  };
  const push = (bytes: Uint8Array) => { chunks.push(bytes); wake?.(); wake = null; };
  return {
    io,
    out,
    exits,
    request: (id: number, method: string, params?: unknown) =>
      push(frame({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })),
    notify: (method: string, params?: unknown) =>
      push(frame({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })),
    raw: (text: string) => push(new TextEncoder().encode(text)),
    end: () => { ended = true; wake?.(); wake = null; },
    response: (id: number) => out.find((m) => "id" in m && m.id === id && !("method" in m)) as any,
    notifications: (method: string) => out.filter((m) => "method" in m && !("id" in m) && m.method === method) as any[],
  };
}

async function started() {
  const fake = fakeCore();
  const h = harness();
  const running = serve(fake.core, h.io, { serverVersion: "9.9.9" });
  return { ...fake, ...h, running };
}

async function initialized() {
  const s = await started();
  s.request(1, "initialize", { clientName: "t", clientVersion: "0" });
  await until(() => s.response(1) !== undefined, "initialize");
  return s;
}

test("before initialize every request is refused with -32002", async () => {
  const s = await started();
  s.request(1, "send", { text: "hi" });
  await until(() => s.response(1) !== undefined, "the refusal");
  expect(s.response(1).error).toMatchObject({ code: NOT_INITIALIZED });
  expect(s.calls).toEqual([]);

  s.request(2, "initialize", { clientName: "t", clientVersion: "0" });
  await until(() => s.response(2) !== undefined, "initialize");
  expect(s.response(2).result).toEqual({
    serverVersion: "9.9.9",
    capabilities: { transcript: 1, state: 1, ask: 1 },
    state: STATE,
  });
  s.end();
  await s.running;
});

test("initialize twice is -32600", async () => {
  const s = await initialized();
  s.request(2, "initialize", { clientName: "t", clientVersion: "0" });
  await until(() => s.response(2) !== undefined, "the second initialize");
  expect(s.response(2).error).toMatchObject({ code: INVALID_REQUEST, message: expect.stringContaining("already initialized") });
  s.end();
  await s.running;
});

test("send, command, answer, interrupt are forwarded and answered with {}", async () => {
  const s = await initialized();
  s.request(2, "send", { text: "hi" });
  s.request(3, "command", { name: "mode", argument: "auto" });
  s.request(4, "answer", { id: "open", value: "y" });
  s.request(5, "interrupt", {});
  await until(() => s.response(5) !== undefined, "interrupt's response");
  expect(s.calls).toEqual([["send", "hi"], ["command", "mode", "auto"], ["answer", "open", "y"], ["interrupt"]]);
  expect(s.response(4).result).toEqual({});
  expect(s.response(5).result).toEqual({});
  // The turn and the command are still running: no response yet.
  expect(s.response(2)).toBeUndefined();
  expect(s.response(3)).toBeUndefined();
  s.release();
  await until(() => s.response(2) !== undefined, "send's response");
  expect(s.response(2).result).toEqual({});
  s.release();
  await until(() => s.response(3) !== undefined, "command's response");
  expect(s.response(3).result).toEqual({});
  s.end();
  await s.running;
});

test("a command without an argument is forwarded with an empty one", async () => {
  const s = await initialized();
  s.request(2, "command", { name: "help" });
  await until(() => s.calls.length === 1, "the command");
  expect(s.calls[0]).toEqual(["command", "help", ""]);
  s.end();
  await s.running;
});

test("requests are not serialized on responses: a later request is answered while an earlier one runs", async () => {
  const s = await initialized();
  s.request(2, "command", { name: "build", argument: "" });
  s.request(3, "interrupt", {});
  await until(() => s.response(3) !== undefined, "interrupt's response");
  expect(s.response(2)).toBeUndefined();
  expect(s.pendingCount()).toBe(1);
  s.release();
  await until(() => s.response(2) !== undefined, "the build's response");
  s.end();
  await s.running;
});

test("notification-shaped send and command are executed but not answered", async () => {
  const s = await initialized();
  s.notify("send", { text: "quiet" });
  s.notify("command", { name: "mode", argument: "plan" });
  await until(() => s.calls.length === 2, "the two calls");
  s.release();
  s.release();
  await new Promise((r) => setTimeout(r, 10));
  expect(s.out.filter((m) => !("method" in m))).toHaveLength(1); // initialize's response only
  s.end();
  await s.running;
});

test("bad params are -32602 and nothing reaches the core", async () => {
  const s = await initialized();
  s.request(2, "send", { text: 5 });
  s.request(3, "command", { argument: "x" });
  s.request(4, "answer", { id: "a" });
  s.request(5, "send");
  await until(() => s.response(5) !== undefined, "the last refusal");
  for (const id of [2, 3, 4, 5]) expect(s.response(id).error).toMatchObject({ code: INVALID_PARAMS });
  expect(s.calls).toEqual([]);
  s.end();
  await s.running;
});

test("answer for an id that is not open is -32602", async () => {
  const s = await initialized();
  s.request(2, "answer", { id: "gone", value: "y" });
  await until(() => s.response(2) !== undefined, "the refusal");
  expect(s.response(2).error).toMatchObject({ code: INVALID_PARAMS, message: "no such ask" });
  expect(s.calls).toEqual([["answer", "gone", "y"]]);
  s.end();
  await s.running;
});

test("an unknown method is -32601 and the server keeps going", async () => {
  const s = await initialized();
  s.request(2, "dance", {});
  s.request(3, "interrupt", {});
  await until(() => s.response(3) !== undefined, "the request after the unknown one");
  expect(s.response(2).error).toMatchObject({ code: METHOD_NOT_FOUND });
  expect(s.response(3).result).toEqual({});
  s.end();
  await s.running;
});

test("garbage is -32700 with a null id and the next frame still works", async () => {
  const s = await initialized();
  s.raw("Content-Length: 5\r\n\r\n{oops");
  s.request(2, "interrupt", {});
  await until(() => s.response(2) !== undefined, "the frame after the garbage");
  const error = s.out.find((m) => "error" in m) as any;
  expect(error).toMatchObject({ id: null, error: { code: PARSE_ERROR } });
  expect(s.response(2).result).toEqual({});
  s.end();
  await s.running;
});

test("core notifications are framed as JSON-RPC notifications in order", async () => {
  const s = await initialized();
  s.emit({ method: "transcript", params: { kind: "user", text: "hi" } });
  s.emit({ method: "ask", params: { id: "q1", kind: "approval", lines: ["ok?"], choices: ["y", "n"], strict: true } });
  s.emit({ method: "state", params: STATE });
  s.emit({ method: "ask.resolved", params: { id: "q1" } });
  const framed = s.out.filter((m) => "method" in m && !("id" in m)) as any[];
  expect(framed.map((m) => m.method)).toEqual(["transcript", "ask", "state", "ask.resolved"]);
  expect(framed[0]).toEqual({ jsonrpc: "2.0", method: "transcript", params: { kind: "user", text: "hi" } });
  expect(framed[3].params).toEqual({ id: "q1" });
  s.end();
  await s.running;
});

test("nothing is forwarded before initialize subscribed", async () => {
  const s = await started();
  s.emit({ method: "state", params: STATE });
  expect(s.out).toEqual([]);
  s.end();
  await s.running;
});

test("input ending closes the core and exits 0", async () => {
  const s = await initialized();
  s.end();
  await s.running;
  expect(s.closedCount()).toBe(1);
  expect(s.exits).toEqual([0]);
});

test("shutdown closes the core and answers {}; exit after it exits 0", async () => {
  const s = await initialized();
  s.request(2, "shutdown", {});
  await until(() => s.response(2) !== undefined, "shutdown's response");
  expect(s.response(2).result).toEqual({});
  expect(s.closedCount()).toBe(1);
  s.notify("exit");
  await s.running;
  expect(s.exits).toEqual([0]);
  expect(s.closedCount()).toBe(1);
});

test("exit without shutdown still closes the core, then exits 1", async () => {
  const s = await initialized();
  s.notify("exit");
  await s.running;
  expect(s.closedCount()).toBe(1);
  expect(s.exits).toEqual([1]);
});

test("a response from the client is ignored", async () => {
  const s = await initialized();
  s.raw(new TextDecoder().decode(frame({ jsonrpc: "2.0", id: 40, result: {} })));
  s.request(2, "interrupt", {});
  await until(() => s.response(2) !== undefined, "the request after the stray response");
  expect(s.out.filter((m) => "error" in m)).toHaveLength(0);
  s.end();
  await s.running;
});

/**
 * A write that fails is the client gone — the same event as stdin ending,
 * and it must end the same way: the core closed once, exit 0, no more frames
 * attempted, and `serve()` itself resolving rather than rejecting.
 */
test("a write that throws is the client gone: close once, exit 0, nothing more written", async () => {
  const fake = fakeCore();
  const h = harness();
  let attempts = 0;
  const io = {
    ...h.io,
    write: (bytes: Uint8Array) => {
      attempts += 1;
      if (attempts >= 2) throw Object.assign(new Error("EPIPE: broken pipe"), { code: "EPIPE" });
      h.io.write(bytes);
    },
  };
  const running = serve(fake.core, io, { serverVersion: "9.9.9" });
  h.request(1, "initialize", { clientName: "t", clientVersion: "0" });
  await until(() => h.response(1) !== undefined, "initialize");
  // The second frame is a notification; its write throws.
  fake.emit({ method: "state", params: STATE });
  await running;
  expect(fake.closedCount()).toBe(1);
  expect(h.exits).toEqual([0]);
  // Nothing after the failure reaches the output, whatever the core or the client does.
  fake.emit({ method: "state", params: STATE });
  h.request(2, "interrupt", {});
  await new Promise((r) => setTimeout(r, 20));
  expect(attempts).toBe(2);
  expect(fake.calls).not.toContainEqual(["interrupt"]);
  h.end();
});

test("output reported lost while input is open ends the same way, once", async () => {
  const fake = fakeCore();
  const h = harness();
  let lost!: () => void;
  const io = { ...h.io, lost: new Promise<void>((resolve) => { lost = resolve; }) };
  const running = serve(fake.core, io, { serverVersion: "9.9.9" });
  h.request(1, "initialize", { clientName: "t", clientVersion: "0" });
  await until(() => h.response(1) !== undefined, "initialize");
  lost();
  await running;
  expect(fake.closedCount()).toBe(1);
  expect(h.exits).toEqual([0]);
  h.end();
  await new Promise((r) => setTimeout(r, 20));
  expect(h.exits).toEqual([0]);
});

test("a core method that throws is -32603 and the server keeps going", async () => {
  const fake = fakeCore();
  fake.core.interrupt = () => { throw new Error("boom"); };
  const h = harness();
  const running = serve(fake.core, h.io, { serverVersion: "9.9.9" });
  h.request(1, "initialize", { clientName: "t", clientVersion: "0" });
  h.request(2, "interrupt", {});
  h.request(3, "answer", { id: "open", value: "y" });
  await until(() => h.response(3) !== undefined, "the request after the throw");
  expect(h.response(2).error).toMatchObject({ code: -32603, message: "boom" });
  expect(h.response(3).result).toEqual({});
  h.end();
  await running;
});

// ---------------------------------------------------------------------------
// (b) over a real pipe

const BIN = join(import.meta.dir, "..", "..", "bin", "vesna");

/**
 * A repository whose config names a local service: `ollama` needs no
 * credential and `buildContext` builds its provider without a request, so
 * `initialize`, `command` and `shutdown` need no model at all. `VESNA_HOME`
 * is a temp dir so neither the machine's settings nor its sessions are touched.
 */
async function sandbox(extra = "") {
  const cwd = await mkdtemp(join(tmpdir(), "vesna-serve-cwd-"));
  const home = await mkdtemp(join(tmpdir(), "vesna-serve-home-"));
  await mkdir(join(cwd, ".vesna"), { recursive: true });
  await writeFile(join(cwd, ".vesna", "config.yaml"), `provider: ollama\nmodel: llama3.2\n${extra}`);
  return { cwd, home };
}

function spawnServe(where: { cwd: string; home: string }) {
  const child = Bun.spawn(["bun", BIN, "serve"], {
    cwd: where.cwd,
    env: { ...process.env, VESNA_HOME: join(where.home, ".vesna") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out: RpcMessage[] = [];
  const decoder = createDecoder();
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      for (const r of decoder.push(chunk)) {
        if (r.kind !== "message") throw new Error(`bad frame from the server: ${r.message}`);
        out.push(r.message);
      }
    }
  })();
  const write = (m: RpcMessage) => { child.stdin.write(frame(m)); child.stdin.flush(); };
  return {
    child,
    out,
    write,
    reading,
    response: (id: number) => out.find((m) => "id" in m && m.id === id && !("method" in m)) as any,
    notifications: (method: string) => out.filter((m) => "method" in m && !("id" in m) && m.method === method) as any[],
    stderr: () => new Response(child.stderr).text(),
  };
}

async function waitFor(check: () => boolean, what: string, stderr: () => Promise<string>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; stderr: ${await stderr()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("over a pipe: initialize, a command, its state, shutdown, exit → 0", async () => {
  const s = spawnServe(await sandbox());
  s.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientName: "test", clientVersion: "0" } });
  await waitFor(() => s.response(1) !== undefined, "initialize", s.stderr);
  const pkg = await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json();
  expect(s.response(1).result).toMatchObject({
    serverVersion: pkg.version,
    capabilities: { transcript: 1, state: 1, ask: 1 },
    state: { mode: "ask", busy: false, building: false, model: "llama3.2", service: "ollama" },
  });

  s.write({ jsonrpc: "2.0", id: 2, method: "command", params: { name: "mode", argument: "auto" } });
  await waitFor(() => s.response(2) !== undefined, "the command's response", s.stderr);
  expect(s.response(2).result).toEqual({});
  expect(s.notifications("state").some((n) => n.params.mode === "auto")).toBe(true);
  const transcript = s.notifications("transcript").map((n) => n.params);
  expect(transcript).toContainEqual({ kind: "notice", text: expect.stringContaining("mode: auto"), level: "ok" });

  s.write({ jsonrpc: "2.0", id: 3, method: "shutdown", params: {} });
  await waitFor(() => s.response(3) !== undefined, "shutdown's response", s.stderr);
  expect(s.response(3).result).toEqual({});
  s.write({ jsonrpc: "2.0", method: "exit" });
  expect(await s.child.exited).toBe(0);
  await s.reading;
  expect(await s.stderr()).toBe("");
}, 30_000);

test("over a pipe: a request before initialize is -32002, garbage is -32700, and the server survives both", async () => {
  const s = spawnServe(await sandbox());
  s.write({ jsonrpc: "2.0", id: 1, method: "interrupt", params: {} });
  await waitFor(() => s.response(1) !== undefined, "the refusal", s.stderr);
  expect(s.response(1).error).toMatchObject({ code: NOT_INITIALIZED });
  s.child.stdin.write("Content-Length: 3\r\n\r\n{{{");
  s.child.stdin.flush();
  s.write({ jsonrpc: "2.0", id: 2, method: "initialize", params: { clientName: "test", clientVersion: "0" } });
  await waitFor(() => s.response(2) !== undefined, "initialize after the garbage", s.stderr);
  expect(s.out.find((m) => "error" in m && m.id === null)).toMatchObject({ error: { code: PARSE_ERROR } });
  expect(s.response(2).result).toMatchObject({ capabilities: { transcript: 1, state: 1, ask: 1 } });
  // stdin closing is shutdown then exit.
  s.child.stdin.end();
  expect(await s.child.exited).toBe(0);
  await s.reading;
}, 30_000);

/**
 * A turn against a service that refuses the connection: what a person would
 * see in the chat — the line quoted back, busy, the failure as a notice, the
 * turn's end, idle — arrives as notifications, and the request is answered
 * `{}`, never a JSON-RPC error. Port 1 is nobody's, so the refusal is instant.
 */
test("over a pipe: a provider failure during send is a notice, and send is still answered {}", async () => {
  const s = spawnServe(await sandbox("baseUrl: http://127.0.0.1:1/v1\n"));
  s.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientName: "test", clientVersion: "0" } });
  await waitFor(() => s.response(1) !== undefined, "initialize", s.stderr);
  s.write({ jsonrpc: "2.0", id: 2, method: "send", params: { text: "hi" } });
  await waitFor(() => s.response(2) !== undefined, "send's response", s.stderr);
  expect(s.response(2).result).toEqual({});
  const transcript = s.notifications("transcript").map((n) => n.params);
  expect(transcript[0]).toEqual({ kind: "user", text: "hi" });
  expect(transcript.some((e) => e.kind === "notice" && e.level === "error")).toBe(true);
  expect(transcript.at(-1)).toEqual({ kind: "turn-end" });
  const busy = s.notifications("state").map((n) => n.params.busy);
  expect(busy).toContain(true);
  expect(busy.at(-1)).toBe(false);
  s.child.stdin.end();
  expect(await s.child.exited).toBe(0);
  await s.reading;
}, 30_000);

/** stdout is the protocol's: a startup problem is main.ts's stderr report and exit 2, with not a byte on stdout. */
test("over a pipe: a startup problem is reported on stderr with exit 2, and stdout stays empty", async () => {
  const where = await sandbox();
  await writeFile(join(where.cwd, ".vesna", "config.yaml"), "provider: custom\n");
  const s = spawnServe(where);
  s.child.stdin.end();
  expect(await s.child.exited).toBe(2);
  await s.reading;
  expect(s.out).toEqual([]);
  expect(await s.stderr()).toContain("vesna: custom has no address of its own");
}, 30_000);

/**
 * The reviewer's reproduction: a client that crashes — its stdin closed and
 * its stdout reader gone in the same tick — while notifications are still
 * flowing. EPIPE on a write is the client gone, not a crash of the server:
 * exit 0, no stack on stderr. Ten runs, since the race is timing-dependent.
 */
test("over a pipe: a client that dies mid-burst leaves the server exiting 0 without a stack", async () => {
  const where = await sandbox();
  for (let run = 0; run < 10; run += 1) {
    const child = Bun.spawn(["bun", BIN, "serve"], {
      cwd: where.cwd,
      env: { ...process.env, VESNA_HOME: join(where.home, ".vesna") },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const write = (m: RpcMessage) => { child.stdin.write(frame(m)); child.stdin.flush(); };
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientName: "t", clientVersion: "0" } });
    await reader.read();
    for (let i = 0; i < 30; i += 1) {
      write({ jsonrpc: "2.0", id: 10 + i, method: "command", params: { name: "mode", argument: i % 2 ? "auto" : "plan" } });
    }
    child.stdin.end();
    await reader.cancel();
    const code = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect({ run, code, stderr }).toEqual({ run, code: 0, stderr: "" });
  }
}, 60_000);
