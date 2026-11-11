import { describe, expect, test } from "bun:test";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import { appendRichBlocks, appendRichInline } from "./richMarkdown";

function renderInline(source: string, html = false): string {
  const doc = new DOMParser().parseFromString("<cell/>", "application/xml");
  const root = doc.documentElement;
  if (!root) throw new Error("test document has no root element");
  appendRichInline(root as unknown as HTMLElement, source, { html });
  return new XMLSerializer().serializeToString(root);
}

function renderBlocks(source: string): string {
  const doc = new DOMParser().parseFromString("<addition/>", "application/xml");
  const root = doc.documentElement;
  if (!root) throw new Error("test document has no root element");
  appendRichBlocks(root as unknown as HTMLElement, source);
  return new XMLSerializer().serializeToString(root);
}

describe("safe rich Markdown rendering", () => {
  test("renders links, emphasis, strong text, and inline code while escaping HTML", () => {
    const rendered = renderInline(
      '[model](https://example.com) *em* **strong** `code` <img src=x onerror="alert(1)">',
    );

    expect(rendered).toBe(
      '<cell><a href="https://example.com" target="_blank" rel="noopener noreferrer">model</a> <em>em</em> <strong>strong</strong> <code>code</code> &lt;img src=x onerror="alert(1)"&gt;</cell>',
    );
  });

  test("renders inline and display LaTeX while leaving code literal", () => {
    const rendered = renderBlocks(
      "Euler wrote $e^{i\\pi}+1=0$, then:\n\n$$\\int_0^1 x^2 dx$$\n\n`$not_math$`",
    );

    expect(rendered).toContain('class="katex"');
    expect(rendered).toContain('class="katex-display"');
    expect(rendered).toContain("<code>$not_math$</code>");
    expect(rendered).not.toContain("$e^{i\\pi}+1=0$");
  });

  test("keeps unsafe links and malformed or unsupported markup as visible text", () => {
    const rendered = renderInline(
      "[bad](javascript:alert(1)) broken *em ![image](data:text/html,boom)",
    );

    expect(rendered).toBe(
      "<cell>[bad](javascript:alert(1)) broken *em ![image](data:text/html,boom)</cell>",
    );
  });

  test("renders a safe multi-block addition with headings, lists, and inline formatting", () => {
    const rendered = renderBlocks(
      "### Glossary\n\n- **Agent**: a [reviewer](https://example.com)\n- `ACM`: the format\n\nClosing *note* <script>alert(1)</script>.",
    );

    expect(rendered).toBe(
      '<addition><h3>Glossary</h3><ul><li><p><strong>Agent</strong>: a <a href="https://example.com" target="_blank" rel="noopener noreferrer">reviewer</a></p></li><li><p><code>ACM</code>: the format</p></li></ul><p>Closing <em>note</em> &lt;script&gt;alert(1)&lt;/script&gt;.</p></addition>',
    );
  });

  test("preserves the starting number of an ordered list", () => {
    expect(renderBlocks("5. Fifth\n6. Sixth")).toBe(
      '<addition><ol start="5"><li><p>Fifth</p></li><li><p>Sixth</p></li></ol></addition>',
    );
  });

  test("supports zero and parenthesised starts without copying later item numbers", () => {
    expect(renderBlocks("0. Zero\n7. Later")).toBe(
      '<addition><ol start="0"><li><p>Zero</p></li><li><p>Later</p></li></ol></addition>',
    );
    expect(renderBlocks("10) Tenth\n11) Eleventh")).toBe(
      '<addition><ol start="10"><li><p>Tenth</p></li><li><p>Eleventh</p></li></ol></addition>',
    );
    expect(renderBlocks("1. First\n8. Still second")).toBe(
      "<addition><ol><li><p>First</p></li><li><p>Still second</p></li></ol></addition>",
    );
    expect(renderBlocks("- Bullet")).toBe(
      "<addition><ul><li><p>Bullet</p></li></ul></addition>",
    );
  });

  test("renders GFM tables with rich cells for print and tracked blocks", () => {
    const rendered = renderBlocks([
      "| Capability | Result |",
      "| --- | ---: |",
      "| **Rich** | [Safe](https://example.com) and `code` |",
    ].join("\n"));

    expect(rendered).toBe(
      '<addition><table class="cm-rich-markdown-table"><thead><tr><th>Capability</th><th data-align="right">Result</th></tr></thead><tbody><tr><td><strong>Rich</strong></td><td data-align="right"><a href="https://example.com" target="_blank" rel="noopener noreferrer">Safe</a> and <code>code</code></td></tr></tbody></table></addition>',
    );
  });

  test("renders escaped table pipes without exposing Markdown escape bytes", () => {
    const rendered = renderBlocks([
      "| Kind | Value |",
      "| --- | --- |",
      String.raw`| escaped pipe | a\|b |`,
      String.raw`| backslash and pipe | a\\\|b |`,
    ].join("\n"));

    expect(rendered).toBe(
      '<addition><table class="cm-rich-markdown-table"><thead><tr><th>Kind</th><th>Value</th></tr></thead><tbody><tr><td>escaped pipe</td><td>a|b</td></tr><tr><td>backslash and pipe</td><td>a\\|b</td></tr></tbody></table></addition>',
    );
  });

  test("renders blockquotes, fenced code, and horizontal rules as document blocks", () => {
    const rendered = renderBlocks([
      "> A quoted *thought*.",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "---",
    ].join("\n"));

    expect(rendered).toBe(
      '<addition><blockquote><p>A quoted <em>thought</em>.</p></blockquote><pre><code data-language="ts">const value = 1;</code></pre><hr/></addition>',
    );
  });

  test("renders a standard HTML table containing two bullet-list columns", () => {
    const rendered = renderBlocks([
      "<table>",
      "<tr>",
      "<td><ul><li>Left one</li><li><strong>Left two</strong></li></ul></td>",
      "<td><ul><li>Right one</li><li><code>Right two</code></li></ul></td>",
      "</tr>",
      "</table>",
    ].join("\n"));

    expect(rendered).toBe(
      '<addition><table class="cm-rich-html-table"><tr><td><ul><li>Left one</li><li><strong>Left two</strong></li></ul></td><td><ul><li>Right one</li><li><code>Right two</code></li></ul></td></tr></table></addition>',
    );
  });

  test("renders safe inline HTML alongside Markdown", () => {
    const rendered = renderInline(
      'Before <strong>HTML</strong>, *Markdown*, and <a href="https://example.com">a link</a>.',
      true,
    );

    expect(rendered).toBe(
      '<cell>Before <strong>HTML</strong>, <em>Markdown</em>, and <a href="https://example.com" target="_blank" rel="noopener noreferrer">a link</a>.</cell>',
    );
  });

  test("renders <u> as an underline, in a cell and in a block (#38)", () => {
    expect(renderInline("The <u>key</u> point", true)).toBe("<cell>The <u>key</u> point</cell>");
    expect(renderBlocks("A <u>key</u> point.")).toBe("<addition><p>A <u>key</u> point.</p></addition>");
  });

  test("renders <u> without the HTML option, as a live table cell does (#38)", () => {
    expect(renderInline("The <u>*key*</u> point")).toBe("<cell>The <u><em>key</em></u> point</cell>");
  });

  test("renders <u> nested in bold and italic, keeping both (#38)", () => {
    expect(renderBlocks("A **<u>key</u>** and *<u>b</u> c*.")).toBe(
      "<addition><p>A <strong><u>key</u></strong> and <em><u>b</u> c</em>.</p></addition>",
    );
  });

  test("bold around one <u> survives a sibling <u> in the same paragraph (#38)", () => {
    expect(renderBlocks("A **<u>key</u>** and <u>other</u>.")).toBe(
      "<addition><p>A <strong><u>key</u></strong> and <u>other</u>.</p></addition>",
    );
  });

  test("an uppercase <U> stays literal text, as in the editor", () => {
    expect(renderInline("A <U>loud</U> word")).toBe("<cell>A &lt;U&gt;loud&lt;/U&gt; word</cell>");
  });

  test("a stray </u> and an unclosed <u> stay literal text", () => {
    expect(renderInline("A </u>stray and <u>open")).toBe("<cell>A &lt;/u&gt;stray and &lt;u&gt;open</cell>");
  });

  test("drops executable HTML and unsafe attributes without enabling custom column tags", () => {
    const rendered = renderBlocks([
      '<div style="columns: 2" onclick="alert(1)">',
      '<columns><ul><li>Visible</li></ul></columns>',
      '<a href="javascript:alert(1)">unsafe link</a>',
      '<img src="data:text/html,boom" onerror="alert(1)" alt="unsafe">',
      '<script>alert(1)</script>',
      "</div>",
    ].join(""));

    expect(rendered).toBe(
      '<addition><div><ul><li>Visible</li></ul><span>unsafe link</span><span>unsafe</span></div></addition>',
    );
  });

  test("keeps malformed HTML inspectable as source text", () => {
    expect(renderBlocks("<table><tr><td>unfinished")).toBe(
      '<addition><pre class="cm-rich-unsupported">&lt;table&gt;&lt;tr&gt;&lt;td&gt;unfinished</pre></addition>',
    );
  });

  test("sanitizes recoverable HTML fragments instead of rejecting valid HTML syntax", () => {
    expect(renderBlocks('<div data-kind=note onclick="alert(1)">ok</div>')).toBe(
      "<addition><div>ok</div></addition>",
    );
    expect(renderBlocks("<p>ok</p>trailing text")).toBe(
      "<addition><p>ok</p>trailing text</addition>",
    );
  });
});
