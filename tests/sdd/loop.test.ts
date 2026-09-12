import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, renderFindings } from "../../src/sdd/loop";
import { appendEvent, createSpec, readEvents, readSpecFile, specPaths, writeSpecFile } from "../../src/spec/store";
import { project, type Finding, type SpecEvent } from "../../src/spec/project";
import { runTask, type BuildResult } from "../../src/work/builder";
import type { ReviewOutcome } from "../../src/sdd/review";
import type { MergeReport } from "../../src/work/merge";
import { createRegistry } from "../../src/registry/registry";
import { writeNode } from "../../src/nodes/write";
import { readNode } from "../../src/nodes/read";
import { branchName, createWorktree, runGit, worktreePath } from "../../src/work/worktree";
import type { CompletionResult, Provider } from "../../src/providers/types";

// Copied from tests/work/builder.test.ts: a real repository and a provider
// that writes one file, for the one test below that runs on real git rather
// than the seams.
async function repository(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "vesna-loop-real-"));
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "user.email", "t@example.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "a.txt"), "one\n");
  await runGit(["add", "-A"], dir);
  await runGit(["commit", "-qm", "first"], dir);
  return dir;
}

function registry() {
  const r = createRegistry();
  r.register(writeNode);
  r.register(readNode);
  return r;
}

/** Writes one file, then answers. */
function writes(path: string, text: string): Provider {
  let turn = 0;
  return {
    id: "fake",
    async complete(): Promise<CompletionResult> {
      turn += 1;
      const content =
        turn === 1
          ? [{ type: "tool_call" as const, id: "c1", name: "write", input: { path, text } }]
          : [{ type: "text" as const, text: "done" }];
      return {
        content,
        stopReason: "end_turn",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

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

function setup(events: SpecEvent[], plan = planFor(events)) {
  const root = mkdtempSync(join(tmpdir(), "vesna-loop-"));
  const specs = join(root, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of events) appendEvent(specs, "work", e);
  writeSpecFile(specPaths(specs, "work").plan, plan);
  return { root, specs };
}

// Same as `setup`, but the root is a real repository rather than a bare
// directory — for the recovery tests that need real `git worktree`/`branch`
// state (a worktree that was never created, or one whose directory was
// removed by hand while git still remembers it) rather than the seams.
async function setupReal(events: SpecEvent[]) {
  const root = await repository();
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
  // Nobody's signal was aborted, so the task was not "interrupted".
  expect(events.filter((e) => e.t === "task.failed")).toEqual([{ t: "task.failed", id: "T1", reason: "aborted" }]);
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

test("a task added after approval means the plan is not approved, so nothing is built unread", async () => {
  const { root, specs } = setup([...approvedWithTasks, { t: "task.added", id: "T3", title: "Third" }]);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "could-not-start", reason: "the plan is not approved — /approve plan" });
  expect(f.log).toEqual([]);
});

test("a fix round the worker was not allowed to do stops the build, and is not mistaken for a fix", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ]);
  const bad: Finding = { severity: "important", file: "a.ts", text: "wrong" };
  const f = fakes({
    reviews: [{ kind: "verdict", verdict: { spec: "met", findings: [bad], summary: "one" }, costUsd: 0 }],
  });
  const resume = async (r: any): Promise<BuildResult> => {
    f.log.push(`resume ${r.task}`);
    return { ...built(r.task, 2), status: "refused", refusals: ["shell rm -rf build", "write .env"] };
  };
  const out = await runBuild(base(root, specs, f, { resume }));
  expect(out).toEqual({
    status: "stopped",
    reason: "T1: fix round 1: the worker was not allowed to: shell rm -rf build; write .env",
  });
  // No second review of a "fix" that never happened, and no merge.
  expect(f.log).toEqual(["build T1", "review", "resume T1"]);
  const events = readEvents(specs, "work");
  expect(events).toContainEqual({
    t: "task.failed", id: "T1", reason: "fix round 1: the worker was not allowed to: shell rm -rf build; write .env",
  });
  expect(events.some((e) => e.t === "task.done")).toBe(false);
  // What the worker said before it was stopped is still in the report.
  expect(readSpecFile(join(specPaths(specs, "work").reports, "T1.md"))).toContain("## Fix round 1 (refused)");
});

test("a stopped build marks the task in flight failed, before it says stopped", async () => {
  const { root, specs } = setup(approvedWithTasks);
  const f = fakes({
    build: (task) => ({ ...built(task, 1), status: "refused", refusals: ["write src/a.ts"] }),
  });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "stopped", reason: "T1: the worker was not allowed to: write src/a.ts" });
  const events = readEvents(specs, "work");
  const failedAt = events.findIndex((e) => e.t === "task.failed");
  const stoppedAt = events.findIndex((e) => e.t === "build.stopped");
  expect(events[failedAt]).toEqual({ t: "task.failed", id: "T1", reason: "the worker was not allowed to: write src/a.ts" });
  expect(failedAt).toBeLessThan(stoppedAt);
  const tree = project(events)!;
  expect(tree.tasks.find((t) => t.id === "T1")).toMatchObject({ state: "failed" });
  expect(tree.tasks.find((t) => t.id === "T1")?.agent).toBeUndefined();
  expect(tree.building).toBe(false);
});

test("an interrupted build marks the task in flight failed as interrupted", async () => {
  const { root, specs } = setup(approvedWithTasks);
  const controller = new AbortController();
  const f = fakes({
    reviews: [Object.assign(new Error("aborted"), { name: "AbortError" })],
  });
  const build = async (r: any) => {
    controller.abort();
    return f.seams.build(r);
  };
  const out = await runBuild(base(root, specs, f, { build, signal: controller.signal }));
  expect(out).toEqual({ status: "stopped", reason: "interrupted" });
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "task.failed")).toEqual([{ t: "task.failed", id: "T1", reason: "interrupted" }]);
  expect(project(events)!.tasks.find((t) => t.id === "T1")).toMatchObject({ state: "failed" });
});

test("a spec whose every task is merged has nothing to build, and no review is paid for", async () => {
  const { root, specs } = setup([
    ...approvedWithTasks,
    { t: "build.started" },
    { t: "task.started", id: "T1" },
    { t: "task.done", id: "T1", commit: "a" },
    { t: "task.started", id: "T2" },
    { t: "task.done", id: "T2", commit: "b" },
    { t: "build.done" },
  ]);
  writeSpecFile(join(specPaths(specs, "work").reviews, "branch.md"), "the first review\n");
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "could-not-start", reason: "nothing to build — every task is merged" });
  expect(f.log).toEqual([]);
  expect(readSpecFile(join(specPaths(specs, "work").reviews, "branch.md"))).toBe("the first review\n");
  expect(readEvents(specs, "work").filter((e) => e.t === "build.started")).toHaveLength(1);
});

// The whole-branch review is a gate, not a note. "done" over a review that
// said the branch does not meet its brief is the panel lying at the end of
// the process it exists to make honest.
const oneApproved: SpecEvent[] = [
  { t: "task.added", id: "T1", title: "First" },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
];

test("a whole-branch review that says not met stops the build instead of finishing it", async () => {
  const { root, specs } = setup(oneApproved);
  const notMet: ReviewOutcome = { kind: "verdict", verdict: { spec: "not_met", findings: [], summary: "missing X" }, costUsd: 0 };
  const f = fakes({ reviews: [clean, notMet] });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "stopped", reason: "branch review: the brief is not met — missing X" });
  const events = readEvents(specs, "work");
  expect(events.some((e) => e.t === "build.done")).toBe(false);
  expect(events.some((e) => e.t === "build.stopped")).toBe(true);
});

test("a critical finding in the whole-branch review stops the build", async () => {
  const { root, specs } = setup(oneApproved);
  const crit: Finding = { severity: "critical", file: "a.ts", line: 9, text: "leaks a key" };
  const bad: ReviewOutcome = { kind: "verdict", verdict: { spec: "met", findings: [crit], summary: "" }, costUsd: 0 };
  const f = fakes({ reviews: [clean, bad] });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "stopped", reason: "branch review: a critical finding — a.ts:9 leaks a key" });
});

test("important and minor findings in the whole-branch review are parked on the branch, and the build is done", async () => {
  const { root, specs } = setup(oneApproved);
  const imp: Finding = { severity: "important", file: "b.ts", text: "should be split" };
  const min: Finding = { severity: "minor", file: "c.ts", text: "nit" };
  const soft: ReviewOutcome = { kind: "verdict", verdict: { spec: "met", findings: [imp, min], summary: "" }, costUsd: 0 };
  const f = fakes({ reviews: [clean, soft] });
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({ status: "done" });
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "parked" && (e as any).task === "branch").map((e: any) => e.finding)).toEqual([imp, min]);
  expect(events.some((e) => e.t === "build.done")).toBe(true);
});

test("a whole-branch review with no verdict gets one retry, then stops the build", async () => {
  const { root, specs } = setup(oneApproved);
  const silent: ReviewOutcome = { kind: "no-verdict", text: "fine", costUsd: 0 };
  const once = fakes({ reviews: [clean, silent, clean] });
  expect(await runBuild(base(root, specs, once))).toEqual({ status: "done" });
  expect(once.log.filter((l) => l === "review").length).toBe(3);

  const { root: r2, specs: s2 } = setup(oneApproved);
  const twice = fakes({ reviews: [clean, silent, silent] });
  expect(await runBuild(base(r2, s2, twice))).toEqual({ status: "stopped", reason: "branch review: the reviewer produced no verdict twice" });
});

