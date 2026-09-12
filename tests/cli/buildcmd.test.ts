import { test, expect } from "bun:test";
import { exitFor, describeEvent } from "../../src/cli/buildcmd";

test("exit codes: done is 0, stopped for a person is 1, could not start is 2", () => {
  expect(exitFor({ status: "done" })).toBe(0);
  expect(exitFor({ status: "stopped", reason: "x" })).toBe(1);
  expect(exitFor({ status: "could-not-start", reason: "x" })).toBe(2);
});

test("events print as one line each, and the ones that are noise print nothing", () => {
  expect(describeEvent({ t: "build.started" })).toBe("building");
  expect(describeEvent({ t: "task.started", id: "T1", agent: "vesna build" })).toBe("T1  building");
  expect(describeEvent({ t: "review.done", task: "T1", round: 0, spec: "met", findings: [] })).toBe(
    "T1  review: met, 0 findings",
  );
  expect(
    describeEvent({
      t: "review.done",
      task: "T1",
      round: 2,
      spec: "not_met",
      findings: [{ severity: "important", file: "a", text: "b" }],
    }),
  ).toBe("T1  review round 2: not met, 1 finding");
  expect(describeEvent({ t: "task.done", id: "T1", commit: "abc1234def" })).toBe("T1  merged abc1234");
  expect(
    describeEvent({ t: "parked", task: "T1", finding: { severity: "minor", file: "a.ts", text: "nit" } }),
  ).toBe("T1  parked: [minor] a.ts — nit");
  expect(describeEvent({ t: "build.stopped", reason: "why" })).toBe("stopped: why");
  expect(describeEvent({ t: "build.done" })).toBe("done");
  expect(describeEvent({ t: "criterion.added", id: "c", text: "t" })).toBeNull();
});

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand } from "../../src/cli/buildcmd";
import { appendEvent, createSpec, readEvents, specPaths, writeSpecFile } from "../../src/spec/store";
import { createRegistry } from "../../src/registry/registry";
import { resolveTheme } from "../../src/tui/theme";
import type { BuildResult } from "../../src/work/builder";
import type { ReviewOutcome } from "../../src/sdd/review";
import type { MergeReport } from "../../src/work/merge";

/** A root with one approved, one-task spec, the way `vesna build` finds it. */
function rootWithSpec(): string {
  const root = mkdtempSync(join(tmpdir(), "vesna-buildcmd-"));
  const specs = join(root, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  appendEvent(specs, "work", { t: "task.added", id: "T1", title: "First" });
  appendEvent(specs, "work", { t: "approved", what: "spec" });
  appendEvent(specs, "work", { t: "approved", what: "plan" });
  writeSpecFile(specPaths(specs, "work").plan, "# Plan\n\n### Task 1: First\nDo it.\n");
  return root;
}

const built = (task: string): BuildResult => ({
  task, status: "committed", branch: `vesna/work/${task}`, worktree: `/wt/${task}`,
  commit: "sha", refusals: [], costUsd: 0, text: "did it",
});
const clean: ReviewOutcome = { kind: "verdict", verdict: { spec: "met", findings: [], summary: "ok" }, costUsd: 0 };
const seams = {
  review: async (): Promise<ReviewOutcome> => clean,
  merge: async (_repo: string, c: { task: string; branch: string }[]): Promise<MergeReport> => ({
    merged: [{ task: c[0]!.task, branch: c[0]!.branch }], pending: [],
  }),
  git: async (args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "start-sha", stderr: "" };
    return { code: 0, stdout: "diff", stderr: "" };
  },
};

function quiet<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  return run().finally(() => {
    console.log = log;
    console.error = error;
  });
}

