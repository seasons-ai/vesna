import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnInterruptible } from "../nodes/spawn";

export const VERIFY_CEILING_MS = 600_000;
const TAIL_LINES = 100;

export interface VerifyRequest {
  command: string;
  cwd: string;
  logPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface VerifyResult {
  /** The exit code, or null when the ceiling stopped it. */
  code: number | null;
  ms: number;
  timedOut: boolean;
  /** The last 100 lines of everything the check printed, for a fix round. */
  tail: string;
}

/**
 * One check, run by Vesna itself. The worker never sees the command and the
 * reviewer never runs it: this is the third witness. An abort is rethrown as
 * the abort — the loop already knows what to write for that — and nothing is
 * logged, since a killed check proved nothing either way.
 */
export async function runVerify(request: VerifyRequest): Promise<VerifyResult> {
  const signal = request.signal ?? new AbortController().signal;
  const started = Date.now();
  const run = await spawnInterruptible(["sh", "-c", request.command], {
    cwd: request.cwd,
    signal,
    timeoutMs: request.timeoutMs ?? VERIFY_CEILING_MS,
  });
  const ms = Date.now() - started;
  const code = run.timedOut ? null : run.code;
  const output = `${run.stdout}${run.stdout !== "" && !run.stdout.endsWith("\n") ? "\n" : ""}${run.stderr}`;
  mkdirSync(dirname(request.logPath), { recursive: true });
  writeFileSync(
    request.logPath,
    `$ ${request.command}\n\n${output}\n\nexit ${code === null ? "timeout" : code} after ${ms} ms\n`,
  );
  const lines = output.trimEnd().split("\n");
  return { code, ms, timedOut: run.timedOut, tail: lines.slice(-TAIL_LINES).join("\n") };
}
