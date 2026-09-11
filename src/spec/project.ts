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
  /** The last review per task. `no_verdict`: the reviewer never called review_verdict. */
  reviews: Record<string, { round: number; spec: "met" | "not_met" | "no_verdict"; open: Finding[] }>;
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
        // The approval was of the plan as it stood. A plan with a task the
        // person never read is a different plan, and /build must not run
        // it on the strength of the old approval.
        if (approved.plan) {
          approved.plan = false;
          stageState.set("plan", "active");
        }
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
        // Approving the spec's output is what closes the design conversation
        // that produced it — nothing else ever marks design done, and a
        // finished project left showing an open first stage is a lie.
        if (event.what === "spec") {
          stageState.set("design", "done");
          stageState.set("plan", "active");
        }
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
        // Recorded on the task so the panel can say "no verdict" rather
        // than leaving it looking like it is still running — and not as
        // "not met", which is a verdict the reviewer never gave.
        reviews[event.task] = { round: event.round, spec: "no_verdict", open: [] };
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
 * The phase to tell the model it is in, derived from facts the tree already
 * carries rather than by scanning stage states for the furthest "active" one.
 *
 * A scan over stage state breaks on two real traces: nothing ever marks
 * `design` done, so a fully finished spec falls through to "design" once
 * `build` and `done` are both `done` and nothing is left `active`; and after
 * `build.stopped`, `build` is left `active` forever even though nothing is
 * running. Reading `building`, `approved.plan` and `approved.spec` directly
 * cannot go stale the same way, because those are exactly the facts a stage
 * scan was trying to reconstruct.
 *
 * An approved plan with no build running — never started, or stopped — is
 * still the plan phase: `/build` is what runs it, and after a stop a person
 * decides next, not the loop.
 *
 * Whether spec.md has been written is not in the log — the file is the
 * fact — so the caller says. A written, unapproved spec is the spec phase:
 * the one prompt that names the file and says to stop and ask the person to
 * read it. Without that fact the phase would go straight from design to
 * plan and that prompt could never appear.
 */
export function activeStage(tree: SpecTree, facts: { specWritten: boolean } = { specWritten: false }): Stage {
  if (tree.stages.find((s) => s.stage === "done")?.state === "done") return "done";
  if (tree.building) return "build";
  if (tree.approved.plan) return "plan"; // approved; /build pending, or stopped
  if (tree.approved.spec) return "plan";
  if (facts.specWritten) return "spec";
  return "design";
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
