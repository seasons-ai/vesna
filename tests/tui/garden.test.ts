import { test, expect } from "bun:test";
import { gardenPane } from "../../src/tui/panes";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../../src/tui/glyphs";
import { resolveTheme } from "../../src/tui/theme";
import { visibleWidth } from "../../src/tui/wrap";
import { project, type SpecEvent } from "../../src/spec/project";

const options = {
  theme: resolveTheme("mono", { depth: 0 }),
  glyphs: UNICODE_GLYPHS,
  width: 30,
  rows: 20,
};
const born: SpecEvent[] = [{ t: "created", id: "abort", title: "Reliable cancellation" }];
const pane = (events: SpecEvent[], over = {}) =>
  gardenPane(project([...born, ...events])!, { ...options, ...over });
const text = (events: SpecEvent[], over = {}) => pane(events, over).lines.join("\n");

test("the title and the count of finished work are at the top", () => {
  const out = text([
    { t: "task.added", id: "T1", title: "one" },
    { t: "task.done", id: "T1" },
  ]);
  expect(out).toContain("Reliable cancellation");
  expect(out).toContain("build 1/1");
});

test("every stage is listed, so you always know where you are", () => {
  const out = text([]);
  for (const stage of ["intent", "spec", "build", "verify"]) expect(out).toContain(stage);
});

test("a finished stage is not expanded — a tree showing everything stops being read", () => {
  const out = text([
    { t: "stage.done", stage: "spec" },
    { t: "criterion.added", id: "AC-1", text: "a criterion nobody needs to see now" },
  ]);
  expect(out).not.toContain("a criterion nobody needs");
});

test("the active stage is expanded", () => {
  const out = text([
    { t: "stage.entered", stage: "spec" },
    { t: "criterion.added", id: "AC-1", text: "shell stops on abort" },
  ]);
  expect(out).toContain("shell stops on abort");
});

test("a criterion with evidence is marked differently from one without", () => {
  const out = text([
    { t: "stage.entered", stage: "spec" },
    { t: "criterion.added", id: "AC-1", text: "proved" },
    { t: "criterion.met", id: "AC-1", evidence: "a test" },
    { t: "criterion.added", id: "AC-2", text: "unproved" },
  ]);
  const proved = out.split("\n").find((line) => line.includes("proved") && !line.includes("un"))!;
  const unproved = out.split("\n").find((line) => line.includes("unproved"))!;
  expect(proved).toContain("✓");
  expect(unproved).toContain("○");
});

test("a running task shows who is doing it", () => {
  const out = text([
    { t: "stage.entered", stage: "build" },
    { t: "task.added", id: "T1", title: "cancel the shell" },
    { t: "task.started", id: "T1", agent: "builder-1" },
  ]);
  expect(out).toContain("cancel the shell");
  expect(out).toContain("builder-1");
});

test("a finished task lets go of its agent on screen too", () => {
  const out = text([
    { t: "stage.entered", stage: "build" },
    { t: "task.added", id: "T1", title: "done thing" },
    { t: "task.started", id: "T1", agent: "builder-1" },
    { t: "task.done", id: "T1" },
  ]);
  expect(out).not.toContain("builder-1");
});

test("blocked work stays visible even when its stage is folded away", () => {
  const out = text([
    { t: "stage.entered", stage: "verify" },
    { t: "task.added", id: "T1", title: "first" },
    { t: "task.added", id: "T2", title: "waiting on the first" },
    { t: "task.started", id: "T2" },
    { t: "task.failed", id: "T2", reason: "no" },
  ]);
  expect(out).toContain("waiting on the first");
});

test("a task can be clicked, and carries its own id", () => {
  const built = pane([
    { t: "stage.entered", stage: "build" },
    { t: "task.added", id: "T1", title: "one" },
  ]);
  expect(built.targets!.filter((id) => id !== undefined)).toEqual(["task:T1"]);
});

test("the pane is exactly the height it was given", () => {
  for (const rows of [4, 20, 40]) {
    expect(pane([], { rows }).lines).toHaveLength(rows);
  }
});

test("nothing is wider than the column", () => {
  const long = text(
    [
      { t: "stage.entered", stage: "build" },
      { t: "task.added", id: "T1", title: "a task title far longer than any column" },
      { t: "task.started", id: "T1", agent: "an-agent-with-a-very-long-name" },
    ],
    { width: 24 },
  );
  for (const line of long.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
});

test("in ASCII mode not one mark is outside ascii", () => {
  const out = text(
    [
      { t: "stage.entered", stage: "build" },
      { t: "task.added", id: "T1", title: "one" },
      { t: "task.started", id: "T1", agent: "b" },
      { t: "task.added", id: "T2", title: "two", dependsOn: ["T1"] },
    ],
    { glyphs: ASCII_GLYPHS },
  );
  expect(out).toMatch(/^[\x00-\x7f]*$/);
});
