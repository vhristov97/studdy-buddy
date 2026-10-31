import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ClassDetail,
  ClassSummary,
  CourseDetail,
  CourseProgress,
  CourseSummary,
  CreateClassInput,
  CreateCourseInput,
  CreateVizSuggestionInput,
  CourseVisualization,
  ClassJobs,
  GenerationJob,
  LessonView,
  MaterialDetail,
  MaterialSummary,
  PublicQuiz,
  QuizSummary,
  SubmissionAnswers,
  SubmissionDetail,
  SubmissionSummary,
  UpdateClassInput,
  UpdateCourseInput,
  VisualizationDetail,
  VisualizationSummary,
  VizSuggestion,
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

/** Visualization topics of a class: the agent's suggestions and the student's own. */
export function useVizSuggestions(classId: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.classVizSuggestions(classId),
    queryFn: () => apiGet<VizSuggestion[]>(`/api/classes/${classId}/viz-suggestions`),
    enabled,
  });
}

/** Released visualizations of a class, oldest first. */
export function useClassVisualizations(classId: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.classVisualizations(classId),
    queryFn: () => apiGet<VisualizationSummary[]>(`/api/classes/${classId}/visualizations`),
    enabled,
  });
}

/** Released visualizations of every class of a course. */
export function useCourseVisualizations(courseId: number) {
  return useQuery({
    queryKey: queryKeys.courseVisualizations(courseId),
    queryFn: () => apiGet<CourseVisualization[]>(`/api/courses/${courseId}/visualizations`),
  });
}

/** One visualization with its context; the page itself is served at /viz/:id. */
export function useVisualization(id: number) {
  return useQuery({
    queryKey: queryKeys.visualization(id),
    queryFn: () => apiGet<VisualizationDetail>(`/api/visualizations/${id}`),
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

/** A quiz as the student sees it: no answers, explanations or key points. */
export function useQuiz(id: number) {
  return useQuery({
    queryKey: queryKeys.quiz(id),
    queryFn: () => apiGet<PublicQuiz>(`/api/quizzes/${id}`),
  });
}

/** Past submissions of a quiz, newest first. */
export function useQuizSubmissions(quizId: number) {
  return useQuery({
    queryKey: queryKeys.quizSubmissions(quizId),
    queryFn: () => apiGet<SubmissionSummary[]>(`/api/quizzes/${quizId}/submissions`),
  });
}

/** How often a submission is refetched while its open questions are being graded. */
export const GRADING_POLL_MS = 5000;

/** Grading has not produced a result yet and nothing says it failed. */
export function isGradingPending(submission: SubmissionDetail | undefined): boolean {
  return submission !== undefined && ["none", "running"].includes(submission.grading.status);
}

/**
 * One submission with its feedback (correct answers, explanations, key points). Refetched every
 * few seconds while grading runs. `initialData` (the POST response) skips the first fetch.
 */
export function useSubmission(id: number, initialData?: SubmissionDetail) {
  return useQuery({
    queryKey: queryKeys.submission(id),
    queryFn: () => apiGet<SubmissionDetail>(`/api/submissions/${id}`),
    initialData,
    staleTime: initialData ? Infinity : 0,
    refetchInterval: (query) => (isGradingPending(query.state.data) ? GRADING_POLL_MS : false),
  });
}

/** Several submissions at once (to label grading jobs); shares the cache with {@link useSubmission}. */
export function useSubmissions(ids: readonly number[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: queryKeys.submission(id),
      queryFn: () => apiGet<SubmissionDetail>(`/api/submissions/${id}`),
    })),
  });
}

export const PROGRESS_POLL_MS = 5000;

/**
 * Progress of a course: Sledeće, backlog, topic mastery, quiz history, observations, flags.
 * Refetches every few seconds while any submission is being graded, so finished results appear.
 */
export function useCourseProgress(courseId: number) {
  return useQuery({
    queryKey: queryKeys.courseProgress(courseId),
    queryFn: () => apiGet<CourseProgress>(`/api/courses/${courseId}/progress`),
    refetchInterval: (query) =>
      query.state.data?.quizHistory.some((q) => q.gradingStatus === "running")
        ? PROGRESS_POLL_MS
        : false,
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

export function useSubmitQuiz(quizId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (answers: SubmissionAnswers) =>
      apiPost<SubmissionDetail>(`/api/quizzes/${quizId}/submissions`, { answers }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.quizSubmissions(quizId) }),
  });
}

/** Starts (or restarts, after a failure) the grading of a submission. A 409 means it already runs. */
export function useGradeSubmission() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (submissionId: number) =>
      apiPost<GenerationJob>(`/api/submissions/${submissionId}/grade`),
    onSettled: (_data, _error, submissionId) =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.submission(submissionId) }),
        // The progress of every course and the class jobs shown in the panels.
        client.invalidateQueries({ queryKey: ["courses"] }),
        client.invalidateQueries({ queryKey: ["classes"] }),
      ]),
  });
}

/** Adds a visualization topic of the student's own. */
export function useCreateVizSuggestion(classId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVizSuggestionInput) =>
      apiPost<VizSuggestion>(`/api/classes/${classId}/viz-suggestions`, input),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.classVizSuggestions(classId) }),
  });
}

/** Starts building the chosen suggestions (one job each). */
export function useSelectVizSuggestions(classId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) =>
      apiPost<VizSuggestion[]>(`/api/classes/${classId}/viz-suggestions/select`, { ids }),
    // The class prefix also covers the jobs, which show up a moment after the POST.
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.class(classId) }),
  });
}

/** Asks the identifier for topics again (first time or after a failure). */
export function useRegenerateVizTopics(classId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<GenerationJob>(`/api/classes/${classId}/viz-topics/regenerate`),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.class(classId) }),
  });
}

/** Plans and builds a selected visualization again from scratch after a failure. */
export function useRegenerateViz(classId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (suggestionId: number) =>
      apiPost<GenerationJob>(`/api/viz-suggestions/${suggestionId}/regenerate`),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.class(classId) }),
  });
}
