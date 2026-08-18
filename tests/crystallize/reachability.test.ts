import { test, expect } from "bun:test";
import { reachableSteps } from "../../src/crystallize/reachability";
import type { LiveTrace } from "../../src/loop/trace";

const trace: LiveTrace = {
  prompt: "build the report for Acme",
  finalText: "done",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0,
  environment: { cwd: ".", gitSha: null, envNames: [] },
  steps: [
    { id: "s1", nodeType: "read", input: { path: "q3.pdf" }, output: { text: "raw rows" }, durationMs: 1 },
    { id: "s2", nodeType: "read", input: { path: "unrelated.txt" }, output: { text: "never used" }, durationMs: 1 },
    { id: "s3", nodeType: "echo", input: { value: "raw rows" }, output: { value: "summary" }, durationMs: 1 },
    { id: "s4", nodeType: "write", input: { path: "out.md", text: "summary" }, output: { path: "out.md" }, durationMs: 1 },
  ],
};

test("keeps only steps reachable from the final step", () => {
  expect(reachableSteps(trace).map((s) => s.id)).toEqual(["s1", "s3", "s4"]);
});

test("drops exploration that fed nothing", () => {
  expect(reachableSteps(trace).some((s) => s.id === "s2")).toBe(false);
});

test("an empty trace yields no steps", () => {
  expect(reachableSteps({ ...trace, steps: [] })).toEqual([]);
});
