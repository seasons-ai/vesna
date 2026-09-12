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
export type RecoveryAction = "resume" | "retry" | "abort";
export type Severity = "critical" | "important" | "minor";
export type VerifyStage = "review" | "merge";

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
  /**
   * Written only by the /approve command, on a keystroke. No tool emits it.
   * `digest` is the sha256 of the text the person read, when the command
   * could compute one — an old log without it just keeps the last digest
   * on record rather than clearing it.
   */
  | { t: "approved"; what: Approvable; digest?: string }
  | { t: "build.started" }
  | { t: "build.stopped"; reason: string }
  /**
   * A person's answer to a build a killed process left behind. Written by
   * the command, never by a tool. Resume keeps the in-flight task where it
   * is; retry and abort send it back to todo — unless a `task.done` for it
   * came first, because git already held the merge — and abort is followed
   * by a `build.stopped "abandoned"`.
   */
  | { t: "build.recovered"; action: RecoveryAction; task?: string }
  | { t: "build.done" }
  | { t: "review.done"; task: string; round: number; spec: "met" | "not_met"; findings: Finding[] }
  /** The reviewer never called review_verdict. That is its failure, not a pass. */
  | { t: "review.failed"; task: string; round: number; reason: string }
  /** Left open at the fix-round cap, on purpose and on the record. */
  | { t: "parked"; task: string; finding: Finding }
  /** A decision the loop made that the plan did not settle. */
  | { t: "ruling"; text: string; why: string }
  /** Vesna committed to running the task's `verify:` command. */
  | { t: "verify.declared"; task: string }
  /** The command ran to completion — `code` may still be non-zero. */
  | { t: "verify.done"; task: string; stage: VerifyStage; code: number; ms: number }
  /** The command could not even be run to completion. */
  | { t: "verify.failed"; task: string; stage: VerifyStage; code: number | null; reason?: string };

export type StageState = "todo" | "active" | "done";
export type TaskState = "todo" | "blocked" | "running" | "done" | "failed";

export interface Criterion {
  id: string;
  text: string;
  evidence?: string;
}

/**
 * Who produced the proof that a task is actually finished, kept apart so a
 * claim in a report is never mistaken for a check that ran.
 *
 * `vesna` is `null` until the task declares a `verify:` command, `false`
 * once it is declared but has not yet passed at merge, and `true` only once
 * a `verify.done` for the "merge" stage comes back with `code: 0`.
 */
export interface Evidence {
  worker: boolean;
  reviewer: boolean;
  vesna: boolean | null;
}

export interface Task {
  id: string;
  title: string;
  state: TaskState;
  dependsOn: string[];
  agent?: string;
  commit?: string;
  reason?: string;
  evidence: Evidence;
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
  /** The sha256 of the text last approved, per artefact — from the last `approved` that carried one. */
  digests: { spec?: string; plan?: string };
  building: boolean;
  /** Build events that arrived before the plan was approved: ignored, and counted. */
  ignored: number;
  /** The last review per task. `no_verdict`: the reviewer never called review_verdict. */
  reviews: Record<string, { round: number; spec: "met" | "not_met" | "no_verdict"; open: Finding[] }>;
  parked: { task: string; finding: Finding }[];
  rulings: { text: string; why: string }[];
  /** Why the last build stopped, until the next one starts. */
  lastStop?: string;
}

export function project(events: SpecEvent[]): SpecTree | null {
  const created = events.find((event) => event.t === "created");
  if (created === undefined) return null;

  const stageState = new Map<Stage, StageState>();
  const criteria = new Map<string, Criterion>();
  const tasks = new Map<string, Task>();
  const evidence = new Map<string, Evidence>();
  const approved = { spec: false, plan: false };
  const digests: SpecTree["digests"] = {};
  let building = false;
  let ignored = 0;
  let agentShape: Shape | undefined;
  let personShape: Shape | undefined;
  const reviews: SpecTree["reviews"] = {};
  const parked: SpecTree["parked"] = [];
  const rulings: SpecTree["rulings"] = [];
  let lastStop: string | undefined;

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
          evidence: { worker: false, reviewer: false, vesna: null },
        });
        evidence.set(event.id, { worker: false, reviewer: false, vesna: null });
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
        // Working on a task is building, whether /build started it or the
        // agent picked it up in the conversation. A running task under a
        // stage marked "to do" is the panel contradicting itself. Design is
        // over once work starts; spec and plan are left as they are — for a
        // bounded change they were skipped, and the panel should say so.
        stageState.set("build", "active");
        if (stageState.get("design") === "active") stageState.set("design", "done");
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
        const e = evidence.get(event.id);
        if (e !== undefined) evidence.set(event.id, { ...e, worker: true });
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
        if (event.digest !== undefined) digests[event.what] = event.digest;
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
        lastStop = undefined;
        stageState.set("plan", "done");
        stageState.set("build", "active");
        break;

      case "build.stopped":
        building = false;
        lastStop = event.reason;
        break;

      case "build.recovered": {
        if (event.action === "resume") break;
        // retry names its task; abort means whichever task is running.
        const id = event.task ?? [...tasks.values()].find((t) => t.state === "running")?.id;
        if (id === undefined) break;
        const task = tasks.get(id);
        if (task === undefined) break;
        // A merged task is never sent back to todo. The loop refuses to
        // retry one; and a kill that landed after the merge and before
        // `task.done` is recovered by writing that `task.done` first, from
        // what git holds, and only then the recovery — which then has
        // nothing to undo.
        if (task.state === "done") break;
        const { agent: _agent, ...rest } = task;
        tasks.set(id, { ...rest, state: "todo" });
        const e = evidence.get(id);
        if (e !== undefined) {
          evidence.set(id, { worker: false, reviewer: false, vesna: e.vesna === null ? null : false });
        }
        break;
      }

      case "build.done":
        building = false;
        lastStop = undefined;
        stageState.set("build", "done");
        stageState.set("done", "done");
        break;

      case "review.done": {
        reviews[event.task] = {
          round: event.round,
          spec: event.spec,
          open: event.findings.filter((f) => f.severity !== "minor"),
        };
        const e = evidence.get(event.task);
        if (e !== undefined && event.spec === "met") evidence.set(event.task, { ...e, reviewer: true });
        break;
      }

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

      case "verify.declared": {
        const e = evidence.get(event.task);
        if (e !== undefined && e.vesna === null) evidence.set(event.task, { ...e, vesna: false });
        break;
      }

      case "verify.done": {
        const e = evidence.get(event.task);
        if (e !== undefined && event.stage === "merge" && event.code === 0) {
          evidence.set(event.task, { ...e, vesna: true });
        }
        break;
      }

      case "verify.failed":
        // Recorded for the garden and the tests; it does not change evidence.
        break;
    }
  }

  const all = [...tasks.values()]
    .map((task) => blockedIfWaiting(task, tasks))
    .map((task) => ({
      ...task,
      evidence: evidence.get(task.id) ?? { worker: false, reviewer: false, vesna: null },
    }));

  return {
    id: created.id,
    title: created.title,
    stages: STAGES.map((stage) => ({ stage, state: stageState.get(stage) ?? "todo" })),
    criteria: [...criteria.values()],
    tasks: all,
    progress: { done: all.filter((task) => task.state === "done").length, total: all.length },
    ...(personShape ?? agentShape ? { shape: personShape ?? agentShape } : {}),
    approved,
    digests,
    building,
    ignored,
    reviews,
    parked,
    rulings,
    ...(lastStop !== undefined ? { lastStop } : {}),
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
