/**
 * Server-sent events, as the chat-completions protocol uses them. Written here
 * rather than pulled in, because the only shape we need is `data:` lines and
 * every compatible host emits exactly that.
 */
export async function* parseSseLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");

      if (line === "" || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      yield payload;
    }
  }
}

export interface StreamedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface StreamedMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: StreamedToolCall[];
}

export interface AccumulatedChat {
  message: StreamedMessage;
  finishReason: string | null;
  model: string | undefined;
  usage: Record<string, any>;
}

/**
 * Folds a chat-completions stream into one message, calling `onText` for each
 * text delta so a front end can render as the model types. Tool calls arrive in
 * fragments keyed by index and are joined here.
 */
export async function accumulateChatStream(
  stream: ReadableStream<Uint8Array>,
  onText: (delta: string) => void,
): Promise<AccumulatedChat> {
  let text = "";
  let finishReason: string | null = null;
  let model: string | undefined;
  let usage: Record<string, any> = {};
  const calls = new Map<number, StreamedToolCall>();

  for await (const payload of parseSseLines(stream)) {
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      // One bad frame must not lose the rest of the answer.
      continue;
    }

    if (event.model) model = event.model;
    if (event.usage) usage = event.usage;

    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      text += delta.content;
      onText(delta.content);
    }

    for (const fragment of delta.tool_calls ?? []) {
      const index = fragment.index ?? 0;
      const existing = calls.get(index) ?? {
        id: "",
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (fragment.id) existing.id = fragment.id;
      if (fragment.function?.name) existing.function.name = fragment.function.name;
      if (fragment.function?.arguments) {
        existing.function.arguments += fragment.function.arguments;
      }
      calls.set(index, existing);
    }
  }

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);

  return {
    message: {
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    finishReason,
    model,
    usage,
  };
}
