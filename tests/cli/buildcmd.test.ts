import { test, expect } from "bun:test";
import { exitFor, describeEvent } from "../../src/cli/buildcmd";

test("exit codes: done is 0, stopped for a person is 1, could not start is 2", () => {
  expect(exitFor({ status: "done" })).toBe(0);
  expect(exitFor({ status: "stopped", reason: "x" })).toBe(1);
  expect(exitFor({ status: "could-not-start", reason: "x" })).toBe(2);
});

test("events print as one line each, and the ones that are noise print nothing", () => {
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
