import { test, expect } from "bun:test";
import { createSession } from "../../src/loop/session";
import { createRegistry } from "../../src/registry/registry";
import type { CompletionRequest, CompletionResult, Provider } from "../../src/providers/types";

function registry() {
  const r = createRegistry();
  for (const type of ["read", "write", "shell"]) {
    r.register({
      type,
      effect: type === "read" ? "pure" : "write",
      description: `${type} things`,
      inputSchema: { type: "object" },
      async run() {
        return {};
      },
    });
  }
  return r;
}

function capturing() {
  const seen: CompletionRequest[] = [];
  const provider: Provider = {
    id: "fake",
    async complete(request): Promise<CompletionResult> {
      seen.push(request);
      return {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  return { provider, seen };
}

test("the agent now sends a system prompt at all — it never used to", async () => {
  const { provider, seen } = capturing();
  await createSession(provider, registry(), { cwd: "/w" }).send("hi");
  expect(seen[0]!.system).toBeDefined();
  expect(seen[0]!.system).toContain("Vesna");
});

test("the prompt names the working directory it was given", async () => {
  const { provider, seen } = capturing();
  await createSession(provider, registry(), { cwd: "/some/where" }).send("hi");
  expect(seen[0]!.system).toContain("/some/where");
});

test("a node the project forbids is never offered to the model", async () => {
  const { provider, seen } = capturing();
  await createSession(provider, registry(), {
    cwd: "/w",
    permit: (type) => type !== "shell",
  }).send("hi");

  const names = seen[0]!.tools!.map((tool) => tool.name);
  expect(names).toContain("read");
  expect(names).not.toContain("shell");
});

test("and the prompt does not promise it either", async () => {
  const { provider, seen } = capturing();
  await createSession(provider, registry(), {
    cwd: "/w",
    permit: (type) => type !== "shell",
  }).send("hi");
  expect(seen[0]!.system).not.toContain("shell");
});

test("with everything forbidden the model is offered nothing and told so", async () => {
  const { provider, seen } = capturing();
  await createSession(provider, registry(), { cwd: "/w", permit: () => false }).send("hi");
  expect(seen[0]!.tools).toEqual([]);
  expect(seen[0]!.system).toMatch(/no tools/i);
});

test("project notes reach the model when the session is given them", async () => {
  const { provider, seen } = capturing();
  await createSession(provider, registry(), {
    cwd: "/w",
    notes: "Never touch the migrations folder.",
  }).send("hi");
  expect(seen[0]!.system).toContain("Never touch the migrations folder.");
});

test("the prompt is identical across turns, so it stays cacheable", async () => {
  const { provider, seen } = capturing();
  const session = createSession(provider, registry(), { cwd: "/w" });
  await session.send("one");
  await session.send("two");
  expect(seen[1]!.system).toBe(seen[0]!.system);
});
