import { test, expect } from "bun:test";
import { runFlow } from "../../src/engine/run";
import { parseFlow } from "../../src/flow/parse";
import { createRegistry } from "../../src/registry/registry";

function sendingRegistry(counter: { sent: number }) {
  const registry = createRegistry();
  registry.register({ type: "echo", description: "test node", inputSchema: { type: "object" }, effect: "pure", async run(input: any) { return input; } });
  registry.register({
    type: "send",
    description: "test node", inputSchema: { type: "object" }, effect: "external",
    async run() {
      counter.sent += 1;
      return { messageId: `m${counter.sent}` };
    },
  });
  registry.register({
    type: "maybe",
    description: "test node", inputSchema: { type: "object" }, effect: "pure",
    async run(input: any) {
      if (input.fail) throw new Error("downstream failure");
      return { ok: true };
    },
  });
  return registry;
}

const FLOW = `
name: f
inputs: { fail: { type: string } }
nodes:
  - { id: send, use: send, in: {} }
  - { id: after, use: maybe, in: { fail: $.inputs.fail } }
`;

test("an external node records a receipt on success", async () => {
  const counter = { sent: 0 };
  const result = await runFlow(parseFlow(FLOW), sendingRegistry(counter), { fail: false });
  const sendOutcome = result.nodes.find((n) => n.id === "send")!;
  expect(sendOutcome.receipt).toBeDefined();
  expect(sendOutcome.receipt!.output).toEqual({ messageId: "m1" });
  expect(counter.sent).toBe(1);
});

test("a node with an existing receipt is not re-executed", async () => {
  const counter = { sent: 0 };
  const registry = sendingRegistry(counter);
  const receipts = {
    send: { nodeId: "send", at: "2026-08-18T00:00:00Z", output: { messageId: "m1" } },
  };

  const result = await runFlow(parseFlow(FLOW), registry, { fail: false }, { receipts });
  expect(counter.sent).toBe(0);
  expect(result.nodes.find((n) => n.id === "send")!.output).toEqual({ messageId: "m1" });
});

test("property: repeated repair never sends more than once per row", async () => {
  for (let trial = 0; trial < 50; trial += 1) {
    const counter = { sent: 0 };
    const registry = sendingRegistry(counter);
    const receipts: Record<string, any> = {};
    const failures = 1 + Math.floor(Math.random() * 5);

    for (let attempt = 0; attempt < failures; attempt += 1) {
      const result = await runFlow(parseFlow(FLOW), registry, { fail: true }, { receipts });
      for (const node of result.nodes) {
        if (node.receipt) receipts[node.id] = node.receipt;
      }
      expect(result.status).toBe("held");
    }

    const final = await runFlow(parseFlow(FLOW), registry, { fail: false }, { receipts });
    expect(final.status).toBe("ok");
    expect(counter.sent).toBe(1);
  }
});
