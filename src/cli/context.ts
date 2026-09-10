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
import { readProjectNotes } from "../loop/prompt";
import { loadPolicy } from "../policy/store";
import { createSink } from "../spec/sink";
import { specsRoot } from "../spec/store";
import { createPlanNodes } from "../nodes/plan";
import { colorDepth, resolveTheme } from "../tui/theme";
import { loadConfig } from "./config";
import { CODEX_BASE_URL, type Preset } from "../providers/catalog";
import type { Provider } from "../providers/types";

export { CODEX_BASE_URL } from "../providers/catalog";

export interface ProviderHandle extends Provider {
  readonly preset: Preset;
  readonly model: string;
  switch(preset: Preset, model: string, baseUrl?: string): Promise<void>;
}

export type BuildProvider = (preset: Preset, baseUrl: string | undefined) => Promise<Provider>;

/**
 * Builds the provider a preset names.
 *
 * The `oauth` block is optional because most presets never need it — it only
 * matters for `auth: "subscription"`, where Vesna ships no client identity of
 * its own and the caller's `.vesna/config.yaml` must supply one.
 */
export async function buildProviderFor(
  preset: Preset,
  baseUrl: string | undefined,
  oauth?: { issuer: string; clientId: string; baseUrl: string; scope?: string },
): Promise<Provider> {
  if (preset.dialect === "anthropic") return createAnthropicProvider();

  if (preset.dialect === "responses" && preset.auth === "codex") {
    // Borrowed credentials: read on every call, never written, never refreshed.
    const path = codexAuthPath(process.env, homedir());
    const auth = await readCodexAuth(path);
    return createResponsesProvider({
      id: preset.id,
      baseUrl: baseUrl ?? preset.baseUrl ?? CODEX_BASE_URL,
      token: createCodexTokenSource({ path }),
      alwaysStream: true,
      ...(auth?.accountId ? { accountId: auth.accountId } : {}),
    });
  }

  if (preset.dialect === "responses" && preset.auth === "subscription") {
    if (!oauth) {
      throw new Error(
        "auth: subscription needs an oauth block in .vesna/config.yaml (issuer, clientId, baseUrl)",
      );
    }
    // A subscription token is only accepted by the Responses endpoint.
    return createResponsesProvider({
      id: preset.id,
      baseUrl: oauth.baseUrl,
      token: createTokenSource({
        path: authPath(process.env, homedir()),
        issuer: oauth.issuer,
        clientId: oauth.clientId,
      }),
    });
  }

  return createOpenAICompatibleProvider({ baseUrl: baseUrl ?? preset.baseUrl, id: preset.id });
}

/**
 * One reference the rest of the program holds, pointing at a provider that can
 * change underneath it.
 *
 * It satisfies Provider itself, so the llm node and every other consumer keep
 * the signature they have. Rebuilding the whole context on a switch would have
 * destroyed the registry, the spec sink and everything the session had
 * accumulated; threading `() => Provider` everywhere would have spread late
 * binding across every signature to make one point mutable.
 */
export async function createProviderHandle(
  preset: Preset,
  model: string,
  baseUrl: string | undefined,
  build: BuildProvider = buildProviderFor,
): Promise<ProviderHandle> {
  let current = await build(preset, baseUrl);
  let currentPreset = preset;
  let currentModel = model;

  return {
    get id() {
      return current.id;
    },
    get preset() {
      return currentPreset;
    },
    get model() {
      return currentModel;
    },
    complete(request) {
      return current.complete(request);
    },
    async switch(next, nextModel, nextBaseUrl) {
      // Build before assigning: a switch to something unreachable must leave
      // the conversation on the provider that still works.
      const built = await build(next, nextBaseUrl);
      current = built;
      currentPreset = next;
      currentModel = nextModel;
    },
  };
}

export async function buildContext(root: string) {
  const config = await loadConfig(root);
  const provider = await createProviderHandle(
    config.preset,
    config.model,
    config.baseUrl,
    (preset, baseUrl) => buildProviderFor(preset, baseUrl, config.oauth),
  );
  const registry = createRegistry();
  registerBuiltins(registry);
  registry.register(createLlmNode(provider, config.prices));

  // Registered once, bound to whichever spec is open at the time.
  const sink = createSink(specsRoot(root));
  for (const node of createPlanNodes(sink)) registry.register(node);
  const store = createTraceStore(join(root, ".vesna", "traces"));
  const theme = resolveTheme(config.theme, {
    depth: colorDepth(process.env, Boolean(process.stdout.isTTY)),
  });
  // Read once here so both `chat` and `do` get the same instructions.
  const notes = await readProjectNotes(root);
  const policy = await loadPolicy(root, config);
  return { registry, store, config, provider, theme, notes, policy, sink };
}
