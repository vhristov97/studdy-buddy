import type { MaterialKind } from "@studdy/shared";
import { extractHtml } from "./html.js";
import { extractMarkdown } from "./markdown.js";
import { extractPdf } from "./pdf.js";
import type { ExtractedText } from "./types.js";

export type { ExtractedText } from "./types.js";

/** Extracts plain text from an uploaded file; throws if the format is unsupported or the file is unreadable. */
export async function extractText(
  kind: MaterialKind,
  mime: string,
  buffer: Buffer,
): Promise<ExtractedText> {
  switch (mime) {
    case "application/pdf":
      return extractPdf(buffer);
    case "text/html":
      return extractHtml(buffer);
    case "text/markdown":
      return extractMarkdown(buffer);
    default:
      throw new Error(`No text extractor for ${kind} of type ${mime}`);
  }
}
