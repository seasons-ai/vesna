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
