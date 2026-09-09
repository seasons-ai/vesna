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
  /** Whether a .vesna/config.yaml was actually found. */
  configured: boolean;
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
  permissions: {
    /**
     * Which nodes exist for the agent. Undefined means all of them: a fixed
     * default list made every node added later invisible until the user edited
     * a config they never wrote. What an allowed node may actually do is the
     * approval layer's business now.
     */
    nodes?: string[];
    /** ask (default) questions each new action; auto allows all but the irreversible. */
    mode?: "ask" | "auto";
    allow?: Record<string, string[]>;
    deny?: Record<string, string[]>;
  };
  /**
   * Three states matter and the middle one is the default, so it cannot be a
   * plain boolean: unset means "ask the locale", true/false override it.
   */
  ascii?: boolean;
  /** Report the mouse so the wheel scrolls. Costs terminal text selection. */
  mouse?: boolean;
}

export async function loadConfig(root: string): Promise<VesnaConfig> {
  const path = join(root, ".vesna", "config.yaml");

  let text: string | null = null;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // No config is a legitimate state — plenty of commands need none. It is
    // only a problem once something asks for a model, and the caller decides.
    text = null;
  }

  let raw: any = {};
  if (text !== null) {
    try {
      raw = parseYaml(text) ?? {};
    } catch (error) {
      // Silently falling back to defaults turns a typo into a mystery: the
      // failure surfaces much later, as a provider that was never configured.
      throw new Error(`${path} is not valid YAML: ${(error as Error).message}`);
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${path} must be a mapping of settings, not ${describe(raw)}`);
    }
  }

  const provider: ProviderId = raw.provider === "openai" ? "openai" : "anthropic";
  const auth: AuthMode = AUTH_MODES.includes(raw.auth) ? raw.auth : "key";
  return {
    configured: text !== null,
    provider,
    auth,
    model: raw.model ?? defaultModel(provider, auth),
    baseUrl: raw.baseUrl,
    theme: raw.theme ?? "vesna",
    prices: raw.prices ?? {},
    oauth: raw.oauth,
    // Permissions are the registry: no node, no capability.
    permissions: {
      ...(Array.isArray(raw.permissions?.nodes) ? { nodes: raw.permissions.nodes } : {}),
      ...(raw.permissions?.mode ? { mode: raw.permissions.mode } : {}),
      ...(raw.permissions?.allow ? { allow: raw.permissions.allow } : {}),
      ...(raw.permissions?.deny ? { deny: raw.permissions.deny } : {}),
    },
    ascii: raw.ascii === true ? true : raw.ascii === false ? false : undefined,
    mouse: raw.mouse === false ? false : undefined,
  };
}

function defaultModel(provider: ProviderId, auth: AuthMode): string {
  if (provider === "anthropic") return DEFAULT_MODEL;
  return auth === "codex" ? CODEX_DEFAULT_MODEL : "gpt-4o-mini";
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  return typeof value;
}

/** Whether a node exists for the agent at all. Nothing listed means all of them. */
export function permits(config: VesnaConfig, node: string): boolean {
  return config.permissions.nodes === undefined || config.permissions.nodes.includes(node);
}
