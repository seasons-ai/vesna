import type { EditorState } from "./editor";
import type { Glyphs } from "./glyphs";
import type { Role } from "./theme";
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
  /**
   * Which message each transcript line can copy, parallel to `transcript`.
   * Carried through wrapping and scrolling so a click can find its message.
   */
  targets?: (string | undefined)[];
  /** Conversations to switch to. Asked for, so the first to go when space runs short. */
  left?: Pane;
  /** The state of the work in hand. */
  right?: Pane;
  /** An SGR establishing the input box's own background, or "" for none. */
  panel?: string;
  /**
   * The theme's own `paint`, passed in rather than imported.
   *
   * Vesna owns the canvas, so text that sets no foreground of its own inherits
   * whatever the user's terminal profile uses — near-black on a dark theme for
   * a reader on a light profile. Folding a foreground into the surface cannot
   * fix it: a painted run closes with SGR 39, which restores the terminal's
   * default rather than the line's opening colour. So the frame paints its own
   * text at source, through a callback that keeps this module pure.
   */
  paint: (role: Role, text: string) => string;
  glyphs: Glyphs;
  /** Shown, centred, only while the transcript is empty. */
  empty?: string[];
}

/** A column beside the conversation: painted lines and what a click means. */
export interface Pane {
  lines: string[];
  targets?: (string | undefined)[];
}

export interface Frame {
  lines: string[];
  /** Parallel to `lines`: the message a click in the conversation would copy. */
  targets: (string | undefined)[];
  /**
   * Where each column starts and ends, so a click is resolved by position
   * rather than by guessing. A row can carry a target in a panel and another
   * in the conversation at once; one array per row could not say which.
   */
  columns: { left: number; right: number };
  /** Parallel to `lines`, for clicks landing in the left panel. */
  leftTargets: (string | undefined)[];
  /** Parallel to `lines`, for clicks landing in the right panel. */
  rightTargets: (string | undefined)[];
  /** Parallel to `lines`; an entry overrides the canvas for that row. */
  surfaces?: (string | undefined)[];
  cursor: { row: number; col: number };
}

/** Past this the box would take over the screen. */
const MAX_INPUT_ROWS = 8;

/** Below these a panel is a sliver, and the conversation is what matters. */
const LEFT_MIN = 22;
const RIGHT_MIN = 24;
/** The conversation keeps at least this much, whatever was asked for. */
const CONVERSATION_MIN = 48;

/**
 * How wide each column may be.
 *
 * The left panel goes first when space runs short: it is opened on request and
 * closed again, while the right one shows the work in hand. Neither is worth
 * having at a width that cannot hold a filename.
 */
export function panelWidths(
  cols: number,
  wanted: { left: boolean; right: boolean },
): { left: number; right: number } {
  const share = (min: number) => Math.max(min, Math.min(40, Math.round(cols * 0.22)));

  let left = wanted.left ? share(LEFT_MIN) : 0;
  let right = wanted.right ? share(RIGHT_MIN) : 0;

  // Each panel costs its own width plus the rule beside it.
  const spent = () => left + right + (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0);

  if (cols - spent() < CONVERSATION_MIN) left = 0;
  if (cols - spent() < CONVERSATION_MIN) right = 0;

  return { left, right };
}

/** The prompt glyph plus the space that separates it from typed text. */
export function promptOf(glyphs: Glyphs): string {
  return `${glyphs.prompt} `;
}

