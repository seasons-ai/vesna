import type { Usage } from "./types";

/** USD per million tokens. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function estimateCostUsd(model: string, usage: Usage): number {
  const price = PRICES[model];
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
