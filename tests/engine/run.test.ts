import { test, expect } from "bun:test";
import { runFlow } from "../../src/engine/run";
import { parseFlow } from "../../src/flow/parse";
import { createRegistry } from "../../src/registry/registry";
import type { Registry } from "../../src/registry/types";

function fakeRegistry(): Registry {
  const registry = createRegistry();
  registry.register({ type: "echo", description: "test node", inputSchema: { type: "object" }, effect: "pure", async run(input: any) { return input; } });
  registry.register({ type: "boom", description: "test node", inputSchema: { type: "object" }, effect: "pure", async run() { throw new Error("kaboom"); } });
  let attempts = 0;
  registry.register({
    type: "flaky",
    description: "test node", inputSchema: { type: "object" }, effect: "pure",
    async run() {
      attempts += 1;
      if (attempts < 2) throw new Error("transient");
      return { attempts };
    },
  });
  return registry;
}

test("runs nodes in dependency order and exposes outputs to later nodes", async () => {
  const flow = parseFlow(`
name: f
inputs: { who: { type: string, required: true } }
nodes:
  - { id: first, use: echo, in: { value: $.inputs.who } }
  - { id: second, use: echo, in: { value: $.first.value } }
`);
  const result = await runFlow(flow, fakeRegistry(), { who: "Acme" });
  expect(result.status).toBe("ok");
  expect(result.nodes.map((n) => n.id)).toEqual(["first", "second"]);
  expect(result.nodes[1]!.output).toEqual({ value: "Acme" });
});

test("a failed assertion holds the node rather than failing it", async () => {
  const flow = parseFlow(`
name: f
inputs: {}
nodes:
  - id: a
    use: echo
    in: { value: "" }
    assert:
      - non_empty: $.out.value
`);
  const result = await runFlow(flow, fakeRegistry(), {});
  expect(result.nodes[0]!.status).toBe("held");
  expect(result.nodes[0]!.error!.class).toBe("assert_failed");
  expect(result.status).toBe("held");
});

test("a throwing node retries then holds with node_error", async () => {
  const flow = parseFlow(`
name: f
inputs: {}
nodes:
  - { id: a, use: boom, in: {} }
`);
  const result = await runFlow(flow, fakeRegistry(), {}, { retries: 1 });
  expect(result.nodes[0]!.status).toBe("held");
  expect(result.nodes[0]!.error!.class).toBe("node_error");
  expect(result.nodes[0]!.error!.message).toContain("kaboom");
});

test("retries recover a transient failure", async () => {
  const flow = parseFlow(`
name: f
inputs: {}
nodes:
  - { id: a, use: flaky, in: {} }
`);
  const result = await runFlow(flow, fakeRegistry(), {}, { retries: 2 });
  expect(result.nodes[0]!.status).toBe("ok");
});

test("a denied permission never retries and is reported as permission_denied", async () => {
  const flow = parseFlow(`
name: f
inputs: {}
nodes:
  - { id: a, use: echo, in: {} }
`);
  const result = await runFlow(flow, fakeRegistry(), {}, { retries: 3, permit: () => false });
  expect(result.nodes[0]!.status).toBe("held");
  expect(result.nodes[0]!.error!.class).toBe("permission_denied");
});

test("nodes downstream of a held node do not run", async () => {
  const flow = parseFlow(`
name: f
inputs: {}
nodes:
  - { id: a, use: boom, in: {} }
  - { id: b, use: echo, in: { value: $.a.value } }
`);
  const result = await runFlow(flow, fakeRegistry(), {}, { retries: 0 });
  expect(result.nodes.map((n) => n.id)).toEqual(["a"]);
});
