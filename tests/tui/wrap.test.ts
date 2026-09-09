import { test, expect } from "bun:test";
import { visibleWidth, wrapAnsi } from "../../src/tui/wrap";

const RED = "\x1b[38;5;203m";
const RESET = "\x1b[0m";
const FG_RESET = "\x1b[39m";

test("width ignores escape codes, so colour never shifts the layout", () => {
  expect(visibleWidth(`${RED}abc${RESET}`)).toBe(3);
});

test("a wide glyph counts as two columns", () => {
  expect(visibleWidth("漢字")).toBe(4);
});

test("a combining mark adds no width of its own", () => {
  expect(visibleWidth("é")).toBe(1);
});

test("short text is returned as a single line", () => {
  expect(wrapAnsi("hello", 20)).toEqual(["hello"]);
});

test("wrapping breaks at spaces rather than mid-word", () => {
  expect(wrapAnsi("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
});

test("a word longer than the width is broken rather than overflowing", () => {
  expect(wrapAnsi("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
});

test("existing newlines are honoured as breaks", () => {
  expect(wrapAnsi("one\ntwo", 20)).toEqual(["one", "two"]);
});

test("an empty line survives wrapping, so paragraph spacing is kept", () => {
  expect(wrapAnsi("a\n\nb", 20)).toEqual(["a", "", "b"]);
});

test("colour is reopened on the next line so a wrap cannot lose it", () => {
  const lines = wrapAnsi(`${RED}alpha beta${FG_RESET}`, 6);
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(line.startsWith(RED)).toBe(true);
    // The foreground closes on its own; a full reset here would kill any
    // background the line is drawn on.
    expect(line.endsWith(FG_RESET)).toBe(true);
    expect(line).not.toContain(RESET);
  }
  expect(lines.map(visibleWidth)).toEqual([5, 4]);
});

test("no wrapped line is wider than the limit", () => {
  const text = "Vesna crystallises a live run into a deterministic flow with assertions.";
  for (const line of wrapAnsi(text, 17)) expect(visibleWidth(line)).toBeLessThanOrEqual(17);
});

test("a width of zero or less yields the text unwrapped rather than looping forever", () => {
  expect(wrapAnsi("abc", 0)).toEqual(["abc"]);
});

test("trailing spaces at a break are dropped, not carried to the next line", () => {
  expect(wrapAnsi("aaa   bbb", 5)).toEqual(["aaa", "bbb"]);
});
