import { test, expect } from "bun:test";
import { chatsPane } from "../../src/tui/panes";
import { UNICODE_GLYPHS } from "../../src/tui/glyphs";
import { resolveTheme } from "../../src/tui/theme";
import { visibleWidth } from "../../src/tui/wrap";
import type { SessionSummary } from "../../src/store/sessions";

const options = { theme: resolveTheme("mono", { depth: 0 }), glyphs: UNICODE_GLYPHS, width: 26, rows: 10 };

const session = (id: string, title: string): SessionSummary => ({
  id,
  title,
  cwd: "/work/api",
  model: "m",
  startedAt: "2026-09-10T10:00:00Z",
  updatedAt: "2026-09-10T10:00:00Z",
  messages: 3,
  costUsd: 0,
});

test("the pane is exactly as tall as it was given, whatever it holds", () => {
  for (const rows of [3, 10, 30]) {
    const pane = chatsPane([session("a", "one")], undefined, "/work/api", { ...options, rows });
    expect(pane.lines).toHaveLength(rows);
    expect(pane.targets).toHaveLength(rows);
  }
});

test("nothing in the pane is wider than the column", () => {
  const long = session("a", "a title far longer than the column can possibly hold");
  const pane = chatsPane([long], undefined, "/very/deep/path/to/a/project", options);
  for (const line of pane.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(26);
});

test("it says which folder these belong to", () => {
  const pane = chatsPane([], undefined, "/work/api", options);
  expect(pane.lines.join("\n")).toContain("api");
});

test("an empty folder says so rather than showing a blank column", () => {
  expect(chatsPane([], undefined, "/work/api", options).lines.join("\n")).toMatch(/no conversations/);
});

test("each conversation can be clicked, and carries its own id", () => {
  const pane = chatsPane([session("a", "one"), session("b", "two")], undefined, "/w", options);
  const ids = pane.targets!.filter((id) => id !== undefined);
  expect(ids).toEqual(["session:a", "session:b"]);
});

test("the conversation you are in is shown but not offered", () => {
  const pane = chatsPane([session("a", "one"), session("b", "two")], "a", "/w", options);
  expect(pane.lines.join("\n")).toContain("one");
  expect(pane.targets!.filter((id) => id !== undefined)).toEqual(["session:b"]);
});

test("the one you are in is marked, so the panel does not look lost", () => {
  const pane = chatsPane([session("a", "one")], "a", "/w", options);
  const row = pane.lines.find((line) => line.includes("one"))!;
  expect(row.startsWith(UNICODE_GLYPHS.bullet)).toBe(true);
});

test("a conversation with no title is named rather than left blank", () => {
  expect(chatsPane([session("a", "")], undefined, "/w", options).lines.join("\n")).toContain(
    "untitled",
  );
});

test("more conversations than rows are cut, not spilled", () => {
  const many = Array.from({ length: 40 }, (_, i) => session(`s${i}`, `chat ${i}`));
  const pane = chatsPane(many, undefined, "/w", { ...options, rows: 6 });
  expect(pane.lines).toHaveLength(6);
});
