import { join } from "node:path";
import { registerBuiltins } from "../nodes";
import { createLlmNode } from "../nodes/llm";
import { createAnthropicProvider } from "../providers/anthropic";
import { createOpenAICompatibleProvider } from "../providers/openai";
import { createResponsesProvider } from "../providers/responses";
import { createTokenSource } from "../auth/token";
import { authPath } from "../auth/store";
import { homedir } from "node:os";
import { createRegistry } from "../registry/registry";
import { createTraceStore } from "../store/trace";
import { colorSupported, resolveTheme } from "../tui/theme";
import { loadConfig, type VesnaConfig } from "./config";

function buildProvider(config: VesnaConfig) {
  if (config.provider !== "openai") return createAnthropicProvider();

  if (config.auth === "subscription") {
    if (!config.oauth) {
      throw new Error(
        "auth: subscription needs an oauth block in .vesna/config.yaml (issuer, clientId, baseUrl)",
      );
    }
    // A subscription token is only accepted by the Responses endpoint.
    return createResponsesProvider({
      id: "openai",
      baseUrl: config.oauth.baseUrl,
      token: createTokenSource({
        path: authPath(process.env, homedir()),
        issuer: config.oauth.issuer,
        clientId: config.oauth.clientId,
      }),
    });
  }

  return createOpenAICompatibleProvider({ baseUrl: config.baseUrl, id: "openai" });
}

export async function buildContext(root: string) {
  const config = await loadConfig(root);
  const provider = buildProvider(config);
  const registry = createRegistry();
  registerBuiltins(registry);
  registry.register(createLlmNode(provider, config.prices));
  const store = createTraceStore(join(root, ".vesna", "traces"));
  const theme = resolveTheme(config.theme, {
    color: colorSupported(process.env, Boolean(process.stdout.isTTY)),
  });
  return { registry, store, config, provider, theme };
}
