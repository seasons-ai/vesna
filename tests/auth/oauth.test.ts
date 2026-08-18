import { test, expect } from "bun:test";
import { authorizeUrl, exchangeCode, generatePkce } from "../../src/auth/oauth";

test("the verifier and challenge follow RFC 7636 S256", async () => {
  const pkce = generatePkce();
  expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
  expect(pkce.verifier.length).toBeLessThanOrEqual(128);
  expect(pkce.verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  expect(pkce.challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  expect(pkce.challenge).not.toContain("=");
});

test("the challenge is the sha256 of the verifier, not the verifier itself", () => {
  const pkce = generatePkce();
  expect(pkce.challenge).not.toBe(pkce.verifier);
  expect(generatePkce().verifier).not.toBe(pkce.verifier);
});

test("the authorize url carries every parameter the provider needs", () => {
  const url = new URL(
    authorizeUrl({
      issuer: "https://auth.example.com",
      clientId: "cid",
      redirectUri: "http://localhost:1234/auth/callback",
      challenge: "chal",
      state: "st",
      scope: "openid profile",
    }),
  );

  expect(url.origin).toBe("https://auth.example.com");
  expect(url.pathname).toBe("/oauth/authorize");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_id")).toBe("cid");
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1234/auth/callback");
  expect(url.searchParams.get("code_challenge")).toBe("chal");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("state")).toBe("st");
  expect(url.searchParams.get("scope")).toBe("openid profile");
});

test("the code is exchanged with the verifier, and tokens come back", async () => {
  const seen: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push({ body: await request.text(), path: new URL(request.url).pathname });
      return Response.json({
        access_token: "at",
        refresh_token: "rt",
        id_token: "it",
        expires_in: 3600,
      });
    },
  });

  try {
    const issuer = `http://localhost:${server.port}`;
    const tokens = await exchangeCode({
      issuer,
      clientId: "cid",
      redirectUri: "http://localhost:1/auth/callback",
      code: "the-code",
      verifier: "the-verifier",
    });

    expect(seen[0]!.path).toBe("/oauth/token");
    const sent = new URLSearchParams(seen[0]!.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("the-code");
    expect(sent.get("code_verifier")).toBe("the-verifier");
    expect(sent.get("client_id")).toBe("cid");

    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  } finally {
    server.stop(true);
  }
});

test("a rejected exchange reports the provider's own error", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('{"error":"invalid_grant"}', { status: 400 }),
  });
  try {
    await expect(
      exchangeCode({
        issuer: `http://localhost:${server.port}`,
        clientId: "cid",
        redirectUri: "http://localhost:1/auth/callback",
        code: "bad",
        verifier: "v",
      }),
    ).rejects.toThrow(/invalid_grant/);
  } finally {
    server.stop(true);
  }
});
