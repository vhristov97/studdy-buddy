import { describe, expect, it } from "vitest";
import {
  ApiErrorBody,
  CreateClassInput,
  CreateCourseInput,
  UpdateClassInput,
  UpdateCourseInput,
} from "./courses";

describe("CreateCourseInput", () => {
  it("trims the name and leaves optional fields undefined when absent", () => {
    expect(CreateCourseInput.parse({ name: "  Databases  " })).toEqual({ name: "Databases" });
  });

  it("rejects an empty or whitespace-only name and one over 200 characters", () => {
    expect(CreateCourseInput.safeParse({ name: "" }).success).toBe(false);
    expect(CreateCourseInput.safeParse({ name: "   " }).success).toBe(false);
    expect(CreateCourseInput.safeParse({ name: "x".repeat(200) }).success).toBe(true);
    expect(CreateCourseInput.safeParse({ name: "x".repeat(201) }).success).toBe(false);
  });

  it("trims persona and assessmentFormat and turns empty strings into null", () => {
    expect(
      CreateCourseInput.parse({ name: "A", persona: "  tutor  ", assessmentFormat: "   " }),
    ).toEqual({ name: "A", persona: "tutor", assessmentFormat: null });
    expect(CreateCourseInput.parse({ name: "A", persona: "" }).persona).toBeNull();
    expect(CreateCourseInput.parse({ name: "A", persona: null }).persona).toBeNull();
  });

  it("enforces the persona and assessmentFormat length limits", () => {
    expect(CreateCourseInput.safeParse({ name: "A", persona: "x".repeat(1000) }).success).toBe(
      true,
    );
    expect(CreateCourseInput.safeParse({ name: "A", persona: "x".repeat(1001) }).success).toBe(
      false,
    );
    expect(
      CreateCourseInput.safeParse({ name: "A", assessmentFormat: "x".repeat(4000) }).success,
    ).toBe(true);
    expect(
      CreateCourseInput.safeParse({ name: "A", assessmentFormat: "x".repeat(4001) }).success,
    ).toBe(false);
  });

  it("accepts a review cadence of 1..50 or null and rejects everything else", () => {
    for (const ok of [1, 50, null]) {
      expect(CreateCourseInput.safeParse({ name: "A", reviewCadence: ok }).success).toBe(true);
    }
    for (const bad of [0, 51, -1, 2.5, "3"]) {
      expect(CreateCourseInput.safeParse({ name: "A", reviewCadence: bad }).success).toBe(false);
    }
  });

  it("rejects unknown keys", () => {
    expect(CreateCourseInput.safeParse({ name: "A", color: "red" }).success).toBe(false);
  });
});

describe("UpdateCourseInput", () => {
  it("accepts any single field", () => {
    expect(UpdateCourseInput.parse({ name: " B " })).toEqual({ name: "B" });
    expect(UpdateCourseInput.parse({ persona: "" })).toEqual({ persona: null });
    expect(UpdateCourseInput.parse({ reviewCadence: null })).toEqual({ reviewCadence: null });
  });

  it("requires at least one field", () => {
    expect(UpdateCourseInput.safeParse({}).success).toBe(false);
    expect(UpdateCourseInput.safeParse({ name: undefined }).success).toBe(false);
  });

  it("still validates the fields that are present", () => {
    expect(UpdateCourseInput.safeParse({ name: "  " }).success).toBe(false);
    expect(UpdateCourseInput.safeParse({ reviewCadence: 0 }).success).toBe(false);
    expect(UpdateCourseInput.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe("CreateClassInput", () => {
  it("trims the title; the number is optional", () => {
    expect(CreateClassInput.parse({ title: "  Intro " })).toEqual({ title: "Intro" });
    expect(CreateClassInput.parse({ title: "Intro", number: 3 })).toEqual({
      title: "Intro",
      number: 3,
    });
  });

  it("rejects bad titles and numbers", () => {
    expect(CreateClassInput.safeParse({ title: "" }).success).toBe(false);
    expect(CreateClassInput.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    for (const bad of [0, 1000, -2, 1.5, "1"]) {
      expect(CreateClassInput.safeParse({ title: "A", number: bad }).success).toBe(false);
    }
    expect(CreateClassInput.safeParse({ title: "A", number: 999 }).success).toBe(true);
  });
});

describe("UpdateClassInput", () => {
  it("accepts title and/or number", () => {
    expect(UpdateClassInput.parse({ title: " T " })).toEqual({ title: "T" });
    expect(UpdateClassInput.parse({ number: 2 })).toEqual({ number: 2 });
    expect(UpdateClassInput.parse({ title: "T", number: 2 })).toEqual({ title: "T", number: 2 });
  });

  it("requires at least one field and validates present ones", () => {
    expect(UpdateClassInput.safeParse({}).success).toBe(false);
    expect(UpdateClassInput.safeParse({ title: "" }).success).toBe(false);
    expect(UpdateClassInput.safeParse({ number: 0 }).success).toBe(false);
  });
});

describe("ApiErrorBody", () => {
  it("accepts the documented shape", () => {
    expect(
      ApiErrorBody.safeParse({ error: { code: "validation", message: "bad", details: [] } })
        .success,
    ).toBe(true);
    expect(ApiErrorBody.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(false);
  });
});
