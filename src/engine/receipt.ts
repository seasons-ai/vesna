import type { FlowNode } from "../flow/types";
import type { EffectClass, NodeDef } from "../registry/types";

export interface Receipt {
  nodeId: string;
  at: string;
  output: unknown;
  /**
   * `confirmed` — the effect completed and we saw its result.
   * `attempted` — the call was interrupted, so whether it landed is unknown.
   *   Repair must not guess; a human decides.
   */
  status: "confirmed" | "attempted";
}

/** A flow node may narrow its own effect; otherwise the registry definition decides. */
export function effectOf(node: FlowNode, definition: NodeDef): EffectClass {
  return node.effect ?? definition.effect;
}
