# Spec-Driven Development Built In — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the build-review-merge half of spec-driven development a loop Vesna runs, gated on a plan a person approved, with reviewers that answer through a tool.

**Architecture:** The garden's event log (`.vesna/specs/<slug>/events.jsonl`) is the state; its reducer gains phases, approvals, classification, reviews, parkings and rulings. A new `src/sdd/` module runs the loop over the existing `src/work/` machinery (worktree, builder, scheduler, merge queue): per task, brief → build → review → fix rounds → merge, then a final review. Reviewers are fresh read-only sessions that must call `review_verdict`. The loop is reachable from `/build` in the chat and `vesna build <slug>` from the shell.

**Tech Stack:** TypeScript on Bun, `bun test`, `yaml`; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-sdd-built-in-design.md`

## Global Constraints

- Every committed artifact in English — code, comments, docs, commit messages.
- Never add `Co-Authored-By` or any AI attribution to a commit.
- No new runtime dependencies: `yaml` and `@anthropic-ai/sdk` only.
- Spec-folder reads and writes are synchronous, like `src/spec/store.ts` — an `await` in a keypress handler does not resolve until the next key.
- `.vesna/config.yaml` is the user's file; nothing here writes it.
- `app.ts` renders, it does not decide: every user-facing string from a slash command comes from a pure exported function in `src/cli/chatcmd.ts` with a unit test on its exact text, error paths included.
- The only node that can append `approved` is none: it is written by the `/approve` command on a person's keystroke, never by a tool the model can call.
- A review without a `review_verdict` call is a failed review, never a pass.
- Fix rounds per task: at most 5. At the cap, Important and Minor park; a Critical still open stops the build.
- Tests never touch the network; providers are faked.
- Commit messages: `git commit -F -` with a heredoc, because they contain backticks.
- Baseline: 934 tests, 0 failures, `bun run typecheck` clean. Every task leaves both green.

**A decision the spec did not settle, made here:** merging happens per task, right after its review passes and before any dependent starts — not as one queue at the end. A task that depends on another's code must branch from a tree that has it. `mergeAll` is called with a single candidate each time.

**Another:** approval is the `/approve spec` or `/approve plan` slash command, not a free-text "ok". A slash command is typed only by a person, is unambiguous, and needs no model to interpret it — which is the whole point of the gate.

---

## File Structure

**New**
- `src/sdd/classify.ts` — `Shape`, the `classify` node, `currentShape(events)`.
- `src/sdd/brief.ts` — `splitPlan(markdown) → PlanTask[]`, `writeBriefs(root, slug, tasks)`.
- `src/sdd/review.ts` — `Verdict`, `Finding`, `createVerdictNode(holder)`, `reviewTask(request) → ReviewOutcome`.
- `src/sdd/loop.ts` — `runBuild(request) → BuildOutcome`: the loop.
- `src/cli/buildcmd.ts` — `vesna build <slug>`.
- `tests/sdd/classify.test.ts`, `tests/sdd/brief.test.ts`, `tests/sdd/review.test.ts`, `tests/sdd/loop.test.ts`, `tests/cli/buildcmd.test.ts`.

**Modified**
- `src/spec/project.ts` — five stages; new events; `approved`, `shape`, `reviews`, `parked`, `rulings`, `building`, `ignored` on the tree.
- `src/spec/store.ts` — `specPaths(root, slug)`, `writeSpecFile`, `readSpecFile`.
- `src/nodes/plan.ts` — `plan` no longer sets the stage to `build` when tasks are given (that is the loop's job now).
- `src/work/builder.ts` — `resumeTask(request)`.
- `src/cli/chatcmd.ts` — `/approve`, `/build` entries; `approveOutcome`, `buildOutcome` pure functions.
- `src/tui/app.ts` — `/approve`, `/build` handlers.
- `src/tui/panes.ts` — review marks beside tasks; stage names.
- `src/loop/prompt.ts` — phase section keyed on the current stage.
- `src/cli/main.ts` — `build` command; `Route`/`COMMANDS`/`needsProvider`.
- `tests/spec/project.test.ts`, `tests/tui/garden.test.ts`, `tests/tui/app.test.ts`, `tests/tui/panes.test.ts`, `tests/work/builder.test.ts`, `tests/cli/chatcmd.test.ts`, `tests/cli/dispatch.test.ts`, `tests/nodes/plan.test.ts`.

---

### Task 1: Five stages, approvals, classification, and the build gate in the reducer

**Files:**
- Modify: `src/spec/project.ts`
- Modify: `src/nodes/plan.ts:74-83` (the stage default)
- Test: `tests/spec/project.test.ts`, `tests/tui/garden.test.ts:30`, `tests/tui/app.test.ts:1561-1597`, `tests/nodes/plan.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (everything later tasks import from `src/spec/project.ts`):
  ```ts
  export type Stage = "design" | "spec" | "plan" | "build" | "done";
  export const STAGES: readonly Stage[];
  export type Shape = "spike" | "bounded" | "architectural";
  export type Approvable = "spec" | "plan";
  export type Severity = "critical" | "important" | "minor";
  export interface Finding { severity: Severity; file: string; line?: number; text: string }
  export type SpecEvent = /* existing */ 
    | { t: "classified"; shape: Shape; by: "agent" | "person" }
    | { t: "approved"; what: Approvable }
    | { t: "build.started" }
    | { t: "build.stopped"; reason: string }
    | { t: "build.done" }
    | { t: "review.done"; task: string; round: number; spec: "met" | "not_met"; findings: Finding[] }
    | { t: "review.failed"; task: string; round: number; reason: string }
    | { t: "parked"; task: string; finding: Finding }
    | { t: "ruling"; text: string; why: string };
  export interface SpecTree { /* existing */
    shape?: Shape;
    approved: { spec: boolean; plan: boolean };
    building: boolean;
    /** Build events that arrived before the plan was approved. Ignored, and counted so the lie is visible. */
    ignored: number;
    reviews: Record<string, { round: number; spec: "met" | "not_met"; open: Finding[] }>;
    parked: { task: string; finding: Finding }[];
    rulings: { text: string; why: string }[];
  }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/spec/project.test.ts` (the file already has a `tree(events)` helper that prepends a `created` event):

```ts
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
  expect(t.reviews.T1).toEqual({ round: 2, spec: "met", open: [] });
});

test("a not-met spec is open even with no findings", () => {
  const t = tree([
    { t: "task.added", id: "T1", title: "one" },
    { t: "review.done", task: "T1", round: 1, spec: "not_met", findings: [] },
  ]);
  expect(t.reviews.T1.spec).toBe("not_met");
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
```

Also update, in the same file, the first stage-list test if it enumerates old names, and in `tests/tui/garden.test.ts:30` change the loop to `["design", "spec", "build", "done"]`. In `tests/tui/app.test.ts:1561-1597`, `"intent"` becomes `"design"` and `"verify"` becomes `"done"` — those strings are used as "the garden is visible" sentinels. If `"done"` turns out to appear elsewhere on the rendered screen and a test flickers, use `"design"` for both.

