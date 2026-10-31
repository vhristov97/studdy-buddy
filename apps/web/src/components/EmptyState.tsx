import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

export function EmptyState({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <p className={styles.message}>{message}</p>
      {children}
    </div>
  );
}
