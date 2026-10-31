import { Link } from "react-router";
import { useClassVisualizations } from "../api/hooks";
import styles from "./VisualizationLinks.module.css";

/** The class's released visualizations as links; renders nothing until there is one. */
export function ClassVisualizationLinks({ classId }: { classId: number }) {
  const query = useClassVisualizations(classId);
  if (!query.data || query.data.length === 0) return null;
  return (
    <section className={styles.box} aria-labelledby="class-viz-heading">
      <h2 id="class-viz-heading" className={styles.heading}>
        Vizualizacije za ovu lekciju
      </h2>
      <ul className={styles.list}>
        {query.data.map((viz) => (
          <li key={viz.id}>
            <Link to={`/vizualizacije/${viz.id}`}>{viz.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
