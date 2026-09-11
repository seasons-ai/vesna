import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitPlan, writeBriefs } from "../../src/sdd/brief";

const PLAN = `# Plan

Intro that belongs to nobody.

### Task 1: Parse the flag

**Files:** a.ts

- [ ] Step 1: write the test

### Task 2: Emit JSON

Depends on Task 1.

---

### Task 3: Docs
Just the README.
`;

test("a plan splits into tasks at its headings, each carrying its own text", () => {
  const tasks = splitPlan(PLAN);
  expect(tasks.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
  expect(tasks[0]!.title).toBe("Parse the flag");
  expect(tasks[0]!.text).toContain("**Files:** a.ts");
  expect(tasks[0]!.text).not.toContain("Emit JSON");
  expect(tasks[1]!.text).toContain("Depends on Task 1.");
  expect(tasks[1]!.text).not.toContain("---");
});

test("a plan with no task headings is no tasks, not one giant task", () => {
  expect(splitPlan("# Plan\n\nnothing here\n")).toEqual([]);
});

test("briefs are written one per task, headed by the task, and their paths returned", () => {
  const root = mkdtempSync(join(tmpdir(), "vesna-briefs-"));
  const paths = writeBriefs(root, "s", splitPlan(PLAN));
  expect(Object.keys(paths)).toEqual(["T1", "T2", "T3"]);
  const t2 = readFileSync(paths.T2!, "utf8");
  expect(t2.startsWith("### Task 2: Emit JSON")).toBe(true);
  expect(t2).toContain("Depends on Task 1.");
});