// Two builds of one spec at once would race on the same branches, worktrees
// and log. The second must refuse and name the first.
test("a second build of the same spec refuses while the first holds the lock", async () => {
  const { root, specs } = setup(oneApproved);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = fakes({ build: (t) => built(t, 1) });
  const held = { ...slow.seams, build: async (r: any) => { await gate; return built(r.task, 1); } };
  const first = runBuild({ ...base(root, specs, slow), ...held });

  // Give the first build a tick to take the lock, then try a second.
  await new Promise((r) => setTimeout(r, 20));
  const second = await runBuild(base(root, specs, fakes()));
  expect(second.status).toBe("could-not-start");
  expect((second as any).reason).toMatch(/already running.*pid \d+/);

  release();
  expect(await first).toEqual({ status: "done" });
  // The lock is gone once the first build ends, so a third can start.
  const third = await runBuild(base(root, specs, fakes()));
  expect(third.status).toBe("could-not-start");
  expect((third as any).reason).toBe("nothing to build — every task is merged");
});

test("a stale lock from a dead process does not block a build", async () => {
  const { root, specs } = setup(oneApproved);
  writeFileSync(join(specs, "work", "build.lock"), JSON.stringify({ pid: 999999999, startedAt: "2000-01-01T00:00:00Z" }));
  const out = await runBuild(base(root, specs, fakes()));
  expect(out).toEqual({ status: "done" });
});

test("after a task merges, its worktree and branch are gone; after the build, nothing is left", async () => {
  const repo = await repository();                       // a git repo with one commit on main
  const specs = join(repo, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of [
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ] as SpecEvent[]) appendEvent(specs, "work", e);
  writeSpecFile(specPaths(specs, "work").plan, "# Plan\n\n### Task 1: First\nWrite b.txt.\n");

  const out = await runBuild({
    root: repo, specsRoot: specs, slug: "work",
    provider: writes("b.txt", "one\n"), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
  });
  expect(out).toEqual({ status: "done" });

  expect(existsSync(join(repo, ".vesna", "worktrees", "work-T1"))).toBe(false);
  expect((await runGit(["branch", "--list", "vesna/work/T1"], repo)).stdout.trim()).toBe("");
  expect((await runGit(["worktree", "list"], repo)).stdout.split("\n").filter((l) => l.includes("work-T1"))).toEqual([]);
  // The work itself is on main, via the merge commit.
  expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("one\n");
});

// If an operator (or anything else) removes a task's worktree directory
// without going through `removeWorktree` — a plain `rm -rf` — git still
// registers the worktree until it is pruned, and a bare `git branch -D`
// then refuses with "used by worktree". The `existsSync` guard in `attempt`
// sends this case to `deleteBranch` instead of `removeWorktree`, and
// `deleteBranch` must still get the branch gone rather than quietly leaving
// it, with no error and no log line, because the directory happened not to
// be there.
test("a branch survives even when its worktree directory was removed by hand first", async () => {
  const repo = await repository();
  const specs = join(repo, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of [
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ] as SpecEvent[]) appendEvent(specs, "work", e);
  writeSpecFile(specPaths(specs, "work").plan, "# Plan\n\n### Task 1: First\nWrite b.txt.\n");

  const out = await runBuild({
    root: repo, specsRoot: specs, slug: "work",
    provider: writes("b.txt", "one\n"), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
    // A real build, through the real `runTask` — but its worktree is
    // deleted by hand before the loop ever gets to clean up after it,
    // reproducing an operator's `rm -rf` rather than Vesna's own removal.
    build: async (r) => {
      const result = await runTask(r);
      rmSync(result.worktree, { recursive: true, force: true });
      return result;
    },
  });
  expect(out).toEqual({ status: "done" });

  expect((await runGit(["branch", "--list", "vesna/work/T1"], repo)).stdout.trim()).toBe("");
});

const deadAfterT1: SpecEvent[] = [
  { t: "task.added", id: "T1", title: "First" },
  { t: "task.added", id: "T2", title: "Second", dependsOn: ["T1"] },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  { t: "build.started" },
  { t: "task.started", id: "T1", agent: "vesna build" },
  { t: "task.done", id: "T1", commit: "sha-T1" },
  { t: "task.started", id: "T2", agent: "vesna build" },
];

test("a plain start on a dead build refuses and names the three actions", async () => {
  const { root, specs } = setup(deadAfterT1);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({
    status: "could-not-start",
    reason: 'a build of "work" was interrupted — /build resume, /build retry <task>, or /build abort',
  });
  expect(f.log).toEqual([]);
});

test("resume continues the in-flight task in its own worktree, then the rest", async () => {
  const { root, specs } = setup(deadAfterT1);
  const f = fakes();
  // Resume now refuses when the in-flight task's checkout is not actually
  // there (see the "checkout is gone" tests below) — a plain `fakes()` never
  // creates one, so this test gives T2 a real directory registered as a real
  // worktree, the way a genuine resume candidate looks.
  const path = worktreePath(root, "work", "T2");
  mkdirSync(path, { recursive: true });
  const branch = branchName("work", "T2");
  const git = async (args: string[]) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return {
        code: 0,
        stdout: `worktree ${path}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/${branch}\n\n`,
        stderr: "",
      };
    }
    return f.git(args);
  };
  const out = await runBuild(base(root, specs, f, { recovery: { action: "resume" }, git }));
  expect(out).toEqual({ status: "done" });
  // T1 is done and not rebuilt; T2 goes through resume, not build.
  expect(f.log).toEqual(["resume T2", "review", "merge T2", "review"]);
  const events = readEvents(specs, "work");
  expect(events.some((e) => e.t === "build.recovered" && (e as any).action === "resume")).toBe(true);
  expect(events.filter((e) => e.t === "build.started").length).toBe(2);
});

test("retry discards the named task's checkout and builds it from scratch", async () => {
  const { root, specs } = setup(deadAfterT1);
  const f = fakes();
  const discarded: string[] = [];
  const out = await runBuild(base(root, specs, f, {
    recovery: { action: "retry", task: "T2" },
    discard: async (_repo: string, r: any) => { discarded.push(r.task); },
  }));
  expect(out).toEqual({ status: "done" });
  expect(discarded).toEqual(["T2"]);
  expect(f.log).toEqual(["build T2", "review", "merge T2", "review"]);
});

test("retry of a task that is already merged is refused", async () => {
  const { root, specs } = setup(deadAfterT1);
  const out = await runBuild(base(root, specs, fakes(), { recovery: { action: "retry", task: "T1" } }));
  expect(out).toEqual({ status: "could-not-start", reason: "T1 is merged — it cannot be retried" });
});

test("abort builds nothing, discards the in-flight checkout, and ends the build as abandoned", async () => {
  const { root, specs } = setup(deadAfterT1);
  const f = fakes();
  const discarded: string[] = [];
  const out = await runBuild(base(root, specs, f, {
    recovery: { action: "abort" },
    discard: async (_repo: string, r: any) => { discarded.push(r.task); },
  }));
  expect(out).toEqual({ status: "stopped", reason: "abandoned" });
  expect(f.log).toEqual([]);
  expect(discarded).toEqual(["T2"]);
  const events = readEvents(specs, "work");
  const last = events.at(-1)!;
  expect(last).toEqual({ t: "build.stopped", reason: "abandoned" });
  expect(events.at(-2)).toEqual({ t: "build.recovered", action: "abort", task: "T2" });
});

test("a recovery on a build that is not dead is refused", async () => {
  const { root, specs } = setup(approvedWithTasks);
  const out = await runBuild(base(root, specs, fakes(), { recovery: { action: "resume" } }));
  expect(out).toEqual({ status: "could-not-start", reason: "nothing to recover — no interrupted build" });
});

// A missing checkout is a state, not an error: the process may have died
// before `git worktree add` ever ran, or a person may have removed the
// directory by hand. retry and abort tolerate it and proceed; resume, which
// has nowhere to continue, refuses instead of silently building in the wrong
// place.

test("abort discards an in-flight checkout that never existed on disk and still ends the build as abandoned", async () => {
  const { root, specs } = setup(deadAfterT1);
  const f = fakes();
  const out = await runBuild(base(root, specs, f, { recovery: { action: "abort" } }));
  expect(out).toEqual({ status: "stopped", reason: "abandoned" });
  expect(f.log).toEqual([]);
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "build.recovered").length).toBe(1);
  expect(events.filter((e) => e.t === "build.stopped").length).toBe(1);
  expect(events.at(-1)).toEqual({ t: "build.stopped", reason: "abandoned" });
  expect(events.at(-2)).toEqual({ t: "build.recovered", action: "abort", task: "T2" });
});

test("retry rebuilds a task whose checkout never existed on disk", async () => {
  const { root, specs } = setup(deadAfterT1);
  const f = fakes();
  const out = await runBuild(base(root, specs, f, { recovery: { action: "retry", task: "T2" } }));
  expect(out).toEqual({ status: "done" });
  expect(f.log).toEqual(["build T2", "review", "merge T2", "review"]);
});

test("resume refuses when the in-flight task's checkout is gone", async () => {
  const { root, specs } = setup(deadAfterT1);
  const before = readEvents(specs, "work").length;
  const out = await runBuild(base(root, specs, fakes(), { recovery: { action: "resume" } }));
  expect(out).toEqual({
    status: "could-not-start",
    reason: 'the checkout of "T2" is gone — /build retry T2 or /build abort',
  });
  expect(readEvents(specs, "work").length).toBe(before);
});

test("resume refuses an explicit task that is not the in-flight one", async () => {
  const { root, specs } = setup(deadAfterT1);
  const out = await runBuild(base(root, specs, fakes(), { recovery: { action: "resume", task: "T1" } }));
  expect(out).toEqual({ status: "could-not-start", reason: 'only the interrupted task "T2" can be resumed' });
});

// The two seam-based tests above against real git, mirroring the review's own
// reproductions: a worktree that was never created at all, and one whose
// directory was removed by hand while git's own bookkeeping still names it.

test("retry rebuilds a task whose branch and worktree were never created (real git)", async () => {
  const { root, specs } = await setupReal(deadAfterT1);
  const out = await runBuild({
    root, specsRoot: specs, slug: "work",
    provider: writes("b.txt", "one\n"), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
    recovery: { action: "retry", task: "T2" },
  });
  expect(out).toEqual({ status: "done" });
  expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("one\n");
  expect((await runGit(["branch", "--list", "vesna/work/T2"], root)).stdout.trim()).toBe("");
});

