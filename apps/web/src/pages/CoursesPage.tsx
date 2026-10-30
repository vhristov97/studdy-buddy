import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
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

export function CoursesPage() {
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
    <section>
      <h1>Kursevi</h1>
      <p className={styles.empty}>Još nema kurseva.</p>
      <p className={`${styles.status} ${styles[status]}`} role="status">
        {STATUS_TEXT[status]}
      </p>
    </section>
  );
}
