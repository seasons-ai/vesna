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
