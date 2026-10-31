import { describe, expect, it } from "vitest";
import { structureSlideLines, type SlideLine } from "./slide-structure.js";

const bullet = (text: string, x: number, height = 16, textX = x + 20): SlideLine => ({
  text,
  x,
  textX,
  height,
  isBullet: true,
});
const plain = (text: string, x: number, height = 16): SlideLine => ({
  text,
  x,
  textX: x,
  height,
  isBullet: false,
});

describe("structureSlideLines", () => {
  it("nests bullets by the distinct x positions of their glyphs, leftmost first", () => {
    expect(
      structureSlideLines([
        bullet("prvi", 80),
        bullet("drugi", 105),
        bullet("treći", 130),
        bullet("opet drugi", 105),
        bullet("opet prvi", 80),
      ]),
    ).toEqual(["- prvi", "  - drugi", "    - treći", "  - opet drugi", "- opet prvi"]);
  });

  it("treats x values within the tolerance as one level", () => {
    expect(structureSlideLines([bullet("a", 80), bullet("b", 82.5), bullet("c", 104)])).toEqual([
      "- a",
      "- b",
      "  - c",
    ]);
  });

  it("makes the leftmost bullet on the page level 0 even when it is indented", () => {
    expect(structureSlideLines([bullet("a", 200), bullet("b", 230)])).toEqual(["- a", "  - b"]);
  });

  it("joins a bullet glyph that stands alone on its line to the following line", () => {
    const lone: SlideLine = { text: "", x: 80, textX: 80, height: 16, isBullet: true };
    expect(structureSlideLines([lone, plain("tekst", 100), bullet("sledeći", 80)])).toEqual([
      "- tekst",
      "- sledeći",
    ]);
  });

  it("drops a lone bullet glyph with nothing after it", () => {
    const lone: SlideLine = { text: "", x: 80, textX: 80, height: 16, isBullet: true };
    expect(structureSlideLines([bullet("a", 80), lone])).toEqual(["- a"]);
  });

  it("appends a wrapped line that starts where the bullet text starts", () => {
    expect(
      structureSlideLines([
        bullet("dugačka stavka koja", 80),
        plain("se prelama u novi red", 100),
        plain("i još jednom", 100),
        bullet("sledeća", 80),
      ]),
    ).toEqual(["- dugačka stavka koja se prelama u novi red i još jednom", "- sledeća"]);
  });

  it("does not merge a line that starts at the glyph position or at another x", () => {
    expect(
      structureSlideLines([
        bullet("stavka", 80),
        plain("izvor: negde", 80),
        plain("sporedno", 300),
      ]),
    ).toEqual(["- stavka", "izvor: negde", "sporedno"]);
  });

  it("does not merge a continuation after a non-bullet line interrupted the bullet", () => {
    expect(
      structureSlideLines([bullet("stavka", 80), plain("izvor", 40), plain("tekst", 100)]),
    ).toEqual(["- stavka", "izvor", "tekst"]);
  });

  it("does not merge a line with a very different font size", () => {
    expect(structureSlideLines([bullet("a", 80), bullet("b", 80), plain("sitno", 100, 9)])).toEqual(
      ["- a", "- b", "sitno"],
    );
  });

  it("marks lines at least 1.25x the median height as titles, several per page", () => {
    expect(
      structureSlideLines([
        plain("Naslov", 40, 28),
        plain("Podnaslov", 40, 22),
        bullet("a", 80),
        bullet("b", 80),
        bullet("c", 80),
        plain("običan red", 40, 16),
        plain("Drugi naslov", 40, 24),
        bullet("d", 80),
      ]),
    ).toEqual([
      "## Naslov",
      "## Podnaslov",
      "- a",
      "- b",
      "- c",
      "običan red",
      "## Drugi naslov",
      "- d",
    ]);
  });

  it("never turns a big bullet into a title", () => {
    expect(structureSlideLines([bullet("veliki", 80, 30), bullet("mali", 80, 12)])).toEqual([
      "- veliki",
      "- mali",
    ]);
  });

  it("does not find titles when all lines have the same size", () => {
    expect(structureSlideLines([plain("a", 40), plain("b", 40), plain("c", 40)])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("handles a page without bullets", () => {
    expect(
      structureSlideLines([plain("Naslov", 40, 30), plain("prvi red", 40), plain("drugi red", 40)]),
    ).toEqual(["## Naslov", "prvi red", "drugi red"]);
  });

  it("drops empty lines, page numbers and dates before measuring", () => {
    expect(
      structureSlideLines([
        plain("5", 500, 40),
        plain("10/9/26", 500, 40),
        plain("  ", 40),
        plain("red", 40),
        plain("još", 40),
      ]),
    ).toEqual(["red", "još"]);
  });

  it("returns nothing for an empty page", () => {
    expect(structureSlideLines([])).toEqual([]);
  });
});
