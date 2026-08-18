import type { Assertion } from "../assert/types";
import type { EffectClass } from "../registry/types";

export interface FlowInput {
  type: "string" | "number" | "file";
  required?: boolean;
}

export interface FlowNode {
  id: string;
  use: string;
  effect?: EffectClass;
  model?: string;
  in: Record<string, unknown>;
  assert?: Assertion[];
}

export interface Flow {
  name: string;
  inputs: Record<string, FlowInput>;
  nodes: FlowNode[];
}
