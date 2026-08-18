import { join } from "node:path";
import { registerBuiltins } from "../nodes";
import { createLlmNode } from "../nodes/llm";
import { createAnthropicProvider } from "../providers/anthropic";
import { createOpenAICompatibleProvider } from "../providers/openai";
import { createRegistry } from "../registry/registry";
import { createTraceStore } from "../store/trace";
import { colorSupported, resolveTheme } from "../tui/theme";
import { loadConfig } from "./config";

export async function buildContext(root: string) {
  const config = await loadConfig(root);
  const provider =
    config.provider === "openai"
      ? createOpenAICompatibleProvider({ baseUrl: config.baseUrl, id: "openai" })
      : createAnthropicProvider();
  const registry = createRegistry();
  registerBuiltins(registry);
  registry.register(createLlmNode(provider, config.prices));
  const store = createTraceStore(join(root, ".vesna", "traces"));
  const theme = resolveTheme(config.theme, {
    color: colorSupported(process.env, Boolean(process.stdout.isTTY)),
  });
  return { registry, store, config, provider, theme };
}
