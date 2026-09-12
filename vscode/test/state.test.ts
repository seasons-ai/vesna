import { test, expect } from "bun:test";
import { initialModel, reduce, detailOf, type PanelModel, type Event } from "../src/state";
import type { Ask, State } from "../src/protocol";

function makeState(busy: boolean): State {
  return {
    mode: "auto",
    busy,
    building: false,
    buildState: "idle",
    model: "gpt",
    service: "openai",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    spec: null,
    specSlug: null,
    chats: null,
    chatId: null,
    root: "/repo",
  };
}

function makeAsk(id: string): Ask {
  return { id, kind: "permission", lines: ["allow this?"], choices: ["y", "a", "n"], strict: false };
}

// ---------------------------------------------------------------------------
// Rule 1: reduce never mutates its input.

test("reduce never mutates its input model", () => {
  const events: Event[] = [
    { kind: "notification", n: { method: "transcript", params: { kind: "user", text: "hi" } } },
    { kind: "notification", n: { method: "transcript", params: { kind: "delta", text: "yo" } } },
    { kind: "notification", n: { method: "transcript", params: { kind: "step", step: { id: "1", nodeType: "read", input: { path: "a" }, output: "x", durationMs: 1 } } } },
    { kind: "notification", n: { method: "transcript", params: { kind: "notice", text: "ok", level: "ok" } } },
    { kind: "notification", n: { method: "transcript", params: { kind: "turn-end" } } },
    { kind: "notification", n: { method: "transcript", params: { kind: "clear" } } },
    { kind: "notification", n: { method: "ask", params: makeAsk("a1") } },
    { kind: "notification", n: { method: "ask.resolved", params: { id: "a1" } } },
    { kind: "notification", n: { method: "state", params: makeState(true) } },
    { kind: "server", status: { kind: "up" } },
    { kind: "sent" },
    { kind: "turnStarted" },
    { kind: "note", text: "hello" },
  ];
  for (const event of events) {
    const model = initialModel();
    const snapshot = JSON.parse(JSON.stringify(model));
    reduce(model, event);
    expect(model).toEqual(snapshot);
  }
});

// ---------------------------------------------------------------------------
// Entry ids: a stable counter on the model.

test("entry ids come from a counter on the model, stable across reductions", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "user", text: "one" } } });
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "user", text: "two" } } });
  expect(model.entries.map((e) => e.id)).toEqual([1, 2]);
  expect(model.nextId).toBe(3);
});

// ---------------------------------------------------------------------------
// transcript: user / delta / step / notice / turn-end / clear.

test("a user transcript entry is appended as-is", () => {
  const model = reduce(initialModel(), { kind: "notification", n: { method: "transcript", params: { kind: "user", text: "hi" } } });
  expect(model.entries).toEqual([{ id: 1, kind: "user", text: "hi" }]);
});

test("delta opens a new assistant message when none is open", () => {
  const model = reduce(initialModel(), { kind: "notification", n: { method: "transcript", params: { kind: "delta", text: "he" } } });
  expect(model.entries).toEqual([{ id: 1, kind: "assistant", text: "he", open: true }]);
});

test("delta appends to the last entry when it is an open assistant message", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "delta", text: "he" } } });
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "delta", text: "llo" } } });
  expect(model.entries).toEqual([{ id: 1, kind: "assistant", text: "hello", open: true }]);
});

test("a step entry carries its detail, computed the TUI's way", () => {
  const model = reduce(initialModel(), {
    kind: "notification",
    n: { method: "transcript", params: { kind: "step", step: { id: "s1", nodeType: "read", input: { path: "src/a.ts" }, output: "ok", durationMs: 12 } } },
  });
  expect(model.entries).toEqual([
    { id: 1, kind: "step", step: { id: "s1", nodeType: "read", input: { path: "src/a.ts" }, output: "ok", durationMs: 12 }, detail: "src/a.ts" },
  ]);
});

test("a notice entry keeps its text and level", () => {
  const model = reduce(initialModel(), { kind: "notification", n: { method: "transcript", params: { kind: "notice", text: "careful", level: "warn" } } });
  expect(model.entries).toEqual([{ id: 1, kind: "notice", text: "careful", level: "warn" }]);
});

test("turn-end closes the open assistant message", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "delta", text: "hi" } } });
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "turn-end" } } });
  expect(model.entries).toEqual([{ id: 1, kind: "assistant", text: "hi", open: false }]);
});

test("turn-end with nothing open is a no-op on entries", () => {
  const model = reduce(initialModel(), { kind: "notification", n: { method: "transcript", params: { kind: "turn-end" } } });
  expect(model.entries).toEqual([]);
});

test("delta after turn-end opens a new message, not the closed one", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "delta", text: "first" } } });
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "turn-end" } } });
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "delta", text: "second" } } });
  expect(model.entries).toEqual([
    { id: 1, kind: "assistant", text: "first", open: false },
    { id: 2, kind: "assistant", text: "second", open: true },
  ]);
});

test("clear empties entries only — an open ask stays until resolved", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "user", text: "hi" } } });
  model = reduce(model, { kind: "notification", n: { method: "ask", params: makeAsk("a1") } });
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "clear" } } });
  expect(model.entries).toEqual([]);
  expect(model.ask).toEqual(makeAsk("a1"));
});

// ---------------------------------------------------------------------------
// ask / ask.resolved.

test("ask sets the open ask", () => {
  const model = reduce(initialModel(), { kind: "notification", n: { method: "ask", params: makeAsk("a1") } });
  expect(model.ask).toEqual(makeAsk("a1"));
});

