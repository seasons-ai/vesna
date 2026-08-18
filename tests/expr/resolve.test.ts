import { test, expect } from "bun:test";
import { isRef, resolveRef, resolveInput, refDependencies, RefError } from "../../src/expr/resolve";

const scope = {
  inputs: { client: "Acme", report: "q3.pdf" },
  parse: { rows: [{ sku: "A1" }] },
};

test("identifies reference strings", () => {
  expect(isRef("$.inputs.client")).toBe(true);
  expect(isRef("Acme")).toBe(false);
  expect(isRef(42)).toBe(false);
});

test("resolves a nested reference", () => {
  expect(resolveRef("$.inputs.client", scope)).toBe("Acme");
  expect(resolveRef("$.parse.rows", scope)).toEqual([{ sku: "A1" }]);
});

test("throws on an unresolvable reference", () => {
  expect(() => resolveRef("$.missing.field", scope)).toThrow(RefError);
});

test("resolves references inside an input object and leaves literals alone", () => {
  const resolved = resolveInput({ rows: "$.parse.rows", label: "static" }, scope);
  expect(resolved).toEqual({ rows: [{ sku: "A1" }], label: "static" });
});

test("collects node dependencies, excluding inputs and duplicates", () => {
  const deps = refDependencies({ a: "$.parse.rows", b: "$.parse.total", c: "$.inputs.client", d: "lit" });
  expect(deps).toEqual(["parse"]);
});
