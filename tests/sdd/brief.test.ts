import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitPlan, writeBriefs } from "../../src/sdd/brief";

const REAL_PLAN_PATH = join(import.meta.dir, "..", "fixtures", "plan-with-fenced-headings.md");

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

test("a heading inside a fenced code block is not a task, it is an example", () => {
  const plan = `### Task 1: Real task

Some intro.

\`\`\`md
### Task 9: Not real
this is just an example inside the fence
\`\`\`

The rest of the real task's body.

### Task 2: Another real task

Its body.
`;
  const tasks = splitPlan(plan);
  expect(tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
  expect(tasks[0]!.text).toContain("### Task 9: Not real");
  expect(tasks[0]!.text).toContain("this is just an example inside the fence");
  expect(tasks[0]!.text).toContain("The rest of the real task's body.");
});

test("two tasks claiming the same number is a malformed plan, refused rather than silently merged", () => {
  const plan = `### Task 1: First

a

### Task 2: Second

b

### Task 1: First again

c
`;
  expect(() => splitPlan(plan)).toThrow("plan names Task 1 twice");
});

test("splitPlan on a real plan whose code examples contain task headings finds exactly its twelve tasks", () => {
  const markdown = readFileSync(REAL_PLAN_PATH, "utf8");
  const tasks = splitPlan(markdown);
  expect(tasks.map((t) => t.id)).toEqual([
    "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12",
  ]);
});

test("a task's verify: line is cut out of its text and returned on its own", () => {
  const plan = `# Plan

### Task 1: The reducer
verify: bun test tests/spec/project.test.ts

- [ ] Step 1

### Task 2: The lock

- [ ] Step 1
`;
  const tasks = splitPlan(plan);
  expect(tasks[0]!.verify).toBe("bun test tests/spec/project.test.ts");
  expect(tasks[0]!.text).not.toContain("verify:");
  expect(tasks[0]!.text).toContain("- [ ] Step 1");
  expect(tasks[1]!.verify).toBeUndefined();
});

test("verify: may follow a blank line, and is only ever the first thing in the task", () => {
  const plan = `### Task 1: A

verify:   bun test

text
`;
  expect(splitPlan(plan)[0]!.verify).toBe("bun test");
});

test("an empty verify: and a second verify: are plan errors naming the task", () => {
  expect(() => splitPlan("### Task 3: A\nverify:\n")).toThrow("Task 3: verify: is empty");
  expect(() => splitPlan("### Task 3: A\nverify: a\n\nverify: b\n")).toThrow("Task 3: verify: given twice");
  expect(() => splitPlan("### Task 3: A\ntext\nverify: a\n")).toThrow(
    "Task 3: verify: must be the first line of the task",
  );
});

test("a verify: inside a fence is somebody's example, not the task's check", () => {
  const plan = "### Task 1: A\n\n```\nverify: not this\n```\n";
  expect(splitPlan(plan)[0]!.verify).toBeUndefined();
});
