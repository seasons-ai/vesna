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
  /** Vertical bar: a code gutter, a quote bar, a column divider. */
  gutter: string;
  /** A list item in rendered prose, distinct from the tool-step bullet. */
  listItem: string;
  /** Marks the button that copies a message. */
  copy: string;
  spinner: readonly string[];
}

export const UNICODE_GLYPHS: Glyphs = {
  mark: "❀",
  prompt: "›",
  rule: "─",
  bullet: "·",
  gutter: "│",
  listItem: "•",
  copy: "⧉",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

export const ASCII_GLYPHS: Glyphs = {
  mark: "*",
  prompt: ">",
  rule: "-",
  bullet: "-",
  gutter: "|",
  listItem: "*",
  copy: "+",
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
