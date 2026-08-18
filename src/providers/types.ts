export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Vesna's own content shape. Providers translate to and from their dialect at
 * the edge, so nothing above this line knows what a vendor calls a tool call.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean };

export interface AgentMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: AgentMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

export interface CompletionResult {
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
  model: string;
}

export interface Provider {
  id: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export const DEFAULT_MODEL = "claude-opus-5";

export function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function toolCallsOf(
  content: ContentBlock[],
): Extract<ContentBlock, { type: "tool_call" }>[] {
  return content.filter(
    (block): block is Extract<ContentBlock, { type: "tool_call" }> => block.type === "tool_call",
  );
}
