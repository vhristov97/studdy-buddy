import { z } from "zod";

export const MATERIAL_KINDS = ["material", "note"] as const;
export const MaterialKind = z.enum(MATERIAL_KINDS);
export type MaterialKind = z.infer<typeof MaterialKind>;

export const EXTRACTION_STATUSES = ["ok", "failed"] as const;
export const ExtractionStatus = z.enum(EXTRACTION_STATUSES);
export type ExtractionStatus = z.infer<typeof ExtractionStatus>;

/** Largest accepted upload, per file. */
export const MAX_MATERIAL_SIZE_BYTES = 50 * 1024 * 1024;

export interface AcceptedFileType {
  mime: string;
  kind: MaterialKind;
}

/** Accepted upload types by lowercase extension (with the dot). Class materials are required, notes optional. */
export const ACCEPTED_FILE_TYPES: Readonly<Record<string, AcceptedFileType>> = {
  ".pdf": { mime: "application/pdf", kind: "material" },
  ".html": { mime: "text/html", kind: "material" },
  ".htm": { mime: "text/html", kind: "material" },
  ".md": { mime: "text/markdown", kind: "note" },
  ".markdown": { mime: "text/markdown", kind: "note" },
};

export const MaterialSummary = z.object({
  id: z.number().int(),
  classId: z.number().int(),
  kind: MaterialKind,
  originalName: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  extractionStatus: ExtractionStatus,
  extractionError: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type MaterialSummary = z.infer<typeof MaterialSummary>;

export const MaterialDetail = MaterialSummary.extend({
  extractedText: z.string().nullable(),
});
export type MaterialDetail = z.infer<typeof MaterialDetail>;
