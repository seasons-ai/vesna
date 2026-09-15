import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerdictNode, reviewPrompt, reviewTask, type Verdict } from "../../src/sdd/review";
import type { CompletionResult, Provider } from "../../src/providers/types";

const ctx = { cwd: "/tmp", signal: new AbortController().signal };

/** Answers with the given content blocks on the first turn, then plain text. */
function answers(first: CompletionResult["content"]): Provider & { calls: number } {
  let turn = 0;
  return {
    id: "fake",
    calls: 0,
    async complete(): Promise<CompletionResult> {
      turn += 1;
      (this as any).calls = turn;
      return {
        content: turn === 1 ? first : [{ type: "text", text: "that is all" }],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: turn === 1 && first.some((b) => b.type === "tool_call") ? "tool_use" : "end_turn",
        model: "m",
      };
    },
  };
}

test("the verdict node records what it was given and returns it", async () => {
  const holder: { verdict?: any } = {};
  const node = createVerdictNode(holder);
  const verdict: Verdict = { spec: "met", findings: [], summary: "clean" };
  await node.run(verdict, ctx);
  expect(holder.verdict).toEqual(verdict);
});

test("a review that calls review_verdict is a verdict", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  const provider = answers([
    {
      type: "tool_call",
      id: "c1",
      name: "review_verdict",
      input: {
        spec: "not_met",
        findings: [{ severity: "important", file: "a.ts", line: 4, text: "off by one" }],
        summary: "one thing",
      },
    },
  ]);
  const out = await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  expect(out.kind).toBe("verdict");
  if (out.kind === "verdict") {
    expect(out.verdict.spec).toBe("not_met");
    expect(out.verdict.findings[0]!.text).toBe("off by one");
  }
});

test("a review that only talks is no verdict, and says what it said", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  const provider = answers([{ type: "text", text: "looks fine to me" }]);
  const out = await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  expect(out).toMatchObject({ kind: "no-verdict", text: "looks fine to me" });
});

test("a reviewer may read but not write", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  writeFileSync(join(cwd, "a.txt"), "before");
  const provider = answers([
    { type: "tool_call", id: "c1", name: "write", input: { path: "a.txt", text: "after" } },
  ]);
  await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("before");
});

test("a reviewer's shell is read-only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  const provider = answers([
    { type: "tool_call", id: "c1", name: "shell", input: { command: "touch made.txt" } },
  ]);
  await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(cwd, "made.txt"))).toBe(false);
});

test("the prompt carries the brief, the report and the diff, and names the tool", () => {
  const text = reviewPrompt({ cwd: "/x", provider: {} as any, brief: "BRIEF", report: "REPORT", diff: "DIFF" });
  for (const piece of ["BRIEF", "REPORT", "DIFF", "review_verdict"]) expect(text).toContain(piece);
});

test("a re-review is told which findings it is checking", () => {
  const text = reviewPrompt({
    cwd: "/x", provider: {} as any, brief: "b", report: "r", diff: "d",
    findings: [{ severity: "important", file: "a.ts", text: "the one to check" }],
  });
  expect(text).toContain("the one to check");
  expect(text).toMatch(/ADDRESSED|addressed/);
});

test("a re-review is told how to say \"addressed\" through a tool that has no such field", () => {
  const text = reviewPrompt({
    cwd: "/x", provider: {} as any, brief: "b", report: "r", diff: "d",
    findings: [{ severity: "important", file: "a.ts", text: "the one to check" }],
  });
  expect(text).toContain(
    "Report only findings that are NOT addressed, plus any new breakage; leave addressed findings out entirely — an empty findings list means all were addressed.",
  );
  // The old wording asked for a verdict per finding the tool cannot carry.
  expect(text).not.toMatch(/ADDRESSED or NOT ADDRESSED/);
});

test("a first review is not told about addressed findings, because there are none", () => {
  const text = reviewPrompt({ cwd: "/x", provider: {} as any, brief: "b", report: "r", diff: "d" });
  expect(text).not.toContain("addressed");
});

test("a reviewer cannot use sed's in-place edit to write, end to end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  writeFileSync(join(cwd, "a.txt"), "before");
  const provider = answers([
    { type: "tool_call", id: "c1", name: "shell", input: { command: "sed -i.bak 's/before/AFTER/' a.txt" } },
  ]);
  await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("before");
});

test("a malformed verdict is rejected, not stored: bad spec", async () => {
  const holder: { verdict?: Verdict } = {};
  const node = createVerdictNode(holder);
  await expect(node.run({ spec: "yes", findings: [], summary: "x" }, ctx)).rejects.toThrow(/spec/);
  expect(holder.verdict).toBeUndefined();
});

