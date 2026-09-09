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
import { systemPrompt } from "./prompt";
import { fingerprint, type LiveTrace, type TraceStep } from "./trace";

export interface SessionOptions {
  cwd: string;
  model?: string;
  maxTurns?: number;
  permit?: (type: string) => boolean;
  /**
   * Consulted before each tool call. `permit` decides which tools exist at
   * all; this decides whether this particular call may proceed, which is the
   * difference between "shell is on" and "you may run this command".
   */
  approve?: (action: {
    node: string;
    input: Record<string, unknown>;
    cwd: string;
    effect?: "pure" | "write" | "external";
  }) => Promise<"allow" | "deny">;
  prices?: Record<string, ModelPrice>;
  /** The project's own instructions, from .vesna/AGENTS.md. */
  notes?: string;
  /** Prior turns, when a stored conversation is being resumed. */
  history?: AgentMessage[];
  onStep?: (step: TraceStep) => void;
  /** Called as the model produces text, so a chat can render while it types. */
  onText?: (delta: string) => void;
  /** Cancels the turn: the provider request, and the loop between tool calls. */
  signal?: AbortSignal;
}

export interface TurnResult {
  /** Assistant text from this turn only. */
  text: string;
  /** Tool calls made during this turn only. */
  steps: TraceStep[];
}

/** Per-turn overrides. A chat binds fresh hooks and a fresh signal each turn. */
export interface TurnOptions {
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onStep?: (step: TraceStep) => void;
}

export interface Session {
  readonly messages: AgentMessage[];
  readonly steps: TraceStep[];
  readonly usage: Usage;
  readonly costUsd: number;
  send(text: string, turn?: TurnOptions): Promise<TurnResult>;
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
  // Offering a node the project forbids buys a wasted turn and a confusing
  // "permission denied": if it cannot be called, it is not a tool it has.
  const tools = toolSpecs(registry).filter(
    (tool) => options.permit === undefined || options.permit(tool.name),
  );

  // Built once: identical across turns, which is what makes it cacheable.
  const system = systemPrompt({
    cwd: options.cwd,
    platform: process.platform,
    now: new Date(),
    tools,
    notes: options.notes,
  });

  // Seeded rather than replayed: the model receives the conversation it had.
  const messages: AgentMessage[] = [...(options.history ?? [])];
  const steps: TraceStep[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  let firstPrompt = "";
  let lastText = "";

  async function send(text: string, turnOptions: TurnOptions = {}): Promise<TurnResult> {
    const signal = turnOptions.signal ?? options.signal;
    const onText = turnOptions.onText ?? options.onText;
    const onStep = turnOptions.onStep ?? options.onStep;
    const ctx = { cwd: options.cwd, signal: signal ?? new AbortController().signal };

    if (firstPrompt === "") firstPrompt = text;
    messages.push({ role: "user", content: [{ type: "text", text }] });

    const turnSteps: TraceStep[] = [];
    let turnText = "";

    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (signal?.aborted) break;
      const response = await provider.complete({
        model,
        system,
        messages,
        tools,
        onText,
        signal,
      });

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

        if (options.approve !== undefined) {
          const verdict = await options.approve({
            node: use.name,
            input: use.input,
            cwd: options.cwd,
            ...(registry.get(use.name) ? { effect: registry.get(use.name)!.effect } : {}),
          });
          if (verdict === "deny") {
            // Reported rather than thrown: a refusal is an answer, and the
            // model can still choose a different way to the same goal.
            results.push({
              type: "tool_result",
              callId: use.id,
              content: `refused by the user: ${use.name}`,
              isError: true,
            });
            continue;
          }
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
          onStep?.(step);
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