test("retry rebuilds a task whose directory was removed by hand while its branch stayed registered (real git)", async () => {
  const { root, specs } = await setupReal(deadAfterT1);
  const stale = await createWorktree(root, "work", "T2", runGit);
  rmSync(stale.path, { recursive: true, force: true });
  const out = await runBuild({
    root, specsRoot: specs, slug: "work",
    provider: writes("b.txt", "one\n"), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
    recovery: { action: "retry", task: "T2" },
  });
  expect(out).toEqual({ status: "done" });
  expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("one\n");
});

test("abort discards a checkout whose branch and worktree were never created and ends the build as abandoned (real git)", async () => {
  const { root, specs } = await setupReal(deadAfterT1);
  const out = await runBuild({
    root, specsRoot: specs, slug: "work",
    provider: {} as any, registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    recovery: { action: "abort" },
  });
  expect(out).toEqual({ status: "stopped", reason: "abandoned" });
  const events = readEvents(specs, "work");
  expect(events.at(-1)).toEqual({ t: "build.stopped", reason: "abandoned" });
  expect(events.at(-2)).toEqual({ t: "build.recovered", action: "abort", task: "T2" });
});

test("abort discards a checkout whose directory was removed by hand while its branch stayed registered (real git)", async () => {
  const { root, specs } = await setupReal(deadAfterT1);
  const stale = await createWorktree(root, "work", "T2", runGit);
  rmSync(stale.path, { recursive: true, force: true });
  const out = await runBuild({
    root, specsRoot: specs, slug: "work",
    provider: {} as any, registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    recovery: { action: "abort" },
  });
  expect(out).toEqual({ status: "stopped", reason: "abandoned" });
  expect((await runGit(["branch", "--list", "vesna/work/T2"], root)).stdout.trim()).toBe("");
});

// Round 2 of the review: the registration check that resume and the discard
// branching both rely on has to realpath, and has to decide on registration
// rather than mere existence, or it misjudges two more real states.

test("resume proceeds when the in-flight checkout is registered, even through a symlinked tmp directory (real git)", async () => {
  const { root, specs } = await setupReal(deadAfterT1);
  const tree = await createWorktree(root, "work", "T2", runGit);
  // A partial commit, the way a genuine in-flight attempt would leave one.
  writeFileSync(join(tree.path, "partial.txt"), "wip\n");
  await runGit(["add", "-A"], tree.path);
  await runGit(["commit", "-qm", "wip"], tree.path);

  const out = await runBuild({
    root, specsRoot: specs, slug: "work",
    provider: writes("b.txt", "one\n"), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
    recovery: { action: "resume" },
  });
  expect(out).toEqual({ status: "done" });
});

test("abort tolerates a directory at the worktree path that was never registered as a worktree", async () => {
  const { root, specs } = setup(deadAfterT1);
  const f = fakes();
  const path = worktreePath(root, "work", "T2");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "junk.txt"), "leftover\n");

  const out = await runBuild(base(root, specs, f, { recovery: { action: "abort" } }));
  expect(out).toEqual({ status: "stopped", reason: "abandoned" });
  expect(f.log).toEqual([]);
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "build.recovered").length).toBe(1);
  expect(events.filter((e) => e.t === "build.stopped").length).toBe(1);
  expect(existsSync(path)).toBe(false);
});

test("retry rebuilds a task whose worktree path holds a directory that was never registered", async () => {
  const { root, specs } = setup(deadAfterT1);
  const f = fakes();
  const path = worktreePath(root, "work", "T2");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "junk.txt"), "leftover\n");

  const out = await runBuild(base(root, specs, f, { recovery: { action: "retry", task: "T2" } }));
  expect(out).toEqual({ status: "done" });
  expect(f.log).toEqual(["build T2", "review", "merge T2", "review"]);
});

// After a stop — any reason — the in-flight task's checkout is kept (§4),
// and the spec is idle again. The way forward is `retry <task>`, which is
// accepted on an idle build for any task that is not merged; resume and
// abort stay dead-only. A plain start meanwhile refuses naming retry, rather
// than colliding on the kept branch with two git commands to run by hand.

const stoppedAtT1: SpecEvent[] = [
  ...approvedWithTasks,
  { t: "build.started" },
  { t: "task.started", id: "T1", agent: "vesna build" },
  { t: "task.failed", id: "T1", reason: "interrupted" },
  { t: "build.stopped", reason: "interrupted" },
];

test("retry after a clean stop discards the failed task's checkout, rebuilds it, then the rest", async () => {
  const { root, specs } = setup(stoppedAtT1);
  const f = fakes();
  const discarded: string[] = [];
  const out = await runBuild(base(root, specs, f, {
    recovery: { action: "retry", task: "T1" },
    discard: async (_repo: string, r: any) => { discarded.push(r.task); },
  }));
  expect(out).toEqual({ status: "done" });
  expect(discarded).toEqual(["T1"]);
  expect(f.log).toEqual(["build T1", "review", "merge T1", "build T2", "review", "merge T2", "review"]);
  const events = readEvents(specs, "work");
  const at = events.findIndex((e) => e.t === "build.recovered");
  expect(events[at]).toEqual({ t: "build.recovered", action: "retry", task: "T1" });
  expect(events[at + 1]).toEqual({ t: "build.started", base: "start-sha" });
  expect(events.at(-1)).toEqual({ t: "build.done" });
});

test("resume and abort stay dead-only: after a clean stop both are refused", async () => {
  const { root, specs } = setup(stoppedAtT1);
  const before = readEvents(specs, "work").length;
  expect(await runBuild(base(root, specs, fakes(), { recovery: { action: "resume" } })))
    .toEqual({ status: "could-not-start", reason: "nothing to recover — no interrupted build" });
  expect(await runBuild(base(root, specs, fakes(), { recovery: { action: "abort" } })))
    .toEqual({ status: "could-not-start", reason: "nothing to recover — no interrupted build" });
  expect(readEvents(specs, "work").length).toBe(before);
});

test("retry of a merged or unknown task after a clean stop is refused", async () => {
  const { root, specs } = setup([
    ...approvedWithTasks,
    { t: "build.started" },
    { t: "task.started", id: "T1", agent: "vesna build" },
    { t: "task.done", id: "T1", commit: "sha-T1" },
    { t: "task.started", id: "T2", agent: "vesna build" },
    { t: "task.failed", id: "T2", reason: "interrupted" },
    { t: "build.stopped", reason: "interrupted" },
  ]);
  expect(await runBuild(base(root, specs, fakes(), { recovery: { action: "retry", task: "T1" } })))
    .toEqual({ status: "could-not-start", reason: "T1 is merged — it cannot be retried" });
  expect(await runBuild(base(root, specs, fakes(), { recovery: { action: "retry", task: "T9" } })))
    .toEqual({ status: "could-not-start", reason: "T9 is not a task of this spec" });
});