In `tests/nodes/plan.test.ts`, find the test asserting that `plan` with tasks emits `stage.entered: build`; change its expectation to: no `stage.entered` event is emitted when no `stage` is given. (Entering `build` is now the loop's job.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/spec/project.test.ts tests/tui/garden.test.ts tests/nodes/plan.test.ts`
Expected: FAIL — `STAGES` has eight members; `approved`/`building`/`ignored`/`shape`/`reviews`/`parked`/`rulings` are undefined.

- [ ] **Step 3: Write the reducer**

Replace the `Stage`/`STAGES` block and extend `SpecEvent`/`SpecTree`/`project` in `src/spec/project.ts`:

```ts
export type Stage = "design" | "spec" | "plan" | "build" | "done";

/**
 * The five phases, in the order they happen. The earlier eight were a guess
 * made before the process was run for real: intent and research are the
 * design conversation, review and verify happen inside the build per task,
 * and crystal is gone with the feature.
 */
export const STAGES: readonly Stage[] = ["design", "spec", "plan", "build", "done"];

export type Shape = "spike" | "bounded" | "architectural";
const HEAVINESS: Record<Shape, number> = { spike: 0, bounded: 1, architectural: 2 };

export type Approvable = "spec" | "plan";
export type Severity = "critical" | "important" | "minor";

export interface Finding {
  severity: Severity;
  file: string;
  line?: number;
  text: string;
}

export type SpecEvent =
  | { t: "created"; id: string; title: string }
  | { t: "stage.entered"; stage: Stage }
  | { t: "stage.done"; stage: Stage }
  | { t: "criterion.added"; id: string; text: string }
  /** Met is not the same as claimed: evidence is what a verifier produced. */
  | { t: "criterion.met"; id: string; evidence: string }
  | { t: "task.added"; id: string; title: string; dependsOn?: string[] }
  | { t: "task.started"; id: string; agent?: string }
  | { t: "task.done"; id: string; commit?: string }
  | { t: "task.failed"; id: string; reason?: string }
  /** What shape of work this is. The agent says; a person may overrule. */
  | { t: "classified"; shape: Shape; by: "agent" | "person" }
  /** Written only by the /approve command, on a keystroke. No tool emits it. */
  | { t: "approved"; what: Approvable }
  | { t: "build.started" }
  | { t: "build.stopped"; reason: string }
  | { t: "build.done" }
  | { t: "review.done"; task: string; round: number; spec: "met" | "not_met"; findings: Finding[] }
  /** The reviewer never called review_verdict. That is its failure, not a pass. */
  | { t: "review.failed"; task: string; round: number; reason: string }
  /** Left open at the fix-round cap, on purpose and on the record. */
  | { t: "parked"; task: string; finding: Finding }
  /** A decision the loop made that the plan did not settle. */
  | { t: "ruling"; text: string; why: string };
```

Add to `SpecTree`:

```ts
  shape?: Shape;
  approved: { spec: boolean; plan: boolean };
  building: boolean;
  /** Build events that arrived before the plan was approved: ignored, and counted. */
  ignored: number;
  reviews: Record<string, { round: number; spec: "met" | "not_met"; open: Finding[] }>;
  parked: { task: string; finding: Finding }[];
  rulings: { text: string; why: string }[];
```

In `project`, before the loop:

```ts
  const approved = { spec: false, plan: false };
  let building = false;
  let ignored = 0;
  let agentShape: Shape | undefined;
  let personShape: Shape | undefined;
  const reviews: SpecTree["reviews"] = {};
  const parked: SpecTree["parked"] = [];
  const rulings: SpecTree["rulings"] = [];
```

New cases in the `switch`:

```ts
      case "classified":
        if (event.by === "person") personShape = event.shape;
        // Between the agent's own guesses the heavier stands: erring toward
        // ceremony costs time, erring away from it costs the review.
        else if (agentShape === undefined || HEAVINESS[event.shape] > HEAVINESS[agentShape]) {
          agentShape = event.shape;
        }
        break;

      case "approved":
        approved[event.what] = true;
        // Approving is what closes a phase: the spec is done when a person
        // says so, and the next phase opens on the same keystroke.
        stageState.set(event.what, "done");
        if (event.what === "spec") stageState.set("plan", "active");
        break;

      case "build.started":
        // The reducer is the second lock. The command refuses first, but a
        // log that could be made to show a build nobody approved would be a
        // log that lies, so the event is dropped and the drop is counted.
        if (!approved.plan) {
          ignored += 1;
          break;
        }
        building = true;
        stageState.set("plan", "done");
        stageState.set("build", "active");
        break;

      case "build.stopped":
        building = false;
        break;

      case "build.done":
        building = false;
        stageState.set("build", "done");
        stageState.set("done", "done");
        break;

      case "review.done":
        reviews[event.task] = {
          round: event.round,
          spec: event.spec,
          open: event.findings.filter((f) => f.severity !== "minor"),
        };
        break;

      case "review.failed":
        // Recorded on the task so the panel can say "review failed" rather
        // than leaving it looking like it is still running.
        reviews[event.task] = { round: event.round, spec: "not_met", open: [] };
        break;

      case "parked":
        parked.push({ task: event.task, finding: event.finding });
        break;

      case "ruling":
        rulings.push({ text: event.text, why: event.why });
        break;
```

And in the returned object:

```ts
    ...(personShape ?? agentShape ? { shape: personShape ?? agentShape } : {}),
    approved,
    building,
    ignored,
    reviews,
    parked,
    rulings,
```

In `src/nodes/plan.ts`, the `plan` node currently does:

```ts
      const stage = named ?? ((input.tasks?.length ?? 0) > 0 ? "build" : undefined);
```

Change it to `const stage = named;` and delete the comment above it that explains the old default. Entering `build` is the loop's event now, gated on approval.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/spec tests/tui/garden.test.ts tests/tui/app.test.ts tests/nodes/plan.test.ts` then `bun test` and `bun run typecheck`.
Expected: all pass; 934 + 12 new = 946 or thereabouts (the plan-node test count may shift by one).

- [ ] **Step 5: Commit**

```bash
git add src/spec/project.ts src/nodes/plan.ts tests/spec/project.test.ts tests/tui/garden.test.ts tests/tui/app.test.ts tests/nodes/plan.test.ts
git commit -F - <<'MSG'
feat: five phases, approvals and the build gate in the reducer

The garden's eight stages were a guess made before the process was run
for real. They collapse to five — design, spec, plan, build, done — and
the log learns the events the process actually produces: what shape of
work this is, what a person approved, whether a build is running, what a
review found, what was parked at the fix-round cap, and what the loop
decided on its own.

The gate lives here as well as in the command. A `build.started` with no
`approved: plan` before it is dropped and counted rather than reduced,
because a log that could be made to show a build nobody approved would
be a log that lies. The `plan` node no longer enters the build stage on
its own for the same reason: that is the loop's event, behind the gate.
MSG
```

---

### Task 2: The spec folder holds the process's files

**Files:**
- Modify: `src/spec/store.ts`
- Test: `tests/spec/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SpecPaths {
    dir: string; events: string; spec: string; plan: string;
    briefs: string; reports: string; reviews: string;
  }
  export function specPaths(root: string, slug: string): SpecPaths;
  /** Synchronous; makes the parent directory. */
  export function writeSpecFile(path: string, text: string): void;
  /** Synchronous; null when absent. */
  export function readSpecFile(path: string): string | null;
  ```

- [ ] **Step 1: Write the failing test**

Append to `tests/spec/store.test.ts`:

```ts
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { specPaths, writeSpecFile, readSpecFile } from "../../src/spec/store";

test("a spec's files all live in its own folder", () => {
  const p = specPaths("/repo/.vesna/specs", "cancel");
  expect(p.dir).toBe("/repo/.vesna/specs/cancel");
  expect(p.events).toBe("/repo/.vesna/specs/cancel/events.jsonl");
  expect(p.spec).toBe("/repo/.vesna/specs/cancel/spec.md");
  expect(p.plan).toBe("/repo/.vesna/specs/cancel/plan.md");
  expect(p.briefs).toBe("/repo/.vesna/specs/cancel/briefs");
  expect(p.reports).toBe("/repo/.vesna/specs/cancel/reports");
  expect(p.reviews).toBe("/repo/.vesna/specs/cancel/reviews");
});

test("writing a spec file makes its folder, and reading it back is exact", () => {
  const root = mkdtempSync(join(tmpdir(), "vesna-specfile-"));
  const p = specPaths(root, "x");
  expect(readSpecFile(p.spec)).toBeNull();
  writeSpecFile(join(p.briefs, "T1.md"), "# T1\n");
  expect(existsSync(p.briefs)).toBe(true);
  expect(readSpecFile(join(p.briefs, "T1.md"))).toBe("# T1\n");
});
```

(`join` is already imported in that file; if not, add `import { join } from "node:path";`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/spec/store.test.ts`
Expected: FAIL — `specPaths` is not exported.

- [ ] **Step 3: Implement**

Add to `src/spec/store.ts` (it already imports `mkdirSync`, `readFileSync`, `writeFileSync`, `join`; add `dirname` to the `node:path` import):

```ts
/**
 * Where a spec's files are. The folder is the process's workspace: the log,
 * the design, the plan, one brief per task, the workers' reports and the
 * reviews, all committed beside the code they describe. The hidden directory
 * that held these before was destroyed by a cleanup step at least once.
 */
export interface SpecPaths {
  dir: string;
  events: string;
  spec: string;
  plan: string;
  briefs: string;
  reports: string;
  reviews: string;
}

export function specPaths(root: string, slug: string): SpecPaths {
  const dir = join(root, slug);
  return {
    dir,
    events: join(dir, "events.jsonl"),
    spec: join(dir, "spec.md"),
    plan: join(dir, "plan.md"),
    briefs: join(dir, "briefs"),
    reports: join(dir, "reports"),
    reviews: join(dir, "reviews"),
  };
}

export function writeSpecFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function readSpecFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
```

Replace the body of the existing `eventsPath` helper with `return specPaths(root, slug).events;` so there is one statement of the layout.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/spec/store.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec/store.ts tests/spec/store.test.ts
git commit -F - <<'MSG'
feat: the spec folder holds the process's files

One statement of where a spec's log, design, plan, briefs, reports and
reviews live, and two synchronous helpers to write and read them. The
folder is committed with the code, so the process that produced a branch
travels with the branch.
MSG
```

---

### Task 3: The `classify` node

**Files:**
- Create: `src/sdd/classify.ts`
- Modify: `src/cli/context.ts` (register the node beside the plan nodes)
- Test: `tests/sdd/classify.test.ts`

**Interfaces:**
- Consumes: `SpecSink` from `src/spec/sink.ts` (`emit(event)`, `ensure(title)`, `open`); `Shape` from `src/spec/project.ts`.
- Produces:
  ```ts
  export const SHAPES: readonly Shape[];
  export function createClassifyNode(sink: SpecSink): NodeDef<{ shape: Shape; title?: string; why: string }, { shape: Shape; spec: string }>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/sdd/classify.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createClassifyNode, SHAPES } from "../../src/sdd/classify";
import type { SpecEvent } from "../../src/spec/project";
import type { SpecSink } from "../../src/spec/sink";

function sink(): SpecSink & { events: SpecEvent[] } {
  const events: SpecEvent[] = [];
  let slug: string | null = null;
  let created = false;
  return {
    events,
    get slug() { return slug; },
    set slug(v) { slug = v; },
    get open() { return slug !== null; },
    get created() { return created; },
    ensure(title) { created = slug === null; slug ??= title.toLowerCase(); return slug; },
    emit(e) { if (slug !== null) events.push(e); },
  };
}

const ctx = { cwd: "/tmp", signal: new AbortController().signal };

test("the three shapes, lightest first", () => {
  expect([...SHAPES]).toEqual(["spike", "bounded", "architectural"]);
});

test("classifying opens a spec if none is open and records the shape as the agent's", async () => {
  const s = sink();
  const node = createClassifyNode(s);
  const out = await node.run({ shape: "bounded", title: "Cancel cleanly", why: "one file" }, ctx);
  expect(out).toEqual({ shape: "bounded", spec: "cancel cleanly" });
  expect(s.events).toEqual([{ t: "classified", shape: "bounded", by: "agent" }]);
});

test("a spike opens no spec: its output is an answer, not work to track", async () => {
  const s = sink();
  const out = await createClassifyNode(s).run({ shape: "spike", why: "just checking" }, ctx);
  expect(out.spec).toBe("");
  expect(s.open).toBe(false);
  expect(s.events).toEqual([]);
});

test("an unknown shape is refused, naming the three", async () => {
  const s = sink();
  await expect(
    createClassifyNode(s).run({ shape: "huge" as any, why: "" }, ctx),
  ).rejects.toThrow(/spike, bounded, architectural/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/sdd/classify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/sdd/classify.ts`:

```ts
import type { NodeDef } from "../registry/types";
import type { Shape } from "../spec/project";
import type { SpecSink } from "../spec/sink";

/**
 * What shape of work a request is.
 *
 * Not every request is a project. A spike ends in an answer and keeps no
 * code. A bounded change is designed in the conversation and built without a
 * spec file. An architectural change goes through every phase. The agent says
 * which it sees, out loud and on the record, so the person can overrule it
 * before any ceremony is spent — or skipped.
 */
export const SHAPES: readonly Shape[] = ["spike", "bounded", "architectural"];

export interface ClassifyInput {
  shape: Shape;
  /** Names the spec when none is open. Ignored for a spike. */
  title?: string;
  /** One sentence. Shown to the person, who may disagree. */
  why: string;
}

export function createClassifyNode(
  sink: SpecSink,
): NodeDef<ClassifyInput, { shape: Shape; spec: string }> {
  return {
    type: "classify",
    description:
      "Say what shape of work the request is, before doing any of it: spike (an answer, no code kept), bounded (a change to a flow that already exists, designed in chat), or architectural (a new subsystem — spec, plan, and build). When in doubt choose the heavier shape and say so. The person can overrule you.",
    inputSchema: {
      type: "object",
      properties: {
        shape: { type: "string", enum: [...SHAPES] },
        title: { type: "string", description: "A short name for the work, used to open a spec." },
        why: { type: "string", description: "One sentence on why this shape." },
      },
      required: ["shape", "why"],
    },
    effect: "pure",
    async run(input) {
      if (!SHAPES.includes(input.shape)) {
        throw new Error(`unknown shape "${input.shape}" — one of ${SHAPES.join(", ")}`);
      }
      // A spike is not tracked: nothing it produces is kept, so a spec for
      // it would be a folder with nothing in it.
      if (input.shape === "spike") return { shape: input.shape, spec: "" };

      const slug = sink.ensure(input.title ?? "untitled work");
      sink.emit({ t: "classified", shape: input.shape, by: "agent" });
      return { shape: input.shape, spec: slug };
    },
  };
}
```

In `src/cli/context.ts`, where `createPlanNodes(sink)` is registered, add `registry.register(createClassifyNode(sink));` with the matching import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/sdd/classify.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sdd/classify.ts src/cli/context.ts tests/sdd/classify.test.ts
git commit -F - <<'MSG'
feat: the agent says what shape of work a request is

Spike, bounded or architectural, announced through a tool so it lands
in the log where a person can see it and overrule it. A spike opens no
spec: nothing it produces is kept.
MSG
```

---

### Task 4: `/approve` — the one event only a person writes

**Files:**
- Modify: `src/cli/chatcmd.ts`
- Modify: `src/tui/app.ts` (the slash-command dispatch, beside `/spec`)
- Test: `tests/cli/chatcmd.test.ts`, `tests/tui/app.test.ts`

**Interfaces:**
- Consumes: `Approvable`, `SpecTree` from `src/spec/project.ts`; `deps.sink` (a `SpecSink`) and `deps.spec` (the current `SpecTree | null`) in `app.ts`.
- Produces:
  ```ts
  export type ApproveOutcome =
    | { kind: "approved"; what: Approvable; message: string }
    | { kind: "refused"; message: string };
  export function approveOutcome(argument: string, tree: SpecTree | null): ApproveOutcome;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/cli/chatcmd.test.ts`:

```ts
import { approveOutcome, CHAT_COMMANDS } from "../../src/cli/chatcmd";
import { project } from "../../src/spec/project";

const open = project([{ t: "created", id: "x", title: "X" }]);

test("/approve is a command", () => {
  expect(CHAT_COMMANDS.map((c) => c.name)).toContain("approve");
});

test("approving the spec names what was approved", () => {
  expect(approveOutcome("spec", open)).toEqual({
    kind: "approved",
    what: "spec",
    message: "approved: spec — the plan can be written now",
  });
});

test("approving the plan says what it unlocks", () => {
  expect(approveOutcome("plan", open)).toEqual({
    kind: "approved",
    what: "plan",
    message: "approved: plan — /build will run it",
  });
});

test("approving with no spec open is refused", () => {
  expect(approveOutcome("plan", null)).toEqual({
    kind: "refused",
    message: "nothing to approve — no spec is open",
  });
});

test("approving something that is not spec or plan is refused, naming both", () => {
  expect(approveOutcome("everything", open)).toEqual({
    kind: "refused",
    message: 'approve what? "spec" or "plan"',
  });
});
```

Append to `tests/tui/app.test.ts` (use the file's existing `start`, `until`, `quit`, and spec fixtures; look at how the `/spec new` tests open one):

```ts
test("/approve plan writes the approval to the log, and nothing else can", async () => {
  const app = await start(reply("x"), { rows: 24, cols: 100 });
  app.input.type("/spec new gate\r");
  await until(() => app.screen().includes("gate"), "the spec");
  app.input.type("/approve plan\r");
  await until(() => app.screen().includes("approved: plan"), "the approval");
  const events = readEvents(specsRoot(app.root), "gate");
  expect(events.some((e) => e.t === "approved" && e.what === "plan")).toBe(true);
  await quit(app);
});
```

(`readEvents` and `specsRoot` are exported from `src/spec/store.ts`; `app.root` is whatever the harness exposes as the project directory — check the existing `/spec` tests for its name.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli/chatcmd.test.ts tests/tui/app.test.ts`
Expected: FAIL — `approveOutcome` not exported; `/approve` is an unknown command.

- [ ] **Step 3: Implement**

In `src/cli/chatcmd.ts`, add to `CHAT_COMMANDS` after `spec`:

```ts
  { name: "approve", help: "approve the spec or the plan: /approve spec, /approve plan" },
```

and export:

```ts
export type ApproveOutcome =
  | { kind: "approved"; what: Approvable; message: string }
  | { kind: "refused"; message: string };

/**
 * The one event no tool can emit. A person typed this; that is the whole
 * meaning of it, so the wording says what the keystroke unlocked.
 */
export function approveOutcome(argument: string, tree: SpecTree | null): ApproveOutcome {
  if (tree === null) return { kind: "refused", message: "nothing to approve — no spec is open" };
  const what = argument.trim();
  if (what === "spec") {
    return { kind: "approved", what, message: "approved: spec — the plan can be written now" };
  }
  if (what === "plan") {
    return { kind: "approved", what, message: "approved: plan — /build will run it" };
  }
  return { kind: "refused", message: 'approve what? "spec" or "plan"' };
}
```

with `import type { Approvable, SpecTree } from "../spec/project";`.

In `src/tui/app.ts`, in the slash-command dispatch beside `/spec`:

```ts
        if (input.name === "approve") {
          const outcome = approveOutcome(input.argument, spec);
          if (outcome.kind === "approved") {
            deps.sink.emit({ t: "approved", what: outcome.what });
            refreshSpec();
            transcript.notice(outcome.message, "ok");
          } else {
            transcript.notice(outcome.message, "warn");
          }
          transcript.endTurn();
          draw();
          continue;
        }
```

(`spec` is the mutable current tree and `refreshSpec` the existing helper that re-reads it; both already exist in `app.ts`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/cli/chatcmd.test.ts tests/tui/app.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/chatcmd.ts src/tui/app.ts tests/cli/chatcmd.test.ts tests/tui/app.test.ts
git commit -F - <<'MSG'
feat: /approve writes the one event only a person can

A slash command is typed by a person, is unambiguous, and needs no model
to read it — which is the point of a gate. The model has no tool that
emits `approved`, so a plan that shows as approved was approved.
MSG
```

---

### Task 5: Briefs from the plan

**Files:**
- Create: `src/sdd/brief.ts`
- Test: `tests/sdd/brief.test.ts`

**Interfaces:**
- Consumes: `specPaths`, `writeSpecFile` from `src/spec/store.ts`.
- Produces:
  ```ts
  export interface PlanTask { id: string; title: string; text: string }
  /** Splits a plan on `### Task N: Title` headings. Ids are `T<N>`. */
  export function splitPlan(markdown: string): PlanTask[];
  /** Writes briefs/<id>.md for each task and returns their paths by id. */
  export function writeBriefs(specsRoot: string, slug: string, tasks: PlanTask[]): Record<string, string>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/sdd/brief.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitPlan, writeBriefs } from "../../src/sdd/brief";

const PLAN = `# Plan

Intro that belongs to nobody.

### Task 1: Parse the flag

**Files:** a.ts

- [ ] Step 1: write the test

### Task 2: Emit JSON

Depends on Task 1.

---

### Task 3: Docs
Just the README.
`;

test("a plan splits into tasks at its headings, each carrying its own text", () => {
  const tasks = splitPlan(PLAN);
  expect(tasks.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
  expect(tasks[0]!.title).toBe("Parse the flag");
  expect(tasks[0]!.text).toContain("**Files:** a.ts");
  expect(tasks[0]!.text).not.toContain("Emit JSON");
  expect(tasks[1]!.text).toContain("Depends on Task 1.");
  expect(tasks[1]!.text).not.toContain("---");
});

test("a plan with no task headings is no tasks, not one giant task", () => {
  expect(splitPlan("# Plan\n\nnothing here\n")).toEqual([]);
});

test("briefs are written one per task, headed by the task, and their paths returned", () => {
  const root = mkdtempSync(join(tmpdir(), "vesna-briefs-"));
  const paths = writeBriefs(root, "s", splitPlan(PLAN));
  expect(Object.keys(paths)).toEqual(["T1", "T2", "T3"]);
  const t2 = readFileSync(paths.T2!, "utf8");
  expect(t2.startsWith("### Task 2: Emit JSON")).toBe(true);
  expect(t2).toContain("Depends on Task 1.");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/sdd/brief.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/sdd/brief.ts`:

```ts
import { join } from "node:path";
import { specPaths, writeSpecFile } from "../spec/store";

/**
 * A task's text, cut out of the plan.
 *
 * A worker reads its brief and never the plan. The plan is the whole
 * argument; the brief is the one task, with the exact values to use. A worker
 * handed the plan reads the other tasks, and starts doing them.
 */
export interface PlanTask {
  id: string;
  title: string;
  text: string;
}

const HEADING = /^### Task (\d+): (.+)$/;

export function splitPlan(markdown: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  let current: PlanTask | null = null;
  const body: string[] = [];

  const flush = () => {
    if (current === null) return;
    // A horizontal rule between tasks is the plan's punctuation, not the task's.
    while (body.length > 0 && /^(---|\s*)$/.test(body[body.length - 1]!)) body.pop();
    tasks.push({ ...current, text: `${current.text}\n${body.join("\n")}`.trimEnd() });
    body.length = 0;
  };

  for (const line of markdown.split("\n")) {
    const match = line.match(HEADING);
    if (match) {
      flush();
      current = { id: `T${match[1]}`, title: match[2]!.trim(), text: line };
      continue;
    }
    if (current !== null) body.push(line);
  }
  flush();
  return tasks;
}

export function writeBriefs(
  specsRoot: string,
  slug: string,
  tasks: PlanTask[],
): Record<string, string> {
  const { briefs } = specPaths(specsRoot, slug);
  const paths: Record<string, string> = {};
  for (const task of tasks) {
    const path = join(briefs, `${task.id}.md`);
    writeSpecFile(path, `${task.text}\n`);
    paths[task.id] = path;
  }
  return paths;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/sdd/brief.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sdd/brief.ts tests/sdd/brief.test.ts
git commit -F - <<'MSG'
feat: briefs cut from the plan, one per task

A worker reads its brief and never the plan: handed the plan, it reads
the other tasks and starts doing them. Task ids are T<N> from the
headings, which is what the garden's tasks are expected to be named.
MSG
```

---

### Task 6: Reviewers answer through a tool

**Files:**
- Create: `src/sdd/review.ts`
- Test: `tests/sdd/review.test.ts`

**Interfaces:**
- Consumes: `Finding` from `src/spec/project.ts`; `createSession` from `src/loop/session.ts`; `createRegistry` from `src/registry/registry.ts`; `readNode`, `grepNode`, `globNode`, `shellNode` from `src/nodes/index.ts`; `isReadOnlyCommand` from `src/policy/readonly.ts`; `Provider` from `src/providers/types.ts`.
- Produces:
  ```ts
  export interface Verdict { spec: "met" | "not_met"; findings: Finding[]; summary: string }
  export type ReviewOutcome =
    | { kind: "verdict"; verdict: Verdict; costUsd: number }
    | { kind: "no-verdict"; text: string; costUsd: number };
  export interface ReviewRequest {
    cwd: string; provider: Provider; brief: string; report: string; diff: string;
    /** For a scoped re-review: the findings the fix was meant to address. */
    findings?: Finding[];
    model?: string; maxTurns?: number; signal?: AbortSignal;
  }
  export function createVerdictNode(holder: { verdict?: Verdict }): NodeDef;
  export function reviewPrompt(request: ReviewRequest): string;
  export async function reviewTask(request: ReviewRequest): Promise<ReviewOutcome>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/sdd/review.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerdictNode, reviewPrompt, reviewTask } from "../../src/sdd/review";
import type { CompletionResult, Provider } from "../../src/providers/types";

const ctx = { cwd: "/tmp", signal: new AbortController().signal };

/** Answers with the given content blocks on the first turn, then plain text. */
function answers(first: CompletionResult["content"]): Provider & { calls: number } {
  let turn = 0;
  return {
    id: "fake",
    calls: 0,
    async complete(): Promise<CompletionResult> {
      turn += 1;
      (this as any).calls = turn;
      return {
        content: turn === 1 ? first : [{ type: "text", text: "that is all" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: turn === 1 && first.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn",
      };
    },
  };
}

test("the verdict node records what it was given and returns it", async () => {
  const holder: { verdict?: any } = {};
  const node = createVerdictNode(holder);
  const verdict = { spec: "met", findings: [], summary: "clean" };
  await node.run(verdict, ctx);
  expect(holder.verdict).toEqual(verdict);
});

test("a review that calls review_verdict is a verdict", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  const provider = answers([
    {
      type: "tool_call",
      id: "c1",
      name: "review_verdict",
      input: {
        spec: "not_met",
        findings: [{ severity: "important", file: "a.ts", line: 4, text: "off by one" }],
        summary: "one thing",
      },
    },
  ]);
  const out = await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  expect(out.kind).toBe("verdict");
  if (out.kind === "verdict") {
    expect(out.verdict.spec).toBe("not_met");
    expect(out.verdict.findings[0]!.text).toBe("off by one");
  }
});

test("a review that only talks is no verdict, and says what it said", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  const provider = answers([{ type: "text", text: "looks fine to me" }]);
  const out = await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  expect(out).toMatchObject({ kind: "no-verdict", text: "looks fine to me" });
});

test("a reviewer may read but not write", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  writeFileSync(join(cwd, "a.txt"), "before");
  const provider = answers([
    { type: "tool_call", id: "c1", name: "write", input: { path: "a.txt", text: "after" } },
  ]);
  await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("before");
});

test("a reviewer's shell is read-only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  const provider = answers([
    { type: "tool_call", id: "c1", name: "shell", input: { command: "touch made.txt" } },
  ]);
  await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(cwd, "made.txt"))).toBe(false);
});

