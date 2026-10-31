import { describe, expect, it } from "vitest";
import {
  cadenceLabel,
  countClasses,
  countMaterials,
  countNotes,
  countPages,
  countQuestions,
  formatBytes,
  formatCount,
  formatDate,
  formatDuration,
  plural,
  pluralForm,
} from "./format";

describe("formatBytes", () => {
  it("formats with a decimal comma", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(1_572_864)).toBe("1,5 MB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
  });
});

describe("plural", () => {
  const forms = (n: number) => plural(n, "jedan", "malo", "mnogo");
  it("picks Serbian forms", () => {
    expect([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101].map(forms)).toEqual([
      "mnogo",
      "jedan",
      "malo",
      "malo",
      "mnogo",
      "mnogo",
      "mnogo",
      "mnogo",
      "jedan",
      "malo",
      "mnogo",
      "jedan",
    ]);
  });
});

describe("pluralForm", () => {
  it("follows the Serbian rule", () => {
    const forms = (ns: number[]) => ns.map(pluralForm);
    expect(forms([1, 21, 31, 101, 1001])).toEqual([1, 1, 1, 1, 1]);
    expect(forms([2, 3, 4, 22, 23, 24, 102])).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(forms([0, 5, 9, 10, 11, 12, 13, 14, 15, 20, 25, 111, 112])).toEqual(Array(13).fill(3));
  });
});

describe("counted nouns", () => {
  it("agrees with the number", () => {
    expect([1, 2, 5, 11, 21].map(countClasses)).toEqual([
      "1 predavanje",
      "2 predavanja",
      "5 predavanja",
      "11 predavanja",
      "21 predavanje",
    ]);
    expect([1, 2, 5].map(countMaterials)).toEqual(["1 materijal", "2 materijala", "5 materijala"]);
    expect([0, 1, 2, 5, 12].map(countNotes)).toEqual([
      "0 beležaka",
      "1 beleška",
      "2 beleške",
      "5 beležaka",
      "12 beležaka",
    ]);
    expect([1, 2, 5].map(countPages)).toEqual(["1 strana", "2 strane", "5 strana"]);
  });
});

describe("cadenceLabel", () => {
  it("agrees with the number", () => {
    expect([1, 2, 4, 5, 11, 12, 21, 50].map(cadenceLabel)).toEqual([
      "na svako predavanje",
      "na svaka 2 predavanja",
      "na svaka 4 predavanja",
      "na svakih 5 predavanja",
      "na svakih 11 predavanja",
      "na svakih 12 predavanja",
      "na svako 21 predavanje",
      "na svakih 50 predavanja",
    ]);
  });
});

describe("formatCount", () => {
  it("groups thousands with dots", () => {
    expect([0, 999, 1000, 12400, 1234567].map(formatCount)).toEqual([
      "0",
      "999",
      "1.000",
      "12.400",
      "1.234.567",
    ]);
  });
});

describe("formatDuration", () => {
  it("shows seconds, then minutes with padded seconds", () => {
    expect([0, 999, 42_000, 60_000, 185_000, -5].map(formatDuration)).toEqual([
      "0 s",
      "0 s",
      "42 s",
      "1 min 00 s",
      "3 min 05 s",
      "0 s",
    ]);
  });
});

describe("countQuestions", () => {
  it("declines pitanje/pitanja", () => {
    expect(countQuestions(1)).toBe("1 pitanje");
    expect(countQuestions(8)).toBe("8 pitanja");
    expect(countQuestions(20)).toBe("20 pitanja");
  });
});

describe("formatDate", () => {
  it("formats day, month and year without padding", () => {
    expect(formatDate("2026-03-05T12:00:00.000Z")).toBe("5. 3. 2026.");
  });
});
