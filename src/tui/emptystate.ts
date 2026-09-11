import type { Glyphs } from "./glyphs";
import type { Theme } from "./theme";
import { visibleWidth } from "./wrap";

/**
 * What is on screen before the first message.
 *
 * An empty state, not a notice: a notice stays in the history and clutters the
 * rest of the session, while this exists only while there is nothing to show
 * and disappears the moment the user says something.
 */

const TAGLINE = "spring, and what comes back";
const WORDMARK = "v e s n a";
const WORDMARK_PLAIN = "vesna";

const EXAMPLES: [string, string][] = [
  ["ask for something", "read src/*.ts and find the dead code"],
  ["plan a piece of work", "/spec new reliable cancellation"],
  ["pick what answers", "/provider"],
  ["see where you are", "ctrl-g"],
];

/**
 * A panel nobody knows how to open may as well not exist. The conversations
 * column was built, documented and never found, because the only mention of
 * it was one line among nine in /help.
 */
const keysLine = (glyphs: Glyphs) =>
  ["ctrl-b conversations", "ctrl-g the plan", "/help everything else"].join(
    ` ${glyphs.bullet} `,
  );

/** Below these the examples do not fit without wrapping into nonsense. */
const EXAMPLES_MIN_COLS = 62;
const EXAMPLES_MIN_ROWS = 9;

/** A little air around the tagline, so it never rides right up against the edge. */
const TAGLINE_MARGIN = 2;

export function emptyState(options: {
  theme: Theme;
  glyphs: Glyphs;
  cols: number;
  rows: number;
}): string[] {
  const { theme, glyphs, cols, rows } = options;
  const centre = (text: string) => {
    const pad = Math.max(0, Math.floor((cols - visibleWidth(text)) / 2));
    return " ".repeat(pad) + text;
  };

  // Content sheds in order of importance rather than being truncated: a
  // missing line reads as spare, a line cut mid-word reads as broken. Every
  // guard below compares visible width (never String.length) against `cols`
  // before a line is added, so no line this function returns can be wider
  // than the window it was given.
  const lines: string[] = [centre(theme.paint("petal", glyphs.mark))];

  if (cols >= visibleWidth(WORDMARK)) {
    lines.push(centre(theme.paint("text", WORDMARK)));
  } else if (cols >= visibleWidth(WORDMARK_PLAIN)) {
    lines.push(centre(theme.paint("text", WORDMARK_PLAIN)));
  }

  if (cols >= visibleWidth(TAGLINE) + TAGLINE_MARGIN) {
    lines.push(centre(theme.paint("muted", TAGLINE)));
  }

  if (cols >= EXAMPLES_MIN_COLS && rows >= EXAMPLES_MIN_ROWS) {
    // The block is centred as a whole, not row by row: the labels are padded
    // to a common width, but the right-hand halves are all different lengths,
    // so centring each composed row on its own would give every row its own
    // indent and undo the alignment the padding was for. One indent, derived
    // from the widest row, keeps the label column straight.
    const label = Math.max(...EXAMPLES.map(([left]) => left.length));
    const composed = EXAMPLES.map(([left, right]) => `${left.padEnd(label)}   ${right}`);
    const widest = Math.max(...composed.map((row) => visibleWidth(row)));
    const indent = " ".repeat(Math.max(0, Math.floor((cols - widest) / 2)));
    lines.push("");
    for (const [left, right] of EXAMPLES) {
      lines.push(
        `${indent}${theme.paint("faint", left.padEnd(label))}   ${theme.paint("muted", right)}`,
      );
    }

    // Last, so that a short window drops it before it drops anything useful.
    lines.push("", centre(theme.paint("faint", keysLine(glyphs))));
  }

  return lines.slice(0, rows);
}
