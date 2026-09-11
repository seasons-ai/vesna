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
