# Vesna brand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Vesna its own canvas — three sakura palettes plus mono, a faceted blossom mark, and an empty screen that teaches the product — with contrast and colour-approximation enforced by tests rather than by eye.

**Architecture:** Colour maths lives in one pure module; palettes are data validated by their own tests; the theme resolves a palette against a colour depth; the layout guarantees full-width lines and the screen driver paints the canvas behind them. Glyphs become a table so an ASCII terminal never sees a tofu box.

**Tech Stack:** TypeScript, Bun, `bun test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-vesna-brand-design.md`

## Global Constraints

- Every committed artifact is in English: code, comments, docs, commit messages.
- Never add `Co-Authored-By` or any AI attribution to a commit.
- TDD throughout: write the failing test, watch it fail, implement, watch it pass, commit. Never commit red.
- `bun test` and `bun run typecheck` must both be clean before every commit.
- Meaningful palette tokens must clear **4.5:1** against their own `bg`. Exempt: `faint`, `rule`.
- Within one palette, no two tokens may collapse onto the same xterm-256 code.
- Exact token values are fixed by the spec and must be copied verbatim; do not re-derive or "improve" them.
- The interface must remain fully usable with no colour at all.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tui/color.ts` (new) | Hex parsing, WCAG luminance and contrast, xterm-256 approximation, SGR builders. Pure maths, no palette knowledge. |
| `src/tui/palette.ts` (new) | The three palettes as token records. Data only. |
| `src/tui/glyphs.ts` (new) | The glyph table and the Unicode/ASCII decision. |
| `src/tui/emptystate.ts` (new) | The lines shown before the first message, and how they shrink. |
| `src/tui/theme.ts` (modify) | Colour depth, role names, resolving a palette into a `Theme`. |
| `src/tui/layout.ts` (modify) | Pad every line to exactly `cols`; centre the empty state. |
| `src/tui/screen.ts` (modify) | Emit the canvas background around each drawn line. |
| `src/tui/transcript.ts`, `src/tui/app.ts`, `src/tui/prompt.ts`, `src/cli/*.ts` (modify) | Role renames and glyph use. |
| `assets/*.svg` (new) | The mark and the two logo lockups. |

---

### Task 1: Rename the theme roles

A pure rename against the existing palettes, so the tree stays green while the
vocabulary changes. Nothing about colour changes in this task.

**Files:**
- Modify: `src/tui/theme.ts`
- Modify: `src/tui/transcript.ts`, `src/tui/app.ts`, `src/tui/prompt.ts`
- Modify: `src/cli/main.ts`, `src/cli/chat.ts`, `src/cli/dropped.ts`
- Test: `tests/tui/theme.test.ts` (existing)

**Interfaces:**
- Consumes: nothing.
- Produces: `type Role = "ok" | "warn" | "muted" | "petal" | "text"`.

- [ ] **Step 1: Update the existing theme test to the new names**

In `tests/tui/theme.test.ts`, replace every occurrence of the old role names in
assertions and calls: `accent` → `petal`, `label` → `text`, `dim` → `muted`,
`held` → `warn`. `ok` is unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/tui/theme.test.ts`
Expected: FAIL — TypeScript rejects the unknown role names.

- [ ] **Step 3: Rename in `theme.ts`**

```ts
export type Role = "ok" | "warn" | "muted" | "petal" | "text";

export const THEMES: Record<string, ThemeDefinition> = {
  vesna: {
    name: "vesna",
    roles: { ok: fg(78), warn: fg(215), muted: fg(245), petal: fg(114), text: fg(252) },
  },
  ember: {
    name: "ember",
    roles: { ok: fg(180), warn: fg(203), muted: fg(240), petal: fg(209), text: fg(223) },
  },
  dusk: {
    name: "dusk",
    roles: { ok: fg(110), warn: fg(176), muted: fg(243), petal: fg(147), text: fg(252) },
  },
  mono: {
    name: "mono",
    roles: { ok: "", warn: "", muted: "", petal: "", text: "" },
  },
};
```

- [ ] **Step 4: Rename every call site**

Run these in order, then read the diff before trusting it:

```bash
grep -rl 'paint("' src | xargs sed -i '' \
  -e 's/paint("accent"/paint("petal"/g' \
  -e 's/paint("label"/paint("text"/g' \
  -e 's/paint("dim"/paint("muted"/g' \
  -e 's/paint("held"/paint("warn"/g'
grep -rn 'paint("\(accent\|label\|dim\|held\)"' src || echo "no old role names left"
```

- [ ] **Step 5: Run the full suite and the typechecker**

Run: `bun test && bun run typecheck`
Expected: PASS, 394 tests, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(tui): name theme roles after what they mean

accent, label, dim and held described how a colour looked. petal, text,
muted and warn describe what it is for, which is the vocabulary the
palette work needs. No colour changes."
```

---

### Task 2: Colour maths

**Files:**
- Create: `src/tui/color.ts`
- Test: `tests/tui/color.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseHex(hex: string): { r: number; g: number; b: number }`
  - `relativeLuminance(hex: string): number`
  - `contrastRatio(a: string, b: string): number`
  - `nearest256(hex: string): number`
  - `fg24(hex: string): string`, `bg24(hex: string): string`
  - `fg8(code: number): string`, `bg8(code: number): string`
  - `RESET: string`

- [ ] **Step 1: Write the failing tests**

Create `tests/tui/color.test.ts`:

```ts
import { test, expect } from "bun:test";
import {
  bg24, bg8, contrastRatio, fg24, fg8, nearest256, parseHex, relativeLuminance,
} from "../../src/tui/color";

test("a hex string parses into channel bytes", () => {
  expect(parseHex("#14161F")).toEqual({ r: 0x14, g: 0x16, b: 0x1f });
});

test("the leading hash is optional and case does not matter", () => {
  expect(parseHex("e3e6ef")).toEqual(parseHex("#E3E6EF"));
});

test("luminance runs from black to white", () => {
  expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
  expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
});

test("black on white is the maximum contrast WCAG defines", () => {
  expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 2);
});

test("contrast does not care which colour is named first", () => {
  expect(contrastRatio("#14161F", "#E3E6EF")).toBeCloseTo(
    contrastRatio("#E3E6EF", "#14161F"), 6,
  );
});

test("a colour against itself has no contrast at all", () => {
  expect(contrastRatio("#BE4674", "#BE4674")).toBeCloseTo(1, 6);
});

test("the ratios the spec was written from still hold", () => {
  expect(contrastRatio("#14161F", "#E3E6EF")).toBeCloseTo(14.46, 1);
  expect(contrastRatio("#FBF7F4", "#7B6E77")).toBeCloseTo(4.54, 1);
});

test("pure colours land on their own cube entries", () => {
  expect(nearest256("#000000")).toBe(16);
  expect(nearest256("#FFFFFF")).toBe(231);
});

test("a near-black lands in the grey ramp, not on pure black", () => {
  expect(nearest256("#14161F")).toBe(234);
});

test("the two palette collisions the spec fixed stay fixed", () => {
  expect(nearest256("#14161F")).not.toBe(nearest256("#1C202C"));
  expect(nearest256("#BE4674")).not.toBe(nearest256("#B03A4A"));
});

test("every 24-bit sequence names all three channels", () => {
  expect(fg24("#F3AFC2")).toBe("\x1b[38;2;243;175;194m");
  expect(bg24("#14161F")).toBe("\x1b[48;2;20;22;31m");
});

test("the 8-bit sequences use the indexed form", () => {
  expect(fg8(217)).toBe("\x1b[38;5;217m");
  expect(bg8(234)).toBe("\x1b[48;5;234m");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tui/color.test.ts`
Expected: FAIL — `Cannot find module '../../src/tui/color'`.

- [ ] **Step 3: Implement**

Create `src/tui/color.ts`:

```ts
/**
 * Colour maths, and nothing else.
 *
 * Kept apart from the palettes so the rules that judge a colour cannot be
 * quietly bent by the colours being judged.
 */

