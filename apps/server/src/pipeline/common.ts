import type { SemanticEvent } from "@mozaik-ai/core";
import type { Coordinator } from "../agents/coordinator.js";
import type { Db } from "../db/client.js";
import { getClassStatus, getJob } from "../repositories/lessons.js";
import { DOMAIN_EVENTS, type JobProgressPayload, type JobUpdatedPayload } from "./events.js";

export const MAX_ERROR_LENGTH = 500;

export function truncate(message: string, max = MAX_ERROR_LENGTH): string {
  return message.length > max ? `${message.slice(0, max)}...` : message;
}

/** Characters of model output carried by one `inference.stream` event (raw Anthropic stream event). */
export function streamedChars(event: SemanticEvent): number {
  if (event.type !== "inference.stream") return 0;
  const payload = event.payload as { type?: unknown; delta?: unknown } | undefined;
  if (payload?.type !== "content_block_delta" || typeof payload.delta !== "object") return 0;
  const delta = payload.delta as { type?: unknown; text?: unknown; partial_json?: unknown };
  if (delta.type === "text_delta" && typeof delta.text === "string") return delta.text.length;
  if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
    return delta.partial_json.length;
  }
  return 0;
}

/** Emits `job.updated` with the job's and its class's current state. */
export function createJobEmitter(db: Db, coordinator: Coordinator): (jobId: number) => void {
  return (jobId) => {
    const job = getJob(db, jobId);
    if (!job) return; // the class was deleted meanwhile
    const classStatus = getClassStatus(db, job.classId);
    if (!classStatus) return;
    const payload: JobUpdatedPayload = { type: "job", job, classStatus };
    coordinator.emit(DOMAIN_EVENTS.JOB_UPDATED, payload);
  };
}

/**
 * Returns a factory for `onEvent` handlers that emit throttled `job.progress` events counting the
 * characters streamed by one agent call (the counter starts at 0 per handler).
 */
export function createProgressReporter(
  coordinator: Coordinator,
  intervalMs: number,
): (target: { classId: number; jobId: number; stage: string }) => (event: SemanticEvent) => void {
  return ({ classId, jobId, stage }) => {
    let outputChars = 0;
    let lastProgressAt = 0;
    return (event) => {
      const chars = streamedChars(event);
      if (chars === 0) return;
      outputChars += chars;
      const now = Date.now();
      if (now - lastProgressAt < intervalMs) return;
      lastProgressAt = now;
      const payload: JobProgressPayload = { type: "progress", classId, jobId, stage, outputChars };
      coordinator.emit(DOMAIN_EVENTS.JOB_PROGRESS, payload);
    };
  };
}
