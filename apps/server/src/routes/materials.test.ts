import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorBody,
  ClassDetail,
  ClassSummary,
  CourseDetail,
  CourseSummary,
  MaterialDetail,
  MaterialSummary,
} from "@studdy/shared";
import { classTable, material } from "../db/schema.js";
import { extractText } from "../extraction/index.js";
import { saveFile } from "../files/store.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { registerErrorHandler } from "./errors.js";
import { materialRoutes } from "./materials.js";

// Wrapped so single tests can slow extraction down or make saving fail; they call the real thing otherwise.
vi.mock("../extraction/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extraction/index.js")>();
  return { ...actual, extractText: vi.fn(actual.extractText) };
});
vi.mock("../files/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../files/store.js")>();
  return { ...actual, saveFile: vi.fn(actual.saveFile) };
});

interface UploadFile {
  name: string;
  content: Buffer | string;
  field?: string;
}

async function makePdf(...lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  lines.forEach((line, index) =>
    page.drawText(line, { x: 60, y: 700 - index * 30, size: 16, font }),
  );
  return Buffer.from(await doc.save());
}

/** Serializes a multipart/form-data body the way a browser would. */
async function multipart(files: UploadFile[]) {
  const form = new FormData();
  for (const file of files) {
    form.append(
      file.field ?? "files",
      new Blob([typeof file.content === "string" ? file.content : new Uint8Array(file.content)]),
      file.name,
    );
  }
  const response = new Response(form);
  return {
    payload: Buffer.from(await response.arrayBuffer()),
    headers: { "content-type": response.headers.get("content-type") ?? "" },
  };
}

