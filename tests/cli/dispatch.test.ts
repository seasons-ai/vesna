import { test, expect } from "bun:test";
import { route } from "../../src/cli/main";

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
