import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeTask, runTask } from "../../src/work/builder";
import { runGit } from "../../src/work/worktree";
import { createRegistry } from "../../src/registry/registry";
import { writeNode } from "../../src/nodes/write";
import { readNode } from "../../src/nodes/read";
import type { CompletionRequest, CompletionResult, Provider } from "../../src/providers/types";
import type { Policy } from "../../src/policy/decide";

async function repository(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vesna-build-"));
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "user.email", "t@example.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  await writeFile(join(dir, "a.txt"), "one\n");
  await runGit(["add", "-A"], dir);
  await runGit(["commit", "-qm", "first"], dir);
  return dir;
}

function registry() {
  const r = createRegistry();
  r.register(writeNode);
  r.register(readNode);
  return r;
}

/** Writes one file, then answers. */
function writes(path: string, text: string): Provider {
  let turn = 0;
  return {
    id: "fake",
    async complete(): Promise<CompletionResult> {
      turn += 1;
      const content =
        turn === 1
          ? [{ type: "tool_call" as const, id: "c1", name: "write", input: { path, text } }]
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

const says = (text: string): Provider => ({
  id: "fake",
  async complete() {
    return {
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      model: "m",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
});

const open: Policy = { mode: "auto", allow: {}, deny: {} };
const asking: Policy = { mode: "ask", allow: {}, deny: {} };

const request = (repo: string, provider: Provider, policy = open) => ({
  repo,
  spec: "spec",
  task: "T1",
  objective: "do the thing",
  provider,
  registry: registry(),
  policy,
});

test("the work happens in the task's own checkout, not in the repository", async () => {
  const repo = await repository();
  const result = await runTask(request(repo, writes("new.txt", "made\n")));

  expect(result.status).toBe("committed");
  expect(await readFile(join(result.worktree, "new.txt"), "utf8")).toBe("made\n");
  await expect(readFile(join(repo, "new.txt"), "utf8")).rejects.toThrow();
});

test("what comes back is a commit on the task's own branch", async () => {
  const repo = await repository();
  const result = await runTask(request(repo, writes("new.txt", "made\n")));

  expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(result.branch).toBe("vesna/spec/T1");
  const message = await runGit(["log", "-1", "--format=%s", result.commit!], repo);
  expect(message.stdout.trim()).toContain("T1");
});

test("a builder that changed nothing says so rather than committing nothing", async () => {
  const repo = await repository();
  const result = await runTask(request(repo, says("I had nothing to do")));

  expect(result.status).toBe("no-changes");
  expect(result.commit).toBeUndefined();
});

test("with nobody to ask, a question is a refusal — never a silent yes", async () => {
  const repo = await repository();
  const result = await runTask(request(repo, writes("new.txt", "made\n"), asking));

  expect(result.status).toBe("refused");
  await expect(readFile(join(result.worktree, "new.txt"), "utf8")).rejects.toThrow();
});

test("a refusal says what was wanted, so a rule can be written for next time", async () => {
  const repo = await repository();
  const result = await runTask(request(repo, writes("src/new.txt", "made\n"), asking));
  expect(result.refusals.join(" ")).toContain("write");
  expect(result.refusals.join(" ")).toContain("src/new.txt");
});

test("a rule that already allows the work lets it through", async () => {
  const repo = await repository();
  const policy: Policy = { mode: "ask", allow: { write: ["src/**"] }, deny: {} };
  const result = await runTask(request(repo, writes("src/new.txt", "made\n"), policy));
  expect(result.status).toBe("committed");
});

test("a budget stops a run rather than letting it spend on", async () => {
  const repo = await repository();
  const result = await runTask({
    ...request(repo, writes("new.txt", "made\n")),
    maxUsd: 0,
  });
  expect(result.refusals.join(" ")).toContain("budget");
});

test("two tasks build side by side without seeing each other", async () => {
  const repo = await repository();
  const [one, two] = await Promise.all([
    runTask({ ...request(repo, writes("one.txt", "1\n")), task: "T1" }),
    runTask({ ...request(repo, writes("two.txt", "2\n")), task: "T2" }),
  ]);

  // The error text is the evidence when this fails; a bare status is not.
  expect({ status: one.status, error: one.error }).toEqual({ status: "committed", error: undefined });
  expect({ status: two.status, error: two.error }).toEqual({ status: "committed", error: undefined });
  await expect(readFile(join(one.worktree, "two.txt"), "utf8")).rejects.toThrow();
  await expect(readFile(join(two.worktree, "one.txt"), "utf8")).rejects.toThrow();
});

test("eight tasks starting at once all get a checkout — none dies on a sibling's half-written worktree", async () => {
  // `git worktree add` writes its administrative files one by one, and a
  // sibling enumerating worktrees in that window used to die with "failed
  // to read .git/worktrees/<id>/commondir". Repeated, because the window
  // is narrow and shows up under load rather than every time.
  for (let round = 0; round < 5; round++) {
    const repo = await repository();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        runTask({ ...request(repo, writes(`file${n + 1}.txt`, `${n + 1}\n`)), task: `T${n + 1}` }),
      ),
    );
    for (const result of results) {
      expect({ task: result.task, status: result.status, error: result.error }).toEqual({
        task: result.task,
        status: "committed",
        error: undefined,
      });
    }
  }
}, 60_000);

test("a provider that falls over is reported, not thrown at the caller", async () => {
  const repo = await repository();
  const broken: Provider = {
    id: "fake",
    async complete() {
      throw new Error("the provider fell over");
    },
  };
  const result = await runTask(request(repo, broken));
  expect(result.status).toBe("failed");
  expect(result.error).toContain("fell over");
});

test("a task that cannot even get a checkout fails cleanly", async () => {
  const notRepo = await mkdtemp(join(tmpdir(), "vesna-plain-"));
  const result = await runTask(request(notRepo, says("hello")));
  expect(result.status).toBe("failed");
  expect(result.worktree).toBe("");
});

test("what it spent comes back with it", async () => {
  const repo = await repository();
  const result = await runTask(request(repo, writes("new.txt", "made\n")));
  expect(typeof result.costUsd).toBe("number");
});

test("partial work stays refused even when the permitted part was committed", async () => {
  const repo = await repository();
  let turn = 0;
  const provider: Provider = {
    id: "fake",
    async complete() {
      turn += 1;
      return {
        content:
          turn === 1
            ? [
                { type: "tool_call" as const, id: "c1", name: "write", input: { path: "ok.txt", text: "ok\n" } },
                { type: "tool_call" as const, id: "c2", name: "write", input: { path: "blocked/no.txt", text: "no\n" } },
              ]
            : [{ type: "text" as const, text: "done" }],
        stopReason: "end_turn",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const policy: Policy = { mode: "ask", allow: { write: ["ok.txt"] }, deny: {} };

  const result = await runTask(request(repo, provider, policy));
  expect(result.status).toBe("refused");
  expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
});

test("a git commit failure makes the build fail rather than look unchanged", async () => {
  const repo = await repository();
  const git = async (args: string[], cwd: string) => {
    if (args[0] === "commit") return { code: 1, stdout: "", stderr: "hook refused commit" };
    return runGit(args, cwd);
  };

  const result = await runTask({ ...request(repo, writes("new.txt", "made\n")), git });
  expect(result.status).toBe("failed");
  expect(result.error).toContain("hook refused commit");
});

test("resuming a task works in the same checkout and adds a second commit", async () => {
  const repo = await repository();
  const first = await runTask({
    repo, spec: "s", task: "T1", objective: "write b.txt",
    provider: writes("b.txt", "one\n"), registry: registry(), policy: { mode: "auto", allow: {}, deny: {} },
  });
  expect(first.status).toBe("committed");

  const second = await resumeTask({
    repo, task: "T1", worktree: { path: first.worktree, branch: first.branch },
    message: "the file should say two",
    provider: writes("b.txt", "two\n"), registry: registry(), policy: { mode: "auto", allow: {}, deny: {} },
  });
  expect(second.status).toBe("committed");
  expect(second.worktree).toBe(first.worktree);
  expect(second.branch).toBe(first.branch);
  expect(second.commit).not.toBe(first.commit);
  expect(await readFile(join(first.worktree, "b.txt"), "utf8")).toBe("two\n");

  const log = await runGit(["log", "--oneline", first.branch], repo);
  expect(log.stdout.trim().split("\n").length).toBe(3); // first, T1 build, T1 fix
});

test("a resume that changes nothing says so rather than committing air", async () => {
  const repo = await repository();
  const first = await runTask({
    repo, spec: "s", task: "T1", objective: "write b.txt",
    provider: writes("b.txt", "one\n"), registry: registry(), policy: { mode: "auto", allow: {}, deny: {} },
  });
  const second = await resumeTask({
    repo, task: "T1", worktree: { path: first.worktree, branch: first.branch },
    message: "leave it",
    provider: writes("b.txt", "one\n"), registry: registry(), policy: { mode: "auto", allow: {}, deny: {} },
  });
  expect(second.status).toBe("no-changes");
});

/** Calls one tool by name on the first turn, and records every request it sees. */
function calls(name: string, input: Record<string, unknown>): Provider & { requests: CompletionRequest[] } {
  let turn = 0;
  const requests: CompletionRequest[] = [];
  return {
    id: "fake",
    requests,
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      requests.push(request);
      turn += 1;
      return {
        content:
          turn === 1
            ? [{ type: "tool_call" as const, id: "c1", name, input }]
            : [{ type: "text" as const, text: "done" }],
        stopReason: "end_turn",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

/** The tool results the model was handed on its second turn. */
function toolResults(provider: { requests: CompletionRequest[] }): string[] {
  const second = provider.requests[1];
  if (second === undefined) return [];
  return second.messages
    .flatMap((message) => message.content)
    .filter((block): block is Extract<typeof block, { type: "tool_result" }> => block.type === "tool_result")
    .map((block) => (typeof block.content === "string" ? block.content : JSON.stringify(block.content)));
}

test("a worker is not offered the process's own tools, and cannot call them", async () => {
  const repo = await repository();
  const specs = await mkdtemp(join(tmpdir(), "vesna-build-specs-"));
  const { createSink } = await import("../../src/spec/sink");
  const { createPlanNodes } = await import("../../src/nodes/plan");
  const { createClassifyNode } = await import("../../src/sdd/classify");
  const sink = createSink(specs);
  const chatRegistry = registry();
  for (const node of createPlanNodes(sink)) chatRegistry.register(node);
  chatRegistry.register(createClassifyNode(sink));

  for (const [index, name] of ["plan", "task_start", "task_verify", "classify"].entries()) {
    const provider = calls(name, { title: "stray", stage: "design", shape: "feature", why: "x", id: "T1", check: "true" });
    await runTask({ ...request(repo, provider), task: `T${index + 1}`, registry: chatRegistry });
    const offered = (provider.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect({ name, offered: offered.includes(name) }).toEqual({ name, offered: false });
    expect(toolResults(provider).join("\n")).toMatch(/permission denied for|unknown tool/);
  }
  // Nothing reached the spec log: no stray spec directory, no event.
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(specs)).toEqual([]);
});

test("a project that removed a node from permissions.nodes never offers it to a worker", async () => {
  const repo = await repository();
  const { shellNode } = await import("../../src/nodes/shell");
  const withShell = registry();
  withShell.register(shellNode);
  const provider = calls("shell", { command: "touch made.txt" });
  const result = await runTask({
    ...request(repo, provider),
    registry: withShell,
    permit: (type) => ["read", "write"].includes(type),
  });
  const offered = (provider.requests[0]?.tools ?? []).map((tool) => tool.name);
  expect(offered).not.toContain("shell");
  expect(toolResults(provider).join("\n")).toContain("permission denied for shell");
  await expect(readFile(join(result.worktree, "made.txt"), "utf8")).rejects.toThrow();
});

test("the project's notes reach the worker's system prompt", async () => {
  const repo = await repository();
  const provider = calls("read", { path: "a.txt" });
  await runTask({ ...request(repo, provider), notes: "Always write tests first." });
  expect(provider.requests[0]?.system).toContain("Always write tests first.");
});
