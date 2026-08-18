import type { Flow } from "../flow/types";
import type { Registry } from "../registry/types";
import type { RunRecord } from "../store/types";
import type { FanoutOptions, FanoutSummary, RowResult } from "./fanout";
import type { Receipt } from "./receipt";
import { runFlow, type RunResult } from "./run";

export interface HealOptions extends FanoutOptions {
  /** Re-send effects whose outcome was left unknown by an interrupt. */
  retryAttempted?: boolean;
  repair?: (inputs: Record<string, unknown>, row: RowResult) => Record<string, unknown>;
}

export function receiptsOf(result: RunResult): Record<string, Receipt> {
  const receipts: Record<string, Receipt> = {};
  for (const node of result.nodes) {
    if (node.receipt) receipts[node.id] = node.receipt;
  }
  return receipts;
}

export async function healRun(
  flow: Flow,
  registry: Registry,
  record: RunRecord,
  options: HealOptions = {},
): Promise<FanoutSummary> {
  const rows: RowResult[] = [];

  for (const row of record.rows) {
    if (row.result.status === "ok") {
      rows.push(row);
      continue;
    }

    const inputs = options.repair ? options.repair(row.inputs, row) : row.inputs;
    const result = await runFlow(flow, registry, inputs, {
      ...options,
      // Receipts from the original attempt travel with the retry, so any
      // external effect that already landed is not repeated.
      receipts: { ...options.receipts, ...receiptsOf(row.result) },
    });
    const healedRow: RowResult = { index: row.index, inputs, result };
    rows.push(healedRow);
    await options.store?.writeRow(record.runId, healedRow);
  }

  rows.sort((a, b) => a.index - b.index);
  return {
    runId: record.runId,
    ok: rows.filter((row) => row.result.status === "ok").length,
    held: rows.filter((row) => row.result.status === "held").length,
    rows,
  };
}
