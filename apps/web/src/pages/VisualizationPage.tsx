import { useParams } from "react-router";
import type { VisualizationDetail } from "@studdy/shared";
import { useVisualization } from "../api/hooks";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { QueryBoundary } from "../components/QueryBoundary";
import { formatClassNumber } from "../lib/format";
import styles from "./VisualizationPage.module.css";

export function VisualizationPage() {
  const id = Number(useParams().vizId);
  const query = useVisualization(id);
  return (
    <QueryBoundary query={query} backTo="/" backLabel="Nazad na kurseve">
      {(detail) => <VisualizationView detail={detail} />}
    </QueryBoundary>
  );
}

function VisualizationView({ detail }: { detail: VisualizationDetail }) {
  const pageUrl = `/viz/${detail.id}`;
  const classLabel = `${formatClassNumber(detail.classNumber)} — ${detail.className}`;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Kursevi", to: "/" },
          { label: detail.courseName, to: `/kursevi/${detail.courseId}` },
          { label: classLabel, to: `/predavanja/${detail.classId}` },
          { label: detail.title },
        ]}
      />
      <header className={styles.header}>
        <h1 className={styles.title}>{detail.title}</h1>
        <a href={pageUrl} target="_blank" rel="noopener noreferrer" className={styles.open}>
          Otvori u novom prozoru
        </a>
      </header>
      {detail.misconception && (
        <p className={styles.misconception}>
          <strong>Ciljana zabluda:</strong> {detail.misconception}
        </p>
      )}
      {/* No allow-same-origin: the page runs in an opaque origin, apart from the app. */}
      <iframe
        className={styles.frame}
        src={pageUrl}
        sandbox="allow-scripts"
        title={`Vizualizacija: ${detail.title}`}
      />
    </>
  );
}
