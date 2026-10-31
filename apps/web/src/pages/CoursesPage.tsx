import { useEffect, useState } from "react";
import { Link } from "react-router";
import { apiGet } from "../api/client";
import { useCourses, useCreateCourse } from "../api/hooks";
import { Button } from "../components/Button";
import { CourseForm } from "../components/CourseForm";
import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { ErrorMessage } from "../components/ErrorMessage";
import { Spinner } from "../components/Spinner";
import { countClasses } from "../lib/format";
import styles from "./CoursesPage.module.css";

type ServerStatus = "loading" | "up" | "down";

interface HealthResponse {
  status: string;
  db: string;
}

const STATUS_TEXT: Record<ServerStatus, string> = {
  loading: "Server: provera…",
  up: "Server: povezan",
  down: "Server: nedostupan",
};

function ServerStatusLine() {
  const [status, setStatus] = useState<ServerStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    apiGet<HealthResponse>("/api/health")
      .then((health) => {
        if (!cancelled) setStatus(health.status === "ok" ? "up" : "down");
      })
      .catch(() => {
        if (!cancelled) setStatus("down");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <p className={`${styles.status} ${styles[status]}`} role="status">
      {STATUS_TEXT[status]}
    </p>
  );
}

export function CoursesPage() {
  const courses = useCourses();
  const createCourse = useCreateCourse();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className={styles.heading}>
        <h1>Kursevi</h1>
        {courses.data && courses.data.length > 0 && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            Novi kurs
          </Button>
        )}
      </div>

      {courses.isPending && <Spinner />}
      {courses.isError && <ErrorMessage>Kursevi se nisu učitali.</ErrorMessage>}
      {courses.data?.length === 0 && (
        <EmptyState message="Još nema kurseva.">
          <Button variant="primary" onClick={() => setCreating(true)}>
            Novi kurs
          </Button>
        </EmptyState>
      )}
      {courses.data && courses.data.length > 0 && (
        <ul className={styles.list}>
          {courses.data.map((course) => (
            <li key={course.id} className={styles.card}>
              <h2 className={styles.cardTitle}>
                <Link to={`/kursevi/${course.id}`} className={styles.cardLink}>
                  {course.name}
                </Link>
              </h2>
              <p className={styles.meta}>{countClasses(course.classCount)}</p>
              {course.persona && <p className={styles.persona}>{course.persona}</p>}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title="Novi kurs">
        <CourseForm
          submitLabel="Napravi kurs"
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            await createCourse.mutateAsync(input);
            setCreating(false);
          }}
        />
      </Dialog>

      <ServerStatusLine />
    </>
  );
}
