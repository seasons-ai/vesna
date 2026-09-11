import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, renderFindings } from "../../src/sdd/loop";
import { appendEvent, createSpec, readEvents, readSpecFile, specPaths, writeSpecFile } from "../../src/spec/store";
import type { Finding, SpecEvent } from "../../src/spec/project";
import type { BuildResult } from "../../src/work/builder";
import type { ReviewOutcome } from "../../src/sdd/review";
import type { MergeReport } from "../../src/work/merge";
import { createRegistry } from "../../src/registry/registry";

// Used only where a test deliberately wants the plan to disagree with the
// log (extra or missing task ids). Every other test's plan is generated to
// match whatever tasks that test actually adds, by `planFor` below.
const PLAN = `# Plan

### Task 1: First
Do the first thing.

### Task 2: Second
Do the second thing.
`;

function planFor(events: SpecEvent[]): string {
  const added = events.filter(
    (e): e is Extract<SpecEvent, { t: "task.added" }> => e.t === "task.added",
  );
  const sections = added.map((e) => `### Task ${e.id.slice(1)}: ${e.title}\nDo it.\n`);
  return `# Plan\n\n${sections.join("\n")}`;
}

function setup(events: SpecEvent[]) {
  const root = mkdtempSync(join(tmpdir(), "vesna-loop-"));
  const specs = join(root, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of events) appendEvent(specs, "work", e);
  writeSpecFile(specPaths(specs, "work").plan, planFor(events));
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
  reviews: (ReviewOutcome | Error)[];
  merge: (task: string) => MergeReport;
}> = {}) {
  const log: string[] = [];
  const gitCalls: string[][] = [];
  const reviews = [...(overrides.reviews ?? [])];
  let resumes = 0;
  return {
    log,
    gitCalls,
    seams: {
      build: async (r: any) => { log.push(`build ${r.task}`); return (overrides.build ?? ((t: string) => built(t, 1)))(r.task); },
      resume: async (r: any) => { resumes += 1; log.push(`resume ${r.task}`); return built(r.task, 1 + resumes); },
      review: async (_r: any) => {
        log.push(`review`);
        const next = reviews.shift() ?? clean;
        if (next instanceof Error) throw next;
        return next;
      },
      merge: async (_repo: string, c: { task: string }[]) => { log.push(`merge ${c[0]!.task}`); return (overrides.merge ?? mergedOk)(c[0]!.task); },
    },
    // The base branch is read once with `rev-parse --abbrev-ref HEAD`, and the
    // build's start commit with a bare `rev-parse HEAD`; a real repo could
    // answer anything for either, so the fake gives each its own distinct
    // value rather than letting a hardcoded literal (or a swapped call) go
    // unnoticed.
    git: async (args: string[]) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "start-sha", stderr: "" };
      return { code: 0, stdout: "diff", stderr: "" };
    },
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
  // Two no-verdict attempts at the same round must not overwrite each
  // other's file — each is its own record of what the silent reviewer said.
  const reviewsDir = specPaths(specs, "work").reviews;
  expect(readSpecFile(join(reviewsDir, "T1-r0-attempt1.md"))).not.toBeNull();
  expect(readSpecFile(join(reviewsDir, "T1-r0-attempt2.md"))).not.toBeNull();
});

test("a review that throws is a failed review, not a crash, and a second try is allowed once", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const f = fakes({ reviews: [new Error("provider down"), clean, clean] });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "done" });
  const events = readEvents(specs, "work");
  const failed = events.filter((e) => e.t === "review.failed");
  expect(failed.length).toBe(1);
  expect((failed[0] as any).reason).toContain("provider down");
});

