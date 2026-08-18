import { evaluateAssertions, type AssertionOutcome } from "../assert/evaluate";
import { resolveInput } from "../expr/resolve";
import { validateFlow, validateInputs } from "../flow/parse";
import type { Flow, FlowNode } from "../flow/types";
import type { Registry } from "../registry/types";
import type { EngineError } from "./errors";
import { topologicalOrder } from "./order";
import { effectOf, type Receipt } from "./receipt";

export type NodeStatus = "ok" | "held" | "failed";

export interface NodeOutcome {
  id: string;
  status: NodeStatus;
  output?: unknown;
  error?: EngineError;
  assertions: AssertionOutcome[];
  receipt?: Receipt;
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
  /** Receipts already recorded for this row; external nodes present here are not re-run. */
  receipts?: Record<string, Receipt>;
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
    const effect = effectOf(node, definition);
    const existing = options.receipts?.[id];

    // The receipt invariant: an external effect that already happened is never
    // repeated. Its recorded output is reused and re-checked instead.
    if (effect === "external" && existing) {
      const replayed = evaluateAssertions(node.assert ?? [], { ...scope, out: existing.output });
      const replayFailed = replayed.filter((outcome) => !outcome.passed);
      if (replayFailed.length > 0) {
        outcomes.push({
          id,
          status: "held",
          output: existing.output,
          error: { class: "assert_failed", message: replayFailed.map((f) => f.detail).join("; ") },
          assertions: replayed,
          receipt: existing,
          durationMs: 0,
        });
        return { status: "held", nodes: outcomes };
      }
      scope[id] = existing.output;
      outcomes.push({
        id,
        status: "ok",
        output: existing.output,
        assertions: replayed,
        receipt: existing,
        durationMs: 0,
      });
      continue;
    }

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

    const receipt: Receipt | undefined =
      effect === "external" ? { nodeId: id, at: new Date().toISOString(), output } : undefined;

    scope[id] = output;
    outcomes.push({
      id,
      status: "ok",
      output,
      assertions,
      receipt,
      durationMs: Date.now() - started,
    });
  }

  return { status: "ok", nodes: outcomes };
}