test("ctrl-c during vesna build stops the build through the log instead of wedging the spec", async () => {
  const root = rootWithSpec();
  const listeners = process.listenerCount("SIGINT");
  let sawListener = false;
  const build = async (r: { task: string; signal?: AbortSignal }): Promise<BuildResult> => {
    // The person presses ctrl-c while the worker is busy.
    sawListener = process.listenerCount("SIGINT") > listeners;
    process.emit("SIGINT" as any);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (r.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return built(r.task);
  };
  const code = await quiet(() =>
    buildCommand("work", root, {
      provider: {} as any,
      registry: createRegistry(),
      policy: { mode: "auto", allow: {}, deny: {} },
      theme: resolveTheme("mono", { depth: 0 }),
      seams: { ...seams, build },
    }),
  );
  expect(sawListener).toBe(true);
  expect(code).toBe(1);
  const events = readEvents(join(root, ".vesna", "specs"), "work");
  expect(events.at(-1)).toEqual({ t: "build.stopped", reason: "interrupted" });
  expect(events).toContainEqual({ t: "task.failed", id: "T1", reason: "interrupted" });
  // The handler is gone once the build is over: the next ctrl-c must still end the process.
  expect(process.listenerCount("SIGINT")).toBe(listeners);
});

test("a finished spec is refused from the shell too", async () => {
  const root = rootWithSpec();
  const specs = join(root, ".vesna", "specs");
  appendEvent(specs, "work", { t: "build.started" });
  appendEvent(specs, "work", { t: "task.started", id: "T1" });
  appendEvent(specs, "work", { t: "task.done", id: "T1" });
  appendEvent(specs, "work", { t: "build.done" });
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: string) => { errors.push(line); };
  try {
    const code = await buildCommand("work", root, {
      provider: {} as any,
      registry: createRegistry(),
      policy: { mode: "auto", allow: {}, deny: {} },
      theme: resolveTheme("mono", { depth: 0 }),
      seams,
    });
    expect(code).toBe(2);
  } finally {
    console.error = error;
  }
  expect(errors).toEqual(["vesna: nothing to build — every task is merged"]);
});

import { recoveryFromFlags } from "../../src/cli/buildcmd";
import type { SpecEvent } from "../../src/spec/project";
import { branchName, worktreePath } from "../../src/work/worktree";

test("flags become a recovery, and only one at a time", () => {
  expect(recoveryFromFlags({})).toEqual({});
  expect(recoveryFromFlags({ resume: "true" })).toEqual({ recovery: { action: "resume" } });
  expect(recoveryFromFlags({ retry: "T2" })).toEqual({ recovery: { action: "retry", task: "T2" } });
  expect(recoveryFromFlags({ abort: "true" })).toEqual({ recovery: { action: "abort" } });
  expect(recoveryFromFlags({ retry: "true" })).toEqual({ error: "--retry needs a task: --retry T2" });
  expect(recoveryFromFlags({ resume: "true", abort: "true" })).toEqual({
    error: "one of --resume, --retry <task>, --abort — not two",
  });
});

test("a plain vesna build on a dead build exits 2 naming the flags, and --resume runs it", async () => {
  const root = mkdtempSync(join(tmpdir(), "vesna-buildcmd-dead-"));
  const specs = join(root, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  const deadAfterT1: SpecEvent[] = [
    { t: "task.added", id: "T1", title: "First" },
    { t: "task.added", id: "T2", title: "Second", dependsOn: ["T1"] },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "task.started", id: "T1", agent: "vesna build" },
    { t: "task.done", id: "T1", commit: "sha-T1" },
    { t: "task.started", id: "T2", agent: "vesna build" },
  ];
  for (const event of deadAfterT1) appendEvent(specs, "work", event);
  writeSpecFile(
    specPaths(specs, "work").plan,
    "# Plan\n\n### Task 1: First\nDo it.\n\n### Task 2: Second\nDo it.\n",
  );
  // Resume refuses a checkout that is not really there, so T2 gets a
  // directory the git seam reports as a registered worktree — mirrors
  // tests/tui/app.test.ts's dead-build resume test.
  const path = worktreePath(root, "work", "T2");
  mkdirSync(path, { recursive: true });
  const branch = branchName("work", "T2");
  const resumeSeams = {
    ...seams,
    resume: async (r: { task: string }) => built(r.task),
    git: async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          code: 0,
          stdout: `worktree ${path}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/${branch}\n\n`,
          stderr: "",
        };
      }
      return seams.git(args);
    },
  };
  const deps = {
    provider: {} as any,
    registry: createRegistry(),
    policy: { mode: "auto" as const, allow: {}, deny: {} },
    theme: resolveTheme("mono", { depth: 0 }),
  };
  const log = console.log;
  const error = console.error;
  const stderr: string[] = [];
  console.log = () => {};
  console.error = (line: string) => { stderr.push(line); };
  try {
    const plain = await buildCommand("work", root, { ...deps, seams: resumeSeams }, {});
    expect(plain).toBe(2);
    expect(stderr.join("\n")).toContain("/build resume");
    expect(stderr.join("\n")).toContain("vesna build work --resume | --retry <task> | --abort");
    const resumed = await buildCommand("work", root, { ...deps, seams: resumeSeams }, { resume: "true" });
    expect(resumed).toBe(0);
  } finally {
    console.log = log;
    console.error = error;
  }
});