test("the prompt carries the brief, the report and the diff, and names the tool", () => {
  const text = reviewPrompt({ cwd: "/x", provider: {} as any, brief: "BRIEF", report: "REPORT", diff: "DIFF" });
  for (const piece of ["BRIEF", "REPORT", "DIFF", "review_verdict"]) expect(text).toContain(piece);
});

test("a re-review is told which findings it is checking", () => {
  const text = reviewPrompt({
    cwd: "/x", provider: {} as any, brief: "b", report: "r", diff: "d",
    findings: [{ severity: "important", file: "a.ts", text: "the one to check" }],
  });
  expect(text).toContain("the one to check");
  expect(text).toMatch(/ADDRESSED|addressed/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/sdd/review.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/sdd/review.ts`:

```ts
import { createSession } from "../loop/session";
import { globNode, grepNode, readNode, shellNode } from "../nodes/index";
import { isReadOnlyCommand } from "../policy/readonly";
import type { Provider } from "../providers/types";
import { createRegistry } from "../registry/registry";
import type { NodeDef } from "../registry/types";
import type { Finding, Severity } from "../spec/project";

/**
 * A review is a verdict, not an opinion.
 *
 * The reviewer is a fresh session that may read and may not write, and it
 * must answer by calling `review_verdict`. Prose that never calls it is not a
 * review: the loop cannot act on "looks fine to me", and a reviewer that gets
 * to phrase its own result is the thing being checked deciding what checking
 * means. `task_verify` holds that line for the worker; this holds it for the
 * reviewer.
 */
export interface Verdict {
  spec: "met" | "not_met";
  findings: Finding[];
  summary: string;
}

export type ReviewOutcome =
  | { kind: "verdict"; verdict: Verdict; costUsd: number }
  | { kind: "no-verdict"; text: string; costUsd: number };

export interface ReviewRequest {
  cwd: string;
  provider: Provider;
  brief: string;
  report: string;
  diff: string;
  /** For a scoped re-review: the findings the fix was meant to address. */
  findings?: Finding[];
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

const SEVERITIES: readonly Severity[] = ["critical", "important", "minor"];

export function createVerdictNode(holder: { verdict?: Verdict }): NodeDef<Verdict, Verdict> {
  return {
    type: "review_verdict",
    description:
      "Deliver your review. This is the only way to finish one: spec is met or not_met, findings each with a severity (critical: wrong or unsafe; important: must fix before merge; minor: worth noting), a file, a line when you have one, and what is wrong. A review without this call did not happen.",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "string", enum: ["met", "not_met"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: [...SEVERITIES] },
              file: { type: "string" },
              line: { type: "integer" },
              text: { type: "string" },
            },
            required: ["severity", "file", "text"],
          },
        },
        summary: { type: "string" },
      },
      required: ["spec", "findings", "summary"],
    },
    effect: "pure",
    async run(input) {
      holder.verdict = input;
      return input;
    },
  };
}

