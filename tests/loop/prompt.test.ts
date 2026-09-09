import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectNotes, systemPrompt } from "../../src/loop/prompt";
import type { ToolSpec } from "../../src/providers/types";

const tool = (name: string, description: string): ToolSpec => ({
  name,
  description,
  input_schema: { type: "object" },
});

const context = (over: Partial<Parameters<typeof systemPrompt>[0]> = {}) => ({
  cwd: "/work/proj",
  platform: "darwin",
  now: new Date("2026-09-09T12:00:00Z"),
  tools: [tool("read", "Read a file"), tool("write", "Write a file")],
  ...over,
});

test("it says where it is, because the model otherwise has no idea", () => {
  expect(systemPrompt(context())).toContain("/work/proj");
});

test("it dates itself, so the model does not assume its training cutoff", () => {
  expect(systemPrompt(context())).toContain("2026-09-09");
});

test("every tool it was given is named", () => {
  const text = systemPrompt(context());
  expect(text).toContain("read");
  expect(text).toContain("write");
  expect(text).toContain("Read a file");
});

test("a tool it was NOT given is never mentioned — the prompt cannot over-promise", () => {
  const text = systemPrompt(context());
  expect(text).not.toContain("shell");
  expect(text).not.toContain("grep");
});

test("with no tools at all it says so plainly instead of listing nothing", () => {
  const text = systemPrompt(context({ tools: [] }));
  expect(text).toMatch(/no tools/i);
});

test("it forbids the exact lie that prompted this: denying it can see the machine", () => {
  const text = systemPrompt(context()).toLowerCase();
  expect(text).toContain("never");
  expect(text).toMatch(/cannot see|can't see|no access/);
});

test("project notes are appended under a heading of their own", () => {
  const text = systemPrompt(context({ notes: "Always run bun test before committing." }));
  expect(text).toContain("Always run bun test before committing.");
  expect(text).toMatch(/project/i);
});

test("without notes there is no empty heading left behind", () => {
  const text = systemPrompt(context());
  expect(text).not.toMatch(/# Project instructions/i);
});

test("the same context always produces the same prompt", () => {
  expect(systemPrompt(context())).toBe(systemPrompt(context()));
});

test("notes are passed through verbatim, not summarised or reformatted", () => {
  const notes = "Line one.\n\n  - indented bullet\n\nLine two.";
  expect(systemPrompt(context({ notes }))).toContain(notes);
});

test("a missing AGENTS.md is simply absent, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesna-notes-"));
  expect(await readProjectNotes(root)).toBeUndefined();
});

test("an AGENTS.md is read from the project folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesna-notes-"));
  await mkdir(join(root, ".vesna"), { recursive: true });
  await writeFile(join(root, ".vesna", "AGENTS.md"), "Prefer small commits.\n");
  expect(await readProjectNotes(root)).toBe("Prefer small commits.");
});

test("an empty AGENTS.md counts as no notes rather than an empty section", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesna-notes-"));
  await mkdir(join(root, ".vesna"), { recursive: true });
  await writeFile(join(root, ".vesna", "AGENTS.md"), "   \n\n");
  expect(await readProjectNotes(root)).toBeUndefined();
});