test("cancel mid-task keeps its checkout; a plain start then names retry; retry rebuilds it and leaves nothing behind (real git)", async () => {
  const { root, specs } = await setupReal(oneApproved);
  const auto = { mode: "auto" as const, allow: {}, deny: {} };
  const common = { root, specsRoot: specs, slug: "work", registry: registry(), policy: auto };
  const worktree = worktreePath(root, "work", "T1");
  const branch = branchName("work", "T1");
  const branches = async () => (await runGit(["branch", "--list", branch], root)).stdout.trim();

  // The person cancels after the worker committed: the real `runTask` made
  // the checkout and the commit, then the abort landed.
  const controller = new AbortController();
  const cancelled = await runBuild({
    ...common,
    provider: writes("b.txt", "one\n"),
    review: async () => clean,
    signal: controller.signal,
    build: async (r) => {
      await runTask(r);
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  expect(cancelled).toEqual({ status: "stopped", reason: "interrupted" });
  expect(existsSync(worktree)).toBe(true);
  expect(await branches()).toContain(branch);
  expect(project(readEvents(specs, "work"))!.building).toBe(false);

  // A plain start would collide on that branch; it refuses naming the way out.
  const before = readEvents(specs, "work").length;
  const plain = await runBuild({ ...common, provider: writes("b.txt", "one\n"), review: async () => clean });
  expect(plain).toEqual({
    status: "could-not-start",
    reason: "T1 has a checkout left by a stopped build — /build retry T1 redoes it",
  });
  expect(readEvents(specs, "work").length).toBe(before);
  expect(existsSync(worktree)).toBe(true);

  // retry: the kept checkout goes, T1 is built from scratch, merged, and cleaned up.
  const retried = await runBuild({
    ...common,
    provider: writes("b.txt", "two\n"),
    review: async () => clean,
    recovery: { action: "retry", task: "T1" },
  });
  expect(retried).toEqual({ status: "done" });
  expect(existsSync(worktree)).toBe(false);
  expect(await branches()).toBe("");
  expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("two\n");
  const events = readEvents(specs, "work");
  expect(events.at(-1)).toEqual({ t: "build.done" });
  expect(events.some((e) => e.t === "build.recovered" && (e as any).action === "retry" && (e as any).task === "T1")).toBe(true);
});

// Killed during the whole-branch review — the longest step — a build has
// every task merged and `build.started` still open. It is a dead build like
// any other: a plain start refuses naming the three, resume finishes it
// (no task runs; the review does), abort abandons it, retry has nothing to
// redo. "nothing to build — every task is merged" is for a finished spec,
// not for one whose build never got to say it finished.
const deadInBranchReview: SpecEvent[] = [
  ...approvedWithTasks,
  { t: "build.started" },
  { t: "task.started", id: "T1", agent: "vesna build" },
  { t: "task.done", id: "T1", commit: "sha-T1" },
  { t: "task.started", id: "T2", agent: "vesna build" },
  { t: "task.done", id: "T2", commit: "sha-T2" },
];

test("a build killed during the whole-branch review is a dead build, not a finished spec", async () => {
  const { root, specs } = setup(deadInBranchReview);
  const f = fakes();
  const out = await runBuild(base(root, specs, f));
  expect(out).toEqual({
    status: "could-not-start",
    reason: 'a build of "work" was interrupted — /build resume, /build retry <task>, or /build abort',
  });
  expect(f.log).toEqual([]);
});

test("resume of a build killed during the whole-branch review runs no task, reviews the branch, and finishes", async () => {
  const { root, specs } = setup(deadInBranchReview);
  const f = fakes();
  const out = await runBuild(base(root, specs, f, { recovery: { action: "resume" } }));
  expect(out).toEqual({ status: "done" });
  expect(f.log).toEqual(["review"]);
  const events = readEvents(specs, "work");
  const at = events.findIndex((e) => e.t === "build.recovered");
  expect(events[at]).toEqual({ t: "build.recovered", action: "resume" });
  expect(events[at + 1]).toEqual({ t: "build.started", base: "start-sha" });
  expect(events.at(-1)).toEqual({ t: "build.done" });
  expect(project(events)!.building).toBe(false);
});

test("a whole-branch review that fails on such a resume stops the build, as it would have the first time", async () => {
  const { root, specs } = setup(deadInBranchReview);
  const notMet: ReviewOutcome = { kind: "verdict", verdict: { spec: "not_met", findings: [], summary: "missing X" }, costUsd: 0 };
  const f = fakes({ reviews: [notMet] });
  const out = await runBuild(base(root, specs, f, { recovery: { action: "resume" } }));
  expect(out).toEqual({ status: "stopped", reason: "branch review: the brief is not met — missing X" });
  expect(readEvents(specs, "work").at(-1)).toEqual({ t: "build.stopped", reason: "branch review: the brief is not met — missing X" });
});

test("abort of a build killed during the whole-branch review abandons it; the merged tasks stay merged", async () => {
  const { root, specs } = setup(deadInBranchReview);
  const f = fakes();
  const discarded: string[] = [];
  const out = await runBuild(base(root, specs, f, {
    recovery: { action: "abort" },
    discard: async (_repo: string, r: any) => { discarded.push(r.task); },
  }));
  expect(out).toEqual({ status: "stopped", reason: "abandoned" });
  expect(f.log).toEqual([]);
  expect(discarded).toEqual([]);
  const events = readEvents(specs, "work");
  expect(events.at(-2)).toEqual({ t: "build.recovered", action: "abort" });
  expect(events.at(-1)).toEqual({ t: "build.stopped", reason: "abandoned" });
  const tree = project(events)!;
  expect(tree.building).toBe(false);
  expect(tree.tasks.map((t) => t.state)).toEqual(["done", "done"]);
});

test("retry on a build killed during the whole-branch review has nothing to redo, and says so", async () => {
  const { root, specs } = setup(deadInBranchReview);
  const before = readEvents(specs, "work").length;
  const out = await runBuild(base(root, specs, fakes(), { recovery: { action: "retry", task: "T2" } }));
  expect(out).toEqual({
    status: "could-not-start",
    reason: "nothing is open to retry — /build resume finishes the build, /build abort abandons it",
  });
  expect(readEvents(specs, "work").length).toBe(before);
});

// Killed during its own review, a task's branch already holds the whole
// commit. The resumed worker looks and changes nothing — which is the right
// answer, not a failure: "changed nothing" on a resume is measured against
// the base the branch was cut from, and a branch ahead of it goes to review.
test("resume of a task killed during its review reviews and merges the commit its branch already holds (real git)", async () => {
  const { root, specs } = await setupReal(deadAfterT1);
  const tree = await createWorktree(root, "work", "T2", runGit);
  writeFileSync(join(tree.path, "T2.txt"), "the whole task\n");
  await runGit(["add", "-A"], tree.path);
  await runGit(["commit", "-qm", "T2: built by vesna"], tree.path);
  const head = (await runGit(["rev-parse", "HEAD"], tree.path)).stdout.trim();

  // Answers with text only: nothing to write, nothing to commit.
  const textOnly: Provider = {
    id: "fake",
    async complete(): Promise<CompletionResult> {
      return {
        content: [{ type: "text", text: "already done" }],
        stopReason: "end_turn", model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const out = await runBuild({
    root, specsRoot: specs, slug: "work",
    provider: textOnly, registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
    recovery: { action: "resume" },
  });
  expect(out).toEqual({ status: "done" });
  expect(readFileSync(join(root, "T2.txt"), "utf8")).toBe("the whole task\n");
  const events = readEvents(specs, "work");
  expect(events.at(-1)).toEqual({ t: "build.done" });
  expect(events.some((e) => e.t === "task.failed")).toBe(false);
  // The commit the branch held is the one the log records as merged.
  expect(events.find((e) => e.t === "task.done" && (e as any).id === "T2")).toEqual({ t: "task.done", id: "T2", commit: head });
  expect(existsSync(tree.path)).toBe(false);
  expect((await runGit(["branch", "--list", "vesna/work/T2"], root)).stdout.trim()).toBe("");
});

test("a resumed worker that changes nothing on a branch with nothing on it is still a worker that changed nothing", async () => {
  const { root, specs } = setup(deadAfterT1);
  const f = fakes();
  const path = worktreePath(root, "work", "T2");
  mkdirSync(path, { recursive: true });
  const branch = branchName("work", "T2");
  const git = async (args: string[]) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return { code: 0, stdout: `worktree ${path}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/${branch}\n\n`, stderr: "" };
    }
    // The branch is exactly at base: no commits ahead.
    if (args[0] === "rev-list") return { code: 0, stdout: "0\n", stderr: "" };
    return f.git(args);
  };
  const resume = async (r: any): Promise<BuildResult> => ({ ...built(r.task, 1), status: "no-changes", commit: undefined });
  const out = await runBuild(base(root, specs, f, { recovery: { action: "resume" }, git, resume }));
  expect(out).toEqual({ status: "stopped", reason: "T2: the worker changed nothing" });
});

// On a dead build, retry's task is the one the build left running: retrying
// a todo task instead would leave the in-flight checkout neither discarded
// nor resumed, and the build would rebuild it from scratch and collide on
// its branch — with a `build.recovered retry T3` in the log that names a
// task the failure had nothing to do with.
test("retry on a dead build must name the in-flight task, not a task still to do", async () => {
  const { root, specs } = setup([
    { t: "task.added", id: "T1", title: "First" },
    { t: "task.added", id: "T2", title: "Second", dependsOn: ["T1"] },
    { t: "task.added", id: "T3", title: "Third", dependsOn: ["T1"] },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "task.started", id: "T1", agent: "vesna build" },
    { t: "task.done", id: "T1", commit: "sha-T1" },
    { t: "task.started", id: "T2", agent: "vesna build" },
  ]);
  const f = fakes();
  const before = readEvents(specs, "work").length;
  const out = await runBuild(base(root, specs, f, { recovery: { action: "retry", task: "T3" } }));
  expect(out).toEqual({
    status: "could-not-start",
    reason: 'only the interrupted task "T2" can be retried while it is in flight — /build retry T2',
  });
  expect(f.log).toEqual([]);
  expect(readEvents(specs, "work").length).toBe(before);
});

// A cancel usually lands inside the worker's model call. The real providers
// hand the signal to `fetch`, which rejects with an AbortError; `work()`
// catches everything the session throws and returns a failed result with
// the abort's text. The loop has to read that result as the interruption it
// was — the signal says so — not as a worker that failed with "aborted".
function abortsWhenCancelled(controller: AbortController): Provider {
  return {
    id: "fake",
    async complete(request): Promise<CompletionResult> {
      // The person cancels while the call is in flight; fetch rejects.
      controller.abort();
      if (request.signal?.aborted) throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      throw new Error("unreachable");
    },
  };
}

test("a cancel that lands inside the worker's model call is interrupted, not a failed worker (real git)", async () => {
  const { root, specs } = await setupReal(oneApproved);
  const controller = new AbortController();
  const out = await runBuild({
    root, specsRoot: specs, slug: "work",
    provider: abortsWhenCancelled(controller), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
    signal: controller.signal,
  });
  expect(out).toEqual({ status: "stopped", reason: "interrupted" });
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "task.failed")).toEqual([{ t: "task.failed", id: "T1", reason: "interrupted" }]);
  expect(events.at(-1)).toEqual({ t: "build.stopped", reason: "interrupted" });
});

test("a failed result handed back after the signal fired is interrupted, on the first attempt and on a fix round", async () => {
  const { root, specs } = setup(oneApproved);
  const controller = new AbortController();
  const f = fakes();
  const build = async (r: any): Promise<BuildResult> => {
    controller.abort();
    return { ...built(r.task, 1), status: "failed", error: "The operation was aborted." };
  };
  const out = await runBuild(base(root, specs, f, { build, signal: controller.signal }));
  expect(out).toEqual({ status: "stopped", reason: "interrupted" });
  expect(readEvents(specs, "work").filter((e) => e.t === "task.failed")).toEqual([{ t: "task.failed", id: "T1", reason: "interrupted" }]);

  const { root: r2, specs: s2 } = setup(oneApproved);
  const c2 = new AbortController();
  const bad: Finding = { severity: "important", file: "a.ts", text: "wrong" };
  const f2 = fakes({ reviews: [{ kind: "verdict", verdict: { spec: "met", findings: [bad], summary: "one" }, costUsd: 0 }] });
  const resume = async (r: any): Promise<BuildResult> => {
    c2.abort();
    return { ...built(r.task, 2), status: "failed", error: "The operation was aborted." };
  };
  const out2 = await runBuild(base(r2, s2, f2, { resume, signal: c2.signal }));
  expect(out2).toEqual({ status: "stopped", reason: "interrupted" });
  expect(readEvents(s2, "work").filter((e) => e.t === "task.failed")).toEqual([{ t: "task.failed", id: "T1", reason: "interrupted" }]);
});

// A cancel that lands while the worker is inside a tool call, before it has
// changed anything: the session loop breaks on the signal and `work()`
// returns "no-changes" rather than a failed result. That is still the
// person's cancel, not a worker that looked and decided there was nothing to
// do — the log should read "interrupted", not "the worker changed nothing".
test("a cancel that lands mid-tool-call, before anything changed, is interrupted, not a no-op worker", async () => {
  const { root, specs } = setup(oneApproved);
  const controller = new AbortController();
  const build = async (r: any): Promise<BuildResult> => {
    controller.abort();
    return { ...built(r.task, 1), status: "no-changes", commit: undefined };
  };
  const out = await runBuild(base(root, specs, fakes(), { build, signal: controller.signal }));
  expect(out).toEqual({ status: "stopped", reason: "interrupted" });
  expect(readEvents(specs, "work").filter((e) => e.t === "task.failed")).toEqual([{ t: "task.failed", id: "T1", reason: "interrupted" }]);
  expect(readEvents(specs, "work").at(-1)).toEqual({ t: "build.stopped", reason: "interrupted" });
});

// Verification in the plan: T1 carries a `verify:` line, T2 does not.
const PLAN_WITH_VERIFY = `# Plan

### Task 1: First
verify: bun test

Do the first thing.

### Task 2: Second
Do the second thing.
`;

const verifyLogs = (specs: string) => join(specPaths(specs, "work").dir, "verify");

test("a task with verify: is checked after the review and after the merge, in that order", async () => {
  const { root, specs } = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const f = fakes();
  const verify = async (r: any) => {
    f.log.push(`verify ${r.logPath.split("/").pop()} ${r.cwd === root ? "root" : "worktree"}`);
    return { code: 0, ms: 1, timedOut: false, tail: "" };
  };
  const outcome = await runBuild(base(root, specs, f, { verify }));
  expect(outcome).toEqual({ status: "done" });
  expect(f.log).toEqual([
    "build T1", "review", "verify T1-review-r0.log worktree", "merge T1", "verify T1-merge.log root",
    "build T2", "review", "merge T2", "review",
  ]);
  const events = readEvents(specs, "work").map((e) => e.t);
  expect(events.indexOf("verify.declared")).toBeLessThan(events.indexOf("task.started"));
  // The build's own events for each task — the fixture's task.added aside.
  const ofTask = (id: string) =>
    readEvents(specs, "work").filter((e: any) => e.t !== "task.added" && (e.task === id || e.id === id)).map((e) => e.t);
  expect(ofTask("T1")).toEqual(["verify.declared", "task.started", "review.done", "verify.done", "verify.done", "task.done"]);
  expect(ofTask("T2")).toEqual(["task.started", "review.done", "task.done"]);
});

test("a failing check before the merge is a fix round with the output, on the review's counter", async () => {
  const { root, specs } = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const f = fakes();
  let calls = 0;
  const verify = async () =>
    ++calls === 1 ? { code: 3, ms: 1, timedOut: false, tail: "expected 2, got 3" } : { code: 0, ms: 1, timedOut: false, tail: "" };
  const resume = async (r: any) => {
    f.log.push(`resume ${r.task}: ${r.message.includes("verify failed: `bun test` exited 3") && r.message.includes("expected 2, got 3")}`);
    return built(r.task, 2);
  };
  const outcome = await runBuild(base(root, specs, f, { verify, resume }));
  expect(outcome).toEqual({ status: "done" });
  expect(f.log).toContain("resume T1: true");
  expect(f.log.slice(0, 6)).toEqual(["build T1", "review", "resume T1: true", "review", "merge T1", "build T2"]);
  const events = readEvents(specs, "work");
  expect(events.filter((e: any) => e.t === "verify.done" && e.stage === "review").map((e: any) => e.code)).toEqual([3, 0]);
  expect(events.filter((e: any) => e.t === "review.done" && e.task === "T1").map((e: any) => e.round)).toEqual([0, 1]);
});

test("a check still failing at the cap stops the build like a brief still not met", async () => {
  const { root, specs } = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const f = fakes();
  const verify = async () => ({ code: 1, ms: 1, timedOut: false, tail: "no" });
  const outcome = await runBuild(base(root, specs, f, { verify, maxRounds: 2 }));
  expect(outcome).toEqual({ status: "stopped", reason: "T1: verify still fails after 2 fix rounds" });
  expect(f.log.filter((l) => l.startsWith("resume"))).toEqual(["resume T1", "resume T1"]);
  expect(readEvents(specs, "work").some((e) => e.t === "parked")).toBe(false);
});

test("a failing check after the merge keeps task.done, writes verify.failed, and stops", async () => {
  const { root, specs } = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const f = fakes();
  const verify = async (r: any) =>
    r.cwd === root ? { code: 2, ms: 1, timedOut: false, tail: "x" } : { code: 0, ms: 1, timedOut: false, tail: "" };
  const outcome = await runBuild(base(root, specs, f, { verify }));
  expect(outcome).toEqual({ status: "stopped", reason: "T1: verify failed after merge — see verify/T1-merge.log" });
  const events = readEvents(specs, "work");
  const tail = events.slice(-3).map((e) => e.t);
  expect(tail).toEqual(["task.done", "verify.failed", "build.stopped"]);
  expect(events.find((e: any) => e.t === "verify.failed")).toEqual({ t: "verify.failed", task: "T1", stage: "merge", code: 2 });
  expect(f.log.filter((l) => l.startsWith("build "))).toEqual(["build T1"]);
  const tree = project(events)!;
  expect(tree.tasks.find((t) => t.id === "T1")).toMatchObject({ state: "done" });
  expect(tree.building).toBe(false);
});

test("a timeout is verify.failed with no code at either stage", async () => {
  const { root, specs } = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const f = fakes();
  let calls = 0;
  const verify = async () =>
    ++calls === 1 ? { code: null, ms: 300, timedOut: true, tail: "" } : { code: 0, ms: 1, timedOut: false, tail: "" };
  const outcome = await runBuild(base(root, specs, f, { verify }));
  expect(outcome).toEqual({ status: "done" });
  expect(readEvents(specs, "work").find((e: any) => e.t === "verify.failed"))
    .toEqual({ t: "verify.failed", task: "T1", stage: "review", code: null, reason: "timeout" });
  expect(f.log).toContain("resume T1");

  // And at the merge stage: task.done stands, verify.failed carries no code, the build stops.
  const again = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const g = fakes();
  const slow = async (r: any) =>
    r.cwd === again.root ? { code: null, ms: 300, timedOut: true, tail: "" } : { code: 0, ms: 1, timedOut: false, tail: "" };
  const stopped = await runBuild(base(again.root, again.specs, g, { verify: slow }));
  expect(stopped).toEqual({ status: "stopped", reason: "T1: verify failed after merge — see verify/T1-merge.log" });
  const events = readEvents(again.specs, "work");
  expect(events.slice(-3).map((e) => e.t)).toEqual(["task.done", "verify.failed", "build.stopped"]);
  expect(events.find((e: any) => e.t === "verify.failed"))
    .toEqual({ t: "verify.failed", task: "T1", stage: "merge", code: null, reason: "timeout" });
});

test("a plan that changed after its approval is refused before the lock", async () => {
  const { root, specs } = setup(
    [
      ...approvedWithTasks.filter((e: any) => !(e.t === "approved" && e.what === "plan")),
      { t: "approved", what: "plan", digest: "not-the-plan" },
    ],
    PLAN_WITH_VERIFY,
  );
  const f = fakes();
  const outcome = await runBuild(base(root, specs, f));
  expect(outcome).toEqual({ status: "could-not-start", reason: "plan.md changed after it was approved — approve it again" });
  expect(f.log).toEqual([]);
  expect(existsSync(join(specs, "work", "build.lock"))).toBe(false);
  expect(readEvents(specs, "work").some((e) => e.t === "build.started")).toBe(false);
});

test("an approval whose digest matches the plan on disk starts as usual", async () => {
  const { root, specs } = setup(
    approvedWithTasks.filter((e: any) => !(e.t === "approved" && e.what === "plan")),
    PLAN_WITH_VERIFY,
  );
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(PLAN_WITH_VERIFY).digest("hex");
  appendEvent(specs, "work", { t: "approved", what: "plan", digest });
  const f = fakes();
  const verify = async () => ({ code: 0, ms: 1, timedOut: false, tail: "" });
  expect(await runBuild(base(root, specs, f, { verify }))).toEqual({ status: "done" });
});

test("the check is interrupted like anything else: the task fails interrupted and the build stops", async () => {
  const { root, specs } = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const controller = new AbortController();
  const f = fakes();
  const verify = async () => {
    controller.abort();
    throw Object.assign(new Error("interrupted"), { name: "AbortedError" });
  };
  const outcome = await runBuild(base(root, specs, f, { verify, signal: controller.signal }));
  expect(outcome).toEqual({ status: "stopped", reason: "interrupted" });
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "task.failed")).toEqual([{ t: "task.failed", id: "T1", reason: "interrupted" }]);
  expect(events.at(-1)).toEqual({ t: "build.stopped", reason: "interrupted" });
  expect(events.some((e) => e.t === "verify.done" || e.t === "verify.failed")).toBe(false);
});

