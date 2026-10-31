import type { MaterialSummary } from "@studdy/shared";
import { Link } from "react-router";
import { countPages, formatBytes, mimeLabel } from "../lib/format";
import { Button } from "./Button";
import styles from "./MaterialItem.module.css";

interface MaterialItemProps {
  item: MaterialSummary;
  /** Present only while the class can still change. */
  onDelete?: (item: MaterialSummary) => void;
}

export function MaterialItem({ item, onDelete }: MaterialItemProps) {
  const meta = [
    mimeLabel(item.mime),
    formatBytes(item.sizeBytes),
    item.mime === "application/pdf" && item.pageCount !== null ? countPages(item.pageCount) : null,
  ].filter(Boolean);

  return (
    <li className={styles.item}>
      <div className={styles.main}>
        <span className={styles.name}>{item.originalName}</span>
        <span className={styles.meta}>{meta.join(" · ")}</span>
        {item.extractionStatus === "failed" && (
          <span className={styles.failed}>
            <strong>Izdvajanje teksta nije uspelo</strong>
            {item.extractionError && <> — {item.extractionError}</>}
          </span>
        )}
      </div>
      <div className={styles.actions}>
        <Link
          to={`/materijali/${item.id}`}
          className={styles.open}
          aria-label={`Otvori ${item.originalName}`}
        >
          Otvori
        </Link>
        {onDelete && (
          <Button
            variant="danger"
            onClick={() => onDelete(item)}
            aria-label={`Obriši ${item.originalName}`}
          >
            Obriši
          </Button>
        )}
      </div>
    </li>
  );
}
