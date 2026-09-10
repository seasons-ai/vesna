import { test, expect } from "bun:test";
import { emptyState } from "../../src/tui/emptystate";
import { UNICODE_GLYPHS, ASCII_GLYPHS } from "../../src/tui/glyphs";
import { resolveTheme } from "../../src/tui/theme";
import { visibleWidth } from "../../src/tui/wrap";

const theme = resolveTheme("mono", { depth: 0 });
const at = (cols: number, rows: number) =>
  emptyState({ theme, glyphs: UNICODE_GLYPHS, cols, rows });

test("the mark and the wordmark are always there", () => {
  const text = at(70, 12).join("\n");
  expect(text).toContain("❀");
  expect(text).toContain("v e s n a");
});

test("a roomy window gets the three examples", () => {
  const text = at(70, 12).join("\n");
  expect(text).toContain("ask for something");
  expect(text).toContain("freeze what worked");
  expect(text).toContain("run it forever");
});

test("a narrow window drops the examples and keeps the mark", () => {
  const text = at(40, 12).join("\n");
  expect(text).toContain("v e s n a");
  expect(text).not.toContain("freeze what worked");
});

test("a short window drops the examples too", () => {
  const text = at(70, 6).join("\n");
  expect(text).not.toContain("freeze what worked");
});

test("nothing ever overflows the width it was given", () => {
  for (const cols of [6, 10, 20, 30, 40, 55, 70, 120]) {
    for (const line of at(cols, 14)) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
  }
});

test("it never asks for more rows than it was given", () => {
  for (const rows of [3, 6, 9, 14, 40]) expect(at(70, rows).length).toBeLessThanOrEqual(rows);
});

test("the composition is centred, not flush left", () => {
  const mark = at(70, 12).find((line) => line.includes("❀"))!;
  const indent = mark.length - mark.trimStart().length;
  expect(indent).toBeGreaterThan(10);
});

test("the example rows line up as one block, not each centred on its own", () => {
  const lines = at(84, 14);
  const labels = ["ask for something", "freeze what worked", "run it forever"];
  const indents = labels.map((label) => {
    const line = lines.find((candidate) => candidate.includes(label))!;
    return line.length - line.trimStart().length;
  });
  expect(indents[1]).toBe(indents[0]);
  expect(indents[2]).toBe(indents[0]);
});

test("ASCII mode uses the ASCII mark and stays ascii throughout", () => {
  const lines = emptyState({ theme, glyphs: ASCII_GLYPHS, cols: 70, rows: 12 });
  expect(lines.join("\n")).toMatch(/^[\x00-\x7f]*$/);
  expect(lines.join("\n")).toContain("*");
});

test("the empty screen names the two columns, which are otherwise undiscoverable", () => {
  const text = at(90, 16).join("\n");
  expect(text).toContain("/spec");
  expect(text).toContain("ctrl-b");
});

test("those hints go when the window is too small for the examples anyway", () => {
  expect(at(40, 16).join("\n")).not.toContain("ctrl-b");
});
