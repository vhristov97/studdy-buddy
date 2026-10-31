import type { ExtractedText } from "./types.js";

/** Glyphs slides use as bullets; Wingdings-style bullets land in the Unicode private use area. */
const GLYPH_BULLET_CHARS = "•◦▪▫●○■□➢✓\uE000-\uF8FF";
/** "-", "–" and "*" are bullets only when they stand alone, since they can be real text. */
const BULLET_ONLY = new RegExp(`^[${GLYPH_BULLET_CHARS}–\\-*]$`, "u");
/** Glyph bullets at the start of a line with text. */
const LEADING_GLYPH_BULLET = new RegExp(`^[${GLYPH_BULLET_CHARS}]\\s+(?=\\S)`, "u");
/** A bullet marker (glyph, or a lone dash/asterisk) with the whitespace after it. */
export const BULLET_PREFIX = new RegExp(`^(?:[${GLYPH_BULLET_CHARS}]|[–\\-*](?=\\s|$))\\s*`, "u");
const PAGE_NUMBER_ONLY = /^\d{1,3}$/;
/** 21.10.2025. / 21. 10. 2025 / 10/9/26 / 2025-10-21 */
const DATE_ONLY =
  /^(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}|\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2})\s*\.?$/;

/** A bare page number or a date: slide furniture rather than content. */
export function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  return PAGE_NUMBER_ONLY.test(trimmed) || DATE_ONLY.test(trimmed);
}

/** Two spaces per list level, as written by `structureSlideLines`. */
const INDENTED_LIST_ITEM = /^((?: {2})+)- /;

/** A line must repeat on more than this share of the pages to count as a footer or header. */
const REPEATED_LINE_SHARE = 0.5;
/** Footers and headers sit in the top or bottom margin band; this is its share of the page height. */
const TOP_BAND = 0.1;
const BOTTOM_BAND = 0.12;

/** A line of a page with where it sits: 0 is the page's top edge, 1 its bottom edge. */
export interface PositionedLine {
  text: string;
  position?: number | undefined;
}

/** One page: raw text, or lines that know their position (only those can be repeated footers). */
export type SlidePage = string | readonly PositionedLine[];

const inMarginBand = (position: number | undefined): boolean =>
  position !== undefined && (position <= TOP_BAND || position >= 1 - BOTTOM_BAND);

/** True unless the text holds nothing but page markers and whitespace. */
export function hasContent(text: string): boolean {
  return text.replace(/^--- strana \d+ ---$/gm, "").trim() !== "";
}

export function pageMarker(pageNumber: number): string {
  return `--- strana ${pageNumber} ---`;
}

function normalizeForComparison(line: string): string {
  return line
    .replace(/^\s*(?:## |- )/, "")
    .toLowerCase()
    .replace(/\d+/g, "#");
}

/** Titles and list items are content, never a footer, however often they repeat. */
const isStructuredLine = (line: string): boolean => /^\s*(?:## |- )/.test(line);

/**
 * Trim, collapse whitespace, drop empty lines, page numbers and dates, and merge lone bullets.
 * Indented list items (`  - text`) keep their indentation.
 */
function cleanPageLines(page: SlidePage): PositionedLine[] {
  const raw: readonly PositionedLine[] =
    typeof page === "string" ? page.split(/\r\n|\r|\n/).map((text) => ({ text })) : page;
  const lines = raw
    .map(({ text, position }) => {
      const indent = INDENTED_LIST_ITEM.exec(text)?.[1] ?? "";
      return { text: indent + text.replace(/\s+/g, " ").trim(), position };
    })
    .filter((line) => line.text.trim() !== "" && !isNoiseLine(line.text));

  const out: PositionedLine[] = [];
  let pendingBullet = false;
  for (const { text: line, position } of lines) {
    if (BULLET_ONLY.test(line)) {
      pendingBullet = true;
      continue;
    }
    const text = line.replace(LEADING_GLYPH_BULLET, "- ");
    out.push({ text: pendingBullet && !text.startsWith("- ") ? `- ${text}` : text, position });
    pendingBullet = false;
  }
  return out;
}

/**
 * Turns the raw per-page text of a slide deck into one cleaned string with a
 * `--- strana N ---` marker before each page, so later steps can cite slide pages.
 *
 * Noise removed: blank lines, bare page numbers, date-only lines, lone bullet glyphs (merged
 * into the next line as `- `) and footers/headers: plain lines that repeat on more than half of
 * the pages and sit in the top or bottom margin band on every page they occur on. Titles, list
 * items and lines without a known position are never removed as repeated.
 */
export function cleanSlideText(pages: readonly SlidePage[]): ExtractedText {
  const cleaned = pages.map(cleanPageLines);

  // Repeated footers/headers only make sense when there are several pages to compare.
  const repeated = new Set<string>();
  if (cleaned.length >= 2) {
    const pagesWithLine = new Map<string, number>();
    const notFooter = new Set<string>();
    for (const lines of cleaned) {
      for (const { text, position } of lines) {
        if (isStructuredLine(text) || !inMarginBand(position)) {
          notFooter.add(normalizeForComparison(text));
        }
      }
      for (const key of new Set(lines.map((line) => normalizeForComparison(line.text)))) {
        pagesWithLine.set(key, (pagesWithLine.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of pagesWithLine) {
      if (count / cleaned.length > REPEATED_LINE_SHARE && !notFooter.has(key)) repeated.add(key);
    }
  }

  const blocks = cleaned.map((lines, index) => {
    const kept = lines.filter((line) => !repeated.has(normalizeForComparison(line.text)));
    return [pageMarker(index + 1), ...kept.map((line) => line.text)].join("\n");
  });
  return { text: blocks.join("\n\n"), pageCount: pages.length };
}
