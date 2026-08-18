import { randomBytes } from "node:crypto";
import { startCallbackServer } from "./callback";
import { authorizeUrl, exchangeCode, generatePkce } from "./oauth";
import type { StoredAuth } from "./store";

export interface LoginConfig {
  issuer: string;
  clientId: string;
  provider: string;
  scope?: string;
  accountId?: string;
}

export interface LoginDeps {
  openBrowser(url: string): Promise<void>;
}

/**
 * Drives the authorisation-code flow end to end. Every screen the user sees
 * belongs to the provider; the only page Vesna serves is the landing page after
 * the redirect.
 */
export async function browserLogin(config: LoginConfig, deps: LoginDeps): Promise<StoredAuth> {
  const pkce = generatePkce();
  const state = randomBytes(16).toString("hex");
  const server = startCallbackServer();

  try {
    const url = authorizeUrl({
      issuer: config.issuer,
      clientId: config.clientId,
      redirectUri: server.redirectUri,
      challenge: pkce.challenge,
      state,
      scope: config.scope,
    });

    await deps.openBrowser(url);
    const result = await server.result;

    if (!result.ok) throw new Error(`authorisation failed: ${result.error}`);
    // Without this check the callback would accept a code from anywhere.
    if (result.state !== state) throw new Error("authorisation state did not match; sign-in aborted");

    const tokens = await exchangeCode({
      issuer: config.issuer,
      clientId: config.clientId,
      redirectUri: server.redirectUri,
      code: result.code,
      verifier: pkce.verifier,
    });

    return {
      provider: config.provider,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      accountId: config.accountId,
    };
  } finally {
    server.close();
  }
}
