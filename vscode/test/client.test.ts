import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDuplex, createClient, createDecoder, frame, RpcError, type Duplex } from "../src/client";

/**
 * (a) a fake duplex the test drives by hand: no process, no bytes on the
 * wire beyond what `frame`/`createDecoder` produce, so the client's request
 * bookkeeping is tested in isolation from the real server.
 */
class FakeDuplex implements Duplex {
  written: Uint8Array[] = [];
  ended = false;
  private dataHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: ((code: number | null) => void) | null = null;
  write(bytes: Uint8Array): void {
    this.written.push(bytes);
  }
  onData(handler: (bytes: Uint8Array) => void): void {
    this.dataHandler = handler;
  }
  onClose(handler: (code: number | null) => void): void {
    this.closeHandler = handler;
  }
  end(): void {
    this.ended = true;
  }
  /** Test helpers below — not part of `Duplex`. */
  emit(message: unknown): void {
    this.dataHandler?.(frame(message));
  }
  emitRaw(bytes: Uint8Array): void {
    this.dataHandler?.(bytes);
  }
  close(code: number | null): void {
    this.closeHandler?.(code);
  }
}

function sentMessages(io: FakeDuplex): any[] {
  const decoder = createDecoder();
  return io.written.flatMap((bytes) => decoder.push(bytes));
}

test("initialize frames the right request and resolves on the response", async () => {
  const io = new FakeDuplex();
  const client = createClient(io);
  const promise = client.initialize({ clientName: "test", clientVersion: "0.0.1" });
  const sent = sentMessages(io);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientName: "test", clientVersion: "0.0.1" },
  });
  io.emit({
    jsonrpc: "2.0",
    id: 1,
    result: { serverVersion: "0.7.0", capabilities: { transcript: 1 }, state: {} },
  });
  const result = await promise;
  expect(result.serverVersion).toBe("0.7.0");
});

test("two requests in flight resolve by id in any order", async () => {
  const io = new FakeDuplex();
  const client = createClient(io);
  const a = client.interrupt();
  const b = client.shutdown();
  const sent = sentMessages(io);
  expect(sent.map((m) => m.method)).toEqual(["interrupt", "shutdown"]);
  const [idA, idB] = sent.map((m) => m.id);
  // Answer the second request first — resolution is by id, not by order sent.
  io.emit({ jsonrpc: "2.0", id: idB, result: {} });
  io.emit({ jsonrpc: "2.0", id: idA, result: {} });
  await expect(b).resolves.toBeUndefined();
  await expect(a).resolves.toBeUndefined();
});

test("a notification reaches on, and stops after unsubscribing", () => {
  const io = new FakeDuplex();
  const client = createClient(io);
  const seen: unknown[] = [];
  const off = client.on((n) => seen.push(n));
  io.emit({ jsonrpc: "2.0", method: "state", params: { mode: "auto" } });
  expect(seen).toEqual([{ method: "state", params: { mode: "auto" } }]);
  off();
  io.emit({ jsonrpc: "2.0", method: "state", params: { mode: "plan" } });
  expect(seen).toHaveLength(1);
});

test("an error response rejects with the code", async () => {
  const io = new FakeDuplex();
  const client = createClient(io);
  const promise = client.interrupt();
  const [sent] = sentMessages(io);
  io.emit({ jsonrpc: "2.0", id: sent.id, error: { code: -32601, message: "unknown method" } });
  try {
    await promise;
    throw new Error("expected the request to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(-32601);
    expect((error as RpcError).message).toBe("unknown method");
  }
});

test("a response with an unknown id is ignored", async () => {
  const io = new FakeDuplex();
  const client = createClient(io);
  const promise = client.interrupt();
  const [sent] = sentMessages(io);
  io.emit({ jsonrpc: "2.0", id: 999, result: { ignored: true } });
  io.emit({ jsonrpc: "2.0", id: sent.id, result: {} });
  await expect(promise).resolves.toBeUndefined();
});

test("close rejects every pending request with server closed", async () => {
  const io = new FakeDuplex();
  const client = createClient(io);
  const a = client.interrupt();
  const b = client.shutdown();
  io.close(1);
  for (const pending of [a, b]) {
    try {
      await pending;
      throw new Error("expected the request to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(-32000);
      expect((error as RpcError).message).toBe("server closed");
    }
  }
});

test("a bad frame is skipped and reported through onProtocolError, never thrown", () => {
  const io = new FakeDuplex();
  const client = createClient(io);
  const errors: string[] = [];
  client.onProtocolError((message) => errors.push(message));
  expect(() => io.emitRaw(new TextEncoder().encode("not a frame at all"))).not.toThrow();
  expect(() => io.emitRaw(new TextEncoder().encode("Content-Length: 3\r\n\r\n{{{"))).not.toThrow();
  expect(errors.length).toBeGreaterThan(0);
});

test("createDecoder buffers a frame split across chunks", () => {
  const decoder = createDecoder();
  const bytes = frame({ jsonrpc: "2.0", method: "ping" });
  const first = bytes.slice(0, 5);
  const second = bytes.slice(5);
  expect(decoder.push(first)).toEqual([]);
  expect(decoder.push(second)).toEqual([{ jsonrpc: "2.0", method: "ping" }]);
});

// ---------------------------------------------------------------------------
// (b) over a real pipe: `bun ../bin/vesna serve`

const BIN = join(import.meta.dir, "..", "..", "bin", "vesna");

/** Mirrors `tests/serve/server.test.ts`'s sandbox: an ollama config needs no credential. */
async function sandbox() {
  const cwd = await mkdtemp(join(tmpdir(), "vesna-vscode-client-cwd-"));
  const home = await mkdtemp(join(tmpdir(), "vesna-vscode-client-home-"));
  await mkdir(join(cwd, ".vesna"), { recursive: true });
  await writeFile(join(cwd, ".vesna", "config.yaml"), "provider: ollama\nmodel: llama3.2\n");
  return { cwd, home };
}

test(
  "over a pipe: initialize, a command's notifications, then shutdown/exit close the child at 0",
  async () => {
    const where = await sandbox();
    const child = spawn("bun", [BIN, "serve"], {
      cwd: where.cwd,
      env: { ...process.env, VESNA_HOME: join(where.home, ".vesna") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const io = childDuplex(child);
    const client = createClient(io);

    const init = await client.initialize({ clientName: "test", clientVersion: "0.0.1" });
    expect(init.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(init.capabilities.transcript).toBe(1);

    const notifications: { method: string; params: any }[] = [];
    client.on((n) => notifications.push(n));
    await client.command("mode", "auto", "/mode auto");
    expect(notifications.some((n) => n.method === "state" && n.params.mode === "auto")).toBe(true);
    expect(
      notifications.some(
        (n) => n.method === "transcript" && n.params.kind === "user" && n.params.text === "/mode auto",
      ),
    ).toBe(true);

    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await client.shutdown();
    client.exit();
    io.end();
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
  },
  5000,
);
