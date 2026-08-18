import { test, expect } from "bun:test";
import { createTranscript } from "../../src/tui/transcript";
import { resolveTheme } from "../../src/tui/theme";

const theme = resolveTheme("mono", { color: false });

test("a fresh transcript is empty", () => {
  expect(createTranscript(theme).lines()).toEqual([]);
});

test("a user message is marked so it is distinguishable from the answer", () => {
  const transcript = createTranscript(theme);
  transcript.user("read a.txt");
  expect(transcript.lines()).toEqual(["› read a.txt", ""]);
});

test("a multi-line user message keeps its shape", () => {
  const transcript = createTranscript(theme);
  transcript.user("one\ntwo");
  expect(transcript.lines()).toEqual(["› one", "  two", ""]);
});

test("streamed deltas join into a paragraph rather than one line per token", () => {
  const transcript = createTranscript(theme);
  for (const delta of ["Read", "ing ", "the ", "file."]) transcript.delta(delta);
  expect(transcript.lines()).toEqual(["Reading the file."]);
});

test("a newline inside the stream starts a new line", () => {
  const transcript = createTranscript(theme);
  transcript.delta("one\ntw");
  transcript.delta("o");
  expect(transcript.lines()).toEqual(["one", "two"]);
});

test("a tool step is its own line, not part of the answer", () => {
  const transcript = createTranscript(theme);
  transcript.delta("Reading.");
  transcript.step("read", 12);
  expect(transcript.lines()).toEqual(["Reading.", "  · read 12ms"]);
});

test("a step carries a detail when there is one worth showing", () => {
  const transcript = createTranscript(theme);
  transcript.step("read", 12, "a.txt");
  expect(transcript.lines()).toEqual(["  · read 12ms  a.txt"]);
});

test("text streamed after a step starts a fresh line rather than joining it", () => {
  const transcript = createTranscript(theme);
  transcript.step("read", 1);
  transcript.delta("Done.");
  expect(transcript.lines()).toEqual(["  · read 1ms", "Done."]);
});

test("ending a turn leaves one blank line before the next", () => {
  const transcript = createTranscript(theme);
  transcript.delta("Done.");
  transcript.endTurn();
  transcript.user("again");
  expect(transcript.lines()).toEqual(["Done.", "", "› again", ""]);
});

test("ending an empty turn does not stack blank lines", () => {
  const transcript = createTranscript(theme);
  transcript.endTurn();
  transcript.endTurn();
  expect(transcript.lines()).toEqual([]);
});

test("a notice is recorded so an error is part of the conversation, not a flash", () => {
  const transcript = createTranscript(theme);
  transcript.notice("interrupted", "held");
  expect(transcript.lines()).toEqual(["  interrupted"]);
});

test("clearing drops everything", () => {
  const transcript = createTranscript(theme);
  transcript.user("x");
  transcript.clear();
  expect(transcript.lines()).toEqual([]);
});
