import styles from "./Spinner.module.css";

export function Spinner({ label = "Učitavanje…" }: { label?: string }) {
  return (
    <p className={styles.spinner} role="status">
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </p>
  );
}
