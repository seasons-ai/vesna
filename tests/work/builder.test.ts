import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../../src/work/builder";
import { runGit } from "../../src/work/worktree";
import { createRegistry } from "../../src/registry/registry";
import { writeNode } from "../../src/nodes/write";
import { readNode } from "../../src/nodes/read";
import type { CompletionResult, Provider } from "../../src/providers/types";
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

  expect(one.status).toBe("committed");
  expect(two.status).toBe("committed");
  await expect(readFile(join(one.worktree, "two.txt"), "utf8")).rejects.toThrow();
  await expect(readFile(join(two.worktree, "one.txt"), "utf8")).rejects.toThrow();
});

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
