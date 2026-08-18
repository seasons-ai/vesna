import type { Flow, FlowInput, FlowNode } from "../flow/types";
import type { ProposedParameter } from "./propose";

/**
 * Rewrites a proposed flow so the accepted literals become declared inputs.
 * This is the step a human confirms: guessing which literals are parameters is
 * the open problem, so nothing is applied until it is accepted by name.
 *
 * `accepted` maps a suggested name to the name actually chosen, so a rename made
 * during confirmation is carried all the way into the flow.
 */
export function applyParameters(
  flow: Flow,
  parameters: ProposedParameter[],
  accepted: Map<string, string>,
): Flow {
  const active = parameters.filter((parameter) => accepted.has(parameter.suggestedName));
  if (active.length === 0) return flow;

  const nodes: FlowNode[] = flow.nodes.map((node) => ({ ...node, in: { ...node.in } }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inputs: Record<string, FlowInput> = { ...flow.inputs };

  for (const parameter of active) {
    const name = accepted.get(parameter.suggestedName)!;
    inputs[name] = { type: "string", required: true };

    for (const site of parameter.sites) {
      const node = byId.get(site.nodeId);
      if (!node) continue;
      const current = node.in[site.field];
      if (typeof current !== "string") continue;

      node.in[site.field] =
        current === parameter.literal
          ? // The whole value is the literal, so a typed reference keeps its type.
            `$.inputs.${name}`
          : // The literal is embedded, so it becomes a template inside the string.
            current.split(parameter.literal).join(`\${inputs.${name}}`);
    }
  }

  return { ...flow, inputs, nodes };
}
