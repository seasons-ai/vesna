import { test, expect } from "bun:test";
import { browserLogin } from "../../src/auth/login";

/** A fake issuer: serves the token endpoint and records what it was asked. */
function fakeIssuer(reply: Record<string, unknown> = { access_token: "at", refresh_token: "rt", expires_in: 3600 }) {
  const seen: URLSearchParams[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push(new URLSearchParams(await request.text()));
      return Response.json(reply);
    },
  });
  return { seen, url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

test("the whole browser flow ends in a stored credential", async () => {
  const issuer = fakeIssuer();
  const opened: string[] = [];
  try {
    const auth = await browserLogin(
      { issuer: issuer.url, clientId: "cid", provider: "openai" },
      {
        async openBrowser(url) {
          opened.push(url);
          // Stand in for the user finishing the flow in their browser.
          const state = new URL(url).searchParams.get("state")!;
          await fetch(`${new URL(url).searchParams.get("redirect_uri")}?code=the-code&state=${state}`);
        },
      },
    );

    expect(auth.provider).toBe("openai");
    expect(auth.accessToken).toBe("at");
    expect(auth.refreshToken).toBe("rt");
    expect(auth.expiresAt).toBeGreaterThan(Date.now());
  } finally {
    issuer.stop();
  }
});

test("the browser is sent to the issuer's authorize page with a loopback redirect", async () => {
  const issuer = fakeIssuer();
  const opened: string[] = [];
  try {
    await browserLogin(
      { issuer: issuer.url, clientId: "cid", provider: "openai", scope: "openid" },
      {
        async openBrowser(url) {
          opened.push(url);
          const parsed = new URL(url);
          await fetch(
            `${parsed.searchParams.get("redirect_uri")}?code=c&state=${parsed.searchParams.get("state")}`,
          );
        },
      },
    );

    const url = new URL(opened[0]!);
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(url.searchParams.get("scope")).toBe("openid");
  } finally {
    issuer.stop();
  }
});

test("the exchange sends the verifier that matches the challenge", async () => {
  const issuer = fakeIssuer();
  try {
    await browserLogin(
      { issuer: issuer.url, clientId: "cid", provider: "openai" },
      {
        async openBrowser(url) {
          const parsed = new URL(url);
          await fetch(
            `${parsed.searchParams.get("redirect_uri")}?code=c&state=${parsed.searchParams.get("state")}`,
          );
        },
      },
    );
    expect(issuer.seen[0]!.get("code_verifier")).toBeTruthy();
    expect(issuer.seen[0]!.get("grant_type")).toBe("authorization_code");
  } finally {
    issuer.stop();
  }
});

test("a mismatched state is rejected — that check is the point of state", async () => {
  const issuer = fakeIssuer();
  try {
    await expect(
      browserLogin(
        { issuer: issuer.url, clientId: "cid", provider: "openai" },
        {
          async openBrowser(url) {
            const redirect = new URL(url).searchParams.get("redirect_uri")!;
            await fetch(`${redirect}?code=c&state=forged`);
          },
        },
      ),
    ).rejects.toThrow(/state/i);
  } finally {
    issuer.stop();
  }
});

test("a denied authorisation surfaces the provider's error", async () => {
  const issuer = fakeIssuer();
  try {
    await expect(
      browserLogin(
        { issuer: issuer.url, clientId: "cid", provider: "openai" },
        {
          async openBrowser(url) {
            const redirect = new URL(url).searchParams.get("redirect_uri")!;
            await fetch(`${redirect}?error=access_denied`);
          },
        },
      ),
    ).rejects.toThrow(/access_denied/);
  } finally {
    issuer.stop();
  }
});
