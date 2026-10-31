/**
 * Serbian plural form of a count: 1 for 1, 21, 101 (not 11); 2 for 2-4, 22-24 (not 12-14);
 * 3 for everything else, including 0 and 11-14.
 */
export function pluralForm(n: number): 1 | 2 | 3 {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 1;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 2;
  return 3;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const form = pluralForm(n);
  return form === 1 ? one : form === 2 ? few : many;
}

export const countClasses = (n: number) =>
  `${n} ${plural(n, "predavanje", "predavanja", "predavanja")}`;
export const countMaterials = (n: number) =>
  `${n} ${plural(n, "materijal", "materijala", "materijala")}`;
export const countNotes = (n: number) => `${n} ${plural(n, "beleška", "beleške", "beležaka")}`;
export const countQuestions = (n: number) => `${n} ${plural(n, "pitanje", "pitanja", "pitanja")}`;
export const countPages = (n: number) => `${n} ${plural(n, "strana", "strane", "strana")}`;

/** "na svako predavanje" / "na svaka 3 predavanja" / "na svakih 5 predavanja". */
export function cadenceLabel(n: number): string {
  if (n === 1) return "na svako predavanje";
  const form = pluralForm(n);
  const every = form === 1 ? "svako" : form === 2 ? "svaka" : "svakih";
  return `na ${every} ${countClasses(n)}`;
}

/** Human readable size with a decimal comma, e.g. "1,5 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded.replace(".", ",")} ${units[unit]}`;
}

export function formatClassNumber(n: number): string {
  return String(n).padStart(2, "0");
}

export function mimeLabel(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/html") return "HTML";
  if (mime === "text/markdown") return "Markdown";
  return mime;
}

/** Integer with dot thousands separators ("12.400"), independent of the runtime's locale data. */
export function formatCount(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** "42 s" under a minute, otherwise "3 min 05 s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  return `${minutes} min ${String(total % 60).padStart(2, "0")} s`;
}

/** Serbian numeric date of an ISO timestamp in local time, e.g. "31. 10. 2026.". */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getDate()}. ${date.getMonth() + 1}. ${date.getFullYear()}.`;
}

/** Decimal number with a comma and no float noise, e.g. 7.5 -> "7,5". */
export function formatDecimal(n: number): string {
  return String(Math.round(n * 1e6) / 1e6).replace(".", ",");
}

/**
 * Exact decimal form of a number value with a comma, never rounded and never in exponent form
 * (1e-7 -> "0,0000001"), for showing a submitted or correct numeric answer.
 */
export function formatExact(n: number): string {
  const plain = String(n);
  const text = /e/i.test(plain)
    ? n.toLocaleString("en-US", { maximumSignificantDigits: 17, useGrouping: false })
    : plain;
  return text.replace(".", ",");
}

/** Date and time of an ISO timestamp in local time, e.g. "31. 10. 2026. 14:05". */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatDate(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "1 otvoreno pitanje čeka ocenjivanje" / "2 otvorena pitanja čekaju ocenjivanje" / "5 otvorenih pitanja čeka ocenjivanje". */
export function openAwaitingGrading(n: number): string {
  const form = pluralForm(n);
  if (form === 1) return `${n} otvoreno pitanje čeka ocenjivanje`;
  if (form === 2) return `${n} otvorena pitanja čekaju ocenjivanje`;
  return `${n} otvorenih pitanja čeka ocenjivanje`;
}
