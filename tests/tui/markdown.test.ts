import { test, expect } from "bun:test";
import { renderMarkdown } from "../../src/tui/markdown";
import { UNICODE_GLYPHS, ASCII_GLYPHS } from "../../src/tui/glyphs";
import { resolveTheme } from "../../src/tui/theme";
import { visibleWidth } from "../../src/tui/wrap";

const theme = resolveTheme("mono", { depth: 0 });
const render = (text: string, width = 60) =>
  renderMarkdown(text, { theme, glyphs: UNICODE_GLYPHS, width });
const plain = (text: string, width = 60) => render(text, width).join("\n");

test("plain prose comes back as prose", () => {
  expect(plain("Just a sentence.")).toBe("Just a sentence.");
});

test("prose is wrapped to the width it was given", () => {
  for (const line of render("word ".repeat(60), 24)) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(24);
  }
});

test("a heading loses its hashes — they are markup, not content", () => {
  const out = plain("### A-tier — capability sandbox");
  expect(out).toContain("A-tier");
  expect(out).not.toContain("###");
});

test("every heading level is recognised, not just the short ones", () => {
  for (const level of ["#", "##", "###", "####"]) {
    expect(plain(`${level} Title`)).toContain("Title");
    expect(plain(`${level} Title`)).not.toContain("#");
  }
});

test("a hash that is not a heading stays put", () => {
  expect(plain("call #42 was fine")).toContain("#42");
});

test("bold and italic markers are consumed, the words are not", () => {
  const out = plain("this is **important** and *slanted*");
  expect(out).toContain("important");
  expect(out).toContain("slanted");
  expect(out).not.toContain("**");
  expect(out).not.toContain("*slanted*");
});

test("inline code keeps its content and drops its backticks", () => {
  const out = plain("run `bun test` now");
  expect(out).toContain("bun test");
  expect(out).not.toContain("`");
});

test("underscores inside a word are left alone, or snake_case breaks", () => {
  expect(plain("max_usd_per_run is the field")).toContain("max_usd_per_run");
});

test("a bullet list gets a real bullet and keeps its text", () => {
  const out = plain("- first\n- second");
  expect(out).toContain("first");
  expect(out).toContain("second");
  expect(out).toContain("•");
  expect(out).not.toMatch(/^- /m);
});

test("in ASCII mode not one non-ascii byte survives, across every construct", () => {
  const everything = [
    "# Heading",
    "- a bullet",
    "1. numbered",
    "> quoted",
    "---",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "```js",
    "const x = 1;",
    "```",
    "text with `code` and **bold**",
  ].join("\n");
  const out = renderMarkdown(everything, { theme, glyphs: ASCII_GLYPHS, width: 40 }).join("\n");
  expect(out).toMatch(/^[\x00-\x7f]*$/);
  expect(out).toContain("a bullet");
  expect(out).toContain("const x = 1;");
});

test("a numbered list keeps its numbers", () => {
  const out = plain("1. first\n2. second");
  expect(out).toContain("1.");
  expect(out).toContain("2.");
});

test("a wrapped bullet lines up under its own text, not under the bullet", () => {
  const lines = render(`- ${"long ".repeat(20)}`, 30);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines[1]!.startsWith("  ")).toBe(true);
});

test("a fenced code block keeps its lines verbatim, spacing and all", () => {
  const out = plain("```yaml\npermissions:\n  nodes: [read]\n```");
  expect(out).toContain("permissions:");
  expect(out).toContain("  nodes: [read]");
  expect(out).not.toContain("```");
});

test("markdown inside a code block is not interpreted", () => {
  expect(plain("```\n# not a heading\n**not bold**\n```")).toContain("# not a heading");
  expect(plain("```\n# not a heading\n**not bold**\n```")).toContain("**not bold**");
});

test("an unclosed fence still renders, because streaming answers arrive open", () => {
  const out = plain("```ts\nconst a = 1;");
  expect(out).toContain("const a = 1;");
});

test("a code line longer than the width is cut, never wrapped into nonsense", () => {
  for (const line of render("```\n" + "x".repeat(200) + "\n```", 30)) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(30);
  }
});

test("a table becomes aligned columns and loses its pipes-as-text", () => {
  const out = plain(
    "| Order | Why |\n|---|---|\n| 1 | Without measurement it is undecidable |\n| 2 | Growth needs limits |",
  );
  expect(out).toContain("Order");
  expect(out).toContain("Growth needs limits");
  expect(out).not.toContain("|---|");
});

test("table columns line up, which is the whole point of a table", () => {
  const lines = render("| a | bbbb |\n|---|---|\n| cccc | d |", 40);
  const rows = lines.filter((line) => line.includes("a") || line.includes("cccc"));
  expect(rows.length).toBeGreaterThanOrEqual(2);
  // Same column count means the same visible width on every row.
  const widths = new Set(rows.map((row) => visibleWidth(row)));
  expect(widths.size).toBe(1);
});

test("a blockquote is marked as quoted rather than read as body text", () => {
  const out = plain("> borrowed words");
  expect(out).toContain("borrowed words");
  expect(out).not.toMatch(/^> /m);
});

test("a horizontal rule becomes a rule the width of the space it has", () => {
  const lines = render("---", 20);
  expect(lines).toHaveLength(1);
  expect(visibleWidth(lines[0]!)).toBe(20);
});

test("a blank line between paragraphs survives", () => {
  expect(render("one\n\ntwo", 40)).toEqual(["one", "", "two"]);
});

test("nothing ever exceeds the width, whatever the input", () => {
  const messy = [
    "# Heading that is really quite long indeed for this width",
    "",
    "- a bullet with **bold** and `code` running well past the edge of the box",
    "",
    "| col | another column | a third |",
    "|---|---|---|",
    "| 1 | 2 | 3 |",
    "",
    "```js",
    "const x = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };",
    "```",
    "",
    "> a quotation that also goes on for a while",
    "---",
  ].join("\n");
  for (const width of [20, 30, 48, 80]) {
    for (const line of render(messy, width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }
});

test("rendering is stable — the same text twice gives the same lines", () => {
  const text = "# T\n\n- a\n- b\n\n```\ncode\n```";
  expect(render(text)).toEqual(render(text));
});
