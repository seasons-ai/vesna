import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type CredentialSource =
  | { kind: "api_key"; note: string }
  | { kind: "auth_token"; note: string }
  | { kind: "profile"; profile: string; note: string }
  | { kind: "missing_profile"; profile: string; note: string }
  | { kind: "none"; note: string };

type Env = Record<string, string | undefined>;

function set(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * Mirrors the SDK's own resolution order so `vesna auth` reports what will
 * actually be used, rather than what the user assumes.
 */
export function credentialSource(env: Env, profiles: string[]): CredentialSource {
  const named = env.ANTHROPIC_PROFILE;

  if (set(env.ANTHROPIC_API_KEY)) {
    return {
      kind: "api_key",
      note:
        profiles.length > 0
          ? "ANTHROPIC_API_KEY is set, so it shadows the OAuth profile on disk"
          : "using ANTHROPIC_API_KEY from the environment",
    };
  }

  if (set(env.ANTHROPIC_AUTH_TOKEN)) {
    return { kind: "auth_token", note: "using ANTHROPIC_AUTH_TOKEN from the environment" };
  }

  if (set(named)) {
    return profiles.includes(named)
      ? { kind: "profile", profile: named, note: "selected by ANTHROPIC_PROFILE" }
      : {
          kind: "missing_profile",
          profile: named,
          note: `ANTHROPIC_PROFILE names "${named}", which does not exist on disk`,
        };
  }

  const fallback = profiles.includes("default") ? "default" : profiles[0];
  if (fallback !== undefined) {
    return { kind: "profile", profile: fallback, note: "OAuth profile from `ant auth login`" };
  }

  return { kind: "none", note: "no credentials found" };
}

/** The SDK's config directory, by the same rules it uses. */
export function configDir(env: Env, platform: string, home: string): string {
  if (set(env.ANTHROPIC_CONFIG_DIR)) return env.ANTHROPIC_CONFIG_DIR;
  if (platform === "win32" && set(env.APPDATA)) return join(env.APPDATA, "Anthropic");
  return join(home, ".config", "anthropic");
}

export async function listProfiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, "credentials")))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
