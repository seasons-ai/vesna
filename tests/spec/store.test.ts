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
  // A name with no latin at all still gets a directory of its own.
  expect(slugify("Привет")).toMatch(/^spec-[0-9a-f]{6}$/);
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

test("a name in another script still gets a directory of its own", () => {
  const one = slugify("Подсветка синтаксиса");
  const two = slugify("История разговоров");
  expect(one).not.toBe(two);
  expect(one).toMatch(/^[a-z0-9-]+$/);
});

test("two names that share their only latin word do not share a directory", () => {
  // Both collapsed to "tui" before, and the second silently continued the first.
  expect(slugify("Подсветка синтаксиса в TUI")).not.toBe(slugify("История чатов в TUI"));
});

test("the same name always gives the same directory, or reopening would break", () => {
  expect(slugify("Подсветка синтаксиса в TUI")).toBe(slugify("Подсветка синтаксиса в TUI"));
});

test("a latin name is untouched, because those already read well", () => {
  expect(slugify("Reliable cancellation")).toBe("reliable-cancellation");
});

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { specPaths, writeSpecFile, readSpecFile, digestOf, digestOfText } from "../../src/spec/store";

test("a spec's files all live in its own folder", () => {
  const p = specPaths("/repo/.vesna/specs", "cancel");
  expect(p.dir).toBe("/repo/.vesna/specs/cancel");
  expect(p.events).toBe("/repo/.vesna/specs/cancel/events.jsonl");
  expect(p.spec).toBe("/repo/.vesna/specs/cancel/spec.md");
  expect(p.plan).toBe("/repo/.vesna/specs/cancel/plan.md");
  expect(p.briefs).toBe("/repo/.vesna/specs/cancel/briefs");
  expect(p.reports).toBe("/repo/.vesna/specs/cancel/reports");
  expect(p.reviews).toBe("/repo/.vesna/specs/cancel/reviews");
});

test("writing a spec file makes its folder, and reading it back is exact", () => {
  const root = mkdtempSync(join(tmpdir(), "vesna-specfile-"));
  const p = specPaths(root, "x");
  expect(readSpecFile(p.spec)).toBeNull();
  writeSpecFile(join(p.briefs, "T1.md"), "# T1\n");
  expect(existsSync(p.briefs)).toBe(true);
  expect(readSpecFile(join(p.briefs, "T1.md"))).toBe("# T1\n");
});

test("digestOf is the sha256 of the file's bytes, and null for a file that is not there", () => {
  const dir = mkdtempSync(join(tmpdir(), "vesna-digest-"));
  const path = join(dir, "plan.md");
  writeFileSync(path, "# Plan\n");
  expect(digestOf(path)).toBe(createHash("sha256").update("# Plan\n").digest("hex"));
  expect(digestOf(join(dir, "missing.md"))).toBeNull();
});

// The chat hashes the plan text it already read for the question, so the
// yes names those very bytes; the two spellings must agree on a file.
test("digestOfText of a file's text is digestOf the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vesna-digest-text-"));
  const path = join(dir, "plan.md");
  const text = "# Plan\n\n### Task 1: First\nverify: bun test\n\nDo it.\n";
  writeFileSync(path, text);
  expect(digestOfText(readFileSync(path, "utf8"))).toBe(digestOf(path)!);
  expect(digestOfText(text)).toBe(createHash("sha256").update(text).digest("hex"));
});