export function reviewPrompt(request: ReviewRequest): string {
  const lines = [
    "You are reviewing one task in a repository. You may read files and run read-only commands. You cannot change anything.",
    "",
    "Answer by calling `review_verdict` exactly once. A review that does not call it is treated as a failed review, not a pass.",
    "",
    "Judge two things. Spec compliance: does the diff do what the brief asks, with the exact values it names, and nothing extra? Task quality: correctness, tests that would actually fail against broken code, duplication, error paths that swallow information, names that mislead.",
    "",
  ];
  if (request.findings !== undefined) {
    lines.push(
      "This is a scoped re-review of a fix. For each finding below, decide whether it is ADDRESSED or NOT ADDRESSED in the diff, and report new breakage the fix introduced. Do not re-review the rest of the task.",
      "",
      ...request.findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.text}`),
      "",
    );
  }
  lines.push(
    "## The brief",
    "",
    request.brief,
    "",
    "## The worker's report",
    "",
    request.report,
    "",
    "## The diff",
    "",
    "```diff",
    request.diff,
    "```",
  );
  return lines.join("\n");
}

export async function reviewTask(request: ReviewRequest): Promise<ReviewOutcome> {
  // Its own registry, so the reviewer is never offered a way to write.
  const registry = createRegistry();
  registry.register(readNode);
  registry.register(grepNode);
  registry.register(globNode);
  registry.register(shellNode);
  const holder: { verdict?: Verdict } = {};
  registry.register(createVerdictNode(holder));

  const session = createSession(request.provider, registry, {
    cwd: request.cwd,
    ...(request.model ? { model: request.model } : {}),
    maxTurns: request.maxTurns ?? 12,
    ...(request.signal ? { signal: request.signal } : {}),
    async approve(action) {
      if (action.node === "shell") {
        const command = typeof action.input.command === "string" ? action.input.command : "";
        return isReadOnlyCommand(command) ? "allow" : "deny";
      }
      return "allow";
    },
  });

  const result = await session.send(reviewPrompt(request));

  if (holder.verdict === undefined) {
    return { kind: "no-verdict", text: result.text, costUsd: session.costUsd };
  }
  return { kind: "verdict", verdict: holder.verdict, costUsd: session.costUsd };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/sdd/review.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS. If the `write` test fails because `write` is not in the reviewer's registry and the session reports an unknown tool rather than denying, that is still the right outcome — the file is unchanged; keep the assertion on the file.

- [ ] **Step 5: Commit**

```bash
git add src/sdd/review.ts tests/sdd/review.test.ts
git commit -F - <<'MSG'
feat: reviewers answer through a tool

A fresh session that may read and may not write, with its own registry
so it is never offered a way to, and one way to finish: call
`review_verdict`. Prose that never calls it is a failed review, not a
pass — the loop cannot act on "looks fine to me", and a reviewer that
phrases its own result is the thing being checked deciding what checking
means.
MSG
```

---

### Task 7: A builder can be resumed with findings

**Files:**
- Modify: `src/work/builder.ts`
- Test: `tests/work/builder.test.ts`

**Interfaces:**
- Consumes: the existing `BuildRequest`, `BuildResult`, `runTask`, `commit` helper, `Worktree` from `src/work/worktree.ts`.
- Produces:
  ```ts
  export interface ResumeRequest extends Omit<BuildRequest, "spec" | "objective"> {
    worktree: { path: string; branch: string };
    /** The findings, already rendered as the message the worker reads. */
    message: string;
  }
  export async function resumeTask(request: ResumeRequest): Promise<BuildResult>;
  ```

- [ ] **Step 1: Write the failing test**

Append to `tests/work/builder.test.ts` (reuse its `repository()`, `registry()` and provider helpers):

```ts
import { resumeTask } from "../../src/work/builder";

test("resuming a task works in the same checkout and adds a second commit", async () => {
  const repo = await repository();
  const first = await runTask({
    repo, spec: "s", task: "T1", objective: "write b.txt",
    provider: writes("b.txt", "one\n"), registry: registry(), policy: { mode: "auto", allow: {}, deny: {} },
  });
  expect(first.status).toBe("committed");

  const second = await resumeTask({
    repo, task: "T1", worktree: { path: first.worktree, branch: first.branch },
    message: "the file should say two",
    provider: writes("b.txt", "two\n"), registry: registry(), policy: { mode: "auto", allow: {}, deny: {} },
  });
  expect(second.status).toBe("committed");
  expect(second.worktree).toBe(first.worktree);
  expect(second.branch).toBe(first.branch);
  expect(second.commit).not.toBe(first.commit);
  expect(await readFile(join(first.worktree, "b.txt"), "utf8")).toBe("two\n");

  const log = await runGit(["log", "--oneline", first.branch], repo);
  expect(log.stdout.trim().split("\n").length).toBe(3); // first, T1 build, T1 fix
});

test("a resume that changes nothing says so rather than committing air", async () => {
  const repo = await repository();
  const first = await runTask({
    repo, spec: "s", task: "T1", objective: "write b.txt",
    provider: writes("b.txt", "one\n"), registry: registry(), policy: { mode: "auto", allow: {}, deny: {} },
  });
  const second = await resumeTask({
    repo, task: "T1", worktree: { path: first.worktree, branch: first.branch },
    message: "leave it",
    provider: writes("b.txt", "one\n"), registry: registry(), policy: { mode: "auto", allow: {}, deny: {} },
  });
  expect(second.status).toBe("no-changes");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/work/builder.test.ts`
Expected: FAIL — `resumeTask` is not exported.

- [ ] **Step 3: Implement**

In `src/work/builder.ts`, extract the session-and-commit half of `runTask` into a shared helper and add `resumeTask`:

```ts
export interface ResumeRequest extends Omit<BuildRequest, "spec" | "objective"> {
  worktree: { path: string; branch: string };
  /** The findings, already rendered as the message the worker reads. */
  message: string;
}

/**
 * A fix round. The same checkout, a fresh session, the findings as its
 * objective. The worker's memory across rounds is its report file, not its
 * context: a context that has argued itself into a corner is not the thing to
 * hand the corner back to.
 */
export async function resumeTask(request: ResumeRequest): Promise<BuildResult> {
  const tree: Worktree = { path: request.worktree.path, branch: request.worktree.branch };
  return await work(request, tree, request.message, `${request.task}: fix`);
}
```

and refactor `runTask` so that after `createWorktree` succeeds it calls
`return await work(request, tree, request.objective, \`${request.task}: built by vesna\`);`
where `work` is:

```ts
async function work(
  request: Omit<BuildRequest, "spec" | "objective">,
  tree: Worktree,
  objective: string,
  commitMessage: string,
): Promise<BuildResult> {
  const git = request.git ?? runGit;
  const refusals: string[] = [];
  const session = createSession(request.provider, request.registry, {
    cwd: tree.path,
    ...(request.model ? { model: request.model } : {}),
    maxTurns: request.maxTurns ?? 16,
    ...(request.signal ? { signal: request.signal } : {}),
    async approve(action) {
      if (request.maxUsd !== undefined && session.costUsd >= request.maxUsd) {
        refusals.push(`budget of $${request.maxUsd.toFixed(2)} reached`);
        return "deny";
      }
      const verdict = decide({ ...action, cwd: tree.path }, request.policy, tree.path);
      if (verdict === "allow") return "allow";
      // No user is watching, so a question is a refusal with a reason.
      refusals.push(`${action.node} ${describe(action.input)}`);
      return "deny";
    },
  });

  let text = "";
  let error: string | undefined;
  try {
    text = (await session.send(objective)).text;
  } catch (failure) {
    error = (failure as Error).message;
  }

  let committed: string | null = null;
  try {
    committed = await commit(tree, commitMessage, git);
  } catch (failure) {
    const message = (failure as Error).message;
    error = error === undefined ? message : `${error}; ${message}`;
  }

  return {
    task: request.task,
    status:
      error !== undefined ? "failed"
      : refusals.length > 0 ? "refused"
      : committed === null ? "no-changes"
      : "committed",
    branch: tree.branch,
    worktree: tree.path,
    ...(committed ? { commit: committed } : {}),
    refusals,
    costUsd: session.costUsd,
    text,
    ...(error !== undefined ? { error } : {}),
  };
}
```

Change `commit(tree, task, git)`'s second parameter from the task id to the full message (`commit(tree: Worktree, message: string, git: GitRunner)`) and use `message` in `git commit -qm`. The existing `runTask` tests assert on `status` and file contents, not on the commit message text; if one does assert `built by vesna`, it still holds.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/work/builder.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/work/builder.ts tests/work/builder.test.ts
git commit -F - <<'MSG'
feat: a builder can be resumed with findings

The same checkout, a fresh session, the findings as its objective, and
one more commit on the task's branch. The worker's memory across rounds
is its report file rather than its context: a context that has argued
itself into a corner is not the thing to hand the corner back to.
MSG
```

---

### Task 8: The build loop — brief, build, review, fix rounds, per-task merge

**Files:**
- Create: `src/sdd/loop.ts`
- Test: `tests/sdd/loop.test.ts`

**Interfaces:**
- Consumes: `project`, `readEvents`, `appendEvent`, `specPaths`, `readSpecFile`, `writeSpecFile` from `src/spec/*`; `splitPlan`, `writeBriefs` from `src/sdd/brief.ts`; `reviewTask`, `Verdict`, `ReviewOutcome` from `src/sdd/review.ts`; `runTask`, `resumeTask`, `BuildResult` from `src/work/builder.ts`; `mergeAll`, `MergeReport` from `src/work/merge.ts`; `schedule` from `src/work/schedule.ts`; `runGit`, `GitRunner` from `src/work/worktree.ts`.
- Produces:
  ```ts
  export interface BuildLoopRequest {
    root: string;            // the repository
    specsRoot: string;       // usually specsRoot(root)
    slug: string;
    provider: Provider;
    registry: Registry;
    policy: Policy;
    model?: string;
    maxRounds?: number;      // default 5
    maxUsd?: number;
    signal?: AbortSignal;
    git?: GitRunner;
    onEvent?: (event: SpecEvent) => void;
    /** Seams for tests. Defaults are the real functions. */
    build?: typeof runTask;
    resume?: typeof resumeTask;
    review?: typeof reviewTask;
    merge?: typeof mergeAll;
  }
  export type BuildOutcome =
    | { status: "done" }
    | { status: "stopped"; reason: string }
    | { status: "could-not-start"; reason: string };
  export function renderFindings(findings: Finding[]): string;
  export async function runBuild(request: BuildLoopRequest): Promise<BuildOutcome>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/sdd/loop.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, renderFindings } from "../../src/sdd/loop";
