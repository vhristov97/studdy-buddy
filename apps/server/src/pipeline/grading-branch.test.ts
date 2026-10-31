import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SemanticEvent } from "@mozaik-ai/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  CourseProgress,
  SubmissionDetail,
  scoreQuiz,
  type GradingResult,
  type PipelineEvent,
} from "@studdy/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { gradeSubmission } from "../agents/grader.js";
import { initAgentRuntime } from "../agents/runtime.js";
import { StageError } from "../agents/stage.js";
import { FakeRunner } from "../agents/testing/fake-runner.js";
import { answersFixture, gradingResultFixture } from "../agents/testing/grading-fixtures.js";
import { MISCONCEPTION, planFixture, quizFixture } from "../agents/testing/quiz-fixtures.js";
import {
  backlogItem,
  classTable,
  course,
  generationJob,
  learnerObservation,
  lesson,
  material,
  nextStep,
  quiz,
  quizPlan,
  result,
  submission,
  topic,
  topicEvent,
} from "../db/schema.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { DOMAIN_EVENTS, type GradingDonePayload } from "./events.js";

type Grade = typeof gradeSubmission;

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let tmpCwd: string;
beforeAll(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-grading-branch-test-"));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new FakeRunner(() => new Error("not used")),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("grading branch", () => {
  let t: TestApp;
  let events: SemanticEvent[];
  let grade: ReturnType<typeof vi.fn<Grade>>;
  let courseId: number;
  let class1: number;
  let class2: number;
  let quizId: number;
  let submissionId: number;
  let autoStart = true;

  const db = () => t.handle.db;
  const jobs = () =>
    db().select().from(generationJob).where(eq(generationJob.kind, "grading")).all();
  const finished = (n = 1) => jobs().length >= n && jobs().every((j) => j.status !== "running");
  const types = () => events.map((e) => e.type);
  const topicId = (name: string, classId: number) =>
    db()
      .select()
      .from(topic)
      .where(and(eq(topic.name, name), eq(topic.classId, classId)))
      .get()!.id;
  const eventsOf = (name: string, classId: number, source?: "notes" | "quiz" | "grading") =>
    db()
      .select()
      .from(topicEvent)
      .where(eq(topicEvent.topicId, topicId(name, classId)))
      .orderBy(asc(topicEvent.id))
      .all()
      .filter((e) => source === undefined || e.source === source);
  const unresolved = () =>
    db().select().from(backlogItem).where(isNull(backlogItem.resolvedAt)).all();

  function newSubmission(forQuiz = quizId): number {
    const full = quizFixture();
    const answers = answersFixture();
    const score = scoreQuiz(full, answers);
    return db()
      .insert(submission)
      .values({
        quizId: forQuiz,
        answersJson: answers,
        autoScore: score.autoScore,
        autoMax: score.autoMax,
        dontKnowJson: score.dontKnow,
        resultsJson: score.results,
        openPending: score.openPending,
      })
      .returning({ id: submission.id })
      .get().id;
  }

  function submit(id = submissionId, forQuiz = quizId): void {
    t.coordinator!.emit(DOMAIN_EVENTS.SUBMISSION_CREATED, { quizId: forQuiz, submissionId: id });
  }

  function mutated(fn: (r: GradingResult) => void): GradingResult {
    const r = gradingResultFixture();
    fn(r);
    return r;
  }

  beforeEach(() => {
    grade = vi.fn<Grade>(async () => gradingResultFixture());
    t = createTestApp({ pipeline: { gradeSubmission: grade, gradingAutoStart: autoStart } });
    events = [];
    t.coordinator!.subscribe((e) => events.push(e));

    courseId = db()
      .insert(course)
      .values({ name: "Kurs", reviewCadence: 4 })
      .returning({ id: course.id })
      .get().id;
    const addClass = (number: number, title: string, status: "draft" | "ready" = "ready") =>
      db()
        .insert(classTable)
        .values({ courseId, number, title, status })
        .returning({ id: classTable.id })
        .get().id;
    class1 = addClass(1, "Skladišta");
    class2 = addClass(2, "Obrada podataka");
    for (const id of [class1, class2]) {
      db().insert(lesson).values({ classId: id, bodyMd: "Lekcija." }).run();
    }
    const addTopic = (classId: number, position: number, name: string) =>
      db()
        .insert(topic)
        .values({ courseId, classId, position, name, rating: "?" })
        .returning({ id: topic.id })
        .get().id;
    addTopic(class1, 0, "Skladišta podataka");
    const batch = addTopic(class2, 0, "Batch obrada");
    addTopic(class2, 1, "Stream obrada");
    addTopic(class2, 2, "Lambda arhitektura");
    db()
      .insert(topicEvent)
      .values({
        topicId: batch,
        source: "notes",
        outcome: "misconception",
        misconceptionText: MISCONCEPTION,
        correctionText: "Batch optimizuje propusnost.",
      })
      .run();

    const q = quizFixture();
    quizId = db()
      .insert(quiz)
      .values({
        courseId,
        classId: class2,
        code: q.code,
        title: q.title,
        subtitle: q.subtitle,
        chipsJson: q.chips,
        questionsJson: q.questions,
      })
      .returning({ id: quiz.id })
      .get().id;
    const quizJob = db()
      .insert(generationJob)
      .values({
        classId: class2,
        kind: "quiz",
        stage: "quiz-planner",
        status: "succeeded",
        attempt: 1,
      })
      .returning({ id: generationJob.id })
      .get().id;
    db()
      .insert(quizPlan)
      .values({ jobId: quizJob, classId: class2, planJson: planFixture(), logJson: [], quizId })
      .run();
    submissionId = newSubmission();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("persists the whole grading in one go", async () => {
    submit();
    await waitFor(() => types().includes(DOMAIN_EVENTS.GRADING_DONE));

    const [job] = jobs();
    expect(job).toMatchObject({
      kind: "grading",
      stage: "grader",
      status: "succeeded",
      attempt: 1,
      error: null,
      classId: class2,
      submissionId,
      parentJobId: null,
    });
    expect(job!.finishedAt).not.toBeNull();

    // The result row.
    const [row] = db().select().from(result).all();
    const sub = db().select().from(submission).where(eq(submission.id, submissionId)).get()!;
    expect(row).toMatchObject({ submissionId, jobId: job!.id, openScore: 0.4 });
    expect(row!.totalScore).toBeCloseTo(sub.autoScore + 0.4, 6);
    expect(row!.writeupMd).toBe(gradingResultFixture().writeupMd);
    expect(row!.resultJson).toEqual(gradingResultFixture());
    expect(events.at(-1)!.payload as GradingDonePayload).toEqual({
      submissionId,
      resultId: row!.id,
    });

    // Per-question events, on each question's topic.
    const quizEvents = (name: string, classId: number) =>
      eventsOf(name, classId, "quiz").map((e) => [e.ref, e.outcome]);
    expect(quizEvents("Batch obrada", class2)).toEqual([
      ["P02·q1", "correct"],
      ["P02·q4", "wrong"],
      ["P02·q7", "open:0.4"],
    ]);
    expect(quizEvents("Stream obrada", class2)).toEqual([
      ["P02·q2", "wrong"],
      ["P02·q3", "dont_know"],
      ["P02·q5", "partial"],
      ["P02·q8", "dont_know"],
    ]);
    expect(quizEvents("Skladišta podataka", class1)).toEqual([["P02·q6", "unanswered"]]);

    // Items, with match rows 1-based.
    const stream = eventsOf("Stream obrada", class2, "grading").filter((e) =>
      e.ref?.startsWith("P02·q"),
    );
    expect(stream.map((e) => [e.ref, e.outcome, e.misconceptionText])).toEqual([
      ["P02·q2", "misconception", "Stream čeka da se skupi ceo skup podataka."],
      ["P02·q3", "gap", null],
      ["P02·q5.r2", "gap", null],
      ["P02·q5.r3", "misconception", "HDFS je log događaja."],
      ["P02·q8", "gap", null],
    ]);
    expect(stream[1]!.correctionText).toBe("Stream obrađuje događaje jedan po jedan.");

    // Fixed notes misconception, rating events and ratings.
    const batchGrading = eventsOf("Batch obrada", class2, "grading");
    expect(batchGrading.find((e) => e.outcome === "fixed")).toMatchObject({
      ref: "P02",
      misconceptionText: MISCONCEPTION,
    });
    expect(batchGrading.find((e) => e.outcome === "partial")).toMatchObject({ ref: "P02·q7" });
    expect(batchGrading.find((e) => e.outcome === "rating:~")).toMatchObject({
      correctionText: "q1 tačno, q4 pogrešno",
    });
    const ratings = db()
      .select({ name: topic.name, rating: topic.rating })
      .from(topic)
      .all()
      .map((r) => `${r.name}:${r.rating}`);
    expect(ratings).toEqual([
      "Skladišta podataka:✗",
      "Batch obrada:~",
      "Stream obrada:✗",
      "Lambda arhitektura:?",
    ]);

    // Backlog, next steps, observations.
    expect(
      unresolved().map((b) => [b.topicId, b.dueQuiz, b.reason, b.submissionId, b.courseId]),
    ).toEqual([
      [topicId("Stream obrada", class2), "K1", "weak", submissionId, courseId],
      [topicId("Skladišta podataka", class1), "K1", "gap", submissionId, courseId],
      [topicId("Lambda arhitektura", class2), "K1", "left_out", submissionId, courseId],
    ]);
    expect(
      db()
        .select()
        .from(nextStep)
        .orderBy(asc(nextStep.position))
        .all()
        .map((n) => [n.courseId, n.position, n.text]),
    ).toEqual(gradingResultFixture().nextSteps.map((text, i) => [courseId, i, text]));
    const [obs] = db().select().from(learnerObservation).all();
    expect(obs).toMatchObject({
      text: gradingResultFixture().observations[0],
      courseId,
      submissionId,
    });
  });

  it("emits the job for the class stream and the grading.done event", async () => {
    submit();
    await waitFor(() => types().includes(DOMAIN_EVENTS.GRADING_DONE));
    const updates = events
      .filter((e) => e.type === DOMAIN_EVENTS.JOB_UPDATED)
      .map((e) => e.payload as Extract<PipelineEvent, { type: "job" }>)
      .filter((p) => p.job.kind === "grading");
    expect(updates.map((u) => u.job.status)).toEqual(["running", "succeeded"]);
    expect(updates[0]).toMatchObject({
      classStatus: "ready",
      job: { classId: class2, stage: "grader", submissionId },
    });
    // The context passed to the grader is the submission's.
    expect(grade.mock.calls[0]![0].submission.id).toBe(submissionId);
  });

  it("skips quizzes that belong to no class", async () => {
    const q = quizFixture();
    const kQuiz = db()
      .insert(quiz)
      .values({
        courseId,
        classId: null,
        code: "K1",
        title: q.title,
        subtitle: q.subtitle,
        chipsJson: q.chips,
        questionsJson: q.questions,
      })
      .returning({ id: quiz.id })
      .get().id;
    const id = newSubmission(kQuiz);
    submit(id, kQuiz);
    await new Promise((r) => setTimeout(r, 50));
    expect(jobs()).toEqual([]);
    expect(grade).not.toHaveBeenCalled();
    await expect(
      t.app.inject({ method: "POST", url: `/api/submissions/${id}/grade` }),
    ).resolves.toMatchObject({ statusCode: 409 });
  });

  describe("failures persist nothing", () => {
    const nothingPersisted = () => {
      expect(db().select().from(result).all()).toEqual([]);
      expect(db().select().from(backlogItem).all()).toEqual([]);
      expect(db().select().from(nextStep).all()).toEqual([]);
      expect(db().select().from(learnerObservation).all()).toEqual([]);
      expect(db().select().from(topicEvent).where(eq(topicEvent.source, "quiz")).all()).toEqual([]);
      expect(db().select().from(topicEvent).where(eq(topicEvent.source, "grading")).all()).toEqual(
        [],
      );
      expect(db().select().from(topic).where(eq(topic.rating, "✗")).all()).toEqual([]);
    };

    it("when the grader errors", async () => {
      grade.mockRejectedValueOnce(new StageError("failed", "api down"));
      submit();
      await waitFor(() => finished());
      expect(jobs()[0]).toMatchObject({
        status: "failed",
        error: "Grading failed (failed): api down",
      });
      expect(types()).not.toContain(DOMAIN_EVENTS.GRADING_DONE);
      nothingPersisted();
    });

    it("when the grader throws a plain error", async () => {
      grade.mockRejectedValueOnce(new Error("boom"));
      submit();
      await waitFor(() => finished());
      expect(jobs()[0]).toMatchObject({ status: "failed", error: "Grading failed: boom" });
      nothingPersisted();
    });

    it('when a "Ne znam" is recorded as a misconception', async () => {
      grade.mockResolvedValueOnce(
        mutated((r) => {
          const item = r.items.find((i) => i.questionId === "q3")!;
          item.classification = "misconception";
          item.misconception = "Misli da stream čeka.";
          item.studentAnswer = "Ne znam";
        }),
      );
      submit();
      await waitFor(() => finished());
      expect(jobs()[0]!.status).toBe("failed");
      expect(jobs()[0]!.error).toMatch(/^Grading violated invariant: q3 was "Ne znam"/);
      nothingPersisted();
    });

    it("when a match row left as Ne znam is a misconception", async () => {
      grade.mockResolvedValueOnce(
        mutated((r) => {
          const item = r.items.find((i) => i.questionId === "q5" && i.rowIndex === 1)!;
          item.classification = "misconception";
          item.misconception = "Spark je skladište.";
        }),
      );
      submit();
      await waitFor(() => finished());
      expect(jobs()[0]!.error).toMatch(/q5 row 1 was "Ne znam"/);
      nothingPersisted();
    });

    it("when a wrong answer is recorded as a gap", async () => {
      grade.mockResolvedValueOnce(
        mutated((r) => {
          const item = r.items.find((i) => i.questionId === "q4")!;
          item.classification = "gap";
          item.misconception = null;
        }),
      );
      submit();
      await waitFor(() => finished());
      expect(jobs()[0]!.error).toMatch(/q4 was answered wrong but is not a misconception/);
      nothingPersisted();
    });

    it("when the persistence fails midway (one transaction)", async () => {
      grade.mockResolvedValueOnce(
        mutated((r) => void r.topicUpdates.push({ ...r.topicUpdates[0]!, classNumber: 9 })),
      );
      submit();
      await waitFor(() => finished());
      expect(jobs()[0]).toMatchObject({ status: "failed" });
      expect(jobs()[0]!.error).toMatch(/Topic "Batch obrada" of class 9 no longer exists/);
      nothingPersisted();
      // The notes event from before is untouched.
      expect(eventsOf("Batch obrada", class2, "notes")).toHaveLength(1);
    });
  });

  describe("regrading", () => {
    async function failFirst(): Promise<number> {
      grade.mockRejectedValueOnce(new StageError("timeout", "too slow"));
      submit();
      await waitFor(() => finished());
      return jobs()[0]!.id;
    }

    it("retries a failed grading with the failed job as parent", async () => {
      const failedId = await failFirst();
      const res = await t.app.inject({
        method: "POST",
        url: `/api/submissions/${submissionId}/grade`,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        kind: "grading",
        attempt: 2,
        status: "running",
        submissionId,
        classId: class2,
      });
      await waitFor(() => finished(2));
      const [first, second] = jobs();
      expect(first!.id).toBe(failedId);
      expect(second).toMatchObject({ status: "succeeded", attempt: 2, parentJobId: failedId });
      expect(db().select().from(result).all()).toHaveLength(1);
    });

    it("refuses while grading runs, once graded, and for unknown submissions", async () => {
      let release!: () => void;
      grade.mockImplementationOnce(
        () =>
          new Promise<GradingResult>((resolve) => {
            release = () => resolve(gradingResultFixture());
          }),
      );
      submit();
      await waitFor(() => grade.mock.calls.length === 1);
      const post = (id: number | string) =>
        t.app.inject({ method: "POST", url: `/api/submissions/${id}/grade` });
      expect((await post(submissionId)).statusCode).toBe(409);
      release();
      await waitFor(() => finished());
      expect((await post(submissionId)).statusCode).toBe(409); // already graded
      expect((await post(9999)).statusCode).toBe(404);
      expect((await post("abc")).statusCode).toBe(400);
    });
  });

  describe("with auto start off", () => {
    beforeAll(() => {
      autoStart = false;
    });
    afterAll(() => {
      autoStart = true;
    });

    it("starts a first grading only on request", async () => {
      submit();
      await new Promise((r) => setTimeout(r, 30));
      expect(jobs()).toEqual([]);
      const job = t.pipeline!.requestGrading(submissionId);
      expect(job).toMatchObject({ attempt: 1, status: "running", submissionId });
      await waitFor(() => finished());
      expect(db().select().from(result).all()).toHaveLength(1);
    });
  });

  describe("submission detail", () => {
    const detail = async (id = submissionId) =>
      SubmissionDetail.parse(
        (await t.app.inject({ method: "GET", url: `/api/submissions/${id}` })).json(),
      );

    it("goes none, running, done and carries the result", async () => {
      expect((await detail()).grading).toEqual({ status: "none", error: null, result: null });
      let release!: () => void;
      grade.mockImplementationOnce(
        () =>
          new Promise<GradingResult>((resolve) => {
            release = () => resolve(gradingResultFixture());
          }),
      );
      submit();
      await waitFor(() => grade.mock.calls.length === 1);
      expect(await detail()).toMatchObject({
        gradingStatus: "running",
        grading: { status: "running", result: null },
      });
      release();
      await waitFor(() => types().includes(DOMAIN_EVENTS.GRADING_DONE));
      const done = await detail();
      expect(done.gradingStatus).toBe("done");
      expect(done.grading.status).toBe("done");
      const graded = done.grading.result!;
      expect(graded).toMatchObject({ openScore: 0.4, writeupMd: gradingResultFixture().writeupMd });
      expect(graded.totalScore).toBeCloseTo(done.autoScore + 0.4, 6);
      expect(graded.items).toEqual(gradingResultFixture().items);
      expect(graded.topicUpdates).toEqual(gradingResultFixture().topicUpdates);
      expect(graded.correctFixes).toEqual(gradingResultFixture().correctFixes);
      expect(graded.openGrades).toEqual(gradingResultFixture().openGrades);
      expect(new Date(graded.gradedAt).toString()).not.toBe("Invalid Date");
      const list = await t.app.inject({ method: "GET", url: `/api/quizzes/${quizId}/submissions` });
      expect(list.json()).toMatchObject([{ id: submissionId, gradingStatus: "done" }]);
    });

    it("reports a failure with its error, and none after a restart", async () => {
      grade.mockRejectedValueOnce(new Error("boom"));
      submit();
      await waitFor(() => finished());
      expect(await detail()).toMatchObject({
        gradingStatus: "failed",
        grading: { status: "failed", error: "Grading failed: boom", result: null },
      });
    });
  });

  describe("backlog and next steps across gradings", () => {
    async function gradeAgain(result: GradingResult): Promise<number> {
      const id = newSubmission();
      const before = jobs().length;
      grade.mockResolvedValueOnce(result);
      submit(id);
      await waitFor(() => finished(before + 1));
      expect(jobs().at(-1)!.status).toBe("succeeded");
      return id;
    }

    it("keeps one unresolved item per topic and resolves it", async () => {
      submit();
      await waitFor(() => finished());
      expect(unresolved()).toHaveLength(3);

      // Re-adding a topic updates its item.
      const second = await gradeAgain(
        mutated((r) => {
          r.backlogAdd = [{ topic: "Stream obrada", classNumber: 2, dueQuiz: "K2", reason: "gap" }];
          r.observations = [];
        }),
      );
      const stream = db()
        .select()
        .from(backlogItem)
        .where(eq(backlogItem.topicId, topicId("Stream obrada", class2)))
        .all();
      expect(stream).toHaveLength(1);
      expect(stream[0]).toMatchObject({
        dueQuiz: "K2",
        reason: "gap",
        submissionId: second,
        resolvedAt: null,
      });
      expect(unresolved()).toHaveLength(3);

      // Resolving closes only that item.
      await gradeAgain(
        mutated((r) => {
          r.backlogAdd = [];
          r.backlogResolve = [{ topic: "Stream obrada", classNumber: 2 }];
        }),
      );
      expect(
        unresolved()
          .map((b) => b.topicId)
          .sort(),
      ).toEqual(
        [topicId("Skladišta podataka", class1), topicId("Lambda arhitektura", class2)].sort(),
      );
      const closed = db()
        .select()
        .from(backlogItem)
        .where(eq(backlogItem.topicId, topicId("Stream obrada", class2)))
        .get()!;
      expect(closed.resolvedAt).not.toBeNull();

      // A resolved topic can be added again, as a new item.
      await gradeAgain(
        mutated((r) => {
          r.backlogAdd = [
            { topic: "Stream obrada", classNumber: 2, dueQuiz: "K1", reason: "weak" },
          ];
        }),
      );
      expect(unresolved()).toHaveLength(3);
      expect(
        db()
          .select()
          .from(backlogItem)
          .where(eq(backlogItem.topicId, topicId("Stream obrada", class2)))
          .all(),
      ).toHaveLength(2);
    });

    it("replaces the next steps wholesale and appends observations", async () => {
      submit();
      await waitFor(() => finished());
      await gradeAgain(
        mutated((r) => {
          r.nextSteps = ["Samo jedan korak."];
          r.observations = ["Drugo zapažanje."];
        }),
      );
      expect(
        db()
          .select()
          .from(nextStep)
          .all()
          .map((n) => n.text),
      ).toEqual(["Samo jedan korak."]);
      expect(
        db()
          .select()
          .from(learnerObservation)
          .orderBy(asc(learnerObservation.id))
          .all()
          .map((o) => o.text),
      ).toEqual([gradingResultFixture().observations[0], "Drugo zapažanje."]);
      // The next grading sees what the previous one stored.
      await gradeAgain(gradingResultFixture());
      const ctx = grade.mock.calls.at(-1)![0];
      expect(ctx.nextSteps).toEqual(["Samo jedan korak."]);
      expect(ctx.observations).toEqual([
        gradingResultFixture().observations[0],
        "Drugo zapažanje.",
      ]);
      expect(ctx.backlog.map((b) => b.topic).sort()).toEqual([
        "Lambda arhitektura",
        "Skladišta podataka",
        "Stream obrada",
      ]);
    });
  });

  describe("course progress", () => {
    const progress = async (id = courseId) => {
      const res = await t.app.inject({ method: "GET", url: `/api/courses/${id}/progress` });
      expect(res.statusCode).toBe(200);
      return CourseProgress.parse(res.json());
    };

    it("is empty for a fresh course and 404/400 for bad ids", async () => {
      const empty = db().insert(course).values({ name: "Prazan" }).returning().get().id;
      expect(await progress(empty)).toEqual({
        nextSteps: [],
        backlog: [],
        topics: [],
        quizHistory: [],
        visualizations: [],
        observations: [],
        flags: { classesWithoutLesson: [], ungradedSubmissions: [] },
      });
      expect(
        (await t.app.inject({ method: "GET", url: "/api/courses/999/progress" })).statusCode,
      ).toBe(404);
      expect(
        (await t.app.inject({ method: "GET", url: "/api/courses/x/progress" })).statusCode,
      ).toBe(400);
    });

    it("aggregates the learner model and the flags", async () => {
      // An ungraded submission, and a draft class with a usable material.
      const ungraded = newSubmission();
      const draft = db()
        .insert(classTable)
        .values({ courseId, number: 3, title: "Nova", status: "draft" })
        .returning()
        .get().id;
      const emptyDraft = db()
        .insert(classTable)
        .values({ courseId, number: 4, title: "Prazna", status: "draft" })
        .returning()
        .get().id;
      void emptyDraft;
      db()
        .insert(material)
        .values({
          classId: draft,
          kind: "material",
          originalName: "slajdovi.pdf",
          mime: "application/pdf",
          sizeBytes: 1,
          sha256: "a".repeat(64),
          storagePath: "files/aa/x.pdf",
          extractedText: "tekst",
          extractionStatus: "ok",
        })
        .run();

      expect((await progress()).flags.ungradedSubmissions.map((u) => u.submissionId)).toEqual([
        submissionId,
        ungraded,
      ]);

      submit(); // grades `submissionId` only
      await waitFor(() => finished());
      const p = await progress();

      expect(p.nextSteps).toEqual(gradingResultFixture().nextSteps);
      expect(p.observations).toEqual(gradingResultFixture().observations);
      expect(p.backlog).toMatchObject([
        { topic: "Stream obrada", classNumber: 2, dueQuiz: "K1", reason: "weak" },
        { topic: "Skladišta podataka", classNumber: 1, dueQuiz: "K1", reason: "gap" },
        { topic: "Lambda arhitektura", classNumber: 2, dueQuiz: "K1", reason: "left_out" },
      ]);
      expect(p.topics.map((x) => [x.classNumber, x.name, x.rating, x.testedRefs])).toEqual([
        [1, "Skladišta podataka", "✗", ["P02"]],
        [2, "Batch obrada", "~", ["P02"]],
        [2, "Stream obrada", "✗", ["P02"]],
        [2, "Lambda arhitektura", "?", []],
      ]);
      expect(p.topics.map((x) => x.lastNote)).toEqual([
        "q6 ne znam",
        "q1 tačno, q4 pogrešno",
        "q2 zabluda, ostalo ne znam",
        null,
      ]);
      expect(p.quizHistory).toHaveLength(2);
      expect(p.quizHistory[0]).toMatchObject({
        submissionId: ungraded,
        code: "P02",
        openScore: null,
        totalScore: null,
        gradingStatus: "none",
      });
      expect(p.quizHistory[1]).toMatchObject({
        submissionId,
        quizId,
        openScore: 0.4,
        gradingStatus: "done",
      });
      expect(p.quizHistory[1]!.totalScore).toBeCloseTo(p.quizHistory[1]!.autoScore + 0.4, 6);
      expect(p.flags).toEqual({
        classesWithoutLesson: [{ classId: draft, number: 3, title: "Nova", status: "draft" }],
        ungradedSubmissions: [
          { submissionId: ungraded, quizCode: "P02", submittedAt: expect.any(String) },
        ],
      });
    });
  });

  describe("per-course serialization", () => {
    /** A grader that records its calls and finishes only when released. */
    function gatedGrader(order: string[], contexts: Parameters<Grade>[0][]) {
      const gates: Array<{ release: (r?: GradingResult | Error) => void }> = [];
      const fn = vi.fn<Grade>(async (ctx) => {
        order.push(`start:${ctx.submission.id}`);
        contexts.push(ctx);
        const outcome = await new Promise<GradingResult | Error>((resolve) => {
          gates.push({ release: (r) => resolve(r ?? gradingResultFixture()) });
        });
        order.push(`end:${ctx.submission.id}`);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      return { fn, gates };
    }

    /** A second course with the same structure and its own quiz and submission. */
    function secondCourse(): { quizId: number; submissionId: number } {
      const otherCourse = db()
        .insert(course)
        .values({ name: "Drugi kurs", reviewCadence: 4 })
        .returning({ id: course.id })
        .get().id;
      const classIds = [1, 2].map(
        (number) =>
          db()
            .insert(classTable)
            .values({ courseId: otherCourse, number, title: `Čas ${number}`, status: "ready" })
            .returning({ id: classTable.id })
            .get().id,
      );
      for (const id of classIds) {
        db().insert(lesson).values({ classId: id, bodyMd: "Lekcija." }).run();
      }
      const names: Array<[number, string]> = [
        [0, "Skladišta podataka"],
        [1, "Batch obrada"],
        [1, "Stream obrada"],
        [1, "Lambda arhitektura"],
      ];
      names.forEach(([ci, name], position) => {
        db()
          .insert(topic)
          .values({ courseId: otherCourse, classId: classIds[ci]!, position, name, rating: "?" })
          .run();
      });
      const q = quizFixture();
      const otherQuiz = db()
        .insert(quiz)
        .values({
          courseId: otherCourse,
          classId: classIds[1]!,
          code: q.code,
          title: q.title,
          subtitle: q.subtitle,
          chipsJson: q.chips,
          questionsJson: q.questions,
        })
        .returning({ id: quiz.id })
        .get().id;
      const quizJob = db()
        .insert(generationJob)
        .values({
          classId: classIds[1]!,
          kind: "quiz",
          stage: "quiz-planner",
          status: "succeeded",
          attempt: 1,
        })
        .returning({ id: generationJob.id })
        .get().id;
      db()
        .insert(quizPlan)
        .values({
          jobId: quizJob,
          classId: classIds[1]!,
          planJson: planFixture(),
          logJson: [],
          quizId: otherQuiz,
        })
        .run();
      return { quizId: otherQuiz, submissionId: newSubmission(otherQuiz) };
    }

    const tick = () => new Promise((r) => setTimeout(r, 30));

    it("starts the second job of a course only after the first one persisted", async () => {
      const order: string[] = [];
      const contexts: Parameters<Grade>[0][] = [];
      const { fn, gates } = gatedGrader(order, contexts);
      grade.mockImplementation(fn);
      const second = newSubmission();

      submit(submissionId);
      submit(second);
      await waitFor(() => gates.length === 1);
      await tick();
      expect(order).toEqual([`start:${submissionId}`]);
      expect(jobs().every((j) => j.status === "running" && j.stage === "grader")).toBe(true);
      expect(contexts[0]!.nextSteps).toEqual([]);

      gates[0]!.release(mutated((r) => (r.nextSteps = ["Prvi korak"])));
      await waitFor(() => gates.length === 2);
      expect(order).toEqual([`start:${submissionId}`, `end:${submissionId}`, `start:${second}`]);
      // The second grader sees what the first one saved.
      expect(contexts[1]!.nextSteps).toEqual(["Prvi korak"]);
      expect(db().select().from(result).all()).toHaveLength(1);

      gates[1]!.release(mutated((r) => (r.nextSteps = ["Drugi korak"])));
      await waitFor(() => finished(2));
      expect(jobs().map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
      expect(
        db()
          .select()
          .from(nextStep)
          .where(eq(nextStep.courseId, courseId))
          .all()
          .map((n) => n.text),
      ).toEqual(["Drugi korak"]);
    });

    it("grades different courses concurrently", async () => {
      const other = secondCourse();
      const order: string[] = [];
      const { fn, gates } = gatedGrader(order, []);
      grade.mockImplementation(fn);

      submit(submissionId);
      submit(other.submissionId, other.quizId);
      await waitFor(() => gates.length === 2);
      expect(order).toEqual([`start:${submissionId}`, `start:${other.submissionId}`]);

      gates.forEach((g) => g.release());
      await waitFor(() => finished(2));
    });

    it("a failing first job does not block the next one of the course", async () => {
      const order: string[] = [];
      const { fn, gates } = gatedGrader(order, []);
      grade.mockImplementation(fn);
      const second = newSubmission();

      submit(submissionId);
      submit(second);
      await waitFor(() => gates.length === 1);
      gates[0]!.release(new Error("API down"));
      await waitFor(() => gates.length === 2);
      gates[1]!.release();
      await waitFor(() => finished(2));

      const byId = Object.fromEntries(jobs().map((j) => [j.submissionId, j.status]));
      expect(byId).toEqual({ [submissionId]: "failed", [second]: "succeeded" });
    });
  });
});
