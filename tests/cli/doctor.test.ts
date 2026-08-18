import { test, expect } from "bun:test";
import { diagnose } from "../../src/cli/doctor";
import type { RunRecord } from "../../src/store/types";

const record = {
  runId: "r1",
  flowName: "f",
  startedAt: "t",
  rows: [
    {
      index: 0,
      inputs: {},
      result: {
        status: "ok",
        nodes: [
          {
            id: "summary",
            status: "ok",
            output: { costUsd: 0.02 },
            assertions: [{ passed: true, assertion: { non_empty: "$.out.x" }, detail: "" }],
            durationMs: 1,
          },
        ],
      },
    },
    {
      index: 1,
      inputs: {},
      result: {
        status: "held",
        nodes: [
          {
            id: "summary",
            status: "held",
            output: { costUsd: 0.04 },
            assertions: [{ passed: false, assertion: { non_empty: "$.out.x" }, detail: "empty" }],
            durationMs: 1,
          },
        ],
      },
    },
  ],
} as unknown as RunRecord;

test("reports per-node assertion pass rate across runs", () => {
  const summary = diagnose([record]).find((h) => h.nodeId === "summary")!;
  expect(summary.runs).toBe(2);
  expect(summary.assertionPassRate).toBeCloseTo(0.5, 5);
});

test("averages cost from node outputs that report it", () => {
  const summary = diagnose([record]).find((h) => h.nodeId === "summary")!;
  expect(summary.avgCostUsd).toBeCloseTo(0.03, 5);
});

test("returns an empty report for no records", () => {
  expect(diagnose([])).toEqual([]);
});
