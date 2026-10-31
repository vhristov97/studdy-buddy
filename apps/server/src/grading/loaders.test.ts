import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDatabase, type DatabaseHandle } from "../db/client.js";
import {
  backlogItem,
  classTable,
  course,
  learnerObservation,
  nextStep,
  topic,
} from "../db/schema.js";
import { MAX_OBSERVATIONS, loadBacklog, loadNextSteps, loadObservations } from "./context.js";

let dir: string;
let handle: DatabaseHandle;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-loaders-test-"));
  handle = openDatabase(dir);
  migrate(handle.db);
});
afterAll(() => {
  handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("grading context loaders", () => {
  it("loads observations across courses, oldest first, capped to the newest", () => {
    const { db } = handle;
    expect(loadObservations(db)).toEqual([]);
    const a = db.insert(course).values({ name: "A" }).returning().get().id;
    const b = db.insert(course).values({ name: "B" }).returning().get().id;
    for (let i = 1; i <= MAX_OBSERVATIONS + 5; i++) {
      db.insert(learnerObservation)
        .values({ text: `o${i}`, courseId: i % 2 === 0 ? a : b })
        .run();
    }
    const loaded = loadObservations(db);
    expect(loaded).toHaveLength(MAX_OBSERVATIONS);
    expect(loaded[0]).toBe("o6");
    expect(loaded.at(-1)).toBe(`o${MAX_OBSERVATIONS + 5}`);
  });

  it("loads a course's unresolved backlog and ordered next steps only", () => {
    const { db } = handle;
    const a = db.insert(course).values({ name: "C" }).returning().get().id;
    const b = db.insert(course).values({ name: "D" }).returning().get().id;
    const topicIn = (courseId: number, name: string) => {
      const cls = db
        .insert(classTable)
        .values({ courseId, number: 1, title: "Čas" })
        .returning()
        .get().id;
      return db
        .insert(topic)
        .values({ courseId, classId: cls, position: 0, name })
        .returning()
        .get().id;
    };
    const open = topicIn(a, "Otvorena");
    const done = db
      .insert(topic)
      .values({
        courseId: a,
        classId: db
          .select()
          .from(topic)
          .all()
          .find((t) => t.id === open)!.classId,
        position: 1,
        name: "Rešena",
      })
      .returning()
      .get().id;
    const other = topicIn(b, "Tuđa");
    db.insert(backlogItem)
      .values([
        { courseId: a, topicId: open, dueQuiz: "K1", reason: "weak" },
        { courseId: a, topicId: done, dueQuiz: "K1", reason: "gap", resolvedAt: new Date() },
        { courseId: b, topicId: other, dueQuiz: "K2", reason: "left_out" },
      ])
      .run();
    expect(loadBacklog(db, a)).toEqual([{ topic: "Otvorena", dueQuiz: "K1", reason: "weak" }]);
    expect(loadBacklog(db, b)).toEqual([{ topic: "Tuđa", dueQuiz: "K2", reason: "left_out" }]);

    db.insert(nextStep)
      .values([
        { courseId: a, position: 1, text: "drugo" },
        { courseId: a, position: 0, text: "prvo" },
        { courseId: b, position: 0, text: "tuđe" },
      ])
      .run();
    expect(loadNextSteps(db, a)).toEqual(["prvo", "drugo"]);
    expect(loadNextSteps(db, b)).toEqual(["tuđe"]);
  });
});
