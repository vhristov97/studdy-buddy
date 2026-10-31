export const queryKeys = {
  courses: ["courses"] as const,
  course: (id: number) => ["courses", id] as const,
  class: (id: number) => ["classes", id] as const,
  classJobs: (id: number) => ["classes", id, "jobs"] as const,
  lesson: (id: number) => ["classes", id, "lesson"] as const,
  material: (id: number) => ["materials", id] as const,
  materialFile: (id: number) => ["materials", id, "file"] as const,
};
