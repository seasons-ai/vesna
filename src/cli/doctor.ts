import type { RunRecord } from "../store/types";

export interface NodeHealth {
  nodeId: string;
  runs: number;
  assertionPassRate: number;
  avgCostUsd: number;
}

export function diagnose(records: RunRecord[]): NodeHealth[] {
  const stats = new Map<string, { runs: number; passed: number; total: number; cost: number }>();

  for (const record of records) {
    for (const row of record.rows) {
      for (const node of row.result.nodes) {
        const entry = stats.get(node.id) ?? { runs: 0, passed: 0, total: 0, cost: 0 };
        entry.runs += 1;
        entry.passed += node.assertions.filter((a) => a.passed).length;
        entry.total += node.assertions.length;
        const cost = (node.output as { costUsd?: unknown } | undefined)?.costUsd;
        if (typeof cost === "number") entry.cost += cost;
        stats.set(node.id, entry);
      }
    }
  }

  return [...stats.entries()].map(([nodeId, entry]) => ({
    nodeId,
    runs: entry.runs,
    assertionPassRate: entry.total === 0 ? 1 : entry.passed / entry.total,
    avgCostUsd: entry.runs === 0 ? 0 : entry.cost / entry.runs,
  }));
}
