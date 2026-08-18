import type { EditorState } from "./editor";
import { visibleWidth, wrapAnsi } from "./wrap";

/**
 * The whole screen as a pure function of state and size.
 *
 * Nothing here touches a terminal, so every rule about what the user sees —
 * where the cursor lands, what a small window does, whether the input box can
 * swallow the conversation — is an assertion rather than a thing to eyeball.
 */

export interface ViewState {
  header: string;
  /** Conversation lines, painted but unwrapped. */
  transcript: string[];
  editor: EditorState;
  /** Left half of the status line. */
  hint: string;
  /** Right half of the status line. */
  status: string;
  /** Lines scrolled back from the bottom of the conversation. */
  scroll: number;
}

export interface Frame {
  lines: string[];
  cursor: { row: number; col: number };
}

export const PROMPT = "› ";
/** Past this the box would take over the screen. */
const MAX_INPUT_ROWS = 8;

export function layout(view: ViewState, size: { rows: number; cols: number }): Frame {
  const cols = Math.max(1, size.cols);
  const rows = Math.max(1, size.rows);
  const inner = Math.max(1, cols - PROMPT.length);

  const input = hardWrap(view.editor.text, inner);
  const overhead = 3; // header, separator, status
  // The box may grow, but never far enough to hide the conversation entirely.
  const inputRows = Math.max(1, Math.min(input.length, MAX_INPUT_ROWS, rows - overhead - 1));
  const transcriptRows = rows - overhead - inputRows;

  const lines: string[] = [];
  lines.push(fit(view.header, cols));

  const wrapped = view.transcript.flatMap((line) => wrapAnsi(line, cols));
  lines.push(...windowOf(wrapped, Math.max(0, transcriptRows), view.scroll));

  lines.push("─".repeat(cols));

  const shown = input.slice(0, inputRows);
  for (const [index, line] of shown.entries()) {
    lines.push(fit(`${index === 0 ? PROMPT : " ".repeat(PROMPT.length)}${line}`, cols));
  }

  lines.push(statusLine(view.hint, view.status, cols));

  const cursor = cursorAt(view.editor, inner, inputRows);
  const inputTop = 1 + Math.max(0, transcriptRows) + 1;

  return {
    // A window too small for the layout still gets exactly the rows it has.
    lines: lines.slice(0, rows),
    cursor: {
      row: Math.min(inputTop + cursor.row, rows - 1),
      col: Math.min(PROMPT.length + cursor.col, cols),
    },
  };
}

/**
 * The input box wraps by character rather than by word: the cursor has to land
 * exactly where the user expects, and word wrap moves text around as you type.
 */
function hardWrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      out.push("");
      continue;
    }
    for (let index = 0; index < line.length; index += width) {
      out.push(line.slice(index, index + width));
    }
  }
  return out;
}

function cursorAt(editor: EditorState, width: number, inputRows: number): { row: number; col: number } {
  const before = editor.text.slice(0, editor.cursor);
  let row = 0;
  let col = 0;
  for (const char of before) {
    if (char === "\n") {
      row += 1;
      col = 0;
      continue;
    }
    col += 1;
    if (col === width) {
      row += 1;
      col = 0;
    }
  }
  // Once the text is taller than the box, the cursor rides its last row.
  return { row: Math.min(row, inputRows - 1), col };
}

/** The tail of the conversation, or an earlier window when scrolled back. */
function windowOf(lines: string[], height: number, scroll: number): string[] {
  if (height <= 0) return [];
  const maxScroll = Math.max(0, lines.length - height);
  const end = lines.length - Math.min(scroll, maxScroll);
  const start = Math.max(0, end - height);
  const window = lines.slice(start, end);
  // Pad at the top so a short conversation rests on the input box.
  return [...Array<string>(height - window.length).fill(""), ...window];
}

function statusLine(hint: string, status: string, cols: number): string {
  const gap = cols - visibleWidth(hint) - visibleWidth(status);
  if (gap < 1) return fit(hint, cols);
  return `${hint}${" ".repeat(gap)}${status}`;
}

/** Truncate to the visible width, keeping escape codes out of the count. */
function fit(text: string, cols: number): string {
  if (visibleWidth(text) <= cols) return text;
  return wrapAnsi(text, cols)[0] ?? "";
}
