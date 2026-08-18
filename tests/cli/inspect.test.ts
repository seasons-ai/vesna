import { test, expect } from "bun:test";
import { planRun, summarizeFlow } from "../../src/cli/inspect";
import { parseFlow, ContractError } from "../../src/flow/parse";
import { createRegistry } from "../../src/registry/registry";

const FLOW = parseFlow(`
name: client-report
inputs:
  client: { type: string, required: true }
  note: { type: string }
nodes:
  - { id: read_1, use: read, in: { path: "reports/\${inputs.client}.txt" } }
  - { id: draft, use: llm, in: { prompt: $.read_1.text } }
  - { id: send, use: post, in: { body: $.draft.text } }
`);

function registry() {
  const r = createRegistry();
  const stub = (type: string, effect: any) => ({
    type,
    effect,
    description: "d",
    inputSchema: { type: "object" },
    async run(input: any) {
      return input;
    },
  });
  r.register(stub("read", "pure"));
  r.register(stub("llm", "pure"));
  r.register(stub("post", "external"));
  return r;
}

test("summarises a flow's inputs and nodes", () => {
  const summary = summarizeFlow(FLOW);
  expect(summary.name).toBe("client-report");
  expect(summary.inputs).toEqual([
    { name: "client", type: "string", required: true },
    { name: "note", type: "string", required: false },
  ]);
  expect(summary.nodes.map((n) => n.id)).toEqual(["read_1", "draft", "send"]);
});

test("a dry run reports the execution order without running anything", () => {
  const plan = planRun(FLOW, registry(), { client: "acme" });
  expect(plan.order).toEqual(["read_1", "draft", "send"]);
});

test("a dry run names the nodes that cost money or touch the outside world", () => {
  const plan = planRun(FLOW, registry(), { client: "acme" });
  expect(plan.external).toEqual(["send"]);
  expect(plan.model).toEqual(["draft"]);
});

test("a dry run surfaces a contract error instead of failing at runtime", () => {
  expect(() => planRun(FLOW, registry(), {})).toThrow(ContractError);
});

test("a dry run rejects a node type the registry does not have", () => {
  const bare = createRegistry();
  expect(() => planRun(FLOW, bare, { client: "acme" })).toThrow(ContractError);
});
