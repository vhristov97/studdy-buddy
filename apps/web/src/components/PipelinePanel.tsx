import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ClassStatus, GenerationJob, QuizSummary } from "@studdy/shared";
import { ApiError } from "../api/client";
import { useClassEvents } from "../api/events";
import {
  useClassJobs,
  useCourseQuizzes,
  useGradeSubmission,
  useRegenerateQuiz,
  useSubmissions,
} from "../api/hooks";
import { groupJobs, JOB_KIND_LABELS, mergeJobs, stageLabel } from "../lib/pipeline";
import { countQuestions, formatCount, formatDateTime, formatDuration, plural } from "../lib/format";
import { Button } from "./Button";
import { ErrorMessage } from "./ErrorMessage";
import { gradeErrorText } from "./GradingStatus";
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
  courseId: number;
  classStatus: ClassStatus;
  /** Shows a "Pokušaj ponovo" button on a failed stage; leave out where retrying is offered elsewhere. */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * Pipeline status of a class: its jobs from the API, kept live over SSE while something runs.
 * Renders nothing until the class has a job. Give it a `key` per class.
 */
export function PipelinePanel({ classId, courseId, classStatus, onRetry, retrying }: PanelProps) {
  const jobsQuery = useClassJobs(classId, classStatus !== "draft");
  const fetched = jobsQuery.data;
  const generating =
    classStatus === "generating" || fetched?.some((job) => job.status === "running");
  const live = useClassEvents(classId, generating === true);
  const jobs = mergeJobs(fetched ?? [], live.jobs, classId);
  const now = useNow(jobs.some((job) => job.status === "running"));
  const startQuiz = useRegenerateQuiz(classId);
  const latestQuiz = jobs.find((job) => job.kind === "quiz");
  const grade = useGradeSubmission();
  const gradingIds = [
    ...new Set(
      jobs.flatMap((job) => (job.kind === "grading" && job.submissionId ? [job.submissionId] : [])),
    ),
  ];
  const submissions = useSubmissions(gradingIds);
  const quizzes = useCourseQuizzes(
    courseId,
    latestQuiz?.status === "succeeded" || gradingIds.length > 0,
  );
  const gradingTargets = new Map<number, GradingTarget>();
  gradingIds.forEach((id, i) => {
    const submission = submissions[i]?.data;
    const quiz = quizzes.data?.find((item) => item.id === submission?.quizId);
    if (submission && quiz) {
      gradingTargets.set(id, {
        quizId: quiz.id,
        code: quiz.code,
        submittedAt: submission.submittedAt,
      });
    }
  });

  if (jobs.length === 0) return null;
  return (
    <PipelineStages
      jobs={jobs}
      progress={live.progress}
      now={now}
      onRetry={classStatus === "failed" ? onRetry : undefined}
      retrying={retrying}
      releasedQuiz={quizzes.data?.find((quiz) => quiz.classId === classId)}
      onStartQuiz={classStatus === "ready" ? () => startQuiz.mutate() : undefined}
      startingQuiz={startQuiz.isPending}
      startQuizError={startQuiz.isError ? startQuizErrorText(startQuiz.error) : null}
      gradingTargets={gradingTargets}
      onGrade={(submissionId) => grade.mutate(submissionId)}
      grading={grade.isPending}
      gradeError={
        grade.isError && grade.variables !== undefined
          ? { submissionId: grade.variables, message: gradeErrorText(grade.error) }
          : null
      }
    />
  );
}

function startQuizErrorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Pravljenje kviza nije uspelo.";
}

/** What a grading job grades: the quiz and the moment of the submission. */
export interface GradingTarget {
  quizId: number;
  code: string;
  /** ISO 8601. */
  submittedAt: string;
}

interface StagesProps {
  /** Newest first. */
  jobs: readonly GenerationJob[];
  progress: ReadonlyMap<number, number>;
  now: number;
  onRetry?: () => void;
  retrying?: boolean;
  /** The released quiz of this class, if known; shown on a succeeded quiz job. */
  releasedQuiz?: QuizSummary;
  /**
   * Starts the quiz again (failed job) or for the first time (class generated before quizzes
   * existed). Leave out unless the class is ready.
   */
  onStartQuiz?: () => void;
  startingQuiz?: boolean;
  startQuizError?: string | null;
  /** Grading jobs' submissions by id, for their label and link. */
  gradingTargets?: ReadonlyMap<number, GradingTarget>;
  /** Grades a submission again (failed grading job); leave out to hide the button. */
  onGrade?: (submissionId: number) => void;
  grading?: boolean;
  gradeError?: { submissionId: number; message: string } | null;
}

