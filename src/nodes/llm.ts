import { estimateCostUsd, type ModelPrice } from "../providers/cost";
import { DEFAULT_MODEL, textOf, type Provider, type Usage } from "../providers/types";
import type { NodeDef } from "../registry/types";

/**
 * The model this provider is currently set to, when it knows.
 *
 * `ProviderHandle` (src/cli/context.ts) carries one and the plain `Provider`
 * interface does not, so this is a structural read rather than an import: the
 * node takes a `Provider`, and a handle satisfies it.
 *
 * Read on every call. The node is registered once, in `buildContext`, while
 * `/provider` and `/model` move the handle underneath it for the rest of the
 * process — capturing the model here would be the same startup snapshot this
 * fixes, one layer down.
 */
function currentModel(provider: Provider): string | undefined {
  const model = (provider as { model?: unknown }).model;
  return typeof model === "string" && model !== "" ? model : undefined;
}

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
        model: { type: "string", description: "Model id; defaults to the one this session is using" },
        system: { type: "string" },
      },
      required: ["prompt"],
    },
    effect: "pure",
    async run(input) {
      const model = input.model ?? currentModel(provider) ?? DEFAULT_MODEL;
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
