import { z } from "zod";
import { MaterialSummary } from "./materials";

export const CLASS_STATUSES = ["draft", "generating", "ready", "failed"] as const;
export const ClassStatus = z.enum(CLASS_STATUSES);
export type ClassStatus = z.infer<typeof ClassStatus>;

/** Optional free text: trimmed, length-limited, and an empty string means "not set" (null). */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

const courseName = z.string().trim().min(1).max(200);
/** A cumulative review every N classes. */
const reviewCadence = z.number().int().min(1).max(50).nullable().optional();
const classTitle = z.string().trim().min(1).max(200);
const classNumber = z.number().int().min(1).max(999);

const hasAtLeastOneField = (value: Record<string, unknown>) =>
  Object.values(value).some((field) => field !== undefined);
const AT_LEAST_ONE_FIELD = { message: "At least one field is required" };

// Request bodies

const courseFields = {
  name: courseName,
  persona: optionalText(1000),
  assessmentFormat: optionalText(4000),
  reviewCadence,
};

export const CreateCourseInput = z.strictObject(courseFields);
export type CreateCourseInput = z.infer<typeof CreateCourseInput>;

export const UpdateCourseInput = z
  .strictObject({ ...courseFields, name: courseName.optional() })
  .refine(hasAtLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateCourseInput = z.infer<typeof UpdateCourseInput>;

export const CreateClassInput = z.strictObject({
  title: classTitle,
  /** Defaults server-side to the highest existing number in the course + 1. */
  number: classNumber.optional(),
});
export type CreateClassInput = z.infer<typeof CreateClassInput>;

export const UpdateClassInput = z
  .strictObject({ title: classTitle.optional(), number: classNumber.optional() })
  .refine(hasAtLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateClassInput = z.infer<typeof UpdateClassInput>;

// Responses

export const ClassSummary = z.object({
  id: z.number().int(),
  courseId: z.number().int(),
  number: z.number().int(),
  title: z.string(),
  status: ClassStatus,
  /** ISO 8601. */
  createdAt: z.string(),
});
export type ClassSummary = z.infer<typeof ClassSummary>;

export const CourseSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  persona: z.string().nullable(),
  assessmentFormat: z.string().nullable(),
  reviewCadence: z.number().int().nullable(),
  classCount: z.number().int(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type CourseSummary = z.infer<typeof CourseSummary>;

export const CourseDetail = CourseSummary.extend({
  /** Ordered by class number. */
  classes: z.array(ClassSummary),
});
export type CourseDetail = z.infer<typeof CourseDetail>;

export const ClassDetail = ClassSummary.extend({
  courseName: z.string(),
  /** Materials first, then notes; each group by original name. */
  materials: z.array(MaterialSummary),
});
export type ClassDetail = z.infer<typeof ClassDetail>;

export const ApiErrorCode = z.enum(["validation", "not_found", "conflict", "internal"]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiErrorBody = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
