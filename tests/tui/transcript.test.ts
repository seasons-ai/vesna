import { test, expect } from "bun:test";
import { createTranscript } from "../../src/tui/transcript";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../../src/tui/glyphs";
import { resolveTheme } from "../../src/tui/theme";
import { fg24 } from "../../src/tui/color";
import { PALETTES } from "../../src/tui/palette";

const theme = resolveTheme("mono", { depth: 0 });

test("a fresh transcript is empty", () => {
  expect(createTranscript(theme, UNICODE_GLYPHS).lines(80)).toEqual([]);
});

test("a user message is marked so it is distinguishable from the answer", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.user("read a.txt");
  // The line after a message is its copy button, not a bare gap.
  expect(transcript.lines(80)).toEqual(["› read a.txt", "  ⧉ copy"]);
});

test("a multi-line user message keeps its shape", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.user("one\ntwo");
  expect(transcript.lines(80)).toEqual(["› one", "  two", "  ⧉ copy"]);
});

test("streamed deltas join into a paragraph rather than one line per token", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  for (const delta of ["Read", "ing ", "the ", "file."]) transcript.delta(delta);
  expect(transcript.lines(80)).toEqual(["Reading the file."]);
});

test("a newline inside the stream starts a new line", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.delta("one\ntw");
  transcript.delta("o");
  expect(transcript.lines(80)).toEqual(["one", "two"]);
});

test("a tool step is its own line, not part of the answer", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.delta("Reading.");
  transcript.step("read", 12);
  expect(transcript.lines(80)).toEqual(["Reading.", "  · read 12ms"]);
});

test("a step carries a detail when there is one worth showing", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.step("read", 12, "a.txt");
  expect(transcript.lines(80)).toEqual(["  · read 12ms  a.txt"]);
});

test("text streamed after a step starts a fresh line rather than joining it", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.step("read", 1);
  transcript.delta("Done.");
  expect(transcript.lines(80)).toEqual(["  · read 1ms", "Done."]);
});

test("ending a turn leaves one blank line before the next", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.delta("Done.");
  transcript.endTurn();
  transcript.user("again");
  expect(transcript.lines(80)).toEqual(["Done.", "  ⧉ copy", "› again", "  ⧉ copy"]);
});

test("ending an empty turn does not stack blank lines", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.endTurn();
  transcript.endTurn();
  expect(transcript.lines(80)).toEqual([]);
});

test("a notice is recorded so an error is part of the conversation, not a flash", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.notice("interrupted", "warn");
  expect(transcript.lines(80)).toEqual(["  interrupted"]);
});

test("clearing drops everything", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.user("x");
  transcript.clear();
  expect(transcript.lines(80)).toEqual([]);
});

test("the user's own words and the streamed answer are painted, not left bare", () => {
  // Vesna owns the canvas, so text that establishes no foreground of its own
  // falls back to whatever the user's terminal profile happens to use — which
  // on a light profile is near-black on the dark `vesna` background.
  const painted = resolveTheme("vesna", { depth: 24 });
  const text = fg24(PALETTES.vesna!.tokens.text);
  const transcript = createTranscript(painted, UNICODE_GLYPHS);

  transcript.user("what does this do?");
  expect(transcript.lines(80)[0]).toContain(text);

  transcript.delta("It reads the file.");
  expect(transcript.lines(80).at(-1)).toContain(text);
});

test("an answer is markdown: the hashes are markup, not text to display", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.delta("## Findings\n\n- one\n- two");
  const out = transcript.lines(60).join("\n");
  expect(out).toContain("Findings");
  expect(out).not.toContain("##");
  expect(out).toContain("one");
});

test("a fenced block inside an answer keeps its own spacing", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.delta("here:\n\n```yaml\nnodes:\n  - read\n```");
  const out = transcript.lines(60).join("\n");
  expect(out).toContain("  - read");
  expect(out).not.toContain("```");
});

test("a half-arrived answer renders as far as it has got", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.delta("## Head");
  expect(transcript.lines(60).join("\n")).toContain("Head");
  transcript.delta("ing\n\nbody");
  const out = transcript.lines(60).join("\n");
  expect(out).toContain("Heading");
  expect(out).toContain("body");
});

test("a user message is never treated as markdown — it is quoted back verbatim", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.user("what does ## mean in bash?");
  expect(transcript.lines(60).join("\n")).toContain("## mean in bash?");
});

