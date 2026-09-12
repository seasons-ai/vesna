/**
 * The review findings as diagnostics: parked findings and every open
 * finding from the last review, turned into the plain shape the editor's
 * diagnostics adapter (Task 7) hangs squiggles from.
 *
 * Pure — no `vscode` import, no I/O. Whether a file actually exists is the
 * adapter's concern, not this module's.
 */
import { join } from "node:path";
import type { Finding, State } from "./protocol";

export interface Diag {
  file: string;
  line: number;
  severity: "error" | "warning" | "information";
  message: string;
}

const SEVERITY: Record<Finding["severity"], Diag["severity"]> = {
  critical: "error",
  important: "warning",
  minor: "information",
};

/** A finding turned into a diagnostic, or `null` when it has nothing to underline. */
function diagFor(root: string, task: string, finding: Finding): Diag | null {
  if (finding.file === "verify" || finding.file === "") return null;
  return {
    file: join(root, finding.file),
    line: (finding.line ?? 1) - 1,
    severity: SEVERITY[finding.severity],
    message: `${task}: ${finding.text}`,
  };
}

/** Parked findings, then every open finding from the last review — `[]` with no spec. */
export function diagnostics(state: State): Diag[] {
  const spec = state.spec;
  if (spec === null) return [];

  const out: Diag[] = [];
  for (const { task, finding } of spec.parked) {
    const diag = diagFor(state.root, task, finding);
    if (diag !== null) out.push(diag);
  }
  for (const [task, review] of Object.entries(spec.reviews)) {
    for (const finding of review.open) {
      const diag = diagFor(state.root, task, finding);
      if (diag !== null) out.push(diag);
    }
  }
  return out;
}
