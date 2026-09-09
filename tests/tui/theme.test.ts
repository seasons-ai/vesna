import { test, expect } from "bun:test";
import { colorDepth, resolveTheme, themeNames } from "../../src/tui/theme";
import { PALETTES } from "../../src/tui/palette";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("NO_COLOR wins over everything, as the convention requires", () => {
  expect(colorDepth({ NO_COLOR: "1", FORCE_COLOR: "1", COLORTERM: "truecolor" }, true)).toBe(0);
});

test("an empty NO_COLOR is not set, so it does not disable colour", () => {
  expect(colorDepth({ NO_COLOR: "" }, true)).toBe(8);
});

test("a dumb terminal gets no colour", () => {
  expect(colorDepth({ TERM: "dumb", COLORTERM: "truecolor" }, true)).toBe(0);
});

test("a pipe gets no colour unless colour is forced", () => {
  expect(colorDepth({}, false)).toBe(0);
  expect(colorDepth({ FORCE_COLOR: "1" }, false)).toBe(8);
});

test("COLORTERM announces truecolor in both of its spellings", () => {
  expect(colorDepth({ COLORTERM: "truecolor" }, true)).toBe(24);
  expect(colorDepth({ COLORTERM: "24bit" }, true)).toBe(24);
});

test("a -direct terminfo entry also means truecolor", () => {
  expect(colorDepth({ TERM: "xterm-direct" }, true)).toBe(24);
});

test("an ordinary terminal gets 256 colours", () => {
  expect(colorDepth({ TERM: "xterm-256color" }, true)).toBe(8);
});

test("mono and the three palettes are all offered", () => {
  expect(themeNames().sort()).toEqual(["hanami", "mono", "vesna", "washi"]);
});

test("an unknown theme name falls back to vesna rather than failing", () => {
  expect(resolveTheme("nonsense", { depth: 24 }).name).toBe("vesna");
});

test("at 24 bits a role paints the exact hex from the palette", () => {
  const theme = resolveTheme("vesna", { depth: 24 });
  expect(theme.paint("petal", "x")).toBe("\x1b[38;2;243;175;194mx\x1b[0m");
});

test("at 8 bits the same role paints its approximation", () => {
  const theme = resolveTheme("vesna", { depth: 8 });
  expect(theme.paint("petal", "x")).toBe("\x1b[38;5;217mx\x1b[0m");
});

test("at depth 0 nothing is painted and the text is untouched", () => {
  const theme = resolveTheme("vesna", { depth: 0 });
  expect(theme.paint("petal", "x")).toBe("x");
  expect(theme.surface).toBe("");
});

test("mono paints nothing even on a truecolor terminal", () => {
  const theme = resolveTheme("mono", { depth: 24 });
  expect(theme.paint("petal", "x")).toBe("x");
  expect(theme.surface).toBe("");
});

test("the surface establishes the canvas background at each depth", () => {
  expect(resolveTheme("vesna", { depth: 24 }).surface).toBe("\x1b[48;2;20;22;31m");
  expect(resolveTheme("vesna", { depth: 8 }).surface).toBe("\x1b[48;5;234m");
});

test("painting never changes the text itself, only its colour", () => {
  for (const name of themeNames()) {
    for (const depth of [0, 8, 24] as const) {
      expect(plain(resolveTheme(name, { depth }).paint("warn", "held"))).toBe("held");
    }
  }
});

test("every palette token is paintable as a role", () => {
  const theme = resolveTheme("vesna", { depth: 24 });
  for (const token of Object.keys(PALETTES.vesna!.tokens)) {
    expect(plain(theme.paint(token as never, "z"))).toBe("z");
  }
});
