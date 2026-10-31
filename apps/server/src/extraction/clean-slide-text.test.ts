import { describe, expect, it } from "vitest";
import { cleanSlideText, hasContent, pageMarker, type SlidePage } from "./clean-slide-text.js";

const NBSP = String.fromCharCode(0xa0);

/** A page of lines with positions (share of the page height from the top). */
const page = (...lines: [text: string, position: number][]): SlidePage =>
  lines.map(([text, position]) => ({ text, position }));

describe("cleanSlideText", () => {
  it("puts a page marker before every page and separates pages with one blank line", () => {
    const { text, pageCount } = cleanSlideText(["Prvi slajd", "Drugi slajd"]);
    expect(text).toBe("--- strana 1 ---\nPrvi slajd\n\n--- strana 2 ---\nDrugi slajd");
    expect(pageCount).toBe(2);
    expect(pageMarker(7)).toBe("--- strana 7 ---");
  });

  it("keeps the marker of a page without any text", () => {
    const { text } = cleanSlideText(["Tekst", "  \n 7 \n", "Opet tekst"]);
    expect(text).toBe(
      "--- strana 1 ---\nTekst\n\n--- strana 2 ---\n\n--- strana 3 ---\nOpet tekst",
    );
  });

  it("trims lines and drops empty lines inside a page", () => {
    const { text } = cleanSlideText(["  prva  \n\n\n   \n\tdruga\t\r\n\r\ntreća"]);
    expect(text).toBe("--- strana 1 ---\nprva\ndruga\ntreća");
  });

  it("keeps the two-space indentation of nested list items and ## title prefixes", () => {
    const { text } = cleanSlideText(["## Naslov\n- a\n  - b  \n    -   c\n   dugačak red"]);
    expect(text).toBe("--- strana 1 ---\n## Naslov\n- a\n  - b\n    - c\ndugačak red");
  });

  it("never treats text without a known position as a repeated footer", () => {
    const { text } = cleanSlideText([
      "Slajd A\nPodnožje",
      "Slajd B\nPodnožje",
      "Slajd C\nPodnožje",
    ]);
    expect(text.match(/Podnožje/g)).toHaveLength(3);
  });

  it("collapses repeated and non-breaking spaces", () => {
    const { text } = cleanSlideText([`a   b${NBSP}${NBSP} c`]);
    expect(text).toBe("--- strana 1 ---\na b c");
  });

  it("drops lines that are only a page number", () => {
    const { text } = cleanSlideText([
      "Naslov\n5",
      "Naslov 2\n12\n123",
      "Rečenica sa brojem 5\n1234",
    ]);
    expect(text).toContain("Naslov\n");
    expect(text).not.toMatch(/^\d{1,3}$/m);
    expect(text).toContain("Rečenica sa brojem 5");
    expect(text).toContain("1234");
  });

  it("drops date-only lines in several formats but keeps dates inside sentences", () => {
    const { text } = cleanSlideText([
      "21.10.2025.\n2025-10-21\n10/9/26\n21. 10. 2025\nIspit je 21.10.2025. u sali 5",
    ]);
    expect(text).toBe("--- strana 1 ---\nIspit je 21.10.2025. u sali 5");
  });

  it("merges a bullet glyph on its own line into the next line as '- '", () => {
    const { text } = cleanSlideText(["●\nPrva stavka\n○\nPodstavka\n–\nTreća\n•", "x"]);
    expect(text).toContain("--- strana 1 ---\n- Prva stavka\n- Podstavka\n- Treća");
    // a trailing bullet with nothing after it disappears
    expect(text).not.toContain("•");
  });

  it.each(["•", "◦", "▪", "▫", "●", "○", "■", "□", "–", "-", "", "", "➢", "✓", "*"])(
    "treats %j alone on a line as a bullet",
    (glyph) => {
      const { text } = cleanSlideText([`${glyph}\nstavka`]);
      expect(text).toBe("--- strana 1 ---\n- stavka");
    },
  );

  it("normalizes a leading bullet glyph followed by text to '- '", () => {
    const { text } = cleanSlideText(["● Prva\n○ Druga\n- Treća\n* Četvrta"]);
    expect(text).toBe("--- strana 1 ---\n- Prva\n- Druga\n- Treća\n* Četvrta");
  });

  it("does not double the dash when a bullet line is followed by an already bulleted line", () => {
    const { text } = cleanSlideText(["•\n- već stavka"]);
    expect(text).toBe("--- strana 1 ---\n- već stavka");
  });

  it("drops a footer repeated on more than half of the pages from the bottom band, comparing normalized text", () => {
    const pages = [
      page(["Slajd A", 0.3], ["ASVSP – Kontejneri 12", 0.95]),
      page(["Slajd B", 0.3], ["asvsp – kontejneri 13", 0.95]),
      page(["Slajd C", 0.3], ["ASVSP – Kontejneri 14", 0.9]),
      page(["Slajd D", 0.3]),
    ];
    const { text } = cleanSlideText(pages);
    expect(text).not.toMatch(/kontejneri/i);
    for (const title of ["Slajd A", "Slajd B", "Slajd C", "Slajd D"]) expect(text).toContain(title);
  });

  it("drops a repeated header from the top band", () => {
    const { text } = cleanSlideText([
      page(["Kurs", 0.05], ["a", 0.4]),
      page(["Kurs", 0.05], ["b", 0.4]),
    ]);
    expect(text).toBe("--- strana 1 ---\na\n\n--- strana 2 ---\nb");
  });

  it("keeps a repeated line that sits in the body region", () => {
    const { text } = cleanSlideText([
      page(["Isti red", 0.5], ["a", 0.3]),
      page(["Isti red", 0.5], ["b", 0.3]),
      page(["Isti red", 0.5], ["c", 0.3]),
    ]);
    expect(text.match(/Isti red/g)).toHaveLength(3);
  });

  it("keeps a repeated line unless it is in the margin band on every page it occurs on", () => {
    const { text } = cleanSlideText([page(["Red", 0.95]), page(["Red", 0.95]), page(["Red", 0.5])]);
    expect(text.match(/Red/g)).toHaveLength(3);
  });

  it("keeps repeated titles and list items even in the margin band", () => {
    const { text } = cleanSlideText([
      page(["## Ponovljeni naslov", 0.05], ["- stavka", 0.95]),
      page(["## Ponovljeni naslov", 0.05], ["- stavka", 0.95]),
    ]);
    expect(text.match(/## Ponovljeni naslov/g)).toHaveLength(2);
    expect(text.match(/- stavka/g)).toHaveLength(2);
  });

  it("keeps a plain line when a title or bullet with the same text exists elsewhere", () => {
    const { text } = cleanSlideText([
      page(["Pojam", 0.95]),
      page(["Pojam", 0.95]),
      page(["## Pojam", 0.1 + 0.05]),
    ]);
    expect(text.match(/Pojam/g)).toHaveLength(3);
  });

  it("keeps a line that appears on exactly half of the pages", () => {
    const { text } = cleanSlideText([
      page(["Zajednički", 0.95]),
      page(["Zajednički", 0.95]),
      page(["c", 0.3]),
      page(["d", 0.3]),
    ]);
    expect(text.match(/Zajednički/g)).toHaveLength(2);
  });

  it("does not drop content from a single-page document", () => {
    const { text } = cleanSlideText(["Jedini slajd\nsadržaj"]);
    expect(text).toBe("--- strana 1 ---\nJedini slajd\nsadržaj");
  });

  it("keeps Serbian diacritics intact", () => {
    const { text } = cleanSlideText(["Čokolada, ćuprija, šuma, žaba i đak\nĆEVAPI ŠĐŽČ"]);
    expect(text).toContain("Čokolada, ćuprija, šuma, žaba i đak");
    expect(text).toContain("ĆEVAPI ŠĐŽČ");
  });

  it("tells whether the cleaned text holds anything besides page markers", () => {
    expect(hasContent(cleanSlideText(["", "12"]).text)).toBe(false);
    expect(hasContent(cleanSlideText(["", "tekst"]).text)).toBe(true);
    expect(hasContent("")).toBe(false);
  });

  it("handles an empty document", () => {
    expect(cleanSlideText([])).toEqual({ text: "", pageCount: 0 });
  });
});
