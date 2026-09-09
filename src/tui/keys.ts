/**
 * Raw terminal bytes -> key events.
 *
 * Pure and chunk-safe: a read can end in the middle of an escape sequence, so
 * anything incomplete is handed back as `rest` for the next read to finish
 * rather than being guessed at or typed into the input box.
 */

export type Key =
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | { type: "enter" }
  | { type: "newline" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "word-left" }
  | { type: "word-right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "kill-line" }
  | { type: "kill-word" }
  | { type: "kill-to-end" }
  | { type: "interrupt" }
  | { type: "eof" }
  | { type: "tab" }
  | { type: "wheel-up" }
  | { type: "wheel-down" }
  | { type: "click"; column: number; row: number }
  | { type: "panel-left" }
  | { type: "panel-right" }
  | { type: "page-up" }
  | { type: "page-down" }
  | { type: "escape" };

const ESC = "\x1b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Control bytes that stand alone. */
const CONTROLS: Record<string, Key> = {
  "\r": { type: "enter" },
  "\n": { type: "enter" },
  "\t": { type: "tab" },
  "\x7f": { type: "backspace" },
  "\x08": { type: "backspace" },
  "\x03": { type: "interrupt" },
  "\x04": { type: "eof" },
  "\x01": { type: "home" },
  "\x05": { type: "end" },
  "\x0b": { type: "kill-to-end" },
  "\x15": { type: "kill-line" },
  "\x17": { type: "kill-word" },
  // Ctrl-B: ctrl-H is backspace on a great many terminals.
  "\x02": { type: "panel-left" },
  // Ctrl-G: the garden, the state of the work in hand.
  "\x07": { type: "panel-right" },
};

/** Final letters of a CSI sequence, once any modifier has been stripped. */
const CSI_KEYS: Record<string, Key> = {
  A: { type: "up" },
  B: { type: "down" },
  C: { type: "right" },
  D: { type: "left" },
  H: { type: "home" },
  F: { type: "end" },
};

const CSI_TILDE: Record<string, Key> = {
  "1": { type: "home" },
  "4": { type: "end" },
  "3": { type: "delete" },
  "5": { type: "page-up" },
  "6": { type: "page-down" },
  "7": { type: "home" },
  "8": { type: "end" },
};

/** ctrl (5) and alt (3) turn a horizontal arrow into a word motion. */
const WORD_MODIFIERS = new Set(["3", "5"]);
/** shift (2) turns a vertical arrow into a scroll. */
const SCROLL_MODIFIER = "2";

export interface Decoded {
  keys: Key[];
  /** An incomplete sequence, to be prepended to the next read. */
  rest: string;
}

export function decodeKeys(input: string): Decoded {
  const keys: Key[] = [];
  let text = "";
  let index = 0;

  const flush = () => {
    if (text !== "") {
      keys.push({ type: "text", text });
      text = "";
    }
  };

  while (index < input.length) {
    const char = input[index]!;

    if (char !== ESC) {
      const control = CONTROLS[char];
      if (control !== undefined) {
        flush();
        keys.push(control);
      } else if (char >= " ") {
        text += char;
      }
      // Other control bytes are dropped rather than typed.
      index += 1;
      continue;
    }

    // A paste is one event however many newlines it holds, so that pasting a
    // block of code cannot be read as a run of separate submissions.
    if (input.startsWith(PASTE_START, index)) {
      const end = input.indexOf(PASTE_END, index + PASTE_START.length);
      if (end === -1) {
        flush();
        return { keys, rest: input.slice(index) };
      }
      flush();
      keys.push({ type: "paste", text: input.slice(index + PASTE_START.length, end) });
      index = end + PASTE_END.length;
      continue;
    }

    const escape = readEscape(input, index);
    if (escape === null) {
      flush();
      return { keys, rest: input.slice(index) };
    }
    flush();
    if (escape.key !== null) keys.push(escape.key);
    index = escape.next;
  }

  flush();
  return { keys, rest: "" };
}

/** null means "incomplete"; a null `key` means "complete but not understood". */
function readEscape(input: string, start: number): { key: Key | null; next: number } | null {
  const after = input[start + 1];
  if (after === undefined) return null;

  if (after === "\r" || after === "\n") return { key: { type: "newline" }, next: start + 2 };
  if (after === "b") return { key: { type: "word-left" }, next: start + 2 };
  if (after === "f") return { key: { type: "word-right" }, next: start + 2 };

  if (after !== "[" && after !== "O") {
    return { key: { type: "escape" }, next: start + 1 };
  }

  // SGR mouse: CSI < Cb ; Cx ; Cy (M press | m release).
  if (after === "[" && input[start + 2] === "<") {
    return readMouse(input, start);
  }

  // CSI: parameter bytes, then one final letter.
  let index = start + 2;
  while (index < input.length && /[0-9;]/.test(input[index]!)) index += 1;
  if (index >= input.length) return null;

  const parameters = input.slice(start + 2, index).split(";");
  const final = input[index]!;
  const next = index + 1;

  if (final === "~") {
    return { key: CSI_TILDE[parameters[0] ?? ""] ?? null, next };
  }

  const key = CSI_KEYS[final];
  if (key === undefined) return { key: null, next };

  const modifier = parameters[1];
  if (modifier !== undefined && WORD_MODIFIERS.has(modifier)) {
    if (key.type === "left") return { key: { type: "word-left" }, next };
    if (key.type === "right") return { key: { type: "word-right" }, next };
  }
  if (modifier === SCROLL_MODIFIER) {
    if (key.type === "up") return { key: { type: "page-up" }, next };
    if (key.type === "down") return { key: { type: "page-down" }, next };
  }
  return { key, next };
}

/** Wheel bit in the SGR button code; 64 is up, 65 is down. */
const WHEEL = 64;
/** Set while the mouse is merely moving, which is not a click. */
const MOTION = 32;

function readMouse(input: string, start: number): { key: Key | null; next: number } | null {
  let index = start + 3;
  while (index < input.length && /[0-9;]/.test(input[index]!)) index += 1;
  if (index >= input.length) return null;

  const final = input[index]!;
  if (final !== "M" && final !== "m") return { key: null, next: index + 1 };

  const parts = input.slice(start + 3, index).split(";").map(Number);
  const [button, column, row] = parts;
  const next = index + 1;
  if (button === undefined || column === undefined || row === undefined) {
    return { key: null, next };
  }

  if ((button & WHEEL) !== 0) {
    // Modifier bits ride alongside the button; the low two bits pick the axis.
    return { key: { type: (button & 1) === 0 ? "wheel-up" : "wheel-down" }, next };
  }

  // A release repeats the press, and motion is not a click; either would
  // double or scatter the action.
  if (final === "m" || (button & MOTION) !== 0) return { key: null, next };
  if ((button & 3) !== 0) return { key: null, next };

  // The terminal counts from one; every coordinate in the frame counts from zero.
  return { key: { type: "click", column: column - 1, row: row - 1 }, next };
}
