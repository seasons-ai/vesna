import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PRESETS, presetFor, type Preset } from "../providers/catalog";
import type { ModelPrice } from "../providers/cost";
import { readSettings, settingsPath, type GlobalSettings } from "./settings";

export type ProviderId = "anthropic" | "openai";

/**
 * `codex` reuses the credentials the Codex CLI already holds, so there is no
 * sign-in flow and no client identity to supply; `subscription` is Vesna's own
 * OAuth, for whoever brings one.
 */
export type AuthMode = "key" | "subscription" | "codex";

/** What the Codex subscription endpoint serves today. */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

export interface VesnaConfig {
  /**
   * Whether there is something to work with — a project config, machine-wide
   * settings, or both. A directory with neither is still usable (the preset's
   * own default applies), but a caller that needs credentials should say so.
   */
  configured: boolean;
  /** The resolved service, from the catalog. */
  preset: Preset;
  /** True when the project config names a provider, so a command can say it cannot change it here. */
  pinned: boolean;
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
    /** plan changes nothing; ask questions each new action; auto allows all but the irreversible. */
    mode?: "plan" | "ask" | "auto";
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

export async function loadConfig(
  root: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Promise<VesnaConfig> {
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

  const machinePath = settingsPath(env, home);
  const settings = readSettings(machinePath);

  const pinned = typeof raw.provider === "string" && raw.provider !== "";
  const named = (pinned ? (raw.provider as string) : undefined) ?? settings.provider;
  const providerName = named ?? "anthropic";
  const resolved = presetFor(providerName, typeof raw.auth === "string" ? raw.auth : undefined);

  if (resolved === undefined) {
    // Same reason malformed YAML above is a throw: silently falling back to a
    // default turns a typo into a mystery. `provider: gruq` used to resolve to
    // Anthropic without a word, so the failure surfaced much later as a
    // service nobody chose — for the one field this whole file is about.
    throw new Error(
      `${pinned ? path : machinePath} names an unknown provider "${providerName}" — ` +
        `valid ids: ${PRESETS.map((entry) => entry.id).join(", ")}`,
    );
  }
  const preset = resolved;

  // Provider, model and address are one tuple, not three keys that happen to
  // live in the same file. The machine settings describe exactly one service,
  // so a project naming a different one inherits nothing from them: pinning
  // `provider: openai` while the machine points at Groq would otherwise post
  // this project's OPENAI_API_KEY to api.groq.com — the two halves of one
  // request taken from two different services.
  const machine: GlobalSettings =
    settings.provider !== undefined && settings.provider === preset.id ? settings : {};

  const model = raw.model ?? machine.model ?? preset.model;
  const baseUrl = raw.baseUrl ?? machine.baseUrl ?? preset.baseUrl;

  return {
    // `configured` used to mean "a project file exists". It now means "there
    // is something to work with", which is the question every caller was
    // actually asking.
    configured: text !== null || settings.provider !== undefined,
    preset,
    pinned,
    provider: preset.dialect === "anthropic" ? "anthropic" : "openai",
    auth: preset.auth ?? "key",
    model,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
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

function describe(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  return typeof value;
}

/** Whether a node exists for the agent at all. Nothing listed means all of them. */
export function permits(config: VesnaConfig, node: string): boolean {
  return config.permissions.nodes === undefined || config.permissions.nodes.includes(node);
}
