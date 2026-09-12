import { test, expect } from "bun:test";
import { readSettings } from "../src/settings";

function getter(values: Record<string, unknown>): (key: string) => unknown {
  return (key) => values[key];
}

test("defaults: command vesna, no args", () => {
  expect(readSettings(getter({}))).toEqual({ command: "vesna", args: [] });
});

test("overrides are read as given", () => {
  expect(readSettings(getter({ command: "/opt/bin/bun", args: ["/x/bin/vesna"] }))).toEqual({
    command: "/opt/bin/bun",
    args: ["/x/bin/vesna"],
  });
});

test("a blank or non-string command falls back to the default", () => {
  expect(readSettings(getter({ command: "" })).command).toBe("vesna");
  expect(readSettings(getter({ command: "   " })).command).toBe("vesna");
  expect(readSettings(getter({ command: 42 })).command).toBe("vesna");
});

test("args that are not a list of strings fall back to none", () => {
  expect(readSettings(getter({ args: "serve" })).args).toEqual([]);
  expect(readSettings(getter({ args: ["a", 1] })).args).toEqual([]);
  expect(readSettings(getter({ args: null })).args).toEqual([]);
});

test("the command is trimmed", () => {
  expect(readSettings(getter({ command: " vesna " })).command).toBe("vesna");
});
