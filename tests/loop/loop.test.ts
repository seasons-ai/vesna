import { test, expect } from "bun:test";
import { runLive } from "../../src/loop/loop";
import { createRegistry } from "../../src/registry/registry";
import type { Provider } from "../../src/providers/types";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

function scriptedProvider(turns: any[][]): Provider {
  let index = 0;
  return {
    id: "scripted",
    async complete(request) {
      const content = turns[index] ?? [{ type: "text", text: "done" }];
      index += 1;
      return {
        content,
        stopReason: content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn",
        usage,
        model: request.model,
      };
    },
  };
}

function registryWithEcho() {
  const registry = createRegistry();
  registry.register({
    type: "echo",
    description: "test node", inputSchema: { type: "object" }, effect: "pure",
    async run(input: any) {
      return { value: input.value };
    },
  });
  return registry;
}

test("executes a requested tool and records it as a trace step", async () => {
  const provider = scriptedProvider([
    [{ type: "tool_use", id: "t1", name: "echo", input: { value: "hi" } }],
    [{ type: "text", text: "all done" }],
  ]);

  const trace = await runLive("do it", provider, registryWithEcho(), { cwd: "." });

  expect(trace.steps).toHaveLength(1);
  expect(trace.steps[0]!.nodeType).toBe("echo");
  expect(trace.steps[0]!.output).toEqual({ value: "hi" });
  expect(trace.finalText).toBe("all done");
});

test("accumulates usage and cost across turns", async () => {
  const provider = scriptedProvider([
    [{ type: "tool_use", id: "t1", name: "echo", input: { value: "hi" } }],
    [{ type: "text", text: "done" }],
  ]);
  const trace = await runLive("do it", provider, registryWithEcho(), { cwd: "." });
  expect(trace.usage.outputTokens).toBe(10);
});

test("stops at maxTurns instead of looping forever", async () => {
  const provider = scriptedProvider(
    Array.from({ length: 20 }, () => [
      { type: "tool_use", id: "t", name: "echo", input: { value: "x" } },
    ]),
  );
  const trace = await runLive("loop", provider, registryWithEcho(), {
    cwd: ".",
    maxTurns: 3,
  });
  expect(trace.steps).toHaveLength(3);
});

test("records an environment fingerprint with names but no env values", async () => {
  const provider = scriptedProvider([[{ type: "text", text: "done" }]]);
  const trace = await runLive("x", provider, registryWithEcho(), { cwd: "." });
  expect(trace.environment.cwd).toBe(".");
  expect(Array.isArray(trace.environment.envNames)).toBe(true);
  expect(JSON.stringify(trace.environment)).not.toContain(process.env.PATH ?? "@@no-path@@");
});

test("a denied tool returns an error result instead of executing", async () => {
  const provider = scriptedProvider([
    [{ type: "tool_use", id: "t1", name: "echo", input: { value: "hi" } }],
    [{ type: "text", text: "ok" }],
  ]);
  const trace = await runLive("do it", provider, registryWithEcho(), {
    cwd: ".",
    permit: () => false,
  });
  expect(trace.steps).toHaveLength(0);
});
