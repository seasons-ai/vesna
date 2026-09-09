/**
 * Wrapping that survives colour.
 *
 * Escape codes take no columns but must not be split, and a colour opened
 * before a break has to be reopened after it — otherwise one wrapped line
 * bleeds its colour into the rest of the screen.
 */

import { FG_RESET, RESET } from "./color";

const SGR = /\x1b\[[0-9;]*m/y;

/** Zero-width: combining marks and joiners. */
const ZERO_WIDTH = /[\p{Mn}\p{Me}​-‏﻿]/u;

/** The East Asian Wide and Fullwidth blocks, which occupy two columns. */
function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff)
  );
}

function charWidth(char: string): number {
  if (ZERO_WIDTH.test(char)) return 0;
  return isWide(char.codePointAt(0)!) ? 2 : 1;
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const piece of pieces(text)) {
    if (piece.escape) continue;
    width += charWidth(piece.char);
  }
  return width;
}

interface Piece {
  char: string;
  escape: boolean;
}

/** Splits into escape sequences and single visible characters, in order. */
function* pieces(text: string): Generator<Piece> {
  let index = 0;
  while (index < text.length) {
    SGR.lastIndex = index;
    const match = SGR.exec(text);
    if (match !== null) {
      yield { char: match[0], escape: true };
      index += match[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(index)!);
    yield { char, escape: false };
    index += char.length;
  }
}

export function wrapAnsi(text: string, width: number): string[] {
  if (width <= 0) return text.split("\n");

  const lines: string[] = [];
  for (const paragraph of text.split("\n")) lines.push(...wrapOne(paragraph, width));
  return lines;
}

interface Cell {
  char: string;
  width: number;
  /** The colour in force at this character, "" for none. */
  color: string;
}

function cells(text: string): Cell[] {
  const out: Cell[] = [];
  let color = "";
  for (const piece of pieces(text)) {
    if (piece.escape) {
      color = piece.char === RESET || piece.char === FG_RESET ? "" : piece.char;
      continue;
    }
    out.push({ char: piece.char, width: charWidth(piece.char), color });
  }
  return out;
}

function wrapOne(text: string, width: number): string[] {
  const lines: string[] = [];
  let line: Cell[] = [];
  let used = 0;

  const flush = () => {
    while (line.length > 0 && line[line.length - 1]!.char === " ") line.pop();
    lines.push(render(line));
    line = [];
    used = 0;
  };

  for (const cell of cells(text)) {
    if (used + cell.width > width) {
      const at = lastSpace(line);
      if (at > 0) {
        const tail = trimLeadingSpaces(line.slice(at));
        line = line.slice(0, at);
        flush();
        line = tail;
        used = tail.reduce((sum, c) => sum + c.width, 0);
      } else {
        flush();
      }
    }

    // The run of spaces that caused a break is the break; it is not content
    // owed to the next line. Leading space on the first line is indentation.
    if (cell.char === " " && line.length === 0 && lines.length > 0) continue;

    line.push(cell);
    used += cell.width;
  }

  flush();
  return lines;
}

function lastSpace(line: Cell[]): number {
  for (let index = line.length - 1; index >= 0; index -= 1) {
    if (line[index]!.char === " ") return index;
  }
  return -1;
}

function trimLeadingSpaces(cells: Cell[]): Cell[] {
  let start = 0;
  while (start < cells.length && cells[start]!.char === " ") start += 1;
  return cells.slice(start);
}

/** Consecutive characters sharing a colour become one painted run. */
function render(line: Cell[]): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    const color = line[index]!.color;
    let text = "";
    while (index < line.length && line[index]!.color === color) {
      text += line[index]!.char;
      index += 1;
    }
    out += color === "" ? text : `${color}${text}${FG_RESET}`;
  }
  return out;
}
