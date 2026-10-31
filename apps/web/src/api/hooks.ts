import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  ClassDetail,
  ClassSummary,
  CourseDetail,
  CourseSummary,
  CreateClassInput,
  CreateCourseInput,
  ClassJobs,
  GenerationJob,
  LessonView,
  MaterialDetail,
  MaterialSummary,
  QuizSummary,
  UpdateClassInput,
  UpdateCourseInput,
} from "@studdy/shared";
import { apiDelete, apiGet, apiGetText, apiPatch, apiPost, apiUpload } from "./client";
import { queryKeys } from "./keys";

// Queries

export function useCourses() {
  return useQuery({
    queryKey: queryKeys.courses,
    queryFn: () => apiGet<CourseSummary[]>("/api/courses"),
  });
}

export function useCourse(id: number) {
  return useQuery({
    queryKey: queryKeys.course(id),
    queryFn: () => apiGet<CourseDetail>(`/api/courses/${id}`),
  });
}

export function useClass(id: number) {
  return useQuery({
    queryKey: queryKeys.class(id),
    queryFn: () => apiGet<ClassDetail>(`/api/classes/${id}`),
  });
}

export function useMaterial(id: number) {
  return useQuery({
    queryKey: queryKeys.material(id),
    queryFn: () => apiGet<MaterialDetail>(`/api/materials/${id}`),
  });
}

/** The combined notes of a class and their tracking-table topics. 404 means "not generated". */
export function useLesson(classId: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.lesson(classId),
    queryFn: () => apiGet<LessonView>(`/api/classes/${classId}/lesson`),
    enabled,
  });
}

/** Generation jobs of a class, newest first. */
export function useClassJobs(classId: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.classJobs(classId),
    queryFn: async () => (await apiGet<ClassJobs>(`/api/classes/${classId}/jobs`)).jobs,
    enabled,
  });
}

/** Released quizzes of a course, newest first. */
export function useCourseQuizzes(courseId: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.courseQuizzes(courseId),
    queryFn: () => apiGet<QuizSummary[]>(`/api/courses/${courseId}/quizzes`),
    enabled,
  });
}

/** The stored file of a Markdown note, as text. */
export function useMaterialText(id: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.materialFile(id),
    queryFn: () => apiGetText(`/api/materials/${id}/file`),
    enabled,
  });
}

// Mutations

function invalidateCourse(client: QueryClient, courseId: number) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.courses }),
    client.invalidateQueries({ queryKey: queryKeys.course(courseId) }),
  ]);
}

export function useCreateCourse() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCourseInput) => apiPost<CourseSummary>("/api/courses", input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courses }),
  });
}

export function useUpdateCourse(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCourseInput) => apiPatch<CourseSummary>(`/api/courses/${id}`, input),
    onSuccess: () => invalidateCourse(client, id),
  });
}

export function useDeleteCourse(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete(`/api/courses/${id}`),
    // Not awaited and not touching course(id): the page is about to navigate away, and
    // refetching the deleted course would flash a "not found" first.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.courses, exact: true });
    },
  });
}

export function useCreateClass(courseId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateClassInput) =>
      apiPost<ClassSummary>(`/api/courses/${courseId}/classes`, input),
    onSuccess: () => invalidateCourse(client, courseId),
  });
}

export function useUpdateClass(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateClassInput) => apiPatch<ClassSummary>(`/api/classes/${id}`, input),
    onSuccess: (updated) =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.class(id) }),
        invalidateCourse(client, updated.courseId),
      ]),
  });
}

export function useDeleteClass(id: number, courseId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete(`/api/classes/${id}`),
    // Not awaited, and class(id) is left alone, for the same reason as useDeleteCourse.
    onSuccess: () => {
      void invalidateCourse(client, courseId);
    },
  });
}

/**
 * The class (the "classes/<id>" prefix also covers its jobs and lesson) and its parent course
 * (the course page shows per-class counts).
 */
export function invalidateClassAndCourse(client: QueryClient, classId: number) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.class(classId) }),
    // The course id isn't known here; the "courses" prefix covers the list and every course.
    client.invalidateQueries({ queryKey: queryKeys.courses }),
  ]);
}

export function useUploadMaterials(classId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]) =>
      apiUpload<MaterialSummary[]>(`/api/classes/${classId}/materials`, files),
    onSettled: () => invalidateClassAndCourse(client, classId),
  });
}

export function useDeleteMaterial(classId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (materialId: number) => apiDelete(`/api/materials/${materialId}`),
    onSuccess: (_data, materialId) => {
      client.removeQueries({ queryKey: queryKeys.material(materialId) });
      return invalidateClassAndCourse(client, classId);
    },
  });
}

export function useGenerate(classId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<GenerationJob>(`/api/classes/${classId}/generate`),
    // A failed POST (e.g. 409) may still mean the class changed under us.
    onSettled: () => invalidateClassAndCourse(client, classId),
  });
}

/** Starts the quiz of a ready class, or builds it again from scratch after a failed attempt. */
export function useRegenerateQuiz(classId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<GenerationJob>(`/api/classes/${classId}/quiz/regenerate`),
    // A failed POST (e.g. 409) may still mean the jobs changed under us. The "courses" prefix
    // covers the course's quiz library.
    onSettled: () => invalidateClassAndCourse(client, classId),
  });
}
