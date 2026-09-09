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
}

type Entry =
  /** Painted once, shown verbatim: what the user typed, a step, a notice. */
  | { kind: "line"; text: string }
  /** Markdown from the model, rendered on demand. */
  | { kind: "answer"; raw: string };

export function createTranscript(theme: Theme, glyphs: Glyphs): Transcript {
  let entries: Entry[] = [];

  // Rendering runs on every frame, including each token of a streamed answer,
  // so the last result is kept rather than recomputed for an unchanged answer.
  let cacheKey = "";
  let cached: string[] = [];

  const push = (line: string) => {
    entries.push({ kind: "line", text: line });
  };

  /**
   * The conversation is the frame's most important text, and on a canvas Vesna
   * owns it cannot be left at the terminal's default foreground: a dark theme
   * under a light profile would render it near-black on near-black.
   */
  const body = (text: string) => (text === "" ? "" : theme.paint("text", text));

  return {
    lines(width) {
      const key = `${width}\u0000${entries.map((e) => (e.kind === "line" ? e.text : e.raw)).join("\u0000")}`;
      if (key === cacheKey) return cached;

      const out: string[] = [];
      for (const entry of entries) {
        if (entry.kind === "line") {
          out.push(entry.text);
          continue;
        }
        out.push(...renderMarkdown(entry.raw, { theme, glyphs, width: Math.max(1, width) }));
      }

      cacheKey = key;
      cached = out;
      return out;
    },

    clear() {
      entries = [];
      cacheKey = "";
      cached = [];
    },

    user(text) {
      const [first, ...rest] = text.split("\n");
      // What the user typed is quoted back, never interpreted: a question
      // about `##` in bash should not come back as a heading.
      push(`${theme.paint("petal", glyphs.prompt)} ${body(first ?? "")}`);
      for (const line of rest) push(`  ${body(line)}`);
      push("");
    },

    delta(text) {
      const last = entries[entries.length - 1];
      if (last?.kind === "answer") {
        last.raw += text;
        return;
      }
      entries.push({ kind: "answer", raw: text });
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
      if (last.kind === "line" && last.text === "") return;
      push("");
    },
  };
}
