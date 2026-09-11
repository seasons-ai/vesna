import { test, expect } from "bun:test";
import { activeStage, project, STAGES, type SpecEvent } from "../../src/spec/project";

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

test("the stages are the five phases of the process, in order", () => {
  expect([...STAGES]).toEqual(["design", "spec", "plan", "build", "done"]);
});

test("nothing is approved until a person says so", () => {
  const t = tree([]);
  expect(t.approved).toEqual({ spec: false, plan: false });
});

test("approving the spec finishes it and opens the plan", () => {
  const t = tree([{ t: "approved", what: "spec" }]);
  expect(t.approved.spec).toBe(true);
  expect(t.stages.find((s) => s.stage === "spec")!.state).toBe("done");
  expect(t.stages.find((s) => s.stage === "plan")!.state).toBe("active");
});

test("approving the spec also closes the design conversation that produced it", () => {
  // Nothing else ever marks design done: no event closes it on its own, so a
  // finished project left showing an open first stage would be the same
  // stale-phase bug in the garden column instead of the prompt.
  const t = tree([{ t: "approved", what: "spec" }]);
  expect(t.stages.find((s) => s.stage === "design")!.state).toBe("done");
});

test("a build that starts without an approved plan is ignored, and counted", () => {
  const t = tree([{ t: "build.started" }]);
  expect(t.building).toBe(false);
  expect(t.ignored).toBe(1);
  expect(t.stages.find((s) => s.stage === "build")!.state).toBe("todo");
});

test("a build that starts on an approved plan is a build", () => {
  const t = tree([{ t: "approved", what: "plan" }, { t: "build.started" }]);
  expect(t.building).toBe(true);
  expect(t.ignored).toBe(0);
  expect(t.stages.find((s) => s.stage === "plan")!.state).toBe("done");
  expect(t.stages.find((s) => s.stage === "build")!.state).toBe("active");
});

test("a finished build is the done stage", () => {
  const t = tree([{ t: "approved", what: "plan" }, { t: "build.started" }, { t: "build.done" }]);
  expect(t.building).toBe(false);
  expect(t.stages.find((s) => s.stage === "build")!.state).toBe("done");
  expect(t.stages.find((s) => s.stage === "done")!.state).toBe("done");
});

test("a stopped build is still the build stage, not done", () => {
  const t = tree([
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "build.stopped", reason: "merge conflict in T2" },
  ]);
  expect(t.building).toBe(false);
  expect(t.stages.find((s) => s.stage === "build")!.state).toBe("active");
  expect(t.stages.find((s) => s.stage === "done")!.state).toBe("todo");
});

test("the agent's classification stands until a person overrides it", () => {
  expect(tree([{ t: "classified", shape: "bounded", by: "agent" }]).shape).toBe("bounded");
  expect(
    tree([
      { t: "classified", shape: "bounded", by: "agent" },
      { t: "classified", shape: "architectural", by: "person" },
      { t: "classified", shape: "spike", by: "agent" },
    ]).shape,
  ).toBe("architectural");
});

test("between two agent classifications the heavier wins", () => {
  expect(
    tree([
      { t: "classified", shape: "architectural", by: "agent" },
      { t: "classified", shape: "spike", by: "agent" },
    ]).shape,
  ).toBe("architectural");
});

test("a review's open findings are the ones that block, and the latest round wins", () => {
  const important = { severity: "important" as const, file: "a.ts", line: 3, text: "wrong" };
  const minor = { severity: "minor" as const, file: "a.ts", text: "nit" };
  const t = tree([
    { t: "task.added", id: "T1", title: "one" },
    { t: "review.done", task: "T1", round: 1, spec: "met", findings: [important, minor] },
    { t: "review.done", task: "T1", round: 2, spec: "met", findings: [minor] },
  ]);
  expect(t.reviews.T1!).toEqual({ round: 2, spec: "met", open: [] });
});

test("a not-met spec is open even with no findings", () => {
  const t = tree([
    { t: "task.added", id: "T1", title: "one" },
    { t: "review.done", task: "T1", round: 1, spec: "not_met", findings: [] },
  ]);
  expect(t.reviews.T1!.spec).toBe("not_met");
});

test("parked findings and rulings are kept in order", () => {
  const f = { severity: "minor" as const, file: "x", text: "later" };
  const t = tree([
    { t: "parked", task: "T1", finding: f },
    { t: "ruling", text: "merge per task", why: "dependents need the code" },
  ]);
  expect(t.parked).toEqual([{ task: "T1", finding: f }]);
  expect(t.rulings).toEqual([{ text: "merge per task", why: "dependents need the code" }]);
});

test("activeStage: nothing done is the design phase", () => {
  expect(activeStage(tree([]))).toBe("design");
});

test("activeStage: a design written to spec.md but not yet approved is the spec phase", () => {
  // The only prompt that names spec.md's path and says "stop and ask the
  // person to read it" is the spec phase; it has to be reachable.
  expect(activeStage(tree([]), { specWritten: true })).toBe("spec");
  expect(activeStage(tree([{ t: "classified", shape: "architectural", by: "agent" }]), { specWritten: true })).toBe("spec");
});

test("activeStage: once the spec is approved, a written spec.md is the plan phase", () => {
  expect(activeStage(tree([{ t: "approved", what: "spec" }]), { specWritten: true })).toBe("plan");
});

test("activeStage: an approved spec with no plan yet is the plan phase", () => {
  expect(activeStage(tree([{ t: "approved", what: "spec" }]))).toBe("plan");
});

test("activeStage: an approved plan with no build running is still the plan phase", () => {
  // /build is what runs an approved plan — approval alone does not start it.
  expect(activeStage(tree([{ t: "approved", what: "spec" }, { t: "approved", what: "plan" }]))).toBe(
    "plan",
  );
});

test("activeStage: a running build is the build phase", () => {
  const t = tree([{ t: "approved", what: "spec" }, { t: "approved", what: "plan" }, { t: "build.started" }]);
  expect(activeStage(t)).toBe("build");
});

test("activeStage: a stopped build falls back to the plan phase, not build", () => {
  // The loop is no longer running, and a person decides what happens next —
  // the same reason a stopped build must not still say "you are not the worker".
  const t = tree([
    { t: "approved", what: "spec" },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "build.stopped", reason: "merge conflict in T2" },
  ]);
  expect(activeStage(t)).toBe("plan");
});

test("activeStage: everything done is the done phase, not design", () => {
  // A scan for the furthest "active" stage falls through to design here,
  // because nothing ever marks design done by itself and nothing is left
  // active once build and done both are — this is the bug the ruling fixed.
  const t = tree([
    { t: "approved", what: "spec" },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "build.done" },
  ]);
  expect(activeStage(t)).toBe("done");
});