export const RESET = "\x1b[0m";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  const text = hex.replace(/^#/, "");
  return {
    r: parseInt(text.slice(0, 2), 16),
    g: parseInt(text.slice(2, 4), 16),
    b: parseInt(text.slice(4, 6), 16),
  };
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The 6 levels of the xterm colour cube. */
const CUBE = [0, 95, 135, 175, 215, 255];

function palette256(): { code: number; rgb: Rgb }[] {
  const entries: { code: number; rgb: Rgb }[] = [];
  for (const [i, r] of CUBE.entries()) {
    for (const [j, g] of CUBE.entries()) {
      for (const [k, b] of CUBE.entries()) {
        entries.push({ code: 16 + 36 * i + 6 * j + k, rgb: { r, g, b } });
      }
    }
  }
  for (let i = 0; i < 24; i += 1) {
    const v = 8 + i * 10;
    entries.push({ code: 232 + i, rgb: { r: v, g: v, b: v } });
  }
  return entries;
}

const PALETTE_256 = palette256();

/** Nearest xterm-256 code by squared RGB distance. The 16 system colours are
 *  skipped: terminals redefine them, so they cannot be relied on. */
export function nearest256(hex: string): number {
  const { r, g, b } = parseHex(hex);
  let best = PALETTE_256[0]!;
  let bestDistance = Infinity;
  for (const entry of PALETTE_256) {
    const distance =
      (entry.rgb.r - r) ** 2 + (entry.rgb.g - g) ** 2 + (entry.rgb.b - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return best.code;
}

export function fg24(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function bg24(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

export function fg8(code: number): string {
  return `\x1b[38;5;${code}m`;
}

export function bg8(code: number): string {
  return `\x1b[48;5;${code}m`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/tui/color.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/color.ts tests/tui/color.test.ts
git commit -m "feat(tui): colour maths

WCAG luminance and contrast, xterm-256 approximation, and the SGR
builders for both depths. Separate from the palettes on purpose: the
rules that judge a colour should not live next to the colours."
```

---

### Task 3: The palettes, and the tests that keep them honest

**Files:**
- Create: `src/tui/palette.ts`
- Test: `tests/tui/palette.test.ts`

**Interfaces:**
- Consumes: `contrastRatio`, `nearest256` from `src/tui/color.ts`.
- Produces:
  - `type Token = "bg" | "panel" | "rule" | "text" | "muted" | "faint" | "petal" | "ice" | "ok" | "warn" | "error"`
  - `interface Palette { name: string; tokens: Record<Token, string> }`
  - `PALETTES: Record<string, Palette>`
  - `MEANINGFUL: readonly Token[]`
  - `MONO = "mono"`

- [ ] **Step 1: Write the failing tests**

Create `tests/tui/palette.test.ts`:

```ts
import { test, expect } from "bun:test";
import { contrastRatio, nearest256 } from "../../src/tui/color";
import { MEANINGFUL, PALETTES, type Token } from "../../src/tui/palette";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tui/palette.test.ts`
Expected: FAIL — `Cannot find module '../../src/tui/palette'`.

- [ ] **Step 3: Implement**

Create `src/tui/palette.ts`. Copy the hex values exactly; they were derived
against the contrast floor and the 256 collision rule, and nudging one
silently breaks a guarantee.

```ts
/**
 * The palettes, as data.
 *
 * Warm petal marks what a model is doing live; cold ice marks what has been
 * crystallised. That is the one rule a contributor has to keep, and the tests
 * beside this file enforce the rest.
 */

export type Token =
  | "bg"
  | "panel"
  | "rule"
  | "text"
  | "muted"
  | "faint"
  | "petal"
  | "ice"
  | "ok"
  | "warn"
  | "error";

export interface Palette {
  name: string;
  tokens: Record<Token, string>;
}

/** Tokens that carry meaning, and so must be legible. */
export const MEANINGFUL: readonly Token[] = [
  "text",
  "muted",
  "petal",
  "ice",
  "ok",
  "warn",
  "error",
];

/** A theme name that paints nothing at all. */
export const MONO = "mono";

export const PALETTES: Record<string, Palette> = {
  vesna: {
    name: "vesna",
    tokens: {
      bg: "#14161F",
      panel: "#1C202C",
      rule: "#242938",
      text: "#E3E6EF",
      muted: "#7B8194",
      faint: "#4E5468",
      petal: "#F3AFC2",
      ice: "#9FD3E8",
      ok: "#9BD5B4",
      warn: "#F0C07A",
      error: "#F090A0",
    },
  },
  hanami: {
    name: "hanami",
    tokens: {
      bg: "#17121C",
      panel: "#1F1826",
      rule: "#2A2130",
      text: "#EDE4EA",
      muted: "#8B7F92",
      faint: "#5E5266",
      petal: "#F2A9BE",
      ice: "#A9CFE0",
      ok: "#A8D8B9",
      warn: "#F0C07A",
      error: "#EE94A6",
    },
  },
  washi: {
    name: "washi",
    tokens: {
      bg: "#FBF7F4",
      panel: "#F4EEE9",
      rule: "#EBE1DB",
      text: "#3A3038",
      muted: "#7B6E77",
      faint: "#C9BDB6",
      petal: "#BE4674",
      ice: "#3C7995",
      ok: "#3D7F58",
      warn: "#9A6614",
      error: "#B03A4A",
    },
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/tui/palette.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the guard actually bites**

Temporarily set `washi.tokens.muted` to `"#9A8E96"` — the value the spec
rejected at 2.95:1 — and run `bun test tests/tui/palette.test.ts`. It must
FAIL and name `washi.muted`. Restore the correct value and confirm it passes
again. A guard nobody has seen fail is not known to work.

- [ ] **Step 6: Commit**

```bash
git add src/tui/palette.ts tests/tui/palette.test.ts
git commit -m "feat(tui): three palettes, and the rules that keep them legible

Two tests stand behind the numbers: every meaningful token clears 4.5:1
on its own canvas, and no two tokens in a palette collapse onto the same
256-colour code. Both already caught real defects while the spec was
being written, and both make contributing a theme a checkable PR."
```

---

### Task 4: Colour depth and theme resolution

**Files:**
- Modify: `src/tui/theme.ts`
- Modify: `src/cli/context.ts:34-36` (the `resolveTheme` call)
- Modify: `src/cli/main.ts` (the early-theme `resolveTheme` call)
- Test: `tests/tui/theme.test.ts`

**Interfaces:**
- Consumes: `PALETTES`, `MONO`, `Token` from `palette.ts`; `fg24`, `fg8`, `bg24`, `bg8`, `nearest256`, `RESET` from `color.ts`.
- Produces:
  - `type Role = Token`
  - `type ColorDepth = 0 | 8 | 24`
  - `colorDepth(env: Record<string, string | undefined>, isTTY: boolean): ColorDepth`
  - `interface Theme { name: string; depth: ColorDepth; paint(role: Role, text: string): string; surface: string }`
  - `resolveTheme(name: string | undefined, options: { depth: ColorDepth }): Theme`
  - `themeNames(): string[]`

- [ ] **Step 1: Rewrite the theme test**

Replace `tests/tui/theme.test.ts` entirely:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tui/theme.test.ts`
Expected: FAIL — `colorDepth` and `themeNames` do not exist.

- [ ] **Step 3: Rewrite `src/tui/theme.ts`**

```ts
import { bg24, bg8, fg24, fg8, nearest256, RESET } from "./color";
import { MONO, PALETTES, type Token } from "./palette";

export type Role = Token;

/** 0 = no colour, 8 = xterm-256, 24 = truecolor. */
export type ColorDepth = 0 | 8 | 24;

const DEFAULT_THEME = "vesna";

/**
 * Honours NO_COLOR first, then FORCE_COLOR, then whether stdout is a terminal,
 * and only then asks how much colour that terminal can show. Piped output and
 * CI logs must stay free of escape codes.
 */
export function colorDepth(
  env: Record<string, string | undefined>,
  isTTY: boolean,
): ColorDepth {
  const set = (value: string | undefined) => value !== undefined && value !== "";

  if (set(env.NO_COLOR)) return 0;
  if (env.TERM === "dumb") return 0;

  const forced = set(env.FORCE_COLOR) && env.FORCE_COLOR !== "0";
  if (!isTTY && !forced) return 0;

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return 24;
  if ((env.TERM ?? "").endsWith("-direct")) return 24;

  return 8;
}

export interface Theme {
  name: string;
  depth: ColorDepth;
  paint(role: Role, text: string): string;
  /** SGR that establishes the canvas, or "" when nothing is painted. */
  surface: string;
}

export function themeNames(): string[] {
  return [...Object.keys(PALETTES), MONO];
}

export function resolveTheme(
  name: string | undefined,
  options: { depth: ColorDepth },
): Theme {
  const wanted = name ?? DEFAULT_THEME;
  const paints = wanted !== MONO && options.depth !== 0;
  const palette = PALETTES[wanted] ?? PALETTES[DEFAULT_THEME]!;
  const themeName = wanted === MONO ? MONO : palette.name;

  const foreground = (hex: string) =>
    options.depth === 24 ? fg24(hex) : fg8(nearest256(hex));

  return {
    name: themeName,
    depth: options.depth,
    surface: paints
      ? options.depth === 24
        ? bg24(palette.tokens.bg)
        : bg8(nearest256(palette.tokens.bg))
      : "",
    paint(role, text) {
      if (!paints) return text;
      return `${foreground(palette.tokens[role])}${text}${RESET}`;
    },
  };
}
```

- [ ] **Step 4: Update the two call sites**

In `src/cli/context.ts`, replace the `resolveTheme` call:

```ts
  const theme = resolveTheme(config.theme, {
    depth: colorDepth(process.env, Boolean(process.stdout.isTTY)),
  });
```

and change the import from `colorSupported` to `colorDepth`. Apply the same
change to the early-theme construction in `src/cli/main.ts`.

- [ ] **Step 5: Run everything**

Run: `bun test && bun run typecheck`
Expected: PASS. Any test still importing `colorSupported` must be updated to
`colorDepth` with the equivalent depth.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tui): colour depth, and themes over the new palettes

colorSupported answered yes or no, which is not enough once the canvas
is ours: the same palette has to render as truecolor, as 256 colours, or
as nothing at all. A theme now resolves a palette against a depth, and
mono and depth zero are independent — either one paints nothing, and
neither changes a character of the text.

ember and dusk are dropped rather than ported."
```

---

### Task 5: The layout fills its lines

**Files:**
- Modify: `src/tui/layout.ts`
- Test: `tests/tui/layout.test.ts`

**Interfaces:**
- Consumes: `visibleWidth` from `wrap.ts`.
- Produces:
  - `ViewState` gains `panel?: string` — an SGR establishing the input box's own background, or `""`.
  - `Frame` gains `surfaces?: (string | undefined)[]`, parallel to `lines`; an entry overrides the canvas for that row. Optional, so a hand-built frame in a test stays valid — `layout` always sets it.
  - `layout(view, size): Frame` with every line exactly `cols` wide.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tui/layout.test.ts`:

```ts
test("every line is exactly as wide as the terminal, not merely no wider", () => {
  const frame = layout(view({ transcript: ["short", "a bit longer"] }), size);
  for (const line of frame.lines) expect(visibleWidth(line)).toBe(30);
});

test("the blank lines above a short conversation are filled too", () => {
  const frame = layout(view({ transcript: ["only"] }), size);
  expect(frame.lines.filter((line) => visibleWidth(line) !== 30)).toEqual([]);
});

test("lines stay full width at every window size", () => {
  for (const rows of [1, 2, 3, 4, 10, 40]) {
    for (const cols of [8, 20, 30, 120]) {
      const frame = layout(view({ transcript: ["x".repeat(200)] }), { rows, cols });
      for (const line of frame.lines) expect(visibleWidth(line)).toBe(cols);
    }
  }
});

test("padding is plain space, so a wrapped colour cannot bleed into it", () => {
  const painted = "\x1b[38;5;217mpetal\x1b[0m";
  const frame = layout(view({ transcript: [painted] }), size);
  const row = frame.lines.find((line) => line.includes("petal"))!;
  expect(row.endsWith(" ")).toBe(true);
  expect(row).toContain("\x1b[0m");
});

test("there is one surface entry per line, so the screen can pair them up", () => {
  const frame = layout(view(), size);
  expect(frame.surfaces).toHaveLength(frame.lines.length);
});

test("the input rows sit on the panel surface and the rest on the canvas", () => {
  const panel = "\x1b[48;5;235m";
  const editor = { ...createEditor(), text: "one\ntwo", cursor: 7 };
  const frame = layout(view({ editor, panel }), size);
  const rows = frame.surfaces
    .map((surface, index) => (surface === panel ? index : -1))
    .filter((index) => index >= 0);

  // Exactly the two input rows, immediately above the status line.
  expect(rows).toHaveLength(2);
  expect(rows.at(-1)).toBe(frame.lines.length - 2);
  expect(frame.lines[rows[0]!]).toContain("one");
});

test("with no panel every row falls back to the canvas", () => {
  const frame = layout(view(), size);
  expect(frame.surfaces.every((surface) => surface === undefined)).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tui/layout.test.ts`
Expected: FAIL — short lines report their own width, not 30.

- [ ] **Step 3: Implement**

In `src/tui/layout.ts`, add `panel?: string` to `ViewState` and
`surfaces: (string | undefined)[]` to `Frame`. Track the rows as they are
pushed, then add the helper and apply it to the finished frame:

```ts
/**
 * Owning the canvas means owning every cell. A line shorter than the window
 * lets the user's own background show through, and the frame looks torn rather
 * than designed.
 */
function pad(line: string, cols: number): string {
  const width = visibleWidth(line);
  return width >= cols ? line : line + " ".repeat(cols - width);
}
```

Record which rows belong to the input box as they are pushed. Immediately
before `lines.push(...)` for the input rows:

```ts
  const inputFirstRow = lines.length;
```

and after that loop:

```ts
  const inputLastRow = lines.length - 1;
```

Then change the return so every line is padded after slicing, and each row
carries the surface it belongs on:

```ts
  const kept = lines.slice(0, rows);
  const panel = view.panel !== undefined && view.panel !== "" ? view.panel : undefined;

  return {
    // A window too small for the layout still gets exactly the rows it has,
    // and every one of them is exactly as wide as the window.
    lines: kept.map((line) => pad(line, cols)),
    // The input box is lifted off the canvas, so the eye finds where to type
    // without a border drawn around it.
    surfaces: kept.map((_, index) =>
      panel !== undefined && index >= inputFirstRow && index <= inputLastRow
        ? panel
        : undefined,
    ),
    cursor: {
      row: Math.min(inputTop + cursor.row, rows - 1),
      col: Math.min(prompt.length + cursor.col, cols),
    },
  };
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/tui/layout.test.ts && bun test && bun run typecheck`
Expected: PASS. The pre-existing "no line is wider than the terminal" test still
passes, since equality satisfies it.

- [ ] **Step 5: Commit**

```bash
git add src/tui/layout.ts tests/tui/layout.test.ts
git commit -m "feat(tui): every frame line fills the window

The layout guaranteed no line was too wide. Owning the canvas needs the
other half of that promise: a short line lets the user's own background
show through and the frame looks torn."
```

---

### Task 6: The screen paints the canvas

**Files:**
- Modify: `src/tui/screen.ts`
- Modify: `src/tui/app.ts` (the `createScreen` call)
- Test: `tests/tui/screen.test.ts`

**Interfaces:**
- Consumes: `Theme.surface` from `theme.ts`.
- Produces: `createScreen(terminal: Terminal, options?: { surface?: string }): Screen`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tui/screen.test.ts`:

```ts
const SURFACE = "\x1b[48;5;234m";

test("entering clears the screen with the canvas colour, not the terminal's", () => {
  const host = fake();
  createScreen(host.terminal, { surface: SURFACE }).enter();
  const output = host.writes.join("");
  expect(output.indexOf(SURFACE)).toBeLessThan(output.indexOf("\x1b[2J"));
});

test("each drawn line is written on the canvas and closed afterwards", () => {
  const host = fake();
  createScreen(host.terminal, { surface: SURFACE }).draw(frame(["a", "b"]));
  expect(host.last()).toContain(`\x1b[2K${SURFACE}a\x1b[0m`);
});

test("the canvas is re-established for every line, so one reset cannot strip the rest", () => {
  const host = fake();
  createScreen(host.terminal, { surface: SURFACE }).draw(frame(["a", "b", "c"]));
  expect(host.last().split(SURFACE)).toHaveLength(4);
});

test("a row with its own surface gets that one instead of the canvas", () => {
  const PANEL = "\x1b[48;5;235m";
  const host = fake();
  createScreen(host.terminal, { surface: SURFACE }).draw({
    lines: ["a", "b"],
    surfaces: [undefined, PANEL],
    cursor: { row: 0, col: 0 },
  });
  expect(host.last()).toContain(`\x1b[2K${SURFACE}a\x1b[0m`);
  expect(host.last()).toContain(`\x1b[2K${PANEL}b\x1b[0m`);
});

test("without a surface nothing extra is emitted at all", () => {
  const host = fake();
  createScreen(host.terminal).draw(frame(["a"]));
  expect(host.last()).not.toContain("\x1b[48;");
  expect(host.last()).toContain("\x1b[2Ka");
});

test("leaving resets the colour before handing the terminal back", () => {
  const host = fake();
  const screen = createScreen(host.terminal, { surface: SURFACE });
  screen.enter();
  host.writes.length = 0;
  screen.leave();
  const output = host.writes.join("");
  expect(output.indexOf("\x1b[0m")).toBeLessThan(output.indexOf("\x1b[?1049l"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tui/screen.test.ts`
Expected: FAIL — `createScreen` takes one argument and emits no background.

- [ ] **Step 3: Implement**

In `src/tui/screen.ts`, import `RESET` from `./color`, then:

```ts
export function createScreen(
  terminal: Terminal,
  options: { surface?: string } = {},
): Screen {
  const surface = options.surface ?? "";
  let previous: string[] = [];
  let lastSize = { rows: -1, cols: -1 };

  return {
    size: () => terminal.size(),

    enter() {
      terminal.write(`${ALT_ON}${CURSOR_HIDE}${PASTE_ON}${surface}${CLEAR_ALL}`);
      previous = [];
    },

    leave() {
      terminal.write(`${RESET}${PASTE_OFF}${CURSOR_SHOW}${ALT_OFF}`);
    },

    draw(frame: Frame) {
      const size = terminal.size();
      if (size.rows !== lastSize.rows || size.cols !== lastSize.cols) {
        previous = [];
        lastSize = size;
      }

      let out = CURSOR_HIDE;
      for (const [index, line] of frame.lines.entries()) {
        if (previous[index] === line) continue;
        // The canvas is re-established per line: a reset inside painted text
        // would otherwise drop the background for everything after it.
        const behind = frame.surfaces?.[index] ?? surface;
        out += behind === ""
          ? `${moveTo(index, 0)}${CLEAR_LINE}${line}`
          : `${moveTo(index, 0)}${CLEAR_LINE}${behind}${line}${RESET}`;
      }
      out += `${moveTo(frame.cursor.row, frame.cursor.col)}${CURSOR_SHOW}`;

      terminal.write(out);
      previous = [...frame.lines];
    },
  };
}
```

In `src/tui/app.ts`, pass the theme's surface, and the panel surface into the
view:

```ts
  const screen = createScreen(io.terminal, { surface: theme.surface });
```

`Theme` gains one more accessor for this, alongside `surface`, built the same
way from `palette.tokens.panel`:

```ts
    panel: paints
      ? options.depth === 24
        ? bg24(palette.tokens.panel)
        : bg8(nearest256(palette.tokens.panel))
      : "",
```

Add `panel: string` to the `Theme` interface, assert it in the theme test
beside the existing `surface` assertions, and pass `panel: theme.panel` in
`currentView()`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify it live**

Run `bun bin/vesna chat` in a truecolor terminal, confirm the whole window takes
the canvas colour rather than showing the shell's background behind short
lines, then leave with ctrl-c twice and confirm the shell's own colours return.
Repeat with `NO_COLOR=1 bun bin/vesna chat` and confirm the interface is intact
and entirely uncoloured.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tui): paint the canvas

The alternate screen and every drawn line now carry the theme's own
background, re-established per line so a reset inside painted text
cannot strip it from everything after. Without a surface — mono, or a
terminal with no colour — not one extra byte is emitted."
```

---

### Task 7: Glyphs, and never showing a tofu box

**Files:**
- Create: `src/tui/glyphs.ts`
- Test: `tests/tui/glyphs.test.ts`
- Modify: `src/tui/layout.ts` (the `PROMPT` constant and the `─` rule)
- Modify: `src/tui/transcript.ts` (the `›` and `·`)
- Modify: `src/tui/app.ts` (header mark, spinner)
- Modify: `src/tui/render.ts` (the braille spinner)
- Modify: `src/cli/config.ts` (the `ascii` option)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Glyphs { mark: string; prompt: string; rule: string; bullet: string; cursor: string; spinner: readonly string[] }`
  - `UNICODE_GLYPHS: Glyphs`, `ASCII_GLYPHS: Glyphs`
  - `resolveGlyphs(env: Record<string, string | undefined>, ascii?: boolean): Glyphs`

- [ ] **Step 1: Write the failing tests**

Create `tests/tui/glyphs.test.ts`:

```ts
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
    ASCII_GLYPHS.bullet, ASCII_GLYPHS.cursor, ...ASCII_GLYPHS.spinner,
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tui/glyphs.test.ts`
Expected: FAIL — `Cannot find module '../../src/tui/glyphs'`.

- [ ] **Step 3: Implement**

Create `src/tui/glyphs.ts`:

```ts
/**
 * The characters the frame is drawn from.
 *
 * A terminal cannot be asked whether its font has a glyph, and a tofu box in
 * the header does more damage than no mark at all. So the decision is made
 * from what is knowable — the locale — and can always be overridden.
 */

export interface Glyphs {
  mark: string;
  prompt: string;
  rule: string;
  bullet: string;
  cursor: string;
  spinner: readonly string[];
}

export const UNICODE_GLYPHS: Glyphs = {
  mark: "❀",
  prompt: "›",
  rule: "─",
  bullet: "·",
  cursor: "▏",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

export const ASCII_GLYPHS: Glyphs = {
  mark: "*",
  prompt: ">",
  rule: "-",
  bullet: "-",
  cursor: "_",
  spinner: ["|", "/", "-", "\\"],
};

export function resolveGlyphs(
  env: Record<string, string | undefined>,
  ascii?: boolean,
): Glyphs {
  if (ascii !== undefined) return ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;

  const locale = env.LC_ALL ?? env.LANG ?? "";
  return /utf-?8/i.test(locale) ? UNICODE_GLYPHS : ASCII_GLYPHS;
}
```

- [ ] **Step 4: Thread the glyphs through the frame**

`ViewState` gains a `glyphs: Glyphs` field. In `layout.ts`, replace the module
constant `PROMPT` with a per-frame value and use the rule glyph:

```ts
  const prompt = `${view.glyphs.prompt} `;
  const inner = Math.max(1, cols - prompt.length);
  // ...
  lines.push(view.glyphs.rule.repeat(cols));
```

Update every use of `PROMPT` in that file to `prompt`, and export
`promptOf(glyphs: Glyphs): string` so tests and `app.ts` agree on the width.

In `transcript.ts`, `createTranscript(theme, glyphs)` uses `glyphs.prompt` for
the user line and `glyphs.bullet` for a step. In `render.ts`, `spinnerFrame`
takes the frames: `spinnerFrame(tick: number, frames: readonly string[])`.
In `app.ts`, resolve once at start-up and pass it everywhere:

```ts
  const glyphs = resolveGlyphs(process.env, deps.config.ascii);
```

Add `ascii?: boolean` to `VesnaConfig` in `src/cli/config.ts`, read as
`raw.ascii === true ? true : raw.ascii === false ? false : undefined`. Three
states matter and the middle one is the default, so it cannot be a plain
boolean: unset means "ask the locale".

Cover it in `tests/cli/config-codex.test.ts`, which already has a `project()`
helper that writes a config file:

```ts
test("ascii is tri-state: unset means ask the locale", async () => {
  expect((await loadConfig(await project("provider: openai\n"))).ascii).toBeUndefined();
  expect((await loadConfig(await project("ascii: true\n"))).ascii).toBe(true);
  expect((await loadConfig(await project("ascii: false\n"))).ascii).toBe(false);
});

test("a non-boolean ascii is ignored rather than taken as true", async () => {
  expect((await loadConfig(await project("ascii: yes please\n"))).ascii).toBeUndefined();
});
```

- [ ] **Step 5: Update the call sites the new signatures break**

Two signatures change, and existing tests call both. Fix them in the same
commit or the tree goes red:

- `createTranscript(theme)` becomes `createTranscript(theme, glyphs)`.
  `tests/tui/transcript.test.ts` calls it 12 times. Add
  `import { UNICODE_GLYPHS } from "../../src/tui/glyphs";` and pass it:

```bash
sed -i '' 's/createTranscript(theme)/createTranscript(theme, UNICODE_GLYPHS)/g' \
  tests/tui/transcript.test.ts
```

- `spinnerFrame(tick)` becomes `spinnerFrame(tick, frames)`. Update
  `tests/tui/render.test.ts` to pass `UNICODE_GLYPHS.spinner`, and assert the
  ASCII table cycles too:

```ts
test("the spinner cycles through whichever frames it is given", () => {
  expect(spinnerFrame(0, ASCII_GLYPHS.spinner)).toBe("|");
  expect(spinnerFrame(4, ASCII_GLYPHS.spinner)).toBe("|");
  expect(spinnerFrame(1, UNICODE_GLYPHS.spinner)).toBe("⠙");
});
```

Also update the layout tests: `PROMPT` is no longer a module constant, so any
test importing it uses `promptOf(UNICODE_GLYPHS)` instead, and `view()` helpers
must supply `glyphs: UNICODE_GLYPHS`.

- [ ] **Step 6: Add the frame-level guarantee**

Append to `tests/tui/app.test.ts`:

```ts
test("in ASCII mode not one non-ascii byte reaches the screen", async () => {
  const host = fakeTerminal();
  const input = keyboard();
  const base = await deps(reply("done"));
  const finished = runApp({ ...base, config: { ...base.config, ascii: true } }, {
    terminal: host.terminal, input,
  });
  await until(() => host.screen().includes("vesna"), "the first frame");
  input.type("hello\r");
  await until(() => host.screen().includes("done"), "the answer");
  expect(host.screen()).toMatch(/^[\x00-\x7f]*$/);
  input.type("\x03\x03\x03");
  await finished;
});
```

- [ ] **Step 7: Run everything**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(tui): a glyph table, and an ASCII frame that is whole

A font cannot be interrogated for a glyph, and a tofu box in the header
is worse than no mark. The locale decides, ascii: true overrides, and
the ASCII table covers every character the frame draws — mark, prompt,
rule, bullet, cursor and spinner — so the fallback is a complete
interface rather than a patched one."
```

---

### Task 8: The empty screen

**Files:**
- Create: `src/tui/emptystate.ts`
- Test: `tests/tui/emptystate.test.ts`
- Modify: `src/tui/layout.ts` (centre it when the conversation is empty)
- Modify: `src/tui/app.ts` (build it; drop the launch notice)

**Interfaces:**
- Consumes: `Theme`, `Glyphs`.
- Produces: `emptyState(options: { theme: Theme; glyphs: Glyphs; cols: number; rows: number }): string[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/tui/emptystate.test.ts`:

```ts
import { test, expect } from "bun:test";
import { emptyState } from "../../src/tui/emptystate";
import { UNICODE_GLYPHS, ASCII_GLYPHS } from "../../src/tui/glyphs";
import { resolveTheme } from "../../src/tui/theme";
import { visibleWidth } from "../../src/tui/wrap";

const theme = resolveTheme("mono", { depth: 0 });
const at = (cols: number, rows: number) =>
  emptyState({ theme, glyphs: UNICODE_GLYPHS, cols, rows });

test("the mark and the wordmark are always there", () => {
  const text = at(70, 12).join("\n");
  expect(text).toContain("❀");
  expect(text).toContain("v e s n a");
});

test("a roomy window gets the three examples", () => {
  const text = at(70, 12).join("\n");
  expect(text).toContain("ask for something");
  expect(text).toContain("freeze what worked");
  expect(text).toContain("run it forever");
});

test("a narrow window drops the examples and keeps the mark", () => {
  const text = at(40, 12).join("\n");
  expect(text).toContain("v e s n a");
  expect(text).not.toContain("freeze what worked");
});

test("a short window drops the examples too", () => {
  const text = at(70, 6).join("\n");
  expect(text).not.toContain("freeze what worked");
});

test("nothing ever overflows the width it was given", () => {
  for (const cols of [20, 30, 40, 55, 70, 120]) {
    for (const line of at(cols, 14)) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
  }
});

test("it never asks for more rows than it was given", () => {
  for (const rows of [3, 6, 9, 14, 40]) expect(at(70, rows).length).toBeLessThanOrEqual(rows);
});

test("the composition is centred, not flush left", () => {
  const mark = at(70, 12).find((line) => line.includes("❀"))!;
  const indent = mark.length - mark.trimStart().length;
  expect(indent).toBeGreaterThan(10);
});

test("ASCII mode uses the ASCII mark and stays ascii throughout", () => {
  const lines = emptyState({ theme, glyphs: ASCII_GLYPHS, cols: 70, rows: 12 });
  expect(lines.join("\n")).toMatch(/^[\x00-\x7f]*$/);
  expect(lines.join("\n")).toContain("*");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tui/emptystate.test.ts`
Expected: FAIL — `Cannot find module '../../src/tui/emptystate'`.

- [ ] **Step 3: Implement**

Create `src/tui/emptystate.ts`:

```ts
import type { Glyphs } from "./glyphs";
import type { Theme } from "./theme";
import { visibleWidth } from "./wrap";

/**
 * What is on screen before the first message.
 *
 * An empty state, not a notice: a notice stays in the history and clutters the
 * rest of the session, while this exists only while there is nothing to show
 * and disappears the moment the user says something.
 */

const TAGLINE = "spring, and what comes back";

const EXAMPLES: [string, string][] = [
  ["ask for something", "read src/*.ts and find the dead code"],
  ["freeze what worked", "/crystallize report"],
  ["run it forever", "vesna run report --map clients.csv"],
];

/** Below these the examples do not fit without wrapping into nonsense. */
const EXAMPLES_MIN_COLS = 62;
const EXAMPLES_MIN_ROWS = 9;

export function emptyState(options: {
  theme: Theme;
  glyphs: Glyphs;
  cols: number;
  rows: number;
}): string[] {
  const { theme, glyphs, cols, rows } = options;
  const centre = (text: string) => {
    const pad = Math.max(0, Math.floor((cols - visibleWidth(text)) / 2));
    return " ".repeat(pad) + text;
  };

  const lines = [
    centre(theme.paint("petal", glyphs.mark)),
    centre(theme.paint("text", "v e s n a")),
    centre(theme.paint("muted", TAGLINE)),
  ];

  if (cols >= EXAMPLES_MIN_COLS && rows >= EXAMPLES_MIN_ROWS) {
    const label = Math.max(...EXAMPLES.map(([left]) => left.length));
    lines.push("");
    for (const [left, right] of EXAMPLES) {
      lines.push(
        centre(`${theme.paint("faint", left.padEnd(label))}   ${theme.paint("muted", right)}`),
      );
    }
  }

  return lines.slice(0, rows);
}
```

- [ ] **Step 4: Centre it in the conversation area**

`ViewState` gains `empty?: string[]`. In `layout.ts`, when the transcript is
empty and `empty` is present, centre those lines vertically in the conversation
area instead of resting them on the input box:

```ts
  const wrapped = view.transcript.flatMap((line) => wrapAnsi(line, cols));
  const body = Math.max(0, transcriptRows);
  if (wrapped.length === 0 && view.empty !== undefined && view.empty.length > 0) {
    const shown = view.empty.slice(0, body);
    const above = Math.max(0, Math.floor((body - shown.length) / 2));
    lines.push(
      ...Array<string>(above).fill(""),
      ...shown,
      ...Array<string>(Math.max(0, body - above - shown.length)).fill(""),
    );
  } else {
    lines.push(...windowOf(wrapped, body, view.scroll));
  }
```

- [ ] **Step 5: Use it in the app, and delete the launch notice**

In `src/tui/app.ts`, remove `transcript.notice("vesna — /help for commands", "dim")`
and supply the empty state in `currentView()`:

```ts
    const size = screen.size();
    return {
      header: header(deps, glyphs),
      transcript: transcript.lines(),
      empty: emptyState({ theme, glyphs, cols: size.cols, rows: size.rows }),
      editor,
      hint: hint(theme, busy, confirmExit),
      status: status(deps, session, busy, tick),
      scroll,
    };
```

- [ ] **Step 6: Prove it appears and then leaves**

Append to `tests/tui/app.test.ts`:

```ts
test("the empty screen greets you and then gets out of the way", async () => {
  const app = await start(reply("answered"));
  expect(app.screen()).toContain("v e s n a");
  expect(app.screen()).toContain("freeze what worked");
  app.input.type("hello\r");
  await until(() => app.screen().includes("answered"), "the answer");
  expect(app.screen()).not.toContain("freeze what worked");
  await quit(app);
});
```

- [ ] **Step 7: Run everything**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(tui): an empty screen that teaches, then leaves

Before the first message: the mark, the wordmark, and three examples
that say what Vesna is for — ask, freeze, run forever. It is an empty
state rather than a notice, so it does not sit in the history for the
rest of the session, and it drops the examples when the window is too
small to hold them honestly."
```

---

### Task 9: The mark, and the README

**Files:**
- Create: `assets/mark.svg`, `assets/logo-dark.svg`, `assets/logo-light.svg`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: the palette hex values from Task 3.
- Produces: nothing importable.

- [ ] **Step 1: Draw the mark**

Create `assets/mark.svg`. One petal path, rotated five times; an ice spine
along each; an ice core:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-52 -52 104 104" width="104" height="104" role="img" aria-label="Vesna">
  <title>Vesna</title>
  <g fill="#F3AFC2">
    <path d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
    <path transform="rotate(72)" d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
    <path transform="rotate(144)" d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
    <path transform="rotate(216)" d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
    <path transform="rotate(288)" d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
  </g>
  <g stroke="#9FD3E8" stroke-width="2.4" stroke-linecap="round">
    <line y1="-7" y2="-31"/>
    <line transform="rotate(72)" y1="-7" y2="-31"/>
    <line transform="rotate(144)" y1="-7" y2="-31"/>
    <line transform="rotate(216)" y1="-7" y2="-31"/>
    <line transform="rotate(288)" y1="-7" y2="-31"/>
  </g>
  <circle r="5.2" fill="#9FD3E8"/>
</svg>
```

- [ ] **Step 2: Build the two lockups**

Create `assets/logo-dark.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 96" width="320" height="96" role="img" aria-label="Vesna">
  <title>Vesna</title>
  <g transform="translate(48 48) scale(0.86)">
    <g fill="#F3AFC2">
      <path d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
      <path transform="rotate(72)" d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
      <path transform="rotate(144)" d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
      <path transform="rotate(216)" d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
      <path transform="rotate(288)" d="M0,0 C-15,-13 -14,-31 -8.2,-44 L0,-36 L8.2,-44 C14,-31 15,-13 0,0 Z"/>
    </g>
    <g stroke="#9FD3E8" stroke-width="2.4" stroke-linecap="round">
      <line y1="-7" y2="-31"/>
      <line transform="rotate(72)" y1="-7" y2="-31"/>
      <line transform="rotate(144)" y1="-7" y2="-31"/>
      <line transform="rotate(216)" y1="-7" y2="-31"/>
      <line transform="rotate(288)" y1="-7" y2="-31"/>
    </g>
    <circle r="5.2" fill="#9FD3E8"/>
  </g>
  <text x="108" y="61" font-family="system-ui, -apple-system, Segoe UI, sans-serif"
        font-size="36" font-weight="500" letter-spacing="2" fill="#E3E6EF">vesna</text>
</svg>
```

Create `assets/logo-light.svg` as a byte-for-byte copy with three substitutions,
so the two never drift apart:

```bash
sed -e 's/#F3AFC2/#BE4674/g' -e 's/#9FD3E8/#3C7995/g' -e 's/#E3E6EF/#3A3038/g' \
  assets/logo-dark.svg > assets/logo-light.svg
```

- [ ] **Step 3: Check the mark survives being small**

Open `assets/mark.svg` in a browser at 16×16 and confirm the five petals still
read as a blossom rather than a blob. If they do not, thicken the ice spines
before continuing — a mark that fails at favicon size fails the spec.

- [ ] **Step 4: Put it in the README**

Replace the `# Vesna` heading with a picture that follows the reader's theme:

```markdown
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="Vesna" src="assets/logo-light.svg" width="240">
</picture>
```

- [ ] **Step 5: Correct the stale claim while you are in the file**

The README says "covered by 92 tests". Replace the count with the current one
from `bun test`, and add a Themes section:

```markdown
## Themes

`vesna` (default), `hanami`, `washi`, and `mono`. Set one in `.vesna/config.yaml`:

```yaml
theme: hanami
```

Warm petal marks what a model is doing live; cold ice marks what has been
crystallised. A theme is a table of eleven colours, and two tests keep it
honest — every meaningful colour must clear 4.5:1 against its own background,
and no two may collapse onto the same 256-colour code. Adding one is a small
pull request.
```

- [ ] **Step 6: Point contributors at it**

In `CONTRIBUTING.md`, add "write a theme" alongside "write a node" as a first
contribution: name `src/tui/palette.ts`, the two guarantees, and the fact that
`bun test tests/tui/palette.test.ts` is the whole review.

- [ ] **Step 7: Verify**

Run: `bun test && bun run typecheck`
Expected: PASS. Then confirm the README renders correctly on GitHub in both
light and dark once pushed.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(brand): the mark, and a README that shows it

A five-petal blossom with faceted petals and an ice core: one drawing
that reads as both a flower and a crystal, and holds together from a
README header down to a favicon. The README follows the reader's theme
rather than assuming a dark one, documents the four themes, and no
longer claims a test count it outgrew months ago."
```

---

## Definition of done

- `bun test` and `bun run typecheck` are clean.
- `vesna chat` on a truecolor terminal paints its own canvas edge to edge.
- The same command under `NO_COLOR=1` is uncoloured and completely usable.
- The same command under `LANG=C` shows no character above ASCII 127.
- Deliberately breaking one palette value fails the contrast or collision test
  and names the offending token.
- The empty screen appears at launch and is gone after the first message.
- The README logo is legible on both light and dark GitHub.
