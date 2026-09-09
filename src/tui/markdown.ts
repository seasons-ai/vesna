import type { Glyphs } from "./glyphs";
import type { Role, Theme } from "./theme";
import { visibleWidth, wrapAnsi } from "./wrap";

/**
 * Markdown for a terminal.
 *
 * Models answer in markdown whether or not anything renders it, so without
 * this an answer arrives as a wall of hashes, asterisks and pipes: the table
 * is unreadable and the code block is indistinguishable from the prose around
 * it.
 *
 * Every line comes back no wider than the width given, so the caller never
 * wraps again. Word wrap applied to a table or a code block would destroy the
 * alignment that makes them worth rendering at all.
 */

export interface MarkdownOptions {
  theme: Theme;
  glyphs: Glyphs;
  width: number;
}

export function renderMarkdown(text: string, options: MarkdownOptions): string[] {
  const width = Math.max(1, options.width);
  const source = text.split("\n");
  const out: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const line = source[index]!;

    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < source.length && !/^\s*```\s*$/.test(source[index]!)) {
        body.push(source[index]!);
        index += 1;
      }
      // A streamed answer arrives with its last fence still open. Render it
      // anyway, rather than making the user wait to see their own code.
      out.push(...codeBlock(body, options, width));
      continue;
    }

    if (isTableRow(line) && isTableDivider(source[index + 1])) {
      const rows: string[][] = [cells(line)];
      index += 2;
      while (index < source.length && isTableRow(source[index])) {
        rows.push(cells(source[index]!));
        index += 1;
      }
      index -= 1;
      out.push(...table(rows, options, width));
      continue;
    }

    out.push(...block(line, options, width));
  }

  return out;
}

function block(line: string, options: MarkdownOptions, width: number): string[] {
  const { theme, glyphs } = options;

  if (line.trim() === "") return [""];

  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
    return [theme.paint("faint", glyphs.rule.repeat(width))];
  }

  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading !== null) {
    const role: Role = heading[1]!.length <= 2 ? "petal" : "text";
    return wrapPainted(inline(heading[2]!, options, role), width, "", "");
  }

  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote !== null) {
    const bar = `${theme.paint("faint", glyphs.gutter)} `;
    return wrapPainted(inline(quote[1]!, options, "muted"), width - 2, bar, bar);
  }

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet !== null) {
    const indent = bullet[1]!;
    const marker = `${indent}${theme.paint("petal", glyphs.listItem)} `;
    const hang = " ".repeat(indent.length + 2);
    return wrapPainted(inline(bullet[2]!, options), width - indent.length - 2, marker, hang);
  }

  const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
  if (numbered !== null) {
    const indent = numbered[1]!;
    const label = `${numbered[2]!}.`;
    const marker = `${indent}${theme.paint("petal", label)} `;
    const hang = " ".repeat(indent.length + label.length + 1);
    const room = width - indent.length - label.length - 1;
    return wrapPainted(inline(numbered[3]!, options), room, marker, hang);
  }

  return wrapPainted(inline(line, options), width, "", "");
}

/** Wraps painted text, marking the first line and hanging the rest. */
function wrapPainted(painted: string, width: number, first: string, rest: string): string[] {
  const wrapped = wrapAnsi(painted, Math.max(1, width));
  return wrapped.map((line, index) => (index === 0 ? first : rest) + line);
}

/** Emphasis markers removed but no colour applied, for headings and cells. */
function stripInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1$2");
}

/**
 * One run of text and the role that paints it.
 *
 * Emphasis is resolved into flat spans rather than nested paint calls: a
 * painted span ends with a reset, so wrapping one inside another would leave
 * everything after the inner span unpainted — and on a canvas Vesna owns,
 * unpainted means the terminal's own foreground, which can be invisible.
 */
interface Span {
  text: string;
  role: Role;
}

const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)|(?<=^|[\s(])\*([^*\s][^*]*)\*|(?<=^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g;

function spans(text: string, base: Role): Span[] {
  const out: Span[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) out.push({ text: text.slice(last, at), role: base });

    const [, code, bold, label, url, star, underscore] = match;
    if (code !== undefined) out.push({ text: code, role: "ice" });
    else if (bold !== undefined) out.push({ text: bold, role: "petal" });
    else if (label !== undefined) {
      out.push({ text: label, role: "ice" });
      out.push({ text: ` ${url ?? ""}`, role: "faint" });
    } else if (star !== undefined) out.push({ text: star, role: "text" });
    else if (underscore !== undefined) out.push({ text: underscore, role: "text" });

    last = at + match[0].length;
  }

  if (last < text.length) out.push({ text: text.slice(last), role: base });
  return out;
}

function inline(text: string, options: MarkdownOptions, base: Role = "text"): string {
  return spans(text, base)
    .map((span) => (span.text === "" ? "" : options.theme.paint(span.role, span.text)))
    .join("");
}

function codeBlock(body: string[], options: MarkdownOptions, width: number): string[] {
  const { theme, glyphs } = options;
  // A gutter rather than a filled background: a background behind a line the
  // layout also pads would tear at its edge, and this survives every terminal.
  const gutter = theme.paint("faint", `${glyphs.gutter} `);
  const room = Math.max(1, width - 2);
  return body.map((line) => {
    const cut = visibleWidth(line) > room ? line.slice(0, room) : line;
    return gutter + theme.paint("ice", cut);
  });
}

function isTableRow(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|.*\|\s*$/.test(line);
}

function isTableDivider(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-");
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function table(rows: string[][], options: MarkdownOptions, width: number): string[] {
  const { theme, glyphs } = options;
  const columns = Math.max(...rows.map((row) => row.length));
  const grid = rows.map((row) => {
    const copy = [...row];
    while (copy.length < columns) copy.push("");
    return copy.slice(0, columns);
  });

  const separators = (columns - 1) * 3;
  const widths = Array.from({ length: columns }, (_unused, i) =>
    Math.max(1, ...grid.map((row) => visibleWidth(stripInline(row[i]!)))),
  );
  // Give each column what it asks for, then shave the widest until it fits.
  while (widths.reduce((sum, w) => sum + w, 0) + separators > width) {
    const widest = widths.indexOf(Math.max(...widths));
    const current = widths[widest];
    if (current === undefined || current <= 1) break;
    widths[widest] = current - 1;
  }

  const divider = theme.paint("faint", ` ${glyphs.gutter} `);
  const painted = grid.map((row, rowIndex) =>
    row
      .map((cell, i) => {
        const room = widths[i]!;
        const flat = stripInline(cell);
        const cut = visibleWidth(flat) > room ? `${flat.slice(0, Math.max(0, room - 1))}…` : flat;
        const padded = cut + " ".repeat(Math.max(0, room - visibleWidth(cut)));
        return theme.paint(rowIndex === 0 ? "petal" : "text", padded);
      })
      .join(divider),
  );

  // A rule under the header, so the eye finds where the data starts.
  const rule = theme.paint("faint", widths.map((w) => glyphs.rule.repeat(w)).join(glyphs.rule.repeat(3)));
  return [painted[0]!, rule, ...painted.slice(1)];
}
