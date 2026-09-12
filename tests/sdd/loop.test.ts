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

function setup(events: SpecEvent[]) {
  const root = mkdtempSync(join(tmpdir(), "vesna-loop-"));
  const specs = join(root, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const e of events) appendEvent(specs, "work", e);
  writeSpecFile(specPaths(specs, "work").plan, planFor(events));
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
  expect(events[at + 1]).toEqual({ t: "build.started" });
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
