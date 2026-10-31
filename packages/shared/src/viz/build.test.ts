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
<a href="https://example.com/izvor">Izvor</a>
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

  it("rejects external src/href except on plain links", () => {
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
    // a plain <a href> is fine, and so are relative and data: URLs and the SVG namespace
    const fine = VALID_HTML.replace(
      "<button",
      '<a href="http://example.com">x</a><img src="data:image/png;base64,AAAA"><svg xmlns="http://www.w3.org/2000/svg"></svg><button',
    );
    expect(errorsOf(fine)).toEqual([]);
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
