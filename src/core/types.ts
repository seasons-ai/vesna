import type { TraceStep } from "../loop/trace";
import type { SpecTree } from "../spec/project";
import type { SessionSummary } from "../store/sessions";
import type { Mode } from "../policy/decide";
import type { BuildState } from "../sdd/recover";

/** How a client styles a notice line: ok/warn/muted/error, nothing more. */
export type NoticeLevel = "ok" | "warn" | "muted" | "error";

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
export interface Ask { id: string; kind: AskKind; lines: string[]; choices: AskChoice[]; strict: boolean }

/** The status a client renders in its header/statusline. */
export interface State {
  mode: Mode; busy: boolean; building: boolean; buildState: BuildState;
  model: string; service: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  spec: SpecTree | null; specSlug: string | null; chats: SessionSummary[] | null;
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

/** The agent minus the screen: a client drives it and renders its notifications. */
export interface Core {
  send(text: string): Promise<void>;
  /** `typed` is the line as the person typed it, quoted back; a key-driven command has none. */
  command(name: string, argument: string, options?: { typed?: string }): Promise<void>;
  answer(id: string, value: string): boolean;   // false when no such ask is open
  interrupt(): void;
  snapshot(): State;
  on(listener: (n: Notification) => void): () => void;
  close(): Promise<void>;
}
