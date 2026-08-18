import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelPrice } from "../providers/cost";
import { DEFAULT_MODEL } from "../providers/types";

export type ProviderId = "anthropic" | "openai";

export type AuthMode = "key" | "subscription";

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
}

export async function loadConfig(root: string): Promise<VesnaConfig> {
  let raw: any = {};
  try {
    raw = parseYaml(await readFile(join(root, ".vesna", "config.yaml"), "utf8")) ?? {};
  } catch {
    raw = {};
  }
  const provider: ProviderId = raw.provider === "openai" ? "openai" : "anthropic";
  return {
    provider,
    auth: raw.auth === "subscription" ? "subscription" : "key",
    model: raw.model ?? (provider === "anthropic" ? DEFAULT_MODEL : "gpt-4o-mini"),
    baseUrl: raw.baseUrl,
    theme: raw.theme ?? "vesna",
    prices: raw.prices ?? {},
    oauth: raw.oauth,
    // Permissions are the registry: no node, no capability.
    permissions: { nodes: raw.permissions?.nodes ?? ["read", "write", "shell", "script", "llm"] },
  };
}
