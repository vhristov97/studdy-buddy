import type { FastifyPluginAsync } from "fastify";
import {
  CreateSubmissionInput,
  scoreQuiz,
  validateAnswers,
  type SubmissionDetail,
  type SubmissionSummary,
} from "@studdy/shared";
import type { Coordinator } from "../agents/coordinator.js";
import type { Db } from "../db/client.js";
import { DOMAIN_EVENTS, type SubmissionCreatedPayload } from "../pipeline/events.js";
import {
  createSubmission,
  getFullQuiz,
  getSubmissionDetail,
  listSubmissions,
} from "../repositories/quizzes.js";
import { ApiError, notFound, parseBody, parseId } from "./errors.js";

export interface SubmissionRouteOptions {
  db: Db;
  /** Without it, submissions are saved but no `submission.created` event is emitted. */
  coordinator?: Coordinator;
}

export const submissionRoutes: FastifyPluginAsync<SubmissionRouteOptions> = async (
  app,
  { db, coordinator },
) => {
  app.post<{ Params: { quizId: string } }>(
    "/api/quizzes/:quizId/submissions",
    async (request, reply): Promise<SubmissionDetail> => {
      const quizId = parseId("quizId", request.params.quizId);
      const full = getFullQuiz(db, quizId);
      if (!full) throw notFound("Quiz");
      const { answers } = parseBody(CreateSubmissionInput, request.body);
      const errors = validateAnswers(full.quiz, answers);
      if (errors.length > 0) {
        throw new ApiError(400, "validation", "Invalid answers", errors);
      }
      // The score is always computed here; nothing score-like from the client is trusted.
      const detail = createSubmission(
        db,
        quizId,
        full.quiz,
        answers,
        scoreQuiz(full.quiz, answers),
      );
      if (coordinator) {
        const payload: SubmissionCreatedPayload = { quizId, submissionId: detail.id };
        try {
          coordinator.emit(DOMAIN_EVENTS.SUBMISSION_CREATED, payload);
        } catch (err) {
          // The submission is saved; a missing event must not fail the student's request.
          request.log.error({ err, ...payload }, "could not emit submission.created");
        }
      }
      return reply.code(201).send(detail);
    },
  );

  app.get<{ Params: { quizId: string } }>(
    "/api/quizzes/:quizId/submissions",
    async (request): Promise<SubmissionSummary[]> => {
      const quizId = parseId("quizId", request.params.quizId);
      if (!getFullQuiz(db, quizId)) throw notFound("Quiz");
      return listSubmissions(db, quizId);
    },
  );

  /** Lets the player show the feedback again after a reload. */
  app.get<{ Params: { submissionId: string } }>(
    "/api/submissions/:submissionId",
    async (request): Promise<SubmissionDetail> => {
      const submissionId = parseId("submissionId", request.params.submissionId);
      const found = getSubmissionDetail(db, submissionId);
      if (!found) throw notFound("Submission");
      return found;
    },
  );
};
