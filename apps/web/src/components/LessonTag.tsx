import { SOURCE_TAGS, type SourceTag } from "../lib/lessonRemark";
import styles from "./LessonTag.module.css";

/** The small "P" / "D" chip that marks where a lesson item comes from. */
export function LessonTag({ tag }: { tag: SourceTag }) {
  const label = SOURCE_TAGS[tag];
  return (
    <span className={`${styles.tag} ${styles[tag === "P" ? "tagP" : "tagD"]}`} title={label}>
      <span aria-hidden="true">{tag}</span>
      <span className={styles.srOnly}>{label}</span>
    </span>
  );
}
