import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelPrice } from "../providers/cost";
import { DEFAULT_MODEL } from "../providers/types";

export type ProviderId = "anthropic" | "openai";

/**
 * `codex` reuses the credentials the Codex CLI already holds, so there is no
 * sign-in flow and no client identity to supply; `subscription` is Vesna's own
 * OAuth, for whoever brings one.
 */
export type AuthMode = "key" | "subscription" | "codex";

/** What the Codex subscription endpoint serves today. */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";
const AUTH_MODES: AuthMode[] = ["key", "subscription", "codex"];

export interface VesnaConfig {
  provider: ProviderId;
  /** How to authenticate the provider. Only the openai provider has a choice. */
  auth: AuthMode;
  model: string;
  /** Only meaningful for the openai-compatible provider. */
  baseUrl?: string;
  theme: string;
  /** Per-model prices for anything Vesna does not ship rates for. */
  prices: Record<string, ModelPrice>;
  /**
   * Subscription sign-in settings. Vesna ships no OAuth client identity of its
   * own or anyone else's, so whoever uses this mode supplies one.
   */
  oauth?: { issuer: string; clientId: string; baseUrl: string; scope?: string };
  permissions: { nodes: string[] };
  /**
   * Three states matter and the middle one is the default, so it cannot be a
   * plain boolean: unset means "ask the locale", true/false override it.
   */
  ascii?: boolean;
}

export async function loadConfig(root: string): Promise<VesnaConfig> {
  let raw: any = {};
  try {
    raw = parseYaml(await readFile(join(root, ".vesna", "config.yaml"), "utf8")) ?? {};
  } catch {
    raw = {};
  }
  const provider: ProviderId = raw.provider === "openai" ? "openai" : "anthropic";
  const auth: AuthMode = AUTH_MODES.includes(raw.auth) ? raw.auth : "key";
  return {
    provider,
    auth,
    model: raw.model ?? defaultModel(provider, auth),
    baseUrl: raw.baseUrl,
    theme: raw.theme ?? "vesna",
    prices: raw.prices ?? {},
    oauth: raw.oauth,
    // Permissions are the registry: no node, no capability.
    permissions: { nodes: raw.permissions?.nodes ?? ["read", "write", "shell", "script", "llm"] },
    ascii: raw.ascii === true ? true : raw.ascii === false ? false : undefined,
  };
}

function defaultModel(provider: ProviderId, auth: AuthMode): string {
  if (provider === "anthropic") return DEFAULT_MODEL;
  return auth === "codex" ? CODEX_DEFAULT_MODEL : "gpt-4o-mini";
}
