import { describe, expect, it } from "vitest";
import { VizPlan, countTitleWords, formatVizReport, validateVizHtml, vizHtmlTitle } from "../index";

/** A minimal page that satisfies the whole static contract. */
const VALID_HTML = `<!doctype html>
<html lang="sr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sharding pod lupom</title>
<style>
:root { --bg: #fff; --fg: #111; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; } }
@media (prefers-reduced-motion: reduce) { * { transition: none; } }
body { background: var(--bg); color: var(--fg); transition: color 0.2s; }
</style>
</head>
<body>
<button id="add">Dodaj čvor</button>
<p id="log" aria-live="polite"></p>
<a href="#izvor">Izvor</a>
<script>
let saved = null;
try { saved = localStorage.getItem("x"); } catch (e) { saved = null; }
document.getElementById("add").addEventListener("click", () => {
  document.getElementById("log").textContent = "Čvor dodat";
});
</script>
</body>
</html>`;

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);
const errorsOf = (html: string): string[] => codes(validateVizHtml(html).errors);
const warningsOf = (html: string): string[] => codes(validateVizHtml(html).warnings);
const without = (html: string, part: string): string => {
  expect(html).toContain(part);
  return html.replace(part, "");
};

describe("validateVizHtml", () => {
  it("passes a page that meets the contract, with no warnings", () => {
    expect(validateVizHtml(VALID_HTML)).toEqual({ errors: [], warnings: [] });
  });

  it("accepts a case-insensitive doctype and leading whitespace", () => {
    expect(errorsOf("\n  " + VALID_HTML.replace("<!doctype html>", "<!DOCTYPE HTML>"))).toEqual([]);
  });

  it("requires the doctype first", () => {
    expect(errorsOf(without(VALID_HTML, "<!doctype html>\n"))).toContain("missing_doctype");
  });

  it("requires the viewport meta", () => {
    expect(
      errorsOf(
        without(VALID_HTML, '<meta name="viewport" content="width=device-width, initial-scale=1">'),
      ),
    ).toContain("missing_viewport");
  });

  it("requires a title of 2-4 words", () => {
    expect(errorsOf(without(VALID_HTML, "<title>Sharding pod lupom</title>"))).toContain(
      "missing_title",
    );
    expect(errorsOf(VALID_HTML.replace("Sharding pod lupom", "Sharding"))).toContain(
      "title_word_count",
    );
    expect(
      errorsOf(VALID_HTML.replace("Sharding pod lupom", "Jedan dva tri četiri pet")),
    ).toContain("title_word_count");
    expect(errorsOf(VALID_HTML.replace("Sharding pod lupom", "Jedan dva tri četiri"))).toEqual([]);
  });

  it("requires prefers-color-scheme and warns when there is no dark rule", () => {
    const noQuery = VALID_HTML.replace(
      "@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; } }",
      "",
    );
    expect(errorsOf(noQuery)).toContain("missing_color_scheme");
    const lightOnly = VALID_HTML.replace(
      "prefers-color-scheme: dark",
      "prefers-color-scheme: light",
    );
    expect(errorsOf(lightOnly)).toEqual([]);
    expect(warningsOf(lightOnly)).toContain("no_dark_theme");
  });

  it("rejects external scripts, stylesheets, imports and CSS urls", () => {
    expect(
      errorsOf(VALID_HTML.replace("<script>", '<script src="app.js"></script><script>')),
    ).toContain("external_script");
    expect(
      errorsOf(
        VALID_HTML.replace("<style>", '<link rel="stylesheet" href="https://x.test/a.css"><style>'),
      ),
    ).toEqual(expect.arrayContaining(["external_link", "external_stylesheet"]));
    expect(
      errorsOf(
        VALID_HTML.replace("<style>", '<link href="//cdn.test/a.css" rel="preload"><style>'),
      ),
    ).toContain("external_link");
    expect(
      errorsOf(VALID_HTML.replace("<style>", '<style>@import url("https://f.test/a.css");')),
    ).toContain("css_import");
    expect(
      errorsOf(VALID_HTML.replace("body {", "body { background: url(https://x.test/a.png);")),
    ).toContain("css_external_url");
  });

  it("rejects network APIs", () => {
    for (const code of [
      'fetch("/api/x");',
      "new XMLHttpRequest();",
      'new WebSocket("ws://x");',
      "new EventSource('/x');",
      'navigator.sendBeacon("/x");',
    ]) {
      expect(errorsOf(VALID_HTML.replace("let saved", `${code}\nlet saved`)), code).toContain(
        "network_api",
      );
    }
  });

  it("rejects external src/href on resource tags", () => {
    for (const tag of [
      '<img src="https://x.test/a.png">',
      '<iframe src="//x.test/"></iframe>',
      "<img src=http://x.test/a.png>",
      '<form action="https://x.test/"></form>',
    ]) {
      expect(errorsOf(VALID_HTML.replace("<button", `${tag}<button`)), tag).toContain(
        "external_resource",
      );
    }
    // relative and data: URLs, fragment links and the SVG namespace are fine
    const fine = VALID_HTML.replace(
      "<button",
      '<a href="#dole">x</a><img src="data:image/png;base64,AAAA"><svg xmlns="http://www.w3.org/2000/svg"></svg><button',
    );
    expect(errorsOf(fine)).toEqual([]);
  });

  it("rejects anchors and areas that link to an external URL", () => {
    for (const tag of [
      '<a href="https://example.com/izvor">Izvor</a>',
      '<a href="http://example.com">x</a>',
      "<a href=//example.com/x>x</a>",
      '<a class="s" target="_blank" href=" https://example.com">x</a>',
      '<area shape="rect" coords="0,0,1,1" href="https://example.com">',
      '<a href="mailto:a@b.test">x</a>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href=" JavaScript:void(0)">x</a>',
      '<a href="data:text/html,hi">x</a>',
      '<a href="tel:+381">x</a>',
      '<a href="file:///etc/passwd">x</a>',
      '<a href="foo.html">x</a>',
      '<a href="/x">x</a>',
      '<a href="?q=1">x</a>',
      "<a href=foo.html>x</a>",
    ]) {
      expect(errorsOf(VALID_HTML.replace("<button", `${tag}<button`)), tag).toContain(
        "external_link_anchor",
      );
    }
  });

  it("allows in-page and empty anchors", () => {
    for (const tag of [
      '<a href="#id">x</a>',
      '<a href="">x</a>',
      "<a>x</a>",
      "<a href=#id>x</a>",
    ]) {
      expect(errorsOf(VALID_HTML.replace("<button", `${tag}<button`)), tag).toEqual([]);
    }
  });

  it("rejects form actions and base href", () => {
    for (const tag of [
      '<form action="submit.html"></form>',
      '<form action="#x"></form>',
      '<base href="https://x.test/">',
      '<base href="/">',
    ]) {
      expect(errorsOf(VALID_HTML.replace("<button", `${tag}<button`)), tag).toContain(
        "navigation_api",
      );
    }
    expect(errorsOf(VALID_HTML.replace("<button", '<form action=""></form><button'))).toEqual([]);
  });

  it("does not flag simulation properties named location or open", () => {
    for (const code of [
      "node.location = nextPosition",
      "this.location = start",
      "obj.location.href = 'x'",
      "const location = { x: 1 }",
      "let location = 3",
      "if (a.location == b) {}",
      "x = window.location.hash",
      "class Door { open(d) { return d; } }",
      "function open(door) { return door; }",
      "door.open(1)",
      "function open(){}; open()",
    ]) {
      const html = VALID_HTML.replace("let saved = null;", `${code}; let saved = null;`);
      expect(errorsOf(html), code).toEqual([]);
    }
  });

  it("rejects navigation APIs and meta refresh", () => {
    for (const code of [
      'location.href = "https://x.test"',
      'window.location.href="https://x.test"',
      'location = "https://x.test"',
      'document.location.assign("https://x.test")',
      'top.location.replace("https://x.test")',
      'window.location = "https://x.test"',
      'self.location = "x"',
      'document.location.replace("x")',
      'window.top.location.href = "x"',
      'location.assign("x")',
    ]) {
      const html = VALID_HTML.replace("let saved = null;", `${code}; let saved = null;`);
      expect(errorsOf(html), code).toContain("navigation_api");
    }
    const refresh = VALID_HTML.replace(
      "<style>",
      '<meta http-equiv="refresh" content="0;url=https://x.test"><style>',
    );
    expect(errorsOf(refresh)).toContain("navigation_api");
    // reading location or comparing it is fine
    const ok = VALID_HTML.replace(
      "let saved = null;",
      'const here = window.location.href; if (location.hash == "#a") {} let saved = null;',
    );
    expect(errorsOf(ok)).toEqual([]);
  });

  it("only warns about window.open and friends", () => {
    for (const code of [
      'window.open("https://x.test")',
      'self.open("x")',
      'top.open("x")',
      'parent.open("x")',
      'globalThis.open("x")',
    ]) {
      const html = VALID_HTML.replace("let saved = null;", `${code}; let saved = null;`);
      expect(errorsOf(html), code).toEqual([]);
      expect(warningsOf(html), code).toContain("navigation_api");
    }
    const bare = VALID_HTML.replace(
      "let saved = null;",
      "function open(){}; open(); let saved = null;",
    );
    expect(validateVizHtml(bare)).toEqual({ errors: [], warnings: [] });
  });

  it("ignores forbidden tags inside HTML comments", () => {
    expect(
      errorsOf(VALID_HTML.replace("<body>", '<body><!-- <script src="x.js"></script> -->')),
    ).toEqual([]);
  });

  it("warns about storage access outside a try block", () => {
    const bad = VALID_HTML.replace(
      'try { saved = localStorage.getItem("x"); } catch (e) { saved = null; }',
      'saved = localStorage.getItem("x");',
    );
    expect(warningsOf(bad)).toContain("storage_not_guarded");
    expect(errorsOf(bad)).toEqual([]);
    expect(warningsOf(VALID_HTML)).not.toContain("storage_not_guarded");
    // sessionStorage counts too, and one guarded access does not excuse another
    const second = VALID_HTML.replace(
      "let saved",
      `${"//".repeat(1)} pad\n${"x".repeat(300)}\nsessionStorage.setItem("a","b");\nlet saved`,
    );
    expect(warningsOf(second)).toContain("storage_not_guarded");
  });

  it("warns when there is no live region", () => {
    const noLive = VALID_HTML.replace(' aria-live="polite"', "");
    expect(warningsOf(noLive)).toContain("no_live_region");
    expect(warningsOf(noLive.replace('<p id="log"', '<p role="log" id="log"'))).not.toContain(
      "no_live_region",
    );
  });

  it("warns about animation without reduced-motion handling", () => {
    const noMotion = VALID_HTML.replace(
      "@media (prefers-reduced-motion: reduce) { * { transition: none; } }",
      "",
    );
    expect(warningsOf(noMotion)).toContain("no_reduced_motion");
  });

  it("rejects a page over 400 KB, counting bytes", () => {
    const big = VALID_HTML.replace("<body>", `<body><!--${"x".repeat(400 * 1024)}-->`);
    expect(errorsOf(big)).toContain("too_large");
    const bytes = VALID_HTML.replace("<body>", `<body><!--${"č".repeat(210 * 1024)}-->`);
    expect(errorsOf(bytes)).toContain("too_large");
    expect(bytes.length).toBeLessThan(400 * 1024);
  });

  it("reports every problem, not just the first", () => {
    expect(errorsOf("<html></html>")).toEqual(
      expect.arrayContaining([
        "missing_doctype",
        "missing_viewport",
        "missing_title",
        "missing_color_scheme",
      ]),
    );
  });
});

