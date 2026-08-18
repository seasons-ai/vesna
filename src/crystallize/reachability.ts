import type { LiveTrace, TraceStep } from "../loop/trace";

function scalars(value: unknown, found: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) scalars(nested, found);
    return;
  }
  const text = String(value);
  if (text.length > 0) found.add(text);
}

function producedValues(step: TraceStep): Set<string> {
  const found = new Set<string>();
  scalars(step.output, found);
  return found;
}

function consumedValues(step: TraceStep): Set<string> {
  const found = new Set<string>();
  scalars(step.input, found);
  return found;
}

/** True when any value produced by `producer` appears in `consumer`'s input. */
function feeds(producer: TraceStep, consumer: TraceStep): boolean {
  const consumed = consumedValues(consumer);
  for (const value of producedValues(producer)) {
    if (consumed.has(value)) return true;
  }
  return false;
}

/**
 * Walks backwards from the final step along data edges. Steps that never fed
 * the result were exploration, not work, and are dropped. This is a graph
 * traversal rather than a heuristic: it is deterministic and explainable.
 */
export function reachableSteps(trace: LiveTrace): TraceStep[] {
  if (trace.steps.length === 0) return [];

  const keep = new Set<string>();
  const frontier = [trace.steps[trace.steps.length - 1]!];
  keep.add(frontier[0]!.id);

  while (frontier.length > 0) {
    const consumer = frontier.pop()!;
    const consumerIndex = trace.steps.indexOf(consumer);
    for (let i = consumerIndex - 1; i >= 0; i -= 1) {
      const candidate = trace.steps[i]!;
      if (keep.has(candidate.id)) continue;
      if (feeds(candidate, consumer)) {
        keep.add(candidate.id);
        frontier.push(candidate);
      }
    }
  }

  return trace.steps.filter((step) => keep.has(step.id));
}
