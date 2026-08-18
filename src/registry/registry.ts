import type { ToolSpec } from "../providers/types";
import type { NodeDef, Registry } from "./types";

export class DuplicateNodeError extends Error {
  constructor(type: string) {
    super(`node type already registered: ${type}`);
    this.name = "DuplicateNodeError";
  }
}

export function createRegistry(): Registry {
  const nodes = new Map<string, NodeDef>();
  return {
    register(def) {
      if (nodes.has(def.type)) throw new DuplicateNodeError(def.type);
      nodes.set(def.type, def);
    },
    get(type) {
      return nodes.get(type);
    },
    list() {
      return [...nodes.keys()];
    },
  };
}

/**
 * Every registered node is callable by the agent. Deriving the specs here rather
 * than from a hand-maintained map is what makes one contributed node upgrade
 * both the live agent and every flow.
 */
export function toolSpecs(registry: Registry): ToolSpec[] {
  return registry.list().map((type) => {
    const def = registry.get(type)!;
    return { name: def.type, description: def.description, input_schema: def.inputSchema };
  });
}
