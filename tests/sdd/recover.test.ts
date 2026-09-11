import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project, type SpecEvent } from "../../src/spec/project";
import { buildState, inFlightTask, pidAlive, readLockPid } from "../../src/sdd/recover";

const base: SpecEvent[] = [
  { t: "created", id: "w", title: "W" },
  { t: "task.added", id: "T1", title: "a" },
  { t: "task.added", id: "T2", title: "b" },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
];

test("no build.started is idle, whatever the lock says", () => {
  expect(buildState(project(base)!, true)).toBe("idle");
  expect(buildState(project(base)!, false)).toBe("idle");
});

test("a build in the log with a live lock is running", () => {
  const t = project([...base, { t: "build.started" }, { t: "task.started", id: "T1" }])!;
  expect(buildState(t, true)).toBe("running");
});

test("a build in the log with no live lock is dead — a killed process leaves exactly this", () => {
  const t = project([...base, { t: "build.started" }, { t: "task.started", id: "T1" }])!;
  expect(buildState(t, false)).toBe("dead");
});

test("a build that stopped or finished is idle again", () => {
  const stopped = project([...base, { t: "build.started" }, { t: "build.stopped", reason: "x" }])!;
  const done = project([...base, { t: "build.started" }, { t: "build.done" }])!;
  expect(buildState(stopped, false)).toBe("idle");
  expect(buildState(done, false)).toBe("idle");
});

test("the in-flight task is the one left running", () => {
  const t = project([
    ...base, { t: "build.started" },
    { t: "task.started", id: "T1" }, { t: "task.done", id: "T1" },
    { t: "task.started", id: "T2" },
  ])!;
  expect(inFlightTask(t)).toBe("T2");
  expect(inFlightTask(project(base)!)).toBeUndefined();
});

test("a lock file's pid is read, and garbage reads as no lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "vesna-lock-"));
  const path = join(dir, "build.lock");
  expect(readLockPid(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ pid: 4242 }));
  expect(readLockPid(path)).toBe(4242);
  writeFileSync(path, "not json");
  expect(readLockPid(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ pid: 0 }));
  expect(readLockPid(path)).toBeNull();
});

test("this process is alive and a pid nobody has is not", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(999999999)).toBe(false);
});