test("an abort while reviewing propagates instead of being swallowed as a failed review", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  const f = fakes({ reviews: [abort] });
  await expect(runBuild(base(root, specs, f))).rejects.toThrow("aborted");
  const events = readEvents(specs, "work");
  expect(events.some((e) => e.t === "review.failed")).toBe(false);
  expect(events.some((e) => e.t === "build.stopped")).toBe(false);
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

test("the base branch is read rather than assumed to be main", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const f = fakes();
  // Override the fake to answer a base branch other than "main", so that a
  // loop which hardcoded the literal would produce the wrong diff command.
  const gitCalls: string[][] = [];
  const git = async (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "trunk", stderr: "" };
    return { code: 0, stdout: "diff", stderr: "" };
  };
  const out = await runBuild(base(root, specs, f, { git }));
  expect(out).toEqual({ status: "done" });
  expect(gitCalls.some((args) => args[0] === "diff" && args[1] === "trunk...vesna/work/T1")).toBe(true);
  expect(gitCalls.some((args) => args[0] === "diff" && args[1] === "main...vesna/work/T1")).toBe(false);
});

test("plan with duplicate task numbers cannot start, and says why", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  writeSpecFile(specPaths(specs, "work").plan, `# Plan\n\n### Task 1: First\nDo it.\n\n### Task 1: Again\nDo it again.\n`);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out.status).toBe("could-not-start");
  expect((out as { reason: string }).reason).toContain("plan names Task 1 twice");
  expect(f.log).toEqual([]);
});

test("a brief still judged not met at the cap stops the build, like a critical finding would", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const notMet: ReviewOutcome = { kind: "verdict", verdict: { spec: "not_met", findings: [], summary: "nope" }, costUsd: 0 };
  const f = fakes({ reviews: Array(6).fill(notMet) });
  const out = await runBuild(base(root, specs, f, { maxRounds: 5 }));
  expect(out).toEqual({ status: "stopped", reason: "T1: the brief is still not met after 5 fix rounds" });
  const events = readEvents(specs, "work");
  expect(events.some((e) => e.t === "build.stopped")).toBe(true);
  expect(events.some((e) => e.t === "task.done")).toBe(false);
});

test("an initial build that changed nothing stops the build rather than reviewing an empty diff", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const f = fakes({ build: (task) => ({ ...built(task, 1), status: "no-changes" }) });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "stopped", reason: "T1: the worker changed nothing" });
  expect(f.log).toEqual(["build T1"]);
});

test("a fix round that changes nothing keeps the earlier commit, not a blank one", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const bad: Finding = { severity: "important", file: "a.ts", text: "wrong" };
  const f = fakes({
    reviews: [
      { kind: "verdict", verdict: { spec: "met", findings: [bad], summary: "one" }, costUsd: 0 },
      clean, // re-review after the no-op fix round
    ],
  });
  const resume = async (r: { worktree: { path: string; branch: string } }): Promise<BuildResult> => ({
    task: "T1",
    status: "no-changes",
    branch: r.worktree.branch,
    worktree: r.worktree.path,
    refusals: [],
    costUsd: 0,
    text: "looked, nothing to change",
  });
  const out = await runBuild(base(root, specs, f, { resume }));
  expect(out).toEqual({ status: "done" });
  const events = readEvents(specs, "work");
  const done = events.find((e) => e.t === "task.done") as { commit?: string };
  // built(task, 1) is what the original build produced; a no-op fix round
  // must not lose that commit in favor of one the resume never made.
  expect(done.commit).toBe("sha-T1-1");
});

test("a task depending on an id missing from the plan is skipped, and the build stops naming it", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First", dependsOn: ["TX"] },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out.status).toBe("stopped");
  const reason = (out as { reason: string }).reason;
  expect(reason).toContain("T1");
  expect(reason).toContain("TX");
  expect(f.log).toEqual([]);
});

test("a signal aborted before the build starts stops it as interrupted, not done", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const f = fakes();
  const controller = new AbortController();
  controller.abort();
  const out = await runBuild(base(root, specs, f, { signal: controller.signal }));
  expect(out).toEqual({ status: "stopped", reason: "interrupted" });
  const events = readEvents(specs, "work");
  expect(events.some((e) => e.t === "build.stopped")).toBe(true);
  expect(events.some((e) => e.t === "build.done")).toBe(false);
  expect(f.log).toEqual([]);
});

