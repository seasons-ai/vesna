import type { SpecEvent, Task } from "../spec/project";

/**
 * Which tasks may run, and when.
 *
 * The plan is a graph, so the order is not the order they were written in. A
 * task runs when everything it waits for has finished; a task whose dependency
 * failed does not run at all, because building on a broken foundation produces
 * a second failure that hides the first.
 */

export interface ScheduleRequest<R> {
  tasks: Task[];
  /** How many may run at once. Two is plenty; ten is a bill, not a speed-up. */
  concurrency?: number;
  run(task: Task): Promise<R>;
  /** Told as the work happens, so a panel can follow along. */
  onEvent?: (event: SpecEvent) => void;
  succeeded(result: R): boolean;
  signal?: AbortSignal;
}

export interface ScheduleReport<R> {
  results: Map<string, R>;
  /** Never started, and why. */
  skipped: { id: string; reason: string }[];
}

export class CycleError extends Error {
  constructor(readonly ids: string[]) {
    super(`these tasks wait on each other: ${ids.join(", ")}`);
    this.name = "CycleError";
  }
}

export async function schedule<R>(request: ScheduleRequest<R>): Promise<ScheduleReport<R>> {
  const concurrency = Math.max(1, request.concurrency ?? 2);
  const byId = new Map(request.tasks.map((task) => [task.id, task]));

  const results = new Map<string, R>();
  const skipped: { id: string; reason: string }[] = [];
  const done = new Set<string>();
  const failed = new Set<string>();
  const started = new Set<string>();

  // Work already finished before this run is not work to do again.
  for (const task of request.tasks) {
    if (task.state === "done") done.add(task.id);
  }

  const ready = (): Task[] =>
    request.tasks.filter((task) => {
      if (started.has(task.id) || done.has(task.id) || failed.has(task.id)) return false;
      if (skipped.some((entry) => entry.id === task.id)) return false;
      return task.dependsOn.every((id) => done.has(id));
    });

  const doomed = (): Task[] =>
    request.tasks.filter((task) => {
      if (started.has(task.id) || done.has(task.id) || failed.has(task.id)) return false;
      if (skipped.some((entry) => entry.id === task.id)) return false;
      return task.dependsOn.some((id) => failed.has(id) || missing(id));
    });

  const missing = (id: string) => !byId.has(id);

  const running = new Map<string, Promise<void>>();

  const launch = (task: Task) => {
    started.add(task.id);
    request.onEvent?.({ t: "task.started", id: task.id });

    const job = (async () => {
      const result = await request.run(task);
      results.set(task.id, result);
      if (request.succeeded(result)) {
        done.add(task.id);
        request.onEvent?.({ t: "task.done", id: task.id });
      } else {
        failed.add(task.id);
        request.onEvent?.({ t: "task.failed", id: task.id });
      }
    })();

    running.set(task.id, job.finally(() => running.delete(task.id)));
  };

  while (true) {
    for (const task of doomed()) {
      const blame = task.dependsOn.filter((id) => failed.has(id) || missing(id));
      skipped.push({
        id: task.id,
        reason: missing(blame[0] ?? "")
          ? `waits on ${blame[0]}, which is not in the plan`
          : `${blame.join(", ")} did not succeed`,
      });
    }

    if (request.signal?.aborted) {
      // Stop admitting work, but do not return while builders are still writing.
      for (const task of request.tasks) {
        if (
          !started.has(task.id) &&
          !done.has(task.id) &&
          !failed.has(task.id) &&
          !skipped.some((entry) => entry.id === task.id)
        ) {
          skipped.push({ id: task.id, reason: "interrupted" });
        }
      }
      await Promise.allSettled(running.values());
      break;
    }

    while (running.size < concurrency) {
      const next = ready()[0];
      if (next === undefined) break;
      launch(next);
    }

    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  // Anything still waiting with nothing running is waiting on itself.
  const stuck = request.tasks.filter(
    (task) =>
      !done.has(task.id) &&
      !failed.has(task.id) &&
      !started.has(task.id) &&
      !skipped.some((entry) => entry.id === task.id),
  );
  if (stuck.length > 0) throw new CycleError(stuck.map((task) => task.id));

  return { results, skipped };
}