test("ask.resolved with a matching id clears the ask", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "ask", params: makeAsk("a1") } });
  model = reduce(model, { kind: "notification", n: { method: "ask.resolved", params: { id: "a1" } } });
  expect(model.ask).toBeNull();
});

test("ask.resolved for another id leaves the ask untouched", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "ask", params: makeAsk("a1") } });
  model = reduce(model, { kind: "notification", n: { method: "ask.resolved", params: { id: "somethingElse" } } });
  expect(model.ask).toEqual(makeAsk("a1"));
});

// ---------------------------------------------------------------------------
// state / queued.

test("a state notification replaces state", () => {
  const model = reduce(initialModel(), { kind: "notification", n: { method: "state", params: makeState(true) } });
  expect(model.state).toEqual(makeState(true));
});

test("sent increments queued only while state.busy is true", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "state", params: makeState(true) } });
  model = reduce(model, { kind: "sent" });
  model = reduce(model, { kind: "sent" });
  expect(model.queued).toBe(2);
});

test("sent leaves queued at 0 when nothing is busy — the turn starts at once", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "state", params: makeState(false) } });
  model = reduce(model, { kind: "sent" });
  expect(model.queued).toBe(0);
});

test("sent leaves queued alone when state is still unknown", () => {
  const model = reduce(initialModel(), { kind: "sent" });
  expect(model.queued).toBe(0);
});

test("a state notification with busy: false resets queued to 0", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "state", params: makeState(true) } });
  model = reduce(model, { kind: "sent" });
  model = reduce(model, { kind: "sent" });
  expect(model.queued).toBe(2);
  model = reduce(model, { kind: "notification", n: { method: "state", params: makeState(false) } });
  expect(model.queued).toBe(0);
});

// ---------------------------------------------------------------------------
// server.

test("server replaces server and, for notFound, keeps entries and state", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "user", text: "hi" } } });
  model = reduce(model, { kind: "notification", n: { method: "state", params: makeState(false) } });
  model = reduce(model, { kind: "server", status: { kind: "notFound", command: "vesna" } });
  expect(model.server).toEqual({ kind: "notFound", command: "vesna" });
  expect(model.entries).toEqual([{ id: 1, kind: "user", text: "hi" }]);
  expect(model.state).toEqual(makeState(false));
});

test("server replaces server and, for exited, keeps entries and state", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "user", text: "hi" } } });
  model = reduce(model, { kind: "server", status: { kind: "exited", code: 1, stderr: "boom" } });
  expect(model.server).toEqual({ kind: "exited", code: 1, stderr: "boom" });
  expect(model.entries).toEqual([{ id: 1, kind: "user", text: "hi" }]);
});

test("server replaces server and, for tooOld, keeps entries and state", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "user", text: "hi" } } });
  model = reduce(model, { kind: "server", status: { kind: "tooOld", server: "0.7.0", extension: "0.1.0" } });
  expect(model.server).toEqual({ kind: "tooOld", server: "0.7.0", extension: "0.1.0" });
  expect(model.entries).toEqual([{ id: 1, kind: "user", text: "hi" }]);
});

test("server replaces server and keeps everything for starting/up too", () => {
  let model = initialModel();
  model = reduce(model, { kind: "notification", n: { method: "transcript", params: { kind: "user", text: "hi" } } });
  model = reduce(model, { kind: "server", status: { kind: "up" } });
  expect(model.server).toEqual({ kind: "up" });
  expect(model.entries).toEqual([{ id: 1, kind: "user", text: "hi" }]);
});

// ---------------------------------------------------------------------------
// note.

test("note sets and clears the note", () => {
  let model = initialModel();
  model = reduce(model, { kind: "note", text: "several folders are open" });
  expect(model.note).toBe("several folders are open");
  model = reduce(model, { kind: "note", text: null });
  expect(model.note).toBeNull();
});

// ---------------------------------------------------------------------------
// detailOf — the TUI's rule, copied exactly.

test("detailOf picks the first of path/pattern/command/name/detail", () => {
  expect(detailOf({ path: "src/a.ts" })).toBe("src/a.ts");
  expect(detailOf({ pattern: "*.ts" })).toBe("*.ts");
  expect(detailOf({ command: "ls -la" })).toBe("ls -la");
  expect(detailOf({ name: "grep" })).toBe("grep");
  expect(detailOf({ detail: "fallback" })).toBe("fallback");
  expect(detailOf({ path: "", name: "grep" })).toBe("grep");
  expect(detailOf({})).toBeUndefined();
  expect(detailOf(null)).toBeUndefined();
  expect(detailOf("not an object")).toBeUndefined();
});

test("detailOf caps at 48 chars: 45 kept plus ...", () => {
  const long = "x".repeat(60);
  const result = detailOf({ path: long });
  expect(result).toBe(`${"x".repeat(45)}...`);
  expect(result?.length).toBe(48);
});

// ---------------------------------------------------------------------------
// The store: one model, every reduction announced.

test("the store reduces on dispatch and tells every subscriber, until unsubscribed", async () => {
  const { createStore } = await import("../src/state");
  const store = createStore();
  const seen: number[] = [];
  const off = store.subscribe((model) => seen.push(model.entries.length));
  store.dispatch({ kind: "notification", n: { method: "transcript", params: { kind: "user", text: "hi" } } });
  store.dispatch({ kind: "server", status: { kind: "up" } });
  expect(store.model.entries).toHaveLength(1);
  expect(store.model.server).toEqual({ kind: "up" });
  expect(seen).toEqual([1, 1]);
  off();
  store.dispatch({ kind: "note", text: "x" });
  expect(seen).toEqual([1, 1]);
  expect(store.model.note).toBe("x");
});