import { appendEvent, createSpec, readEvents, specPaths, writeSpecFile } from "../../src/spec/store";
import type { Finding, SpecEvent } from "../../src/spec/project";
import type { BuildResult } from "../../src/work/builder";
import type { ReviewOutcome } from "../../src/sdd/review";
import type { MergeReport } from "../../src/work/merge";
import { createRegistry } from "../../src/registry/registry";

const PLAN = `# Plan

### Task 1: First
Do the first thing.

### Task 2: Second
Do the second thing.
`;

function setup(events: SpecEvent[]) {
  const root = mkdtempSync(join(tmpdir(), "vesna-loop-"));
  const specs = join(root, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of events) appendEvent(specs, "work", e);
  writeSpecFile(specPaths(specs, "work").plan, PLAN);
  return { root, specs };
}

const approvedWithTasks: SpecEvent[] = [
  { t: "task.added", id: "T1", title: "First" },
  { t: "task.added", id: "T2", title: "Second", dependsOn: ["T1"] },
  { t: "approved", what: "spec" },
  { t: "approved", what: "plan" },
];

function built(task: string, n: number): BuildResult {
  return {
    task, status: "committed", branch: `vesna/work/${task}`, worktree: `/wt/${task}`,
    commit: `sha-${task}-${n}`, refusals: [], costUsd: 0.01, text: "did it",
  };
}
const clean: ReviewOutcome = { kind: "verdict", verdict: { spec: "met", findings: [], summary: "ok" }, costUsd: 0.01 };
const mergedOk = (task: string): MergeReport => ({ merged: [{ task, branch: `vesna/work/${task}` }], pending: [] });

function fakes(overrides: Partial<{
  build: (task: string) => BuildResult;
  reviews: ReviewOutcome[];
  merge: (task: string) => MergeReport;
}> = {}) {
  const log: string[] = [];
  const reviews = [...(overrides.reviews ?? [])];
  let resumes = 0;
  return {
    log,
    seams: {
      build: async (r: any) => { log.push(`build ${r.task}`); return (overrides.build ?? ((t: string) => built(t, 1)))(r.task); },
      resume: async (r: any) => { resumes += 1; log.push(`resume ${r.task}`); return built(r.task, 1 + resumes); },
      review: async (r: any) => { log.push(`review`); return reviews.shift() ?? clean; },
      merge: async (_repo: string, c: { task: string }[]) => { log.push(`merge ${c[0]!.task}`); return (overrides.merge ?? mergedOk)(c[0]!.task); },
    },
    git: async () => ({ code: 0, stdout: "diff", stderr: "" }),
  };
}

function base(root: string, specs: string, f: ReturnType<typeof fakes>, extra = {}) {
  return {
    root, specsRoot: specs, slug: "work",
    provider: {} as any, registry: createRegistry(), policy: { mode: "auto" as const, allow: {}, deny: {} },
    git: f.git, ...f.seams, ...extra,
  };
}

test("a plan nobody approved cannot start, and says so", async () => {
  const { root, specs } = setup([{ t: "task.added", id: "T1", title: "First" }, { t: "approved", what: "spec" }]);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "could-not-start", reason: "the plan is not approved — /approve plan" });
  expect(f.log).toEqual([]);
});

test("a dependent task does not start until the one it waits on has merged", async () => {
  const { root, specs } = setup(approvedWithTasks);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "done" });
  expect(f.log).toEqual(["build T1", "review", "merge T1", "build T2", "review", "merge T2", "review"]);
  const tree = readEvents(specs, "work");
  expect(tree.filter((e) => e.t === "task.done").map((e: any) => e.id)).toEqual(["T1", "T2"]);
  expect(tree.some((e) => e.t === "build.done")).toBe(true);
});

test("an important finding produces a fix round and a scoped re-review", async () => {
  const { root, specs } = setup(approvedWithTasks);
  const bad: Finding = { severity: "important", file: "a.ts", line: 2, text: "wrong" };
  const f = fakes({
    reviews: [
      { kind: "verdict", verdict: { spec: "met", findings: [bad], summary: "one" }, costUsd: 0 },
      clean, // re-review of T1
      clean, // T2
      clean, // final
    ],
  });
  await runBuild(base(root, specs, f));
  expect(f.log.slice(0, 5)).toEqual(["build T1", "review", "resume T1", "review", "merge T1"]);
});

test("at the cap, important findings park and the task still merges", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const bad: Finding = { severity: "important", file: "a.ts", text: "stubborn" };
  const always: ReviewOutcome = { kind: "verdict", verdict: { spec: "met", findings: [bad], summary: "" }, costUsd: 0 };
  const f = fakes({ reviews: [always, always, always, always, always, always, clean] });
  const out = await runBuild(base(root, specs, f, { maxRounds: 5 }));
  expect(out).toEqual({ status: "done" });
  expect(f.log.filter((l) => l === "resume T1").length).toBe(5);
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "parked")).toEqual([{ t: "parked", task: "T1", finding: bad }]);
  expect(events.some((e) => e.t === "task.done" && (e as any).id === "T1")).toBe(true);
});

test("a critical still open at the cap stops the build for a person", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const bad: Finding = { severity: "critical", file: "a.ts", text: "unsafe" };
  const always: ReviewOutcome = { kind: "verdict", verdict: { spec: "met", findings: [bad], summary: "" }, costUsd: 0 };
  const f = fakes({ reviews: Array(6).fill(always) });
  const out = await runBuild(base(root, specs, f, { maxRounds: 5 }));
  expect(out).toEqual({ status: "stopped", reason: "T1: a critical finding is still open after 5 fix rounds — unsafe" });
  const events = readEvents(specs, "work");
  expect(events.some((e) => e.t === "build.stopped")).toBe(true);
  expect(events.some((e) => e.t === "task.done")).toBe(false);
});

test("a merge conflict stops the loop and names the task", async () => {
  const { root, specs } = setup(approvedWithTasks);
  const f = fakes({
    merge: (task) => task === "T1"
      ? { merged: [], conflict: { task, branch: "b", files: ["a.ts"] }, pending: ["T2"] }
      : mergedOk(task),
  });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "stopped", reason: "T1: merge conflict in a.ts" });
  expect(f.log).not.toContain("build T2");
});

