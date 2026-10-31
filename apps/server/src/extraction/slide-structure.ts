import { isNoiseLine } from "./clean-slide-text.js";

/** One text line of a slide, with the layout facts needed to recover its structure. */
export interface SlideLine {
  /** Text without the bullet marker. Empty for a bullet glyph that stands alone on its line. */
  text: string;
  /** x of the line's first mark: the bullet glyph for a bullet line. */
  x: number;
  /** x where the text itself starts (after the bullet glyph); equals `x` for other lines. */
  textX: number;
  /** Font height of the text. */
  height: number;
  isBullet: boolean;
}

/** Lines at least this much taller than the page's median body line are titles. */
const TITLE_HEIGHT_RATIO = 1.25;
/** A wrapped continuation must have about the font size of the bullet it continues. */
const CONTINUATION_HEIGHT_TOLERANCE = 0.2;
const MIN_X_TOLERANCE = 3;
const X_TOLERANCE_PER_HEIGHT = 0.25;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Sorted distinct cluster starts: x values within `tolerance` of a cluster's first value join it. */
function clusterStarts(values: number[], tolerance: number): number[] {
  const starts: number[] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = starts[starts.length - 1];
    if (last === undefined || value - last > tolerance) starts.push(value);
  }
  return starts;
}

interface Block {
  kind: "bullet" | "text";
  text: string;
  x: number;
  textX: number;
  height: number;
}

/** Drops noise lines and joins a lone bullet glyph to the line after it. */
function toBlocks(lines: readonly SlideLine[]): Block[] {
  const blocks: Block[] = [];
  let pending: SlideLine | undefined;
  for (const line of lines) {
    const text = line.text.trim();
    if (line.isBullet && text === "") {
      pending = line;
      continue;
    }
    if (text === "" || (!line.isBullet && isNoiseLine(text))) continue;
    if (line.isBullet) {
      blocks.push({ kind: "bullet", text, x: line.x, textX: line.textX, height: line.height });
    } else if (pending) {
      blocks.push({ kind: "bullet", text, x: pending.x, textX: line.x, height: line.height });
    } else {
      blocks.push({ kind: "text", text, x: line.x, textX: line.x, height: line.height });
    }
    pending = undefined;
  }
  return blocks;
}

/**
 * Rebuilds the structure of one slide page as text lines:
 * - bullets get `"  ".repeat(level) + "- "`, where levels come from the distinct x positions of
 *   the page's bullet glyphs (leftmost = 0);
 * - a non-bullet line that continues a bullet (it starts where the bullet's text starts and has
 *   about its font size) is appended to that bullet;
 * - a non-bullet line at least 1.25x taller than the median line is a title: `## text`.
 * Page numbers, dates and empty lines are dropped.
 */
export function structureSlideLines(lines: readonly SlideLine[]): string[] {
  const blocks = toBlocks(lines);
  if (blocks.length === 0) return [];

  const medianHeight = median(blocks.map((block) => block.height));
  const tolerance = Math.max(MIN_X_TOLERANCE, medianHeight * X_TOLERANCE_PER_HEIGHT);
  const levelStarts = clusterStarts(
    blocks.filter((block) => block.kind === "bullet").map((block) => block.x),
    tolerance,
  );
  const levelOf = (x: number): number => {
    let level = 0;
    levelStarts.forEach((start, index) => {
      if (x >= start - tolerance) level = index;
    });
    return level;
  };
  const isTitle = (block: Block) =>
    block.kind === "text" && medianHeight > 0 && block.height >= medianHeight * TITLE_HEIGHT_RATIO;

  const out: string[] = [];
  /** The bullet that wrapped lines may still continue, and where its text starts. */
  let open: { index: number; textX: number; height: number } | undefined;
  for (const block of blocks) {
    if (block.kind === "bullet") {
      out.push(`${"  ".repeat(levelOf(block.x))}- ${block.text}`);
      open = { index: out.length - 1, textX: block.textX, height: block.height };
    } else if (isTitle(block)) {
      out.push(`## ${block.text}`);
      open = undefined;
    } else if (
      open &&
      Math.abs(block.x - open.textX) <= tolerance &&
      Math.abs(block.height - open.height) <= open.height * CONTINUATION_HEIGHT_TOLERANCE
    ) {
      out[open.index] = `${out[open.index]} ${block.text}`;
    } else {
      out.push(block.text);
      open = undefined;
    }
  }
  return out;
}
