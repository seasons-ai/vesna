import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MODEL,
  type AgentMessage,
  type CompletionRequest,
  type CompletionResult,
  type ContentBlock,
  type Provider,
} from "./types";

/** Neutral content -> Anthropic wire content. */
export function toAnthropicMessages(messages: AgentMessage[]): any[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "tool_call") {
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      }
      return {
        type: "tool_result",
        tool_use_id: block.callId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
    }),
  }));
}

/** Anthropic wire content -> neutral content. Unknown block types are dropped. */
export function fromAnthropicContent(content: any[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block?.type === "text") blocks.push({ type: "text", text: block.text });
    else if (block?.type === "tool_use") {
      blocks.push({ type: "tool_call", id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return blocks;
}

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
        messages: toAnthropicMessages(request.messages) as any,
      });

      // The stream was already open; the deltas were simply being discarded.
      if (request.onText) stream.on("text", (delta: string) => request.onText!(delta));

      const message = await stream.finalMessage();

      return {
        content: fromAnthropicContent(message.content as any[]),
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
