import { describe, expect, it } from "vitest";
import {
  ACCEPTED_FILE_TYPES,
  MAX_MATERIAL_SIZE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MaterialDetail,
} from "./materials";

describe("accepted file types", () => {
  it("maps extensions to a mime type and kind", () => {
    expect(ACCEPTED_FILE_TYPES[".pdf"]).toEqual({ mime: "application/pdf", kind: "material" });
    expect(ACCEPTED_FILE_TYPES[".htm"]).toEqual(ACCEPTED_FILE_TYPES[".html"]);
    expect(ACCEPTED_FILE_TYPES[".markdown"]).toEqual(ACCEPTED_FILE_TYPES[".md"]);
    expect(ACCEPTED_FILE_TYPES[".md"]?.kind).toBe("note");
    expect(ACCEPTED_FILE_TYPES[".exe"]).toBeUndefined();
  });

  it("allows 50 MB per file", () => {
    expect(MAX_MATERIAL_SIZE_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_UPLOAD_TOTAL_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe("MaterialDetail", () => {
  it("accepts a summary plus extracted text", () => {
    const detail = {
      id: 1,
      classId: 2,
      kind: "note",
      originalName: "n.md",
      mime: "text/markdown",
      sizeBytes: 3,
      extractionStatus: "ok",
      extractionError: null,
      pageCount: null,
      createdAt: new Date().toISOString(),
      extractedText: "abc",
    };
    expect(MaterialDetail.parse(detail)).toEqual(detail);
    expect(MaterialDetail.safeParse({ ...detail, kind: "slides" }).success).toBe(false);
  });
});
