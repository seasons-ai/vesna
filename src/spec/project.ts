/**
 * The state of a piece of work, derived from what happened.
 *
 * The panel does not read markdown and guess. It reduces a log of typed events,
 * which means the interface can be rebuilt after a crash, the reducer can be
 * tested without a terminal, and a claim in a chat message — "I finished T2" —
 * is never mistaken for the fact of it.
 */

export type Stage =
  | "intent"
  | "research"
  | "spec"
  | "plan"
  | "build"
  | "review"
  | "verify"
  | "crystal";

export const STAGES: readonly Stage[] = [
  "intent",
  "research",
  "spec",
  "plan",
  "build",
  "review",
  "verify",
  "crystal",
];

export type SpecEvent =
  | { t: "created"; id: string; title: string }
  | { t: "stage.entered"; stage: Stage }
  | { t: "stage.done"; stage: Stage }
  | { t: "criterion.added"; id: string; text: string }
  /** Met is not the same as claimed: evidence is what a verifier produced. */
  | { t: "criterion.met"; id: string; evidence: string }
  | { t: "task.added"; id: string; title: string; dependsOn?: string[] }
  | { t: "task.started"; id: string; agent?: string }
  | { t: "task.done"; id: string; commit?: string }
  | { t: "task.failed"; id: string; reason?: string };

export type StageState = "todo" | "active" | "done";
export type TaskState = "todo" | "blocked" | "running" | "done" | "failed";

export interface Criterion {
  id: string;
  text: string;
  evidence?: string;
}

export interface Task {
  id: string;
  title: string;
  state: TaskState;
  dependsOn: string[];
  agent?: string;
  commit?: string;
  reason?: string;
}

export interface SpecTree {
  id: string;
  title: string;
  stages: { stage: Stage; state: StageState }[];
  criteria: Criterion[];
  tasks: Task[];
  /** Tasks finished against tasks known, for the header line. */
  progress: { done: number; total: number };
}

export function project(events: SpecEvent[]): SpecTree | null {
  const created = events.find((event) => event.t === "created");
  if (created === undefined) return null;

  const stageState = new Map<Stage, StageState>();
  const criteria = new Map<string, Criterion>();
  const tasks = new Map<string, Task>();

  for (const event of events) {
    switch (event.t) {
      case "created":
        break;

      case "stage.entered":
        // Re-entering a finished stage is normal: a review sends work back.
        stageState.set(event.stage, "active");
        break;

      case "stage.done":
        stageState.set(event.stage, "done");
        break;

      case "criterion.added":
        criteria.set(event.id, { id: event.id, text: event.text });
        break;

      case "criterion.met": {
        const existing = criteria.get(event.id);
        // Evidence for a criterion nobody declared is still worth showing:
        // losing it would hide the very thing that was proved.
        criteria.set(event.id, {
          id: event.id,
          text: existing?.text ?? event.id,
          evidence: event.evidence,
        });
        break;
      }

      case "task.added":
        tasks.set(event.id, {
          id: event.id,
          title: event.title,
          state: "todo",
          dependsOn: event.dependsOn ?? [],
        });
        break;

      case "task.started": {
        const task = tasks.get(event.id);
        if (task === undefined) break;
        tasks.set(event.id, {
          ...task,
          state: "running",
          ...(event.agent ? { agent: event.agent } : {}),
        });
        break;
      }

      case "task.done": {
        const task = tasks.get(event.id);
        if (task === undefined) break;
        const { agent: _agent, ...rest } = task;
        tasks.set(event.id, {
          ...rest,
          state: "done",
          ...(event.commit ? { commit: event.commit } : {}),
        });
        break;
      }

      case "task.failed": {
        const task = tasks.get(event.id);
        if (task === undefined) break;
        const { agent: _agent, ...rest } = task;
        tasks.set(event.id, {
          ...rest,
          state: "failed",
          ...(event.reason ? { reason: event.reason } : {}),
        });
        break;
      }
    }
  }

  const all = [...tasks.values()].map((task) => blockedIfWaiting(task, tasks));

  return {
    id: created.id,
    title: created.title,
    stages: STAGES.map((stage) => ({ stage, state: stageState.get(stage) ?? "todo" })),
    criteria: [...criteria.values()],
    tasks: all,
    progress: { done: all.filter((task) => task.state === "done").length, total: all.length },
  };
}

/**
 * A task waiting on unfinished work is not merely "not started": showing it as
 * blocked is what tells the reader nothing is stuck, it is simply waiting.
 */
function blockedIfWaiting(task: Task, tasks: Map<string, Task>): Task {
  if (task.state !== "todo") return task;
  const waiting = task.dependsOn.some((id) => tasks.get(id)?.state !== "done");
  return waiting && task.dependsOn.length > 0 ? { ...task, state: "blocked" } : task;
}
