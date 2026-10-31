export const FORM_ERROR_KEY = "_form";

export type FieldErrors = Record<string, string>;

const FIELD_LABELS: Record<string, string> = {
  name: "Naziv",
  persona: "Uloga tutora",
  assessmentFormat: "Format ispita",
  title: "Naslov",
};

const NUMBER_RANGES: Record<string, string> = {
  reviewCadence: "Unesite ceo broj od 1 do 50.",
  number: "Unesite ceo broj od 1 do 999.",
};

interface LooseIssue {
  code?: unknown;
  path?: unknown;
  maximum?: unknown;
}

function messageFor(field: string, issue: LooseIssue): string {
  const range = NUMBER_RANGES[field];
  if (range) return range;
  const label = FIELD_LABELS[field];
  if (label && issue.code === "too_small") return `${label} je obavezan.`;
  if (label && issue.code === "too_big") {
    return `${label} može imati najviše ${String(issue.maximum)} karaktera.`;
  }
  return "Neispravna vrednost.";
}

/**
 * Turns Zod issues (from a client-side parse or the server's `details`) into one Serbian message
 * per field. Issues without a field end up under FORM_ERROR_KEY.
 */
export function issuesToFieldErrors(issues: unknown): FieldErrors {
  const errors: FieldErrors = {};
  if (!Array.isArray(issues)) return errors;
  for (const raw of issues) {
    if (typeof raw !== "object" || raw === null) continue;
    const issue = raw as LooseIssue;
    const first = Array.isArray(issue.path) ? issue.path[0] : undefined;
    const field = typeof first === "string" ? first : FORM_ERROR_KEY;
    if (errors[field]) continue;
    errors[field] = field === FORM_ERROR_KEY ? "Neispravan unos." : messageFor(field, issue);
  }
  return errors;
}