test("on real sh: the check runs in the task's worktree, then in the root, and its logs are kept", async () => {
  const repo = await repository();
  const specs = join(repo, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of [
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ] as SpecEvent[]) appendEvent(specs, "work", e);
  writeSpecFile(
    specPaths(specs, "work").plan,
    "# Plan\n\n### Task 1: First\nverify: test -f T1.txt && echo present\n\nWrite T1.txt.\n",
  );

  const out = await runBuild({
    root: repo, specsRoot: specs, slug: "work",
    provider: writes("T1.txt", "one\n"), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
  });
  expect(out).toEqual({ status: "done" });

  const logs = verifyLogs(specs);
  expect(existsSync(join(logs, "T1-review-r0.log"))).toBe(true);
  expect(existsSync(join(logs, "T1-merge.log"))).toBe(true);
  expect(readFileSync(join(logs, "T1-review-r0.log"), "utf8")).toContain("present");
  expect(readFileSync(join(logs, "T1-merge.log"), "utf8")).toContain("present");
  const events = readEvents(specs, "work");
  expect(events.filter((e: any) => e.t === "verify.done").map((e: any) => [e.stage, e.code])).toEqual([["review", 0], ["merge", 0]]);
  expect(project(events)!.tasks.find((t) => t.id === "T1")?.evidence.vesna).toBe(true);
  // Merged and cleaned up as after any merge.
  expect(readFileSync(join(repo, "T1.txt"), "utf8")).toBe("one\n");
  expect(existsSync(join(repo, ".vesna", "worktrees", "work-T1"))).toBe(false);
  expect((await runGit(["branch", "--list", "vesna/work/T1"], repo)).stdout.trim()).toBe("");
});

