import { topologicalOrder } from "../engine/order";
import { effectOf } from "../engine/receipt";
import { validateFlow, validateInputs } from "../flow/parse";
import type { Flow } from "../flow/types";
import type { Registry } from "../registry/types";

export interface FlowSummary {
  name: string;
  inputs: { name: string; type: string; required: boolean }[];
  nodes: { id: string; use: string }[];
}

export function summarizeFlow(flow: Flow): FlowSummary {
  return {
    name: flow.name,
    inputs: Object.entries(flow.inputs).map(([name, spec]) => ({
      name,
      type: spec.type,
      required: spec.required === true,
    })),
    nodes: flow.nodes.map((node) => ({ id: node.id, use: node.use })),
  };
}

export interface RunPlan {
  order: string[];
  /** Nodes that touch the outside world — the ones worth reading twice before a fan-out. */
  external: string[];
  /** Nodes that call a model, and therefore cost tokens per row. */
  model: string[];
}

/**
 * Everything `run` would check before executing, without executing. This is the
 * cheap way to find out what a flow will do to 200 rows.
 */
export function planRun(flow: Flow, registry: Registry, inputs: Record<string, unknown>): RunPlan {
  validateFlow(flow, registry);
  validateInputs(flow, inputs);

  const order = topologicalOrder(flow);
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));

  const external: string[] = [];
  const model: string[] = [];

  for (const id of order) {
    const node = byId.get(id)!;
    const definition = registry.get(node.use)!;
    if (effectOf(node, definition) === "external") external.push(id);
    if (node.use === "llm") model.push(id);
  }

  return { order, external, model };
}
