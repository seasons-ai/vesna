import type { Glyphs } from "./glyphs";
import type { Role, Theme } from "./theme";

/**
 * The conversation as a growing list of painted lines.
 *
 * Streamed text lands character by character, so appending to the line in
 * progress — rather than pushing a line per delta — is what keeps a streaming
 * answer readable.
 */
export interface Transcript {
  user(text: string): void;
  delta(text: string): void;
  step(nodeType: string, durationMs: number, detail?: string): void;
  notice(text: string, tone?: Role): void;
  /** Closes the answer and leaves a single blank line behind. */
  endTurn(): void;
  clear(): void;
  lines(): string[];
}

export function createTranscript(theme: Theme, glyphs: Glyphs): Transcript {
  let lines: string[] = [];
  /** True while the last line is an answer still being streamed into. */
  let streaming = false;

  const push = (line: string) => {
    lines.push(line);
    streaming = false;
  };

  return {
    lines: () => [...lines],

    clear() {
      lines = [];
      streaming = false;
    },

    user(text) {
      const [first, ...rest] = text.split("\n");
      push(`${theme.paint("petal", glyphs.prompt)} ${first ?? ""}`);
      for (const line of rest) push(`  ${line}`);
      push("");
    },

    delta(text) {
      for (const [index, part] of text.split("\n").entries()) {
        if (index > 0 || !streaming) {
          lines.push("");
          streaming = true;
        }
        lines[lines.length - 1] += part;
      }
      streaming = true;
    },

    step(nodeType, durationMs, detail) {
      const label = `${theme.paint("petal", glyphs.bullet)} ${theme.paint("text", nodeType)} ${theme.paint("muted", `${durationMs}ms`)}`;
      push(`  ${label}${detail ? `  ${theme.paint("muted", detail)}` : ""}`);
    },

    notice(text, tone = "muted") {
      push(`  ${theme.paint(tone, text)}`);
    },

    endTurn() {
      if (lines.length === 0) return;
      if (lines[lines.length - 1] === "") return;
      push("");
    },
  };
}
