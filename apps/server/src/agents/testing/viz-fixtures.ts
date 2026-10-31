import type { VizSuggestionDraft, VizSuggestions } from "@studdy/shared";

/** Test-only. Small hand-written visualization suggestions; no real course material. */

export function vizSuggestionFixture(
  overrides: Partial<VizSuggestionDraft> = {},
): VizSuggestionDraft {
  return {
    concept: "Sharding pod lupom",
    section: "Obrada podataka › Batch obrada",
    misconception:
      "Pogrešan model predviđa da dodavanje čvora premešta samo mali deo ključeva; vizualizacija pokazuje da mod N premešta većinu.",
    summary:
      "Student dodaje i uklanja čvorove i poredi mod N sa consistent hashing. Kontrole su broj čvorova i način raspodele; scenariji pokrivaju dodavanje i ispad čvora.",
    controls: ["klizač: broj čvorova", "prekidač: mod N / consistent hashing"],
    scenarios: [
      "Dodavanje čvora: 3 čvora, 12 ključeva, dodaj čvor; mod N premešta većinu ključeva.",
      "Ispad čvora: ugasi čvor 2; consistent hashing premešta samo njegove ključeve.",
    ],
    ...overrides,
  };
}

export function vizSuggestionsFixture(): VizSuggestions {
  return {
    suggestions: [
      vizSuggestionFixture(),
      vizSuggestionFixture({
        concept: "Lambda u pokretu",
        section: "Obrada podataka › Stream obrada",
        controls: ["dugme: pošalji događaj", "prekidač: batch sloj uključen"],
      }),
    ],
  };
}
