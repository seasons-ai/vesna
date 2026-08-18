import { parse as parseYaml } from "yaml";
import { refDependencies } from "../expr/resolve";
import type { Registry } from "../registry/types";
import type { Flow, FlowNode } from "./types";

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export function parseFlow(source: string): Flow {
  const raw = parseYaml(source);
  if (raw === null || typeof raw !== "object") throw new ContractError("flow must be a mapping");
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw new ContractError("flow requires a name");
  }
  if (!Array.isArray(raw.nodes)) throw new ContractError("flow requires a nodes array");

  const seen = new Set<string>();
  for (const node of raw.nodes as FlowNode[]) {
    if (typeof node?.id !== "string") throw new ContractError("each node requires an id");
    if (typeof node.use !== "string") throw new ContractError(`node ${node.id} requires a use`);
    if (seen.has(node.id)) throw new ContractError(`duplicate node id: ${node.id}`);
    seen.add(node.id);
    node.in ??= {};
  }

  return { name: raw.name, inputs: raw.inputs ?? {}, nodes: raw.nodes };
}

export function validateFlow(flow: Flow, registry: Registry): void {
  const ids = new Set(flow.nodes.map((node) => node.id));
  for (const node of flow.nodes) {
    if (!registry.get(node.use)) {
      throw new ContractError(`node ${node.id} uses unregistered type: ${node.use}`);
    }
    for (const dependency of refDependencies(node.in)) {
      if (!ids.has(dependency)) {
        throw new ContractError(`node ${node.id} references unknown node: ${dependency}`);
      }
    }
  }
}

export function validateInputs(flow: Flow, values: Record<string, unknown>): void {
  for (const [name, spec] of Object.entries(flow.inputs)) {
    if (spec.required && !(name in values)) {
      throw new ContractError(`missing required input: ${name}`);
    }
  }
}
