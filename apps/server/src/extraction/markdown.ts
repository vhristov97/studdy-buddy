import type { ExtractedText } from "./types.js";

/** Notes are kept as written: only the BOM and line endings are normalized (`~~` stays). */
export function extractMarkdown(buffer: Buffer): ExtractedText {
  const text = buffer
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  return { text, pageCount: null };
}
