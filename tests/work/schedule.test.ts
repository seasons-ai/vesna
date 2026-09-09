import { test, expect } from "bun:test";
import { CycleError, schedule } from "../../src/work/schedule";
import type { SpecEvent, Task } from "../../src/spec/project";

const task = (id: string, dependsOn: string[] = [], state: Task["state"] = "todo"): Task => ({
  id,
  title: id,
  state,
  dependsOn,
});

/** Records the order tasks ran in, and how many overlapped. */
function runner(failing: string[] = [], delay = 5) {
  const order: string[] = [];
  let live = 0;
  let peak = 0;
  return {
    order,
    peak: () => peak,
    succeeded: (ok: boolean) => ok,
    async run(t: Task) {
      order.push(t.id);
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, delay));
      live -= 1;
      return !failing.includes(t.id);
    },
  };
}

test("a plan with nothing in it finishes immediately", async () => {
  const r = runner();
  const report = await schedule({ tasks: [], run: r.run, succeeded: r.succeeded });
  expect(report.results.size).toBe(0);
});

test("independent tasks all run", async () => {
  const r = runner();
  await schedule({ tasks: [task("A"), task("B")], run: r.run, succeeded: r.succeeded });
  expect(r.order.sort()).toEqual(["A", "B"]);
});

test("a task waits for what it depends on", async () => {
  const r = runner();
  await schedule({
    tasks: [task("B", ["A"]), task("A")],
    run: r.run,
    succeeded: r.succeeded,
  });
  expect(r.order).toEqual(["A", "B"]);
});

test("no more than the concurrency runs at once", async () => {
  const r = runner([], 20);
  await schedule({
    tasks: [task("A"), task("B"), task("C"), task("D")],
    concurrency: 2,
    run: r.run,
    succeeded: r.succeeded,
  });
  expect(r.peak()).toBe(2);
});

test("independent work does overlap — that is the point of running in parallel", async () => {
  const r = runner([], 20);
  await schedule({
    tasks: [task("A"), task("B")],
    concurrency: 2,
    run: r.run,
    succeeded: r.succeeded,
  });
  expect(r.peak()).toBe(2);
});

test("a task whose dependency failed is not run at all", async () => {
  const r = runner(["A"]);
  const report = await schedule({
    tasks: [task("A"), task("B", ["A"])],
    run: r.run,
    succeeded: r.succeeded,
  });

  // Building on a broken foundation gives a second failure that hides the first.
  expect(r.order).toEqual(["A"]);
  expect(report.skipped).toEqual([{ id: "B", reason: "A did not succeed" }]);
});

test("a failure stops only what depended on it", async () => {
  const r = runner(["A"]);
  await schedule({
    tasks: [task("A"), task("B", ["A"]), task("C")],
    run: r.run,
    succeeded: r.succeeded,
  });
  expect(r.order.sort()).toEqual(["A", "C"]);
});

test("work already finished is not done again", async () => {
  const r = runner();
  await schedule({
    tasks: [task("A", [], "done"), task("B", ["A"])],
    run: r.run,
    succeeded: r.succeeded,
  });
  expect(r.order).toEqual(["B"]);
});

test("a dependency nobody declared is named, not waited on forever", async () => {
  const r = runner();
  const report = await schedule({
    tasks: [task("B", ["ghost"])],
    run: r.run,
    succeeded: r.succeeded,
  });
  expect(report.skipped[0]!.reason).toContain("not in the plan");
});

test("tasks waiting on each other are reported rather than hanging", async () => {
  const r = runner();
  await expect(
    schedule({ tasks: [task("A", ["B"]), task("B", ["A"])], run: r.run, succeeded: r.succeeded }),
  ).rejects.toThrow(CycleError);
});

test("the events say what happened, in the order it happened", async () => {
  const r = runner(["B"]);
  const events: SpecEvent[] = [];
  await schedule({
    tasks: [task("A"), task("B", ["A"])],
    concurrency: 1,
    run: r.run,
    succeeded: r.succeeded,
    onEvent: (event) => events.push(event),
  });

  expect(events).toEqual([
    { t: "task.started", id: "A" },
    { t: "task.done", id: "A" },
    { t: "task.started", id: "B" },
    { t: "task.failed", id: "B" },
  ]);
});

test("an interrupt stops new work rather than abandoning what is running", async () => {
  const controller = new AbortController();
  const r = runner([], 30);
  const report = await schedule({
    tasks: [task("A"), task("B"), task("C")],
    concurrency: 1,
    run: async (t) => {
      const result = await r.run(t);
      controller.abort();
      return result;
    },
    succeeded: r.succeeded,
    signal: controller.signal,
  });

  expect(r.order).toEqual(["A"]);
  expect(report.results.get("A")).toBe(true);
  expect(report.skipped.map((entry) => entry.reason)).toEqual(["interrupted", "interrupted"]);
});

test("every result comes back, keyed by its task", async () => {
  const r = runner(["B"]);
  const report = await schedule({
    tasks: [task("A"), task("B")],
    run: r.run,
    succeeded: r.succeeded,
  });
  expect(report.results.get("A")).toBe(true);
  expect(report.results.get("B")).toBe(false);
});
