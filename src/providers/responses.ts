import type {
  AgentMessage,
  CompletionRequest,
  CompletionResult,
  ContentBlock,
  Provider,
  ToolSpec,
} from "./types";
import { textOf } from "./types";
import { parseSseLines } from "./sse";

/**
 * The Responses dialect. A ChatGPT subscription token is accepted only here —
 * the subscription endpoint does not speak chat/completions — so this is a third
 * translation alongside Anthropic's and OpenAI's chat format.
 *
 * Shapes taken from the official SDK's type definitions, not from memory.
 */

export function toResponsesTools(tools: ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }));
}

/** Neutral messages -> the flat `input` item array the Responses API expects. */
export function toResponsesInput(messages: AgentMessage[]): unknown[] {
  const items: unknown[] = [];

  for (const message of messages) {
    const text = textOf(message.content);
    if (text.length > 0) items.push({ role: message.role, content: text });

    for (const block of message.content) {
      if (block.type === "tool_call") {
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        items.push({
          type: "function_call_output",
          call_id: block.callId,
          output: block.content,
        });
      }
    }
  }
  return items;
}

/** The `output` item array -> neutral content. Unknown item types are ignored. */
export function fromResponsesOutput(output: any[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const item of output ?? []) {
    if (item?.type === "message") {
      for (const part of item.content ?? []) {
        if (part?.type === "output_text" && part.text) {
          blocks.push({ type: "text", text: part.text });
        } else if (part?.type === "refusal" && part.refusal) {
          // A refusal is the model's answer, not an absence of one.
          blocks.push({ type: "text", text: part.refusal });
        }
      }
      continue;
    }

    if (item?.type === "function_call") {
      let input: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(item.arguments ?? "{}");
        if (parsed && typeof parsed === "object") input = parsed;
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_call", id: item.call_id, name: item.name, input });
    }
  }
  return blocks;
}

export interface ResponsesProviderOptions {
  /** e.g. https://chatgpt.com/backend-api/codex for a subscription token. */
  baseUrl: string;
  /** Resolved per call, so a refreshed token is picked up without rebuilding. */
  token: () => Promise<string>;
  id?: string;
  /** Sent as chatgpt-account-id when the endpoint requires it. */
  accountId?: string;
  /** The subscription endpoint serves streaming responses only. */
  alwaysStream?: boolean;
  maxTokens?: number;
}

export function createResponsesProvider(options: ResponsesProviderOptions): Provider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  return {
    id: options.id ?? "responses",
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const token = await options.token();
      const onText = request.onText ?? (options.alwaysStream ? () => {} : undefined);

      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(options.accountId ? { "chatgpt-account-id": options.accountId } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          ...(request.system ? { instructions: request.system } : {}),
          input: toResponsesInput(request.messages),
          // The subscription endpoint rejects anything else, and not retaining
          // turns server-side is the right default for the API path too.
          store: false,
          ...(request.tools ? { tools: toResponsesTools(request.tools) } : {}),
          ...(request.maxTokens ?? options.maxTokens
            ? { max_output_tokens: request.maxTokens ?? options.maxTokens }
            : {}),
          ...(onText ? { stream: true } : {}),
        }),
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 400);
        throw new Error(`${this.id} returned ${response.status}: ${detail}`);
      }

      // Each item is delivered whole when it finishes, so the fragments of a
      // function call never have to be reassembled by hand.
      const body: any = onText
        ? await readStreamedResponse(response, onText, this.id)
        : await response.json();

      const usage = body.usage ?? {};

      return {
        content: fromResponsesOutput(body.output ?? []),
        stopReason: body.status ?? null,
        model: body.model ?? request.model,
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}

async function readStreamedResponse(
  response: Response,
  onText: (delta: string) => void,
  id: string,
): Promise<any> {
  if (!response.body) throw new Error(`${id} returned an empty stream`);

  let final: any = null;
  const items: { index: number; item: any }[] = [];

  for await (const payload of parseSseLines(response.body)) {
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue; // one bad frame must not cost the rest of the answer
    }

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      onText(event.delta);
    } else if (event.type === "response.output_item.done" && event.item) {
      items.push({ index: event.output_index ?? items.length, item: event.item });
    } else if (event.type === "response.completed") {
      final = event.response;
    } else if (event.type === "response.failed" || event.type === "response.incomplete") {
      const detail = event.response?.error?.message ?? event.type;
      throw new Error(`${id} did not complete: ${detail}`);
    }
  }

  if (final === null) throw new Error(`${id} stream ended without a completed response`);

  // With store:false the completed event carries an empty output, so the items
  // gathered on the way are the only record of the turn.
  if (!Array.isArray(final.output) || final.output.length === 0) {
    items.sort((a, b) => a.index - b.index);
    return { ...final, output: items.map((entry) => entry.item) };
  }
  return final;
}
