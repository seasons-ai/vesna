/**
 * JSON-RPC 2.0 over a byte stream, framed the way the Language Server
 * Protocol frames it: a Content-Length header, a blank line, the JSON body.
 * Pure: bytes in, messages out, no I/O, so it can be tested on bytes alone.
 */
export interface RpcRequest { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }
export interface RpcNotification { jsonrpc: "2.0"; method: string; params?: unknown }
export interface RpcError { code: number; message: string; data?: unknown }
export interface RpcResponse { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: RpcError }
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
/** Not in the JSON-RPC spec; LSP's code for "initialize has not happened". */
export const NOT_INITIALIZED = -32002;

export type DecodeResult =
  | { kind: "message"; message: RpcMessage }
  | { kind: "error"; code: number; message: string; id: number | string | null };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SEPARATOR = "\r\n\r\n";

export function frame(message: RpcMessage): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const head = encoder.encode(`Content-Length: ${body.length}${SEPARATOR}`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

// JSON-RPC discourages `id: null`, but doesn't forbid it. We treat a message
// with `id: null` as notification-shaped: `isRequest` returns false for it,
// `isNotification` returns true. Practically this means a request sent with
// `id: null` never gets a response — the caller asked for that by using the
// id reserved for "no reply expected". Everything with a defined, non-null
// `id` and a `method` is a request; everything with a `method` and no `id`
// at all (including `id: null`) is a notification.
export function isRequest(m: RpcMessage): m is RpcRequest {
  return "method" in m && "id" in m && m.id !== undefined && m.id !== null;
}

export function isNotification(m: RpcMessage): m is RpcNotification {
  return "method" in m && (!("id" in m) || (m as { id?: unknown }).id === null);
}

export function resultResponse(id: number | string, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: number | string | null, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function indexOf(buf: Uint8Array, needle: string): number {
  const n = encoder.encode(needle);
  outer: for (let i = 0; i + n.length <= buf.length; i += 1) {
    for (let j = 0; j < n.length; j += 1) if (buf[i + j] !== n[j]) continue outer;
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

function classify(body: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "error", code: PARSE_ERROR, message: "body is not JSON", id: null };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "error", code: INVALID_REQUEST, message: "not a JSON-RPC message", id: null };
  }
  const m = parsed as Record<string, unknown>;
  const id = typeof m.id === "number" || typeof m.id === "string" ? m.id : null;
  if (m.jsonrpc !== "2.0") return { kind: "error", code: INVALID_REQUEST, message: "jsonrpc must be \"2.0\"", id };
  const hasMethod = typeof m.method === "string";
  const hasResult = "result" in m || "error" in m;
  if (!hasMethod && !hasResult) return { kind: "error", code: INVALID_REQUEST, message: "neither a method nor a response", id };
  return { kind: "message", message: parsed as RpcMessage };
}

// Header matching is case-insensitive per LSP (`/Content-Length:\s*(\d+)/i`),
// and other headers (e.g. Content-Type) may appear before or after it within
// the same header block — the regex just scans the whole block for the
// Content-Length line, wherever it falls.
//
// If Content-Length names more bytes than the buffer currently holds, push
// simply waits for more input on the next call; there is no timeout here,
// since the server (not the codec) owns time.
export function createDecoder(): { push(chunk: Uint8Array): DecodeResult[] } {
  let buffer: Uint8Array = new Uint8Array(0);
  return {
    push(chunk) {
      buffer = concat(buffer, chunk);
      const out: DecodeResult[] = [];
      for (;;) {
        const sep = indexOf(buffer, SEPARATOR);
        if (sep < 0) break;
        const head = decoder.decode(buffer.slice(0, sep));
        const match = head.match(/Content-Length:\s*(\d+)/i);
        if (match === null) {
          out.push({ kind: "error", code: PARSE_ERROR, message: "missing Content-Length", id: null });
          buffer = buffer.slice(sep + SEPARATOR.length);
          continue;
        }
        const length = Number(match[1]);
        const start = sep + SEPARATOR.length;
        if (buffer.length < start + length) break;
        const body = decoder.decode(buffer.slice(start, start + length));
        buffer = buffer.slice(start + length);
        out.push(classify(body));
      }
      return out;
    },
  };
}
