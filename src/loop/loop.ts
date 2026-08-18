import { estimateCostUsd } from "../providers/cost";
import { DEFAULT_MODEL, type Provider, type ToolSpec, type Usage } from "../providers/types";
import type { Registry } from "../registry/types";
import { fingerprint, type LiveTrace, type TraceStep } from "./trace";

export interface LiveOptions {
  schemas: Record<string, ToolSpec>;
  cwd: string;
  model?: string;
  maxTurns?: number;
  permit?: (type: string) => boolean;
}

export function toolSpecsFrom(registry: Registry, schemas: Record<string, ToolSpec>): ToolSpec[] {
  return registry.list().flatMap((type) => (schemas[type] ? [schemas[type]!] : []));
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
  const tools = toolSpecsFrom(registry, options.schemas);
  const messages: any[] = [{ role: "user", content: prompt }];
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

    const toolUses = response.content.filter((block: any) => block.type === "tool_use");
    finalText = response.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("");

    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const results: any[] = [];

    for (const use of toolUses as any[]) {
      if (options.permit && !options.permit(use.name)) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `permission denied for ${use.name}`,
          is_error: true,
        });
        continue;
      }

      const definition = registry.get(use.name);
      if (!definition) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `unknown tool ${use.name}`,
          is_error: true,
        });
        continue;
      }

      const started = Date.now();
      try {
        const output = await definition.run(use.input, ctx);
        steps.push({
          id: use.id,
          nodeType: use.name,
          input: use.input,
          output,
          durationMs: Date.now() - started,
        });
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(output) });
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: (error as Error).message,
          is_error: true,
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
    costUsd: estimateCostUsd(model, usage),
    environment: await fingerprint(options.cwd),
  };
}
