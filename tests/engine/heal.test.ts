import { test, expect } from "bun:test";
import { healRun, receiptsOf } from "../../src/engine/heal";
import { runMapped } from "../../src/engine/fanout";
import { parseFlow } from "../../src/flow/parse";
import { createRegistry } from "../../src/registry/registry";

const FLOW = parseFlow(`
name: f
inputs: { client: { type: string, required: true } }
nodes:
  - { id: send, use: send, in: {} }
  - id: check
    use: echo
    in: { value: $.inputs.client }
    assert:
      - non_empty: $.out.value
`);

function registry(counter: { sent: number }) {
  const r = createRegistry();
  r.register({ type: "echo", description: "test node", inputSchema: { type: "object" }, effect: "pure", async run(input: any) { return input; } });
  r.register({
    type: "send",
    description: "test node", inputSchema: { type: "object" }, effect: "external",
    async run() {
      counter.sent += 1;
      return { messageId: `m${counter.sent}` };
    },
  });
  return r;
}

test("collects receipts from a run result", () => {
  const receipts = receiptsOf({
    status: "held",
    nodes: [
      {
        id: "send",
        status: "ok",
        assertions: [],
        durationMs: 0,
        receipt: { nodeId: "send", at: "t", output: 1 },
      },
    ],
  } as any);
  expect(Object.keys(receipts)).toEqual(["send"]);
});

test("heals only held rows and leaves ok rows untouched", async () => {
  const counter = { sent: 0 };
  const r = registry(counter);
  const rows = [{ client: "Acme" }, { client: "" }];

  const first = await runMapped(FLOW, r, rows, {});
  expect(first.ok).toBe(1);
  expect(first.held).toBe(1);
  expect(counter.sent).toBe(2);

  const record = { runId: first.runId, flowName: "f", startedAt: "t", rows: first.rows };
  const healed = await healRun(FLOW, r, record, {
    repair: (inputs) => ({ ...inputs, client: "Repaired" }),
  });

  expect(healed.ok).toBe(2);
  expect(healed.held).toBe(0);
  expect(counter.sent).toBe(2);
});
