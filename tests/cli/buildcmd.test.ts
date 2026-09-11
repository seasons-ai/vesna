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