test("the answer is rewrapped when the window changes width", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.delta("word ".repeat(30));
  expect(transcript.lines(80).length).toBeLessThan(transcript.lines(24).length);
});

test("a step between two answers does not merge them into one block", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.delta("# First");
  transcript.step("read", 1);
  transcript.delta("# Second");
  const out = transcript.lines(60).join("\n");
  expect(out).toContain("First");
  expect(out).toContain("Second");
  expect(out).not.toContain("#");
});

test("a message can be copied back out exactly as it arrived", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.user("read a.txt");
  transcript.delta("## Done\n\n- read it");
  transcript.endTurn();

  const ids = transcript.copyTargets(60).filter((id): id is string => id !== undefined);
  expect(ids).toHaveLength(2);
  expect(transcript.rawOf(ids[0]!)).toBe("read a.txt");
  // The markdown the model sent, not the version rendered for the screen.
  expect(transcript.rawOf(ids[1]!)).toBe("## Done\n\n- read it");
});

test("the copy button rides the blank line that already followed the message", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.user("hi");
  const lines = transcript.lines(60);
  const targets = transcript.copyTargets(60);

  expect(targets).toHaveLength(lines.length);
  const at = targets.findIndex((id) => id !== undefined);
  expect(at).toBeGreaterThan(0);
  expect(lines[at]).toContain("copy");
});

test("a step or a notice is not a message, and offers no copy button", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.step("read", 3);
  transcript.notice("interrupted", "warn");
  expect(transcript.copyTargets(60).every((id) => id === undefined)).toBe(true);
});

test("an unknown id yields nothing rather than throwing at a click", () => {
  expect(createTranscript(theme, UNICODE_GLYPHS).rawOf("nope")).toBeUndefined();
});

test("clearing forgets what could be copied", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.user("hi");
  const id = transcript.copyTargets(60).find((entry) => entry !== undefined)!;
  transcript.clear();
  expect(transcript.rawOf(id)).toBeUndefined();
});

test("the newest answer is findable without a mouse", () => {
  const transcript = createTranscript(theme, UNICODE_GLYPHS);
  transcript.delta("first");
  transcript.endTurn();
  transcript.delta("second");
  expect(transcript.lastAnswer()).toBe("second");
});

test("with no answer yet there is nothing to copy", () => {
  expect(createTranscript(theme, UNICODE_GLYPHS).lastAnswer()).toBeUndefined();
});

test("switching the theme repaints history, not just what comes next", () => {
  const dark = resolveTheme("vesna", { depth: 24 });
  const light = resolveTheme("washi", { depth: 24 });

  const transcript = createTranscript(dark, UNICODE_GLYPHS);
  transcript.user("hello");
  transcript.step("read", 3, "a.txt");
  transcript.notice("careful", "warn");
  transcript.delta("an answer");

  const before = transcript.lines(60).join("\n");
  expect(before).toContain("\x1b[38;2;");

  transcript.setTheme(light, UNICODE_GLYPHS);
  const after = transcript.lines(60).join("\n");

  // Same words, none of the old colours left anywhere.
  for (const word of ["hello", "read", "careful", "an answer"]) {
    expect(after).toContain(word);
  }
  const darkCodes = before.match(/\x1b\[38;2;[0-9;]+m/g) ?? [];
  for (const code of new Set(darkCodes)) expect(after).not.toContain(code);
});

test("the glyphs change with the theme, so ASCII mode can be entered live", () => {
  const theme24 = resolveTheme("vesna", { depth: 24 });
  const transcript = createTranscript(theme24, UNICODE_GLYPHS);
  transcript.user("hi");
  expect(transcript.lines(60).join("\n")).toContain("›");

  transcript.setTheme(theme24, ASCII_GLYPHS);
  const after = transcript.lines(60).join("\n");
  expect(after).toContain(">");
  expect(after).not.toContain("›");
});

test("what can be copied is unaffected by how it is painted", () => {
  const transcript = createTranscript(resolveTheme("vesna", { depth: 24 }), UNICODE_GLYPHS);
  transcript.user("exact words");
  const id = transcript.copyTargets(60).find((entry) => entry !== undefined)!;
  transcript.setTheme(resolveTheme("mono", { depth: 0 }), ASCII_GLYPHS);
  expect(transcript.rawOf(id)).toBe("exact words");
});
