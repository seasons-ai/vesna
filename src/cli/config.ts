import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PRESETS, presetFor, type Preset } from "../providers/catalog";
import type { ModelPrice } from "../providers/cost";
import { SERVER_KEY, type McpEffect, type McpServerConfig } from "../mcp/types";
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
  /**
   * Why the machine settings could not be used, when they could not.
   *
   * `~/.vesna/settings.yaml` is Vesna's own file, and `readSettings` already
   * tolerates a corrupt one rather than stranding the user with no way in. A
   * value in it that no preset matches is the same kind of trouble, so it does
   * not throw either: the settings are ignored, the preset falls back, and the
   * reason is carried here for the commands that actually need a service to
   * refuse with (see `needsProvider` in src/cli/main.ts). A provider the
   * *project* file names is still a throw — a human wrote that one on purpose.
   */
  settingsProblem?: string;
  /** Servers by key, from the `mcp:` section. Undefined when the section is absent. */
  mcp?: Record<string, McpServerConfig>;
  /** One line per skipped server, in the exact wording `settingsProblem` models. */
  mcpProblems?: string[];
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

  // Silently falling back to a default turns a typo into a mystery:
  // `provider: gruq` used to resolve to Anthropic without a word, so the
  // failure surfaced much later as a service nobody chose. Both branches below
  // still say so; they differ only in when.
  let settingsProblem: string | undefined;
  let preset: Preset;
  if (resolved !== undefined) {
    preset = resolved;
  } else if (pinned) {
    // A human wrote this line, in this directory, on purpose.
    throw new Error(unknownProvider(path, providerName));
  } else {
    // Vesna's own file. Throwing here ran before `route` ever saw the
    // arguments, so a one-character typo in it made `vesna --help`,
    // `--version`, `doctor` and `run --dry-run` all exit 2 — the exact
    // breakage src/cli/entry.ts exists to prevent, from a file the user may
    // not know exists. The settings are dropped, the built-in default stands
    // in, and the reason travels on the config for whoever needs a service.
    settingsProblem = unknownProvider(machinePath, providerName);
    preset = presetFor("anthropic", undefined)!;
  }

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

  const { servers: mcp, problems: mcpProblems } = parseMcp(raw);

  return {
    // `configured` used to mean "a project file exists". It now means "there
    // is something to work with", which is the question every caller was
    // actually asking.
    configured: text !== null || settings.provider !== undefined,
    preset,
    ...(settingsProblem !== undefined ? { settingsProblem } : {}),
    ...(raw.mcp !== undefined ? { mcp } : {}),
    ...(mcpProblems.length > 0 ? { mcpProblems } : {}),
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

/**
 * One wording for both files, so the only difference between them is which
 * path is named — and the list, because the fix has to be guessable from the
 * message.
 */
function unknownProvider(path: string, name: string): string {
  return (
    `${path} names an unknown provider "${name}" — ` +
    `valid ids: ${PRESETS.map((entry) => entry.id).join(", ")}`
  );
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  return typeof value;
}

/** Passed-through environment variable names, not values — never lower-case,
 * never a stray symbol a shell would choke on. */
/** A variable's name, in either case: `http_proxy` is as much a name as `GITHUB_TOKEN`. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The `mcp:` section, pure: `raw` in, servers and problems out. A malformed
 * entry is one problem line and the whole entry is skipped — the others
 * still load. Checked in a fixed order (key, then command, then tools, then
 * env) so an entry wrong in more than one way still gets exactly one line.
 */
export function parseMcp(raw: unknown): { servers: Record<string, McpServerConfig>; problems: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const problems: string[] = [];

  const mcp = (raw as { mcp?: unknown } | null)?.mcp;
  if (mcp === undefined || mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) {
    return { servers, problems };
  }

  for (const [key, value] of Object.entries(mcp as Record<string, unknown>)) {
    const entry = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;

    if (!SERVER_KEY.test(key)) {
      problems.push(`mcp ${key}: key must match ${SERVER_KEY.source}`);
      continue;
    }

    if (typeof entry.command !== "string" || entry.command === "") {
      problems.push(`mcp ${key}: no command`);
      continue;
    }
    const command = entry.command;

    const toolsRaw = entry.tools;
    let toolProblem: string | undefined;
    const tools: Record<string, McpEffect> = {};
    if (toolsRaw !== undefined && toolsRaw !== null && typeof toolsRaw === "object" && !Array.isArray(toolsRaw)) {
      for (const [tool, effect] of Object.entries(toolsRaw as Record<string, unknown>)) {
        if (effect !== "pure" && effect !== "write") {
          toolProblem = `mcp ${key}: tools.${tool}: effect must be pure or write`;
          break;
        }
        tools[tool] = effect;
      }
    }
    if (toolProblem !== undefined) {
      problems.push(toolProblem);
      continue;
    }

    const envRaw = entry.env;
    let env: string[] = [];
    if (envRaw !== undefined) {
      const valid =
        Array.isArray(envRaw) && envRaw.every((name) => typeof name === "string" && ENV_NAME.test(name));
      if (!valid) {
        problems.push(`mcp ${key}: env must be a list of names`);
        continue;
      }
      env = envRaw as string[];
    }

    const argsRaw = entry.args;
    let args: string[] = [];
    if (argsRaw !== undefined) {
      // Checked here, as a config problem: an element that is not a string
      // would otherwise reach the spawn and surface as "could not start".
      if (!Array.isArray(argsRaw) || !argsRaw.every((arg) => typeof arg === "string")) {
        problems.push(`mcp ${key}: args must be a list of strings`);
        continue;
      }
      args = argsRaw as string[];
    }

    servers[key] = { command, args, env, tools };
  }

  return { servers, problems };
}

/**
 * Whether a node exists for the agent at all. Nothing listed means all of
 * them. The list names builtins: an MCP server's tools are opted in by naming
 * the server in the `mcp:` section, and the session skips this check for a
 * node whose `origin` is `"mcp"` — a server started for tools the model may
 * never see would be a server started for nothing.
 */
export function permits(config: VesnaConfig, node: string): boolean {
  return config.permissions.nodes === undefined || config.permissions.nodes.includes(node);
}
