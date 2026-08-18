import { join } from "node:path";
import { registerBuiltins } from "../nodes";
import { createLlmNode } from "../nodes/llm";
import { createAnthropicProvider } from "../providers/anthropic";
import { createOpenAICompatibleProvider } from "../providers/openai";
import { createResponsesProvider } from "../providers/responses";
import { createTokenSource } from "../auth/token";
import { codexAuthPath, createCodexTokenSource, readCodexAuth } from "../auth/codex";
import { authPath } from "../auth/store";
import { homedir } from "node:os";
import { createRegistry } from "../registry/registry";
import { createTraceStore } from "../store/trace";
import { colorSupported, resolveTheme } from "../tui/theme";
import { loadConfig, type VesnaConfig } from "./config";

/** The subscription endpoint the Codex CLI talks to. */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

async function buildProvider(config: VesnaConfig) {
  if (config.provider !== "openai") return createAnthropicProvider();

  if (config.auth === "codex") {
    // Borrowed credentials: read on every call, never written, never refreshed.
    const path = codexAuthPath(process.env, homedir());
    const auth = await readCodexAuth(path);
    return createResponsesProvider({
      id: "openai",
      baseUrl: config.baseUrl ?? CODEX_BASE_URL,
      token: createCodexTokenSource({ path }),
      alwaysStream: true,
      ...(auth?.accountId ? { accountId: auth.accountId } : {}),
    });
  }

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
  const provider = await buildProvider(config);
  const registry = createRegistry();
  registerBuiltins(registry);
  registry.register(createLlmNode(provider, config.prices));
  const store = createTraceStore(join(root, ".vesna", "traces"));
  const theme = resolveTheme(config.theme, {
    color: colorSupported(process.env, Boolean(process.stdout.isTTY)),
  });
  return { registry, store, config, provider, theme };
}
