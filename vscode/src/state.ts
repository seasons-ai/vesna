/**
 * The panel's model: a pure reduction of the server's notifications and a
 * handful of host-only events into the one shape the webview draws.
 *
 * `state.ts` imports nothing but `./protocol` — the webview holds no
 * protocol state of its own, and this module holds no VS Code state either.
 */
import type { Ask, Notification, NoticeLevel, State, TraceStep, TranscriptEntry } from "./protocol";

export type Entry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; open: boolean }
  | { id: number; kind: "step"; step: TraceStep; detail: string | undefined }
  | { id: number; kind: "notice"; text: string; level: NoticeLevel };

export type ServerStatus =
  | { kind: "starting" }
  | { kind: "up" }
  | { kind: "notFound"; command: string }
  | { kind: "exited"; code: number | null; stderr: string }
  | { kind: "tooOld"; server: string; extension: string }
  | { kind: "noFolder" };

export interface PanelModel {
  entries: Entry[];
  ask: Ask | null;
  state: State | null;
  server: ServerStatus;
  queued: number;
  note: string | null;
  /** Where the next entry's id comes from — kept on the model so ids stay stable across reductions. */
  nextId: number;
}

export type Event =
  | { kind: "notification"; n: Notification }
  | { kind: "server"; status: ServerStatus }
  | { kind: "sent" }
  | { kind: "turnStarted" }
  | { kind: "note"; text: string | null };

export function initialModel(): PanelModel {
  return { entries: [], ask: null, state: null, server: { kind: "starting" }, queued: 0, note: null, nextId: 1 };
}

/**
 * The TUI's rule for the one field worth showing next to a step, copied
 * exactly from `src/loop/trace.ts` `detailOf`: `path`/`pattern`/`command`/
 * `name`/`detail`, whichever is the first non-empty string, capped at 48
 * characters (45 kept plus `...`).
 */
export function detailOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const field of ["path", "pattern", "command", "name", "detail"]) {
    const value = record[field];
    if (typeof value === "string" && value !== "") {
      return value.length > 48 ? `${value.slice(0, 45)}...` : value;
    }
  }
  return undefined;
}

export function reduce(model: PanelModel, event: Event): PanelModel {
  switch (event.kind) {
    case "notification":
      return reduceNotification(model, event.n);
    case "server":
      // `notFound`/`exited`/`tooOld` keep `entries` and `state` (a person can
      // still read what happened); `starting`/`up` keep everything too;
      // `noFolder` is only ever the initial status. None of that needs a
      // special case — a `server` event only ever replaces `server`.
      return { ...model, server: event.status };
    case "sent":
      // While the core is busy the turn is queued; otherwise it starts at
      // once and nothing is queued.
      return model.state?.busy === true ? { ...model, queued: model.queued + 1 } : { ...model };
    case "turnStarted":
      // One queued turn has now started running. `sent` is the only other
      // writer of `queued`, and a `state` notification with `busy: false`
      // is the hard reset, so this only ever nudges the count down.
      return { ...model, queued: Math.max(0, model.queued - 1) };
    case "note":
      return { ...model, note: event.text };
  }
}

function reduceNotification(model: PanelModel, n: Notification): PanelModel {
  switch (n.method) {
    case "transcript":
      return reduceTranscript(model, n.params);
    case "state":
      return { ...model, state: n.params, queued: n.params.busy === false ? 0 : model.queued };
    case "ask":
      return { ...model, ask: n.params };
    case "ask.resolved":
      // A non-matching id leaves the ask untouched.
      return model.ask !== null && model.ask.id === n.params.id ? { ...model, ask: null } : { ...model };
  }
}

function reduceTranscript(model: PanelModel, entry: TranscriptEntry): PanelModel {
  switch (entry.kind) {
    case "user":
      return appendEntry(model, (id) => ({ id, kind: "user", text: entry.text }));
    case "delta": {
      const last = model.entries[model.entries.length - 1];
      if (last !== undefined && last.kind === "assistant" && last.open) {
        const updated: Entry = { ...last, text: last.text + entry.text };
        return { ...model, entries: [...model.entries.slice(0, -1), updated] };
      }
      return appendEntry(model, (id) => ({ id, kind: "assistant", text: entry.text, open: true }));
    }
    case "step":
      return appendEntry(model, (id) => ({ id, kind: "step", step: entry.step, detail: detailOf(entry.step.input) }));
    case "notice":
      return appendEntry(model, (id) => ({ id, kind: "notice", text: entry.text, level: entry.level }));
    case "turn-end": {
      const last = model.entries[model.entries.length - 1];
      if (last !== undefined && last.kind === "assistant" && last.open) {
        const updated: Entry = { ...last, open: false };
        return { ...model, entries: [...model.entries.slice(0, -1), updated] };
      }
      return { ...model };
    }
    case "clear":
      // Empties `entries` only — an open ask stays until it is resolved.
      return { ...model, entries: [] };
  }
}

function appendEntry(model: PanelModel, make: (id: number) => Entry): PanelModel {
  return { ...model, entries: [...model.entries, make(model.nextId)], nextId: model.nextId + 1 };
}

/**
 * The one place the host keeps the model: every event goes through
 * `reduce`, and every subscriber hears about every reduction (the panel
 * posts the model, the status bar redraws). No `vscode` here either.
 */
export interface Store {
  readonly model: PanelModel;
  dispatch(event: Event): void;
  subscribe(listener: (model: PanelModel) => void): () => void;
}

export function createStore(model: PanelModel = initialModel()): Store {
  let current = model;
  const listeners = new Set<(model: PanelModel) => void>();
  return {
    get model() {
      return current;
    },
    dispatch(event) {
      current = reduce(current, event);
      for (const listener of listeners) listener(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
