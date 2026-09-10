import { codexAuthPath, readCodexAuth } from "../auth/codex";
import { authPath, isExpired, loadAuth } from "../auth/store";
import { configDir, credentialSource, listProfiles, type CredentialSource } from "./auth";
import type { VesnaConfig } from "./config";
import { needsAddress, type Preset } from "../providers/catalog";
import { CODEX_BASE_URL } from "./context";

/**
 * One answer to "can this provider actually authenticate?".
 *
 * `vesna auth` and the check that runs before a conversation both ask this, so
 * they cannot disagree — a status command that says you are signed in while
 * the next command fails is worse than no status command.
 */

export type Credential =
  | { mode: "codex"; state: "valid" | "expired" | "missing"; path: string; endpoint: string }
  | {
      mode: "subscription";
      state: "valid" | "expired" | "missing";
      path: string;
      endpoint: string | null;
    }
  | {
      mode: "openai-key";
      state: "valid" | "missing";
      reason: "key" | "local";
      endpoint: string;
      /**
       * Name of the variable this preset actually reads (e.g. `GROQ_API_KEY`).
       * Absent means either a preset that names none at all (a local server,
       * or "custom"), or — for older call sites that build a `Credential` by
       * hand — no opinion, in which case `problem`/`remedy` fall back to the
       * historical `OPENAI_API_KEY` wording.
       */
      env?: string;
    }
  | { mode: "anthropic"; source: CredentialSource; dir: string; profiles: string[] }
  /**
   * A preset with nowhere to send a request. There is no credential question
   * to answer yet — and, more to the point, no endpoint to report: the openai
   * dialect falls back to api.openai.com when it is given none, so this module
   * naming a host here would name the one host `needsAddress` exists to stop
   * anyone reaching by accident.
   */
  | { mode: "unaddressed"; id: string };

type Env = Record<string, string | undefined>;

export async function inspectCredential(
  config: VesnaConfig,
  env: Env,
  home: string,
): Promise<Credential> {
  if (config.provider === "openai" && config.auth === "codex") {
    const path = codexAuthPath(env, home);
    const auth = await readCodexAuth(path);
    const endpoint = config.baseUrl ?? CODEX_BASE_URL;

    if (auth?.accessToken === undefined) return { mode: "codex", state: "missing", path, endpoint };
    const expired = auth.expiresAt !== undefined && auth.expiresAt <= Date.now();
    return { mode: "codex", state: expired ? "expired" : "valid", path, endpoint };
  }

  if (config.provider === "openai" && config.auth === "subscription") {
    const path = authPath(env, home);
    const stored = await loadAuth(path);
    const endpoint = config.oauth?.baseUrl ?? null;

    if (stored === null) return { mode: "subscription", state: "missing", path, endpoint };
    const state = isExpired(stored, Date.now()) ? "expired" : "valid";
    return { mode: "subscription", state, path, endpoint };
  }

  if (config.provider === "openai") {
    // Before anything else, and asking the same question src/cli/context.ts
    // asks before it builds a provider. Skipping it is how `vesna auth`
    // reported `endpoint: https://api.openai.com/v1` and `credential: none
    // needed (local endpoint)` with exit 0 for an unaddressed `custom`, while
    // the very next command refused to build it at all — the disagreement the
    // header of this module says cannot happen.
    if (config.baseUrl === undefined && needsAddress(config.preset)) {
      return { mode: "unaddressed", id: config.preset.id };
    }

    const endpoint = config.baseUrl ?? "https://api.openai.com/v1";
    // `VesnaConfig.provider` collapses groq, openrouter, custom and openai
    // into one dialect value, so the actual variable to check has to come
    // from the resolved preset — not a name hardcoded for the openai preset.
    const envName = config.preset.env;

    if (envName === undefined) {
      // This preset names no variable at all: a local server (ollama,
      // lmstudio, vllm) or "custom" needs no credential of any kind.
      return { mode: "openai-key", state: "valid", reason: "local", endpoint };
    }

    const key = env[envName];
    if (key !== undefined && key !== "") {
      return { mode: "openai-key", state: "valid", reason: "key", endpoint, env: envName };
    }
    // A model served from this machine needs no credential of any kind, even
    // if the preset in play happens to name one.
    const local = config.baseUrl !== undefined && /localhost|127\.0\.0\.1/.test(config.baseUrl);
    return {
      mode: "openai-key",
      state: local ? "valid" : "missing",
      reason: local ? "local" : "key",
      endpoint,
      env: envName,
    };
  }

  const dir = configDir(env, process.platform, home);
  const profiles = await listProfiles(dir);
  return { mode: "anthropic", source: credentialSource(env, profiles), dir, profiles };
}

