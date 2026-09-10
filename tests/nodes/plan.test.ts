import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanNodes } from "../../src/nodes/plan";
import { createSink } from "../../src/spec/sink";
import { createSpec, readSpec, specsRoot } from "../../src/spec/store";
import type { NodeDef } from "../../src/registry/types";

async function ready() {
  const project = await mkdtemp(join(tmpdir(), "vesna-plan-"));
  const root = specsRoot(project);
  const { slug } = createSpec(root, "the work");
  const sink = createSink(root);
  sink.slug = slug;
  const nodes = createPlanNodes(sink);
  const by = (type: string) => nodes.find((node) => node.type === type)! as NodeDef<any, any>;
  return { project, root, slug, sink, by, tree: () => readSpec(root, slug)! };
}

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal });

test("a plan records the stage, the criteria and the tasks in one call", async () => {
  const it = await ready();
  await it.by("plan").run(
    {
      stage: "build",
      criteria: [{ id: "AC-1", text: "shell stops on abort" }],
      tasks: [{ id: "T1", title: "add a failing test" }, { id: "T2", title: "fix it", dependsOn: ["T1"] }],
    },
    ctx(it.project),
  );

  const tree = it.tree();
  expect(tree.stages.find((s) => s.stage === "build")!.state).toBe("active");
  expect(tree.criteria.map((c) => c.id)).toEqual(["AC-1"]);
  expect(tree.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
  expect(tree.tasks.find((t) => t.id === "T2")!.state).toBe("blocked");
});

test("a stage nobody has heard of is ignored rather than invented", async () => {
  const it = await ready();
  await it.by("plan").run({ stage: "wibble" }, ctx(it.project));
  expect(it.tree().stages.every((s) => s.state === "todo")).toBe(true);
});

test("declaring a task does not start it", async () => {
  const it = await ready();
  await it.by("plan").run({ tasks: [{ id: "T1", title: "one" }] }, ctx(it.project));
  expect(it.tree().tasks[0]!.state).toBe("todo");
});

test("starting a task shows it as running", async () => {
  const it = await ready();
  await it.by("plan").run({ tasks: [{ id: "T1", title: "one" }] }, ctx(it.project));
  await it.by("task_start").run({ id: "T1" }, ctx(it.project));
  expect(it.tree().tasks[0]!.state).toBe("running");
});

test("there is no node that marks a task done by assertion", async () => {
  const it = await ready();
  const types = ["plan", "task_start", "task_verify"];
  expect(createPlanNodes(it.sink).map((node) => node.type)).toEqual(types);
});

test("a passing check finishes the task and keeps the command as evidence", async () => {
  const it = await ready();
  await it.by("plan").run({ tasks: [{ id: "T1", title: "one" }] }, ctx(it.project));

  const result = await it.by("task_verify").run({ id: "T1", check: "true" }, ctx(it.project));
  expect(result.passed).toBe(true);

  const tree = it.tree();
  expect(tree.tasks[0]!.state).toBe("done");
  expect(tree.criteria.find((c) => c.id === "T1")!.evidence).toBe("true");
});

test("a failing check fails the task rather than finishing it", async () => {
  const it = await ready();
  await it.by("plan").run({ tasks: [{ id: "T1", title: "one" }] }, ctx(it.project));

  const result = await it.by("task_verify").run({ id: "T1", check: "exit 3" }, ctx(it.project));
  expect(result.passed).toBe(false);
  expect(it.tree().tasks[0]!.state).toBe("failed");
});

test("a failing check hands back its output, so the work can be fixed", async () => {
  const it = await ready();
  await it.by("plan").run({ tasks: [{ id: "T1", title: "one" }] }, ctx(it.project));
  const result = await it.by("task_verify").run(
    { id: "T1", check: "echo 'assertion failed: 2 != 3' >&2; exit 1" },
    ctx(it.project),
  );
  expect(result.output).toContain("assertion failed");
});

test("a failing check is an answer, not a thrown error", async () => {
  const it = await ready();
  await it.by("plan").run({ tasks: [{ id: "T1", title: "one" }] }, ctx(it.project));
  await expect(
    it.by("task_verify").run({ id: "T1", check: "exit 1" }, ctx(it.project)),
  ).resolves.toBeDefined();
});

test("planning with nothing open opens a spec rather than refusing", async () => {
  const it = await ready();
  it.sink.slug = null;

  const result = await it.by("plan").run(
    { title: "Reliable cancellation", tasks: [{ id: "T1", title: "one" }] },
    ctx(it.project),
  );

  expect(result.opened).toBe(true);
  expect(result.spec).toBe("reliable-cancellation");
  expect(readSpec(it.root, result.spec)!.tasks.map((t) => t.id)).toEqual(["T1"]);
});

test("an unnamed plan takes its name from the first task", async () => {
  const it = await ready();
  it.sink.slug = null;
  const result = await it.by("plan").run(
    { tasks: [{ id: "T1", title: "cancel the shell" }] },
    ctx(it.project),
  );
  expect(result.spec).toBe("cancel-the-shell");
});

test("the other two still need a plan first — they have nothing to open one from", async () => {
  const it = await ready();
  it.sink.slug = null;
  for (const type of ["task_start", "task_verify"]) {
    await expect(
      it.by(type).run({ id: "T1", check: "true" }, ctx(it.project)),
    ).rejects.toThrow(/record a plan first/);
  }
});

test("verification is a write, so the permission layer sees it", async () => {
  const it = await ready();
  expect(it.by("task_verify").effect).toBe("write");
  expect(it.by("plan").effect).toBe("pure");
});
