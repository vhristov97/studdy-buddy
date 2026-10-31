import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdf, itemsToLines, type PdfTextItem } from "./pdf.js";

async function makePdf(pages: { lines: string[]; pageNumber: string }[], footer?: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const { lines, pageNumber } of pages) {
    const page = doc.addPage([600, 800]);
    lines.forEach((line, index) => {
      page.drawText(line, { x: 60, y: 700 - index * 30, size: 16, font });
    });
    page.drawText(pageNumber, { x: 560, y: 30, size: 10, font });
    if (footer) page.drawText(footer, { x: 60, y: 30, size: 10, font });
  }
  return Buffer.from(await doc.save());
}

describe("extractPdf", () => {
  it("extracts lines per page, drops page numbers and repeated footers, and marks pages", async () => {
    const buffer = await makePdf(
      [
        { lines: ["Uvod u kontejnere", "Prva stavka slajda"], pageNumber: "1" },
        { lines: ["Docker slike", "Druga stavka slajda"], pageNumber: "2" },
      ],
      "Arhitektura sistema velikih skupova podataka",
    );
    const { text, pageCount } = await extractPdf(buffer);
    expect(pageCount).toBe(2);
    expect(text).toBe(
      [
        "--- strana 1 ---",
        "Uvod u kontejnere",
        "Prva stavka slajda",
        "",
        "--- strana 2 ---",
        "Docker slike",
        "Druga stavka slajda",
      ].join("\n"),
    );
  });

  it("marks titles with ## and indents nested bullets by two spaces per level", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);
    const draw = (text: string, x: number, y: number, size = 16) =>
      page.drawText(text, { x, y, size, font });
    draw("Naslov slajda", 60, 740, 30);
    draw("\u2022", 60, 680);
    draw("Prva stavka", 80, 680);
    draw("\u2022", 100, 650);
    draw("podstavka", 120, 650);
    draw("koja se nastavlja", 120, 630);
    draw("\u2022", 60, 600);
    draw("Druga stavka", 80, 600);

    const { text } = await extractPdf(Buffer.from(await doc.save()));
    expect(text).toBe(
      [
        "--- strana 1 ---",
        "## Naslov slajda",
        "- Prva stavka",
        "  - podstavka koja se nastavlja",
        "- Druga stavka",
      ].join("\n"),
    );
  });

  it("keeps a repeated line in the body and a repeated title, but drops a bottom-band footer", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const body of ["prvi", "drugi", "treci"]) {
      const page = doc.addPage([600, 800]);
      page.drawText("Isti naslov", { x: 60, y: 740, size: 30, font });
      page.drawText("Isti red u telu", { x: 60, y: 500, size: 16, font });
      page.drawText(body, { x: 60, y: 450, size: 16, font });
      page.drawText("Podnozje kursa", { x: 60, y: 30, size: 10, font });
    }
    const { text } = await extractPdf(Buffer.from(await doc.save()));
    expect(text.match(/## Isti naslov/g)).toHaveLength(3);
    expect(text.match(/Isti red u telu/g)).toHaveLength(3);
    expect(text).not.toContain("Podnozje");
  });

  it("rejects a PDF whose text is all page numbers and dates as having no text", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const number of ["1", "2"]) {
      const page = doc.addPage([600, 800]);
      page.drawText(number, { x: 560, y: 30, size: 10, font });
      page.drawText("21.10.2025.", { x: 60, y: 30, size: 10, font });
    }
    await expect(extractPdf(Buffer.from(await doc.save()))).rejects.toThrow(/no extractable text/i);
  });

  it("rejects a PDF without any text", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await expect(extractPdf(Buffer.from(await doc.save()))).rejects.toThrow(/no extractable text/i);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(extractPdf(Buffer.from("%PDF-1.4 not really"))).rejects.toThrow();
  });
});

describe("itemsToLines", () => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    { hasEOL = false, size = 12 } = {},
  ): PdfTextItem => ({
    str,
    transform: [size, 0, 0, size, x, y],
    width,
    height: size,
    hasEOL,
  });

  it("joins runs of one line without inserting a space inside a word", () => {
    const lines = itemsToLines([
      item("te", 10, 100, 12),
      item("ž", 22, 100, 6),
      item("ina", 28, 100, 14, { hasEOL: true }),
      item("sledeća linija", 10, 80, 70, { hasEOL: true }),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["težina", "sledeća linija"]);
  });

  it("adds a space between runs separated by a gap", () => {
    const lines = itemsToLines([item("prva", 10, 100, 30), item("druga", 60, 100, 30)]);
    expect(lines.map((line) => line.text)).toEqual(["prva druga"]);
  });

  it("starts a new line when the baseline moves, even without hasEOL", () => {
    const lines = itemsToLines([item("gore", 10, 100, 30), item("dole", 10, 70, 30)]);
    expect(lines.map((line) => line.text)).toEqual(["gore", "dole"]);
  });

  it("ignores empty runs that only carry an end-of-line flag", () => {
    const lines = itemsToLines([
      item("", 10, 100, 0, { hasEOL: true }),
      item("tekst", 10, 100, 30, { hasEOL: true }),
    ]);
    expect(lines.map((line) => line.text)).toEqual(["tekst"]);
  });

  it("reports the line's vertical position when given a position function", () => {
    const lines = itemsToLines(
      [item("gore", 10, 780, 30, { hasEOL: true }), item("dole", 10, 40, 30)],
      (_x, y) => 1 - y / 800,
    );
    expect(lines[0]?.position).toBeCloseTo(0.025);
    expect(lines[1]?.position).toBeCloseTo(0.95);
  });

  it("reports x, text start, font height and the bullet marker", () => {
    const lines = itemsToLines([
      item("●", 80, 100, 6),
      item(" ", 86, 100, 4),
      item("stavka", 100, 100, 40, { hasEOL: true }),
      item("naslov", 20, 60, 90, { size: 24 }),
    ]);
    expect(lines).toEqual([
      { text: "stavka", x: 80, textX: 100, height: 12, isBullet: true },
      { text: "naslov", x: 20, textX: 20, height: 24, isBullet: false },
    ]);
  });

  it("keeps a bullet glyph that sits alone on its line", () => {
    const lines = itemsToLines([
      item("○", 80, 100, 6, { hasEOL: true }),
      item("sledeća", 100, 80, 40),
    ]);
    expect(lines[0]).toMatchObject({ text: "", x: 80, isBullet: true });
    expect(lines[1]).toMatchObject({ text: "sledeća", isBullet: false });
  });

  it("estimates where the text starts when the marker shares a run with it", () => {
    const [line] = itemsToLines([item("- stavka", 80, 100, 80)]);
    expect(line).toMatchObject({ text: "stavka", x: 80, isBullet: true });
    expect(line?.textX).toBeCloseTo(80 + (80 * 2) / 8);
  });
});
