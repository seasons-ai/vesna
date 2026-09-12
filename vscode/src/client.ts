/**
 * A JSON-RPC 2.0 client for `vesna serve`'s stdio, speaking the same framing
 * as the server: `Content-Length: N\r\n\r\n` then UTF-8 JSON. Reimplemented
 * here rather than imported — the extension does not depend on the root
 * package's `src/` — so this file imports nothing but `node:child_process`
 * types and `./protocol`.
 */
import type { ChildProcess } from "node:child_process";
import type { InitializeResult, Notification } from "./protocol";

/** What the client writes to and reads from — a real child process, or a fake for tests. */
export interface Duplex {
  write(bytes: Uint8Array): void;
  onData(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: (code: number | null) => void): void;
  end(): void;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface Client {
  initialize(params: { clientName: string; clientVersion: string }): Promise<InitializeResult>;
  send(text: string): Promise<void>;
  command(name: string, argument: string, typed?: string): Promise<void>;
  answer(id: string, value: string): Promise<void>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
  /** A notification: no id, no response. */
  exit(): void;
  on(handler: (n: Notification) => void): () => void;
  onClose(handler: (code: number | null) => void): void;
  /** A frame that was not valid JSON, or had no Content-Length: skipped, never thrown. */
  onProtocolError(handler: (message: string) => void): void;
}

// ---------------------------------------------------------------------------
// Framing — the same wire format as `src/serve/rpc.ts`, kept in step by hand.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SEPARATOR = "\r\n\r\n";

export function frame(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const head = encoder.encode(`Content-Length: ${body.length}${SEPARATOR}`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

function indexOfSeparator(buf: Uint8Array): number {
  const needle = encoder.encode(SEPARATOR);
  outer: for (let i = 0; i + needle.length <= buf.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (buf[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Buffers bytes into whole messages. Only well-formed frames come out of
 * `push`; a frame with no Content-Length header, or a body that is not JSON,
 * is dropped and reported to `onBadFrame` instead of being returned or thrown.
 */
export function createDecoder(onBadFrame?: (message: string) => void): { push(chunk: Uint8Array): unknown[] } {
  let buffer: Uint8Array = new Uint8Array(0);
  return {
    push(chunk) {
      buffer = concat(buffer, chunk);
      const out: unknown[] = [];
      for (;;) {
        const sep = indexOfSeparator(buffer);
        if (sep < 0) break;
        const head = decoder.decode(buffer.slice(0, sep));
        const match = head.match(/Content-Length:\s*(\d+)/i);
        if (match === null) {
          buffer = buffer.slice(sep + SEPARATOR.length);
          onBadFrame?.("missing Content-Length");
          continue;
        }
        const length = Number(match[1]);
        const start = sep + SEPARATOR.length;
        if (buffer.length < start + length) break;
        const body = buffer.slice(start, start + length);
        buffer = buffer.slice(start + length);
        try {
          out.push(JSON.parse(decoder.decode(body)));
        } catch {
          onBadFrame?.("body is not JSON");
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// The client

export function createClient(io: Duplex): Client {
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  const notificationHandlers = new Set<(n: Notification) => void>();
  let closeHandler: ((code: number | null) => void) | null = null;
  let protocolErrorHandler: ((message: string) => void) | null = null;

  const decoder = createDecoder((message) => protocolErrorHandler?.(message));

  function request(method: string, params: unknown): Promise<unknown> {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      io.write(frame({ jsonrpc: "2.0", id, method, params }));
    });
  }

  function notify(method: string, params?: unknown): void {
    io.write(frame({ jsonrpc: "2.0", method, params }));
  }

  io.onData((bytes) => {
    for (const message of decoder.push(bytes)) handleMessage(message);
  });

  io.onClose((code) => {
    for (const entry of pending.values()) entry.reject(new RpcError(-32000, "server closed"));
    pending.clear();
    closeHandler?.(code);
  });

  function handleMessage(message: unknown): void {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      protocolErrorHandler?.("message is not an object");
      return;
    }
    const m = message as Record<string, unknown>;
    const hasId = typeof m.id === "number" || typeof m.id === "string";
    if (hasId && ("result" in m || "error" in m)) {
      // Requests get numeric ids, so a response's id is always one of ours.
      const entry = pending.get(m.id as number);
      if (!entry) return; // an unknown id is ignored, not an error
      pending.delete(m.id as number);
      if ("error" in m) {
        const error = m.error as { code: number; message: string; data?: unknown };
        entry.reject(new RpcError(error.code, error.message, error.data));
      } else {
        entry.resolve(m.result);
      }
      return;
    }
    if (typeof m.method === "string") {
      const notification = { method: m.method, params: m.params } as Notification;
      for (const handler of notificationHandlers) handler(notification);
      return;
    }
    protocolErrorHandler?.("message is neither a response nor a notification");
  }

  return {
    initialize: (params) => request("initialize", params) as Promise<InitializeResult>,
    send: (text) => request("send", { text }).then(() => undefined),
    command: (name, argument, typed) =>
      request("command", { name, argument, ...(typed === undefined ? {} : { typed }) }).then(() => undefined),
    answer: (id, value) => request("answer", { id, value }).then(() => undefined),
    interrupt: () => request("interrupt", {}).then(() => undefined),
    shutdown: () => request("shutdown", {}).then(() => undefined),
    exit: () => notify("exit"),
    on: (handler) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
    onProtocolError: (handler) => {
      protocolErrorHandler = handler;
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter from a Node child process

export function childDuplex(child: ChildProcess): Duplex {
  return {
    write(bytes) {
      child.stdin?.write(bytes);
    },
    onData(handler) {
      child.stdout?.on("data", (chunk: Buffer) => handler(new Uint8Array(chunk)));
    },
    onClose(handler) {
      child.on("exit", (code) => handler(code));
    },
    end() {
      child.stdin?.end();
    },
  };
}