describe("validateVizHtml tag tokenizer", () => {
  const withTag = (tag: string): string => VALID_HTML.replace("<button", `${tag}<button`);

  it("does not read a quoted value as an attribute", () => {
    for (const tag of [
      `<a title="href='#safe'" href="https://evil.test">x</a>`,
      `<a title='href="#safe"' href=https://evil.test>x</a>`,
      `<a data-x="a>b" href="https://evil.test">x</a>`,
      `<a title="x = y" href = 'javascript:alert(1)'>x</a>`,
    ]) {
      expect(errorsOf(withTag(tag)), tag).toContain("external_link_anchor");
    }
    // the same text as a title is harmless when the real href is a fragment
    expect(errorsOf(withTag(`<a title="href='https://x.test'" href="#a">x</a>`))).toEqual([]);
    expect(errorsOf(withTag(`<a title="a > b" href="#a">x</a>`))).toEqual([]);
  });

  it("reads double-quoted, single-quoted and unquoted values", () => {
    for (const tag of [
      `<a href="//x.test">x</a>`,
      `<a href='//x.test'>x</a>`,
      `<a href=//x.test>x</a>`,
    ]) {
      expect(errorsOf(withTag(tag)), tag).toContain("external_link_anchor");
    }
    for (const tag of [
      `<a href="#a">x</a>`,
      `<a href='#a'>x</a>`,
      `<a href=#a>x</a>`,
      `<a href=#a/>x</a>`,
    ]) {
      expect(errorsOf(withTag(tag)), tag).toEqual([]);
    }
  });

  it("lets the first duplicate attribute win, like a browser", () => {
    expect(errorsOf(withTag(`<a href="#a" href="https://x.test">x</a>`))).toEqual([]);
    expect(errorsOf(withTag(`<a href="https://x.test" href="#a">x</a>`))).toContain(
      "external_link_anchor",
    );
  });

  it("decodes character references in values", () => {
    for (const tag of [
      `<a href="&#x6a;avascript:alert(1)">x</a>`,
      `<a href="&#106avascript:alert(1)">x</a>`,
      `<a href="&#104;ttps://x.test">x</a>`,
      `<a href="java&Tab;script:1">x</a>`,
      `<a href="https&colon;//x.test">x</a>`,
    ]) {
      expect(errorsOf(withTag(tag)), tag).toContain("external_link_anchor");
    }
    expect(errorsOf(withTag(`<img src="&#x68;ttps://x.test/a.png">`))).toContain(
      "external_resource",
    );
    expect(errorsOf(withTag(`<img srcset="a.png 1x, &#104;ttps://x.test/b.png 2x">`))).toContain(
      "external_resource",
    );
    expect(errorsOf(withTag(`<a href="&#35;a">x</a>`))).toEqual([]);
  });

  it("treats tag and attribute names case-insensitively", () => {
    expect(errorsOf(withTag(`<A HREF="https://x.test">x</A>`))).toContain("external_link_anchor");
    expect(errorsOf(withTag(`<IMG SRC="https://x.test/a.png">`))).toContain("external_resource");
    expect(errorsOf(withTag(`<SCRIPT SRC="a.js"></SCRIPT>`))).toContain("external_script");
    expect(errorsOf(withTag(`<BASE HREF="/">`))).toContain("navigation_api");
    expect(errorsOf(withTag(`<META HTTP-EQUIV="Refresh" CONTENT="0">`))).toContain(
      "navigation_api",
    );
    expect(errorsOf(withTag(`<LINK REL="Stylesheet" HREF="a.css">`))).toContain(
      "external_stylesheet",
    );
  });

  it("ignores tag-like text inside script and style contents and comments", () => {
    const inScript = VALID_HTML.replace(
      "let saved = null;",
      `const html = '<a href="https://x.test">x</a><img src="https://x.test/a.png">'; if (1<2) {} let saved = null;`,
    );
    expect(errorsOf(inScript)).toEqual([]);
    const inStyle = VALID_HTML.replace("body {", `/* <a href="https://x.test"> */ body {`);
    expect(errorsOf(inStyle)).toEqual([]);
    expect(errorsOf(withTag(`<!-- <a href="https://x.test">x</a> -->`))).toEqual([]);
    // a real tag after the script is still seen
    expect(
      errorsOf(VALID_HTML.replace("</body>", `<a href="https://x.test">x</a></body>`)),
    ).toContain("external_link_anchor");
  });
});

describe("helpers", () => {
  it("reads and counts the title", () => {
    expect(vizHtmlTitle(VALID_HTML)).toBe("Sharding pod lupom");
    expect(vizHtmlTitle("<p>x</p>")).toBeNull();
    expect(vizHtmlTitle("<title>\n  Dva   reda </title>")).toBe("Dva reda");
    expect(countTitleWords("  Dve   reči ")).toBe(2);
  });

  it("formats a report", () => {
    const text = formatVizReport(validateVizHtml("<html></html>"));
    expect(text).toContain("Errors (");
    expect(text).toContain("[missing_doctype]");
    expect(formatVizReport({ errors: [], warnings: [] })).toBe(
      "Errors (0):\n- none\nWarnings (0):\n- none",
    );
  });
});

describe("VizPlan", () => {
  it("is a closed object schema", () => {
    expect(VizPlan.safeParse({}).success).toBe(false);
  });
});
