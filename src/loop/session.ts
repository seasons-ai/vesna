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

export interface SessionOptions {
  cwd: string;
  model?: string;
  maxTurns?: number;
  permit?: (type: string) => boolean;
  prices?: Record<string, ModelPrice>;
  onStep?: (step: TraceStep) => void;
}

export interface TurnResult {
  /** Assistant text from this turn only. */
  text: string;
  /** Tool calls made during this turn only. */
  steps: TraceStep[];
}

export interface Session {
  readonly messages: AgentMessage[];
  readonly steps: TraceStep[];
  readonly usage: Usage;
  readonly costUsd: number;
  send(text: string): Promise<TurnResult>;
  toTrace(): Promise<LiveTrace>;
}

/**
 * A conversation that survives between messages. The agent loop used to own its
 * history and drop it on return, which made every request a cold start: a reply
 * that was nearly right could only be fixed by paying for the whole run again.
 */
export function createSession(
  provider: Provider,
  registry: Registry,
  options: SessionOptions,
): Session {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTurns = options.maxTurns ?? 24;
  const tools = toolSpecs(registry);

  const messages: AgentMessage[] = [];
  const steps: TraceStep[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const ctx = { cwd: options.cwd, signal: new AbortController().signal };

  let firstPrompt = "";
  let lastText = "";

  async function send(text: string): Promise<TurnResult> {
    if (firstPrompt === "") firstPrompt = text;
    messages.push({ role: "user", content: [{ type: "text", text }] });

    const turnSteps: TraceStep[] = [];
    let turnText = "";

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const response = await provider.complete({ model, messages, tools });

      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.cacheReadTokens += response.usage.cacheReadTokens;
      usage.cacheWriteTokens += response.usage.cacheWriteTokens;

      const calls = toolCallsOf(response.content);
      turnText = textOf(response.content);

      if (calls.length === 0) {
        messages.push({ role: "assistant", content: response.content });
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      const results: ContentBlock[] = [];

      for (const use of calls) {
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
          turnSteps.push(step);
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

    lastText = turnText;
    return { text: turnText, steps: turnSteps };
  }

  return {
    messages,
    steps,
    usage,
    get costUsd() {
      return estimateCostUsd(model, usage, options.prices ?? {});
    },
    send,
    async toTrace(): Promise<LiveTrace> {
      return {
        prompt: firstPrompt,
        steps,
        finalText: lastText,
        usage,
        costUsd: estimateCostUsd(model, usage, options.prices ?? {}),
        environment: await fingerprint(options.cwd),
      };
    },
  };
}
