import { and, asc, desc, eq, inArray, isNotNull, isNull, notExists } from "drizzle-orm";
import type { CourseProgress, ProgressTopic } from "@studdy/shared";
import type { Db } from "../db/client.js";
import {
  backlogItem,
  classTable,
  learnerObservation,
  lesson,
  material,
  nextStep,
  quiz,
  result,
  submission,
  topic,
  topicEvent,
} from "../db/schema.js";
import { gradingStateOf } from "./grading.js";

/** Separates the quiz code from the question id in a quiz event's ref, e.g. "P01·q3". */
const REF_SEPARATOR = "·";
const RATING_OUTCOME_PREFIX = "rating:";

function topicsProgress(db: Db, courseId: number): ProgressTopic[] {
  const events = db
    .select({ event: topicEvent })
    .from(topicEvent)
    .innerJoin(topic, eq(topic.id, topicEvent.topicId))
    .where(eq(topic.courseId, courseId))
    .orderBy(asc(topicEvent.id))
    .all();
  const testedRefs = new Map<number, string[]>();
  const lastNotes = new Map<number, string>();
  for (const { event } of events) {
    if (event.source === "quiz" && event.ref) {
      const code = event.ref.split(REF_SEPARATOR)[0]!;
      const refs = testedRefs.get(event.topicId) ?? [];
      if (!refs.includes(code)) refs.push(code);
      testedRefs.set(event.topicId, refs);
    }
    if (
      event.source === "grading" &&
      event.outcome?.startsWith(RATING_OUTCOME_PREFIX) &&
      event.correctionText !== null
    ) {
      lastNotes.set(event.topicId, event.correctionText); // events are oldest first, so the last wins
    }
  }
  return db
    .select({ topic, classNumber: classTable.number })
    .from(topic)
    .innerJoin(classTable, eq(classTable.id, topic.classId))
    .where(eq(topic.courseId, courseId))
    .orderBy(asc(classTable.number), asc(topic.position), asc(topic.id))
    .all()
    .map(({ topic: t, classNumber }) => ({
      id: t.id,
      classNumber,
      name: t.name,
      rating: t.rating,
      deferred: t.deferred,
      testedRefs: testedRefs.get(t.id) ?? [],
      lastNote: lastNotes.get(t.id) ?? null,
    }));
}

/** Everything the progress page shows for a course. */
export function getCourseProgress(db: Db, courseId: number): CourseProgress {
  const submissions = db
    .select({ submission, quiz, result })
    .from(submission)
    .innerJoin(quiz, eq(quiz.id, submission.quizId))
    .leftJoin(result, eq(result.submissionId, submission.id))
    .where(eq(quiz.courseId, courseId))
    .orderBy(desc(submission.id))
    .all();

  const classesWithoutLesson = db
    .select({
      classId: classTable.id,
      number: classTable.number,
      title: classTable.title,
      status: classTable.status,
    })
    .from(classTable)
    .where(
      and(
        eq(classTable.courseId, courseId),
        inArray(classTable.status, ["draft", "failed"]),
        notExists(
          db.select({ id: lesson.id }).from(lesson).where(eq(lesson.classId, classTable.id)),
        ),
      ),
    )
    .orderBy(asc(classTable.number))
    .all()
    .filter(
      (cls) =>
        db
          .select({ id: material.id })
          .from(material)
          .where(
            and(
              eq(material.classId, cls.classId),
              eq(material.kind, "material"),
              eq(material.extractionStatus, "ok"),
              isNotNull(material.extractedText),
            ),
          )
          .limit(1)
          .get() !== undefined,
    );

  return {
    nextSteps: db
      .select({ text: nextStep.text })
      .from(nextStep)
      .where(eq(nextStep.courseId, courseId))
      .orderBy(asc(nextStep.position), asc(nextStep.id))
      .all()
      .map((r) => r.text),
    backlog: db
      .select({ item: backlogItem, name: topic.name, classNumber: classTable.number })
      .from(backlogItem)
      .innerJoin(topic, eq(topic.id, backlogItem.topicId))
      .innerJoin(classTable, eq(classTable.id, topic.classId))
      .where(and(eq(backlogItem.courseId, courseId), isNull(backlogItem.resolvedAt)))
      .orderBy(asc(backlogItem.id))
      .all()
      .map(({ item, name, classNumber }) => ({
        topic: name,
        classNumber,
        dueQuiz: item.dueQuiz,
        reason: item.reason,
        createdAt: item.createdAt.toISOString(),
      })),
    topics: topicsProgress(db, courseId),
    quizHistory: submissions.map(({ submission: s, quiz: q, result: r }) => ({
      quizId: q.id,
      code: q.code,
      title: q.title,
      submissionId: s.id,
      submittedAt: s.submittedAt.toISOString(),
      autoScore: s.autoScore,
      autoMax: s.autoMax,
      openScore: r?.openScore ?? null,
      totalScore: r?.totalScore ?? null,
      gradingStatus: gradingStateOf(db, s.id).status,
    })),
    observations: db
      .select({ text: learnerObservation.text })
      .from(learnerObservation)
      .orderBy(desc(learnerObservation.id))
      .all()
      .map((r) => r.text),
    flags: {
      classesWithoutLesson,
      ungradedSubmissions: submissions
        .filter(({ result: r }) => r === null)
        .reverse()
        .map(({ submission: s, quiz: q }) => ({
          submissionId: s.id,
          quizCode: q.code,
          submittedAt: s.submittedAt.toISOString(),
        })),
    },
  };
}
