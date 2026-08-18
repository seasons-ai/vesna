import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoredAuth {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  accountId?: string;
}

/** Credentials are per user, not per project, so they never sit next to a repo. */
export function authPath(env: Record<string, string | undefined>, home: string): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== ""
    ? env.XDG_CONFIG_HOME
    : join(home, ".config");
  return join(base, "vesna", "auth.json");
}

export async function saveAuth(path: string, auth: StoredAuth): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export async function loadAuth(path: string): Promise<StoredAuth | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // A missing or corrupt credential file must not break every command.
    return null;
  }
}

/** A minute of margin: a token that expires mid-request is a failed run. */
const EXPIRY_MARGIN_MS = 60_000;

export function isExpired(auth: StoredAuth, now: number): boolean {
  if (auth.expiresAt === undefined) return false;
  return auth.expiresAt - EXPIRY_MARGIN_MS <= now;
}
