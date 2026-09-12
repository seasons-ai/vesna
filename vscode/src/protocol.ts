/**
 * The shapes `vesna serve` speaks over JSON-RPC on stdio, copied here as
 * types only. Keep these in lockstep with `src/core/types.ts`,
 * `src/spec/project.ts` and `src/store/sessions.ts` in the root package —
 * this file has no runtime dependency on that package, so nothing enforces
 * the match but a person reading both.
 */

/** How a client styles a notice line: ok/warn/muted/error, nothing more. */
export type NoticeLevel = "ok" | "warn" | "muted" | "error";

export interface TraceStep {
  id: string;
  nodeType: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
}

/** One line a client appends to (or clears from) the transcript it renders. */
export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "step"; step: TraceStep }
  | { kind: "notice"; text: string; level: NoticeLevel }
  | { kind: "turn-end" }
  | { kind: "clear" };

/** Whether an ask is a one-off permission check or a plan/build approval. */
export type AskKind = "permission" | "approval";

/** The choices a client can answer an ask with: yes, always, or no. */
export type AskChoice = "y" | "a" | "n";

/**
 * A question a client shows the user and answers back via `Core.answer`.
 * A permission ask always offers `a`; when its second line shows no `[a]`
 * there is nothing to make a rule from, and `a` means allow once.
 */
export interface Ask {
  id: string;
  kind: AskKind;
  lines: string[];
  choices: AskChoice[];
  strict: boolean;
}

export type Mode = "plan" | "ask" | "auto";
export type BuildState = "running" | "dead" | "idle";

export type Shape = "spike" | "bounded" | "architectural";
export type Approvable = "spec" | "plan";
export type Severity = "critical" | "important" | "minor";

export interface Finding {
  severity: Severity;
  file: string;
  line?: number;
  text: string;
}

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

export type Stage = "design" | "spec" | "plan" | "build" | "done";

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
  /** The commit the current build range started from, until `build.done` closes it. */
  buildBase?: string;
  /** A `build.done` has been reduced and no `build.started` has been reduced since. */
  finished: boolean;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  model: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  messages: number;
  costUsd: number;
}

/** The status a client renders in its header/statusline. */
export interface State {
  mode: Mode;
  busy: boolean;
  building: boolean;
  buildState: BuildState;
  model: string;
  service: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  spec: SpecTree | null;
  specSlug: string | null;
  chats: SessionSummary[] | null;
  /** The id of the conversation being recorded, so a list can mark it; null when nothing records it. */
  chatId: string | null;
  /** The folder the conversation is about — the heading of a conversations column. */
  root: string;
}

/** What a client subscribes to via `Core.on` to stay in sync with the core. */
export type Notification =
  | { method: "transcript"; params: TranscriptEntry }
  | { method: "state"; params: State }
  | { method: "ask"; params: Ask }
  | { method: "ask.resolved"; params: { id: string } };

export interface InitializeResult {
  serverVersion: string;
  capabilities: Record<string, number>;
  state: State;
}

export const REQUIRED_CAPABILITIES = { transcript: 1, state: 1, ask: 1 } as const;
