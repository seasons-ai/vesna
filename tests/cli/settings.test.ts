import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, settingsPath, writeSettings } from "../../src/cli/settings";

function withHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "vesna-settings-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("settingsPath honours VESNA_HOME over the home directory", () => {
  expect(settingsPath({ VESNA_HOME: "/tmp/elsewhere" }, "/home/x")).toBe(
    "/tmp/elsewhere/settings.yaml",
  );
  expect(settingsPath({}, "/home/x")).toBe("/home/x/.vesna/settings.yaml");
});

test("an empty VESNA_HOME falls back to the home directory rather than resolving to the cwd", () => {
  expect(settingsPath({ VESNA_HOME: "" }, "/home/x")).toBe("/home/x/.vesna/settings.yaml");
});

test("a missing file reads as empty settings rather than throwing", () => {
  withHome((home) => {
    expect(readSettings(settingsPath({}, home))).toEqual({});
  });
});

test("what is written is what is read back", () => {
  withHome((home) => {
    const path = settingsPath({}, home);
    writeSettings(path, { provider: "ollama", model: "qwen3" });
    expect(readSettings(path)).toEqual({ provider: "ollama", model: "qwen3" });
  });
});

test("writing creates the directory and leaves a comment saying who owns the file", () => {
  withHome((home) => {
    const path = settingsPath({}, home);
    writeSettings(path, { provider: "groq" });
    expect(readFileSync(path, "utf8")).toContain("Written by Vesna");
  });
});

test("unreadable YAML reads as empty rather than crashing the program", () => {
  withHome((home) => {
    const path = settingsPath({}, home);
    writeSettings(path, { provider: "groq" });
    writeFileSync(path, "provider: [unclosed\n");
    expect(readSettings(path)).toEqual({});
  });
});
