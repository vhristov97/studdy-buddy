import { describe, expect, it } from "vitest";
import { cleanSlideText, pageMarker } from "./clean-slide-text.js";

const NBSP = String.fromCharCode(0xa0);

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

  it("recognizes a repeated footer whatever its title or list prefix", () => {
    const { text } = cleanSlideText(["## Podnožje\nprvo", "- podnožje\ndrugo"]);
    expect(text).toBe("--- strana 1 ---\nprvo\n\n--- strana 2 ---\ndrugo");
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

  it("drops lines repeated on more than half of the pages, comparing normalized text", () => {
    const pages = [
      "Slajd A\nASVSP – Kontejneri 12",
      "Slajd B\nasvsp – kontejneri 13",
      "Slajd C\nASVSP – Kontejneri 14",
      "Slajd D",
    ];
    const { text } = cleanSlideText(pages);
    expect(text).not.toMatch(/kontejneri/i);
    for (const title of ["Slajd A", "Slajd B", "Slajd C", "Slajd D"]) expect(text).toContain(title);
  });

  it("keeps a line that appears on exactly half of the pages", () => {
    const { text } = cleanSlideText(["Zajednički\na", "Zajednički\nb", "c", "d"]);
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

  it("handles an empty document", () => {
    expect(cleanSlideText([])).toEqual({ text: "", pageCount: 0 });
  });
});
