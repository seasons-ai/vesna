import { test, expect } from "bun:test";
import { createClassifyNode, SHAPES } from "../../src/sdd/classify";
import type { SpecEvent } from "../../src/spec/project";
import type { SpecSink } from "../../src/spec/sink";

function sink(): SpecSink & { events: SpecEvent[] } {
  const events: SpecEvent[] = [];
  let slug: string | null = null;
  let created = false;
  return {
    events,
    get slug() { return slug; },
    set slug(v) { slug = v; },
    get open() { return slug !== null; },
    get created() { return created; },
    ensure(title) { created = slug === null; slug ??= title.toLowerCase(); return slug; },
    emit(e) { if (slug !== null) events.push(e); },
  };
}

const ctx = { cwd: "/tmp", signal: new AbortController().signal };

test("the three shapes, lightest first", () => {
  expect([...SHAPES]).toEqual(["spike", "bounded", "architectural"]);
});

test("classifying opens a spec if none is open and records the shape as the agent's", async () => {
  const s = sink();
  const node = createClassifyNode(s);
  const out = await node.run({ shape: "bounded", title: "Cancel cleanly", why: "one file" }, ctx);
  expect(out).toEqual({ shape: "bounded", spec: "cancel cleanly" });
  expect(s.events).toEqual([{ t: "classified", shape: "bounded", by: "agent" }]);
});

test("a spike opens no spec: its output is an answer, not work to track", async () => {
  const s = sink();
  const out = await createClassifyNode(s).run({ shape: "spike", why: "just checking" }, ctx);
  expect(out.spec).toBe("");
  expect(s.open).toBe(false);
  expect(s.events).toEqual([]);
});

test("an unknown shape is refused, naming the three", async () => {
  const s = sink();
  await expect(
    createClassifyNode(s).run({ shape: "huge" as any, why: "" }, ctx),
  ).rejects.toThrow(/spike, bounded, architectural/);
});
