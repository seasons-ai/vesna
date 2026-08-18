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
  expect(paths[0]!.sites).toEqual([{ nodeId: "read_1", field: "path" }]);
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

const twoPaths: LiveTrace = {
  prompt: "read reports/acme.txt and write out/acme.md",
  finalText: "done",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0,
  environment: { cwd: ".", gitSha: null, envNames: [] },
  steps: [
    { id: "s1", nodeType: "read", input: { path: "reports/acme.txt" }, output: { text: "body" }, durationMs: 1 },
    { id: "s2", nodeType: "write", input: { path: "out/acme.md", text: "body" }, output: { path: "out/acme.md" }, durationMs: 1 },
  ],
};

test("two different literals on the same field get distinct names", () => {
  const names = proposeFlow(twoPaths, "f").parameters.map((p) => p.suggestedName);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toHaveLength(2);
});

test("the same literal used twice becomes one parameter with two sites", () => {
  const shared: LiveTrace = {
    ...twoPaths,
    prompt: "process shared.txt twice",
    steps: [
      { id: "s1", nodeType: "read", input: { path: "shared.txt" }, output: { text: "b" }, durationMs: 1 },
      { id: "s2", nodeType: "write", input: { path: "shared.txt", text: "b" }, output: { path: "shared.txt" }, durationMs: 1 },
    ],
  };
  const parameters = proposeFlow(shared, "f").parameters;
  expect(parameters).toHaveLength(1);
  expect(parameters[0]!.sites).toHaveLength(2);
  expect(parameters[0]!.sites.map((s) => s.nodeId)).toEqual(["read_1", "write_2"]);
});

test("a value produced by an earlier step becomes a reference, not a constant", () => {
  const piped: LiveTrace = {
    ...trace,
    prompt: "read reports/acme.txt and write the summary",
    steps: [
      { id: "s1", nodeType: "read", input: { path: "reports/acme.txt" }, output: { text: "revenue: 120" }, durationMs: 1 },
      { id: "s2", nodeType: "write", input: { path: "out.md", text: "revenue: 120" }, output: { path: "out.md" }, durationMs: 1 },
    ],
  };
  const flow = proposeFlow(piped, "f").flow;
  expect(flow.nodes[1]!.in.text).toBe("$.read_1.text");
});

test("a literal that no earlier step produced stays a literal", () => {
  const piped: LiveTrace = {
    ...trace,
    prompt: "write a fixed banner",
    steps: [
      { id: "s1", nodeType: "read", input: { path: "a.txt" }, output: { text: "body" }, durationMs: 1 },
      { id: "s2", nodeType: "write", input: { path: "out.md", text: "body" }, output: { path: "out.md" }, durationMs: 1 },
    ],
  };
  const flow = proposeFlow(piped, "f").flow;
  expect(flow.nodes[1]!.in.text).toBe("$.read_1.text");
  expect(flow.nodes[1]!.in.path).toBe("out.md");
});

test("a wired reference is not also offered as a parameter", () => {
  const piped: LiveTrace = {
    ...trace,
    prompt: "read reports/acme.txt then write revenue: 120 somewhere",
    steps: [
      { id: "s1", nodeType: "read", input: { path: "reports/acme.txt" }, output: { text: "revenue: 120" }, durationMs: 1 },
      { id: "s2", nodeType: "write", input: { path: "out.md", text: "revenue: 120" }, output: { path: "out.md" }, durationMs: 1 },
    ],
  };
  const proposal = proposeFlow(piped, "f");
  expect(proposal.flow.nodes[1]!.in.text).toBe("$.read_1.text");
  expect(proposal.parameters.some((p) => p.literal === "revenue: 120")).toBe(false);
});
