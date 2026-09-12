/**
 * The one markdown renderer the transcript uses. No React, no DOM —
 * `test/markdown.test.ts` imports this under Bun.
 *
 * `html: false` makes markdown-it escape raw HTML instead of passing it
 * through, which is what lets the output go into `dangerouslySetInnerHTML`.
 * Code is not highlighted: a fence becomes `<pre class="code"><code
 * class="language-x">` and the stylesheet does the rest.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const { escapeHtml } = md.utils;

md.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]!;
  const language = token.info.trim().split(/\s+/)[0] ?? "";
  const attribute = language === "" ? "" : ` class="language-${escapeHtml(language)}"`;
  return `<pre class="code"><code${attribute}>${escapeHtml(token.content)}</code></pre>\n`;
};

md.renderer.rules.code_block = (tokens, index) => {
  return `<pre class="code"><code>${escapeHtml(tokens[index]!.content)}</code></pre>\n`;
};

export function render(source: string): string {
  return md.render(source);
}
