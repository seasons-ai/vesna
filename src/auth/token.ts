import { refreshTokens } from "./oauth";
import { isExpired, loadAuth, saveAuth, type StoredAuth } from "./store";

export interface TokenSourceConfig {
  path: string;
  issuer: string;
  clientId: string;
}

export class NotSignedInError extends Error {
  constructor() {
    super("not signed in");
    this.name = "NotSignedInError";
  }
}

/**
 * Returns a usable access token, refreshing and persisting it when it is close
 * to expiry. Resolved per request so a long run cannot die on a stale token.
 */
export function createTokenSource(config: TokenSourceConfig): () => Promise<string> {
  return async () => {
    const stored = await loadAuth(config.path);
    if (stored === null) throw new NotSignedInError();
    if (!isExpired(stored, Date.now())) return stored.accessToken;

    if (stored.refreshToken === undefined) throw new NotSignedInError();

    const refreshed = await refreshTokens({
      issuer: config.issuer,
      clientId: config.clientId,
      refreshToken: stored.refreshToken,
    });

    const next: StoredAuth = {
      ...stored,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    };
    await saveAuth(config.path, next);
    return next.accessToken;
  };
}
