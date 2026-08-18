import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reading the credentials the Codex CLI already holds.
 *
 * The alternative — Vesna running its own OAuth against the subscription
 * endpoint — needs a client identity, and Vesna ships none, its own or anyone
 * else's. Borrowing a token that `codex login` obtained keeps that decision in
 * the user's hands: no sign-in flow, no client id, nothing to configure.
 *
 * Read-only by design. Vesna never writes this file and never refreshes it; a
 * token past its expiry is reported so `codex login` can renew it.
 */

export interface CodexAuth {
  /** Subscription access token, when the user signed in with ChatGPT. */
  accessToken?: string;
  /** Plain API key, when the user gave codex one instead. */
  apiKey?: string;
  accountId?: string;
  /** Epoch milliseconds, from the token's own exp claim. */
  expiresAt?: number;
}

export function codexAuthPath(env: Record<string, string | undefined>, home: string): string {
  const dir = env.CODEX_HOME && env.CODEX_HOME !== "" ? env.CODEX_HOME : join(home, ".codex");
  return join(dir, "auth.json");
}

/** The claims of a JWT, or null for anything that is not one. */
export function decodeJwtClaims(token: string): Record<string, any> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function parseCodexAuth(raw: string): CodexAuth | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null; // a corrupt file must not break an unrelated command
  }
  if (!data || typeof data !== "object") return null;

  const tokens = data.tokens ?? {};
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
  const apiKey = typeof data.OPENAI_API_KEY === "string" ? data.OPENAI_API_KEY : undefined;
  if (accessToken === undefined && apiKey === undefined) return null;

  const claims = accessToken ? decodeJwtClaims(accessToken) : null;
  const idClaims = typeof tokens.id_token === "string" ? decodeJwtClaims(tokens.id_token) : null;

  return {
    ...(accessToken ? { accessToken } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(accountIdOf(tokens, idClaims) ? { accountId: accountIdOf(tokens, idClaims)! } : {}),
    ...(typeof claims?.exp === "number" ? { expiresAt: claims.exp * 1000 } : {}),
  };
}

function accountIdOf(tokens: any, idClaims: Record<string, any> | null): string | undefined {
  if (typeof tokens?.account_id === "string") return tokens.account_id;
  const auth = idClaims?.["https://api.openai.com/auth"];
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

export async function readCodexAuth(path: string): Promise<CodexAuth | null> {
  try {
    return parseCodexAuth(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const RENEW = "run `codex login` to sign in";

/**
 * Resolves the token on every call, so signing in again in another terminal
 * takes effect without restarting Vesna. Never refreshes: renewal belongs to
 * the tool that owns the credentials.
 */
export function createCodexTokenSource(config: { path: string }): () => Promise<string> {
  return async () => {
    const auth = await readCodexAuth(config.path);
    if (auth?.accessToken === undefined) {
      throw new Error(`no ChatGPT subscription token in ${config.path} — ${RENEW}`);
    }
    if (auth.expiresAt !== undefined && auth.expiresAt <= Date.now()) {
      throw new Error(`the ChatGPT subscription token has expired — ${RENEW}`);
    }
    return auth.accessToken;
  };
}
