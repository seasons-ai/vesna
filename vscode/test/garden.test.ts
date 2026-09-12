import { join } from "node:path";
import { test, expect } from "bun:test";
import { gardenTree, marks } from "../src/garden";
import type { State, SpecTree } from "../src/protocol";

const ROOT = "/repo";
const SLUG = "abort";

function makeSpec(overrides: Partial<SpecTree> = {}): SpecTree {
  return {
    id: SLUG,
    title: "Reliable cancellation",
    stages: [
      { stage: "design", state: "done" },
      { stage: "spec", state: "done" },
      { stage: "plan", state: "done" },
      { stage: "build", state: "active" },
      { stage: "done", state: "todo" },
    ],
    criteria: [],
    tasks: [],
    progress: { done: 0, total: 0 },
    approved: { spec: true, plan: true },
    digests: {},
    building: true,
    ignored: 0,
    reviews: {},
    parked: [],
    rulings: [],
    finished: false,
    ...overrides,
  };
}

function makeState(spec: SpecTree | null, over: Partial<State> = {}): State {
  return {
    mode: "auto",
    busy: false,
    building: false,
    buildState: "idle",
    model: "gpt",
    service: "openai",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    spec,
    specSlug: spec === null ? null : SLUG,
    chats: null,
    chatId: null,
    root: ROOT,
    ...over,
  };
}

const briefPath = (id: string) => join(ROOT, ".vesna", "specs", SLUG, "briefs", `${id}.md`);

// ---------------------------------------------------------------------------
// gardenTree — [] when there is no spec.

test("no spec, no tree", () => {
  expect(gardenTree(makeState(null))).toEqual([]);
});

// ---------------------------------------------------------------------------
// gardenTree — a two-task state exercises stages, marks, witness, review,
// parked, the open paths, and the retry command's absence on a done task.

function twoTaskState(): State {
  const spec = makeSpec({
    tasks: [
      {
        id: "T1",
        title: "one",
        state: "done",
        dependsOn: [],
        evidence: { worker: true, reviewer: true, vesna: null },
      },
      {
        id: "T2",
        title: "two",
        state: "running",
        dependsOn: ["T1"],
        evidence: { worker: false, reviewer: false, vesna: false },
      },
    ],
    progress: { done: 1, total: 2 },
    reviews: {
      T1: { round: 1, spec: "met", open: [] },
    },
    parked: [{ task: "T1", finding: { severity: "minor", file: "a.ts", line: 3, text: "nit" } }],
  });
  return makeState(spec);
}

test("the root carries the spec's title and build progress", () => {
  const [root] = gardenTree(twoTaskState());
  expect(root!.label).toBe("Reliable cancellation");
  expect(root!.description).toBe("build 1/2");
});

test("stages become children of the root, with open paths for spec and plan", () => {
  const [root] = gardenTree(twoTaskState());
  const byId = Object.fromEntries(root!.children.map((n) => [n.id, n]));
  expect(Object.keys(byId)).toEqual(["stage:design", "stage:spec", "stage:plan", "stage:build", "stage:done"]);
  expect(byId["stage:spec"]!.open).toBe(join(ROOT, ".vesna", "specs", SLUG, "spec.md"));
  expect(byId["stage:plan"]!.open).toBe(join(ROOT, ".vesna", "specs", SLUG, "plan.md"));
  expect(byId["stage:design"]!.open).toBeUndefined();
  expect(byId["stage:done"]!.open).toBeUndefined();
});

test("the build stage holds the tasks, in order", () => {
  const [root] = gardenTree(twoTaskState());
  const build = root!.children.find((n) => n.id === "stage:build")!;
  expect(build.children.map((n) => n.id)).toEqual(["task:T1", "task:T2"]);
});

test("a task node carries its label, icon and brief path", () => {
  const [root] = gardenTree(twoTaskState());
  const build = root!.children.find((n) => n.id === "stage:build")!;
  const t1 = build.children.find((n) => n.id === "task:T1")!;
  const t2 = build.children.find((n) => n.id === "task:T2")!;
  expect(t1.label).toBe("T1  one");
  expect(t1.icon).toBe("done");
  expect(t1.open).toBe(briefPath("T1"));
  expect(t2.label).toBe("T2  two");
  expect(t2.icon).toBe("running");
  expect(t2.open).toBe(briefPath("T2"));
});

