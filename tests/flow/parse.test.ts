import { test, expect } from "bun:test";
import { parseFlow, validateFlow, validateInputs, ContractError } from "../../src/flow/parse";
import { createRegistry } from "../../src/registry/registry";

const YAML = `
name: client-report
inputs:
  client: { type: string, required: true }
nodes:
  - id: summary
    use: echo
    effect: pure
    in: { value: $.inputs.client }
    assert:
      - non_empty: $.out.value
`;

function registryWithEcho() {
  const registry = createRegistry();
  registry.register({ type: "echo", description: "test node", inputSchema: { type: "object" }, effect: "pure", async run(input: any) { return input; } });
  return registry;
}

test("parses a flow file into a typed object", () => {
  const flow = parseFlow(YAML);
  expect(flow.name).toBe("client-report");
  expect(flow.inputs.client).toEqual({ type: "string", required: true });
  expect(flow.nodes[0]!.id).toBe("summary");
  expect(flow.nodes[0]!.assert).toHaveLength(1);
});

test("rejects a flow with no name", () => {
  expect(() => parseFlow("nodes: []")).toThrow(ContractError);
});

test("rejects duplicate node ids", () => {
  const dup = `
name: d
inputs: {}
nodes:
  - { id: a, use: echo, in: {} }
  - { id: a, use: echo, in: {} }
`;
  expect(() => parseFlow(dup)).toThrow(ContractError);
});

test("validateFlow rejects a node type missing from the registry", () => {
  const flow = parseFlow(`
name: f
inputs: {}
nodes:
  - { id: a, use: nosuchnode, in: {} }
`);
  expect(() => validateFlow(flow, registryWithEcho())).toThrow(ContractError);
});

test("validateFlow rejects a reference to an unknown node", () => {
  const flow = parseFlow(`
name: f
inputs: {}
nodes:
  - { id: a, use: echo, in: { v: $.ghost.value } }
`);
  expect(() => validateFlow(flow, registryWithEcho())).toThrow(ContractError);
});

test("validateFlow accepts a well-formed flow", () => {
  expect(() => validateFlow(parseFlow(YAML), registryWithEcho())).not.toThrow();
});

test("validateInputs rejects a missing required input", () => {
  const flow = parseFlow(YAML);
  expect(() => validateInputs(flow, {})).toThrow(ContractError);
  expect(() => validateInputs(flow, { client: "Acme" })).not.toThrow();
});