test("a review that produces no verdict is a failed review, and a second try is allowed once", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const silent: ReviewOutcome = { kind: "no-verdict", text: "seems fine", costUsd: 0 };
  const f = fakes({ reviews: [silent, clean, clean] });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "done" });
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "review.failed").length).toBe(1);
});

test("two silent reviews in a row stop the build", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const silent: ReviewOutcome = { kind: "no-verdict", text: "seems fine", costUsd: 0 };
  const f = fakes({ reviews: [silent, silent] });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "stopped", reason: "T1: the reviewer produced no verdict twice" });
});

test("a worker that refused stops the build with what it could not do", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const f = fakes({ build: (task) => ({ ...built(task, 1), status: "refused", refusals: ["shell rm -rf x"] }) });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "stopped", reason: "T1: the worker was not allowed to: shell rm -rf x" });
});

test("findings render one per line with severity, place and text", () => {
  expect(renderFindings([
    { severity: "important", file: "a.ts", line: 2, text: "wrong" },
    { severity: "minor", file: "b.ts", text: "nit" },
  ])).toBe("- [important] a.ts:2 — wrong\n- [minor] b.ts — nit");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/sdd/loop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/sdd/loop.ts`:

```ts
import { join } from "node:path";
import type { Policy } from "../policy/decide";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import { project, type Finding, type SpecEvent, type Task } from "../spec/project";
import { appendEvent, readEvents, readSpecFile, specPaths, writeSpecFile } from "../spec/store";
import { resumeTask, runTask, type BuildResult } from "../work/builder";
import { mergeAll } from "../work/merge";
import { schedule } from "../work/schedule";
import { runGit, type GitRunner } from "../work/worktree";
import { splitPlan, writeBriefs } from "./brief";
import { reviewTask, type ReviewOutcome } from "./review";

/**
 * The loop.
 *
 * For each task the plan names, in dependency order: cut its brief, build it
 * in a checkout of its own, review the diff, fix what the review found, and
 * merge — then the next. Merging per task rather than all at the end is not
 * optional: a task that depends on another's code has to branch from a tree
 * that has it.
 *
 * Every step is an event in the spec's log, so the garden shows it as it
 * happens and a person who comes back later can read what was decided.
 */
export interface BuildLoopRequest {
  root: string;
  specsRoot: string;
  slug: string;
  provider: Provider;
  registry: Registry;
  policy: Policy;
  model?: string;
  /** Fix rounds per task. Five is the cap; past it, rounds do not converge. */
  maxRounds?: number;
  maxUsd?: number;
  signal?: AbortSignal;
  git?: GitRunner;
  onEvent?: (event: SpecEvent) => void;
  build?: typeof runTask;
  resume?: typeof resumeTask;
  review?: typeof reviewTask;
  merge?: typeof mergeAll;
}

export type BuildOutcome =
  | { status: "done" }
  | { status: "stopped"; reason: string }
  | { status: "could-not-start"; reason: string };

class Stop extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function renderFindings(findings: Finding[]): string {
  return findings
    .map((f) => `- [${f.severity}] ${f.file}${f.line !== undefined ? `:${f.line}` : ""} — ${f.text}`)
    .join("\n");
}

const blocking = (f: Finding) => f.severity !== "minor";

export async function runBuild(request: BuildLoopRequest): Promise<BuildOutcome> {
  const { specsRoot, slug } = request;
  const git = request.git ?? runGit;
  const build = request.build ?? runTask;
  const resume = request.resume ?? resumeTask;
  const review = request.review ?? reviewTask;
  const merge = request.merge ?? mergeAll;
  const maxRounds = request.maxRounds ?? 5;
  const paths = specPaths(specsRoot, slug);

  const emit = (event: SpecEvent) => {
    appendEvent(specsRoot, slug, event);
    request.onEvent?.(event);
  };

  const tree = project(readEvents(specsRoot, slug));
  if (tree === null) return { status: "could-not-start", reason: `no spec called "${slug}"` };
  if (!tree.approved.plan) {
    return { status: "could-not-start", reason: "the plan is not approved — /approve plan" };
  }
  const planText = readSpecFile(paths.plan);
  if (planText === null) return { status: "could-not-start", reason: "there is no plan.md to build" };
  const planTasks = splitPlan(planText);
  if (planTasks.length === 0) return { status: "could-not-start", reason: "plan.md names no tasks" };
  if (tree.tasks.length === 0) return { status: "could-not-start", reason: "the log names no tasks" };

  const briefs = writeBriefs(specsRoot, slug, planTasks);
  emit({ t: "build.started" });

  const one = async (task: Task): Promise<BuildResult> => {
    const brief = readSpecFile(briefs[task.id] ?? "") ?? task.title;
    emit({ t: "task.started", id: task.id, agent: "vesna build" });

    const common = {
      repo: request.root,
      task: task.id,
      provider: request.provider,
      registry: request.registry,
      policy: request.policy,
      ...(request.model ? { model: request.model } : {}),
      ...(request.maxUsd !== undefined ? { maxUsd: request.maxUsd } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      git,
    };

    let result = await build({ ...common, spec: slug, objective: brief });
    let report = `# ${task.id}\n\n${result.text}\n`;
    writeSpecFile(join(paths.reports, `${task.id}.md`), report);

    if (result.status === "refused") {
      throw new Stop(`${task.id}: the worker was not allowed to: ${result.refusals.join("; ")}`);
    }
    if (result.status === "failed") throw new Stop(`${task.id}: ${result.error ?? "the build failed"}`);

    let round = 0;
    let silent = 0;
    let open: Finding[] | undefined;
    for (;;) {
      const diff = await git(["diff", `main...${result.branch}`], request.root);
      const outcome: ReviewOutcome = await review({
        cwd: result.worktree,
        provider: request.provider,
        brief,
        report,
        diff: diff.stdout,
        ...(open !== undefined ? { findings: open } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });

      if (outcome.kind === "no-verdict") {
        silent += 1;
        emit({ t: "review.failed", task: task.id, round, reason: "no verdict" });
        writeSpecFile(join(paths.reviews, `${task.id}-r${round}.md`), `(no verdict)\n\n${outcome.text}\n`);
        if (silent >= 2) throw new Stop(`${task.id}: the reviewer produced no verdict twice`);
        continue;
      }
      silent = 0;
      const { verdict } = outcome;
      emit({ t: "review.done", task: task.id, round, spec: verdict.spec, findings: verdict.findings });
      writeSpecFile(
        join(paths.reviews, `${task.id}-r${round}.md`),
        `spec: ${verdict.spec}\n\n${verdict.summary}\n\n${renderFindings(verdict.findings)}\n`,
      );

      open = verdict.findings.filter(blocking);
      if (verdict.spec === "met" && open.length === 0) break;

      if (round >= maxRounds) {
        const critical = open.find((f) => f.severity === "critical");
        if (critical !== undefined) {
          throw new Stop(
            `${task.id}: a critical finding is still open after ${maxRounds} fix rounds — ${critical.text}`,
          );
        }
        for (const finding of verdict.findings) emit({ t: "parked", task: task.id, finding });
        break;
      }

      round += 1;
      const message = [
        `Review round ${round} found the following. Fix each, re-run the tests that cover it, and say what you changed.`,
        "",
        verdict.spec === "not_met" ? "The reviewer judged the brief NOT MET." : "",
        renderFindings(open),
      ].join("\n");
      result = await resume({ ...common, worktree: { path: result.worktree, branch: result.branch }, message });
      report += `\n## Fix round ${round}\n\n${result.text}\n`;
      writeSpecFile(join(paths.reports, `${task.id}.md`), report);
      if (result.status === "failed") throw new Stop(`${task.id}: fix round ${round} failed — ${result.error}`);
    }

    const merged = await merge(request.root, [{ task: task.id, branch: result.branch }], git);
    if (merged.conflict) throw new Stop(`${task.id}: merge conflict in ${merged.conflict.files.join(", ")}`);
    if (merged.error) throw new Stop(`${task.id}: ${merged.error.message}`);

    emit({ t: "task.done", id: task.id, ...(result.commit ? { commit: result.commit } : {}) });
    return result;
  };

  try {
    await schedule<BuildResult>({
      tasks: tree.tasks,
      concurrency: 1,
      run: one,
      succeeded: () => true,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    // One more pair of eyes over the whole branch, with the parked findings
    // beside it. Nothing is fixed here; the person decides.
    const whole = await git(["diff", "main~0...HEAD"], request.root);
    const parked = project(readEvents(specsRoot, slug))?.parked ?? [];
    const final = await review({
      cwd: request.root,
      provider: request.provider,
      brief: `The whole branch for spec "${slug}". Parked findings from the task reviews:\n${renderFindings(parked.map((p) => p.finding)) || "(none)"}`,
      report: "(whole-branch review)",
      diff: whole.stdout,
      ...(request.model ? { model: request.model } : {}),
    });
    if (final.kind === "verdict") {
      emit({ t: "review.done", task: "branch", round: 0, spec: final.verdict.spec, findings: final.verdict.findings });
      writeSpecFile(join(paths.reviews, "branch.md"), `${final.verdict.summary}\n\n${renderFindings(final.verdict.findings)}\n`);
    } else {
      emit({ t: "review.failed", task: "branch", round: 0, reason: "no verdict" });
    }

    emit({ t: "build.done" });
    return { status: "done" };
  } catch (error) {
    if (error instanceof Stop) {
      emit({ t: "build.stopped", reason: error.reason });
      return { status: "stopped", reason: error.reason };
    }
    throw error;
  }
}
```

Notes for the implementer: the `git diff main...branch` assumes the repository's base branch is `main`; read the current branch name once at the start with `git rev-parse --abbrev-ref HEAD` and use it in place of the literal `main`, so a repository on `master` works. The final-review diff should be from the commit the build started at (record `git rev-parse HEAD` before the schedule) to `HEAD`. The tests' fake `git` returns `stdout: "diff"` for everything, so they do not depend on those details, but the real command line does.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/sdd/loop.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sdd/loop.ts tests/sdd/loop.test.ts
git commit -F - <<'MSG'
feat: the build loop

Brief, build, review, fix rounds, merge — per task, in dependency order,
every step an event in the spec's log. Merging per task rather than all
at the end is not a preference: a task that depends on another's code
has to branch from a tree that has it.

Five fix rounds at most. At the cap an Important or Minor finding is
parked on the record; a Critical still open stops the build for a
person, because five rounds that could not close it is a structural
problem and not one more round's worth of work. A reviewer that never
calls review_verdict is a failed review; twice in a row stops the build
rather than advancing on an opinion.
MSG
```

---

### Task 9: `vesna build <slug>`

**Files:**
- Create: `src/cli/buildcmd.ts`
- Modify: `src/cli/main.ts` (`Command`, `COMMANDS`, `needsProvider`, `USAGE`, dispatch)
- Test: `tests/cli/buildcmd.test.ts`, `tests/cli/dispatch.test.ts`

**Interfaces:**
- Consumes: `runBuild`, `BuildOutcome` from `src/sdd/loop.ts`; `buildContext` from `src/cli/context.ts`; `specsRoot` from `src/spec/store.ts`; `EXIT` from `src/cli/exit.ts`.
- Produces:
  ```ts
  export function exitFor(outcome: BuildOutcome): 0 | 1 | 2;
  export function describeEvent(event: SpecEvent): string | null;  // one line, or null for events not worth printing
  export async function buildCommand(slug: string | undefined, root: string, ...): Promise<number>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/buildcmd.test.ts`:

```ts
import { test, expect } from "bun:test";
import { exitFor, describeEvent } from "../../src/cli/buildcmd";

test("exit codes: done is 0, stopped for a person is 1, could not start is 2", () => {
  expect(exitFor({ status: "done" })).toBe(0);
  expect(exitFor({ status: "stopped", reason: "x" })).toBe(1);
  expect(exitFor({ status: "could-not-start", reason: "x" })).toBe(2);
});

test("events print as one line each, and the ones that are noise print nothing", () => {
  expect(describeEvent({ t: "task.started", id: "T1", agent: "vesna build" })).toBe("T1  building");
  expect(describeEvent({ t: "review.done", task: "T1", round: 0, spec: "met", findings: [] })).toBe("T1  review: met, 0 findings");
  expect(describeEvent({ t: "review.done", task: "T1", round: 2, spec: "not_met", findings: [{ severity: "important", file: "a", text: "b" }] })).toBe("T1  review round 2: not met, 1 finding");
  expect(describeEvent({ t: "task.done", id: "T1", commit: "abc1234def" })).toBe("T1  merged abc1234");
  expect(describeEvent({ t: "parked", task: "T1", finding: { severity: "minor", file: "a.ts", text: "nit" } })).toBe("T1  parked: [minor] a.ts — nit");
  expect(describeEvent({ t: "build.stopped", reason: "why" })).toBe("stopped: why");
  expect(describeEvent({ t: "build.done" })).toBe("done");
  expect(describeEvent({ t: "criterion.added", id: "c", text: "t" })).toBeNull();
});
```

Append to `tests/cli/dispatch.test.ts`, in the test that lists routes needing a provider, add `"build"` to the array.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli/buildcmd.test.ts tests/cli/dispatch.test.ts`
Expected: FAIL — module not found; `"build"` is not a `Route`.

- [ ] **Step 3: Implement**

Create `src/cli/buildcmd.ts`:

```ts
import type { SpecEvent } from "../spec/project";
import { specsRoot } from "../spec/store";
import { runBuild, type BuildOutcome, renderFindings } from "../sdd/loop";
import type { Policy } from "../policy/decide";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import type { Theme } from "../tui/theme";
import { EXIT } from "./exit";

/**
 * The loop from the shell. Prints each event as it happens and exits with
 * what happened: done, stopped for a person, or never started. This is the
 * surface a later client calls once someone has approved the plan from
 * wherever they are.
 */
export function exitFor(outcome: BuildOutcome): 0 | 1 | 2 {
  if (outcome.status === "done") return EXIT.ok;
  if (outcome.status === "stopped") return EXIT.held;
  return EXIT.error;
}

export function describeEvent(event: SpecEvent): string | null {
  switch (event.t) {
    case "task.started":
      return `${event.id}  building`;
    case "review.done": {
      const n = event.findings.length;
      const where = event.round === 0 ? "review" : `review round ${event.round}`;
      return `${event.task}  ${where}: ${event.spec === "met" ? "met" : "not met"}, ${n} finding${n === 1 ? "" : "s"}`;
    }
    case "review.failed":
      return `${event.task}  review: no verdict`;
    case "task.done":
      return `${event.id}  merged${event.commit ? ` ${event.commit.slice(0, 7)}` : ""}`;
    case "task.failed":
      return `${event.id}  failed${event.reason ? `: ${event.reason}` : ""}`;
    case "parked":
      return `${event.task}  parked: ${renderFindings([event.finding]).slice(2)}`;
    case "ruling":
      return `ruling: ${event.text}`;
    case "build.stopped":
      return `stopped: ${event.reason}`;
    case "build.done":
      return "done";
    default:
      return null;
  }
}

export async function buildCommand(
  slug: string | undefined,
  root: string,
  deps: { provider: Provider; registry: Registry; policy: Policy; theme: Theme; model?: string },
): Promise<number> {
  if (slug === undefined || slug === "") {
    console.error("vesna: build needs a spec — vesna build <slug>");
    return EXIT.error;
  }
  const outcome = await runBuild({
    root,
    specsRoot: specsRoot(root),
    slug,
    provider: deps.provider,
    registry: deps.registry,
    policy: deps.policy,
    ...(deps.model ? { model: deps.model } : {}),
    onEvent: (event) => {
      const line = describeEvent(event);
      if (line !== null) console.log(`  ${deps.theme.paint("petal", "·")} ${line}`);
    },
  });
  if (outcome.status !== "done") console.error(`vesna: ${outcome.reason}`);
  return exitFor(outcome);
}
```

In `src/cli/main.ts`: add `"build"` to `Command` and `COMMANDS`; add `case "build":` to the `return true` group in `needsProvider`; add a usage line `"  vesna build <slug>                      run an approved plan: build, review, merge"`; and after the `do` block:

```ts
  if (command === "build") {
    return await buildCommand(target, root, { provider, registry, policy, theme, model: flags.model ?? config.model });
  }
```

with `import { buildCommand } from "./buildcmd";`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/cli/buildcmd.test.ts tests/cli/dispatch.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/buildcmd.ts src/cli/main.ts tests/cli/buildcmd.test.ts tests/cli/dispatch.test.ts
git commit -F - <<'MSG'
feat: vesna build <slug>

The loop from the shell: one line per event, and an exit code that says
what happened — 0 done, 1 stopped for a person, 2 never started. This is
the surface a later client calls once someone has approved the plan from
wherever they are.
MSG
```

---

### Task 10: `/build` in the chat, and review marks in the garden

**Files:**
- Modify: `src/cli/chatcmd.ts` (`/build` entry, `buildOutcome`)
- Modify: `src/tui/app.ts` (`/build` handler)
- Modify: `src/tui/panes.ts` (review marks)
- Test: `tests/cli/chatcmd.test.ts`, `tests/tui/panes.test.ts`, `tests/tui/app.test.ts`

**Interfaces:**
- Consumes: `runBuild` from `src/sdd/loop.ts`; `describeEvent` from `src/cli/buildcmd.ts`; `SpecTree.reviews`, `.parked` from `src/spec/project.ts`.
- Produces:
  ```ts
  export function buildStart(tree: SpecTree | null): { kind: "start"; message: string } | { kind: "refused"; message: string };
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/cli/chatcmd.test.ts`:

```ts
import { buildStart } from "../../src/cli/chatcmd";

test("/build is a command", () => {
  expect(CHAT_COMMANDS.map((c) => c.name)).toContain("build");
});

test("/build with no spec is refused", () => {
  expect(buildStart(null)).toEqual({ kind: "refused", message: "nothing to build — no spec is open" });
});

test("/build on an unapproved plan is refused, naming the command", () => {
  const t = project([{ t: "created", id: "x", title: "X" }, { t: "task.added", id: "T1", title: "a" }]);
  expect(buildStart(t)).toEqual({ kind: "refused", message: "the plan is not approved — /approve plan" });
});

test("/build on an approved plan starts, and says how many tasks", () => {
  const t = project([
    { t: "created", id: "x", title: "X" },
    { t: "task.added", id: "T1", title: "a" },
    { t: "task.added", id: "T2", title: "b" },
    { t: "approved", what: "plan" },
  ]);
  expect(buildStart(t)).toEqual({ kind: "start", message: "building 2 tasks — events appear below and in the garden" });
});

test("/build while a build is running is refused", () => {
  const t = project([
    { t: "created", id: "x", title: "X" },
    { t: "task.added", id: "T1", title: "a" },
    { t: "approved", what: "plan" },
    { t: "build.started" },
  ]);
  expect(buildStart(t)).toEqual({ kind: "refused", message: "a build is already running" });
});
```

Append to `tests/tui/panes.test.ts` (use its existing `options`/theme fixture; look at how the garden tests build a tree):

```ts
test("a task under review shows the review's outcome beside it", () => {
  const tree = project([
    { t: "created", id: "x", title: "X" },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "task.added", id: "T1", title: "First" },
    { t: "task.started", id: "T1", agent: "vesna build" },
    { t: "review.done", task: "T1", round: 1, spec: "met", findings: [{ severity: "important", file: "a", text: "b" }] },
  ])!;
  const text = gardenPane(tree, options({ width: 40, rows: 12 })).lines.join("\n");
  expect(text).toContain("First");
  expect(text).toContain("review 1: 1 open");
});

test("parked findings are listed under the task, not hidden", () => {
  const tree = project([
    { t: "created", id: "x", title: "X" },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "task.added", id: "T1", title: "First" },
    { t: "parked", task: "T1", finding: { severity: "minor", file: "a.ts", text: "nit" } },
    { t: "task.done", id: "T1" },
  ])!;
  const text = gardenPane(tree, options({ width: 40, rows: 12 })).lines.join("\n");
  expect(text).toContain("parked: a.ts — nit");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli/chatcmd.test.ts tests/tui/panes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/cli/chatcmd.ts`, add to `CHAT_COMMANDS` after `approve`:

```ts
  { name: "build", help: "run the approved plan: build, review, merge, one task at a time" },
```

and export:

```ts
export function buildStart(
  tree: SpecTree | null,
): { kind: "start"; message: string } | { kind: "refused"; message: string } {
  if (tree === null) return { kind: "refused", message: "nothing to build — no spec is open" };
  if (tree.building) return { kind: "refused", message: "a build is already running" };
  if (!tree.approved.plan) return { kind: "refused", message: "the plan is not approved — /approve plan" };
  const n = tree.tasks.length;
  return {
    kind: "start",
    message: `building ${n} task${n === 1 ? "" : "s"} — events appear below and in the garden`,
  };
}
```

In `src/tui/app.ts`, beside `/approve`:

```ts
        if (input.name === "build") {
          const start = buildStart(spec);
          if (start.kind === "refused") {
            transcript.notice(start.message, "warn");
            transcript.endTurn();
            draw();
            continue;
          }
          transcript.notice(start.message, "ok");
          transcript.endTurn();
          draw();
          // Runs alongside the conversation. Each event redraws the garden and
          // adds a line, so the person watches it happen rather than waiting.
          void runBuild({
            root: deps.root,
            specsRoot: specsRoot(deps.root),
            slug: deps.sink.slug!,
            provider: deps.provider,
            registry: deps.registry,
            policy,
            onEvent: (event) => {
              const line = describeEvent(event);
              if (line !== null) transcript.notice(line, event.t === "build.stopped" ? "warn" : "muted");
              refreshSpec();
              draw();
            },
          }).then((outcome) => {
            if (outcome.status !== "done") transcript.notice(outcome.reason, "warn");
            refreshSpec();
            draw();
          });
          continue;
        }
```

(`policy` is the mutable current policy in `app.ts`; `deps.sink.slug` is non-null whenever `spec` is non-null.)

In `src/tui/panes.ts`, inside the `build` stage's task loop, after the task line and before the `agent` line:

```ts
        const review = tree.reviews[task.id];
        if (review !== undefined) {
          const label =
            review.spec === "not_met"
              ? `review ${review.round}: not met`
              : `review ${review.round}: ${review.open.length} open`;
          lines.push({
            text: `    ${theme.paint(review.open.length > 0 || review.spec === "not_met" ? "warn" : "ice", mark("◆"))} ${theme.paint("muted", truncate(label, width - 6))}`,
          });
        }
        for (const parked of tree.parked.filter((p) => p.task === task.id)) {
          const where = `${parked.finding.file}${parked.finding.line !== undefined ? `:${parked.finding.line}` : ""}`;
          lines.push({
            text: `    ${theme.paint("faint", mark("○"))} ${theme.paint("muted", truncate(`parked: ${where} — ${parked.finding.text}`, width - 6))}`,
          });
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/cli/chatcmd.test.ts tests/tui/panes.test.ts tests/tui/app.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/chatcmd.ts src/tui/app.ts src/tui/panes.ts tests/cli/chatcmd.test.ts tests/tui/panes.test.ts
git commit -F - <<'MSG'
feat: /build in the chat, with the garden showing reviews as they land

The loop runs beside the conversation. Each event adds a line and
redraws the column, so a task under review shows the review's outcome
next to it and a parked finding is listed rather than hidden. Refused
when nothing is open, when the plan is not approved, or when a build is
already running — each with the words that say what to do.
MSG
```

---

### Task 11: Phase prompts — the model knows which phase it is in

**Files:**
- Modify: `src/loop/prompt.ts`
- Modify: `src/tui/app.ts` (pass the stage and spec paths into the prompt context)
- Test: `tests/loop/prompt.test.ts`

**Interfaces:**
- Consumes: `Stage`, `SpecTree` from `src/spec/project.ts`; `specPaths` from `src/spec/store.ts`.
- Produces: `PromptContext` gains `phase?: { stage: Stage; specPath: string; planPath: string }`; `export function phaseSection(phase): string`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/loop/prompt.test.ts`:

```ts
import { phaseSection, systemPrompt } from "../../src/loop/prompt";

const phase = (stage: any) => ({ stage, specPath: "/r/.vesna/specs/x/spec.md", planPath: "/r/.vesna/specs/x/plan.md" });

test("in design, the prompt asks for classification first and forbids code", () => {
  const text = phaseSection(phase("design"));
  expect(text).toContain("classify");
  expect(text).toMatch(/do not write code|no code/i);
});

test("in spec, the prompt names the file to write and the command that approves it", () => {
  const text = phaseSection(phase("spec"));
  expect(text).toContain("/r/.vesna/specs/x/spec.md");
  expect(text).toContain("/approve spec");
});

test("in plan, the prompt names plan.md, the heading shape, and the ids the tasks must use", () => {
  const text = phaseSection(phase("plan"));
  expect(text).toContain("/r/.vesna/specs/x/plan.md");
  expect(text).toContain("### Task 1:");
  expect(text).toContain("T1");
  expect(text).toContain("/approve plan");
});

test("in build, the prompt says the loop is running and the model is not the worker", () => {
  const text = phaseSection(phase("build"));
  expect(text).toMatch(/\/build|running/);
});

test("with no phase the system prompt has no phase section", () => {
  const text = systemPrompt({ cwd: "/r", tools: [] } as any);
  expect(text).not.toContain("/approve");
});
```

(Check `PromptContext`'s required fields in `src/loop/prompt.ts:17-25` and fill them in the last test.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/loop/prompt.test.ts`
Expected: FAIL — `phaseSection` not exported.

- [ ] **Step 3: Implement**

In `src/loop/prompt.ts`, add to `PromptContext`:

```ts
  /** Which phase of the process the open spec is in, when one is open. */
  phase?: { stage: Stage; specPath: string; planPath: string };
```

and export:

```ts
/**
 * What the model should be doing right now, given where the work stands.
 *
 * The conversational phases are prompts the model follows; the mechanical
 * ones are a loop Vesna runs. The prompt says which is which so the model
 * does not try to build in a phase where building is the loop's job.
 */
export function phaseSection(phase: NonNullable<PromptContext["phase"]>): string {
  switch (phase.stage) {
    case "design":
      return [
        "## Phase: design",
        "Before anything else, call `classify` to say what shape this work is — spike, bounded, or architectural — and why. When in doubt choose the heavier shape. Then understand the request: ask one question at a time, propose two or three approaches with a recommendation, and do not write code. A spike ends in an answer. A bounded change is designed here in the conversation and then built. An architectural change gets a written design next.",
      ].join("\n");
    case "spec":
      return [
        "## Phase: spec",
        `Write the design to \`${phase.specPath}\` with the write tool: the problem, the decisions with their reasons, what is out of scope, and how it will be tested. Then stop and ask the person to read it. They approve it with \`/approve spec\`; you cannot.`,
      ].join("\n");
    case "plan":
      return [
        "## Phase: plan",
        `Write the plan to \`${phase.planPath}\`: one section per task, headed exactly \`### Task 1: <title>\`, \`### Task 2: <title>\` and so on. Each task is the smallest unit with its own test cycle, and its section contains everything a worker with no other context needs — files, the exact test code, the exact implementation, the commit message. Then call \`plan\` with the same tasks, ids \`T1\`, \`T2\` ... matching the headings, and their dependencies. Then stop. The person approves with \`/approve plan\`; you cannot, and \`/build\` will not run an unapproved plan.`,
      ].join("\n");
    case "build":
      return [
        "## Phase: build",
        "The plan is being built by `/build`: one worker per task in its own checkout, a review after each, fix rounds, then a merge. You are not the worker. Answer questions about the work, and if the person asks you to change the plan, say that the running build has to stop first.",
      ].join("\n");
    case "done":
      return "## Phase: done\nThe plan was built and reviewed. Report what was parked and what the final review found if asked.";
  }
}
```

and in `systemPrompt`, where sections are assembled, add `if (context.phase) sections.push(phaseSection(context.phase));`.

In `src/tui/app.ts`, wherever the prompt context is built for a session (search for `notes:` being passed into `createSession` or `systemPrompt`), add:

```ts
    ...(spec !== null && deps.sink.slug !== null
      ? {
          phase: {
            stage: activeStage(spec),
            specPath: specPaths(specsRoot(deps.root), deps.sink.slug).spec,
            planPath: specPaths(specsRoot(deps.root), deps.sink.slug).plan,
          },
        }
      : {}),
```

with a small local helper:

```ts
/** The furthest stage that is active, or the first that is not done. */
function activeStage(tree: SpecTree): Stage {
  const active = [...tree.stages].reverse().find((s) => s.state === "active");
  if (active) return active.stage;
  return tree.stages.find((s) => s.state !== "done")?.stage ?? "done";
}
```

If `createSession` does not currently accept a prompt context beyond `notes`, thread `phase` through `SessionOptions` into the `systemPrompt` call the same way `notes` travels — one optional field, passed along.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/loop/prompt.test.ts` then `bun test` and `bun run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/loop/prompt.ts src/tui/app.ts src/loop/session.ts tests/loop/prompt.test.ts
git commit -F - <<'MSG'
feat: the model is told which phase it is in

Design asks for a classification first and forbids code. Spec names the
file and the command that approves it. Plan names the heading shape and
the task ids the loop will look for, and says the person approves. Build
says the loop is running and the model is not the worker. The
conversational phases are prompts; the mechanical one is not.
MSG
```

---

### Task 12: README and usage — what the process is now

**Files:**
- Modify: `README.md` (the garden section, the usage listing, "What is not built yet")
- Modify: `src/cli/main.ts` (`USAGE`, already touched in task 9 — verify)

- [ ] **Step 1: Run the real thing and capture its output**

In a temporary git repository with a `.vesna/config.yaml` copied from this one, open `vesna`, ask for a small architectural piece of work, and drive it through `classify` → spec → `/approve spec` → plan → `/approve plan` → `/build`. Capture the transcript's event lines. If any step does not behave as the design says, stop and report it — that is a defect in an earlier task, not a documentation problem.

- [ ] **Step 2: Rewrite the README's garden section**

Replace the section headed `## The garden` with one headed `## The process`, in the existing voice, covering: the five phases; `classify`; `/approve spec` and `/approve plan` as the only way a phase closes; `/build` and what one round of it looks like (paste the captured lines verbatim); `review_verdict` and why prose is not a review; parked findings and the fix-round cap; `vesna build <slug>` and its exit codes. Keep the paragraph about evidence versus claims — it is the thesis.

Update "What is not built yet": remove the bullet that says nothing starts the `src/work/` machinery; keep the no-server bullet; add "builds run one task at a time; the scheduler knows which are independent, but parallel builds are not switched on."

- [ ] **Step 3: Verify every console block in the README is real**

For each console block you added or changed, re-run the command and confirm the output matches. A README that documents behaviour the code does not have is the defect this project keeps sending commits back for.

- [ ] **Step 4: Run the suite**

Run: `bun test` and `bun run typecheck`.
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add README.md src/cli/main.ts
git commit -F - <<'MSG'
docs: the README describes the process Vesna now runs

Five phases, two approvals a person types, one loop the runtime runs,
and reviewers that answer through a tool. Every console block is
verbatim output from a run made while writing it.
MSG
```

---

## Self-review

**Spec coverage.** §1 hybrid → tasks 8 (loop) and 11 (prompts). §2 stages → task 1. §3 folder → tasks 2, 5, 8. §4 classification → tasks 1, 3, 11. §5 approval and gate → tasks 1, 4, 8, 10. §6 loop steps 1–5 → task 8; garden marks → task 10. §7 `review_verdict` → task 6. §8 rulings → the `ruling` event exists (task 1) and the loop's `Stop` reasons cover the four stopping cases (task 8); the loop does not yet emit `ruling` events for its own decisions — noted as a gap: the only self-made decision in this loop (merge per task) is recorded in the plan header and commit message, not as an event. Acceptable for this plan; a follow-up can emit one when the loop makes a runtime choice. §9 CLI → task 9. Testing section → each bullet maps to a test in tasks 1, 3, 8, 9. Non-goals respected.

**Placeholders.** None: every step has its code or its exact command.

**Type consistency.** `Finding` is defined once in `src/spec/project.ts` and imported by `review.ts`, `loop.ts`, `buildcmd.ts`. `Verdict` in `review.ts` uses it. `ReviewOutcome` shape matches between task 6 and task 8's fakes. `BuildResult` in task 7 keeps the existing fields; task 8's `built()` fixture matches. `BuildOutcome` in task 8 matches `exitFor` in task 9. `SpecTree.reviews[task]` shape `{ round, spec, open }` matches between task 1's reducer and task 10's pane. `buildStart`/`approveOutcome` return shapes match their tests. `phase` field on `PromptContext` matches `phaseSection`'s parameter.
