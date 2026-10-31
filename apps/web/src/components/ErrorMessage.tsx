import styles from "./ErrorMessage.module.css";

export function ErrorMessage({ children }: { children: string }) {
  return (
    <p className={styles.error} role="alert">
      {children}
    </p>
  );
}
