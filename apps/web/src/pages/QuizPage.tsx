import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import type { PublicQuiz, QuizScore, SubmissionAnswers, SubmissionDetail } from "@studdy/shared";
import { ApiError } from "../api/client";
import {
  useCourseQuizzes,
  useQuiz,
  useQuizSubmissions,
  useSubmission,
  useSubmitQuiz,
} from "../api/hooks";
import { Badge } from "../components/Badge";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { QueryBoundary } from "../components/QueryBoundary";
import { QuizQuestion } from "../components/QuizQuestion";
import { formatDateTime, formatDecimal, openAwaitingGrading } from "../lib/format";
import {
  buildAnswers,
  clearDraft,
  countAnswered,
  draftFromAnswers,
  isTextDraft,
  loadDraft,
  saveDraft,
  type DraftValue,
  type QuizDraft,
} from "../lib/quizAnswers";
import styles from "./QuizPage.module.css";

/** `/kursevi/:courseId/kvizovi`: opens the newest quiz of the course. */
export function CourseQuizzesPage() {
  const courseId = Number(useParams().courseId);
  const query = useCourseQuizzes(courseId);
  return (
    <QueryBoundary query={query} backTo="/" backLabel="Nazad na kurseve">
      {(quizzes) => {
        const newest = quizzes[0];
        return newest ? (
          <Navigate to={`/kvizovi/${newest.id}`} replace />
        ) : (
          <EmptyState message="Još nema kvizova.">
            <Link to={`/kursevi/${courseId}`}>Nazad na kurs</Link>
          </EmptyState>
        );
      }}
    </QueryBoundary>
  );
}

/** `/kvizovi/:quizId` (take the quiz) and `/kvizovi/:quizId/predaje/:submissionId` (a past one). */
export function QuizPage() {
  const params = useParams();
  const quizId = Number(params.quizId);
  const submissionId = params.submissionId === undefined ? null : Number(params.submissionId);
  const query = useQuiz(quizId);
  return (
    <QueryBoundary query={query} backTo="/" backLabel="Nazad na kurseve">
      {(quiz) => (
        <QuizView
          key={`${quiz.id}/${submissionId ?? "new"}`}
          quiz={quiz}
          submissionId={submissionId}
        />
      )}
    </QueryBoundary>
  );
}

function QuizView({ quiz, submissionId }: { quiz: PublicQuiz; submissionId: number | null }) {
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Kursevi", to: "/" },
          { label: quiz.courseName, to: `/kursevi/${quiz.courseId}` },
          ...(submissionId === null
            ? [{ label: `Kviz ${quiz.code}` }]
            : [{ label: `Kviz ${quiz.code}`, to: `/kvizovi/${quiz.id}` }, { label: "Predaja" }]),
        ]}
      />
      <QuizPicker quiz={quiz} />
      <header className={styles.header}>
        <p className={styles.eyebrow}>{quiz.courseName}</p>
        <h1 className={styles.title}>{quiz.title}</h1>
        <p className={styles.subtitle}>{quiz.subtitle}</p>
        {quiz.chips.length > 0 && (
          <ul className={styles.chips} aria-label="Oznake">
            {quiz.chips.map((chip) => (
              <li key={chip}>
                <Badge>{chip}</Badge>
              </li>
            ))}
          </ul>
        )}
      </header>

      {submissionId === null ? (
        <LivePlayer quiz={quiz} />
      ) : (
        <ReviewPlayer quiz={quiz} submissionId={submissionId} />
      )}
      <PastSubmissions quizId={quiz.id} currentId={submissionId} />
    </>
  );
}

function QuizPicker({ quiz }: { quiz: PublicQuiz }) {
  const navigate = useNavigate();
  const quizzes = useCourseQuizzes(quiz.courseId);
  const list = quizzes.data ?? [];
  if (list.length === 0) return null;
  // The current quiz is always listed, even if the library fetch is stale.
  const options = list.some((item) => item.id === quiz.id)
    ? list
    : [{ id: quiz.id, code: quiz.code, title: quiz.title }, ...list];
  return (
    <div className={styles.picker}>
      <label htmlFor="quiz-picker">Kviz</label>
      <select
        id="quiz-picker"
        value={String(quiz.id)}
        onChange={(e) => void navigate(`/kvizovi/${e.target.value}`)}
      >
        {options.map((item) => (
          <option key={item.id} value={String(item.id)}>
            {item.code} — {item.title}
          </option>
        ))}
      </select>
    </div>
  );
}

