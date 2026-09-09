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
