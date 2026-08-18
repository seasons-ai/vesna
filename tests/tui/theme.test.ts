import { test, expect } from "bun:test";
import { colorSupported, resolveTheme, THEMES } from "../../src/tui/theme";

const ESC = "";

test("every theme defines the same set of roles", () => {
  const roles = Object.keys(THEMES.vesna!.roles).sort();
  for (const theme of Object.values(THEMES)) {
    expect(Object.keys(theme.roles).sort()).toEqual(roles);
  }
});

test("NO_COLOR wins over everything, per the convention", () => {
  expect(colorSupported({ NO_COLOR: "1", FORCE_COLOR: "3" }, true)).toBe(false);
});

test("colour is off when stdout is not a terminal", () => {
  expect(colorSupported({}, false)).toBe(false);
});

test("FORCE_COLOR turns colour on even off a terminal", () => {
  expect(colorSupported({ FORCE_COLOR: "1" }, false)).toBe(true);
});

test("a dumb terminal gets no colour", () => {
  expect(colorSupported({ TERM: "dumb" }, true)).toBe(false);
});

test("with colour off a theme emits no escape codes at all", () => {
  const painted = resolveTheme("vesna", { color: false }).paint("ok", "done");
  expect(painted).toBe("done");
  expect(painted.includes(ESC)).toBe(false);
});

test("with colour on a theme wraps the text and resets afterwards", () => {
  const painted = resolveTheme("vesna", { color: true }).paint("ok", "done");
  expect(painted).toContain("done");
  expect(painted.startsWith(ESC)).toBe(true);
  expect(painted.endsWith(`${ESC}[0m`)).toBe(true);
});

test("an unknown theme name falls back to the default instead of throwing", () => {
  expect(resolveTheme("nosuchtheme", { color: true }).name).toBe("vesna");
});

test("themes are listed by name for the config to choose from", () => {
  expect(Object.keys(THEMES)).toContain("vesna");
  expect(Object.keys(THEMES).length).toBeGreaterThan(1);
});