test("tasks that depend on each other are a cycle, and the build says so", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First", dependsOn: ["T2"] },
    { t: "task.added", id: "T2", title: "Second", dependsOn: ["T1"] },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out.status).toBe("stopped");
  const events = readEvents(specs, "work");
  expect(events.some((e) => e.t === "build.stopped")).toBe(true);
});

test("a git failure on the loop's own call stops the build before any work starts", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const f = fakes();
  const git = async (args: string[]) => {
    if (args[0] === "rev-parse") return { code: 128, stdout: "", stderr: "fatal: not a git repository\n" };
    return { code: 0, stdout: "diff", stderr: "" };
  };
  const out = await runBuild(base(root, specs, f, { git }));
  expect(out.status).toBe("stopped");
  const reason = (out as { reason: string }).reason;
  expect(reason).toContain("git rev-parse failed");
  expect(reason).toContain("not a git repository");
  expect(f.log).toEqual([]);
});

test("a task in the log with no matching plan heading cannot start", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "task.added", id: "T3", title: "Extra" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  // Only Task 1 in the plan; the log also added T3.
  writeSpecFile(specPaths(specs, "work").plan, `# Plan\n\n### Task 1: First\nDo it.\n`);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out.status).toBe("could-not-start");
  expect((out as { reason: string }).reason).toContain("T3 is in the log but not in plan.md");
  expect(f.log).toEqual([]);
});

test("a plan heading with no matching task in the log cannot start", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  // PLAN names Task 1 and Task 2; the log only ever added T1.
  writeSpecFile(specPaths(specs, "work").plan, PLAN);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out.status).toBe("could-not-start");
  expect((out as { reason: string }).reason).toContain("T2 is in plan.md but not in the log");
  expect(f.log).toEqual([]);
});

test("the final whole-branch review receives the signal like every per-round review does", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const seen: { signal?: AbortSignal }[] = [];
  const review = async (r: { signal?: AbortSignal }): Promise<ReviewOutcome> => {
    seen.push(r);
    return clean;
  };
  const f = fakes();
  const controller = new AbortController();
  const out = await runBuild(base(root, specs, f, { review, signal: controller.signal }));
  expect(out).toEqual({ status: "done" });
  expect(seen.at(-1)?.signal).toBe(controller.signal);
});

test("the final review diffs from where the build started, not a fixed point", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "done" });
  expect(f.gitCalls.some((args) => args[0] === "diff" && args[1] === "start-sha...HEAD")).toBe(true);
});

test("findings render one per line with severity, place and text", () => {
  expect(renderFindings([
    { severity: "important", file: "a.ts", line: 2, text: "wrong" },
    { severity: "minor", file: "b.ts", text: "nit" },
  ])).toBe("- [important] a.ts:2 — wrong\n- [minor] b.ts — nit");
});

test("the loop hands every worker the project's permit and notes, on the first build and on a fix round", async () => {
  const { root, specs } = setup(approvedWithTasks);
  const bad: Finding = { severity: "important", file: "a.ts", text: "wrong" };
  const seen: { call: string; permit: unknown; notes: unknown }[] = [];
  const f = fakes({
    reviews: [
      { kind: "verdict", verdict: { spec: "met", findings: [bad], summary: "one" }, costUsd: 0 },
      clean, clean, clean,
    ],
  });
  const permit = (type: string) => type !== "shell";
  const record = (call: string, inner: (r: any) => Promise<BuildResult>) => async (r: any) => {
    seen.push({ call, permit: r.permit, notes: r.notes });
    return inner(r);
  };
  await runBuild(base(root, specs, f, {
    build: record("build", f.seams.build),
    resume: record("resume", f.seams.resume),
    permit,
    notes: "House rules.",
  }));
  expect(seen.length).toBe(3);
  for (const request of seen) expect(request).toEqual({ call: request.call, permit, notes: "House rules." });
  expect(seen.map((s) => s.call)).toEqual(["build", "resume", "build"]);
});
