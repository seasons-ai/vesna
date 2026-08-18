import type { Assertion } from "../assert/types";
import type { Flow, FlowNode } from "../flow/types";
import type { LiveTrace } from "../loop/trace";
import { reachableSteps } from "./reachability";

export interface ParameterSite {
  nodeId: string;
  field: string;
}

export interface ProposedParameter {
  /** The literal observed in the trace. */
  literal: string;
  /** A unique name for the flow input this literal would become. */
  suggestedName: string;
  /** Every place the literal appeared. One literal is one input, used in many places. */
  sites: ParameterSite[];
}

export interface DroppedStep {
  nodeType: string;
  input: Record<string, unknown>;
}

export interface Proposal {
  flow: Flow;
  parameters: ProposedParameter[];
  /**
   * Steps the answer turned out not to depend on. Usually the model read
   * something and then paraphrased it instead of passing the value along, so
   * there is no data path to follow. Dropping them is right; doing it quietly
   * is not — the flow would be shorter than the run with no explanation.
   */
  dropped: DroppedStep[];
}

export function synthesizeAssertions(output: unknown): Assertion[] {
  const assertions: Assertion[] = [];
  if (output === null || typeof output !== "object") return assertions;

  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    const ref = `$.out.${key}`;
    if (Array.isArray(value)) {
      assertions.push({ non_empty: ref });
      const first = value[0];
      if (first && typeof first === "object") {
        assertions.push({ has_keys: { value: ref, keys: Object.keys(first) } });
      }
    } else if (typeof value === "string") {
      assertions.push({ non_empty: ref });
      assertions.push({ not_matches: { value: ref, pattern: "\\{\\{.*\\}\\}" } });
    }
  }
  return assertions;
}

/**
 * Derives a flow from a trace and proposes which literals look like parameters.
 * The proposal is deliberately not applied: generalising a single trace is the
 * hard problem, so a human confirms it. See the risks section of the spec.
 */
/**
 * Finds an earlier node whose output carried exactly this value, so the flow can
 * reference it instead of freezing a constant. Without this a crystal looks
 * correct and quietly writes the first run's data on every later row.
 */
function referenceForValue(
  value: unknown,
  produced: { nodeId: string; output: unknown }[],
): string | undefined {
  for (const earlier of produced) {
    if (earlier.output === null || typeof earlier.output !== "object") continue;
    for (const [key, candidate] of Object.entries(earlier.output as Record<string, unknown>)) {
      if (candidate === value) return `$.${earlier.nodeId}.${key}`;
    }
  }
  return undefined;
}

export function proposeFlow(trace: LiveTrace, name: string): Proposal {
  const steps = reachableSteps(trace);

  // One literal is one input, however many places it appears in.
  const byLiteral = new Map<string, ParameterSite[]>();
  const produced: { nodeId: string; output: unknown }[] = [];

  const nodes: FlowNode[] = steps.map((step, index) => {
    const id = `${step.nodeType}_${index + 1}`;
    const wired: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(step.input)) {
      const reference = referenceForValue(value, produced);
      if (reference !== undefined) {
        // Data that flowed between steps is wired, never parameterised.
        wired[field] = reference;
        continue;
      }

      wired[field] = value;
      if (typeof value === "string" && value.length > 0 && trace.prompt.includes(value)) {
        const sites = byLiteral.get(value) ?? [];
        sites.push({ nodeId: id, field });
        byLiteral.set(value, sites);
      }
    }

    produced.push({ nodeId: id, output: step.output });
    return {
      id,
      use: step.nodeType,
      in: wired,
      assert: synthesizeAssertions(step.output),
    };
  });

  // Names must be unique: two different literals on a `path` field would
  // otherwise both propose `$.inputs.path` and silently collapse into one input.
  const taken = new Set<string>();
  const parameters: ProposedParameter[] = [];

  for (const [literal, sites] of byLiteral) {
    const first = sites[0]!;
    const candidates = [first.field, `${first.nodeId}_${first.field}`];
    let suggestedName = candidates.find((candidate) => !taken.has(candidate));
    for (let suffix = 2; suggestedName === undefined; suffix += 1) {
      const candidate = `${first.field}_${suffix}`;
      if (!taken.has(candidate)) suggestedName = candidate;
    }
    taken.add(suggestedName);
    parameters.push({ literal, suggestedName, sites });
  }

  const kept = new Set(steps);
  const dropped: DroppedStep[] = trace.steps
    .filter((step) => !kept.has(step))
    .map((step) => ({ nodeType: step.nodeType, input: step.input }));

  return { flow: { name, inputs: {}, nodes }, parameters, dropped };
}