test("a malformed verdict is rejected, not stored: findings not an array", async () => {
  const holder: { verdict?: Verdict } = {};
  const node = createVerdictNode(holder);
  await expect(node.run({ spec: "met", findings: "none", summary: "x" }, ctx)).rejects.toThrow(/findings/);
  expect(holder.verdict).toBeUndefined();
});

test("a malformed verdict is rejected, not stored: bad finding severity", async () => {
  const holder: { verdict?: Verdict } = {};
  const node = createVerdictNode(holder);
  await expect(
    node.run({ spec: "met", findings: [{ severity: "urgent", file: "a.ts", text: "x" }], summary: "x" }, ctx),
  ).rejects.toThrow(/severity/);
  expect(holder.verdict).toBeUndefined();
});

test("a malformed verdict is rejected, not stored: finding file not a string", async () => {
  const holder: { verdict?: Verdict } = {};
  const node = createVerdictNode(holder);
  await expect(
    node.run({ spec: "met", findings: [{ severity: "minor", file: 3, text: "x" }], summary: "x" }, ctx),
  ).rejects.toThrow(/file/);
  expect(holder.verdict).toBeUndefined();
});

test("a malformed verdict is rejected, not stored: finding text not a string", async () => {
  const holder: { verdict?: Verdict } = {};
  const node = createVerdictNode(holder);
  await expect(
    node.run({ spec: "met", findings: [{ severity: "minor", file: "a.ts", text: 3 }], summary: "x" }, ctx),
  ).rejects.toThrow(/text/);
  expect(holder.verdict).toBeUndefined();
});

test("a malformed verdict is rejected, not stored: finding line not an integer", async () => {
  const holder: { verdict?: Verdict } = {};
  const node = createVerdictNode(holder);
  await expect(
    node.run(
      { spec: "met", findings: [{ severity: "minor", file: "a.ts", text: "x", line: 1.5 }], summary: "x" },
      ctx,
    ),
  ).rejects.toThrow(/line/);
  expect(holder.verdict).toBeUndefined();
});

test("a malformed verdict is rejected, not stored: bad summary", async () => {
  const holder: { verdict?: Verdict } = {};
  const node = createVerdictNode(holder);
  await expect(node.run({ spec: "met", findings: [], summary: 42 }, ctx)).rejects.toThrow(/summary/);
  expect(holder.verdict).toBeUndefined();
});

test("a reviewer cannot use git's --output to write, end to end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  const { execFileSync } = await import("node:child_process");
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(cwd, "a.txt"), "before");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  const provider = answers([
    { type: "tool_call", id: "c1", name: "shell", input: { command: "git diff --output=x HEAD" } },
  ]);
  await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(cwd, "x"))).toBe(false);
});

/** A node as an MCP server would register it, with the effect the config gave it. */
function mcpNode(type: string, effect: "pure" | "write" | "external", origin: "mcp" | "none" = "mcp") {
  return {
    type,
    effect,
    ...(origin === "mcp" ? { origin } : {}),
    description: `fake: ${type}`,
    inputSchema: { type: "object", properties: {} },
    async run() {
      return "called";
    },
  };
}

/** Records the tool names each completion offered. */
function offering(): Provider & { tools: string[][] } {
  return {
    id: "fake",
    tools: [],
    async complete(request): Promise<CompletionResult> {
      (this as any).tools.push((request.tools ?? []).map((t) => t.name));
      return {
        content: [{ type: "text", text: "no verdict" }],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end_turn",
        model: "m",
      };
    },
  };
}

test("the reviewer gets the MCP tools the config calls pure, and no other", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  const provider = offering();
  await reviewTask({
    cwd, provider, brief: "b", report: "r", diff: "d",
    extraTools: [
      mcpNode("fake__pure", "pure"),
      mcpNode("fake__external", "external"),
      mcpNode("fake__write", "write"),
      // Not an MCP node: the reviewer's builtins are listed by hand, never by effect.
      mcpNode("stray", "pure", "none"),
    ],
  });
  const names = provider.tools[0]!;
  expect(names).toContain("fake__pure");
  expect(names).not.toContain("fake__external");
  expect(names).not.toContain("fake__write");
  expect(names).not.toContain("stray");
  expect(names).toEqual(expect.arrayContaining(["read", "grep", "glob", "shell", "review_verdict"]));
});

test("a reviewer without extra tools has exactly the four builtins and the verdict", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-review-"));
  const provider = offering();
  await reviewTask({ cwd, provider, brief: "b", report: "r", diff: "d" });
  expect([...provider.tools[0]!].sort()).toEqual(["glob", "grep", "read", "review_verdict", "shell"]);
});
