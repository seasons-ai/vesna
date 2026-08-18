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
