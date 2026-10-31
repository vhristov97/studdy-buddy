import type { FastifyPluginAsync } from "fastify";
import {
  CreateClassInput,
  CreateCourseInput,
  UpdateClassInput,
  UpdateCourseInput,
} from "@studdy/shared";
import type { Db } from "../db/client.js";
import {
  createClass,
  createCourse,
  deleteClass,
  deleteCourse,
  getClass,
  getCourse,
  listCourses,
  updateClass,
  updateCourse,
} from "../repositories/courses.js";
import { deleteUnreferencedFiles } from "../files/store.js";
import { listClassHashes, listCourseHashes } from "../repositories/materials.js";
import { notFound, parseBody, parseId } from "./errors.js";

export interface CourseRouteOptions {
  db: Db;
  dataDir: string;
}

interface CourseParams {
  courseId: string;
}

interface ClassParams {
  classId: string;
}

export const courseRoutes: FastifyPluginAsync<CourseRouteOptions> = async (
  app,
  { db, dataDir },
) => {
  app.get("/api/courses", async () => listCourses(db));

  app.post("/api/courses", async (request, reply) => {
    const input = parseBody(CreateCourseInput, request.body);
    return reply.code(201).send(createCourse(db, input));
  });

  app.get<{ Params: CourseParams }>("/api/courses/:courseId", async (request) => {
    const course = getCourse(db, parseId("courseId", request.params.courseId));
    if (!course) throw notFound("Course");
    return course;
  });

  app.patch<{ Params: CourseParams }>("/api/courses/:courseId", async (request) => {
    const id = parseId("courseId", request.params.courseId);
    const input = parseBody(UpdateCourseInput, request.body);
    const course = updateCourse(db, id, input);
    if (!course) throw notFound("Course");
    return course;
  });

  app.delete<{ Params: CourseParams }>("/api/courses/:courseId", async (request, reply) => {
    const id = parseId("courseId", request.params.courseId);
    // The cascade removes the material rows, so note which files they pointed at first.
    const hashes = listCourseHashes(db, id);
    if (!deleteCourse(db, id)) throw notFound("Course");
    deleteUnreferencedFiles(db, dataDir, hashes, (err) =>
      request.log.warn({ err }, "could not remove an unreferenced file"),
    );
    return reply.code(204).send();
  });

  app.post<{ Params: CourseParams }>("/api/courses/:courseId/classes", async (request, reply) => {
    const courseId = parseId("courseId", request.params.courseId);
    const input = parseBody(CreateClassInput, request.body);
    const created = createClass(db, courseId, input);
    if (!created) throw notFound("Course");
    return reply.code(201).send(created);
  });

  app.get<{ Params: ClassParams }>("/api/classes/:classId", async (request) => {
    const found = getClass(db, parseId("classId", request.params.classId));
    if (!found) throw notFound("Class");
    return found;
  });

  app.patch<{ Params: ClassParams }>("/api/classes/:classId", async (request) => {
    const id = parseId("classId", request.params.classId);
    const input = parseBody(UpdateClassInput, request.body);
    const updated = updateClass(db, id, input);
    if (!updated) throw notFound("Class");
    return updated;
  });

  app.delete<{ Params: ClassParams }>("/api/classes/:classId", async (request, reply) => {
    const id = parseId("classId", request.params.classId);
    const hashes = listClassHashes(db, id);
    if (!deleteClass(db, id)) throw notFound("Class");
    deleteUnreferencedFiles(db, dataDir, hashes, (err) =>
      request.log.warn({ err }, "could not remove an unreferenced file"),
    );
    return reply.code(204).send();
  });
};