test("on real sh: a cancel during the check ends the build interrupted and leaves no process", async () => {
  const repo = await repository();
  const specs = join(repo, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of [
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ] as SpecEvent[]) appendEvent(specs, "work", e);
  const marker = `vesna-verify-cancel-${process.pid}`;
  writeSpecFile(
    specPaths(specs, "work").plan,
    `# Plan\n\n### Task 1: First\nverify: sleep 30 # ${marker}\n\nWrite T1.txt.\n`,
  );

  const controller = new AbortController();
  const out = await runBuild({
    root: repo, specsRoot: specs, slug: "work",
    provider: writes("T1.txt", "one\n"), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
    signal: controller.signal,
    // The person cancels once the check is running: after the review's
    // verdict, the loop is inside `sh -c "sleep 30 ..."`.
    onEvent: (e) => {
      if (e.t === "review.done") setTimeout(() => controller.abort(), 200);
    },
  });
  expect(out).toEqual({ status: "stopped", reason: "interrupted" });
  const events = readEvents(specs, "work");
  expect(events.filter((e) => e.t === "task.failed")).toEqual([{ t: "task.failed", id: "T1", reason: "interrupted" }]);
  expect(events.at(-1)).toEqual({ t: "build.stopped", reason: "interrupted" });
  expect(events.some((e) => e.t === "verify.done" || e.t === "verify.failed")).toBe(false);
  const left = Bun.spawnSync(["pgrep", "-f", marker]);
  expect(left.stdout.toString().trim()).toBe("");
});

// Fix round 1: once the merge succeeded the task is done whatever the check
// does next — an interrupt inside the merge-stage check included. Before
// this, that window recorded the merged task as failed, and no recovery
// could move it: retry found the work already on main.
test("a cancel during the merge-stage check still records task.done, and the build ends interrupted", async () => {
  const { root, specs } = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const controller = new AbortController();
  const f = fakes();
  const verify = async (r: any) => {
    if (r.cwd !== root) return { code: 0, ms: 1, timedOut: false, tail: "" };
    controller.abort();
    throw Object.assign(new Error("interrupted"), { name: "AbortedError" });
  };
  const outcome = await runBuild(base(root, specs, f, { verify, signal: controller.signal }));
  expect(outcome).toEqual({ status: "stopped", reason: "interrupted" });
  const events = readEvents(specs, "work");
  expect(events.slice(-3)).toEqual([
    { t: "verify.done", task: "T1", stage: "review", code: 0, ms: 1 },
    { t: "task.done", id: "T1", commit: "sha-T1-1" },
    { t: "build.stopped", reason: "interrupted" },
  ]);
  expect(events.some((e) => e.t === "task.failed")).toBe(false);
  expect(events.filter((e: any) => e.t === "verify.failed" || (e.t === "verify.done" && e.stage === "merge"))).toEqual([]);
  const tree = project(events)!;
  expect(tree.tasks.find((t) => t.id === "T1")).toMatchObject({ state: "done" });
  expect(tree.building).toBe(false);
  expect(existsSync(join(specs, "work", "build.lock"))).toBe(false);
});

test("on real sh: a cancel during the merge-stage check keeps the merge, records task.done, and cleans up", async () => {
  const repo = await repository();
  const specs = join(repo, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of [
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ] as SpecEvent[]) appendEvent(specs, "work", e);
  const marker = `vesna-verify-merge-cancel-${process.pid}`;
  // Passes in the task's checkout (its branch is not main); on main it
  // sleeps, and that is where the person cancels.
  writeSpecFile(
    specPaths(specs, "work").plan,
    `# Plan\n\n### Task 1: First\nverify: test "$(git rev-parse --abbrev-ref HEAD)" != main || sleep 30 # ${marker}\n\nWrite T1.txt.\n`,
  );

  const controller = new AbortController();
  const out = await runBuild({
    root: repo, specsRoot: specs, slug: "work",
    provider: writes("T1.txt", "one\n"), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
    signal: controller.signal,
    onEvent: (e) => {
      if (e.t === "verify.done" && e.stage === "review") setTimeout(() => controller.abort(), 300);
    },
  });
  expect(out).toEqual({ status: "stopped", reason: "interrupted" });
  const events = readEvents(specs, "work");
  expect(events.slice(-3).map((e: any) => [e.t, e.stage ?? e.reason ?? e.id])).toEqual([
    ["verify.done", "review"], ["task.done", "T1"], ["build.stopped", "interrupted"],
  ]);
  expect(events.some((e) => e.t === "task.failed")).toBe(false);
  const tree = project(events)!;
  expect(tree.tasks.find((t) => t.id === "T1")).toMatchObject({ state: "done" });
  expect(tree.building).toBe(false);
  // The merge stands on main; the checkout and branch are gone as after any merge.
  expect(readFileSync(join(repo, "T1.txt"), "utf8")).toBe("one\n");
  expect(existsSync(join(repo, ".vesna", "worktrees", "work-T1"))).toBe(false);
  expect((await runGit(["branch", "--list", "vesna/work/T1"], repo)).stdout.trim()).toBe("");
  expect(existsSync(join(specs, "work", "build.lock"))).toBe(false);
  expect(Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim()).toBe("");
  // A killed check proved nothing and writes no log; the review-stage one did.
  expect(existsSync(join(verifyLogs(specs), "T1-review-r0.log"))).toBe(true);
  expect(existsSync(join(verifyLogs(specs), "T1-merge.log"))).toBe(false);
});

// Fix round 1: the review-stage check runs on every path that leads to the
// merge — the parked path at the cap included, not only "met with nothing
// open".
test("the parked path at the cap still runs the check before the merge, and a failure there stops the build", async () => {
  const important: Finding = { severity: "important", file: "a.ts", text: "could be tighter" };
  const metWithOne: ReviewOutcome = { kind: "verdict", verdict: { spec: "met", findings: [important], summary: "fine" }, costUsd: 0 };

  const passing = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const f = fakes();
  const verify = async (r: any) => { f.log.push(`verify ${r.logPath.split("/").pop()}`); return { code: 0, ms: 1, timedOut: false, tail: "" }; };
  const outcome = await runBuild(base(passing.root, passing.specs, f, { verify, maxRounds: 1, review: async () => { f.log.push("review"); return metWithOne; } }));
  expect(outcome).toEqual({ status: "done" });
  expect(f.log.slice(0, 6)).toEqual(["build T1", "review", "resume T1", "review", "verify T1-review-r1.log", "merge T1"]);
  expect(readEvents(passing.specs, "work").filter((e: any) => e.t === "parked" && e.task === "T1")).toHaveLength(1);

  const failing = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const g = fakes();
  const fails = async () => ({ code: 1, ms: 1, timedOut: false, tail: "no" });
  const stopped = await runBuild(base(failing.root, failing.specs, g, { verify: fails, maxRounds: 1, review: async () => metWithOne }));
  expect(stopped).toEqual({ status: "stopped", reason: "T1: verify still fails after 1 fix rounds" });
  expect(g.log).not.toContain("merge T1");
});

// Fix round 1: the reviewer never runs the command, so it cannot judge
// whether a verify failure was addressed. The review after a verify failure
// is a fresh one; after the reviewer's own findings it stays scoped to them.
test("the review after a verify failure is fresh; after the reviewer's own findings it is scoped to them", async () => {
  const seen: (Finding[] | undefined)[] = [];
  const reviewing = async (r: any) => { seen.push(r.findings); return clean; };

  const afterVerify = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const f = fakes();
  let calls = 0;
  const verify = async () =>
    ++calls === 1 ? { code: 3, ms: 1, timedOut: false, tail: "boom" } : { code: 0, ms: 1, timedOut: false, tail: "" };
  expect(await runBuild(base(afterVerify.root, afterVerify.specs, f, { verify, review: reviewing }))).toEqual({ status: "done" });
  expect(seen).toEqual([undefined, undefined, undefined, undefined]);
  expect(f.log.filter((l) => l.startsWith("resume"))).toEqual(["resume T1"]);

  seen.length = 0;
  const afterReviewer = setup(approvedWithTasks, PLAN_WITH_VERIFY);
  const g = fakes();
  const wrong: Finding = { severity: "important", file: "a.ts", line: 2, text: "wrong" };
  let round = 0;
  const scoped = async (r: any) => {
    seen.push(r.findings);
    round += 1;
    return round === 1 ? { kind: "verdict", verdict: { spec: "met", findings: [wrong], summary: "one" }, costUsd: 0 } as ReviewOutcome : clean;
  };
  const ok = async () => ({ code: 0, ms: 1, timedOut: false, tail: "" });
  expect(await runBuild(base(afterReviewer.root, afterReviewer.specs, g, { verify: ok, review: scoped }))).toEqual({ status: "done" });
  expect(seen).toEqual([undefined, [wrong], undefined, undefined]);
});

// Final fix round, item 1: a process that died — not cancelled — after the
// merge and before `task.done`. The log says T1 is running; git says its
// branch is already an ancestor of main. A seam cannot reproduce it: the
// loop's `finally` would still run. So the build runs in a child `bun`
// that is SIGKILLed while the merge-stage check sleeps on main, and each
// recovery then runs in this process against what the kill left behind.
import { writesWhatTheBriefNames } from "../fixtures/build-child";

