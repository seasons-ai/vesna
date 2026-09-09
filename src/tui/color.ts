/**
 * Colour maths, and nothing else.
 *
 * Kept apart from the palettes so the rules that judge a colour cannot be
 * quietly bent by the colours being judged.
 */

export const RESET = "\x1b[0m";
/** Closes the foreground only, deliberately leaving any background in place. */
export const FG_RESET = "\x1b[39m";

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
