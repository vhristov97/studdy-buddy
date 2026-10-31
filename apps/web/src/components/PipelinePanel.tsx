import { useEffect, useState } from "react";
import type { ClassStatus, GenerationJob } from "@studdy/shared";
import { useClassEvents } from "../api/events";
import { useClassJobs } from "../api/hooks";
import { groupJobs, JOB_KIND_LABELS, mergeJobs } from "../lib/pipeline";
import { formatCount, formatDuration, plural } from "../lib/format";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import styles from "./PipelinePanel.module.css";

/** The current time, refreshed every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

interface PanelProps {
  classId: number;
  classStatus: ClassStatus;
  /** Shows a "Pokušaj ponovo" button on a failed stage; leave out where retrying is offered elsewhere. */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * Pipeline status of a class: its jobs from the API, kept live over SSE while something runs.
 * Renders nothing until the class has a job. Give it a `key` per class.
 */
export function PipelinePanel({ classId, classStatus, onRetry, retrying }: PanelProps) {
  const jobsQuery = useClassJobs(classId, classStatus !== "draft");
  const fetched = jobsQuery.data;
  const generating =
    classStatus === "generating" || fetched?.some((job) => job.status === "running");
  const live = useClassEvents(classId, generating === true);
  const jobs = mergeJobs(fetched ?? [], live.jobs, classId);
  const now = useNow(jobs.some((job) => job.status === "running"));

  if (jobs.length === 0) return null;
  return (
    <PipelineStages
      jobs={jobs}
      progress={live.progress}
      now={now}
      onRetry={classStatus === "failed" ? onRetry : undefined}
      retrying={retrying}
    />
  );
}

interface StagesProps {
  /** Newest first. */
  jobs: readonly GenerationJob[];
  progress: ReadonlyMap<number, number>;
  now: number;
  onRetry?: () => void;
  retrying?: boolean;
}

export function PipelineStages({ jobs, progress, now, onRetry, retrying }: StagesProps) {
  const groups = groupJobs(jobs);
  return (
    <section className={styles.panel} aria-labelledby="pipeline-heading">
      <h2 id="pipeline-heading" className={styles.heading}>
        Tok generisanja
      </h2>
      <div aria-live="polite">
        <ul className={styles.stages}>
          {groups.map(({ kind, latest, earlier }) => (
            <li key={kind} className={styles.stage}>
              <JobRow
                job={latest}
                label={JOB_KIND_LABELS[kind]}
                chars={progress.get(latest.id)}
                now={now}
              />
              {latest.status === "failed" && onRetry && (
                <Button variant="primary" onClick={onRetry} disabled={retrying}>
                  Pokušaj ponovo
                </Button>
              )}
              {earlier.length > 0 && (
                <details className={styles.earlier}>
                  <summary>
                    {`${plural(earlier.length, "Raniji pokušaj", "Ranija pokušaja", "Ranijih pokušaja")}: ${earlier.length}`}
                  </summary>
                  <ul className={styles.stages}>
                    {earlier.map((job) => (
                      <li key={job.id}>
                        <JobRow job={job} label={JOB_KIND_LABELS[kind]} now={now} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

interface RowProps {
  job: GenerationJob;
  label: string;
  /** Output so far; shown only while the job runs. */
  chars?: number;
  now: number;
}

function JobRow({ job, label, chars, now }: RowProps) {
  const running = job.status === "running";
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const duration = formatDuration(end - Date.parse(job.createdAt));
  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <strong className={styles.label}>{label}</strong>
        {running ? (
          <Spinner label="U toku…" />
        ) : (
          <span className={job.status === "failed" ? styles.failed : styles.succeeded}>
            {job.status === "failed" ? "Neuspešno" : "Završeno"}
          </span>
        )}
      </div>
      <p className={styles.meta}>
        {job.attempt > 1 && <span>pokušaj {job.attempt}</span>}
        <span>{duration}</span>
        {running && chars !== undefined && chars > 0 && (
          <span>~{formatCount(chars >= 1000 ? Math.round(chars / 100) * 100 : chars)} znakova</span>
        )}
      </p>
      {job.status === "failed" && job.error && (
        <p className={styles.error} role="alert">
          {job.error}
        </p>
      )}
    </div>
  );
}