async function killedDuringMergeCheck() {
  const repo = await repository();
  const specs = join(repo, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of [
    { t: "task.added", id: "T1", title: "First" },
    { t: "task.added", id: "T2", title: "Second", dependsOn: ["T1"] },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  ] as SpecEvent[]) appendEvent(specs, "work", e);
  // Flags outside the repository: `running` says the check is on main and
  // asleep, `pass` (written by the test before a recovery) makes the same
  // command pass on main the next time.
  const flags = mkdtempSync(join(tmpdir(), "vesna-loop-kill-flags-"));
  const marker = `vesna-verify-kill-${process.pid}-${Date.now()}`;
  writeSpecFile(
    specPaths(specs, "work").plan,
    [
      "# Plan", "",
      "### Task 1: First",
      `verify: test "$(git rev-parse --abbrev-ref HEAD)" != main || test -f ${flags}/pass || { touch ${flags}/running; sleep 30; } # ${marker}`,
      "", "Write T1.txt.", "",
      "### Task 2: Second",
      "Write T2.txt.", "",
    ].join("\n"),
  );

  const child = Bun.spawn(["bun", join(import.meta.dir, "..", "fixtures", "build-child.ts"), repo], {
    cwd: join(import.meta.dir, "..", ".."),
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(flags, "running"))) {
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`the child never reached the merge-stage check: ${await new Response(child.stderr).text()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill("SIGKILL");
  await child.exited;
  // The check's `sh`/`sleep` outlive their parent; nothing waits on them.
  Bun.spawnSync(["pkill", "-f", marker]);

  // What the kill left: T1 merged on main, running in the log, its checkout
  // and branch still there, the lock naming a dead pid.
  const events = readEvents(specs, "work");
  expect(events.at(-1)).toEqual({ t: "verify.done", task: "T1", stage: "review", code: 0, ms: expect.any(Number) });
  expect(project(events)!.tasks.find((t) => t.id === "T1")).toMatchObject({ state: "running" });
  expect((await runGit(["log", "--format=%s", "-1", "main"], repo)).stdout.trim()).toBe("merge T1");
  expect((await runGit(["branch", "--list", "vesna/work/T1"], repo)).stdout.trim()).not.toBe("");
  expect(existsSync(worktreePath(repo, "work", "T1"))).toBe(true);
  const head = (await runGit(["rev-parse", "vesna/work/T1"], repo)).stdout.trim();
  const before = events.length;
  writeFileSync(join(flags, "pass"), "");
  return { repo, specs, head, before };
}

function recover(repo: string, specs: string, recovery: { action: "resume" | "retry" | "abort"; task?: string }) {
  return runBuild({
    root: repo, specsRoot: specs, slug: "work",
    provider: writesWhatTheBriefNames(), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
    recovery,
  });
}

async function cleanAfterRecovery(repo: string) {
  expect((await runGit(["branch", "--list", "vesna/*"], repo)).stdout.trim()).toBe("");
  expect(existsSync(worktreePath(repo, "work", "T1"))).toBe(false);
  expect(existsSync(join(repo, ".vesna", "specs", "work", "build.lock"))).toBe(false);
}

for (const action of ["resume", "retry"] as const) {
  test(`${action} after a kill during the merge-stage check records the merge, runs the check on main, and builds the rest (real git)`, async () => {
    const { repo, specs, head, before } = await killedDuringMergeCheck();
    const out = await recover(repo, specs, action === "retry" ? { action, task: "T1" } : { action });
    expect(out).toEqual({ status: "done" });

    const events = readEvents(specs, "work");
    const since = events.slice(before).map((e: any) => [e.t, e.id ?? e.task ?? e.action ?? e.reason ?? null]);
    // No worker ran for T1: the merge git already holds is recorded first,
    // then the recovery, then the check on main, then T2 as usual.
    expect(events.slice(before, before + 3)).toEqual([
      { t: "task.done", id: "T1", commit: head },
      { t: "build.recovered", action, task: "T1" },
      { t: "build.started", base: expect.any(String) },
    ]);
    expect(since.filter(([t]) => t === "task.started")).toEqual([["task.started", "T2"]]);
    expect(events.slice(before).filter((e: any) => e.t === "verify.done")).toEqual([
      { t: "verify.done", task: "T1", stage: "merge", code: 0, ms: expect.any(Number) },
    ]);
    expect(since.filter(([t]) => t === "task.failed" || t === "verify.failed")).toEqual([]);
    expect(events.at(-1)).toEqual({ t: "build.done" });

    const tree = project(events)!;
    expect(tree.tasks.find((t) => t.id === "T1")).toMatchObject({ state: "done", commit: head });
    expect(tree.tasks.find((t) => t.id === "T1")!.evidence).toEqual({ worker: true, reviewer: true, vesna: true });
    expect(tree.tasks.find((t) => t.id === "T2")).toMatchObject({ state: "done" });
    expect(readFileSync(join(repo, "T1.txt"), "utf8")).toBe("T1.txt\n");
    expect(readFileSync(join(repo, "T2.txt"), "utf8")).toBe("T2.txt\n");
    expect(existsSync(join(verifyLogs(specs), "T1-merge.log"))).toBe(true);
    await cleanAfterRecovery(repo);
  });
}

test("abort after a kill during the merge-stage check records the merge, then abandons the build and cleans up (real git)", async () => {
  const { repo, specs, head, before } = await killedDuringMergeCheck();
  const out = await recover(repo, specs, { action: "abort" });
  expect(out).toEqual({ status: "stopped", reason: "abandoned" });

  const events = readEvents(specs, "work");
  expect(events.slice(before)).toEqual([
    { t: "task.done", id: "T1", commit: head },
    { t: "build.recovered", action: "abort", task: "T1" },
    { t: "build.stopped", reason: "abandoned" },
  ]);
  const tree = project(events)!;
  expect(tree.tasks.map((t) => [t.id, t.state])).toEqual([["T1", "done"], ["T2", "todo"]]);
  expect(tree.building).toBe(false);
  // The merge stands; the check did not run again.
  expect((await runGit(["log", "--format=%s", "-1", "main"], repo)).stdout.trim()).toBe("merge T1");
  expect(existsSync(join(verifyLogs(specs), "T1-merge.log"))).toBe(false);
  await cleanAfterRecovery(repo);
});

// Final fix round, item 4: after a post-merge failure the base branch is
// red, and the next plain start used to build the remaining tasks on it
// and end `build.done` with the failed task's mark still standing. Now a
// plain start re-runs the merge-stage check for every done task whose
// check was declared and never passed — in task order, on the root, before
// anything is scheduled — and stops the same way the merge did if it is
// still red.
const redMain: SpecEvent[] = [
  ...approvedWithTasks,
  { t: "build.started" },
  { t: "verify.declared", task: "T1" },
  { t: "task.started", id: "T1", agent: "vesna build" },
  { t: "review.done", task: "T1", round: 0, spec: "met", findings: [] },
  { t: "verify.done", task: "T1", stage: "review", code: 0, ms: 1 },
  { t: "task.done", id: "T1", commit: "sha-T1-1" },
  { t: "verify.failed", task: "T1", stage: "merge", code: 2 },
  { t: "build.stopped", reason: "T1: verify failed after merge — see verify/T1-merge.log" },
];

test("a plain start on a red main re-runs the failed task's check on the root before building anything", async () => {
  const { root, specs } = setup(redMain, PLAN_WITH_VERIFY);
  const f = fakes();
  const verify = async (r: any) => {
    f.log.push(`verify ${r.logPath.split("/").pop()} ${r.cwd === root ? "root" : "worktree"}`);
    return { code: 0, ms: 7, timedOut: false, tail: "" };
  };
  const before = readEvents(specs, "work").length;
  const outcome = await runBuild(base(root, specs, f, { verify }));
  expect(outcome).toEqual({ status: "done" });
  expect(f.log).toEqual(["verify T1-merge.log root", "build T2", "review", "merge T2", "review"]);
  const events = readEvents(specs, "work");
  expect(events.slice(before, before + 3)).toEqual([
    { t: "build.started", base: "start-sha" },
    { t: "verify.done", task: "T1", stage: "merge", code: 0, ms: 7 },
    { t: "task.started", id: "T2", agent: "vesna build" },
  ]);
  expect(events.at(-1)).toEqual({ t: "build.done" });
  const tree = project(events)!;
  expect(tree.tasks.find((t) => t.id === "T1")!.evidence).toEqual({ worker: true, reviewer: true, vesna: true });
  expect(tree.tasks.find((t) => t.id === "T2")).toMatchObject({ state: "done" });
});

test("a plain start on a main that is still red stops as the merge did, and schedules nothing", async () => {
  const { root, specs } = setup(redMain, PLAN_WITH_VERIFY);
  const f = fakes();
  const verify = async () => ({ code: 3, ms: 1, timedOut: false, tail: "still no" });
  const before = readEvents(specs, "work").length;
  const outcome = await runBuild(base(root, specs, f, { verify }));
  expect(outcome).toEqual({ status: "stopped", reason: "T1: verify failed after merge — see verify/T1-merge.log" });
  expect(f.log).toEqual([]);
  expect(readEvents(specs, "work").slice(before)).toEqual([
    { t: "build.started", base: "start-sha" },
    { t: "verify.failed", task: "T1", stage: "merge", code: 3 },
    { t: "build.stopped", reason: "T1: verify failed after merge — see verify/T1-merge.log" },
  ]);
  expect(existsSync(join(specs, "work", "build.lock"))).toBe(false);

  const again = setup(redMain, PLAN_WITH_VERIFY);
  const g = fakes();
  const slow = async () => ({ code: null, ms: 300, timedOut: true, tail: "" });
  const stopped = await runBuild(base(again.root, again.specs, g, { verify: slow }));
  expect(stopped).toEqual({ status: "stopped", reason: "T1: verify failed after merge — see verify/T1-merge.log" });
  expect(g.log).toEqual([]);
  expect(readEvents(again.specs, "work").at(-2)).toEqual({ t: "verify.failed", task: "T1", stage: "merge", code: null, reason: "timeout" });
});

test("on real sh: a post-merge failure, main fixed by hand, then a plain start re-checks, builds the rest, and T1 is vesna's", async () => {
  const repo = await repository();
  const specs = join(repo, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of approvedWithTasks) appendEvent(specs, "work", e);
  // Passes in the checkout (its branch is not main); on main only once
  // NOTES.md is there — which the worker never writes.
  writeSpecFile(
    specPaths(specs, "work").plan,
    [
      "# Plan", "",
      "### Task 1: First",
      'verify: test "$(git rev-parse --abbrev-ref HEAD)" != main || test -f NOTES.md',
      "", "Write T1.txt.", "",
      "### Task 2: Second",
      "Write T2.txt.", "",
    ].join("\n"),
  );
  const run = () => runBuild({
    root: repo, specsRoot: specs, slug: "work",
    provider: writesWhatTheBriefNames(), registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async () => clean,
  });

  expect(await run()).toEqual({ status: "stopped", reason: "T1: verify failed after merge — see verify/T1-merge.log" });
  let tree = project(readEvents(specs, "work"))!;
  expect(tree.tasks.map((t) => [t.id, t.state, t.evidence.vesna])).toEqual([["T1", "done", false], ["T2", "todo", null]]);

  // The person fixes main by hand.
  writeFileSync(join(repo, "NOTES.md"), "how to run it\n");
  await runGit(["add", "-A"], repo);
  await runGit(["commit", "-qm", "notes"], repo);

  const before = readEvents(specs, "work").length;
  expect(await run()).toEqual({ status: "done" });
  const events = readEvents(specs, "work");
  expect(events.slice(before, before + 2)).toEqual([
    { t: "build.started", base: expect.any(String) },
    { t: "verify.done", task: "T1", stage: "merge", code: 0, ms: expect.any(Number) },
  ]);
  expect(events.at(-1)).toEqual({ t: "build.done" });
  tree = project(events)!;
  expect(tree.tasks.map((t) => [t.id, t.state, t.evidence.vesna])).toEqual([["T1", "done", true], ["T2", "done", null]]);
  expect(readFileSync(join(repo, "T2.txt"), "utf8")).toBe("T2.txt\n");
  expect(readFileSync(join(verifyLogs(specs), "T1-merge.log"), "utf8")).toContain("exit 0");
  expect((await runGit(["branch", "--list", "vesna/*"], repo)).stdout.trim()).toBe("");
});

// A build's range is the build's, not one process's. `build.started` names
// the commit it starts from; a resume or a finishing start reuses the base
// the first start named, so the whole-branch review at the end reads the
// whole build. A log from before bases were recorded reviews from the sha
// read at this start, as it always did.
test("build.started names the commit the build starts from", async () => {
  const { root, specs } = setup(approvedWithTasks);
  const f = fakes();
  await runBuild(base(root, specs, f));
  const started = readEvents(specs, "work").find((e) => e.t === "build.started") as any;
  expect(started.base).toBe("start-sha");
});

// The T2 checkout a resume needs, faked the way the resume test above does
// it: a real directory at the worktree path, and a `worktree list` answer
// that registers it. Every other call falls through to `inner`.
function withT2Checkout(root: string, inner: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  const path = worktreePath(root, "work", "T2");
  mkdirSync(path, { recursive: true });
  const branch = branchName("work", "T2");
  return async (args: string[]) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return {
        code: 0,
        stdout: `worktree ${path}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/${branch}\n\n`,
        stderr: "",
      };
    }
    return inner(args);
  };
}

test("a resumed build reviews the whole branch from the first start, not from the resume point", async () => {
  // deadAfterT1 plus a base on its build.started; the git seam answers a
  // DIFFERENT sha now, as a real repository would after T1's merge.
  const events = deadAfterT1.map((e: any) => (e.t === "build.started" ? { ...e, base: "first-sha" } : e));
  const { root, specs } = setup(events);
  const f = fakes();
  const gitCalls: string[][] = [];
  const git = withT2Checkout(root, async (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "later-sha", stderr: "" };
    return { code: 0, stdout: "diff", stderr: "" };
  });
  const outcome = await runBuild(base(root, specs, f, { git, recovery: { action: "resume" } }));
  expect(outcome).toEqual({ status: "done" });
  expect(gitCalls.some((a) => a[0] === "diff" && a[1] === "first-sha...HEAD")).toBe(true);
  expect(gitCalls.some((a) => a[0] === "diff" && a[1] === "later-sha...HEAD")).toBe(false);
  const starts = readEvents(specs, "work").filter((e) => e.t === "build.started") as any[];
  expect(starts.map((s) => s.base)).toEqual(["first-sha", "first-sha"]);
});

test("an old log without a base reviews from the loop's own start, as before", async () => {
  const { root, specs } = setup(deadAfterT1); // no base on build.started
  const f = fakes();
  const git = withT2Checkout(root, f.git);
  const outcome = await runBuild(base(root, specs, f, { git, recovery: { action: "resume" } }));
  expect(outcome).toEqual({ status: "done" });
  expect(f.gitCalls.some((a) => a[0] === "diff" && a[1] === "start-sha...HEAD")).toBe(true);
});

// Every task merged, and the branch review said no: the build stopped with
// nothing left to build and something left to do — the review. That is a
// finishing build, and a plain start is how a person asks for it once the
// branch is fixed. "nothing to build" is for a build that finished.
const stoppedAtReview: SpecEvent[] = [
  { t: "task.added", id: "T1", title: "a" }, { t: "task.added", id: "T2", title: "b" },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  { t: "build.started", base: "first-sha" },
  { t: "task.started", id: "T1" }, { t: "review.done", task: "T1", round: 0, spec: "met", findings: [] }, { t: "task.done", id: "T1" },
  { t: "task.started", id: "T2" }, { t: "review.done", task: "T2", round: 0, spec: "met", findings: [] }, { t: "task.done", id: "T2" },
  { t: "review.done", task: "branch", round: 0, spec: "not_met", findings: [] },
  { t: "build.stopped", reason: "branch review: the brief is not met" },
];

test("a build the branch review stopped is finished by a plain start: no task runs, the review runs again", async () => {
  const { root, specs } = setup(stoppedAtReview);
  const f = fakes();
  const outcome = await runBuild(base(root, specs, f));
  expect(outcome).toEqual({ status: "done" });
  expect(f.log).toEqual(["review"]);
  const events = readEvents(specs, "work");
  expect(events.at(-1)!.t).toBe("build.done");
  expect(events.at(-2)!.t).toBe("review.done");
  expect((events.filter((e) => e.t === "build.started").at(-1) as any).base).toBe("first-sha");
  expect(f.gitCalls.some((a) => a[0] === "diff" && a[1] === "first-sha...HEAD")).toBe(true);
});

test("a finishing build re-checks a red task before reviewing", async () => {
  // stoppedAtReview, with T1's check declared and red after its merge; the
  // plan gives T1 a verify: line.
  const events = [
    ...stoppedAtReview.slice(0, 5),
    { t: "verify.declared", task: "T1" },
    ...stoppedAtReview.slice(5, 8), { t: "verify.failed", task: "T1", stage: "merge", code: 1 },
    ...stoppedAtReview.slice(8),
  ] as SpecEvent[];
  const { root, specs } = setup(events, PLAN_WITH_VERIFY);
  const f = fakes();
  const verify = async (r: any) => { f.log.push(`verify ${r.logPath.split("/").pop()}`); return { code: 0, ms: 1, timedOut: false, tail: "" }; };
  const outcome = await runBuild(base(root, specs, f, { verify }));
  expect(outcome).toEqual({ status: "done" });
  expect(f.log).toEqual(["verify T1-merge.log", "review"]);
});

test("after build.done a plain start is refused as before", async () => {
  const { root, specs } = setup([...stoppedAtReview.slice(0, -2), { t: "review.done", task: "branch", round: 0, spec: "met", findings: [] }, { t: "build.done" }]);
  const f = fakes();
  expect(await runBuild(base(root, specs, f))).toEqual({ status: "could-not-start", reason: "nothing to build — every task is merged" });
  expect(f.log).toEqual([]);
});

test("on real git: a build stopped at the branch review, finished by a plain start, reviews both tasks' files", async () => {
  // The state by hand: a real repository, two task branches really merged
  // on main, and the log of a build the branch review stopped whose base is
  // the sha before T1's merge.
  const { root, specs } = await setupReal(stoppedAtReview.filter((e) => e.t !== "build.started"));
  const first = (await runGit(["rev-parse", "HEAD"], root)).stdout.trim();
  for (const id of ["T1", "T2"]) {
    const tree = await createWorktree(root, "work", id, runGit);
    writeFileSync(join(tree.path, `${id}.txt`), `${id}\n`);
    await runGit(["add", "-A"], tree.path);
    await runGit(["commit", "-qm", `${id}: built`], tree.path);
    await runGit(["merge", "--no-ff", "-q", "-m", `merge ${id}`, tree.branch], root);
    await runGit(["worktree", "remove", "--force", tree.path], root);
    await runGit(["branch", "-D", tree.branch], root);
  }
  // The log is rewritten with the base in its place: setupReal appended the
  // rest already, so the file is rebuilt from scratch in order.
  rmSync(join(specs, "work"), { recursive: true, force: true });
  createSpec(specs, "work");
  for (const e of stoppedAtReview) appendEvent(specs, "work", e.t === "build.started" ? { t: "build.started", base: first } : e);
  writeSpecFile(specPaths(specs, "work").plan, planFor(stoppedAtReview));

  const diffs: string[] = [];
  const out = await runBuild({
    root, specsRoot: specs, slug: "work",
    provider: {} as any, registry: registry(),
    policy: { mode: "auto", allow: {}, deny: {} },
    review: async (r: any) => { diffs.push(r.diff); return clean; },
  });
  expect(out).toEqual({ status: "done" });
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toContain("T1.txt");
  expect(diffs[0]).toContain("T2.txt");
  expect(readEvents(specs, "work").at(-1)).toEqual({ t: "build.done" });
});
