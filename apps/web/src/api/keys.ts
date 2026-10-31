export const queryKeys = {
  courses: ["courses"] as const,
  course: (id: number) => ["courses", id] as const,
  class: (id: number) => ["classes", id] as const,
  material: (id: number) => ["materials", id] as const,
  materialFile: (id: number) => ["materials", id, "file"] as const,
};
