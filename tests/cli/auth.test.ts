import { test, expect } from "bun:test";
import { configDir, credentialSource } from "../../src/cli/auth";
import { authCommand } from "../../src/cli/authcmd";
import type { VesnaConfig } from "../../src/cli/config";
import { findPreset } from "../../src/providers/catalog";
import { resolveTheme } from "../../src/tui/theme";
import { EXIT } from "../../src/cli/exit";

test("an API key in the environment wins", () => {
  const source = credentialSource({ ANTHROPIC_API_KEY: "sk-x" }, ["default"]);
  expect(source.kind).toBe("api_key");
});

test("an auth token is used when there is no API key", () => {
  expect(credentialSource({ ANTHROPIC_AUTH_TOKEN: "t" }, []).kind).toBe("auth_token");
});

test("an API key shadows a profile — the trap worth naming", () => {
  const source = credentialSource({ ANTHROPIC_API_KEY: "sk-x" }, ["default", "work"]);
  expect(source.kind).toBe("api_key");
  expect(source.note).toContain("shadow");
});

test("a profile on disk is used when no environment credential is set", () => {
  const source = credentialSource({}, ["default"]);
  expect(source.kind).toBe("profile");
  expect(source.kind === "profile" && source.profile).toBe("default");
});

test("ANTHROPIC_PROFILE selects which profile is used", () => {
  const source = credentialSource({ ANTHROPIC_PROFILE: "work" }, ["default", "work"]);
  expect(source.kind === "profile" && source.profile).toBe("work");
});

test("naming a profile that does not exist is an error, not a silent fallback", () => {
  const source = credentialSource({ ANTHROPIC_PROFILE: "ghost" }, ["default"]);
  expect(source.kind).toBe("missing_profile");
});

test("no credentials anywhere is reported plainly", () => {
  expect(credentialSource({}, []).kind).toBe("none");
});

test("an empty API key does not count as a credential", () => {
  expect(credentialSource({ ANTHROPIC_API_KEY: "" }, []).kind).toBe("none");
});

test("the config directory follows the platform convention", () => {
  expect(configDir({ ANTHROPIC_CONFIG_DIR: "/custom" }, "linux", "/home/u")).toBe("/custom");
  expect(configDir({}, "linux", "/home/u")).toBe("/home/u/.config/anthropic");
  expect(configDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toBe(
    "C:\\Users\\u\\AppData\\Roaming/Anthropic",
  );
});

/**
 * `vesna auth` used to print `VesnaConfig.provider`, which is the wire dialect
 * — one value shared by openai, groq, openrouter, ollama and every other
 * openai-compatible service. A Groq setup reported "provider: openai", which
 * is the one line of this screen that says what you are talking to.
 */
test("the status names the service, not the dialect it happens to speak", async () => {
  const config = {
    configured: true,
    preset: findPreset("groq")!,
    pinned: false,
    provider: "openai",
    auth: "key",
    model: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
    theme: "mono",
    prices: {},
    permissions: {},
  } as VesnaConfig;

  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await authCommand(undefined, config, resolveTheme("mono", { depth: 0 }), "/tmp");
  } finally {
    console.log = real;
  }

  expect(lines[0]).toContain("groq");
  expect(lines[0]).not.toContain("openai");
});

/**
 * `vesna auth` for a `custom` with no baseUrl printed
 * `endpoint: https://api.openai.com/v1` and `credential: none needed (local
 * endpoint)`, and exited 0 — then `vesna do "hi"` refused to build the
 * provider. The status screen names no host now, because there is no host:
 * the fallback it was printing is the one d20cce8 exists to stop reaching.
 */
test("the status refuses an unaddressed custom rather than naming a host nobody chose", async () => {
  const config = {
    configured: true,
    preset: findPreset("custom")!,
    pinned: true,
    provider: "openai",
    auth: "key",
    model: "local-model",
    theme: "mono",
    prices: {},
    permissions: {},
  } as VesnaConfig;

  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  let status: number;
  try {
    status = await authCommand(undefined, config, resolveTheme("mono", { depth: 0 }), "/tmp");
  } finally {
    console.log = real;
  }

  expect(status).toBe(EXIT.error);
  expect(lines.join("\n")).not.toContain("api.openai.com");
  expect(lines.join("\n")).toContain("custom has no address of its own");
  // The two files that may carry one, so the fix is guessable from the screen.
  expect(lines.join("\n")).toContain("baseUrl");
});
