export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
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
  messages: any[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

export interface CompletionResult {
  content: any[];
  stopReason: string | null;
  usage: Usage;
  model: string;
}

export interface Provider {
  id: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export const DEFAULT_MODEL = "claude-opus-5";
