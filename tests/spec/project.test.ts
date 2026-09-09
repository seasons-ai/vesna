import { test, expect } from "bun:test";
import { project, STAGES, type SpecEvent } from "../../src/spec/project";

const born: SpecEvent[] = [{ t: "created", id: "abort", title: "Reliable cancellation" }];
const tree = (events: SpecEvent[]) => project([...born, ...events])!;

test("events that never created anything project to nothing", () => {
  expect(project([])).toBeNull();
  expect(project([{ t: "stage.entered", stage: "build" }])).toBeNull();
});

test("a new spec starts with every stage still to do", () => {
  const t = tree([]);
  expect(t.title).toBe("Reliable cancellation");
  expect(t.stages.map((s) => s.stage)).toEqual([...STAGES]);
  expect(t.stages.every((s) => s.state === "todo")).toBe(true);
});

test("entering a stage makes it the active one", () => {
  const t = tree([{ t: "stage.entered", stage: "spec" }]);
  expect(t.stages.find((s) => s.stage === "spec")!.state).toBe("active");
});

test("a finished stage stays finished while the next one runs", () => {
  const t = tree([
    { t: "stage.entered", stage: "spec" },
    { t: "stage.done", stage: "spec" },
    { t: "stage.entered", stage: "plan" },
  ]);
  expect(t.stages.find((s) => s.stage === "spec")!.state).toBe("done");
  expect(t.stages.find((s) => s.stage === "plan")!.state).toBe("active");
});

test("a review can send a finished stage back, and the tree says so", () => {
  const t = tree([
    { t: "stage.done", stage: "build" },
    { t: "stage.entered", stage: "build" },
  ]);
  expect(t.stages.find((s) => s.stage === "build")!.state).toBe("active");
});

test("a criterion is unmet until something proves it", () => {
  const t = tree([{ t: "criterion.added", id: "AC-1", text: "shell stops on abort" }]);
  expect(t.criteria).toEqual([{ id: "AC-1", text: "shell stops on abort" }]);
});

test("met means evidence, and the evidence is kept", () => {
  const t = tree([
    { t: "criterion.added", id: "AC-1", text: "shell stops" },
    { t: "criterion.met", id: "AC-1", evidence: "test: aborting a shell command" },
  ]);
  expect(t.criteria[0]!.evidence).toBe("test: aborting a shell command");
});

test("evidence for a criterion nobody declared is kept, not discarded", () => {
  const t = tree([{ t: "criterion.met", id: "AC-9", evidence: "typecheck" }]);
  expect(t.criteria).toEqual([{ id: "AC-9", text: "AC-9", evidence: "typecheck" }]);
});

test("a task with no dependencies is ready, not blocked", () => {
  const t = tree([{ t: "task.added", id: "T1", title: "add tests" }]);
  expect(t.tasks[0]!.state).toBe("todo");
});

test("a task waiting on unfinished work is blocked, which is not the same as idle", () => {
  const t = tree([
    { t: "task.added", id: "T1", title: "one" },
    { t: "task.added", id: "T2", title: "two", dependsOn: ["T1"] },
  ]);
  expect(t.tasks.find((task) => task.id === "T2")!.state).toBe("blocked");
});

test("finishing what it waited for unblocks it", () => {
  const t = tree([
    { t: "task.added", id: "T1", title: "one" },
    { t: "task.added", id: "T2", title: "two", dependsOn: ["T1"] },
    { t: "task.done", id: "T1", commit: "a14f0cd" },
  ]);
  expect(t.tasks.find((task) => task.id === "T2")!.state).toBe("todo");
});

test("a running task names who is doing it", () => {
  const t = tree([
    { t: "task.added", id: "T1", title: "one" },
    { t: "task.started", id: "T1", agent: "builder-1" },
  ]);
  expect(t.tasks[0]!.state).toBe("running");
  expect(t.tasks[0]!.agent).toBe("builder-1");
});

test("a finished task keeps its commit and lets go of its agent", () => {
  const t = tree([
    { t: "task.added", id: "T1", title: "one" },
    { t: "task.started", id: "T1", agent: "builder-1" },
    { t: "task.done", id: "T1", commit: "a14f0cd" },
  ]);
  expect(t.tasks[0]!.commit).toBe("a14f0cd");
  expect(t.tasks[0]!.agent).toBeUndefined();
});

test("a failed task says why, and does not pretend to still be running", () => {
  const t = tree([
    { t: "task.added", id: "T1", title: "one" },
    { t: "task.started", id: "T1", agent: "builder-1" },
    { t: "task.failed", id: "T1", reason: "tests did not pass" },
  ]);
  expect(t.tasks[0]!.state).toBe("failed");
  expect(t.tasks[0]!.reason).toBe("tests did not pass");
  expect(t.tasks[0]!.agent).toBeUndefined();
});

test("an event about a task nobody declared is ignored, not invented", () => {
  expect(tree([{ t: "task.started", id: "ghost" }]).tasks).toEqual([]);
});

test("progress counts what is finished against what is known", () => {
  const t = tree([
    { t: "task.added", id: "T1", title: "one" },
    { t: "task.added", id: "T2", title: "two" },
    { t: "task.done", id: "T1" },
  ]);
  expect(t.progress).toEqual({ done: 1, total: 2 });
});

test("the same events always give the same tree", () => {
  const events: SpecEvent[] = [
    { t: "stage.entered", stage: "build" },
    { t: "task.added", id: "T1", title: "one" },
    { t: "task.started", id: "T1", agent: "b" },
  ];
  expect(tree(events)).toEqual(tree(events));
});

test("replaying a prefix gives the state at that moment, which is what recovery needs", () => {
  const full: SpecEvent[] = [
    { t: "task.added", id: "T1", title: "one" },
    { t: "task.started", id: "T1" },
    { t: "task.done", id: "T1" },
  ];
  expect(tree(full.slice(0, 2)).tasks[0]!.state).toBe("running");
  expect(tree(full).tasks[0]!.state).toBe("done");
});
