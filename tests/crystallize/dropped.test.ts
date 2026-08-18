import { test, expect } from "bun:test";
import { proposeFlow } from "../../src/crystallize/propose";
import type { LiveTrace } from "../../src/loop/trace";

/**
 * A step whose result the model paraphrased rather than passed along has no
 * data path to the answer, so reachability drops it. The flow that comes out
 * is still valid and still shorter than the run — the user has to be told.
 */
const paraphrased: LiveTrace = {
  id: "t",
  prompt: "read a.txt and summarise it into summary.txt",
  startedAt: "now",
  model: "m",
  steps: [
    { id: "s1", nodeType: "read", input: { path: "a.txt" }, output: { text: "revenue: 120" }, durationMs: 1 },
    {
      id: "s2",
      nodeType: "write",
      input: { path: "summary.txt", text: "Revenue was 120." },
      output: { path: "summary.txt" },
      durationMs: 1,
    },
  ],
  answer: "done",
} as any;

test("a step the answer does not depend on is reported, not silently dropped", () => {
  const proposal = proposeFlow(paraphrased, "report");
  expect(proposal.flow.nodes.map((n) => n.use)).toEqual(["write"]);
  expect(proposal.dropped).toEqual([{ nodeType: "read", input: { path: "a.txt" } }]);
});

test("when every step is reachable nothing is reported as dropped", () => {
  const wired: LiveTrace = {
    ...paraphrased,
    steps: [
      { id: "s1", nodeType: "read", input: { path: "a.txt" }, output: { text: "body" }, durationMs: 1 },
      {
        id: "s2",
        nodeType: "write",
        input: { path: "summary.txt", text: "body" },
        output: { path: "summary.txt" },
        durationMs: 1,
      },
    ],
  } as any;
  expect(proposeFlow(wired, "report").dropped).toEqual([]);
});
