import { z } from "zod";

/** Output of the viz-builder agent: one self-contained HTML page plus remarks for the reviewer. */
export const VizDraft = z.object({
  html: z.string().min(1),
  /** Things the builder wants the reviewer to know (deviations, doubts about the plan). */
  notes: z.array(z.string()),
});
export type VizDraft = z.infer<typeof VizDraft>;

/** One fix the reviewer wants from the builder. */
export const VizReviewFix = z.object({
  /** What it concerns: a control, a scenario, "design contract", "language", ... */
  area: z.string().min(1),
  problem: z.string().min(1),
  change: z.string().min(1),
});
export type VizReviewFix = z.infer<typeof VizReviewFix>;

/** Output of the viz-reviewer agent. */
export const VizReview = z.object({
  approved: z.boolean(),
  summary: z.string().min(1),
  fixes: z.array(VizReviewFix),
});
export type VizReview = z.infer<typeof VizReview>;

export interface VizIssue {
  severity: "error" | "warning";
  /** Stable machine-readable code, e.g. "external_script". */
  code: string;
  message: string;
}

export interface VizReport {
  errors: VizIssue[];
  warnings: VizIssue[];
}

/** The largest page the server accepts. */
export const MAX_VIZ_HTML_BYTES = 400 * 1024;
export const MIN_VIZ_TITLE_WORDS = 2;
export const MAX_VIZ_TITLE_WORDS = 4;

/** How far before a storage access a `try {` may sit for the access to count as guarded. */
const STORAGE_TRY_WINDOW = 200;

const EXTERNAL_URL = String.raw`(?:https?:)?\/\/`;

/** The raw value of attribute `name` in one start tag; null when the tag does not have it. */
function tagAttr(tag: string, name: string): string | null {
  const match = new RegExp(
    String.raw`[\s"'/]${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))`,
    "i",
  ).exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/** Words of a `<title>` / plan title, split on whitespace. */
export function countTitleWords(title: string): number {
  return title.split(/\s+/).filter(Boolean).length;
}

/** The text of the page's `<title>`, whitespace collapsed; null when there is none. */
export function vizHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.replace(/<!--[\s\S]*?-->/g, ""));
  return match ? match[1]!.replace(/\s+/g, " ").trim() : null;
}

/**
 * The static part of the visualization design contract (spec §12): checks that need no browser.
 * Errors block release (the builder must repair them); warnings go to the reviewer.
 */
