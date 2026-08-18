import type { FlowNode } from "../flow/types";
import type { EffectClass, NodeDef } from "../registry/types";

export interface Receipt {
  nodeId: string;
  at: string;
  output: unknown;
}

/** A flow node may narrow its own effect; otherwise the registry definition decides. */
export function effectOf(node: FlowNode, definition: NodeDef): EffectClass {
  return node.effect ?? definition.effect;
}
