import type { FastifyPluginAsync } from "fastify";
import type { CourseProgress } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { getCourse } from "../repositories/courses.js";
import { getCourseProgress } from "../repositories/progress.js";
import { notFound, parseId } from "./errors.js";

export interface ProgressRouteOptions {
  db: Db;
}

export const progressRoutes: FastifyPluginAsync<ProgressRouteOptions> = async (app, { db }) => {
  app.get<{ Params: { courseId: string } }>(
    "/api/courses/:courseId/progress",
    async (request): Promise<CourseProgress> => {
      const courseId = parseId("courseId", request.params.courseId);
      if (!getCourse(db, courseId)) throw notFound("Course");
      return getCourseProgress(db, courseId);
    },
  );
};
