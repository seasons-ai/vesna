import type { DroppedStep } from "../crystallize/propose";
import type { Theme } from "../tui/theme";

/**
 * A crystal shorter than the run it came from needs an explanation, or the
 * user reads the missing steps as a bug rather than as a data-flow fact.
 */
export function describeDropped(dropped: DroppedStep[], theme: Theme): string[] {
  if (dropped.length === 0) return [];

  const lines = [
    theme.paint(
      "warn",
      `  ${dropped.length} step${dropped.length === 1 ? "" : "s"} left out - nothing in the answer depended on ${dropped.length === 1 ? "it" : "them"}:`,
    ),
  ];
  for (const step of dropped) {
    lines.push(theme.paint("muted", `    ${step.nodeType}  ${summarizeInput(step.input)}`));
  }
  lines.push(
    theme.paint(
      "muted",
      "    usually the model retyped a value instead of passing it on; wire it by hand to keep the step",
    ),
  );
  return lines;
}

function summarizeInput(input: Record<string, unknown>): string {
  const parts = Object.entries(input).map(([key, value]) => `${key}=${short(value)}`);
  return parts.join(" ");
}

function short(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 40 ? `${oneLine.slice(0, 37)}...` : oneLine;
}
