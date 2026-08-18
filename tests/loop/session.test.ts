import { test, expect } from "bun:test";
import { createSession } from "../../src/loop/session";
import { createRegistry } from "../../src/registry/registry";
import type { Provider } from "../../src/providers/types";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Replies from a script, and records what history it was given each time. */
function scriptedProvider(turns: any[][]) {
  const seen: any[][] = [];
  let index = 0;
  const provider: Provider = {
    id: "scripted",
    async complete(request) {
      seen.push(structuredClone(request.messages));
      const content = turns[index] ?? [{ type: "text", text: "done" }];
      index += 1;
      return {
        content,
        stopReason: content.some((b: any) => b.type === "tool_call") ? "tool_use" : "end_turn",
        usage,
        model: request.model,
      };
    },
  };
  return { provider, seen };
}

function registryWithEcho() {
  const registry = createRegistry();
  registry.register({
    type: "echo",
    effect: "pure",
    description: "Echo a value",
    inputSchema: { type: "object" },
    async run(input: any) {
      return { value: input.value };
    },
  });
  return registry;
}

test("a second message sees the first turn's history", async () => {
  const { provider, seen } = scriptedProvider([
    [{ type: "text", text: "first" }],
    [{ type: "text", text: "second" }],
  ]);
  const session = createSession(provider, registryWithEcho(), { cwd: "." });

  await session.send("hello");
  await session.send("and again");

  expect(seen[1]!.length).toBeGreaterThan(seen[0]!.length);
  expect(seen[1]![0]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
  expect(seen[1]!.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "and again" }] });
});

test("a turn returns just that turn's text and steps", async () => {
  const { provider } = scriptedProvider([
    [{ type: "tool_call", id: "t1", name: "echo", input: { value: "x" } }],
    [{ type: "text", text: "first done" }],
    [{ type: "text", text: "second done" }],
  ]);
  const session = createSession(provider, registryWithEcho(), { cwd: "." });

  const first = await session.send("do it");
  expect(first.text).toBe("first done");
  expect(first.steps).toHaveLength(1);

  const second = await session.send("again");
  expect(second.text).toBe("second done");
  expect(second.steps).toHaveLength(0);
});

test("usage and cost accumulate across turns, not per turn", async () => {
  const { provider } = scriptedProvider([
    [{ type: "text", text: "a" }],
    [{ type: "text", text: "b" }],
  ]);
  const session = createSession(provider, registryWithEcho(), { cwd: "." });

  await session.send("one");
  expect(session.usage.outputTokens).toBe(5);
  await session.send("two");
  expect(session.usage.outputTokens).toBe(10);
});

test("the whole session exports as a trace the crystallizer can read", async () => {
  const { provider } = scriptedProvider([
    [{ type: "tool_call", id: "t1", name: "echo", input: { value: "x" } }],
    [{ type: "text", text: "all done" }],
  ]);
  const session = createSession(provider, registryWithEcho(), { cwd: "." });
  await session.send("build the thing");

  const trace = await session.toTrace();
  expect(trace.prompt).toBe("build the thing");
  expect(trace.finalText).toBe("all done");
  expect(trace.steps).toHaveLength(1);
  expect(trace.environment.cwd).toBe(".");
});

test("a multi-turn session keeps the first prompt as the trace prompt", async () => {
  const { provider } = scriptedProvider([[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]]);
  const session = createSession(provider, registryWithEcho(), { cwd: "." });
  await session.send("the original ask");
  await session.send("a follow-up");
  expect((await session.toTrace()).prompt).toBe("the original ask");
});

test("steps from every turn end up in one trace", async () => {
  const { provider } = scriptedProvider([
    [{ type: "tool_call", id: "t1", name: "echo", input: { value: "a" } }],
    [{ type: "text", text: "done one" }],
    [{ type: "tool_call", id: "t2", name: "echo", input: { value: "b" } }],
    [{ type: "text", text: "done two" }],
  ]);
  const session = createSession(provider, registryWithEcho(), { cwd: "." });
  await session.send("first");
  await session.send("second");
  expect((await session.toTrace()).steps.map((s) => s.id)).toEqual(["t1", "t2"]);
});