function scoreText(score: Pick<QuizScore, "autoScore" | "autoMax">): string {
  return `${formatDecimal(score.autoScore)} / ${score.autoMax}`;
}

function ScoreLine({
  submission,
  focusRef,
}: {
  submission: SubmissionDetail;
  focusRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div className={styles.score} ref={focusRef} tabIndex={-1} role="status">
      <strong>Rezultat: {scoreText(submission)}</strong>
      {submission.openPending > 0 && (
        <span className={styles.pending}>{openAwaitingGrading(submission.openPending)}</span>
      )}
    </div>
  );
}

function Questions({
  quiz,
  draft,
  onChange,
  submission,
}: {
  quiz: PublicQuiz;
  draft: QuizDraft;
  onChange?: (questionId: string, value: DraftValue | undefined) => void;
  submission: SubmissionDetail | null;
}) {
  const results = new Map(submission?.results.map((r) => [r.id, r]));
  const feedback = new Map(submission?.feedback.questions.map((f) => [f.id, f]));
  return (
    <ol className={styles.questions}>
      {quiz.questions.map((question, index) => (
        <li key={question.id}>
          <QuizQuestion
            index={index}
            question={question}
            value={draft[question.id]}
            onChange={(value) => onChange?.(question.id, value)}
            locked={submission !== null}
            result={results.get(question.id)}
            feedback={feedback.get(question.id)}
          />
        </li>
      ))}
    </ol>
  );
}

function isEmptyValue(value: DraftValue | undefined): boolean {
  return value === undefined || (isTextDraft(value) && !value.dontKnow && value.text === "");
}

function LivePlayer({ quiz }: { quiz: PublicQuiz }) {
  const [draft, setDraft] = useState<QuizDraft>(() => loadDraft(quiz));
  const [submission, setSubmission] = useState<SubmissionDetail | null>(null);
  const [warnedFor, setWarnedFor] = useState<number | null>(null);
  const [attempt, setAttempt] = useState<{
    submittedAt: string;
    answers: SubmissionAnswers;
  } | null>(null);
  const submit = useSubmitQuiz(quiz.id);
  const bottomScore = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (submission) return;
    saveDraft(quiz.id, draft);
  }, [quiz.id, draft, submission]);

  useEffect(() => {
    if (submission) bottomScore.current?.focus();
  }, [submission]);

  const total = quiz.questions.length;
  const answered = countAnswered(quiz, draft);
  const unanswered = total - answered;

  const setValue = (questionId: string, value: DraftValue | undefined) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (isEmptyValue(value)) delete next[questionId];
      else next[questionId] = value as DraftValue;
      return next;
    });
  };

  const onSubmit = () => {
    if (unanswered > 0 && warnedFor !== unanswered) {
      setWarnedFor(unanswered);
      return;
    }
    const answers = buildAnswers(quiz, draft);
    setAttempt({ submittedAt: new Date().toISOString(), answers });
    submit.mutate(answers, {
      onSuccess: (detail) => {
        clearDraft(quiz.id);
        setSubmission(detail);
      },
    });
  };

  const reset = () => {
    setDraft({});
    setSubmission(null);
    setWarnedFor(null);
    setAttempt(null);
    submit.reset();
    clearDraft(quiz.id);
  };

  if (submission) {
    return (
      <>
        <ScoreLine submission={submission} />
        <Questions
          quiz={quiz}
          draft={draftFromAnswers(quiz, submission.answers)}
          submission={submission}
        />
        <ScoreLine submission={submission} focusRef={bottomScore} />
        <div className={styles.actions}>
          <Button variant="primary" onClick={reset}>
            Pokušaj ponovo
          </Button>
        </div>
      </>
    );
  }

  const error = submit.isError ? submit.error : null;
  const validation = error instanceof ApiError && error.status === 400 ? error : null;
  const details =
    validation && Array.isArray(validation.details)
      ? validation.details.filter((d): d is string => typeof d === "string")
      : [];

  return (
    <>
      <div
        className={styles.progress}
        role="progressbar"
        aria-label="Odgovorena pitanja"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={answered}
        aria-valuetext={`${answered} od ${total}`}
      >
        <div className={styles.progressText}>
          Odgovoreno {answered} od {total}
        </div>
        <div className={styles.progressTrack}>
          <div
            className={styles.progressBar}
            style={{ width: `${total === 0 ? 0 : (answered / total) * 100}%` }}
          />
        </div>
      </div>

      <Questions quiz={quiz} draft={draft} onChange={setValue} submission={null} />

      <div className={styles.actions}>
        {unanswered > 0 && warnedFor === unanswered && (
          <p className={styles.warning} role="alert">
            Nisi odgovorio na {unanswered} {unanswered === 1 ? "pitanje" : "pitanja"}. Klikni ponovo
            da predaš.
          </p>
        )}
        {validation && (
          <div className={styles.errorBox} role="alert">
            {details.length > 0 ? (
              <>
                <p>Odgovori nisu ispravni:</p>
                <ul>
                  {details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{validation.message}</p>
            )}
          </div>
        )}
        {error && !validation && attempt && <SaveFallback attempt={attempt} quizId={quiz.id} />}
        <Button variant="primary" onClick={onSubmit} disabled={submit.isPending}>
          {submit.isPending ? "Predajem…" : "Predaj kviz"}
        </Button>
      </div>
    </>
  );
}

