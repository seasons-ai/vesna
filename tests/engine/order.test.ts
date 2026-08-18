import { test, expect } from "bun:test";
import { topologicalOrder } from "../../src/engine/order";
import { parseFlow, ContractError } from "../../src/flow/parse";

test("orders nodes so dependencies run first", () => {
  const flow = parseFlow(`
name: f
inputs: {}
nodes:
  - { id: c, use: echo, in: { v: $.b.value } }
  - { id: a, use: echo, in: {} }
  - { id: b, use: echo, in: { v: $.a.value } }
`);
  expect(topologicalOrder(flow)).toEqual(["a", "b", "c"]);
});

test("rejects a dependency cycle", () => {
  const flow = parseFlow(`
name: f
inputs: {}
nodes:
  - { id: a, use: echo, in: { v: $.b.value } }
  - { id: b, use: echo, in: { v: $.a.value } }
`);
  expect(() => topologicalOrder(flow)).toThrow(ContractError);
});
