import type { Usage } from "./types";

/** USD per million tokens. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * `extra` comes from the user's config. Vesna ships prices only for models whose
 * rates it can state accurately; for anything else the user supplies them rather
 * than trusting a number this project invented.
 */
export function estimateCostUsd(
  model: string,
  usage: Usage,
  extra: Record<string, ModelPrice> = {},
): number {
  const price = extra[model] ?? PRICES[model];
  // A model with no published price (a local one, say) is reported as free
  // rather than throwing — cost accounting must never break a run.
  if (!price) return 0;

  const perInputToken = price.input / 1_000_000;
  return (
    usage.inputTokens * perInputToken +
    usage.outputTokens * (price.output / 1_000_000) +
    usage.cacheReadTokens * perInputToken * 0.1 +
    usage.cacheWriteTokens * perInputToken * 1.25
  );
}
