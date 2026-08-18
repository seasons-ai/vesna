import { evaluateAssertions, type AssertionOutcome } from "../assert/evaluate";
import { resolveInput } from "../expr/resolve";
import { validateFlow, validateInputs } from "../flow/parse";
import type { Flow, FlowNode } from "../flow/types";
import type { Registry } from "../registry/types";
import type { EngineError } from "./errors";
import { topologicalOrder } from "./order";

export type NodeStatus = "ok" | "held" | "failed";

export interface NodeOutcome {
  id: string;
  status: NodeStatus;
  output?: unknown;
  error?: EngineError;
  assertions: AssertionOutcome[];
  durationMs: number;
}

export interface RunResult {
  status: NodeStatus;
  nodes: NodeOutcome[];
}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  permit?: (node: FlowNode) => boolean;
  retries?: number;
}

export async function runFlow(
  flow: Flow,
  registry: Registry,
  inputs: Record<string, unknown>,
  options: RunOptions = {},
): Promise<RunResult> {
  validateFlow(flow, registry);
  validateInputs(flow, inputs);

  const order = topologicalOrder(flow);
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const scope: Record<string, unknown> = { inputs };
  const outcomes: NodeOutcome[] = [];
  const retries = options.retries ?? 0;
  const ctx = {
    cwd: options.cwd ?? process.cwd(),
    signal: options.signal ?? new AbortController().signal,
  };

  for (const id of order) {
    const node = byId.get(id)!;
    const started = Date.now();

    if (options.permit && !options.permit(node)) {
      outcomes.push({
        id,
        status: "held",
        error: {
          class: "permission_denied",
          message: `node ${id} (${node.use}) is not permitted`,
        },
        assertions: [],
        durationMs: Date.now() - started,
      });
      return { status: "held", nodes: outcomes };
    }

    const definition = registry.get(node.use)!;
    let output: unknown;
    let lastError: unknown;
    let succeeded = false;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        output = await definition.run(resolveInput(node.in, scope), ctx);
        succeeded = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!succeeded) {
      outcomes.push({
        id,
        status: "held",
        error: { class: "node_error", message: (lastError as Error).message },
        assertions: [],
        durationMs: Date.now() - started,
      });
      return { status: "held", nodes: outcomes };
    }

    const assertions = evaluateAssertions(node.assert ?? [], { ...scope, out: output });
    const failed = assertions.filter((outcome) => !outcome.passed);

    if (failed.length > 0) {
      outcomes.push({
        id,
        status: "held",
        output,
        error: { class: "assert_failed", message: failed.map((f) => f.detail).join("; ") },
        assertions,
        durationMs: Date.now() - started,
      });
      return { status: "held", nodes: outcomes };
    }

    scope[id] = output;
    outcomes.push({ id, status: "ok", output, assertions, durationMs: Date.now() - started });
  }

  return { status: "ok", nodes: outcomes };
}
