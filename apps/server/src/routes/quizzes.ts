import type { FastifyPluginAsync } from "fastify";
import type { QuizSummary } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { getCourse } from "../repositories/courses.js";
import { listQuizSummaries } from "../repositories/quizzes.js";
import { notFound, parseId } from "./errors.js";

export interface QuizRouteOptions {
  db: Db;
}

export const quizRoutes: FastifyPluginAsync<QuizRouteOptions> = async (app, { db }) => {
  app.get<{ Params: { courseId: string } }>(
    "/api/courses/:courseId/quizzes",
    async (request): Promise<QuizSummary[]> => {
      const courseId = parseId("courseId", request.params.courseId);
      if (!getCourse(db, courseId)) throw notFound("Course");
      return listQuizSummaries(db, courseId);
    },
  );
};
