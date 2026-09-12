import { test, expect } from "bun:test";
import { createDecoder, frame, errorResponse, resultResponse, isRequest, isNotification, PARSE_ERROR, INVALID_REQUEST } from "../../src/serve/rpc";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("a frame is Content-Length, a blank line, and the JSON in UTF-8", () => {
  const bytes = frame({ jsonrpc: "2.0", id: 1, method: "send", params: { text: "привет" } });
  const text = dec.decode(bytes);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send", params: { text: "привет" } });
  expect(text).toBe(`Content-Length: ${enc.encode(body).length}\r\n\r\n${body}`);
});

test("one frame decodes to one message", () => {
  const d = createDecoder();
  const out = d.push(frame({ jsonrpc: "2.0", id: 7, method: "interrupt" }));
  expect(out).toEqual([{ kind: "message", message: { jsonrpc: "2.0", id: 7, method: "interrupt" } }]);
});

test("two frames in one read decode to two messages, in order", () => {
  const d = createDecoder();
  const a = frame({ jsonrpc: "2.0", method: "state", params: { busy: false } });
  const b = frame({ jsonrpc: "2.0", id: 2, method: "shutdown" });
  const joined = new Uint8Array(a.length + b.length); joined.set(a); joined.set(b, a.length);
  const out = d.push(joined);
  expect(out.map((r) => r.kind)).toEqual(["message", "message"]);
  expect((out[1] as any).message.method).toBe("shutdown");
});

test("a frame split across reads decodes once the last byte arrives", () => {
  const d = createDecoder();
  const whole = frame({ jsonrpc: "2.0", id: 3, method: "send", params: { text: "x" } });
  const cut = 17;
  expect(d.push(whole.slice(0, cut))).toEqual([]);
  expect(d.push(whole.slice(cut, whole.length - 1))).toEqual([]);
  const out = d.push(whole.slice(whole.length - 1));
  expect(out).toHaveLength(1);
  expect((out[0] as any).message.params).toEqual({ text: "x" });
});

test("a body that is not JSON is a parse error with a null id, and the next frame still decodes", () => {
  const d = createDecoder();
  const bad = enc.encode("Content-Length: 5\r\n\r\n{nope");
  const good = frame({ jsonrpc: "2.0", id: 4, method: "interrupt" });
  const joined = new Uint8Array(bad.length + good.length); joined.set(bad); joined.set(good, bad.length);
  const out = d.push(joined);
  expect(out[0]).toEqual({ kind: "error", code: PARSE_ERROR, message: expect.any(String), id: null });
  expect(out[1]!.kind).toBe("message");
});

test("a header block without a Content-Length is a parse error and is skipped", () => {
  const d = createDecoder();
  const out = d.push(enc.encode("X-Nothing: 1\r\n\r\n"));
  expect(out).toEqual([{ kind: "error", code: PARSE_ERROR, message: expect.any(String), id: null }]);
  expect(d.push(frame({ jsonrpc: "2.0", id: 5, method: "interrupt" }))).toHaveLength(1);
});

test("JSON that is not a JSON-RPC message is an invalid request carrying its id when it has one", () => {
  const d = createDecoder();
  const body = JSON.stringify({ id: 9, hello: "world" });
  const out = d.push(enc.encode(`Content-Length: ${body.length}\r\n\r\n${body}`));
  expect(out).toEqual([{ kind: "error", code: INVALID_REQUEST, message: expect.any(String), id: 9 }]);
});

test("requests and notifications are told apart by the id, and responses are built the same way back", () => {
  expect(isRequest({ jsonrpc: "2.0", id: 1, method: "m" })).toBe(true);
  expect(isNotification({ jsonrpc: "2.0", method: "m" })).toBe(true);
  expect(isRequest({ jsonrpc: "2.0", method: "m" })).toBe(false);
  expect(resultResponse(1, { ok: true })).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  expect(errorResponse(null, PARSE_ERROR, "bad")).toEqual({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "bad" } });
});
