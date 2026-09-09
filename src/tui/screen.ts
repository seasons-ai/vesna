import { RESET } from "./color";
import type { Frame } from "./layout";

/**
 * The only part that talks to a terminal.
 *
 * Redraws are differential — a streaming answer changes one line at a time,
 * and repainting the whole screen for each token flickers — and each draw is a
 * single write, so a frame can never appear half-applied.
 */

export interface Terminal {
  write(text: string): void;
  size(): { rows: number; cols: number };
}

export interface Screen {
  enter(): void;
  leave(): void;
  draw(frame: Frame): void;
  size(): { rows: number; cols: number };
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const CLEAR_LINE = "\x1b[2K";
const CLEAR_ALL = "\x1b[2J";

function moveTo(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`;
}

export function createScreen(
  terminal: Terminal,
  options: { surface?: string } = {},
): Screen {
  const surface = options.surface ?? "";
  let previous: string[] = [];
  let lastSize = { rows: -1, cols: -1 };

  return {
    size: () => terminal.size(),

    enter() {
      terminal.write(`${ALT_ON}${CURSOR_HIDE}${PASTE_ON}${surface}${CLEAR_ALL}`);
      previous = [];
    },

    leave() {
      terminal.write(`${RESET}${PASTE_OFF}${CURSOR_SHOW}${ALT_OFF}`);
    },

    draw(frame: Frame) {
      const size = terminal.size();
      // Diffing against a frame drawn at another size would leave debris.
      if (size.rows !== lastSize.rows || size.cols !== lastSize.cols) {
        previous = [];
        lastSize = size;
      }

      // The canvas is re-established per line: a reset inside painted text
      // would otherwise drop the background for everything after it. The
      // diff is keyed on this composed payload, not the bare text, so a row
      // whose surface changes but whose text does not — a panel boundary
      // sliding across blank rows — still repaints.
      const rendered = frame.lines.map((line, index) => {
        const behind = frame.surfaces?.[index] ?? surface;
        return behind === "" ? line : `${behind}${line}${RESET}`;
      });

      let out = CURSOR_HIDE;
      for (const [index, payload] of rendered.entries()) {
        if (previous[index] === payload) continue;
        out += `${moveTo(index, 0)}${CLEAR_LINE}${payload}`;
      }
      out += `${moveTo(frame.cursor.row, frame.cursor.col)}${CURSOR_SHOW}`;

      terminal.write(out);
      previous = rendered;
    },
  };
}
