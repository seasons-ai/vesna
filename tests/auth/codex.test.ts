import { test, expect } from "bun:test";
import { codexAuthPath, decodeJwtClaims, parseCodexAuth } from "../../src/auth/codex";

/** A JWT is three base64url segments; only the middle one carries claims. */
function jwt(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${body}.signature`;
}

test("the path follows CODEX_HOME when it is set", () => {
  expect(codexAuthPath({ CODEX_HOME: "/elsewhere" }, "/home/me")).toBe("/elsewhere/auth.json");
  expect(codexAuthPath({}, "/home/me")).toBe("/home/me/.codex/auth.json");
});

test("an empty CODEX_HOME falls back rather than yielding /auth.json", () => {
  expect(codexAuthPath({ CODEX_HOME: "" }, "/home/me")).toBe("/home/me/.codex/auth.json");
});

test("the access token is read from the tokens block", () => {
  const auth = parseCodexAuth(JSON.stringify({ tokens: { access_token: "at", refresh_token: "rt" } }));
  expect(auth?.accessToken).toBe("at");
});

test("the account id is taken from the tokens block when present", () => {
  const auth = parseCodexAuth(JSON.stringify({ tokens: { access_token: "at", account_id: "acc-1" } }));
  expect(auth?.accountId).toBe("acc-1");
});

test("the account id falls back to the id token claim", () => {
  const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-2" } });
  const auth = parseCodexAuth(JSON.stringify({ tokens: { access_token: "at", id_token: idToken } }));
  expect(auth?.accountId).toBe("acc-2");
});

test("expiry comes from the access token's own exp claim, in milliseconds", () => {
  const access = jwt({ exp: 1_700_000_000 });
  expect(parseCodexAuth(JSON.stringify({ tokens: { access_token: access } }))?.expiresAt).toBe(
    1_700_000_000_000,
  );
});

test("a token without an exp claim has no expiry rather than expiring at once", () => {
  expect(parseCodexAuth(JSON.stringify({ tokens: { access_token: "opaque" } }))?.expiresAt).toBeUndefined();
});

test("an API key stored by codex is reported separately from the subscription token", () => {
  const auth = parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: null }));
  expect(auth?.apiKey).toBe("sk-x");
  expect(auth?.accessToken).toBeUndefined();
});

test("a file with neither a token nor a key parses to null, not a hollow record", () => {
  expect(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: null, tokens: null }))).toBeNull();
});

test("corrupt json is null rather than a crash on an unrelated command", () => {
  expect(parseCodexAuth("{not json")).toBeNull();
});

test("a malformed jwt yields no claims instead of throwing", () => {
  expect(decodeJwtClaims("nope")).toBeNull();
  expect(decodeJwtClaims("a.!!!.c")).toBeNull();
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexTokenSource } from "../../src/auth/codex";

async function authFile(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vesna-codex-"));
  const path = join(dir, "auth.json");
  await writeFile(path, JSON.stringify(contents));
  return path;
}

test("the token source hands back the stored subscription token", async () => {
  const path = await authFile({ tokens: { access_token: "live-token" } });
  expect(await createCodexTokenSource({ path })()).toBe("live-token");
});

test("a missing file names codex login rather than saying 'not signed in'", async () => {
  await expect(createCodexTokenSource({ path: "/nope/auth.json" })()).rejects.toThrow(/codex login/);
});

test("an expired token is refused with the command that renews it", async () => {
  const stale = `h.${Buffer.from(JSON.stringify({ exp: 1_000 })).toString("base64url")}.s`;
  const path = await authFile({ tokens: { access_token: stale } });
  await expect(createCodexTokenSource({ path })()).rejects.toThrow(/expired.*codex login/is);
});

test("the token is re-read each call, so signing in again is picked up mid-session", async () => {
  const path = await authFile({ tokens: { access_token: "first" } });
  const token = createCodexTokenSource({ path });
  expect(await token()).toBe("first");
  await writeFile(path, JSON.stringify({ tokens: { access_token: "second" } }));
  expect(await token()).toBe("second");
});

test("an api-key-only codex file is not mistaken for a subscription", async () => {
  const path = await authFile({ OPENAI_API_KEY: "sk-x", tokens: null });
  await expect(createCodexTokenSource({ path })()).rejects.toThrow(/codex login/);
});
