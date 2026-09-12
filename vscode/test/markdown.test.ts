import { test, expect } from "bun:test";
import { render } from "../webview/markdown";

test("a heading, a fence, a link — and raw HTML is escaped, never passed through", () => {
  const html = render("# a\n\n```js\nx\n```\n<b>no</b>\n\nsee https://example.com");
  expect(html).toContain("<h1>a</h1>");
  expect(html).toContain('<pre class="code"><code class="language-js">x\n</code></pre>');
  expect(html).toContain("&lt;b&gt;no&lt;/b&gt;");
  expect(html).not.toContain("<b>");
  expect(html).toContain('<a href="https://example.com">https://example.com</a>');
});

test("a fence without a language still gets the code class", () => {
  expect(render("```\nplain\n```")).toContain('<pre class="code"><code>plain\n</code></pre>');
});

test("a single newline inside a paragraph is not a line break", () => {
  expect(render("one\ntwo")).not.toContain("<br");
});
