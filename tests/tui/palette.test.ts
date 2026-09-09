import { test, expect } from "bun:test";
import { contrastRatio, nearest256 } from "../../src/tui/color";
import { MEANINGFUL, MEANING, PALETTES, type Token } from "../../src/tui/palette";

const palettes = Object.values(PALETTES);

test("the three shipped palettes are present and named", () => {
  expect(Object.keys(PALETTES).sort()).toEqual(["hanami", "vesna", "washi"]);
});

test("every meaningful token clears 4.5:1 against its own canvas", () => {
  for (const palette of palettes) {
    for (const token of MEANINGFUL) {
      const ratio = contrastRatio(palette.tokens.bg, palette.tokens[token]);
      expect(`${palette.name}.${token} ${ratio.toFixed(2)}`).toBe(
        `${palette.name}.${token} ${Math.max(ratio, 4.5).toFixed(2)}`,
      );
    }
  }
});

test("faint and rule are exempt, because they are decoration and not text", () => {
  expect(MEANINGFUL).not.toContain("faint" as Token);
  expect(MEANINGFUL).not.toContain("rule" as Token);
  expect(MEANINGFUL).not.toContain("bg" as Token);
  expect(MEANINGFUL).not.toContain("panel" as Token);
});

test("no two tokens in a palette collapse onto one 256-colour code", () => {
  for (const palette of palettes) {
    const seen = new Map<number, Token>();
    for (const [token, hex] of Object.entries(palette.tokens) as [Token, string][]) {
      const code = nearest256(hex);
      const clash = seen.get(code);
      expect(`${palette.name}: ${token} vs ${clash ?? "nothing"} at ${code}`).toBe(
        `${palette.name}: ${token} vs nothing at ${code}`,
      );
      seen.set(code, token);
    }
  }
});

test("the canvas and the input box stay distinguishable at both depths", () => {
  for (const palette of palettes) {
    expect(palette.tokens.panel).not.toBe(palette.tokens.bg);
    expect(nearest256(palette.tokens.panel)).not.toBe(nearest256(palette.tokens.bg));
  }
});

test("every token is a full six-digit hex, so nothing is half-specified", () => {
  for (const palette of palettes) {
    for (const hex of Object.values(palette.tokens)) {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    }
  }
});

test("vesna is dark and washi is light, as the spec describes them", () => {
  expect(contrastRatio("#000000", PALETTES.vesna!.tokens.bg)).toBeLessThan(2);
  expect(contrastRatio("#FFFFFF", PALETTES.washi!.tokens.bg)).toBeLessThan(1.2);
});

test("every token declares whether it carries meaning, so a new one cannot slip the guard", () => {
  // The compiler forces the declaration; this asserts the declaration is what
  // MEANINGFUL is actually derived from, rather than a second list beside it.
  const declared = Object.keys(MEANING) as Token[];
  for (const palette of palettes) {
    for (const token of Object.keys(palette.tokens) as Token[]) {
      expect(declared).toContain(token);
    }
  }
  expect([...MEANINGFUL]).toEqual(declared.filter((token) => MEANING[token]));
});
