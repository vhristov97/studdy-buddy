/** A unique constraint was violated, e.g. a class number that already exists in the course. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Drizzle may wrap the driver error as `cause`, so check the whole chain. */
export function isUniqueViolation(err: unknown): boolean {
  for (let current = err; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  }
  return false;
}
