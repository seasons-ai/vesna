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

// ---------------------------------------------------------------------------
// The contributions are folder-scoped: a multi-root workspace's first folder
// may name its own command, and the extension reads the folder's settings.

test("vesna.command and vesna.args are resource-scoped in package.json", async () => {
  const pkg = (await import("../package.json")) as { contributes: { configuration: { properties: Record<string, { scope?: string }> } } };
  const properties = pkg.contributes.configuration.properties;
  expect(properties["vesna.command"]?.scope).toBe("resource");
  expect(properties["vesna.args"]?.scope).toBe("resource");
});
