import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MODEL,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
} from "./types";

export function createAnthropicProvider(options: { apiKey?: string } = {}): Provider {
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});

  return {
    id: "anthropic",
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      // Streaming is required because max_tokens is above 16000.
      // temperature / top_p / top_k are deliberately absent: they return 400.
      const stream = client.messages.stream({
        model: request.model || DEFAULT_MODEL,
        max_tokens: request.maxTokens ?? 64_000,
        thinking: { type: "adaptive" },
        ...(request.system ? { system: request.system } : {}),
        ...(request.tools ? { tools: request.tools as any } : {}),
        messages: request.messages,
      });

      const message = await stream.finalMessage();

      return {
        content: message.content,
        stopReason: message.stop_reason,
        model: message.model,
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