export function validateVizHtml(html: string): VizReport {
  const errors: VizIssue[] = [];
  const warnings: VizIssue[] = [];
  const error = (code: string, message: string): void => {
    errors.push({ severity: "error", code, message });
  };
  const warn = (code: string, message: string): void => {
    warnings.push({ severity: "warning", code, message });
  };

  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_VIZ_HTML_BYTES) {
    error(
      "too_large",
      `The page is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_VIZ_HTML_BYTES / 1024} KB. Make it smaller.`,
    );
  }

  if (!/^\s*<!doctype html>/i.test(html)) {
    error("missing_doctype", "The page must start with <!doctype html>.");
  }

  // Everything below ignores HTML comments, so a commented-out tag is neither found nor flagged.
  const page = html.replace(/<!--[\s\S]*?-->/g, "");

  if (!/<meta\b[^>]*\bname\s*=\s*["']?viewport\b/i.test(page)) {
    error(
      "missing_viewport",
      'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    );
  }

  const title = vizHtmlTitle(page);
  if (title === null || title === "") {
    error("missing_title", "The page needs a <title> of 2-4 words.");
  } else {
    const words = countTitleWords(title);
    if (words < MIN_VIZ_TITLE_WORDS || words > MAX_VIZ_TITLE_WORDS) {
      error("title_word_count", `The <title> "${title}" has ${words} words; it needs 2 to 4.`);
    }
  }

  if (!/prefers-color-scheme/i.test(page)) {
    error(
      "missing_color_scheme",
      "The page must support light and dark themes with CSS custom properties and @media (prefers-color-scheme: dark).",
    );
  } else if (!/prefers-color-scheme\s*:\s*dark/i.test(page)) {
    warn(
      "no_dark_theme",
      "No @media (prefers-color-scheme: dark) rule found; is there a dark theme?",
    );
  }

  if (/<script\b[^>]*\bsrc\s*=/i.test(page)) {
    error("external_script", "<script src=...> is not allowed; put all JavaScript inline.");
  }
  if (new RegExp(String.raw`<link\b[^>]*\bhref\s*=\s*["']?\s*${EXTERNAL_URL}`, "i").test(page)) {
    error(
      "external_link",
      "<link href=http(s)://...> is not allowed; the page must not load external resources.",
    );
  }
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet\b/i.test(page)) {
    error(
      "external_stylesheet",
      '<link rel="stylesheet"> is not allowed; put all CSS in a <style> element.',
    );
  }
  if (new RegExp(String.raw`@import\s+(?:url\(\s*)?["']?\s*${EXTERNAL_URL}`, "i").test(page)) {
    error("css_import", "@import of an external stylesheet is not allowed.");
  }
  if (new RegExp(String.raw`\burl\(\s*["']?\s*${EXTERNAL_URL}`, "i").test(page)) {
    error(
      "css_external_url",
      "CSS url(http...) is not allowed; use no external images, fonts or files.",
    );
  }
  if (/\bfetch\s*\(/.test(page) || /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/.test(page)) {
    error(
      "network_api",
      "fetch(), XMLHttpRequest, WebSocket and EventSource are not allowed; the page makes no network requests.",
    );
  }
  if (/\bsendBeacon\b/.test(page)) {
    error(
      "network_api",
      "navigator.sendBeacon is not allowed; the page makes no network requests.",
    );
  }

  // http(s):// or // in src/href/poster/action of any tag. Anchors are handled separately below.
  const attrPattern = new RegExp(
    String.raw`\s(src|href|xlink:href|poster|action|srcset)\s*=\s*["']?\s*${EXTERNAL_URL}`,
    "i",
  );
  for (const tag of page.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const name = tag[1]!.toLowerCase();
    if (name === "script" || name === "link" || name === "a" || name === "area") continue; // handled elsewhere
    if (attrPattern.test(tag[0])) {
      error(
        "external_resource",
        `<${name}> references an external URL (${tag[0].slice(0, 80)}...); the page must not load external resources.`,
      );
      break;
    }
  }

  // Anchors: an allow-list. Only an empty href or an in-page fragment (#id) is fine; any other
  // value (http(s), mailto:, javascript:, data:, tel:, file:, a relative or absolute path, ...)
  // would navigate the sandboxed frame away from the page. CSP has no reliable directive against
  // frame self-navigation, so this check is the main guard (the serving headers and the iframe
  // sandbox are defense in depth).
  for (const tag of page.matchAll(/<(a|area)\b[^>]*>/gi)) {
    const href = tagAttr(tag[0], "href");
    if (href === null) continue;
    const value = href.trim();
    if (value === "" || value.startsWith("#")) continue;
    error(
      "external_link_anchor",
      `<${tag[1]!.toLowerCase()}> links away from the page (${tag[0].slice(0, 80)}...); only href="#id" links inside the page are allowed, cite sources as plain text.`,
    );
  }
  for (const tag of page.matchAll(/<(?:form|button|input)\b[^>]*>/gi)) {
    for (const attr of ["action", "formaction"]) {
      const value = tagAttr(tag[0], attr);
      if (value !== null && value.trim() !== "") {
        error(
          "navigation_api",
          `${attr}="${value.trim().slice(0, 40)}" is not allowed; forms must not submit or navigate.`,
        );
      }
    }
  }
  if (/<base\b[^>]*\bhref\s*=/i.test(page)) {
    error(
      "navigation_api",
      "<base href> is not allowed; the page must not change how links resolve.",
    );
  }

  // Navigation of the page itself. Anchored on the receivers (bare identifier, window, self, top,
  // parent, document), so a simulation property like `node.location = next` is not flagged.
  const globalRecv = String.raw`(?:(?:window|self|top|parent|globalThis)\s*\.\s*)*(?:window|self|top|parent|document|globalThis)\s*\.\s*`;
  const location = String.raw`(?:(?<![.\w$])${globalRecv}|(?<![.\w$])(?<!\b(?:const|let|var|function)\s+))location`;
  if (
    new RegExp(String.raw`${location}\s*(?:\.\s*href\s*)?=(?!=)`).test(page) ||
    new RegExp(String.raw`${location}\s*\.\s*(?:assign|replace)\s*\(`).test(page)
  ) {
    error(
      "navigation_api",
      "Assigning location / location.href or calling location.assign() / location.replace() is not allowed; the page must not navigate.",
    );
  }
  if (
    /(?<![.\w$])(?:(?:window|self|top|parent|globalThis)\s*\.\s*)+open\s*\(/.test(page) ||
    /(?<![.\w$])(?<!\bfunction\s+)open\s*\((?![^()]*\)\s*\{)/.test(page)
  ) {
    error(
      "navigation_api",
      "window.open() is not allowed; the page must not navigate or open windows.",
    );
  }
  if (/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b/i.test(page)) {
    error(
      "navigation_api",
      '<meta http-equiv="refresh"> is not allowed; the page must not navigate.',
    );
  }

  const unguarded = [...page.matchAll(/\b(?:localStorage|sessionStorage)\b/g)].filter((m) => {
    const before = page.slice(Math.max(0, m.index - STORAGE_TRY_WINDOW), m.index);
    return !/\btry\s*\{/.test(before);
  });
  if (unguarded.length > 0) {
    warn(
      "storage_not_guarded",
      `${unguarded.length} localStorage/sessionStorage access(es) are not inside a try { } block; the page must work when storage throws or is blocked.`,
    );
  }

  if (!/\baria-live\s*=/i.test(page) && !/\brole\s*=\s*["']?(?:log|status)\b/i.test(page)) {
    warn(
      "no_live_region",
      'No element with aria-live found; the caption / event log should be an aria-live="polite" region.',
    );
  }

  if (
    /\b(?:animation|transition|requestAnimationFrame|setInterval)\b/.test(page) &&
    !/prefers-reduced-motion/i.test(page)
  ) {
    warn(
      "no_reduced_motion",
      "The page animates but has no @media (prefers-reduced-motion: reduce) handling.",
    );
  }

  return { errors, warnings };
}

function formatIssue(issue: VizIssue): string {
  return `- [${issue.code}] ${issue.message}`;
}

/** A compact, human-readable list of the report, for builder/reviewer prompts and logs. */
export function formatVizReport(report: VizReport): string {
  return [
    `Errors (${report.errors.length}):`,
    ...(report.errors.length ? report.errors.map(formatIssue) : ["- none"]),
    `Warnings (${report.warnings.length}):`,
    ...(report.warnings.length ? report.warnings.map(formatIssue) : ["- none"]),
  ].join("\n");
}
