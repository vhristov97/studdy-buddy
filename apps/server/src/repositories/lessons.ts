import { asc, desc, eq } from "drizzle-orm";
import type { ClassStatus, GenerationJob, LessonView, TopicEvent, TopicView } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { classTable, generationJob, lesson, topic, topicEvent } from "../db/schema.js";

type JobRow = typeof generationJob.$inferSelect;

export function toGenerationJob(row: JobRow): GenerationJob {
  return {
    id: row.id,
    classId: row.classId,
    kind: row.kind,
    stage: row.stage,
    status: row.status,
    attempt: row.attempt,
    error: row.error,
    cycle: row.cycle,
    submissionId: row.submissionId,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function getJob(db: Db, id: number): GenerationJob | undefined {
  const row = db.select().from(generationJob).where(eq(generationJob.id, id)).get();
  return row && toGenerationJob(row);
}

/** Newest first. */
export function listJobs(db: Db, classId: number): GenerationJob[] {
  return db
    .select()
    .from(generationJob)
    .where(eq(generationJob.classId, classId))
    .orderBy(desc(generationJob.id))
    .all()
    .map(toGenerationJob);
}

export function getClassStatus(db: Db, classId: number): ClassStatus | undefined {
  return db
    .select({ status: classTable.status })
    .from(classTable)
    .where(eq(classTable.id, classId))
    .get()?.status;
}

/** The lesson with its topics (in lesson order) and their events (oldest first). */
export function getLessonView(db: Db, classId: number): LessonView | undefined {
  const row = db.select().from(lesson).where(eq(lesson.classId, classId)).get();
  if (!row) return undefined;

  const events = new Map<number, TopicEvent[]>();
  const eventRows = db
    .select({ event: topicEvent })
    .from(topicEvent)
    .innerJoin(topic, eq(topic.id, topicEvent.topicId))
    .where(eq(topic.classId, classId))
    .orderBy(asc(topicEvent.createdAt), asc(topicEvent.id))
    .all();
  for (const { event } of eventRows) {
    const list = events.get(event.topicId) ?? [];
    list.push({
      id: event.id,
      source: event.source,
      ref: event.ref,
      outcome: event.outcome,
      misconceptionText: event.misconceptionText,
      correctionText: event.correctionText,
      createdAt: event.createdAt.toISOString(),
    });
    events.set(event.topicId, list);
  }

  const topics: TopicView[] = db
    .select()
    .from(topic)
    .where(eq(topic.classId, classId))
    .orderBy(asc(topic.position), asc(topic.id))
    .all()
    .map((t) => ({
      id: t.id,
      name: t.name,
      position: t.position,
      rating: t.rating,
      deferred: t.deferred,
      deferredNote: t.deferredNote,
      events: events.get(t.id) ?? [],
    }));

  return { classId, bodyMd: row.bodyMd, createdAt: row.createdAt.toISOString(), topics };
}
