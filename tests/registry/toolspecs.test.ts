import { test, expect } from "bun:test";
import { createRegistry, toolSpecs } from "../../src/registry/registry";
import type { NodeDef } from "../../src/registry/types";

const echo: NodeDef<{ value: string }, { value: string }> = {
  type: "echo",
  effect: "pure",
  description: "Echo a value back unchanged",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string", description: "The value to echo" } },
    required: ["value"],
  },
  async run(input) {
    return { value: input.value };
  },
};

test("derives tool specs from the registry without a hand-written map", () => {
  const registry = createRegistry();
  registry.register(echo);

  expect(toolSpecs(registry)).toEqual([
    {
      name: "echo",
      description: "Echo a value back unchanged",
      input_schema: echo.inputSchema,
    },
  ]);
});

test("every registered node becomes callable by the agent", () => {
  const registry = createRegistry();
  registry.register(echo);
  registry.register({ ...echo, type: "echo2" });

  expect(toolSpecs(registry).map((s) => s.name)).toEqual(registry.list());
});
