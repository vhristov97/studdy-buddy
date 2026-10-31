import type { VizDraft, VizPlan, VizReview } from "@studdy/shared";

/** Test-only. A small hand-written plan, page and reviews; no real course material. */

export function vizPlanFixture(overrides: Partial<VizPlan> = {}): VizPlan {
  return {
    title: "Sharding pod lupom",
    slug: "sharding-pod-lupom",
    concept: "Sharding pod lupom",
    section: "Obrada podataka › Batch obrada",
    misconception: {
      wrongModelPredicts: "Dodavanje čvora premešta samo mali deo ključeva.",
      vizShows: "Mod N premešta većinu ključeva, consistent hashing samo oko četvrtine.",
    },
    layout: "Gore kontrole, u sredini prsten sa čvorovima i ključevima, dole opis događaja.",
    controls: [
      { name: "Dodaj čvor", effect: "Pojavljuje se novi čvor i ključevi menjaju boju." },
      { name: "Način raspodele", effect: "Prebacuje mod N i consistent hashing." },
    ],
    scenarios: [
      {
        name: "Dodavanje čvora",
        steps: ["Izaberi mod N", "Klikni Dodaj čvor"],
        expectedEndState: "Većina od 12 ključeva je promenila čvor, prikazano brojačem.",
      },
      {
        name: "Ispad čvora",
        steps: ["Izaberi consistent hashing", "Ugasi čvor 2"],
        expectedEndState: "Samo ključevi čvora 2 su premešteni.",
      },
    ],
    terminology: [{ term: "shard", meaning: "Deo podataka na jednom čvoru." }],
    dopuna: [],
    ...overrides,
  };
}

/** A page that satisfies the static design contract. */
export const VIZ_HTML = `<!doctype html>
<html lang="sr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sharding pod lupom</title>
<style>
:root { --bg: #fff; --fg: #111; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; } }
@media (prefers-reduced-motion: reduce) { * { transition: none; } }
body { background: var(--bg); color: var(--fg); }
</style>
</head>
<body>
<button id="add">Dodaj čvor</button>
<p id="log" aria-live="polite"></p>
<script>
document.getElementById("add").addEventListener("click", () => {
  document.getElementById("log").textContent = "Čvor dodat";
});
</script>
</body>
</html>`;

export function vizDraftFixture(overrides: Partial<VizDraft> = {}): VizDraft {
  return { html: VIZ_HTML, notes: [], ...overrides };
}

export const VIZ_APPROVED: VizReview = {
  approved: true,
  summary: "Svi scenariji završavaju u planiranom stanju.",
  fixes: [],
};

export const VIZ_REJECTED: VizReview = {
  approved: false,
  summary: "Scenario ispada čvora ne završava u planiranom stanju.",
  fixes: [
    {
      area: "scenario: Ispad čvora",
      problem: "Posle gašenja čvora 2 svi ključevi se premeštaju.",
      change: "Premesti samo ključeve čvora 2.",
    },
  ],
};