test("the retry command is present on a running task but absent on a done one", () => {
  const [root] = gardenTree(twoTaskState());
  const build = root!.children.find((n) => n.id === "stage:build")!;
  const t1 = build.children.find((n) => n.id === "task:T1")!;
  const t2 = build.children.find((n) => n.id === "task:T2")!;
  expect(t1.command).toBeUndefined();
  expect(t2.command).toEqual({ name: "build", argument: "retry T2" });
});

test("a done task shows its witness line beneath it", () => {
  const [root] = gardenTree(twoTaskState());
  const build = root!.children.find((n) => n.id === "stage:build")!;
  const t1 = build.children.find((n) => n.id === "task:T1")!;
  const witness = t1.children.find((n) => n.id === "task:T1:witness")!;
  expect(witness.icon).toBe("witness");
  expect(witness.label).toBe("✓ worker  ✓ reviewer  — vesna");
});

test("a running task has no witness node yet", () => {
  const [root] = gardenTree(twoTaskState());
  const build = root!.children.find((n) => n.id === "stage:build")!;
  const t2 = build.children.find((n) => n.id === "task:T2")!;
  expect(t2.children.some((n) => n.id === "task:T2:witness")).toBe(false);
});

test("a task under review carries the review's outcome, worded like the TUI", () => {
  const [root] = gardenTree(twoTaskState());
  const build = root!.children.find((n) => n.id === "stage:build")!;
  const t1 = build.children.find((n) => n.id === "task:T1")!;
  const review = t1.children.find((n) => n.id === "task:T1:review")!;
  expect(review.icon).toBe("review");
  expect(review.label).toBe("review 1: 0 open");
});

test("not met and no verdict are worded like the TUI too", () => {
  const notMet = makeState(
    makeSpec({
      tasks: [{ id: "T1", title: "one", state: "done", dependsOn: [], evidence: { worker: true, reviewer: true, vesna: true } }],
      reviews: { T1: { round: 2, spec: "not_met", open: [] } },
    }),
  );
  const noVerdict = makeState(
    makeSpec({
      tasks: [{ id: "T1", title: "one", state: "done", dependsOn: [], evidence: { worker: true, reviewer: true, vesna: true } }],
      reviews: { T1: { round: 3, spec: "no_verdict", open: [] } },
    }),
  );
  const reviewOf = (state: State) => {
    const [root] = gardenTree(state);
    const build = root!.children.find((n) => n.id === "stage:build")!;
    const t1 = build.children.find((n) => n.id === "task:T1")!;
    return t1.children.find((n) => n.id === "task:T1:review")!;
  };
  expect(reviewOf(notMet).label).toBe("review 2: not met");
  expect(reviewOf(noVerdict).label).toBe("review 3: no verdict");
});

test("a task with no review entry gets no review node", () => {
  const [root] = gardenTree(twoTaskState());
  const build = root!.children.find((n) => n.id === "stage:build")!;
  const t2 = build.children.find((n) => n.id === "task:T2")!;
  expect(t2.children.some((n) => n.id === "task:T2:review")).toBe(false);
});

test("parked findings become their own node under the task, numbered from 0", () => {
  const [root] = gardenTree(twoTaskState());
  const build = root!.children.find((n) => n.id === "stage:build")!;
  const t1 = build.children.find((n) => n.id === "task:T1")!;
  const parked = t1.children.find((n) => n.id === "task:T1:parked:0")!;
  expect(parked.icon).toBe("parked");
  expect(parked.label).toBe("parked: a.ts:3 — nit");
});

// ---------------------------------------------------------------------------
// marks — reused directly, the witness line's own words.

test("marks: every witness present and true", () => {
  expect(marks({ worker: true, reviewer: true, vesna: true })).toBe("✓ worker  ✓ reviewer  ✓ vesna");
});

test("marks: a dash for a check the plan never declared", () => {
  expect(marks({ worker: true, reviewer: true, vesna: null })).toBe("✓ worker  ✓ reviewer  — vesna");
});

test("marks: a cross for a check that failed", () => {
  expect(marks({ worker: true, reviewer: true, vesna: false })).toBe("✓ worker  ✓ reviewer  × vesna");
});
