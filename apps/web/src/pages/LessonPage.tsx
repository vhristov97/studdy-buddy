import { Link, useParams } from "react-router";
import type { ClassDetail } from "@studdy/shared";
import { ApiError } from "../api/client";
import { useClass, useLesson } from "../api/hooks";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { EmptyState } from "../components/EmptyState";
import { ErrorMessage } from "../components/ErrorMessage";
import { LessonMarkdown } from "../components/LessonMarkdown";
import { LessonTag } from "../components/LessonTag";
import { PipelinePanel } from "../components/PipelinePanel";
import { QueryBoundary } from "../components/QueryBoundary";
import { Spinner } from "../components/Spinner";
import { TrackingTable } from "../components/TrackingTable";
import { formatClassNumber } from "../lib/format";
import styles from "./LessonPage.module.css";

export function LessonPage() {
  const classId = Number(useParams().classId);
  const query = useClass(classId);
  return (
    <QueryBoundary query={query} backTo="/" backLabel="Nazad na kurseve">
      {(detail) => <LessonView detail={detail} />}
    </QueryBoundary>
  );
}

function Legend() {
  return (
    <section className={styles.legend} aria-label="Legenda">
      <ul>
        <li>
          <LessonTag tag="P" /> napomena predavača iz tvojih beleški
        </li>
        <li>
          <LessonTag tag="D" /> dodatak tutora
        </li>
        <li>Stavke bez oznake potiču iz slajdova.</li>
        <li>
          <strong>⚠️ Ispravka</strong> ispravlja netačnost u beleškama, <strong>❓ Pitanje</strong>{" "}
          je pitanje za tebe, <strong>⏳ Odloženo</strong> je tema koja se obrađuje kasnije.
        </li>
      </ul>
    </section>
  );
}

function LessonView({ detail }: { detail: ClassDetail }) {
  const lesson = useLesson(detail.id);
  const label = `${formatClassNumber(detail.number)} — ${detail.title}`;
  const classPath = `/predavanja/${detail.id}`;

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Kursevi", to: "/" },
          { label: detail.courseName, to: `/kursevi/${detail.courseId}` },
          { label, to: classPath },
          { label: "Objedinjene beleške" },
        ]}
      />
      <h1 className={styles.title}>{label}</h1>

      {detail.status !== "draft" && (
        <details className={styles.pipeline} open={detail.status !== "ready"}>
          <summary>Tok generisanja</summary>
          <PipelinePanel
            key={detail.id}
            classId={detail.id}
            courseId={detail.courseId}
            classStatus={detail.status}
          />
        </details>
      )}

      {lesson.isPending ? (
        <Spinner />
      ) : lesson.isError ? (
        lesson.error instanceof ApiError && lesson.error.status === 404 ? (
          <EmptyState message="Objedinjene beleške još nisu generisane.">
            <Link to={classPath}>Nazad na predavanje</Link>
          </EmptyState>
        ) : (
          <ErrorMessage>
            {lesson.error instanceof ApiError
              ? lesson.error.message
              : "Došlo je do greške. Pokušajte ponovo."}
          </ErrorMessage>
        )
      ) : (
        <>
          <Legend />
          <article aria-label="Objedinjene beleške" className={styles.lesson}>
            <LessonMarkdown source={lesson.data.bodyMd} />
          </article>
          <section aria-labelledby="tracking-heading" className={styles.tracking}>
            <h2 id="tracking-heading">Praćenje znanja</h2>
            <TrackingTable topics={lesson.data.topics} />
          </section>
        </>
      )}
    </>
  );
}
