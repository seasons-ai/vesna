import { test, expect } from "bun:test";
import { decodeKeys, type Key } from "../../src/tui/keys";

const ESC = "\x1b";
function keys(input: string): Key[] {
  return decodeKeys(input).keys;
}

test("printable characters coalesce into one text key, not one per byte", () => {
  expect(keys("hello")).toEqual([{ type: "text", text: "hello" }]);
});

test("enter is enter whether the terminal sends CR or LF", () => {
  expect(keys("\r")).toEqual([{ type: "enter" }]);
  expect(keys("\n")).toEqual([{ type: "enter" }]);
});

test("text around a control character keeps its order", () => {
  expect(keys("ab\rcd")).toEqual([
    { type: "text", text: "ab" },
    { type: "enter" },
    { type: "text", text: "cd" },
  ]);
});

test("backspace arrives as DEL on most terminals and as BS on some", () => {
  expect(keys("\x7f")).toEqual([{ type: "backspace" }]);
  expect(keys("\x08")).toEqual([{ type: "backspace" }]);
});

test("ctrl-c is an interrupt, distinct from anything typed", () => {
  expect(keys("\x03")).toEqual([{ type: "interrupt" }]);
});

test("ctrl-d is end of input", () => {
  expect(keys("\x04")).toEqual([{ type: "eof" }]);
});

test("the arrow keys decode from their CSI sequences", () => {
  expect(keys(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`)).toEqual([
    { type: "up" },
    { type: "down" },
    { type: "right" },
    { type: "left" },
  ]);
});

test("ctrl and alt with an arrow move by word", () => {
  expect(keys(`${ESC}[1;5D`)).toEqual([{ type: "word-left" }]);
  expect(keys(`${ESC}[1;5C`)).toEqual([{ type: "word-right" }]);
  expect(keys(`${ESC}[1;3D`)).toEqual([{ type: "word-left" }]);
  expect(keys(`${ESC}b`)).toEqual([{ type: "word-left" }]);
  expect(keys(`${ESC}f`)).toEqual([{ type: "word-right" }]);
});

test("home and end decode from both of their common spellings", () => {
  expect(keys(`${ESC}[H`)).toEqual([{ type: "home" }]);
  expect(keys(`${ESC}[F`)).toEqual([{ type: "end" }]);
  expect(keys(`${ESC}[1~`)).toEqual([{ type: "home" }]);
  expect(keys(`${ESC}[4~`)).toEqual([{ type: "end" }]);
  expect(keys("\x01")).toEqual([{ type: "home" }]);
  expect(keys("\x05")).toEqual([{ type: "end" }]);
});

test("the delete key is forward delete, not backspace", () => {
  expect(keys(`${ESC}[3~`)).toEqual([{ type: "delete" }]);
});

test("the readline kill keys are recognised", () => {
  expect(keys("\x15")).toEqual([{ type: "kill-line" }]);
  expect(keys("\x17")).toEqual([{ type: "kill-word" }]);
  expect(keys("\x0b")).toEqual([{ type: "kill-to-end" }]);
});

test("alt-enter is a newline inside the message, not a send", () => {
  expect(keys(`${ESC}\r`)).toEqual([{ type: "newline" }]);
});

test("a bare escape is escape, not the start of a lost sequence", () => {
  expect(keys(ESC).keys ?? keys(ESC)).toBeDefined();
  const { keys: decoded, rest } = decodeKeys(ESC);
  // Held back: it may still turn into a sequence when the next byte arrives.
  expect(decoded).toEqual([]);
  expect(rest).toBe(ESC);
});

test("a sequence split across two reads survives the join", () => {
  const first = decodeKeys(`ab${ESC}[`);
  expect(first.keys).toEqual([{ type: "text", text: "ab" }]);
  expect(decodeKeys(first.rest + "A").keys).toEqual([{ type: "up" }]);
});

test("a pasted block is one key, so multi-line paste does not send N messages", () => {
  const pasted = `${ESC}[200~line one\nline two${ESC}[201~`;
  expect(keys(pasted)).toEqual([{ type: "paste", text: "line one\nline two" }]);
});

test("an unfinished paste is held back rather than sent a line at a time", () => {
  const { keys: decoded, rest } = decodeKeys(`${ESC}[200~half`);
  expect(decoded).toEqual([]);
  expect(rest).toBe(`${ESC}[200~half`);
});

test("text typed after a paste still arrives", () => {
  expect(keys(`${ESC}[200~x${ESC}[201~y`)).toEqual([
    { type: "paste", text: "x" },
    { type: "text", text: "y" },
  ]);
});

test("an unrecognised escape sequence is dropped, never typed into the box", () => {
  expect(keys(`${ESC}[99;99R`)).toEqual([]);
});

test("tab is its own key so completion can use it later", () => {
  expect(keys("\t")).toEqual([{ type: "tab" }]);
});

test("non-ascii text passes through intact", () => {
  expect(keys("привет")).toEqual([{ type: "text", text: "привет" }]);
});

test("page up and page down scroll the conversation", () => {
  expect(keys(`${ESC}[5~`)).toEqual([{ type: "page-up" }]);
  expect(keys(`${ESC}[6~`)).toEqual([{ type: "page-down" }]);
});

test("shift with a vertical arrow scrolls rather than browsing history", () => {
  expect(keys(`${ESC}[1;2A`)).toEqual([{ type: "page-up" }]);
  expect(keys(`${ESC}[1;2B`)).toEqual([{ type: "page-down" }]);
});

test("the wheel is decoded from an SGR mouse report", () => {
  expect(keys(`${ESC}[<64;10;5M`)).toEqual([{ type: "wheel-up" }]);
  expect(keys(`${ESC}[<65;10;5M`)).toEqual([{ type: "wheel-down" }]);
});

test("a left click reports where it landed, in zero-based rows and columns", () => {
  // The terminal counts from 1; the frame counts from 0.
  expect(keys(`${ESC}[<0;12;7M`)).toEqual([{ type: "click", column: 11, row: 6 }]);
});

test("the button release is swallowed, so one click is one event", () => {
  expect(keys(`${ESC}[<0;12;7m`)).toEqual([]);
});

test("a drag or a move is ignored rather than mistaken for a click", () => {
  expect(keys(`${ESC}[<32;12;7M`)).toEqual([]);
  expect(keys(`${ESC}[<35;12;7M`)).toEqual([]);
});

test("a right or middle click is ignored — only the left button acts", () => {
  expect(keys(`${ESC}[<1;5;5M`)).toEqual([]);
  expect(keys(`${ESC}[<2;5;5M`)).toEqual([]);
});

test("a mouse report split across two reads survives the join", () => {
  const first = decodeKeys(`${ESC}[<64;10`);
  expect(first.keys).toEqual([]);
  expect(decodeKeys(`${first.rest};5M`).keys).toEqual([{ type: "wheel-up" }]);
});

test("typing after a wheel event still arrives", () => {
  expect(keys(`${ESC}[<64;1;1Mhi`)).toEqual([{ type: "wheel-up" }, { type: "text", text: "hi" }]);
});

test("wheel with a modifier held still scrolls rather than being dropped", () => {
  expect(keys(`${ESC}[<80;10;5M`)).toEqual([{ type: "wheel-up" }]);
});

test("ctrl-b asks for the conversations column", () => {
  expect(keys("\x02")).toEqual([{ type: "panel-left" }]);
});

test("ctrl-h is still backspace, because on most terminals that is what it is", () => {
  expect(keys("\x08")).toEqual([{ type: "backspace" }]);
});
