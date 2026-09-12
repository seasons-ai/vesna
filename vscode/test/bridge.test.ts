import { test, expect } from "bun:test";
import { parseLine } from "../webview/bridge";

test("a slash line is a command: name up to the first space, the rest trimmed, typed as the line", () => {
  expect(parseLine("/mode auto")).toEqual({ kind: "command", name: "mode", argument: "auto", typed: "/mode auto" });
  expect(parseLine("  /spec  a new one  ")).toEqual({
    kind: "command",
    name: "spec",
    argument: "a new one",
    typed: "/spec  a new one",
  });
  expect(parseLine("/cost")).toEqual({ kind: "command", name: "cost", argument: "", typed: "/cost" });
});

test("anything else is a send, trimmed", () => {
  expect(parseLine("hi")).toEqual({ kind: "send", text: "hi" });
  expect(parseLine("  two\nlines \n")).toEqual({ kind: "send", text: "two\nlines" });
});

test("a blank line is nothing", () => {
  expect(parseLine("")).toBeNull();
  expect(parseLine("  ")).toBeNull();
  expect(parseLine("\n\t")).toBeNull();
});