describe("materials API", () => {
  let t: TestApp;

  beforeEach(() => {
    t = createTestApp();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  const json = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    t.app.inject({ method, url, ...(payload ? { payload } : {}) });

  async function createCourse(name = "Databases") {
    const res = await json("POST", "/api/courses", { name });
    return CourseSummary.parse(res.json());
  }

  async function createClass(courseId: number, title = "Intro") {
    const res = await json("POST", `/api/courses/${courseId}/classes`, { title });
    return ClassSummary.parse(res.json());
  }

  async function upload(classId: number, files: UploadFile[]) {
    return t.app.inject({
      method: "POST",
      url: `/api/classes/${classId}/materials`,
      ...(await multipart(files)),
    });
  }

  async function uploadOk(classId: number, files: UploadFile[]) {
    const res = await upload(classId, files);
    expect(res.statusCode).toBe(201);
    return MaterialSummary.array().parse(res.json());
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

  const filesOnDisk = (): string[] => {
    const root = path.join(t.dir, "files");
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  };

  describe("uploading", () => {
    it("accepts a PDF, an HTML page and Markdown notes in one request", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const created = await uploadOk(cls.id, [
        { name: "slajdovi.pdf", content: await makePdf("Prvi slajd", "Druga linija") },
        { name: "strana.html", content: "<html><body><h1>Naslov</h1><p>Tekst</p></body></html>" },
        { name: "beleške.md", content: "# Beleške\r\n~~prekrižano~~\r\n" },
      ]);

      expect(created).toHaveLength(3);
      const byName = Object.fromEntries(created.map((m) => [m.originalName, m]));
      expect(byName["slajdovi.pdf"]).toMatchObject({
        classId: cls.id,
        kind: "material",
        mime: "application/pdf",
        extractionStatus: "ok",
        extractionError: null,
        pageCount: 1,
      });
      expect(byName["strana.html"]).toMatchObject({
        kind: "material",
        mime: "text/html",
        pageCount: null,
        extractionStatus: "ok",
      });
      expect(byName["beleške.md"]).toMatchObject({ kind: "note", mime: "text/markdown" });
      expect(byName["beleške.md"]?.sizeBytes).toBe(
        Buffer.byteLength("# Beleške\r\n~~prekrižano~~\r\n"),
      );
      expect(filesOnDisk()).toHaveLength(3);
    });

    it("lists materials first, then notes, each by name, and includes them in the class detail", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      await uploadOk(cls.id, [
        { name: "b-note.md", content: "b" },
        { name: "z-page.html", content: "<p>z</p>" },
        { name: "a-note.md", content: "a" },
        { name: "m-page.htm", content: "<p>m</p>" },
      ]);

      const list = MaterialSummary.array().parse(
        (await json("GET", `/api/classes/${cls.id}/materials`)).json(),
      );
      expect(list.map((m) => m.originalName)).toEqual([
        "m-page.htm",
        "z-page.html",
        "a-note.md",
        "b-note.md",
      ]);

      const detail = ClassDetail.parse((await json("GET", `/api/classes/${cls.id}`)).json());
      expect(detail.materials).toEqual(list);
    });

    it("reports material and note counts on the class and in the course's class list", async () => {
      const course = await createCourse();
      const first = await createClass(course.id, "Prvo");
      const second = await createClass(course.id, "Drugo");
      expect(first).toMatchObject({ materialCount: 0, noteCount: 0 });
      const created = await uploadOk(first.id, [
        { name: "a.pdf", content: await makePdf("A") },
        { name: "b.html", content: "<p>B</p>" },
        { name: "n.md", content: "# N" },
      ]);

      const detail = ClassDetail.parse((await json("GET", `/api/classes/${first.id}`)).json());
      expect(detail).toMatchObject({ materialCount: 2, noteCount: 1 });

      const courseDetail = CourseDetail.parse(
        (await json("GET", `/api/courses/${course.id}`)).json(),
      );
      expect(courseDetail.classes.map((c) => [c.id, c.materialCount, c.noteCount])).toEqual([
        [first.id, 2, 1],
        [second.id, 0, 0],
      ]);

      const renamed = ClassSummary.parse(
        (
          await t.app.inject({
            method: "PATCH",
            url: `/api/classes/${first.id}`,
            payload: { title: "Preimenovano" },
          })
        ).json(),
      );
      expect(renamed).toMatchObject({ materialCount: 2, noteCount: 1 });

      const note = created.find((m) => m.kind === "note");
      await json("DELETE", `/api/materials/${note?.id}`);
      const after = ClassDetail.parse((await json("GET", `/api/classes/${first.id}`)).json());
      expect(after).toMatchObject({ materialCount: 2, noteCount: 0 });
    });

    it("returns the extracted text in the material detail", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const [pdf, note] = [
        ...(await uploadOk(cls.id, [
          { name: "a.pdf", content: await makePdf("Docker kontejneri") },
          { name: "n.md", content: "~~staro~~ novo\r\n" },
        ])),
      ];
      const pdfDetail = MaterialDetail.parse(
        (await json("GET", `/api/materials/${pdf?.id}`)).json(),
      );
      expect(pdfDetail.extractedText).toBe("--- strana 1 ---\nDocker kontejneri");
      const noteDetail = MaterialDetail.parse(
        (await json("GET", `/api/materials/${note?.id}`)).json(),
      );
      expect(noteDetail.extractedText).toBe("~~staro~~ novo\n");
    });

    it("keeps non-ASCII file names intact", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const [created] = await uploadOk(cls.id, [
        { name: "Predavanje čćšžđ - 01.md", content: "x" },
      ]);
      expect(created?.originalName).toBe("Predavanje čćšžđ - 01.md");
    });

    it("stores a file whose extraction fails and lists it with the error", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const [created] = await uploadOk(cls.id, [
        { name: "broken.pdf", content: "%PDF-1.4\nthis is not a real pdf" },
      ]);
      expect(created).toMatchObject({ extractionStatus: "failed", pageCount: null });
      expect(created?.extractionError).toBeTruthy();
      const detail = MaterialDetail.parse(
        (await json("GET", `/api/materials/${created?.id}`)).json(),
      );
      expect(detail.extractedText).toBeNull();

      expect((await json("DELETE", `/api/materials/${created?.id}`)).statusCode).toBe(204);
    });

    it("rejects an unsupported extension with 415 and stores nothing", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const res = await upload(cls.id, [
        { name: "ok.md", content: "fine" },
        { name: "photo.png", content: "png" },
      ]);
      expectError(res, 415, "validation");
      expect(t.handle.db.select().from(material).all()).toHaveLength(0);
      expect(filesOnDisk()).toHaveLength(0);
    });

    it("rejects a PDF without the %PDF- magic with 400", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      expectError(
        await upload(cls.id, [{ name: "fake.pdf", content: "<html>not a pdf</html>" }]),
        400,
        "validation",
      );
    });

    it("rejects text that is not valid UTF-8 with 400", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const latin1 = Buffer.from([0x70, 0x72, 0xe8, 0x73, 0x74]); // "prèst" in Latin-1
      expectError(await upload(cls.id, [{ name: "n.md", content: latin1 }]), 400, "validation");
      expectError(await upload(cls.id, [{ name: "p.html", content: latin1 }]), 400, "validation");
    });

    it("rejects an empty file, a missing file and a wrongly named field with 400", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      expectError(await upload(cls.id, [{ name: "empty.md", content: "" }]), 400, "validation");
      expectError(await upload(cls.id, []), 400, "validation");
      expectError(
        await upload(cls.id, [{ name: "n.md", content: "x", field: "other" }]),
        400,
        "validation",
      );
      expectError(
        await t.app.inject({
          method: "POST",
          url: `/api/classes/${cls.id}/materials`,
          payload: {},
        }),
        400,
        "validation",
      );
    });

    it("rejects more than 10 files in one request", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const files = Array.from({ length: 11 }, (_, i) => ({
        name: `n${i}.md`,
        content: `note ${i}`,
      }));
      const res = await upload(cls.id, files);
      expect(res.statusCode).toBe(413);
      ApiErrorBody.parse(res.json());
      expect(t.handle.db.select().from(material).all()).toHaveLength(0);
    });

    it("rejects an upload whose files together exceed the request cap with 413", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const small = Fastify();
      registerErrorHandler(small);
      await small.register(materialRoutes, {
        db: t.handle.db,
        dataDir: t.dir,
        maxUploadBytes: 100,
      });
      const send = async (files: UploadFile[]) =>
        small.inject({
          method: "POST",
          url: `/api/classes/${cls.id}/materials`,
          ...(await multipart(files)),
        });

      const tooBig = await send([
        { name: "a.md", content: "a".repeat(60) },
        { name: "b.md", content: "b".repeat(60) },
      ]);
      expectError(tooBig, 413, "validation");
      expect(tooBig.json().error.message).toMatch(/in total/);
      expect(t.handle.db.select().from(material).all()).toHaveLength(0);
      expect(filesOnDisk()).toHaveLength(0);

      const fits = await send([
        { name: "a.md", content: "a".repeat(40) },
        { name: "b.md", content: "b".repeat(40) },
      ]);
      expect(fits.statusCode).toBe(201);
      await small.close();
    });

    it("keeps a shared file that another class deletes while this upload is extracting", async () => {
      const course = await createCourse();
      const one = await createClass(course.id, "One");
      const two = await createClass(course.id, "Two");
      const [inOne] = await uploadOk(one.id, [{ name: "a.md", content: "shared" }]);

      vi.mocked(extractText).mockImplementationOnce(async (...args) => {
        // The last committed reference goes away while the upload has saved but not inserted.
        expect((await json("DELETE", `/api/materials/${inOne?.id}`)).statusCode).toBe(204);
        expect(filesOnDisk()).toHaveLength(1);
        return (
          await vi.importActual<typeof import("../extraction/index.js")>("../extraction/index.js")
        ).extractText(...args);
      });
      const [inTwo] = await uploadOk(two.id, [{ name: "a.md", content: "shared" }]);

      expect(filesOnDisk()).toHaveLength(1);
      const file = await json("GET", `/api/materials/${inTwo?.id}/file`);
      expect(file.statusCode).toBe(200);
      expect(file.body).toBe("shared");
    });

    it("removes only the files it saved when saving fails part-way through a batch", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const actual = await vi.importActual<typeof import("../files/store.js")>("../files/store.js");
      vi.mocked(saveFile)
        .mockImplementationOnce((...args) => actual.saveFile(...args))
        .mockImplementationOnce(() => {
          throw new Error("disk full");
        });

      const res = await upload(cls.id, [
        { name: "one.md", content: "first" },
        { name: "two.md", content: "second" },
      ]);
      expectError(res, 500, "internal");
      expect(filesOnDisk()).toHaveLength(0);
      expect(t.handle.db.select().from(material).all()).toHaveLength(0);
    });

    it("leaves a file it did not save alone when the batch fails", async () => {
      const course = await createCourse();
      const one = await createClass(course.id, "One");
      const two = await createClass(course.id, "Two");
      await uploadOk(one.id, [{ name: "a.md", content: "kept" }]);
      const actual = await vi.importActual<typeof import("../files/store.js")>("../files/store.js");
      vi.mocked(saveFile)
        .mockImplementationOnce((...args) => actual.saveFile(...args))
        .mockImplementationOnce(() => {
          throw new Error("disk full");
        });

      const res = await upload(two.id, [
        { name: "a.md", content: "kept" },
        { name: "b.md", content: "other" },
      ]);
      expectError(res, 500, "internal");
      expect(filesOnDisk()).toHaveLength(1);
    });

    it("rejects a duplicate in the same class with 409 and writes no rows", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      await uploadOk(cls.id, [{ name: "a.md", content: "same bytes" }]);

      // Same content under another name, plus a new file: the whole request fails.
      const res = await upload(cls.id, [
        { name: "new.md", content: "brand new" },
        { name: "copy.md", content: "same bytes" },
      ]);
      expectError(res, 409, "conflict");
      expect(t.handle.db.select().from(material).all()).toHaveLength(1);
      expect(filesOnDisk()).toHaveLength(1);
    });

    it("rejects the same file twice within one request with 409", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const res = await upload(cls.id, [
        { name: "a.md", content: "twin" },
        { name: "b.md", content: "twin" },
      ]);
      expectError(res, 409, "conflict");
      expect(t.handle.db.select().from(material).all()).toHaveLength(0);
      expect(filesOnDisk()).toHaveLength(0);
    });

    it("allows the same file in different classes", async () => {
      const course = await createCourse();
      const one = await createClass(course.id, "One");
      const two = await createClass(course.id, "Two");
      await uploadOk(one.id, [{ name: "a.md", content: "shared" }]);
      await uploadOk(two.id, [{ name: "a.md", content: "shared" }]);
      expect(filesOnDisk()).toHaveLength(1);
    });

    it("returns 404 for an unknown class and 400 for a bad id", async () => {
      expectError(await upload(999, [{ name: "a.md", content: "x" }]), 404, "not_found");
      expectError(
        await upload("abc" as unknown as number, [{ name: "a.md", content: "x" }]),
        400,
        "validation",
      );
      expectError(await json("GET", "/api/classes/999/materials"), 404, "not_found");
    });

    it("rejects uploads, and deletes, once the class is no longer a draft", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const [created] = await uploadOk(cls.id, [{ name: "a.md", content: "x" }]);
      t.handle.db
        .update(classTable)
        .set({ status: "generating" })
        .where(eq(classTable.id, cls.id))
        .run();

      const res = await upload(cls.id, [{ name: "b.md", content: "y" }]);
      const body = expectError(res, 409, "conflict");
      expect(body.error.message).toBe("Class materials can't be changed after generation");
      const del = await json("DELETE", `/api/materials/${created?.id}`);
      expectError(del, 409, "conflict");
      expect(t.handle.db.select().from(material).all()).toHaveLength(1);
      expect(filesOnDisk()).toHaveLength(1);
    });
  });

  describe("serving files", () => {
    it("returns the stored bytes with the stored mime and a download-safe disposition", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const pdf = await makePdf("Slajd");
      const [created] = await uploadOk(cls.id, [{ name: "Slajdovi (1) čćš.pdf", content: pdf }]);

      const res = await json("GET", `/api/materials/${created?.id}/file`);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(pdf)).toBe(true);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toBe(
        "inline; filename*=UTF-8''Slajdovi%20%281%29%20%C4%8D%C4%87%C5%A1.pdf",
      );
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBeUndefined();
    });

    it("adds a sandboxing CSP for HTML", async () => {
      const course = await createCourse();
      const cls = await createClass(course.id);
      const html = "<html><body><script>alert(1)</script><p>hi</p></body></html>";
      const [created] = await uploadOk(cls.id, [{ name: "page.html", content: html }]);

      const res = await json("GET", `/api/materials/${created?.id}/file`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(html);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["content-security-policy"]).toBe(
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      );
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      // The extracted text never contains the script.
      const detail = MaterialDetail.parse(
        (await json("GET", `/api/materials/${created?.id}`)).json(),
      );
      expect(detail.extractedText).toBe("hi");
    });

    it("returns 404 for an unknown material and for a file missing from disk", async () => {
      expectError(await json("GET", "/api/materials/999"), 404, "not_found");
      expectError(await json("GET", "/api/materials/999/file"), 404, "not_found");

      const course = await createCourse();
      const cls = await createClass(course.id);
      const [created] = await uploadOk(cls.id, [{ name: "a.md", content: "x" }]);
      fs.rmSync(path.join(t.dir, "files"), { recursive: true });
      expectError(await json("GET", `/api/materials/${created?.id}/file`), 404, "not_found");
    });
  });

  describe("deleting", () => {
    it("removes the row and the file, but keeps a file another class still uses", async () => {
      const course = await createCourse();
      const one = await createClass(course.id, "One");
      const two = await createClass(course.id, "Two");
      const [inOne] = await uploadOk(one.id, [{ name: "a.md", content: "shared" }]);
      const [inTwo] = await uploadOk(two.id, [{ name: "a.md", content: "shared" }]);

      expect((await json("DELETE", `/api/materials/${inOne?.id}`)).statusCode).toBe(204);
      expectError(await json("GET", `/api/materials/${inOne?.id}`), 404, "not_found");
      expect(filesOnDisk()).toHaveLength(1);
      expect((await json("GET", `/api/materials/${inTwo?.id}/file`)).statusCode).toBe(200);

      expect((await json("DELETE", `/api/materials/${inTwo?.id}`)).statusCode).toBe(204);
      expect(filesOnDisk()).toHaveLength(0);
      expectError(await json("DELETE", `/api/materials/${inTwo?.id}`), 404, "not_found");
    });

    it("removes unreferenced files when a class is deleted, keeping shared ones", async () => {
      const course = await createCourse();
      const one = await createClass(course.id, "One");
      const two = await createClass(course.id, "Two");
      await uploadOk(one.id, [
        { name: "shared.md", content: "shared" },
        { name: "only-one.md", content: "only one" },
      ]);
      await uploadOk(two.id, [{ name: "shared.md", content: "shared" }]);
      expect(filesOnDisk()).toHaveLength(2);

      expect((await json("DELETE", `/api/classes/${one.id}`)).statusCode).toBe(204);
      expect(filesOnDisk()).toHaveLength(1);
      expect(t.handle.db.select().from(material).all()).toHaveLength(1);

      expect((await json("DELETE", `/api/classes/${two.id}`)).statusCode).toBe(204);
      expect(filesOnDisk()).toHaveLength(0);
    });

    it("removes the files of every class when a course is deleted", async () => {
      const course = await createCourse();
      const other = await createCourse("Other");
      const one = await createClass(course.id, "One");
      const two = await createClass(course.id, "Two");
      const elsewhere = await createClass(other.id, "Elsewhere");
      await uploadOk(one.id, [{ name: "a.md", content: "a" }]);
      await uploadOk(two.id, [
        { name: "a.md", content: "a" },
        { name: "b.html", content: "<p>b</p>" },
      ]);
      await uploadOk(elsewhere.id, [{ name: "kept.md", content: "kept" }]);
      expect(filesOnDisk()).toHaveLength(3);

      expect((await json("DELETE", `/api/courses/${course.id}`)).statusCode).toBe(204);
      expect(filesOnDisk()).toEqual([expect.stringMatching(/\.md$/)]);
      expect(t.handle.db.select().from(material).all()).toHaveLength(1);
    });
  });

  it("returns an ApiErrorBody 404 for unknown /api routes", async () => {
    expectError(await json("GET", "/api/nope"), 404, "not_found");
  });
});
