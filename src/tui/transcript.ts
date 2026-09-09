import type { Glyphs } from "./glyphs";
import { renderMarkdown } from "./markdown";
import type { Role, Theme } from "./theme";

/**
 * The conversation, as entries rather than as finished lines.
 *
 * An answer is kept as the markdown the model actually sent and rendered at
 * the width of the moment. Rendering as the text arrives is impossible: a
 * table or a fence is only meaningful once it is complete, and a window can
 * be resized long after the answer has finished.
 */
export interface Transcript {
  user(text: string): void;
  delta(text: string): void;
  step(nodeType: string, durationMs: number, detail?: string): void;
  notice(text: string, tone?: Role): void;
  /** Closes the answer and leaves a single blank line behind. */
  endTurn(): void;
  clear(): void;
  lines(width: number): string[];
  /**
   * Which message each rendered line can copy, parallel to `lines`. Only the
   * button's own row carries an id; everything else is undefined.
   */
  copyTargets(width: number): (string | undefined)[];
  /** The text behind a copy button, as it arrived rather than as displayed. */
  rawOf(id: string): string | undefined;
  /** The most recent answer, for copying without a mouse. */
  lastAnswer(): string | undefined;
}

type Entry =
  /** Painted once, shown verbatim: what the user typed, a step, a notice. */
  | { kind: "line"; text: string }
  /** Markdown from the model, rendered on demand. */
  | { kind: "answer"; raw: string; id: string }
  /**
   * The blank line that already separates messages, carrying a copy button.
   * Reusing it costs no height, which a button on a line of its own would.
   */
  | { kind: "copy"; id: string };

export function createTranscript(theme: Theme, glyphs: Glyphs): Transcript {
  let entries: Entry[] = [];

  // Rendering runs on every frame, including each token of a streamed answer,
  // so the last result is kept rather than recomputed for an unchanged answer.
  let cacheKey = "";
  let cached: { lines: string[]; targets: (string | undefined)[] } = { lines: [], targets: [] };
  /** What each copy button puts on the clipboard, by id. */
  const sources = new Map<string, string>();
  let counter = 0;
  const nextId = () => `m${(counter += 1)}`;

  const push = (line: string) => {
    entries.push({ kind: "line", text: line });
  };

  /**
   * The conversation is the frame's most important text, and on a canvas Vesna
   * owns it cannot be left at the terminal's default foreground: a dark theme
   * under a light profile would render it near-black on near-black.
   */
  const body = (text: string) => (text === "" ? "" : theme.paint("text", text));

  /** Renders once per (width, content) and serves both views from the result. */
  const render = (width: number) => {
    const key = `${width}\u0000${entries
      .map((entry) =>
        entry.kind === "line" ? entry.text : entry.kind === "answer" ? entry.raw : `c:${entry.id}`,
      )
      .join("\u0000")}`;
    if (key === cacheKey) return cached;

    const lines: string[] = [];
    const targets: (string | undefined)[] = [];

    for (const entry of entries) {
      if (entry.kind === "line") {
        lines.push(entry.text);
        targets.push(undefined);
        continue;
      }
      if (entry.kind === "copy") {
        lines.push(`  ${theme.paint("faint", `${glyphs.copy} copy`)}`);
        targets.push(entry.id);
        continue;
      }
      for (const line of renderMarkdown(entry.raw, { theme, glyphs, width: Math.max(1, width) })) {
        lines.push(line);
        targets.push(undefined);
      }
    }

    cacheKey = key;
    cached = { lines, targets };
    return cached;
  };

  return {
    lines: (width) => render(width).lines,
    copyTargets: (width) => render(width).targets,
    rawOf: (id) => sources.get(id),

    lastAnswer() {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        if (entry.kind === "answer") return entry.raw;
      }
      return undefined;
    },

    clear() {
      entries = [];
      sources.clear();
      cacheKey = "";
      cached = { lines: [], targets: [] };
    },

    user(text) {
      const [first, ...rest] = text.split("\n");
      // What the user typed is quoted back, never interpreted: a question
      // about `##` in bash should not come back as a heading.
      push(`${theme.paint("petal", glyphs.prompt)} ${body(first ?? "")}`);
      for (const line of rest) push(`  ${body(line)}`);

      const id = nextId();
      sources.set(id, text);
      entries.push({ kind: "copy", id });
    },

    delta(text) {
      const last = entries[entries.length - 1];
      if (last?.kind === "answer") {
        last.raw += text;
        sources.set(last.id, last.raw);
        return;
      }
      const id = nextId();
      entries.push({ kind: "answer", raw: text, id });
      sources.set(id, text);
    },

    step(nodeType, durationMs, detail) {
      const label = `${theme.paint("petal", glyphs.bullet)} ${theme.paint("text", nodeType)} ${theme.paint("muted", `${durationMs}ms`)}`;
      push(`  ${label}${detail ? `  ${theme.paint("muted", detail)}` : ""}`);
    },

    notice(text, tone = "muted") {
      push(`  ${theme.paint(tone, text)}`);
    },

    endTurn() {
      const last = entries[entries.length - 1];
      if (last === undefined) return;
      if (last.kind === "copy") return;
      if (last.kind === "line" && last.text === "") return;

      // An answer earns a button; a bare notice or step just gets its gap.
      if (last.kind === "answer") {
        entries.push({ kind: "copy", id: last.id });
        return;
      }
      push("");
    },
  };
}
