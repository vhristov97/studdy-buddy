import type { SubmissionDetail } from "@studdy/shared";
import { ApiError } from "../api/client";
import { useGradeSubmission } from "../api/hooks";
import { formatDecimal } from "../lib/format";
import { Button } from "./Button";
import { MarkdownView } from "./MarkdownView";
import { Spinner } from "./Spinner";
import styles from "./GradingStatus.module.css";

export function gradeErrorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Pokretanje ocenjivanja nije uspelo.";
}

/** The grading state of a submission, shown under its score. */
export function GradingStatusLine({
  submission,
  openCount,
}: {
  submission: SubmissionDetail;
  /** Open questions in the quiz; each is worth 1 point, graded or not ("Ne znam", empty). */
  openCount: number;
}) {
  const grade = useGradeSubmission();
  const { grading } = submission;

  if (grading.status === "done" && grading.result) {
    const max = submission.autoMax + openCount;
    return (
      <div className={styles.line} role="status">
        <strong>
          Ukupno: {formatDecimal(grading.result.totalScore)} / {max}
        </strong>
        <span className={styles.muted}>
          (automatski {formatDecimal(submission.autoScore)} + otvorena{" "}
          {formatDecimal(grading.result.openScore)})
        </span>
      </div>
    );
  }

  if (grading.status === "failed") {
    return (
      <div className={`${styles.line} ${styles.failed}`}>
        <p className={styles.error} role="alert">
          Ocenjivanje nije uspelo{grading.error ? `: ${grading.error}` : "."}
        </p>
        <Button
          variant="primary"
          onClick={() => grade.mutate(submission.id)}
          disabled={grade.isPending}
        >
          Oceni ponovo
        </Button>
        {grade.isError && (
          <p className={styles.error} role="alert">
            {gradeErrorText(grade.error)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.line}>
      <Spinner label="Ocenjivanje otvorenih pitanja je u toku…" />
    </div>
  );
}

/** The write-up and the fixed misconceptions of a graded submission. */
export function GradingReport({ submission }: { submission: SubmissionDetail }) {
  const result = submission.grading.result;
  if (submission.grading.status !== "done" || !result) return null;
  return (
    <section className={styles.report} aria-label="Rezultati ocenjivanja">
      {result.correctFixes.length > 0 && (
        <div>
          <h2 className={styles.heading}>Ispravljene zablude iz beleški</h2>
          <ul className={styles.fixes}>
            {result.correctFixes.map((fix, i) => (
              <li key={i}>
                <strong>{fix.topic}:</strong> {fix.misconception}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className={styles.writeup}>
        <summary>Izveštaj</summary>
        <MarkdownView source={result.writeupMd} />
      </details>
    </section>
  );
}
