import { join } from "node:path";
import { test, expect } from "bun:test";
import { diagnostics, groupByFile } from "../src/diagnostics";
import type { State, SpecTree } from "../src/protocol";

const ROOT = "/repo";

function makeSpec(overrides: Partial<SpecTree> = {}): SpecTree {
  return {
    id: "abort",
    title: "Reliable cancellation",
    stages: [],
    criteria: [],
    tasks: [],
    progress: { done: 0, total: 0 },
    approved: { spec: true, plan: true },
    digests: {},
    building: true,
    ignored: 0,
    reviews: {},
    parked: [],
    rulings: [],
    finished: false,
    ...overrides,
  };
}

function makeState(spec: SpecTree | null, over: Partial<State> = {}): State {
  return {
    mode: "auto",
    busy: false,
    building: false,
    buildState: "idle",
    model: "gpt",
    service: "openai",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    spec,
    specSlug: spec === null ? null : "abort",
    chats: null,
    chatId: null,
    root: ROOT,
    ...over,
  };
}

test("no spec, no diagnostics", () => {
  expect(diagnostics(makeState(null))).toEqual([]);
});

test("parked findings and every open review finding become diagnostics, minus the ones with nothing to underline", () => {
  const spec = makeSpec({
    parked: [
      { task: "T1", finding: { severity: "critical", file: "verify", text: "skipped: the verify pseudo-file" } },
      { task: "T1", finding: { severity: "minor", file: "", text: "skipped: no file at all" } },
      { task: "T1", finding: { severity: "minor", file: "a.ts", line: 3, text: "parked issue" } },
    ],
    reviews: {
      T1: {
        round: 1,
        spec: "not_met",
        open: [
          { severity: "critical", file: "a.ts", text: "open issue" },
          { severity: "important", file: "b.ts", line: 5, text: "warn issue" },
        ],
      },
    },
  });

  const out = diagnostics(makeState(spec));

  expect(out).toEqual([
    { file: join(ROOT, "a.ts"), line: 2, severity: "information", message: "T1: parked issue" },
    { file: join(ROOT, "a.ts"), line: 0, severity: "error", message: "T1: open issue" },
    { file: join(ROOT, "b.ts"), line: 4, severity: "warning", message: "T1: warn issue" },
  ]);
});

test("a missing line defaults to line 1, reported zero-based as 0", () => {
  const spec = makeSpec({
    reviews: {
      T1: { round: 1, spec: "not_met", open: [{ severity: "minor", file: "a.ts", text: "no line given" }] },
    },
  });
  const [diag] = diagnostics(makeState(spec));
  expect(diag!.line).toBe(0);
});

test("severity maps critical/important/minor to error/warning/information", () => {
  const spec = makeSpec({
    reviews: {
      T1: {
        round: 1,
        spec: "not_met",
        open: [
          { severity: "critical", file: "a.ts", text: "x" },
          { severity: "important", file: "a.ts", text: "y" },
          { severity: "minor", file: "a.ts", text: "z" },
        ],
      },
    },
  });
  const out = diagnostics(makeState(spec));
  expect(out.map((d) => d.severity)).toEqual(["error", "warning", "information"]);
});

// ---------------------------------------------------------------------------
// groupByFile — the adapter's grouping, with existence injected.

test("diagnostics are grouped by file, in order, and a file that does not exist is dropped", () => {
  const diags = [
    { file: "/repo/a.ts", line: 2, severity: "warning" as const, message: "T1: first" },
    { file: "/repo/gone.ts", line: 0, severity: "error" as const, message: "T1: nowhere" },
    { file: "/repo/b.ts", line: 0, severity: "information" as const, message: "T2: other" },
    { file: "/repo/a.ts", line: 4, severity: "error" as const, message: "T2: second" },
  ];
  const seen: string[] = [];
  const grouped = groupByFile(diags, (file) => {
    seen.push(file);
    return file !== "/repo/gone.ts";
  });
  expect([...grouped.keys()]).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  expect(grouped.get("/repo/a.ts")!.map((d) => d.message)).toEqual(["T1: first", "T2: second"]);
  expect(grouped.get("/repo/b.ts")!.map((d) => d.message)).toEqual(["T2: other"]);
  // Existence is asked once per file, not once per finding.
  expect(seen).toEqual(["/repo/a.ts", "/repo/gone.ts", "/repo/b.ts"]);
});
