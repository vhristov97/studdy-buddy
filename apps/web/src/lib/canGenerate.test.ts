import { describe, expect, it } from "vitest";
import { classDetail, material } from "../test/utils";
import { canGenerate } from "./canGenerate";

describe("canGenerate", () => {
  it("is not ok without any material", () => {
    expect(canGenerate(classDetail())).toEqual({
      ok: false,
      reason: "Dodaj bar jedan PDF ili HTML materijal.",
    });
  });

  it("does not count notes as material", () => {
    const notes = [material({ kind: "note", mime: "text/markdown", originalName: "n.md" })];
    expect(canGenerate(classDetail({ materials: notes })).reason).toBe(
      "Dodaj bar jedan PDF ili HTML materijal.",
    );
  });

  it("is not ok when an item failed extraction", () => {
    const items = [
      material(),
      material({ id: 11, extractionStatus: "failed", extractionError: "boom" }),
    ];
    expect(canGenerate(classDetail({ materials: items }))).toEqual({
      ok: false,
      reason: "Ukloni materijale čiji tekst nije izdvojen.",
    });
  });

  it("is ok for a draft with extracted material", () => {
    expect(canGenerate(classDetail({ materials: [material()] }))).toEqual({
      ok: true,
      reason: null,
    });
  });

  it("is ok for a failed class (retry)", () => {
    expect(canGenerate(classDetail({ status: "failed", materials: [material()] })).ok).toBe(true);
  });

  it("is not ok while generating", () => {
    expect(canGenerate(classDetail({ status: "generating", materials: [material()] }))).toEqual({
      ok: false,
      reason: "Generisanje je u toku.",
    });
  });

  it("is not ok once generated", () => {
    const result = canGenerate(classDetail({ status: "ready", materials: [material()] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Predavanje je već generisano.");
  });
});
