import {
  MISCONCEPTION_OUTCOME,
  type TopicEvent,
  type TopicRating,
  type TopicView,
} from "@studdy/shared";
import { Badge } from "./Badge";
import styles from "./TrackingTable.module.css";

const RATINGS: Record<TopicRating, { label: string; className: string }> = {
  "?": { label: "Nije testirano", className: styles.unknown! },
  "✗": { label: "Slabo", className: styles.weak! },
  "~": { label: "Delimično", className: styles.partial! },
  "✓": { label: "Dobro", className: styles.good! },
};

/** The rating symbol with its label (visible on phones, read by screen readers elsewhere). */
export function RatingChip({ rating }: { rating: TopicRating }) {
  const info = RATINGS[rating];
  return (
    <span className={`${styles.rating} ${info.className}`} title={info.label}>
      <span aria-hidden="true">{rating}</span>
      <span className={styles.ratingLabel}>{info.label}</span>
    </span>
  );
}

/** Unique quiz codes in the order they were first taken. */
function testedRefs(events: readonly TopicEvent[]): string[] {
  const refs = events.flatMap((event) => (event.source === "quiz" && event.ref ? [event.ref] : []));
  return [...new Set(refs)];
}

function misconceptionNote(event: TopicEvent): string | null {
  if (!event.misconceptionText) return null;
  const fix = event.correctionText ? ` → ${event.correctionText}` : "";
  if (event.source === "notes" && event.outcome === MISCONCEPTION_OUTCOME) {
    return `Zabluda iz beleški: ${event.misconceptionText}${fix}`;
  }
  const where = event.ref ? ` (${event.ref})` : "";
  return `Zabluda${where}: ${event.misconceptionText}${fix}`;
}

function noteList(topic: TopicView): { id: number; text: string }[] {
  return topic.events.flatMap((event) => {
    const text = misconceptionNote(event);
    return text ? [{ id: event.id, text }] : [];
  });
}

function Notes({ topic, notes }: { topic: TopicView; notes: { id: number; text: string }[] }) {
  if (!topic.deferred && notes.length === 0) return <>—</>;
  return (
    <ul className={styles.notes}>
      {topic.deferred && (
        <li>
          <Badge>Odloženo</Badge>
          {topic.deferredNote && <span className={styles.deferredNote}> {topic.deferredNote}</span>}
        </li>
      )}
      {notes.map((note) => (
        <li key={note.id}>{note.text}</li>
      ))}
    </ul>
  );
}

/** "Praćenje znanja": one row per lesson topic, live from the DB. Rows become cards on phones. */
export function TrackingTable({ topics }: { topics: readonly TopicView[] }) {
  return (
    <table className={styles.table}>
      <caption className={styles.srOnly}>Praćenje znanja</caption>
      <thead>
        <tr>
          <th scope="col" className={styles.colTopic}>
            Tema
          </th>
          <th scope="col" className={styles.colRating}>
            Ocena
          </th>
          <th scope="col" className={styles.colTested}>
            Testirano
          </th>
          <th scope="col">Napomene</th>
        </tr>
      </thead>
      <tbody>
        {[...topics]
          .sort((a, b) => a.position - b.position)
          .map((topic) => {
            const refs = testedRefs(topic.events);
            const notes = noteList(topic);
            const noNotes = !topic.deferred && notes.length === 0;
            return (
              <tr key={topic.id}>
                <th scope="row" className={styles.topic}>
                  {topic.name}
                </th>
                <td data-label="Ocena" className={styles.ratingCell}>
                  <RatingChip rating={topic.rating} />
                </td>
                {/* Empty cells stay on desktop as a dash; phone cards hide them (data-empty). */}
                <td data-label="Testirano" data-empty={refs.length === 0 || undefined}>
                  {refs.length > 0 ? refs.join(", ") : "—"}
                </td>
                <td data-label="Napomene" data-empty={noNotes || undefined}>
                  <Notes topic={topic} notes={notes} />
                </td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}
