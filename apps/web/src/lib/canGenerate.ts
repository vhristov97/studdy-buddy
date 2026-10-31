import type { ClassDetail } from "@studdy/shared";

export interface GenerateReadiness {
  ok: boolean;
  /** Why generation isn't possible; null when it is. */
  reason: string | null;
}

/** Whether a class can be generated: a draft (first run) or a failed one (retry) with material. */
export function canGenerate(
  classDetail: Pick<ClassDetail, "status" | "materials">,
): GenerateReadiness {
  if (classDetail.status === "generating") {
    return { ok: false, reason: "Generisanje je u toku." };
  }
  if (classDetail.status === "ready") {
    return { ok: false, reason: "Predavanje je već generisano." };
  }
  if (!classDetail.materials.some((item) => item.kind === "material")) {
    return { ok: false, reason: "Dodaj bar jedan PDF ili HTML materijal." };
  }
  if (classDetail.materials.some((item) => item.extractionStatus === "failed")) {
    return { ok: false, reason: "Ukloni materijale čiji tekst nije izdvojen." };
  }
  return { ok: true, reason: null };
}