test("vesna build --resume finishes a build killed during the whole-branch review, exit 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "vesna-buildcmd-review-"));
  const specs = join(root, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const event of [
    { t: "task.added", id: "T1", title: "First" },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "task.started", id: "T1", agent: "vesna build" },
    { t: "task.done", id: "T1", commit: "sha-T1" },
  ] as SpecEvent[]) appendEvent(specs, "work", event);
  writeSpecFile(specPaths(specs, "work").plan, "# Plan\n\n### Task 1: First\nDo it.\n");
  const deps = {
    provider: {} as any,
    registry: createRegistry(),
    policy: { mode: "auto" as const, allow: {}, deny: {} },
    theme: resolveTheme("mono", { depth: 0 }),
    seams,
  };
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = (line: string) => { stderr.push(line); };
  try {
    expect(await buildCommand("work", root, deps, {})).toBe(2);
    expect(stderr.join("\n")).toContain("was interrupted");
    expect(stderr.join("\n")).toContain("vesna build work --resume | --retry <task> | --abort");
    expect(await buildCommand("work", root, deps, { resume: "true" })).toBe(0);
  } finally {
    console.log = log;
    console.error = error;
  }
  expect(readEvents(specs, "work").at(-1)).toEqual({ t: "build.done" });
});

// Every refusal that names a /build word gets the shell's own spelling
// under it — not only "was interrupted". A shell user meeting "/build retry
// T2" with no flag beside it has been told the chat's words, not theirs.
function deadWithoutCheckout(): { root: string; specs: string } {
  const root = mkdtempSync(join(tmpdir(), "vesna-buildcmd-gone-"));
  const specs = join(root, ".vesna", "specs");
  mkdirSync(specs, { recursive: true });
  createSpec(specs, "work");
  for (const event of [
    { t: "task.added", id: "T1", title: "First" },
    { t: "task.added", id: "T2", title: "Second", dependsOn: ["T1"] },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "task.started", id: "T1", agent: "vesna build" },
    { t: "task.done", id: "T1", commit: "sha-T1" },
    { t: "task.started", id: "T2", agent: "vesna build" },
  ] as SpecEvent[]) appendEvent(specs, "work", event);
  writeSpecFile(specPaths(specs, "work").plan, "# Plan\n\n### Task 1: First\nDo it.\n\n### Task 2: Second\nDo it.\n");
  return { root, specs };
}

const shellDeps = () => ({
  provider: {} as any,
  registry: createRegistry(),
  policy: { mode: "auto" as const, allow: {}, deny: {} },
  theme: resolveTheme("mono", { depth: 0 }),
  seams,
});

async function capture(run: () => Promise<number>): Promise<{ code: number; stderr: string[] }> {
  const log = console.log;
  const error = console.error;
  const stderr: string[] = [];
  console.log = () => {};
  console.error = (line: string) => { stderr.push(line); };
  try {
    return { code: await run(), stderr };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("--resume on a build whose checkout is gone names the flags under the chat's words", async () => {
  const { root } = deadWithoutCheckout();
  const { code, stderr } = await capture(() => buildCommand("work", root, shellDeps(), { resume: "true" }));
  expect(code).toBe(2);
  expect(stderr).toEqual([
    'vesna: the checkout of "T2" is gone — /build retry T2 or /build abort',
    "  from the shell: vesna build work --resume | --retry <task> | --abort",
  ]);
});

test("a plain vesna build on a task a stop left a checkout for names the flags under the chat's words", async () => {
  const root = rootWithSpec();
  const specs = join(root, ".vesna", "specs");
  appendEvent(specs, "work", { t: "build.started" });
  appendEvent(specs, "work", { t: "task.started", id: "T1", agent: "vesna build" });
  appendEvent(specs, "work", { t: "task.failed", id: "T1", reason: "interrupted" });
  appendEvent(specs, "work", { t: "build.stopped", reason: "interrupted" });
  // The kept checkout: git reports T1's branch as existing.
  const git = async (args: string[]) => {
    if (args[0] === "branch" && args[1] === "--list") return { code: 0, stdout: `  ${args[2]}\n`, stderr: "" };
    return seams.git(args);
  };
  const { code, stderr } = await capture(() =>
    buildCommand("work", root, { ...shellDeps(), seams: { ...seams, git } }, {}),
  );
  expect(code).toBe(2);
  expect(stderr).toEqual([
    "vesna: T1 has a checkout left by a stopped build — /build retry T1 redoes it",
    "  from the shell: vesna build work --resume | --retry <task> | --abort",
  ]);
});
