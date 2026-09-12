import type { Core } from "../core/types";
import {
  createDecoder,
  errorResponse,
  frame,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isRequest,
  METHOD_NOT_FOUND,
  NOT_INITIALIZED,
  resultResponse,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
} from "./rpc";

/** JSON-RPC's own code for a handler that threw; the core never should, but a server must not die of it. */
const INTERNAL_ERROR = -32603;

/** The version handshake: a later server adds a key, an older client ignores it. */
const CAPABILITIES = { transcript: 1, state: 1, ask: 1 } as const;

export interface ServeIo {
  input: AsyncIterable<Uint8Array>;
  /** May throw (EPIPE) once the client's read end is gone; the server treats that as the client leaving. */
  write: (bytes: Uint8Array) => void;
  exit: (code: number) => void;
  /** Resolves when the output is known to be gone without a write to say so (stdout's `error` event). */
  lost?: Promise<void>;
}

type Params = Record<string, unknown>;

/** Params are an object with the named string fields; anything else is a client mistake. */
function strings(params: unknown, required: string[], optional: string[] = []): Params | null {
  if (params === undefined) params = {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const p = params as Params;
  for (const key of required) if (typeof p[key] !== "string") return null;
  for (const key of optional) if (p[key] !== undefined && typeof p[key] !== "string") return null;
  return p;
}

/**
 * The agent behind JSON-RPC on a byte stream: requests are the core's
 * methods, the core's notifications go out as JSON-RPC notifications, and
 * protocol mistakes are errors the server survives. Requests are dispatched
 * as they arrive — `send` and `command` are answered when their promise
 * resolves, and other requests are answered meanwhile; the core's own queue
 * is the only ordering. Input ending is `shutdown` then `exit`: the core is
 * closed (a build cancelled, ceiling included) and the process leaves with 0.
 * A write that fails is the same event — the client is gone — and ends the
 * same way, once; nothing more is written after it.
 */
export async function serve(core: Core, io: ServeIo, meta: { serverVersion: string }): Promise<void> {
  // Set when the output is gone: every later frame is dropped, the reading
  // stops, and the leave below runs exactly as it does for input ending.
  let gone = false;
  let leave!: () => void;
  const left = new Promise<void>((resolve) => { leave = resolve; });
  const lost = (): void => {
    if (gone) return;
    gone = true;
    leave();
  };
  void io.lost?.then(lost);
  const write = (message: RpcMessage): void => {
    if (gone) return;
    try {
      io.write(frame(message));
    } catch {
      lost();
    }
  };
  let initialized = false;
  // Held in an object: TypeScript cannot see the assignment inside `handle`.
  const subscription: { off: (() => void) | null } = { off: null };
  // Set when `shutdown` arrives; `exit` after it is the orderly leave (0).
  let shutdown: Promise<void> | null = null;

  function handle(message: RpcRequest | RpcNotification): void {
    const id = isRequest(message) ? message.id : null;
    const reply = (result: unknown): void => { if (id !== null) write(resultResponse(id, result)); };
    const refuse = (code: number, text: string): void => { if (id !== null) write(errorResponse(id, code, text)); };
    const settle = (run: Promise<void>): void => {
      run.then(() => reply({}), (error: unknown) => refuse(INTERNAL_ERROR, (error as Error)?.message ?? String(error)));
    };

    if (message.method === "initialize") {
      if (initialized) return refuse(INVALID_REQUEST, "already initialized");
      // A handshake is a request: one without an id has nobody to hand the
      // state to, and must not lock the real one out. Its params name the
      // client, and a client that cannot say who it is has not initialized.
      if (id === null) return;
      if (strings(message.params, ["clientName", "clientVersion"]) === null) {
        return refuse(INVALID_PARAMS, "initialize needs { clientName: string; clientVersion: string }");
      }
      initialized = true;
      reply({ serverVersion: meta.serverVersion, capabilities: CAPABILITIES, state: core.snapshot() });
      subscription.off = core.on((n) => write({ jsonrpc: "2.0", method: n.method, params: n.params }));
      return;
    }
    if (!initialized) return refuse(NOT_INITIALIZED, "not initialized");

    switch (message.method) {
      case "send": {
        const p = strings(message.params, ["text"]);
        if (p === null) return refuse(INVALID_PARAMS, "send needs { text: string }");
        return settle(core.send(p.text as string));
      }
      case "command": {
        const p = strings(message.params, ["name"], ["argument", "typed"]);
        if (p === null) return refuse(INVALID_PARAMS, "command needs { name: string; argument?: string; typed?: string }");
        const typed = p.typed as string | undefined;
        return settle(core.command(p.name as string, (p.argument as string | undefined) ?? "", typed === undefined ? {} : { typed }));
      }
      case "answer": {
        const p = strings(message.params, ["id", "value"]);
        if (p === null) return refuse(INVALID_PARAMS, "answer needs { id: string; value: string }");
        if (!core.answer(p.id as string, p.value as string)) return refuse(INVALID_PARAMS, "no such ask");
        return reply({});
      }
      case "interrupt":
        core.interrupt();
        return reply({});
      case "shutdown":
        shutdown ??= core.close();
        return settle(shutdown);
      default:
        return refuse(METHOD_NOT_FOUND, `unknown method "${message.method}"`);
    }
  }

  const decoder = createDecoder();
  // `exit` is honoured whether or not anything else has happened: a client
  // that leaves is a client that leaves. Before `shutdown` it is a mistake
  // the exit code reports — after the core is closed all the same, so no
  // build is left running behind a client that is gone.
  let exit: number | null = null;
  const reading = (async () => {
    reading: for await (const chunk of io.input) {
      for (const item of decoder.push(chunk)) {
        if (gone) break reading;
        if (item.kind === "error") {
          write(errorResponse(item.id, item.code, item.message));
          continue;
        }
        const message = item.message;
        // The server sends no requests, so a response has nothing to correlate.
        if (!("method" in message)) continue;
        if (message.method === "exit" && !isRequest(message)) {
          exit = shutdown === null ? 1 : 0;
          break reading;
        }
        // No request may take the loop down: a method that throws is that
        // request's failure, reported to it when it can be.
        try {
          handle(message);
        } catch (error) {
          if (isRequest(message)) write(errorResponse(message.id, INTERNAL_ERROR, (error as Error)?.message ?? String(error)));
        }
      }
    }
  })();
  // Whichever comes first: the input ending (or `exit`), or the output gone.
  await Promise.race([reading, left]);

  // Input ending without `exit` is the client dying: shutdown then exit, 0.
  // The output gone is the same client, the same leave.
  await (shutdown ?? core.close());
  subscription.off?.();
  io.exit(exit ?? 0);
}
