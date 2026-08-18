import { createHash, randomBytes } from "node:crypto";

export interface Pkce {
  verifier: string;
  challenge: string;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** RFC 7636 S256. Written from the spec rather than copied from any client. */
export function generatePkce(): Pkce {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export interface AuthorizeParams {
  issuer: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
}

export function authorizeUrl(params: AuthorizeParams): string {
  const url = new URL("/oauth/authorize", params.issuer);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  if (params.scope) url.searchParams.set("scope", params.scope);
  return url.toString();
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
}

export interface ExchangeParams {
  issuer: string;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
}

export async function exchangeCode(params: ExchangeParams): Promise<Tokens> {
  const response = await fetch(new URL("/oauth/token", params.issuer), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code: params.code,
      code_verifier: params.verifier,
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`token exchange failed (${response.status}): ${text}`);

  const body = JSON.parse(text);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: body.id_token,
    expiresAt:
      typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
  };
}
