import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createSpec, listSpecs, readSpec, slugify, specsRoot } from "../../src/spec/store";

const root = async () => specsRoot(await mkdtemp(join(tmpdir(), "vesna-spec-")));

test("specs live in the project, beside the code they describe", () => {
  expect(specsRoot("/work/api")).toBe("/work/api/.vesna/specs");
});

test("a name becomes a directory that cannot surprise anyone", () => {
  expect(slugify("Add abort handling!")).toBe("add-abort-handling");
  expect(slugify("  spaces  and---dashes  ")).toBe("spaces-and-dashes");
  expect(slugify("Привет")).toBe("spec");
  expect(slugify("")).toBe("spec");
});

test("a created spec exists and knows its own title", async () => {
  const dir = await root();
  const made = createSpec(dir, "Reliable cancellation");
  expect(made.slug).toBe("reliable-cancellation");
  expect(readSpec(dir, made.slug)!.title).toBe("Reliable cancellation");
});

test("creating the same spec twice is refused rather than appended to", async () => {
  const dir = await root();
  createSpec(dir, "Reliable cancellation");
  expect(() => createSpec(dir, "Reliable cancellation")).toThrow(/already exists/);
});

test("the refusal says how to open the one that is there", async () => {
  const dir = await root();
  createSpec(dir, "abort handling");
  expect(() => createSpec(dir, "abort handling")).toThrow(/spec open abort-handling/);
});

test("events accumulate and project into the tree", async () => {
  const dir = await root();
  const { slug } = createSpec(dir, "work");
  appendEvent(dir, slug, { t: "stage.entered", stage: "build" });
  appendEvent(dir, slug, { t: "task.added", id: "T1", title: "one" });
  appendEvent(dir, slug, { t: "task.done", id: "T1" });

  const tree = readSpec(dir, slug)!;
  expect(tree.stages.find((s) => s.stage === "build")!.state).toBe("active");
  expect(tree.progress).toEqual({ done: 1, total: 1 });
});

test("a spec survives being read back in a fresh process, which is the point", async () => {
  const dir = await root();
  const { slug } = createSpec(dir, "work");
  appendEvent(dir, slug, { t: "task.added", id: "T1", title: "kept" });
  expect(readSpec(dir, slug)!.tasks[0]!.title).toBe("kept");
});

test("listing shows what there is, by name", async () => {
  const dir = await root();
  createSpec(dir, "beta work");
  createSpec(dir, "alpha work");
  expect(listSpecs(dir).map((s) => s.slug)).toEqual(["alpha-work", "beta-work"]);
});

test("listing nothing is empty, not an error", async () => {
  expect(listSpecs(await root())).toEqual([]);
});

test("a spec that never got created is nothing, not a crash", async () => {
  expect(readSpec(await root(), "missing")).toBeNull();
});

test("a torn line costs its own event and no others", async () => {
  const dir = await root();
  const { slug } = createSpec(dir, "work");
  appendEvent(dir, slug, { t: "task.added", id: "T1", title: "before" });
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(dir, slug, "events.jsonl"), "{not json\n");
  appendEvent(dir, slug, { t: "task.added", id: "T2", title: "after" });

  expect(readSpec(dir, slug)!.tasks.map((t) => t.title)).toEqual(["before", "after"]);
});