export function PipelineStages({
  jobs,
  progress,
  now,
  onRetry,
  retrying,
  releasedQuiz,
  onStartQuiz,
  startingQuiz,
  startQuizError,
  gradingTargets,
  onGrade,
  grading,
  gradeError,
}: StagesProps) {
  const groups = groupJobs(jobs);
  const lessonDone = groups.some(
    ({ kind, latest }) => kind === "lesson" && latest.status === "succeeded",
  );
  const offerFirstQuiz = onStartQuiz && lessonDone && !groups.some(({ kind }) => kind === "quiz");
  const quizButton = (label: string) => (
    <Button variant="primary" onClick={onStartQuiz} disabled={startingQuiz}>
      {label}
    </Button>
  );
  return (
    <section className={styles.panel} aria-labelledby="pipeline-heading">
      <h2 id="pipeline-heading" className={styles.heading}>
        Tok generisanja
      </h2>
      <div aria-live="polite">
        <ul className={styles.stages}>
          {groups.map(({ key, kind, latest, earlier }) => (
            <li key={key} className={styles.stage}>
              <JobRow
                job={latest}
                label={JOB_KIND_LABELS[kind]}
                gradingTarget={
                  latest.submissionId === null
                    ? undefined
                    : gradingTargets?.get(latest.submissionId)
                }
                chars={progress.get(latest.id)}
                now={now}
                released={kind === "quiz" ? releasedQuiz : undefined}
              />
              {kind === "lesson" && latest.status === "failed" && onRetry && (
                <Button variant="primary" onClick={onRetry} disabled={retrying}>
                  Pokušaj ponovo
                </Button>
              )}
              {kind === "quiz" && latest.status === "failed" && onStartQuiz && (
                <>
                  {quizButton("Napravi kviz ispočetka")}
                  {startQuizError && <ErrorMessage>{startQuizError}</ErrorMessage>}
                </>
              )}
              {kind === "grading" &&
                latest.status === "failed" &&
                latest.submissionId !== null &&
                onGrade && (
                  <>
                    <Button
                      variant="primary"
                      onClick={() => onGrade(latest.submissionId!)}
                      disabled={grading}
                    >
                      Oceni ponovo
                    </Button>
                    {gradeError?.submissionId === latest.submissionId && (
                      <ErrorMessage>{gradeError.message}</ErrorMessage>
                    )}
                  </>
                )}
              {earlier.length > 0 && (
                <details className={styles.earlier}>
                  <summary>
                    {`${plural(earlier.length, "Raniji pokušaj", "Ranija pokušaja", "Ranijih pokušaja")}: ${earlier.length}`}
                  </summary>
                  <ul className={styles.stages}>
                    {earlier.map((job) => (
                      <li key={job.id}>
                        <JobRow
                          job={job}
                          label={JOB_KIND_LABELS[kind]}
                          now={now}
                          gradingTarget={
                            job.submissionId === null
                              ? undefined
                              : gradingTargets?.get(job.submissionId)
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
          {offerFirstQuiz && (
            <li className={styles.stage}>
              <div className={styles.row}>
                <div className={styles.head}>
                  <strong className={styles.label}>{JOB_KIND_LABELS.quiz}</strong>
                  <span className={styles.idle}>Još nije napravljen</span>
                </div>
              </div>
              {quizButton("Napravi kviz")}
              {startQuizError && <ErrorMessage>{startQuizError}</ErrorMessage>}
            </li>
          )}
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
  /** The quiz this (succeeded) job released. */
  released?: QuizSummary;
  /** The submission this (grading) job grades. */
  gradingTarget?: GradingTarget;
}

function JobRow({ job, label, chars, now, released, gradingTarget }: RowProps) {
  const running = job.status === "running";
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const duration = formatDuration(end - Date.parse(job.createdAt));
  const step = running ? stageLabel(job) : null;
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
        {step && <span>{step}</span>}
        {job.status === "succeeded" && released && (
          <Link to={`/kvizovi/${released.id}`}>
            {`${released.code} · ${countQuestions(released.questionCount)}`}
          </Link>
        )}
        {gradingTarget && job.submissionId !== null && (
          <Link to={`/kvizovi/${gradingTarget.quizId}/predaje/${job.submissionId}`}>
            {`${gradingTarget.code} · ${formatDateTime(gradingTarget.submittedAt)}`}
          </Link>
        )}
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
