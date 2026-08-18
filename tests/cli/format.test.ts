import { test, expect } from "bun:test";
import { formatParameter } from "../../src/cli/main";
import { resolveInput } from "../../src/expr/resolve";

const parameter = {
  literal: "reports/acme.txt",
  suggestedName: "source",
  sites: [{ nodeId: "read_1", field: "path" }],
};

test("prints the template syntax the flow language actually accepts", () => {
  expect(formatParameter(parameter)).toContain("${inputs.source}");
});

test("the printed template is one the resolver can evaluate", () => {
  const printed = formatParameter(parameter);
  const template = printed.match(/\$\{inputs\.[a-z_0-9]+\}/)![0];
  expect(resolveInput({ p: template }, { inputs: { source: "reports/acme.txt" } })).toEqual({
    p: "reports/acme.txt",
  });
});

test("lists every site the literal appeared at", () => {
  const many = { ...parameter, sites: [...parameter.sites, { nodeId: "write_2", field: "path" }] };
  expect(formatParameter(many)).toContain("read_1.path, write_2.path");
});
