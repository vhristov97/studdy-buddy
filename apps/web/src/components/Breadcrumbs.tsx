import { Link } from "react-router";
import styles from "./Breadcrumbs.module.css";

export interface Crumb {
  label: string;
  to?: string;
}

/** The last crumb is the current page and has no link. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Putanja" className={styles.nav}>
      <ol className={styles.list}>
        {items.map((item, index) => (
          <li key={index} className={styles.item}>
            {item.to ? (
              <Link to={item.to}>{item.label}</Link>
            ) : (
              <span aria-current="page">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
