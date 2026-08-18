import { estimateCostUsd, type ModelPrice } from "../providers/cost";
import {
  DEFAULT_MODEL,
  textOf,
  toolCallsOf,
  type AgentMessage,
  type ContentBlock,
  type Provider,
  type Usage,
} from "../providers/types";
import { toolSpecs } from "../registry/registry";
import type { Registry } from "../registry/types";
import { fingerprint, type LiveTrace, type TraceStep } from "./trace";

export interface LiveOptions {
  cwd: string;
  model?: string;
  maxTurns?: number;
  permit?: (type: string) => boolean;
  /** Prices for models Vesna does not ship rates for. */
  prices?: Record<string, ModelPrice>;
  /** Called after each tool call so a front end can render progress. */
  onStep?: (step: TraceStep) => void;
}

/**
 * A manual agentic loop rather than the SDK tool runner: every tool call is
 * recorded as a typed node invocation with its input and output, and that
 * recording is exactly what the crystallizer later consumes.
 */
export async function runLive(
  prompt: string,
  provider: Provider,
  registry: Registry,
  options: LiveOptions,
): Promise<LiveTrace> {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTurns = options.maxTurns ?? 24;
  const tools = toolSpecs(registry);
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: prompt }] },
  ];
  const steps: TraceStep[] = [];
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const ctx = { cwd: options.cwd, signal: new AbortController().signal };
  let finalText = "";

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await provider.complete({ model, messages, tools });

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.cacheReadTokens += response.usage.cacheReadTokens;
    usage.cacheWriteTokens += response.usage.cacheWriteTokens;

    const toolUses = toolCallsOf(response.content);
    finalText = textOf(response.content);

    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const results: ContentBlock[] = [];

    for (const use of toolUses) {
      if (options.permit && !options.permit(use.name)) {
        results.push({
          type: "tool_result",
          callId: use.id,
          content: `permission denied for ${use.name}`,
          isError: true,
        });
        continue;
      }

      const definition = registry.get(use.name);
      if (!definition) {
        results.push({
          type: "tool_result",
          callId: use.id,
          content: `unknown tool ${use.name}`,
          isError: true,
        });
        continue;
      }

      const started = Date.now();
      try {
        const output = await definition.run(use.input, ctx);
        const step: TraceStep = {
          id: use.id,
          nodeType: use.name,
          input: use.input,
          output,
          durationMs: Date.now() - started,
        };
        steps.push(step);
        options.onStep?.(step);
        results.push({ type: "tool_result", callId: use.id, content: JSON.stringify(output) });
      } catch (error) {
        results.push({
          type: "tool_result",
          callId: use.id,
          content: (error as Error).message,
          isError: true,
        });
      }
    }

    messages.push({ role: "user", content: results });
  }

  return {
    prompt,
    steps,
    finalText,
    usage,
    costUsd: estimateCostUsd(model, usage, options.prices ?? {}),
    environment: await fingerprint(options.cwd),
  };
}
