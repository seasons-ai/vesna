import { test, expect } from "bun:test";
import { ASCII_GLYPHS, resolveGlyphs, UNICODE_GLYPHS } from "../../src/tui/glyphs";

test("a UTF-8 locale gets the real mark", () => {
  expect(resolveGlyphs({ LANG: "en_US.UTF-8" }).mark).toBe("❀");
});

test("lowercase and hyphenless spellings of utf8 are recognised", () => {
  expect(resolveGlyphs({ LANG: "ru_RU.utf8" })).toBe(UNICODE_GLYPHS);
});

test("LC_ALL overrides LANG, as the locale rules say", () => {
  expect(resolveGlyphs({ LANG: "en_US.UTF-8", LC_ALL: "C" })).toBe(ASCII_GLYPHS);
});

test("a locale that says nothing about UTF-8 falls back to ASCII", () => {
  expect(resolveGlyphs({ LANG: "C" })).toBe(ASCII_GLYPHS);
  expect(resolveGlyphs({})).toBe(ASCII_GLYPHS);
});

test("the config setting wins over any locale", () => {
  expect(resolveGlyphs({ LANG: "en_US.UTF-8" }, true)).toBe(ASCII_GLYPHS);
  expect(resolveGlyphs({ LANG: "C" }, false)).toBe(UNICODE_GLYPHS);
});

test("no ASCII glyph contains a byte above 127", () => {
  const every = [
    ASCII_GLYPHS.mark, ASCII_GLYPHS.prompt, ASCII_GLYPHS.rule,
    ASCII_GLYPHS.bullet, ...ASCII_GLYPHS.spinner,
  ].join("");
  expect(every).toMatch(/^[\x20-\x7e]+$/);
});

test("both tables offer the same glyphs, so nothing is missing in ASCII", () => {
  expect(Object.keys(ASCII_GLYPHS).sort()).toEqual(Object.keys(UNICODE_GLYPHS).sort());
  expect(ASCII_GLYPHS.spinner.length).toBeGreaterThan(1);
});

test("every glyph is one column wide, or the frame arithmetic breaks", () => {
  for (const table of [ASCII_GLYPHS, UNICODE_GLYPHS]) {
    for (const glyph of [table.mark, table.prompt, table.rule, table.bullet, ...table.spinner]) {
      expect([...glyph]).toHaveLength(1);
    }
  }
});
