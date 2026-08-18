import { test, expect } from "bun:test";
import { runFlow } from "../../src/engine/run";
import { healRun } from "../../src/engine/heal";
import { parseFlow } from "../../src/flow/parse";
import { createRegistry } from "../../src/registry/registry";

const FLOW = `
name: f
inputs: {}
nodes:
  - { id: send, use: send, in: {} }
  - { id: after, use: echo, in: {} }
`;

function registry(counter: { sent: number }, behaviour: "ok" | "abort") {
  const r = createRegistry();
  const stub = (type: string, effect: any, run: any) => ({
    type,
    effect,
    description: "d",
    inputSchema: { type: "object" },
    run,
  });
  r.register(stub("echo", "pure", async (input: any) => input));
  r.register(
    stub("send", "external", async () => {
      counter.sent += 1;
      // The effect has landed; the interrupt arrives before we learn the outcome.
      if (behaviour === "abort") throw new Error("The operation was aborted");
      return { messageId: `m${counter.sent}` };
    }),
  );
  return r;
}

test("an aborted external node records the attempt, not silence", async () => {
  const counter = { sent: 0 };
  const result = await runFlow(parseFlow(FLOW), registry(counter, "abort"), {});
  const send = result.nodes.find((n) => n.id === "send")!;

  expect(send.status).toBe("held");
  expect(send.receipt).toBeDefined();
  expect(send.receipt!.status).toBe("attempted");
});

test("a completed external node records a confirmed receipt", async () => {
  const counter = { sent: 0 };
  const result = await runFlow(parseFlow(FLOW), registry(counter, "ok"), {});
  expect(result.nodes.find((n) => n.id === "send")!.receipt!.status).toBe("confirmed");
});

test("repair does not silently repeat an effect whose outcome is unknown", async () => {
  const counter = { sent: 0 };
  const r = registry(counter, "abort");
  const first = await runFlow(parseFlow(FLOW), r, {});
  expect(counter.sent).toBe(1);

  const record = {
    runId: "r",
    flowName: "f",
    startedAt: "t",
    rows: [{ index: 0, inputs: {}, result: first }],
  };
  const healed = await healRun(parseFlow(FLOW), r, record as any, {});

  // Still held, and the send was not attempted a second time.
  expect(counter.sent).toBe(1);
  expect(healed.held).toBe(1);
  const send = healed.rows[0]!.result.nodes.find((n) => n.id === "send")!;
  expect(send.error!.message).toMatch(/unknown|attempted/i);
});

test("an uncertain effect can be retried when a human decides it did not land", async () => {
  const counter = { sent: 0 };
  const aborting = registry(counter, "abort");
  const first = await runFlow(parseFlow(FLOW), aborting, {});

  const working = registry(counter, "ok");
  const record = {
    runId: "r",
    flowName: "f",
    startedAt: "t",
    rows: [{ index: 0, inputs: {}, result: first }],
  };
  const healed = await healRun(parseFlow(FLOW), working, record as any, {
    retryAttempted: true,
  });

  expect(counter.sent).toBe(2);
  expect(healed.ok).toBe(1);
});

test("a pure node aborting needs no receipt at all", async () => {
  const r = createRegistry();
  r.register({
    type: "boom",
    effect: "pure",
    description: "d",
    inputSchema: { type: "object" },
    async run() {
      throw new Error("The operation was aborted");
    },
  });
  const result = await runFlow(
    parseFlow(`
name: f
inputs: {}
nodes:
  - { id: a, use: boom, in: {} }
`),
    r,
    {},
  );
  expect(result.nodes[0]!.receipt).toBeUndefined();
});

test("an abort signal stops the flow before the next node runs", async () => {
  const controller = new AbortController();
  const ran: string[] = [];
  const r = createRegistry();
  r.register({
    type: "mark",
    effect: "pure",
    description: "d",
    inputSchema: { type: "object" },
    async run(input: any) {
      ran.push(input.id);
      controller.abort();
      return {};
    },
  });

  const result = await runFlow(
    parseFlow(`
name: f
inputs: {}
nodes:
  - { id: one, use: mark, in: { id: one } }
  - { id: two, use: mark, in: { id: two } }
`),
    r,
    {},
    { signal: controller.signal },
  );

  expect(ran).toEqual(["one"]);
  expect(result.status).toBe("held");
  expect(result.nodes.at(-1)!.error!.message).toMatch(/interrupt|abort/i);
});
