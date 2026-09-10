import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSink } from "../../src/spec/sink";
import { listSpecs, readSpec, specsRoot } from "../../src/spec/store";

const root = async () => specsRoot(await mkdtemp(join(tmpdir(), "vesna-sink-")));

test("with nothing open, planning opens a spec rather than failing", async () => {
  const dir = await root();
  const sink = createSink(dir);

  const slug = sink.ensure("Reliable cancellation");
  expect(slug).toBe("reliable-cancellation");
  expect(sink.slug).toBe(slug);
  expect(readSpec(dir, slug)!.title).toBe("Reliable cancellation");
});

test("a spec already open is used, not replaced", async () => {
  const dir = await root();
  const sink = createSink(dir);
  const first = sink.ensure("first piece of work");
  const again = sink.ensure("something else entirely");

  expect(again).toBe(first);
  expect(listSpecs(dir)).toHaveLength(1);
});

test("reopening the same name later picks up what is already there", async () => {
  const dir = await root();
  const one = createSink(dir);
  one.ensure("shared work");
  one.emit({ t: "task.added", id: "T1", title: "kept" });

  const two = createSink(dir);
  expect(two.ensure("shared work")).toBe("shared-work");
  expect(readSpec(dir, "shared-work")!.tasks.map((t) => t.title)).toEqual(["kept"]);
});

test("it reports whether it just made one, so the user can be told", async () => {
  const dir = await root();
  const sink = createSink(dir);
  expect(sink.created).toBe(false);
  sink.ensure("new work");
  expect(sink.created).toBe(true);
  sink.ensure("new work");
  expect(sink.created).toBe(false);
});

test("events still go nowhere when nothing has been opened or ensured", async () => {
  const sink = createSink(await root());
  sink.emit({ t: "task.added", id: "T1", title: "lost" });
  expect(sink.open).toBe(false);
});
