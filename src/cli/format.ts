import type { ProposedParameter } from "../crystallize/propose";

/**
 * Renders a proposal line. The arrow points at the exact template the flow
 * language accepts, because that is what a human copies into the file.
 */
export function formatParameter(parameter: ProposedParameter): string {
  const sites = parameter.sites.map((site) => `${site.nodeId}.${site.field}`).join(", ");
  return `"${parameter.literal}"  ->  \${inputs.${parameter.suggestedName}}   at ${sites}`;
}
