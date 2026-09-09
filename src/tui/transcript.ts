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
  /**
   * Repaints everything, including what is already on screen. Entries hold
   * what was said rather than how it looked, so a theme change reaches the
   * whole conversation instead of only what comes next.
   */
  setTheme(theme: Theme, glyphs: Glyphs): void;
  /** The text behind a copy button, as it arrived rather than as displayed. */
  rawOf(id: string): string | undefined;
  /** The most recent answer, for copying without a mouse. */
  lastAnswer(): string | undefined;
}

type Entry =
  /** What the user typed, quoted back rather than interpreted. */
  | { kind: "user"; text: string }
  /** A tool call: type, duration, and the one field worth showing. */
  | { kind: "step"; nodeType: string; durationMs: number; detail?: string }
  /** Something Vesna itself is saying. */
  | { kind: "notice"; text: string; tone: Role }
  /** A gap between turns. */
  | { kind: "blank" }
  /** Markdown from the model, rendered on demand. */
  | { kind: "answer"; raw: string; id: string }
  /**
   * The blank line that already separates messages, carrying a copy button.
   * Reusing it costs no height, which a button on a line of its own would.
   */
  | { kind: "copy"; id: string };

export function createTranscript(initial: Theme, initialGlyphs: Glyphs): Transcript {
  let theme = initial;
  let glyphs = initialGlyphs;
  let entries: Entry[] = [];

  // Rendering runs on every frame, including each token of a streamed answer,
  // so the last result is kept rather than recomputed for an unchanged answer.
  let cacheKey = "";
  let cached: { lines: string[]; targets: (string | undefined)[] } = { lines: [], targets: [] };
  /** What each copy button puts on the clipboard, by id. */
  const sources = new Map<string, string>();
  let counter = 0;
  const nextId = () => `m${(counter += 1)}`;



  /**
   * The conversation is the frame's most important text, and on a canvas Vesna
   * owns it cannot be left at the terminal's default foreground: a dark theme
   * under a light profile would render it near-black on near-black.
   */
  const body = (text: string) => (text === "" ? "" : theme.paint("text", text));

  /** Renders once per (width, content) and serves both views from the result. */
  const render = (width: number) => {
    // The theme is part of the key: the same words in a different palette are
    // different lines, and serving the cached ones would freeze the old colours.
    const key = [width, theme.name, theme.depth, glyphs.mark, ...entries.map(describe)].join(
      "\u0000",
    );
    if (key === cacheKey) return cached;

    const lines: string[] = [];
    const targets: (string | undefined)[] = [];
    const add = (line: string, id?: string) => {
      lines.push(line);
      targets.push(id);
    };

    for (const entry of entries) {
      switch (entry.kind) {
        case "blank":
          add("");
          break;

        case "user": {
          const [first, ...rest] = entry.text.split("\n");
          add(`${theme.paint("petal", glyphs.prompt)} ${body(first ?? "")}`);
          for (const line of rest) add(`  ${body(line)}`);
          break;
        }

        case "step": {
          const label = `${theme.paint("petal", glyphs.bullet)} ${theme.paint("text", entry.nodeType)} ${theme.paint("muted", `${entry.durationMs}ms`)}`;
          add(`  ${label}${entry.detail ? `  ${theme.paint("muted", entry.detail)}` : ""}`);
          break;
        }

        case "notice":
          add(`  ${theme.paint(entry.tone, entry.text)}`);
          break;

        case "copy":
          add(`  ${theme.paint("faint", `${glyphs.copy} copy`)}`, entry.id);
          break;

        case "answer":
          for (const line of renderMarkdown(entry.raw, {
            theme,
            glyphs,
            width: Math.max(1, width),
          })) {
            add(line);
          }
          break;
      }
    }

    cacheKey = key;
    cached = { lines, targets };
    return cached;
  };

  /** Enough of an entry to tell two renders apart. */
  function describe(entry: Entry): string {
    switch (entry.kind) {
      case "blank":
        return "b";
      case "user":
        return `u:${entry.text}`;
      case "step":
        return `s:${entry.nodeType}:${entry.durationMs}:${entry.detail ?? ""}`;
      case "notice":
        return `n:${entry.tone}:${entry.text}`;
      case "copy":
        return `c:${entry.id}`;
      case "answer":
        return `a:${entry.raw}`;
    }
  }

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

    setTheme(next, nextGlyphs) {
      theme = next;
      glyphs = nextGlyphs;
      cacheKey = "";
    },

    user(text) {
      // Quoted back, never interpreted: a question about `##` in bash should
      // not come back as a heading.
      entries.push({ kind: "user", text });

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
      entries.push({ kind: "step", nodeType, durationMs, ...(detail ? { detail } : {}) });
    },

    notice(text, tone = "muted") {
      entries.push({ kind: "notice", text, tone });
    },

    endTurn() {
      const last = entries[entries.length - 1];
      if (last === undefined) return;
      if (last.kind === "copy" || last.kind === "blank") return;

      // An answer earns a button; a bare notice or step just gets its gap.
      if (last.kind === "answer") {
        entries.push({ kind: "copy", id: last.id });
        return;
      }
      entries.push({ kind: "blank" });
    },
  };
}
