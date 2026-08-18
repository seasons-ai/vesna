import type { Assertion } from "../assert/types";
import type { Flow, FlowNode } from "../flow/types";
import type { LiveTrace } from "../loop/trace";
import { reachableSteps } from "./reachability";

export interface ProposedParameter {
  nodeId: string;
  field: string;
  literal: string;
  suggestedName: string;
}

export interface Proposal {
  flow: Flow;
  parameters: ProposedParameter[];
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
export function proposeFlow(trace: LiveTrace, name: string): Proposal {
  const steps = reachableSteps(trace);
  const parameters: ProposedParameter[] = [];

  const nodes: FlowNode[] = steps.map((step, index) => {
    const id = `${step.nodeType}_${index + 1}`;
    for (const [field, value] of Object.entries(step.input)) {
      if (typeof value === "string" && value.length > 0 && trace.prompt.includes(value)) {
        parameters.push({ nodeId: id, field, literal: value, suggestedName: field });
      }
    }
    return {
      id,
      use: step.nodeType,
      in: { ...step.input },
      assert: synthesizeAssertions(step.output),
    };
  });

  return { flow: { name, inputs: {}, nodes }, parameters };
}
