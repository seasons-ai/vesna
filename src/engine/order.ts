import { refDependencies } from "../expr/resolve";
import { ContractError } from "../flow/parse";
import type { Flow } from "../flow/types";

export function topologicalOrder(flow: Flow): string[] {
  const pending = new Map(flow.nodes.map((node) => [node.id, refDependencies(node.in)]));
  const ordered: string[] = [];
  const done = new Set<string>();

  // Among nodes the graph leaves unordered, declaration order wins. Sorting by
  // id here would be deterministic too, but it would silently reorder a flow
  // away from the sequence its author wrote.
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, deps]) => deps.every((dep) => done.has(dep)))
      .map(([id]) => id);
    if (ready.length === 0) {
      throw new ContractError(`dependency cycle among nodes: ${[...pending.keys()].join(", ")}`);
    }
    for (const id of ready) {
      ordered.push(id);
      done.add(id);
      pending.delete(id);
    }
  }
  return ordered;
}
