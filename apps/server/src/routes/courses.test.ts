import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiErrorBody,
  ClassDetail,
  ClassSummary,
  CourseDetail,
  CourseSummary,
} from "@studdy/shared";
import { createTestApp, type TestApp } from "../test/app.js";

describe("courses and classes API", () => {
  let t: TestApp;

  beforeEach(() => {
    t = createTestApp();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  const request = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    t.app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });

  async function createCourse(body: object = { name: "Databases" }) {
    const res = await request("POST", "/api/courses", body);
    expect(res.statusCode).toBe(201);
    return CourseSummary.parse(res.json());
  }

  async function createClass(courseId: number, body: object = { title: "Intro" }) {
    const res = await request("POST", `/api/courses/${courseId}/classes`, body);
    expect(res.statusCode).toBe(201);
    return ClassSummary.parse(res.json());
  }

  function expectError(
    res: { statusCode: number; json: () => unknown },
    status: number,
    code: string,
  ) {
    expect(res.statusCode).toBe(status);
    const body = ApiErrorBody.parse(res.json());
    expect(body.error.code).toBe(code);
    return body;
  }

  describe("courses", () => {
    it("creates a course with defaults and trims fields", async () => {
      const course = await createCourse({ name: "  Databases ", persona: "  " });
      expect(course).toMatchObject({
        name: "Databases",
        persona: null,
        assessmentFormat: null,
        reviewCadence: null,
        classCount: 0,
      });
      expect(new Date(course.createdAt).toISOString()).toBe(course.createdAt);
    });

    it("stores the optional fields", async () => {
      const course = await createCourse({
        name: "Databases",
        persona: "experienced data engineer",
        assessmentFormat: "written exam, 10 questions",
        reviewCadence: 4,
      });
      expect(course).toMatchObject({
        persona: "experienced data engineer",
        assessmentFormat: "written exam, 10 questions",
        reviewCadence: 4,
      });
    });

    it("lists courses newest first with class counts", async () => {
      const first = await createCourse({ name: "First" });
      const second = await createCourse({ name: "Second" });
      await createClass(first.id);
      await createClass(first.id, { title: "Second class" });

      const res = await request("GET", "/api/courses");
      expect(res.statusCode).toBe(200);
      const list = CourseSummary.array().parse(res.json());
      expect(list.map((c) => [c.name, c.classCount])).toEqual([
        ["Second", 0],
        ["First", 2],
      ]);
      expect(list[0]?.id).toBe(second.id);
    });

    it("returns an empty list when there are no courses", async () => {
      const res = await request("GET", "/api/courses");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("gets a course with its classes ordered by number", async () => {
      const course = await createCourse();
      await createClass(course.id, { title: "Third", number: 3 });
      await createClass(course.id, { title: "First", number: 1 });

      const res = await request("GET", `/api/courses/${course.id}`);
      expect(res.statusCode).toBe(200);
      const detail = CourseDetail.parse(res.json());
      expect(detail.classCount).toBe(2);
      expect(detail.classes.map((c) => [c.number, c.title, c.status])).toEqual([
        [1, "First", "draft"],
        [3, "Third", "draft"],
      ]);
    });

    it("updates some fields, keeps the others and can clear optional ones", async () => {
      const course = await createCourse({ name: "Old", persona: "tutor", reviewCadence: 3 });
      await createClass(course.id);

      const res = await request("PATCH", `/api/courses/${course.id}`, {
        name: " New ",
        persona: null,
      });
      expect(res.statusCode).toBe(200);
      expect(CourseSummary.parse(res.json())).toMatchObject({
        id: course.id,
        name: "New",
        persona: null,
        reviewCadence: 3,
        classCount: 1,
      });
    });

    it("deletes a course", async () => {
      const course = await createCourse();
      const res = await request("DELETE", `/api/courses/${course.id}`);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expectError(await request("GET", `/api/courses/${course.id}`), 404, "not_found");
    });

    it("deleting a course cascades to its classes", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      expect((await request("DELETE", `/api/courses/${course.id}`)).statusCode).toBe(204);
      expectError(await request("GET", `/api/classes/${cls.id}`), 404, "not_found");
    });

    it("rejects invalid bodies with the error shape", async () => {
      const cases: object[] = [
        { name: "" },
        { name: "   " },
        { name: "A", reviewCadence: 0 },
        { name: "A", reviewCadence: 51 },
        { name: "A", unknown: true },
        {},
      ];
      for (const body of cases) {
        const res = await request("POST", "/api/courses", body);
        const err = expectError(res, 400, "validation");
        expect(Array.isArray(err.error.details)).toBe(true);
      }
      expectError(await request("POST", "/api/courses"), 400, "validation");
      expect((await request("GET", "/api/courses")).json()).toEqual([]);
    });

    it("rejects an empty or unknown-key update", async () => {
      const course = await createCourse();
      expectError(await request("PATCH", `/api/courses/${course.id}`, {}), 400, "validation");
      expectError(
        await request("PATCH", `/api/courses/${course.id}`, { classCount: 5 }),
        400,
        "validation",
      );
    });
  });

  describe("classes", () => {
    it("defaults the number to max + 1", async () => {
      const course = await createCourse();
      const first = await createClass(course.id, { title: "One" });
      const second = await createClass(course.id, { title: "Two" });
      expect([first.number, second.number]).toEqual([1, 2]);
      expect(first).toMatchObject({ courseId: course.id, title: "One", status: "draft" });

      await createClass(course.id, { title: "Ten", number: 10 });
      expect((await createClass(course.id, { title: "Next" })).number).toBe(11);
    });

    it("numbers classes per course", async () => {
      const a = await createCourse({ name: "A" });
      const b = await createCourse({ name: "B" });
      await createClass(a.id);
      expect((await createClass(b.id)).number).toBe(1);
    });

    it("accepts an explicit number", async () => {
      const course = await createCourse();
      expect((await createClass(course.id, { title: "Five", number: 5 })).number).toBe(5);
    });

    it("returns 409 for a duplicate number", async () => {
      const course = await createCourse();
      await createClass(course.id, { title: "One", number: 1 });
      const res = await request("POST", `/api/courses/${course.id}/classes`, {
        title: "Again",
        number: 1,
      });
      expectError(res, 409, "conflict");
      expect(
        CourseDetail.parse((await request("GET", `/api/courses/${course.id}`)).json()).classCount,
      ).toBe(1);
    });

    it("returns 404 when creating a class in a missing course", async () => {
      const res = await request("POST", "/api/courses/999/classes", { title: "Intro" });
      expectError(res, 404, "not_found");
    });

    it("validates the class body", async () => {
      const course = await createCourse();
      for (const body of [
        { title: "" },
        { title: "A", number: 0 },
        { title: "A", number: 1000 },
        {},
      ]) {
        expectError(
          await request("POST", `/api/courses/${course.id}/classes`, body),
          400,
          "validation",
        );
      }
    });

    it("gets a class with the course name", async () => {
      const course = await createCourse({ name: "Databases" });
      const cls = await createClass(course.id);
      const res = await request("GET", `/api/classes/${cls.id}`);
      expect(res.statusCode).toBe(200);
      expect(ClassDetail.parse(res.json())).toEqual({ ...cls, courseName: "Databases" });
    });

    it("updates title and number", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const res = await request("PATCH", `/api/classes/${cls.id}`, {
        title: " Renamed ",
        number: 7,
      });
      expect(res.statusCode).toBe(200);
      expect(ClassSummary.parse(res.json())).toMatchObject({
        id: cls.id,
        title: "Renamed",
        number: 7,
      });

      const titleOnly = await request("PATCH", `/api/classes/${cls.id}`, { title: "Again" });
      expect(ClassSummary.parse(titleOnly.json())).toMatchObject({ title: "Again", number: 7 });
    });

    it("returns 409 when updating to a number that is taken, and keeps the class unchanged", async () => {
      const course = await createCourse();
      await createClass(course.id);
      const second = await createClass(course.id, { title: "Two" });
      expectError(
        await request("PATCH", `/api/classes/${second.id}`, { number: 1 }),
        409,
        "conflict",
      );
      expect(
        ClassDetail.parse((await request("GET", `/api/classes/${second.id}`)).json()).number,
      ).toBe(2);
    });

    it("allows updating a class to its own number", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const res = await request("PATCH", `/api/classes/${cls.id}`, {
        number: cls.number,
        title: "Same",
      });
      expect(res.statusCode).toBe(200);
    });

    it("deletes a class", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const res = await request("DELETE", `/api/classes/${cls.id}`);
      expect(res.statusCode).toBe(204);
      expectError(await request("GET", `/api/classes/${cls.id}`), 404, "not_found");
      expect(
        CourseDetail.parse((await request("GET", `/api/courses/${course.id}`)).json()).classCount,
      ).toBe(0);
    });
  });

  describe("ids and errors", () => {
    it("rejects non-positive-integer ids with 400", async () => {
      const urls: Array<[Parameters<typeof request>[0], string]> = [
        ["GET", "/api/courses/abc"],
        ["GET", "/api/courses/0"],
        ["GET", "/api/courses/-1"],
        ["GET", "/api/courses/1.5"],
        ["PATCH", "/api/courses/abc"],
        ["DELETE", "/api/courses/abc"],
        ["POST", "/api/courses/abc/classes"],
        ["GET", "/api/classes/abc"],
        ["GET", "/api/classes/0"],
        ["PATCH", "/api/classes/abc"],
        ["DELETE", "/api/classes/0"],
      ];
      for (const [method, url] of urls) {
        expectError(await request(method, url, { name: "A", title: "A" }), 400, "validation");
      }
    });

    it("returns 404 for ids that do not exist", async () => {
      const missing: Array<[Parameters<typeof request>[0], string, object?]> = [
        ["GET", "/api/courses/999"],
        ["PATCH", "/api/courses/999", { name: "X" }],
        ["DELETE", "/api/courses/999"],
        ["GET", "/api/classes/999"],
        ["PATCH", "/api/classes/999", { title: "X" }],
        ["DELETE", "/api/classes/999"],
      ];
      for (const [method, url, body] of missing) {
        expectError(await request(method, url, body), 404, "not_found");
      }
    });

    it("returns 400 for malformed JSON", async () => {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/courses",
        headers: { "content-type": "application/json" },
        payload: '{"name": ',
      });
      expectError(res, 400, "validation");
    });

    it("returns a generic 500 in the error shape for unexpected errors", async () => {
      t.handle.close();
      const res = await request("GET", "/api/courses");
      const err = expectError(res, 500, "internal");
      expect(err.error.message).toBe("Internal server error");
      expect(err.error.details).toBeUndefined();
    });
  });
});
