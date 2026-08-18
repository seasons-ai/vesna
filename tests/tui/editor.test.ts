import { test, expect } from "bun:test";
import { applyKey, createEditor, type EditorState } from "../../src/tui/editor";
import type { Key } from "../../src/tui/keys";

function type(state: EditorState, ...events: Key[]): EditorState {
  let current = state;
  for (const event of events) current = applyKey(current, event).state;
  return current;
}

const text = (t: string): Key => ({ type: "text", text: t });

test("typing inserts at the cursor and moves it along", () => {
  const state = type(createEditor(), text("hi"));
  expect(state.text).toBe("hi");
  expect(state.cursor).toBe(2);
});

test("typing in the middle inserts rather than overwrites", () => {
  let state = type(createEditor(), text("ac"), { type: "left" });
  state = type(state, text("b"));
  expect(state.text).toBe("abc");
  expect(state.cursor).toBe(2);
});

test("backspace at the start of the text is a no-op, not a crash", () => {
  const state = type(createEditor(), { type: "backspace" });
  expect(state.text).toBe("");
  expect(state.cursor).toBe(0);
});

test("forward delete removes the character under the cursor", () => {
  const state = type(createEditor(), text("abc"), { type: "home" }, { type: "delete" });
  expect(state.text).toBe("bc");
  expect(state.cursor).toBe(0);
});

test("home and end go to the ends of the current line, not the whole text", () => {
  let state = type(createEditor(), text("one"), { type: "newline" }, text("two"));
  state = type(state, { type: "home" });
  expect(state.cursor).toBe(4);
  state = type(state, { type: "end" });
  expect(state.cursor).toBe(7);
});

test("word motions stop at word boundaries", () => {
  let state = type(createEditor(), text("read the file"));
  state = type(state, { type: "word-left" });
  expect(state.text.slice(state.cursor)).toBe("file");
  state = type(state, { type: "word-left" });
  expect(state.text.slice(state.cursor)).toBe("the file");
  state = type(state, { type: "word-right" });
  expect(state.text.slice(state.cursor)).toBe(" file");
});

test("ctrl-w deletes the word behind the cursor", () => {
  const state = type(createEditor(), text("read the file"), { type: "kill-word" });
  expect(state.text).toBe("read the ");
});

test("ctrl-u clears back to the start of the line only", () => {
  let state = type(createEditor(), text("one"), { type: "newline" }, text("two"));
  state = type(state, { type: "kill-line" });
  expect(state.text).toBe("one\n");
});

test("ctrl-k clears to the end of the line", () => {
  let state = type(createEditor(), text("hello world"), { type: "home" });
  state = type(state, { type: "word-right" }, { type: "kill-to-end" });
  expect(state.text).toBe("hello");
});

test("enter submits the text and leaves an empty box behind", () => {
  const result = applyKey(type(createEditor(), text("go")), { type: "enter" });
  expect(result.submit).toBe("go");
  expect(result.state.text).toBe("");
  expect(result.state.cursor).toBe(0);
});

test("enter on a blank box submits nothing rather than an empty turn", () => {
  const result = applyKey(type(createEditor(), text("   ")), { type: "enter" });
  expect(result.submit).toBeUndefined();
});

test("alt-enter adds a line instead of sending", () => {
  const result = applyKey(type(createEditor(), text("one")), { type: "newline" });
  expect(result.submit).toBeUndefined();
  expect(result.state.text).toBe("one\n");
});

test("a pasted block keeps its newlines and does not send", () => {
  const result = applyKey(createEditor(), { type: "paste", text: "a\nb" });
  expect(result.submit).toBeUndefined();
  expect(result.state.text).toBe("a\nb");
});

test("a submitted line enters the history", () => {
  const first = applyKey(type(createEditor(), text("one")), { type: "enter" });
  expect(first.state.history).toEqual(["one"]);
});

test("the same line twice in a row is stored once", () => {
  let state = applyKey(type(createEditor(), text("one")), { type: "enter" }).state;
  state = applyKey(type(state, text("one")), { type: "enter" }).state;
  expect(state.history).toEqual(["one"]);
});

test("up recalls the previous line and down comes back to the draft", () => {
  let state = applyKey(type(createEditor(), text("first")), { type: "enter" }).state;
  state = type(state, text("half"));
  state = type(state, { type: "up" });
  expect(state.text).toBe("first");
  state = type(state, { type: "down" });
  expect(state.text).toBe("half");
});

test("up walks further back through the history and stops at the oldest", () => {
  let state = createEditor();
  for (const line of ["one", "two"]) {
    state = applyKey(type(state, text(line)), { type: "enter" }).state;
  }
  state = type(state, { type: "up" });
  expect(state.text).toBe("two");
  state = type(state, { type: "up" });
  expect(state.text).toBe("one");
  state = type(state, { type: "up" });
  expect(state.text).toBe("one");
});

test("in a multi-line message the arrows move between lines, not through history", () => {
  let state = applyKey(type(createEditor(), text("old")), { type: "enter" }).state;
  state = type(state, text("one"), { type: "newline" }, text("two"));
  state = type(state, { type: "up" });
  expect(state.text).toBe("one\ntwo");
  expect(state.cursor).toBe(3); // same column, clamped to the shorter line
});

test("moving down from the last line of a multi-line message keeps the text", () => {
  let state = type(createEditor(), text("one"), { type: "newline" }, text("two"));
  state = type(state, { type: "down" });
  expect(state.text).toBe("one\ntwo");
});

test("a recalled line can be edited without rewriting the history", () => {
  let state = applyKey(type(createEditor(), text("first")), { type: "enter" }).state;
  state = type(state, { type: "up" }, text("!"));
  expect(state.text).toBe("first!");
  expect(state.history).toEqual(["first"]);
});
