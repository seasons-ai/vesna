/**
 * The state of a piece of work, derived from what happened.
 *
 * The panel does not read markdown and guess. It reduces a log of typed events,
 * which means the interface can be rebuilt after a crash, the reducer can be
 * tested without a terminal, and a claim in a chat message — "I finished T2" —
 * is never mistaken for the fact of it.
 */

export type Stage = "design" | "spec" | "plan" | "build" | "done";

/**
 * The five phases, in the order they happen. The earlier eight were a guess
 * made before the process was run for real: intent and research are the
 * design conversation, review and verify happen inside the build per task,
 * and crystal is gone with the feature.
 */
export const STAGES: readonly Stage[] = ["design", "spec", "plan", "build", "done"];

export type Shape = "spike" | "bounded" | "architectural";
const HEAVINESS: Record<Shape, number> = { spike: 0, bounded: 1, architectural: 2 };

export type Approvable = "spec" | "plan";
export type Severity = "critical" | "important" | "minor";

export interface Finding {
  severity: Severity;
  file: string;
  line?: number;
  text: string;
}

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
  | { t: "task.failed"; id: string; reason?: string }
  /** What shape of work this is. The agent says; a person may overrule. */
  | { t: "classified"; shape: Shape; by: "agent" | "person" }
  /** Written only by the /approve command, on a keystroke. No tool emits it. */
  | { t: "approved"; what: Approvable }
  | { t: "build.started" }
  | { t: "build.stopped"; reason: string }
  | { t: "build.done" }
  | { t: "review.done"; task: string; round: number; spec: "met" | "not_met"; findings: Finding[] }
  /** The reviewer never called review_verdict. That is its failure, not a pass. */
  | { t: "review.failed"; task: string; round: number; reason: string }
  /** Left open at the fix-round cap, on purpose and on the record. */
  | { t: "parked"; task: string; finding: Finding }
  /** A decision the loop made that the plan did not settle. */
  | { t: "ruling"; text: string; why: string };

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
  shape?: Shape;
  approved: { spec: boolean; plan: boolean };
  building: boolean;
  /** Build events that arrived before the plan was approved: ignored, and counted. */
  ignored: number;
  reviews: Record<string, { round: number; spec: "met" | "not_met"; open: Finding[] }>;
  parked: { task: string; finding: Finding }[];
  rulings: { text: string; why: string }[];
}

export function project(events: SpecEvent[]): SpecTree | null {
  const created = events.find((event) => event.t === "created");
  if (created === undefined) return null;

  const stageState = new Map<Stage, StageState>();
  const criteria = new Map<string, Criterion>();
  const tasks = new Map<string, Task>();
  const approved = { spec: false, plan: false };
  let building = false;
  let ignored = 0;
  let agentShape: Shape | undefined;
  let personShape: Shape | undefined;
  const reviews: SpecTree["reviews"] = {};
  const parked: SpecTree["parked"] = [];
  const rulings: SpecTree["rulings"] = [];

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

      case "classified":
        if (event.by === "person") personShape = event.shape;
        // Between the agent's own guesses the heavier stands: erring toward
        // ceremony costs time, erring away from it costs the review.
        else if (agentShape === undefined || HEAVINESS[event.shape] > HEAVINESS[agentShape]) {
          agentShape = event.shape;
        }
        break;

      case "approved":
        approved[event.what] = true;
        // Approving is what closes a phase: the spec is done when a person
        // says so, and the next phase opens on the same keystroke.
        stageState.set(event.what, "done");
        if (event.what === "spec") stageState.set("plan", "active");
        break;

      case "build.started":
        // The reducer is the second lock. The command refuses first, but a
        // log that could be made to show a build nobody approved would be a
        // log that lies, so the event is dropped and the drop is counted.
        if (!approved.plan) {
          ignored += 1;
          break;
        }
        building = true;
        stageState.set("plan", "done");
        stageState.set("build", "active");
        break;

      case "build.stopped":
        building = false;
        break;

      case "build.done":
        building = false;
        stageState.set("build", "done");
        stageState.set("done", "done");
        break;

      case "review.done":
        reviews[event.task] = {
          round: event.round,
          spec: event.spec,
          open: event.findings.filter((f) => f.severity !== "minor"),
        };
        break;

      case "review.failed":
        // Recorded on the task so the panel can say "review failed" rather
        // than leaving it looking like it is still running.
        reviews[event.task] = { round: event.round, spec: "not_met", open: [] };
        break;

      case "parked":
        parked.push({ task: event.task, finding: event.finding });
        break;

      case "ruling":
        rulings.push({ text: event.text, why: event.why });
        break;
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
    ...(personShape ?? agentShape ? { shape: personShape ?? agentShape } : {}),
    approved,
    building,
    ignored,
    reviews,
    parked,
    rulings,
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
