import { test, expect } from "bun:test";
import { configDir, credentialSource } from "../../src/cli/auth";

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
