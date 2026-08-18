import { test, expect } from "bun:test";
import { proposeFlow, synthesizeAssertions } from "../../src/crystallize/propose";
import type { LiveTrace } from "../../src/loop/trace";

const trace: LiveTrace = {
  prompt: "build the report for Acme from q3.pdf",
  finalText: "done",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0,
  environment: { cwd: ".", gitSha: null, envNames: [] },
  steps: [
    { id: "s1", nodeType: "read", input: { path: "q3.pdf" }, output: { rows: [{ sku: "A1", qty: 2 }] }, durationMs: 1 },
    { id: "s2", nodeType: "write", input: { path: "out.md", text: "A1" }, output: { path: "out.md" }, durationMs: 1 },
  ],
};

test("synthesizes non_empty and has_keys from an observed output", () => {
  const assertions = synthesizeAssertions({ rows: [{ sku: "A1", qty: 2 }] });
  expect(assertions).toContainEqual({ non_empty: "$.out.rows" });
  expect(assertions).toContainEqual({ has_keys: { value: "$.out.rows", keys: ["sku", "qty"] } });
});

test("produces a flow whose node ids match the reachable steps", () => {
  const proposal = proposeFlow(trace, "client-report");
  expect(proposal.flow.name).toBe("client-report");
  expect(proposal.flow.nodes.map((n) => n.id)).toEqual(["read_1", "write_2"]);
  expect(proposal.flow.nodes[0]!.use).toBe("read");
});

test("proposes literals that appear in the prompt as parameters", () => {
  const proposal = proposeFlow(trace, "client-report");
  const paths = proposal.parameters.filter((p) => p.literal === "q3.pdf");
  expect(paths).toHaveLength(1);
  expect(paths[0]!.nodeId).toBe("read_1");
  expect(paths[0]!.field).toBe("path");
});

test("does not propose literals absent from the prompt", () => {
  const proposal = proposeFlow(trace, "client-report");
  expect(proposal.parameters.some((p) => p.literal === "out.md")).toBe(false);
});

test("proposed parameters are not yet applied to the flow", () => {
  const proposal = proposeFlow(trace, "client-report");
  expect(proposal.flow.nodes[0]!.in.path).toBe("q3.pdf");
  expect(proposal.flow.inputs).toEqual({});
});
