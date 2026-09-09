import { test, expect } from "bun:test";
import { createSession } from "../../src/loop/session";
import { createRegistry } from "../../src/registry/registry";
import type { CompletionResult, Provider } from "../../src/providers/types";

function registry(ran: string[]) {
  const r = createRegistry();
  r.register({
    type: "write",
    effect: "write",
    description: "write a file",
    inputSchema: { type: "object" },
    async run(input: any) {
      ran.push(input.path);
      return { path: input.path };
    },
  });
  return r;
}

/** Calls `write` once, then answers. */
function callsWrite(): Provider {
  let turn = 0;
  return {
    id: "fake",
    async complete(): Promise<CompletionResult> {
      turn += 1;
      const content =
        turn === 1
          ? [{ type: "tool_call" as const, id: "c1", name: "write", input: { path: "src/a.ts" } }]
          : [{ type: "text" as const, text: "done" }];
      return {
        content,
        stopReason: "end_turn",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

test("an approved action runs", async () => {
  const ran: string[] = [];
  await createSession(callsWrite(), registry(ran), {
    cwd: "/w",
    approve: async () => "allow",
  }).send("go");
  expect(ran).toEqual(["src/a.ts"]);
});

test("a refused action does not run, and the model is told why", async () => {
  const ran: string[] = [];
  const session = createSession(callsWrite(), registry(ran), {
    cwd: "/w",
    approve: async () => "deny",
  });
  await session.send("go");

  expect(ran).toEqual([]);
  const results = JSON.stringify(session.messages);
  expect(results).toContain("refused");
});

test("the approver is told what the action actually is, not just its type", async () => {
  const seen: unknown[] = [];
  await createSession(callsWrite(), registry([]), {
    cwd: "/w",
    approve: async (action) => {
      seen.push(action);
      return "allow";
    },
  }).send("go");

  // The effect travels with the action: it is what decides whether a question
  // is worth asking at all.
  expect(seen).toEqual([
    { node: "write", input: { path: "src/a.ts" }, cwd: "/w", effect: "write" },
  ]);
});

test("without an approver everything permitted still runs, as it always did", async () => {
  const ran: string[] = [];
  await createSession(callsWrite(), registry(ran), { cwd: "/w" }).send("go");
  expect(ran).toEqual(["src/a.ts"]);
});

test("a refusal does not end the turn — the model can try something else", async () => {
  const session = createSession(callsWrite(), registry([]), {
    cwd: "/w",
    approve: async () => "deny",
  });
  const result = await session.send("go");
  expect(result.text).toBe("done");
});