/**
 * The config a preset would produce, for asking about a service before
 * switching to it.
 *
 * `/provider` has to answer "could this one authenticate?" about a preset that
 * is not in effect yet, and `inspectCredential` reads a whole `VesnaConfig` —
 * so the three fields that describe the service get replaced and the rest
 * (where the project lives, whether it is configured, the oauth block) is kept
 * as it is. Building this inline at the call site is what let `/provider` skip
 * the question entirely.
 */
export function asPreset(config: VesnaConfig, preset: Preset): VesnaConfig {
  return {
    ...config,
    preset,
    provider: preset.dialect === "anthropic" ? "anthropic" : "openai",
    auth: preset.auth ?? "key",
    model: preset.model,
    baseUrl: preset.baseUrl,
  };
}

export function usable(credential: Credential): boolean {
  switch (credential.mode) {
    case "codex":
      // Vesna never refreshes a borrowed token, so an expired one is a dead end.
      return credential.state === "valid";
    case "subscription":
      // Vesna owns this one and refreshes it on use, so expiry is not a problem.
      return credential.state !== "missing";
    case "openai-key":
      return credential.state === "valid";
    case "anthropic":
      return credential.source.kind !== "none" && credential.source.kind !== "missing_profile";
    case "unaddressed":
      // Not "no credential": no service. Nothing can be used yet.
      return false;
  }
}

/** The concrete next step, for a credential that cannot be used. */
export function remedy(config: VesnaConfig, credential: Credential): string[] {
  const lines: string[] = [];

  // `configured` means "a project file or global settings exist" — not "a
  // project file exists" (see src/cli/config.ts). So this hint about writing
  // .vesna/config.yaml is suppressed whenever global settings already supply
  // something to work with; the credential problem below is the real one.
  if (!config.configured) {
    lines.push(
      "there is no .vesna/config.yaml here, so Vesna fell back to its defaults",
      "  vesna init                  # write one for this folder",
      "",
    );
  }

  switch (credential.mode) {
    case "codex":
      lines.push("  codex login");
      break;
    case "subscription":
      lines.push("  vesna auth login");
      break;
    case "openai-key":
      lines.push(`  export ${credential.env ?? "OPENAI_API_KEY"}=...   # or point baseUrl at a local host`);
      break;
    case "anthropic":
      lines.push(
        "  export ANTHROPIC_API_KEY=...",
        "  ant auth login              # OAuth, refreshed automatically, no static key",
      );
      break;
    case "unaddressed":
      // The line to add, rather than a command to run: this one is settled by
      // editing a file, and the two files that may carry it are both named.
      lines.push("  baseUrl: http://127.0.0.1:8080/v1   # in ~/.vesna/settings.yaml or .vesna/config.yaml");
      break;
  }
  return lines;
}

/** A one-line statement of what is wrong, for the line above the remedy. */
export function problem(credential: Credential): string {
  switch (credential.mode) {
    case "codex":
      return credential.state === "expired"
        ? "the borrowed codex token has expired"
        : "no codex subscription token";
    case "subscription":
      return "not signed in";
    case "openai-key":
      return `${credential.env ?? "OPENAI_API_KEY"} is not set`;
    case "anthropic":
      return credential.source.kind === "missing_profile"
        ? `ANTHROPIC_PROFILE names "${credential.source.profile}", which does not exist`
        : "no Anthropic credentials found";
    case "unaddressed":
      // The same words `/provider` uses for the same refusal (see
      // src/cli/chatcmd.ts), so the two surfaces read as one program.
      return `${credential.id} has no address of its own`;
  }
}
