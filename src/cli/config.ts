import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModelPrice } from "../providers/cost";
import { DEFAULT_MODEL } from "../providers/types";

export type ProviderId = "anthropic" | "openai";

export interface VesnaConfig {
  provider: ProviderId;
  model: string;
  /** Only meaningful for the openai-compatible provider. */
  baseUrl?: string;
  theme: string;
  /** Per-model prices for anything Vesna does not ship rates for. */
  prices: Record<string, ModelPrice>;
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
    model: raw.model ?? (provider === "anthropic" ? DEFAULT_MODEL : "gpt-4o-mini"),
    baseUrl: raw.baseUrl,
    theme: raw.theme ?? "vesna",
    prices: raw.prices ?? {},
    // Permissions are the registry: no node, no capability.
    permissions: { nodes: raw.permissions?.nodes ?? ["read", "write", "shell", "script", "llm"] },
  };
}
