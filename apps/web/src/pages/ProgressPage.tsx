import { Link, useParams } from "react-router";
import type {
  BacklogReason,
  CourseProgress,
  GradingStatus,
  ProgressBacklogItem,
  ProgressQuizHistoryEntry,
} from "@studdy/shared";
import { useCourse, useCourseProgress, useGradeSubmission } from "../api/hooks";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { gradeErrorText } from "../components/GradingStatus";
import { QueryBoundary } from "../components/QueryBoundary";
import { RatingChip } from "../components/TrackingTable";
import { formatClassNumber, formatDateTime, formatDecimal } from "../lib/format";
import styles from "./ProgressPage.module.css";

const REASON_LABELS: Record<BacklogReason, string> = {
  weak: "slabo",
  gap: "ne znam",
  left_out: "izostavljeno iz kviza",
};

const GRADING_LABELS: Record<Exclude<GradingStatus, "done">, string> = {
  none: "čeka ocenjivanje",
  running: "ocenjivanje u toku",
  failed: "ocenjivanje nije uspelo",
};

/** `/kursevi/:courseId/napredak`: where the student stands (spec sections 6, 9 and 14). */
export function ProgressPage() {
  const courseId = Number(useParams().courseId);
  const course = useCourse(courseId);
  const query = useCourseProgress(courseId);
  return (
    <QueryBoundary query={query} backTo="/" backLabel="Nazad na kurseve">
      {(progress) => (
        <>
          <Breadcrumbs
            items={[
              { label: "Kursevi", to: "/" },
              { label: course.data?.name ?? "Kurs", to: `/kursevi/${courseId}` },
              { label: "Napredak" },
            ]}
          />
          <h1 className={styles.title}>Napredak</h1>
          <ProgressView progress={progress} />
        </>
      )}
    </QueryBoundary>
  );
}

