import { estimateCostUsd } from "../providers/cost";
import { DEFAULT_MODEL, type Provider, type Usage } from "../providers/types";
import type { NodeDef } from "../registry/types";

export function createLlmNode(
  provider: Provider,
): NodeDef<
  { prompt: string; model?: string; system?: string },
  { text: string; usage: Usage; costUsd: number }
> {
  return {
    type: "llm",
    effect: "pure",
    async run(input) {
      const model = input.model ?? DEFAULT_MODEL;
      const result = await provider.complete({
        model,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
      });

      const text = result.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("");

      return { text, usage: result.usage, costUsd: estimateCostUsd(model, result.usage) };
    },
  };
}