function SaveFallback({
  attempt,
  quizId,
}: {
  attempt: { submittedAt: string; answers: SubmissionAnswers };
  quizId: number;
}) {
  const [copy, setCopy] = useState<"idle" | "ok" | "failed">("idle");
  const area = useRef<HTMLTextAreaElement>(null);
  const json = JSON.stringify({ quizId, ...attempt }, null, 2);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopy("ok");
    } catch {
      area.current?.select();
      setCopy("failed");
    }
  };
  return (
    <div className={styles.fallback} role="alert">
      <p>
        Predaja nije uspela. Tvoji odgovori su sačuvani u ovom pregledaču; možeš ih kopirati i
        poslati tutoru ili pokušati ponovo.
      </p>
      <label htmlFor="submission-json" className={styles.srOnly}>
        Odgovori u JSON formatu
      </label>
      <textarea
        id="submission-json"
        ref={area}
        readOnly
        rows={8}
        value={json}
        onFocus={(e) => e.currentTarget.select()}
        className={styles.json}
      />
      <div className={styles.copyRow}>
        <Button onClick={() => void onCopy()}>Kopiraj</Button>
        {copy === "ok" && <span role="status">Kopirano</span>}
        {copy === "failed" && (
          <span role="status">
            Kopiranje nije uspelo. Označi tekst (Ctrl+A) i kopiraj ga ručno.
          </span>
        )}
      </div>
    </div>
  );
}

function ReviewPlayer({ quiz, submissionId }: { quiz: PublicQuiz; submissionId: number }) {
  const query = useSubmission(submissionId);
  return (
    <QueryBoundary query={query} backTo={`/kvizovi/${quiz.id}`} backLabel="Nazad na kviz">
      {(submission) =>
        submission.quizId !== quiz.id ? (
          <EmptyState message="Ova predaja ne pripada ovom kvizu.">
            <Link to={`/kvizovi/${quiz.id}`}>Nazad na kviz</Link>
          </EmptyState>
        ) : (
          <>
            <p className={styles.reviewNote}>
              Predaja od {formatDateTime(submission.submittedAt)}. Odgovori se samo pregledaju.
            </p>
            <ScoreLine submission={submission} />
            <Questions
              quiz={quiz}
              draft={draftFromAnswers(quiz, submission.answers)}
              submission={submission}
            />
            <ScoreLine submission={submission} />
            <div className={styles.actions}>
              <Link to={`/kvizovi/${quiz.id}`} className={styles.retakeLink}>
                Pokušaj ponovo
              </Link>
            </div>
          </>
        )
      }
    </QueryBoundary>
  );
}

function PastSubmissions({ quizId, currentId }: { quizId: number; currentId: number | null }) {
  const query = useQuizSubmissions(quizId);
  if (!query.data || query.data.length === 0) return null;
  return (
    <section className={styles.past} aria-labelledby="past-heading">
      <h2 id="past-heading">Ranije predaje</h2>
      <ul>
        {query.data.map((item) => (
          <li key={item.id}>
            <Link
              to={`/kvizovi/${quizId}/predaje/${item.id}`}
              aria-current={item.id === currentId ? "page" : undefined}
            >
              {formatDateTime(item.submittedAt)}
            </Link>
            <span>{scoreText(item)}</span>
            {item.openPending > 0 && (
              <span className={styles.pastPending}>{openAwaitingGrading(item.openPending)}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