export function layout(view: ViewState, size: { rows: number; cols: number }): Frame {
  const full = Math.max(1, size.cols);
  const rows = Math.max(1, size.rows);

  const widths = panelWidths(full, {
    left: view.left !== undefined,
    right: view.right !== undefined,
  });
  const rules = (widths.left > 0 ? 1 : 0) + (widths.right > 0 ? 1 : 0);
  // Everything below lays out the conversation, in the width left over.
  const cols = Math.max(1, full - widths.left - widths.right - rules);
  const prompt = promptOf(view.glyphs);
  const inner = Math.max(1, cols - prompt.length);

  const input = hardWrap(view.editor.text, inner);
  const overhead = 3; // header, separator, status
  // The box may grow, but never far enough to hide the conversation entirely.
  const inputRows = Math.max(1, Math.min(input.length, MAX_INPUT_ROWS, rows - overhead - 1));
  const transcriptRows = rows - overhead - inputRows;

  const lines: string[] = [];
  // One entry per frame row, filled in beside the row it belongs to.
  const targets: (string | undefined)[] = [];

  lines.push(fit(view.header, cols));
  targets.push(undefined);

  const wrapped: string[] = [];
  const wrappedTargets: (string | undefined)[] = [];
  for (const [index, line] of view.transcript.entries()) {
    const id = view.targets?.[index];
    for (const piece of wrapAnsi(line, cols)) {
      wrapped.push(piece);
      wrappedTargets.push(id);
    }
  }
  const hidden = Math.max(0, wrapped.length - Math.max(0, transcriptRows) - view.scroll);
  const body = Math.max(0, transcriptRows);
  if (wrapped.length === 0 && view.empty !== undefined && view.empty.length > 0) {
    const shown = view.empty.slice(0, body);
    const above = Math.max(0, Math.floor((body - shown.length) / 2));
    lines.push(
      ...Array<string>(above).fill(""),
      ...shown,
      ...Array<string>(Math.max(0, body - above - shown.length)).fill(""),
    );
    targets.push(...Array<string | undefined>(body).fill(undefined));
  } else {
    const window = windowOf(wrapped, wrappedTargets, body, view.scroll);
    lines.push(...window.lines);
    targets.push(...window.targets);
  }

  lines.push(view.paint("rule", view.glyphs.rule.repeat(cols)));
  targets.push(undefined);

  const shown = input.slice(0, inputRows);
  const inputFirstRow = lines.length;
  for (const [index, line] of shown.entries()) {
    const lead =
      index === 0 ? view.paint("petal", prompt) : " ".repeat(prompt.length);
    const typed = line === "" ? "" : view.paint("text", line);
    lines.push(fit(`${lead}${typed}`, cols));
    targets.push(undefined);
  }
  const inputLastRow = lines.length - 1;

  // Scrolled back, the newest text is off-screen: say so, or the user cannot
  // tell a paused conversation from a finished one.
  const hint = view.scroll > 0 && hidden > 0 ? `${hidden} more below` : view.hint;
  lines.push(statusLine(hint, view.status, cols));
  targets.push(undefined);

  const cursor = cursorAt(view.editor, inner, inputRows);
  const inputTop = 1 + Math.max(0, transcriptRows) + 1;

  const kept = lines.slice(0, rows);
  const panel = view.panel !== undefined && view.panel !== "" ? view.panel : undefined;

  const laid = kept.map((line) => pad(line, cols));

  // Composed at the end rather than woven through: the conversation's own
  // layout stays exactly what it was when it had the screen to itself.
  const rule = view.paint("rule", view.glyphs.gutter);
  const leftAt = (index: number) => pad(view.left?.lines[index] ?? "", widths.left);
  const rightAt = (index: number) => pad(view.right?.lines[index] ?? "", widths.right);

  const composed = laid.map((line, index) => {
    const before = widths.left > 0 ? `${leftAt(index)}${rule}` : "";
    const after = widths.right > 0 ? `${rule}${rightAt(index)}` : "";
    return `${before}${line}${after}`;
  });

  const conversationStart = widths.left > 0 ? widths.left + 1 : 0;

  return {
    // A window too small for the layout still gets exactly the rows it has,
    // and every one of them is exactly as wide as the window.
    lines: composed,
    targets: laid.map((_, index) => targets[index]),
    columns: { left: conversationStart, right: conversationStart + cols },
    leftTargets: laid.map((_, index) =>
      widths.left > 0 ? view.left?.targets?.[index] : undefined,
    ),
    rightTargets: laid.map((_, index) =>
      widths.right > 0 ? view.right?.targets?.[index] : undefined,
    ),
    // The input box is lifted off the canvas, so the eye finds where to type
    // without a border drawn around it.
    surfaces: laid.map((_, index) =>
      panel !== undefined && index >= inputFirstRow && index <= inputLastRow
        ? panel
        : undefined,
    ),
    cursor: {
      row: Math.min(inputTop + cursor.row, rows - 1),
      col: Math.min(conversationStart + prompt.length + cursor.col, full),
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
function windowOf(
  lines: string[],
  targets: (string | undefined)[],
  height: number,
  scroll: number,
): { lines: string[]; targets: (string | undefined)[] } {
  if (height <= 0) return { lines: [], targets: [] };
  const maxScroll = Math.max(0, lines.length - height);
  const end = lines.length - Math.min(scroll, maxScroll);
  const start = Math.max(0, end - height);
  const pad = height - (end - start);
  // Pad at the top so a short conversation rests on the input box. A padded
  // row belongs to no message, so a click there must do nothing.
  return {
    lines: [...Array<string>(pad).fill(""), ...lines.slice(start, end)],
    targets: [...Array<string | undefined>(pad).fill(undefined), ...targets.slice(start, end)],
  };
}

/**
 * Cost and usage are the half worth keeping: a narrow window trims the hint,
 * which the user already knows, rather than the number they are watching.
 */
function statusLine(hint: string, status: string, cols: number): string {
  const statusWidth = visibleWidth(status);
  if (statusWidth >= cols) return fit(status, cols);

  // One column short of the window leaves no room for a hint at all, only for
  // the single space that keeps the two halves apart.
  const room = cols - statusWidth - 1;
  const trimmed = room <= 0 ? "" : visibleWidth(hint) <= room ? hint : fit(hint, room);
  const gap = cols - visibleWidth(trimmed) - statusWidth;
  return `${trimmed}${" ".repeat(Math.max(1, gap))}${status}`;
}

/**
 * Truncate to the visible width, keeping escape codes out of the count.
 *
 * A width of zero or less means there is no room at all, and the answer is
 * nothing. `wrapAnsi` escapes early on a non-positive width and would hand
 * back the whole string, which is how the status line came to emit a row twice
 * as wide as the window.
 */
function fit(text: string, cols: number): string {
  if (cols <= 0) return "";
  if (visibleWidth(text) <= cols) return text;
  return wrapAnsi(text, cols)[0] ?? "";
}

/**
 * Owning the canvas means owning every cell. A line shorter than the window
 * lets the user's own background show through, and the frame looks torn rather
 * than designed.
 */
function pad(line: string, cols: number): string {
  const width = visibleWidth(line);
  return width >= cols ? line : line + " ".repeat(cols - width);
}
