import { test, expect } from "bun:test";
import { scriptNode } from "../../src/nodes/script";

const ctx = { cwd: process.cwd(), signal: new AbortController().signal };

test("evaluates a script body and returns its output", async () => {
  const result = await scriptNode.run(
    { body: "output = { sum: input.a + input.b };", args: { a: 2, b: 3 } },
    ctx,
  );
  expect(result).toEqual({ sum: 5 });
});

test("propagates a script error as a node failure", async () => {
  await expect(scriptNode.run({ body: "throw new Error('bad script');" }, ctx)).rejects.toThrow(/bad script/);
});

test("kills a script that exceeds its timeout", async () => {
  await expect(scriptNode.run({ body: "while (true) {}", timeoutMs: 200 }, ctx)).rejects.toThrow(/timed out or crashed/);
});

test("networking is unavailable inside the sandbox", async () => {
  await expect(
    scriptNode.run({ body: "output = await fetch('http://example.com').then(r => r.status);" }, ctx),
  ).rejects.toThrow();
});

test("is declared as a pure effect", () => {
  expect(scriptNode.effect).toBe("pure");
});
