import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { BULLET_PREFIX, cleanSlideText } from "./clean-slide-text.js";
import { structureSlideLines, type SlideLine } from "./slide-structure.js";
import type { ExtractedText } from "./types.js";

/** The parts of a pdf.js text item that line rebuilding needs. */
export interface PdfTextItem {
  str: string;
  /** [a, b, c, d, e, f]; e/f is the origin of the text run. */
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

const fontHeight = (item: PdfTextItem): number =>
  Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || item.height;

/** A piece of a line being built: where it starts in the line's text and on the page. */
interface Run {
  offset: number;
  length: number;
  x: number;
  width: number;
  height: number;
}

function finishLine(text: string, runs: Run[]): SlideLine | undefined {
  if (text.trim() === "") return undefined;
  const bullet = BULLET_PREFIX.exec(text);
  const prefixLength = bullet?.[0].length ?? 0;
  const first = runs[0];
  if (!first) return undefined;

  // Runs that hold text after the bullet marker; their start is where the text begins.
  const textRuns = runs.filter(
    (run) => run.offset + run.length > prefixLength && run.height > 0 && run.length > 0,
  );
  const firstText = textRuns[0] ?? first;
  const textOffset = Math.max(prefixLength, firstText.offset);
  // The marker and its text may share a run: estimate the x of the text inside it.
  const inRun = firstText.length > 0 ? (textOffset - firstText.offset) / firstText.length : 0;
  const textX = firstText.x + firstText.width * inRun;
  return {
    text: text.slice(prefixLength).trim(),
    x: first.x,
    textX: bullet ? textX : first.x,
    height: Math.max(...(textRuns.length > 0 ? textRuns : runs).map((run) => run.height)),
    isBullet: bullet !== null,
  };
}

/**
 * Rebuilds the lines of one page from pdf.js text items. A new line starts after an item with
 * `hasEOL` or when the baseline (y of the transform) moves; items of one line are concatenated
 * (runs are often split mid-word at accented letters), with a space where there is a gap.
 * Each line carries its x position, font height and bullet marker for `structureSlideLines`.
 */
export function itemsToLines(items: readonly PdfTextItem[]): SlideLine[] {
  const lines: SlideLine[] = [];
  let current = "";
  let runs: Run[] = [];
  let lastY: number | undefined;
  let lastEnd = 0;
  let breakNext = false;

  const flush = () => {
    const line = finishLine(current, runs);
    if (line) lines.push(line);
    current = "";
    runs = [];
    lastY = undefined;
  };

  for (const item of items) {
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const height = fontHeight(item);
    const tolerance = Math.max(2, height * 0.4);
    if (breakNext || (lastY !== undefined && Math.abs(y - lastY) > tolerance)) flush();
    breakNext = false;

    if (item.str !== "") {
      const gap = x - lastEnd;
      const needsSpace =
        current !== "" &&
        gap > Math.max(height, 1) * 0.25 &&
        !/\s$/.test(current) &&
        !/^\s/.test(item.str);
      if (needsSpace) current += " ";
      runs.push({
        offset: current.length,
        length: item.str.length,
        x,
        width: item.width,
        height: item.str.trim() === "" ? 0 : height,
      });
      current += item.str;
      lastY = y;
      lastEnd = x + item.width;
    }
    if (item.hasEOL) breakNext = true;
  }
  flush();
  return lines;
}

/** Extracts the text of every page and cleans it with `cleanSlideText`. Throws on unreadable or text-less PDFs. */
export async function extractPdf(buffer: Buffer): Promise<ExtractedText> {
  const task = pdfjs.getDocument({
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.filter((item) => "str" in item) as PdfTextItem[];
      pages.push(structureSlideLines(itemsToLines(items)).join("\n"));
      page.cleanup();
    }
    const result = cleanSlideText(pages);
    if (!pages.some((page) => page.trim() !== "")) {
      throw new Error("The PDF has no extractable text (a scanned document?)");
    }
    return result;
  } finally {
    await task.destroy();
  }
}
