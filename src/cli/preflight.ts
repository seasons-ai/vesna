import { codexAuthPath, readCodexAuth } from "../auth/codex";
import { authPath, isExpired, loadAuth } from "../auth/store";
import { configDir, credentialSource, listProfiles, type CredentialSource } from "./auth";
import type { VesnaConfig } from "./config";
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
    }
  | { mode: "anthropic"; source: CredentialSource; dir: string; profiles: string[] };

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
    const endpoint = config.baseUrl ?? "https://api.openai.com/v1";
    const key = env.OPENAI_API_KEY;
    if (key !== undefined && key !== "") {
      return { mode: "openai-key", state: "valid", reason: "key", endpoint };
    }
    // A model served from this machine needs no credential of any kind.
    const local = config.baseUrl !== undefined && /localhost|127\.0\.0\.1/.test(config.baseUrl);
    return { mode: "openai-key", state: local ? "valid" : "missing", reason: local ? "local" : "key", endpoint };
  }

  const dir = configDir(env, process.platform, home);
  const profiles = await listProfiles(dir);
  return { mode: "anthropic", source: credentialSource(env, profiles), dir, profiles };
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
      lines.push("  export OPENAI_API_KEY=...   # or point baseUrl at a local host");
      break;
    case "anthropic":
      lines.push(
        "  export ANTHROPIC_API_KEY=...",
        "  ant auth login              # OAuth, refreshed automatically, no static key",
      );
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
      return "OPENAI_API_KEY is not set";
    case "anthropic":
      return credential.source.kind === "missing_profile"
        ? `ANTHROPIC_PROFILE names "${credential.source.profile}", which does not exist`
        : "no Anthropic credentials found";
  }
}
