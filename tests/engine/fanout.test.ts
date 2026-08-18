import { test, expect } from "bun:test";
import { runMapped } from "../../src/engine/fanout";
import { parseFlow } from "../../src/flow/parse";
import { createRegistry } from "../../src/registry/registry";

const FLOW = parseFlow(`
name: f
inputs: { client: { type: string, required: true } }
nodes:
  - id: check
    use: echo
    in: { value: $.inputs.client }
    assert:
      - non_empty: $.out.value
`);

function registry() {
  const r = createRegistry();
  r.register({ type: "echo", description: "test node", inputSchema: { type: "object" }, effect: "pure", async run(input: any) { return input; } });
  return r;
}

test("runs every row and reports ok and held counts", async () => {
  const rows = [{ client: "Acme" }, { client: "" }, { client: "Globex" }];
  const summary = await runMapped(FLOW, registry(), rows, {});
  expect(summary.ok).toBe(2);
  expect(summary.held).toBe(1);
  expect(summary.rows).toHaveLength(3);
});

test("a held row does not stop the remaining rows", async () => {
  const rows = [{ client: "" }, { client: "Acme" }];
  const summary = await runMapped(FLOW, registry(), rows, {});
  expect(summary.rows.find((r) => r.index === 1)!.result.status).toBe("ok");
});

test("respects the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const r = createRegistry();
  r.register({
    type: "echo",
    description: "test node", inputSchema: { type: "object" }, effect: "pure",
    async run(input: any) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return input;
    },
  });
  const rows = Array.from({ length: 12 }, (_, i) => ({ client: `c${i}` }));
  await runMapped(FLOW, r, rows, { concurrency: 3 });
  expect(peak).toBeLessThanOrEqual(3);
});