function ProgressView({ progress }: { progress: CourseProgress }) {
  return (
    <>
      <Flags progress={progress} />
      <Section id="next" title="Sledeće">
        <NextSteps steps={progress.nextSteps} />
      </Section>
      <Section id="backlog" title="Obavezno u K…">
        <Backlog items={progress.backlog} />
      </Section>
      <Section id="topics" title="Pregled tema">
        <Topics topics={progress.topics} />
      </Section>
      <Section id="history" title="Istorija kvizova">
        <History entries={progress.quizHistory} />
      </Section>
      <Section id="observations" title="Zapažanja">
        <Observations observations={progress.observations} />
      </Section>
    </>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={`progress-${id}`}>
      <h2 id={`progress-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

function Flags({ progress }: { progress: CourseProgress }) {
  const { classesWithoutLesson, ungradedSubmissions } = progress.flags;
  if (classesWithoutLesson.length === 0 && ungradedSubmissions.length === 0) return null;
  const history = new Map(progress.quizHistory.map((entry) => [entry.submissionId, entry]));
  return (
    <section className={styles.flags} aria-label="Šta čeka">
      {classesWithoutLesson.length > 0 && (
        <div>
          <h2 className={styles.flagHeading}>
            Predavanja sa materijalima bez objedinjenih beleški
          </h2>
          <ul className={styles.flagList}>
            {classesWithoutLesson.map((item) => (
              <li key={item.classId}>
                <Link to={`/predavanja/${item.classId}`}>
                  {formatClassNumber(item.number)} — {item.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ungradedSubmissions.length > 0 && (
        <div>
          <h2 className={styles.flagHeading}>Neocenjene predaje</h2>
          <ul className={styles.flagList}>
            {ungradedSubmissions.map((item) => (
              <UngradedItem
                key={item.submissionId}
                submissionId={item.submissionId}
                quizCode={item.quizCode}
                submittedAt={item.submittedAt}
                entry={history.get(item.submissionId)}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function UngradedItem({
  submissionId,
  quizCode,
  submittedAt,
  entry,
}: {
  submissionId: number;
  quizCode: string;
  submittedAt: string;
  entry: ProgressQuizHistoryEntry | undefined;
}) {
  const grade = useGradeSubmission();
  const label = `${quizCode} · ${formatDateTime(submittedAt)}`;
  const running = entry?.gradingStatus === "running";
  return (
    <li className={styles.flagItem}>
      {entry ? (
        <Link to={`/kvizovi/${entry.quizId}/predaje/${submissionId}`}>{label}</Link>
      ) : (
        <span>{label}</span>
      )}
      {running ? (
        <span className={styles.muted}>ocenjivanje u toku</span>
      ) : (
        <Button onClick={() => grade.mutate(submissionId)} disabled={grade.isPending}>
          Oceni
        </Button>
      )}
      {grade.isError && (
        <p className={styles.error} role="alert">
          {gradeErrorText(grade.error)}
        </p>
      )}
    </li>
  );
}

function NextSteps({ steps }: { steps: string[] }) {
  if (steps.length === 0) {
    return <EmptyState message="Još nema predloga. Pojaviće se posle prvog ocenjenog kviza." />;
  }
  return (
    <ol className={styles.steps}>
      {steps.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
  );
}

function dueNumber(code: string): number {
  const n = Number(code.replace(/\D/g, ""));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function Backlog({ items }: { items: ProgressBacklogItem[] }) {
  if (items.length === 0) return <EmptyState message="Nema obaveznih tema za kumulativni test." />;
  const groups = new Map<string, ProgressBacklogItem[]>();
  for (const item of items) groups.set(item.dueQuiz, [...(groups.get(item.dueQuiz) ?? []), item]);
  const ordered = [...groups.entries()].sort(
    (a, b) => dueNumber(a[0]) - dueNumber(b[0]) || a[0].localeCompare(b[0]),
  );
  return (
    <div className={styles.backlog}>
      {ordered.map(([dueQuiz, list]) => (
        <div key={dueQuiz}>
          <h3 className={styles.groupHeading}>Obavezno u {dueQuiz}</h3>
          <ul className={styles.backlogList}>
            {list.map((item, i) => (
              <li key={i}>
                <strong>{item.topic}</strong>
                <span className={styles.muted}>
                  {" "}
                  · predavanje {formatClassNumber(item.classNumber)} · {REASON_LABELS[item.reason]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Topics({ topics }: { topics: CourseProgress["topics"] }) {
  if (topics.length === 0)
    return <EmptyState message="Još nema tema. Generiši objedinjene beleške." />;
  return (
    <table className={styles.table}>
      <caption className={styles.srOnly}>Pregled tema</caption>
      <thead>
        <tr>
          <th scope="col" className={styles.colClass}>
            Predavanje
          </th>
          <th scope="col">Tema</th>
          <th scope="col" className={styles.colRating}>
            Ocena
          </th>
          <th scope="col">Testirano</th>
          <th scope="col">Poslednja napomena</th>
        </tr>
      </thead>
      <tbody>
        {topics.map((topic) => (
          <tr key={topic.id}>
            <td data-label="Predavanje" className={styles.classCell}>
              {formatClassNumber(topic.classNumber)}
            </td>
            <th scope="row" className={styles.topic}>
              {topic.name}
              {topic.deferred && <span className={styles.muted}> (odloženo)</span>}
            </th>
            <td data-label="Ocena" className={styles.ratingCell}>
              <RatingChip rating={topic.rating} />
            </td>
            <td data-label="Testirano" data-empty={topic.testedRefs.length === 0 || undefined}>
              {topic.testedRefs.length > 0 ? topic.testedRefs.join(", ") : "—"}
            </td>
            <td data-label="Poslednja napomena" data-empty={topic.lastNote === null || undefined}>
              {topic.lastNote ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function historyScore(entry: ProgressQuizHistoryEntry): string {
  const auto = `auto ${formatDecimal(entry.autoScore)}/${entry.autoMax}`;
  if (entry.gradingStatus === "done" && entry.openScore !== null) {
    return `${auto} + otvorena ${formatDecimal(entry.openScore)}`;
  }
  const status = GRADING_LABELS[entry.gradingStatus === "done" ? "none" : entry.gradingStatus];
  return `${auto} · ${status}`;
}

function History({ entries }: { entries: ProgressQuizHistoryEntry[] }) {
  if (entries.length === 0) return <EmptyState message="Još nema predatih kvizova." />;
  return (
    <ul className={styles.history}>
      {entries.map((entry) => (
        <li key={entry.submissionId} className={styles.historyItem}>
          <div className={styles.historyHead}>
            <Link to={`/kvizovi/${entry.quizId}/predaje/${entry.submissionId}`}>
              <strong>{entry.code}</strong> — {entry.title}
            </Link>
            <span className={styles.muted}>{formatDateTime(entry.submittedAt)}</span>
          </div>
          <p className={styles.historyScore}>
            <span>{historyScore(entry)}</span>
            {entry.totalScore !== null && (
              <strong>Ukupno: {formatDecimal(entry.totalScore)}</strong>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Observations({ observations }: { observations: string[] }) {
  if (observations.length === 0) {
    return <EmptyState message="Još nema zapažanja o tvom učenju." />;
  }
  return (
    <>
      <p className={styles.muted}>Zapažanja su zajednička za sve kurseve.</p>
      <ul className={styles.observations}>
        {observations.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ul>
    </>
  );
}
