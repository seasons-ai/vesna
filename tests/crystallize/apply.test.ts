import { test, expect } from "bun:test";
import { applyParameters } from "../../src/crystallize/apply";
import { resolveInput } from "../../src/expr/resolve";
import type { Flow } from "../../src/flow/types";
import type { ProposedParameter } from "../../src/crystallize/propose";

const flow: Flow = {
  name: "client-report",
  inputs: {},
  nodes: [
    { id: "read_1", use: "read", in: { path: "reports/acme.txt" } },
    { id: "write_2", use: "write", in: { path: "out/acme.md", text: "hello acme, here it is" } },
  ],
};

const params: ProposedParameter[] = [
  { literal: "reports/acme.txt", suggestedName: "source", sites: [{ nodeId: "read_1", field: "path" }] },
  { literal: "acme", suggestedName: "client", sites: [{ nodeId: "write_2", field: "text" }] },
];

test("an accepted whole-value literal becomes a typed reference", () => {
  const applied = applyParameters(flow, params, new Map([["source", "source"]]));
  expect(applied.nodes[0]!.in.path).toBe("$.inputs.source");
});

test("an accepted literal inside a longer string becomes a template", () => {
  const applied = applyParameters(flow, params, new Map([["client", "client"]]));
  expect(applied.nodes[1]!.in.text).toBe("hello ${inputs.client}, here it is");
});

test("accepted parameters are declared as required flow inputs", () => {
  const applied = applyParameters(flow, params, new Map([["source", "source"], ["client", "client"]]));
  expect(applied.inputs).toEqual({
    source: { type: "string", required: true },
    client: { type: "string", required: true },
  });
});

test("a rejected parameter leaves its literal untouched", () => {
  const applied = applyParameters(flow, params, new Map([["source", "source"]]));
  expect(applied.nodes[1]!.in.text).toBe("hello acme, here it is");
  expect(applied.inputs.client).toBeUndefined();
});

test("the result is resolvable — the applied references actually evaluate", () => {
  const applied = applyParameters(flow, params, new Map([["source", "source"], ["client", "client"]]));
  const scope = { inputs: { source: "reports/globex.txt", client: "globex" } };
  expect(resolveInput(applied.nodes[0]!.in, scope)).toEqual({ path: "reports/globex.txt" });
  expect(resolveInput(applied.nodes[1]!.in, scope)).toMatchObject({
    text: "hello globex, here it is",
  });
});

test("applying nothing returns the flow unchanged", () => {
  expect(applyParameters(flow, params, new Map())).toEqual(flow);
});

test("one literal used at several sites is replaced at all of them", () => {
  const shared: Flow = {
    name: "f",
    inputs: {},
    nodes: [
      { id: "a", use: "read", in: { path: "shared.txt" } },
      { id: "b", use: "write", in: { path: "shared.txt", text: "x" } },
    ],
  };
  const applied = applyParameters(
    shared,
    [
      {
        literal: "shared.txt",
        suggestedName: "file",
        sites: [
          { nodeId: "a", field: "path" },
          { nodeId: "b", field: "path" },
        ],
      },
    ],
    new Map([["file", "file"]]),
  );
  expect(applied.nodes[0]!.in.path).toBe("$.inputs.file");
  expect(applied.nodes[1]!.in.path).toBe("$.inputs.file");
});

test("a rename during confirmation is carried into the flow", () => {
  const applied = applyParameters(flow, params, new Map([["source", "report_path"]]));
  expect(applied.nodes[0]!.in.path).toBe("$.inputs.report_path");
  expect(applied.inputs.report_path).toEqual({ type: "string", required: true });
  expect(applied.inputs.source).toBeUndefined();
});
