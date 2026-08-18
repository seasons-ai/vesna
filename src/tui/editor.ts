import type { Key } from "./keys";

/**
 * The input box as a value. Every key is a pure state transition, so the whole
 * editor is testable without a terminal, and the renderer only ever draws a
 * snapshot.
 */
export interface EditorState {
  text: string;
  /** Character offset into `text`; may sit past a newline. */
  cursor: number;
  history: string[];
  /** How far back through the history we have walked; 0 means "not walking". */
  historyDepth: number;
  /** What was being typed before the history walk started. */
  draft: string;
}

export function createEditor(history: string[] = []): EditorState {
  return { text: "", cursor: 0, history, historyDepth: 0, draft: "" };
}

export interface Applied {
  state: EditorState;
  /** Set only when the key completed a message. */
  submit?: string;
}

export function applyKey(state: EditorState, key: Key): Applied {
  switch (key.type) {
    case "text":
      return { state: insert(state, key.text) };
    case "paste":
      // Newlines in a paste are content, never a send.
      return { state: insert(state, key.text) };
    case "newline":
      return { state: insert(state, "\n") };
    case "enter":
      return submit(state);
    case "backspace":
      return { state: deleteRange(state, Math.max(0, state.cursor - 1), state.cursor) };
    case "delete":
      return { state: deleteRange(state, state.cursor, Math.min(state.text.length, state.cursor + 1)) };
    case "left":
      return { state: moveTo(state, Math.max(0, state.cursor - 1)) };
    case "right":
      return { state: moveTo(state, Math.min(state.text.length, state.cursor + 1)) };
    case "word-left":
      return { state: moveTo(state, wordLeft(state.text, state.cursor)) };
    case "word-right":
      return { state: moveTo(state, wordRight(state.text, state.cursor)) };
    case "home":
      return { state: moveTo(state, lineStart(state.text, state.cursor)) };
    case "end":
      return { state: moveTo(state, lineEnd(state.text, state.cursor)) };
    case "kill-line":
      return { state: deleteRange(state, lineStart(state.text, state.cursor), state.cursor) };
    case "kill-to-end":
      return { state: deleteRange(state, state.cursor, lineEnd(state.text, state.cursor)) };
    case "kill-word":
      return { state: deleteRange(state, wordLeft(state.text, state.cursor), state.cursor) };
    case "up":
      return { state: verticalMove(state, -1) };
    case "down":
      return { state: verticalMove(state, 1) };
    default:
      return { state };
  }
}

function insert(state: EditorState, text: string): EditorState {
  return {
    ...state,
    text: state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor),
    cursor: state.cursor + text.length,
  };
}

function deleteRange(state: EditorState, from: number, to: number): EditorState {
  if (from >= to) return state;
  return { ...state, text: state.text.slice(0, from) + state.text.slice(to), cursor: from };
}

function moveTo(state: EditorState, cursor: number): EditorState {
  return { ...state, cursor };
}

function submit(state: EditorState): Applied {
  const message = state.text.trim();
  if (message === "") return { state };

  // Repeating the last line adds nothing worth scrolling past.
  const history =
    state.history[state.history.length - 1] === message
      ? state.history
      : [...state.history, message];

  return { submit: message, state: { ...createEditor(history) } };
}

function lineStart(text: string, cursor: number): number {
  return text.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
  const index = text.indexOf("\n", cursor);
  return index === -1 ? text.length : index;
}

const WORD = /[\p{L}\p{N}_]/u;

function wordLeft(text: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && !WORD.test(text[index - 1]!)) index -= 1;
  while (index > 0 && WORD.test(text[index - 1]!)) index -= 1;
  return index;
}

function wordRight(text: string, cursor: number): number {
  let index = cursor;
  while (index < text.length && !WORD.test(text[index]!)) index += 1;
  while (index < text.length && WORD.test(text[index]!)) index += 1;
  return index;
}

/**
 * A single-line box has nowhere to go vertically, so the arrows browse the
 * history instead. Once the message has more than one line they mean what they
 * say and move the cursor.
 */
function verticalMove(state: EditorState, direction: -1 | 1): EditorState {
  if (state.text.includes("\n")) return moveByLine(state, direction);
  return browseHistory(state, direction);
}

function moveByLine(state: EditorState, direction: -1 | 1): EditorState {
  const start = lineStart(state.text, state.cursor);
  const column = state.cursor - start;

  if (direction === -1) {
    if (start === 0) return state;
    const previousStart = lineStart(state.text, start - 1);
    const previousEnd = start - 1;
    return moveTo(state, Math.min(previousStart + column, previousEnd));
  }

  const end = lineEnd(state.text, state.cursor);
  if (end === state.text.length) return state;
  const nextStart = end + 1;
  return moveTo(state, Math.min(nextStart + column, lineEnd(state.text, nextStart)));
}

function browseHistory(state: EditorState, direction: -1 | 1): EditorState {
  const depth = state.historyDepth - direction; // up goes further back
  if (depth < 0) return state;
  if (depth > state.history.length) return state;

  // Stepping off the live text keeps it, so coming back down restores it.
  const draft = state.historyDepth === 0 ? state.text : state.draft;
  const text = depth === 0 ? draft : state.history[state.history.length - depth]!;

  return { ...state, text, cursor: text.length, historyDepth: depth, draft };
}
