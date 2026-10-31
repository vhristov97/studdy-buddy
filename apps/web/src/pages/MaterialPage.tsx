import { useState } from "react";
import { Link, useParams } from "react-router";
import type { MaterialDetail } from "@studdy/shared";
import { useMaterial, useMaterialText } from "../api/hooks";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { ExtractedTextView, MarkdownView } from "../components/MarkdownView";
import { QueryBoundary } from "../components/QueryBoundary";
import { Spinner } from "../components/Spinner";
import { mimeLabel } from "../lib/format";
import styles from "./MaterialPage.module.css";

export function MaterialPage() {
  const materialId = Number(useParams().materialId);
  const query = useMaterial(materialId);
  return (
    <QueryBoundary query={query} backTo="/" backLabel="Nazad na kurseve">
      {(material) => <MaterialView material={material} />}
    </QueryBoundary>
  );
}

function MaterialView({ material }: { material: MaterialDetail }) {
  const [showText, setShowText] = useState(false);
  const fileUrl = `/api/materials/${material.id}/file`;

  return (
    <>
      <p className={styles.back}>
        <Link to={`/predavanja/${material.classId}`}>← Nazad na predavanje</Link>
      </p>
      <header className={styles.header}>
        <h1 className={styles.title}>{material.originalName}</h1>
        <Badge>{mimeLabel(material.mime)}</Badge>
      </header>

      <section aria-label="Sadržaj" className={styles.viewer}>
        {material.mime === "application/pdf" && (
          <iframe src={fileUrl} title={`PDF: ${material.originalName}`} className={styles.frame} />
        )}
        {material.mime === "text/html" && (
          <iframe
            src={fileUrl}
            title={`HTML: ${material.originalName}`}
            sandbox=""
            className={styles.frame}
          />
        )}
        {material.mime === "text/markdown" && <NoteContent id={material.id} />}
      </section>

      <section className={styles.text}>
        <Button aria-expanded={showText} onClick={() => setShowText((current) => !current)}>
          {showText ? "Sakrij izdvojeni tekst" : "Prikaži izdvojeni tekst"}
        </Button>
        {showText && (
          <div className={styles.extracted}>
            {material.extractionStatus === "failed" ? (
              <ErrorMessage>
                {`Izdvajanje teksta nije uspelo${
                  material.extractionError ? `: ${material.extractionError}` : "."
                }`}
              </ErrorMessage>
            ) : material.extractedText ? (
              <ExtractedTextView text={material.extractedText} />
            ) : (
              <p className={styles.none}>Nema izdvojenog teksta.</p>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function NoteContent({ id }: { id: number }) {
  const text = useMaterialText(id, true);
  if (text.isPending) return <Spinner />;
  if (text.isError) return <ErrorMessage>Beleška se nije učitala.</ErrorMessage>;
  return (
    <article className={styles.note}>
      <MarkdownView source={text.data} />
    </article>
  );
}
