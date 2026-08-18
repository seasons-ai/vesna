import { test, expect } from "bun:test";
import { renderCallbackPage, startCallbackServer } from "../../src/auth/callback";

test("the success page names the product and says it is safe to close", () => {
  const html = renderCallbackPage({ ok: true, message: "Signed in as you@example.com" });
  expect(html).toContain("Vesna");
  expect(html).toContain("Signed in as you@example.com");
  expect(html.toLowerCase()).toContain("close this tab");
});

test("the failure page shows the reason instead of a blank screen", () => {
  const html = renderCallbackPage({ ok: false, message: "access_denied" });
  expect(html).toContain("access_denied");
});

test("the page renders in both colour schemes rather than assuming light", () => {
  const html = renderCallbackPage({ ok: true, message: "done" });
  expect(html).toContain("prefers-color-scheme: dark");
});

test("the page escapes the message, so a hostile redirect cannot inject markup", () => {
  const html = renderCallbackPage({ ok: false, message: "<img src=x onerror=alert(1)>" });
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img");
});

test("the server resolves with the code and state from the redirect", async () => {
  const server = startCallbackServer();
  try {
    const response = await fetch(`${server.redirectUri}?code=abc123&state=xyz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Vesna");

    const result = await server.result;
    expect(result).toEqual({ ok: true, code: "abc123", state: "xyz" });
  } finally {
    server.close();
  }
});

test("an error redirect resolves as a failure rather than hanging", async () => {
  const server = startCallbackServer();
  try {
    await fetch(`${server.redirectUri}?error=access_denied`);
    const result = await server.result;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("access_denied");
  } finally {
    server.close();
  }
});

test("the redirect uri is a loopback address on a real port", () => {
  const server = startCallbackServer();
  try {
    expect(server.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(server.port).toBeGreaterThan(0);
  } finally {
    server.close();
  }
});
