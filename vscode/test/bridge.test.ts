import { test, expect } from "bun:test";
import { parseLine, type ToWebview } from "../webview/bridge";
import { initialModel } from "../src/state";
import { COMMAND_NAMES } from "../src/words";

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

// ---------------------------------------------------------------------------
// Host → webview: the model, or a line the host could not deliver.

test("a rejected line is a ToWebview message carrying the text back", async () => {
  const { isRejected } = await import("../webview/bridge");
  const message: ToWebview = { kind: "rejected", text: "/mode plan" };
  expect(isRejected(message)).toBe(true);
  expect(isRejected({ kind: "model", model: initialModel() })).toBe(false);
  expect(isRejected({ kind: "other" })).toBe(false);
  expect(isRejected(undefined)).toBe(false);
});

// ---------------------------------------------------------------------------
// Command completion: only while the line is a bare `/name` with no space yet.

test("completions match the command names by prefix, only before the first space", async () => {
  const { completions } = await import("../webview/bridge");
  expect(completions("/mo")).toEqual(["mode", "model"]);
  expect(completions("/")).toEqual([...COMMAND_NAMES]);
  expect(completions("/mode")).toEqual(["mode", "model"]);
  expect(completions("/mode ")).toEqual([]);
  expect(completions("/zzz")).toEqual([]);
  expect(completions("hello")).toEqual([]);
  expect(completions("")).toEqual([]);
  expect(completions("/Mo")).toEqual(["mode", "model"]);
});
