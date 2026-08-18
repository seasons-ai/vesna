import { estimateCostUsd, type ModelPrice } from "../providers/cost";
import { DEFAULT_MODEL, textOf, type Provider, type Usage } from "../providers/types";
import type { NodeDef } from "../registry/types";

export function createLlmNode(
  provider: Provider,
  prices: Record<string, ModelPrice> = {},
): NodeDef<
  { prompt: string; model?: string; system?: string },
  { text: string; usage: Usage; costUsd: number }
> {
  return {
    type: "llm",
    description: "Ask a language model for text. Use only where judgement is required.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: { type: "string", description: "Model id; defaults to the configured one" },
        system: { type: "string" },
      },
      required: ["prompt"],
    },
    effect: "pure",
    async run(input) {
      const model = input.model ?? DEFAULT_MODEL;
      const result = await provider.complete({
        model,
        system: input.system,
        messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
      });

      const text = textOf(result.content);

      return { text, usage: result.usage, costUsd: estimateCostUsd(model, result.usage, prices) };
    },
  };
}
