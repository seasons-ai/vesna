import type {
  AgentMessage,
  CompletionRequest,
  CompletionResult,
  ContentBlock,
  Provider,
  ToolSpec,
} from "./types";
import { textOf } from "./types";
import { accumulateChatStream } from "./sse";

/**
 * Speaks the OpenAI chat-completions dialect over plain fetch. That protocol is
 * implemented identically by OpenAI, AIMLAPI, OpenRouter, DeepSeek, Together,
 * vLLM and Ollama, so one adapter with a configurable base URL covers all of
 * them. Pulling a vendor SDK for a single endpoint would only slow CLI startup.
 */
export interface OpenAICompatibleOptions {
  /** Defaults to https://api.openai.com/v1 */
  baseUrl?: string;
  apiKey?: string;
  /** Identifier reported in traces, e.g. "ollama" or "aimlapi". */
  id?: string;
  maxTokens?: number;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

export function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/** Neutral messages -> OpenAI messages. Tool results become their own turn. */
export function toOpenAIMessages(messages: AgentMessage[], system: string | undefined): unknown[] {
  const wire: unknown[] = [];
  if (system) wire.push({ role: "system", content: system });

  for (const message of messages) {
    const results = message.content.filter((block) => block.type === "tool_result");
    const rest = message.content.filter((block) => block.type !== "tool_result");

    if (rest.length > 0) {
      const calls = rest.filter((block) => block.type === "tool_call");
      const text = textOf(rest);
      wire.push({
        role: message.role,
        content: text.length > 0 ? text : null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((block) => ({
                id: block.type === "tool_call" ? block.id : "",
                type: "function",
                function: {
                  name: block.type === "tool_call" ? block.name : "",
                  arguments: JSON.stringify(block.type === "tool_call" ? block.input : {}),
                },
              })),
            }
          : {}),
      });
    }

    for (const result of results) {
      if (result.type !== "tool_result") continue;
      wire.push({ role: "tool", tool_call_id: result.callId, content: result.content });
    }
  }
  return wire;
}

/** An OpenAI assistant message -> neutral content. */
export function fromOpenAIMessage(message: OpenAIMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      // A model can emit invalid JSON here; an empty object is recoverable,
      // a thrown parse error in the middle of an agent loop is not.
      const parsed = JSON.parse(call.function.arguments);
      if (parsed && typeof parsed === "object") input = parsed;
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_call", id: call.id, name: call.function.name, input });
  }
  return blocks;
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions = {}): Provider {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

  return {
    id: options.id ?? "openai",
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens ?? options.maxTokens ?? 8192,
          messages: toOpenAIMessages(request.messages, request.system),
          ...(request.tools ? { tools: toOpenAITools(request.tools) } : {}),
          ...(request.onText ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 400);
        throw new Error(`${this.id} returned ${response.status}: ${detail}`);
      }

      if (request.onText) {
        if (!response.body) throw new Error(`${this.id} returned an empty stream`);
        const streamed = await accumulateChatStream(response.body, request.onText);
        return {
          content: fromOpenAIMessage(streamed.message),
          stopReason: streamed.finishReason,
          model: streamed.model ?? request.model,
          usage: {
            inputTokens: streamed.usage.prompt_tokens ?? 0,
            outputTokens: streamed.usage.completion_tokens ?? 0,
            cacheReadTokens: streamed.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
          },
        };
      }

      const body: any = await response.json();
      const choice = body.choices?.[0];
      if (!choice) throw new Error(`${this.id} returned no choices`);

      const usage = body.usage ?? {};
      return {
        content: fromOpenAIMessage(choice.message ?? { role: "assistant", content: null }),
        stopReason: choice.finish_reason ?? null,
        model: body.model ?? request.model,
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}
