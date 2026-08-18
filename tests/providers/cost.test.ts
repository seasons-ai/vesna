import { test, expect } from "bun:test";
import { estimateCostUsd } from "../../src/providers/cost";

const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

test("prices input tokens for the default model", () => {
  expect(estimateCostUsd("claude-opus-5", usage)).toBeCloseTo(5, 5);
});

test("prices output tokens", () => {
  expect(
    estimateCostUsd("claude-opus-5", { ...usage, inputTokens: 0, outputTokens: 1_000_000 }),
  ).toBeCloseTo(25, 5);
});

test("cache reads cost a tenth of input, cache writes cost 1.25x", () => {
  expect(
    estimateCostUsd("claude-opus-5", { ...usage, inputTokens: 0, cacheReadTokens: 1_000_000 }),
  ).toBeCloseTo(0.5, 5);
  expect(
    estimateCostUsd("claude-opus-5", { ...usage, inputTokens: 0, cacheWriteTokens: 1_000_000 }),
  ).toBeCloseTo(6.25, 5);
});

test("an unpriced model returns zero rather than throwing", () => {
  expect(estimateCostUsd("some-local-model", usage)).toBe(0);
});
