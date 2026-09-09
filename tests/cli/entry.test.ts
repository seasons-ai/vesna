import { test, expect } from "bun:test";
import { isHelp, isVersion, VERSION } from "../../src/cli/entry";

test("every spelling of help is help", () => {
  for (const word of ["help", "--help", "-h"]) expect(isHelp(word)).toBe(true);
});

test("no command at all is help, not an error", () => {
  expect(isHelp(undefined)).toBe(true);
});

test("a real command is not help", () => {
  for (const word of ["chat", "run", "doctor", "--plain"]) expect(isHelp(word)).toBe(false);
});

test("every spelling of version is version", () => {
  for (const word of ["--version", "-v", "version"]) expect(isVersion(word)).toBe(true);
});

test("version is not help, and help is not version", () => {
  expect(isVersion("--help")).toBe(false);
  expect(isHelp("--version")).toBe(false);
});

test("the reported version matches the package, so it cannot drift", async () => {
  const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json();
  expect(VERSION).toBe(pkg.version);
});
