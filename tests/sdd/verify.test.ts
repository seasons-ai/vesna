import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerify } from "../../src/sdd/verify";
import { AbortedError } from "../../src/nodes/spawn";

const dir = () => mkdtempSync(join(tmpdir(), "vesna-verify-"));

test("a check that passes reports 0 and its log holds the output", async () => {
  const d = dir();
  const log = join(d, "verify", "T1-review-r0.log");
  const r = await runVerify({ command: "echo ok; echo err >&2", cwd: d, logPath: log });
  expect(r.code).toBe(0);
  expect(r.timedOut).toBe(false);
  expect(r.ms).toBeGreaterThanOrEqual(0);
  const text = readFileSync(log, "utf8");
  expect(text).toContain("$ echo ok; echo err >&2");
  expect(text).toContain("ok");
  expect(text).toContain("err");
  expect(text).toContain("exit 0 after");
});

test("a check that fails reports its code, and the tail is the last 100 lines", async () => {
  const d = dir();
  const r = await runVerify({ command: "seq 1 150; exit 3", cwd: d, logPath: join(d, "l.log") });
  expect(r.code).toBe(3);
  const lines = r.tail.split("\n");
  expect(lines.length).toBe(100);
  expect(lines[0]).toBe("51");
  expect(lines[99]).toBe("150");
});

test("a check runs in the cwd it was given", async () => {
  const d = dir();
  const r = await runVerify({ command: "pwd", cwd: d, logPath: join(d, "l.log") });
  expect(readFileSync(join(d, "l.log"), "utf8")).toContain(d.replace("/private", "").split("/").pop()!);
  expect(r.code).toBe(0);
});

test("a check past its ceiling is a timeout with no code, and the log says so", async () => {
  const d = dir();
  const r = await runVerify({ command: "sleep 60", cwd: d, logPath: join(d, "l.log"), timeoutMs: 300 });
  expect(r.timedOut).toBe(true);
  expect(r.code).toBeNull();
  expect(readFileSync(join(d, "l.log"), "utf8")).toContain("exit timeout after");
});

test("an abort during a check is the abort, not a result", async () => {
  const d = dir();
  const controller = new AbortController();
  const pending = runVerify({ command: "sleep 60", cwd: d, logPath: join(d, "l.log"), signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await expect(pending).rejects.toBeInstanceOf(AbortedError);
  expect(existsSync(join(d, "l.log"))).toBe(false);
});
