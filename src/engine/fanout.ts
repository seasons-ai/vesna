import type { Flow } from "../flow/types";
import type { Registry } from "../registry/types";
import type { TraceStore } from "../store/types";
import { runFlow, type RunOptions, type RunResult } from "./run";

export interface RowResult {
  index: number;
  inputs: Record<string, unknown>;
  result: RunResult;
}

export interface FanoutSummary {
  runId: string;
  ok: number;
  held: number;
  rows: RowResult[];
}

export interface FanoutOptions extends RunOptions {
  concurrency?: number;
  store?: TraceStore;
  /** Called as each row settles, so a front end can show progress live. */
  onRow?: (row: RowResult, done: number, total: number) => void;
}

export async function runMapped(
  flow: Flow,
  registry: Registry,
  rows: Record<string, unknown>[],
  options: FanoutOptions = {},
): Promise<FanoutSummary> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const runId = options.store?.createRun(flow.name) ?? `run_local_${Date.now().toString(36)}`;
  const results: RowResult[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      const inputs = rows[index];
      if (!inputs) return;

      // One row holding must never stop the others.
      const result = await runFlow(flow, registry, inputs, options);
      const row: RowResult = { index, inputs, result };
      results.push(row);
      await options.store?.writeRow(runId, row);
      options.onRow?.(row, results.length, rows.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, worker));
  results.sort((a, b) => a.index - b.index);

  return {
    runId,
    ok: results.filter((row) => row.result.status === "ok").length,
    held: results.filter((row) => row.result.status === "held").length,
    rows: results,
  };
}
