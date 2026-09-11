import { test, expect } from "bun:test";
import { needsProvider, route } from "../../src/cli/main";

test("bare vesna opens the chat when there is something to work with", () => {
  expect(route([], { configured: true })).toBe("chat");
});

test("bare vesna onboards when there is not", () => {
  expect(route([], { configured: false })).toBe("onboard");
});

test("an explicit command is still itself, configured or not", () => {
  expect(route(["do", "task"], { configured: true })).toBe("do");
  expect(route(["auth"], { configured: false })).toBe("auth");
  expect(route(["chat"], { configured: true })).toBe("chat");
});

test("help and version are answers, not misuse", () => {
  expect(route(["--help"], { configured: false })).toBe("usage");
  expect(route(["--version"], { configured: false })).toBe("version");
});

test("an unknown first word stays an error rather than becoming a task", () => {
  expect(route(["fix the tests"], { configured: true })).toBe("error");
});

/**
 * Which routes an unusable `~/.vesna/settings.yaml` is allowed to stop. The
 * file is Vesna's own, so a typo in it must not reach a command that never
 * asks what the service is — `vesna --help` exiting 2 fails a shell script.
 */
test("asking for help or a version needs no provider", () => {
  for (const route of ["usage", "version", "error"] as const) {
    expect(needsProvider(route)).toBe(false);
  }
});

test("anything that reaches a model, or writes down which one, needs a provider", () => {
  for (const route of ["chat", "do", "auth", "init"] as const) {
    expect(needsProvider(route)).toBe(true);
  }
});

test("onboarding is how an unusable machine file gets rewritten, so it is not blocked by one", () => {
  expect(needsProvider("onboard")).toBe(false);
});
