import { test, expect } from "bun:test";
import { CHAT_COMMANDS, parseChatInput } from "../../src/cli/chatcmd";

test("plain text is a message, not a command", () => {
  expect(parseChatInput("read src/a.ts")).toEqual({ kind: "message", text: "read src/a.ts" });
});

test("a leading slash is a command", () => {
  expect(parseChatInput("/exit")).toEqual({ kind: "command", name: "exit", argument: "" });
});

test("a command carries the rest of the line as one argument", () => {
  expect(parseChatInput("/crystallize client report")).toEqual({
    kind: "command",
    name: "crystallize",
    argument: "client report",
  });
});

test("an unknown command is reported rather than sent to the model", () => {
  expect(parseChatInput("/nope")).toEqual({ kind: "unknown", name: "nope" });
});

test("a blank line is nothing at all", () => {
  expect(parseChatInput("   ")).toEqual({ kind: "blank" });
});

test("a path that happens to start with a slash is still a message", () => {
  expect(parseChatInput("/Users/me/file.ts is broken")).toEqual({
    kind: "unknown",
    name: "Users/me/file.ts",
  });
});

test("every advertised command is recognised by the parser", () => {
  for (const command of CHAT_COMMANDS) {
    expect(parseChatInput(`/${command.name}`).kind).toBe("command");
  }
});

test("the help listing covers exit and crystallize, the two that matter", () => {
  const names = CHAT_COMMANDS.map((c) => c.name);
  expect(names).toContain("exit");
  expect(names).toContain("crystallize");
});
