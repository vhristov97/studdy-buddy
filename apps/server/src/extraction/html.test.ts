import { describe, expect, it } from "vitest";
import { extractHtml } from "./html.js";

const convert = (html: string) => extractHtml(Buffer.from(html, "utf8"));

describe("extractHtml", () => {
  it("converts headings, lists, emphasis and links to Markdown", () => {
    const { text, pageCount } = convert(
      `<html><body><h1>Naslov</h1><p>Običan <strong>podebljan</strong> tekst i <a href="https://example.com">veza</a>.</p><ul><li>jedan</li><li>dva</li></ul></body></html>`,
    );
    expect(pageCount).toBeNull();
    expect(text).toBe(
      "# Naslov\n\nObičan **podebljan** tekst i [veza](https://example.com).\n\n- jedan\n- dva",
    );
  });

  it("numbers ordered lists and indents nested lists", () => {
    const { text } = convert(
      "<body><ol><li>prvo<ul><li>pod</li></ul></li><li>drugo</li></ol></body>",
    );
    expect(text).toBe("1. prvo\n  - pod\n2. drugo");
  });

  it("removes script, style, noscript, iframe, svg, nav and footer content", () => {
    const { text } = convert(`<body>
      <nav>Meni</nav><script>alert('x')</script><style>p{color:red}</style>
      <noscript>Uključite JS</noscript><iframe src="https://example.com"></iframe>
      <svg><text>Crtež</text></svg>
      <p>Sadržaj</p><footer>Podnožje</footer></body>`);
    expect(text).toBe("Sadržaj");
  });

  it("prefers <main> over the rest of the page", () => {
    const { text } = convert(
      "<body><div>Sporedno</div><main><h2>Glavno</h2><p>Telo</p></main></body>",
    );
    expect(text).toBe("## Glavno\n\nTelo");
  });

  it("falls back to <article> when there is no <main>", () => {
    const { text } = convert("<body><p>Van</p><article><p>Unutra</p></article></body>");
    expect(text).toBe("Unutra");
  });

  it("collapses three or more blank lines and keeps diacritics", () => {
    const { text } = convert("<body><p>Čas</p><br><br><br><br><p>žđšćč</p></body>");
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).toContain("žđšćč");
  });
});
