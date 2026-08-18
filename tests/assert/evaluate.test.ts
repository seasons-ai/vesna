import { test, expect } from "bun:test";
import { evaluateAssertions } from "../../src/assert/evaluate";
import type { Assertion } from "../../src/assert/types";

const scope = {
  out: {
    rows: [{ sku: "A1", qty: 2, total: 10 }],
    text: "Report for Acme",
    empty: [],
    placeholder: "Report for {{client_name}}",
  },
  inputs: { client: "Acme" },
};

function run(assertion: Assertion) {
  return evaluateAssertions([assertion], scope)[0]!;
}

test("non_empty passes on a populated array and fails on an empty one", () => {
  expect(run({ non_empty: "$.out.rows" }).passed).toBe(true);
  expect(run({ non_empty: "$.out.empty" }).passed).toBe(false);
});

test("has_keys checks every element of an array", () => {
  expect(run({ has_keys: { value: "$.out.rows", keys: ["sku", "qty", "total"] } }).passed).toBe(true);
  expect(run({ has_keys: { value: "$.out.rows", keys: ["missing"] } }).passed).toBe(false);
});

test("not_matches catches an unsubstituted placeholder", () => {
  expect(run({ not_matches: { value: "$.out.text", pattern: "\\{\\{.*\\}\\}" } }).passed).toBe(true);
  expect(run({ not_matches: { value: "$.out.placeholder", pattern: "\\{\\{.*\\}\\}" } }).passed).toBe(false);
});

test("contains resolves the needle when it is a reference", () => {
  expect(run({ contains: { value: "$.out.text", needle: "$.inputs.client" } }).passed).toBe(true);
  expect(run({ contains: { value: "$.out.text", needle: "Globex" } }).passed).toBe(false);
});

test("an unresolvable reference fails the assertion instead of throwing", () => {
  const outcome = run({ non_empty: "$.out.nothing" });
  expect(outcome.passed).toBe(false);
  expect(outcome.detail).toContain("cannot resolve");
});

test("evaluates every assertion, not just the first failure", () => {
  const outcomes = evaluateAssertions(
    [{ non_empty: "$.out.empty" }, { non_empty: "$.out.rows" }],
    scope,
  );
  expect(outcomes.map((o) => o.passed)).toEqual([false, true]);
});
