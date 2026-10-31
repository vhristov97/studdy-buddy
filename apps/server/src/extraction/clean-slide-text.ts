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

export function pageMarker(pageNumber: number): string {
  return `--- strana ${pageNumber} ---`;
}

function normalizeForComparison(line: string): string {
  return line
    .replace(/^\s*(?:## |- )/, "")
    .toLowerCase()
    .replace(/\d+/g, "#");
}

/**
 * Trim, collapse whitespace, drop empty lines, page numbers and dates, and merge lone bullets.
 * Indented list items (`  - text`) keep their indentation.
 */
function cleanPageLines(rawPage: string): string[] {
  const lines = rawPage
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const indent = INDENTED_LIST_ITEM.exec(line)?.[1] ?? "";
      return indent + line.replace(/\s+/g, " ").trim();
    })
    .filter((line) => line.trim() !== "" && !isNoiseLine(line));

  const out: string[] = [];
  let pendingBullet = false;
  for (const line of lines) {
    if (BULLET_ONLY.test(line)) {
      pendingBullet = true;
      continue;
    }
    const text = line.replace(LEADING_GLYPH_BULLET, "- ");
    out.push(pendingBullet && !text.startsWith("- ") ? `- ${text}` : text);
    pendingBullet = false;
  }
  return out;
}

/**
 * Turns the raw per-page text of a slide deck into one cleaned string with a
 * `--- strana N ---` marker before each page, so later steps can cite slide pages.
 *
 * Noise removed: blank lines, bare page numbers, date-only lines, lone bullet glyphs (merged
 * into the next line as `- `) and lines repeated on more than half of the pages (footers).
 */
export function cleanSlideText(pages: string[]): ExtractedText {
  const cleaned = pages.map(cleanPageLines);

  // Repeated footers/headers only make sense when there are several pages to compare.
  const repeated = new Set<string>();
  if (cleaned.length >= 2) {
    const pagesWithLine = new Map<string, number>();
    for (const lines of cleaned) {
      for (const key of new Set(lines.map(normalizeForComparison))) {
        pagesWithLine.set(key, (pagesWithLine.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of pagesWithLine) {
      if (count / cleaned.length > REPEATED_LINE_SHARE) repeated.add(key);
    }
  }

  const blocks = cleaned.map((lines, index) => {
    const kept = lines.filter((line) => !repeated.has(normalizeForComparison(line)));
    return [pageMarker(index + 1), ...kept].join("\n");
  });
  return { text: blocks.join("\n\n"), pageCount: pages.length };
}
