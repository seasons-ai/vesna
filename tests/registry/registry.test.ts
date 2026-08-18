import { test, expect } from "bun:test";
import { createRegistry, DuplicateNodeError } from "../../src/registry/registry";
import type { NodeDef } from "../../src/registry/types";

const echo: NodeDef<{ value: string }, { value: string }> = {
  type: "echo",
  description: "test node", inputSchema: { type: "object" }, effect: "pure",
  async run(input) {
    return { value: input.value };
  },
};

test("registers and retrieves a node by type", () => {
  const registry = createRegistry();
  registry.register(echo);
  expect(registry.get("echo")).toBe(echo);
});

test("returns undefined for an unknown type", () => {
  const registry = createRegistry();
  expect(registry.get("nope")).toBeUndefined();
});

test("lists registered types in insertion order", () => {
  const registry = createRegistry();
  registry.register(echo);
  registry.register({ ...echo, type: "echo2" });
  expect(registry.list()).toEqual(["echo", "echo2"]);
});

test("rejects a duplicate type", () => {
  const registry = createRegistry();
  registry.register(echo);
  expect(() => registry.register(echo)).toThrow(DuplicateNodeError);
});
