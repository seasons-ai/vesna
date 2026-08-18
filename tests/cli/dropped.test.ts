import { test, expect } from "bun:test";
import { describeDropped } from "../../src/cli/dropped";
import { resolveTheme } from "../../src/tui/theme";

const theme = resolveTheme("vesna", { color: false });

test("nothing dropped prints nothing at all", () => {
  expect(describeDropped([], theme)).toEqual([]);
});

test("a dropped step names its type and the input it ran with", () => {
  const lines = describeDropped([{ nodeType: "read", input: { path: "a.txt" } }], theme).join("\n");
  expect(lines).toContain("read");
  expect(lines).toContain("path=a.txt");
  expect(lines).toContain("1 step left out");
});

test("the plural reads correctly for more than one", () => {
  const lines = describeDropped(
    [
      { nodeType: "read", input: { path: "a" } },
      { nodeType: "glob", input: { pattern: "*" } },
    ],
    theme,
  ).join("\n");
  expect(lines).toContain("2 steps left out");
});

test("a long value is truncated so one step cannot flood the terminal", () => {
  const lines = describeDropped([{ nodeType: "write", input: { text: "x".repeat(500) } }], theme);
  for (const line of lines) expect(line.length).toBeLessThan(120);
});
