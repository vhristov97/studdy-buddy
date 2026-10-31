import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { GenerationJob, VisualizationSummary, VizSuggestion } from "@studdy/shared";
import { ApiError } from "../api/client";
import {
  useClassJobs,
  useClassVisualizations,
  useCreateVizSuggestion,
  useRegenerateViz,
  useRegenerateVizTopics,
  useSelectVizSuggestions,
  useVizSuggestions,
} from "../api/hooks";
import { queryKeys } from "../api/keys";
import { stageLabel } from "../lib/pipeline";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { ErrorMessage } from "./ErrorMessage";
import { TextArea, TextField } from "./Field";
import { Spinner } from "./Spinner";
import styles from "./VizSection.module.css";

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

interface Props {
  classId: number;
  /** Shorter version for the lesson page: no controls/scenarios and no form for own topics. */
  compact?: boolean;
  /** Where "Dodaj svoju temu" leads in the compact version. */
  classPath?: string;
}

/**
 * Visualization topics of a ready class: pick which suggestions to build, add own topics and
 * follow each build. Nothing is built unasked. Live state comes from the jobs query, which the
 * pipeline panel's event stream keeps current.
 */
export function VizSection({ classId, compact = false, classPath }: Props) {
  const suggestions = useVizSuggestions(classId);
  const visualizations = useClassVisualizations(classId);
  const jobsQuery = useClassJobs(classId);
  const jobs = jobsQuery.data ?? [];
  const client = useQueryClient();

  const select = useSelectVizSuggestions(classId);
  const regenerateTopics = useRegenerateVizTopics(classId);
  const regenerateViz = useRegenerateViz(classId);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());

  const topicsJob = jobs.find((job) => job.kind === "viz_topics");
  const all = suggestions.data ?? [];
  const open = all.filter((item) => !item.selected);
  const chosen = all.filter((item) => item.selected);
  const built = visualizations.data ?? [];

  // Right after "Napravi izabrane" the jobs appear a moment later: poll until each has one.
  const loaded = jobsQuery.isSuccess && suggestions.isSuccess && visualizations.isSuccess;
  const waitingForJob =
    loaded &&
    chosen.some(
      (item) =>
        !jobs.some((job) => job.kind === "viz" && job.suggestionId === item.id) &&
        !built.some((viz) => viz.suggestionId === item.id),
    );
  useEffect(() => {
    if (!waitingForJob) return;
    const timer = setInterval(
      () => void client.invalidateQueries({ queryKey: queryKeys.classJobs(classId) }),
      1000,
    );
    return () => clearInterval(timer);
  }, [waitingForJob, client, classId]);

  const toggle = (id: number) =>
    setChecked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const build = () => {
    const ids = open.filter((item) => checked.has(item.id)).map((item) => item.id);
    if (ids.length === 0) return;
    select.mutate(ids, { onSuccess: () => setChecked(new Set()) });
  };

  const identifying = topicsJob?.status === "running";
  const topicsFailed = topicsJob?.status === "failed";

  return (
    <section
      className={compact ? `${styles.section} ${styles.compact}` : styles.section}
      aria-labelledby={`viz-heading-${classId}`}
    >
      <h2 id={`viz-heading-${classId}`}>Vizualizacije</h2>
      {!compact && (
        <p className={styles.hint}>
          Interaktivne vizualizacije pomažu da razjasniš teške pojmove. Ništa se ne pravi dok ne
          izabereš teme.
        </p>
      )}

      {identifying && <Spinner label="Tražim teme za vizualizacije…" />}
      {topicsFailed && (
        <ErrorMessage>
          {`Traženje tema nije uspelo${topicsJob.error ? `: ${topicsJob.error}` : "."}`}
        </ErrorMessage>
      )}
      {!identifying && (topicsFailed || (loaded && !topicsJob && all.length === 0)) && (
        <div className={styles.actions}>
          {!topicsJob && <p className={styles.hint}>Teme još nisu predložene.</p>}
          <Button
            variant="primary"
            onClick={() => regenerateTopics.mutate()}
            disabled={regenerateTopics.isPending}
          >
            Predloži teme
          </Button>
        </div>
      )}
      {regenerateTopics.isError && (
        <ErrorMessage>
          {errorText(regenerateTopics.error, "Predlaganje tema nije uspelo.")}
        </ErrorMessage>
      )}

      {suggestions.isError && <ErrorMessage>Teme se nisu učitale.</ErrorMessage>}

      {open.length > 0 && (
        <>
          <h3 className={styles.subheading}>Predložene teme</h3>
          <ul className={styles.list}>
            {open.map((item) => (
              <li key={item.id} className={styles.item}>
                <SuggestionCheck
                  suggestion={item}
                  checked={checked.has(item.id)}
                  onToggle={() => toggle(item.id)}
                  compact={compact}
                />
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={build}
              disabled={checked.size === 0 || select.isPending}
            >
              Napravi izabrane
            </Button>
            {select.isError && (
              <ErrorMessage>{errorText(select.error, "Pravljenje nije uspelo.")}</ErrorMessage>
            )}
          </div>
        </>
      )}

      {chosen.length > 0 && (
        <>
          <h3 className={styles.subheading}>Izabrane teme</h3>
          <ul className={styles.list}>
            {chosen.map((item) => (
              <li key={item.id} className={styles.item}>
                <ChosenRow
                  suggestion={item}
                  job={jobs.find((job) => job.kind === "viz" && job.suggestionId === item.id)}
                  visualization={built.find((viz) => viz.suggestionId === item.id)}
                  onRegenerate={() => regenerateViz.mutate(item.id)}
                  regenerating={regenerateViz.isPending}
                />
              </li>
            ))}
          </ul>
          {regenerateViz.isError && (
            <ErrorMessage>
              {errorText(regenerateViz.error, "Pravljenje ispočetka nije uspelo.")}
            </ErrorMessage>
          )}
        </>
      )}

      {!all.some((item) => item.origin === "agent") &&
        !identifying &&
        topicsJob?.status === "succeeded" && (
          <EmptyState message="Za ovu lekciju nema predloga za vizualizacije." />
        )}

      {compact ? (
        classPath && (
          <p className={styles.hint}>
            <Link to={classPath}>Dodaj svoju temu</Link> na stranici predavanja.
          </p>
        )
      ) : (
        <CustomTopicForm classId={classId} />
      )}
    </section>
  );
}

function SuggestionCheck({
  suggestion,
  checked,
  onToggle,
  compact,
}: {
  suggestion: VizSuggestion;
  checked: boolean;
  onToggle: () => void;
  compact: boolean;
}) {
  const hasDetails = suggestion.controls.length > 0 || suggestion.scenarios.length > 0;
  return (
    <>
      <label className={styles.check}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className={styles.checkText}>
          <span className={styles.head}>
            <strong className={styles.concept}>{suggestion.concept}</strong>
            {suggestion.origin === "user" && <Badge tone="info">tvoja tema</Badge>}
            {suggestion.section && <span className={styles.sectionPath}>{suggestion.section}</span>}
          </span>
          <span className={styles.summary}>{suggestion.summary}</span>
        </span>
      </label>
      {!compact && hasDetails && (
        <details className={styles.details}>
          <summary>Kontrole i scenariji</summary>
          {suggestion.controls.length > 0 && (
            <>
              <h4>Kontrole</h4>
              <ul>
                {suggestion.controls.map((control) => (
                  <li key={control}>{control}</li>
                ))}
              </ul>
            </>
          )}
          {suggestion.scenarios.length > 0 && (
            <>
              <h4>Scenariji</h4>
              <ul>
                {suggestion.scenarios.map((scenario) => (
                  <li key={scenario}>{scenario}</li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
    </>
  );
}

function ChosenRow({
  suggestion,
  job,
  visualization,
  onRegenerate,
  regenerating,
}: {
  suggestion: VizSuggestion;
  job: GenerationJob | undefined;
  visualization: VisualizationSummary | undefined;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  return (
    <>
      <span className={styles.head}>
        <strong className={styles.concept}>{suggestion.concept}</strong>
        {suggestion.origin === "user" && <Badge tone="info">tvoja tema</Badge>}
      </span>
      {visualization ? (
        <p className={styles.status}>
          <Badge tone="success">Gotovo</Badge>
          <Link to={`/vizualizacije/${visualization.id}`}>{visualization.title}</Link>
        </p>
      ) : job?.status === "failed" ? (
        <>
          <ErrorMessage>{job.error ?? "Pravljenje vizualizacije nije uspelo."}</ErrorMessage>
          <Button onClick={onRegenerate} disabled={regenerating}>
            Napravi ispočetka
          </Button>
        </>
      ) : job?.status === "succeeded" ? (
        <p className={styles.status}>
          <Badge tone="success">Gotovo</Badge>
        </p>
      ) : (
        <p className={styles.status}>
          <Spinner label={job ? (stageLabel(job) ?? "Izrada") : "Čeka na početak…"} />
        </p>
      )}
    </>
  );
}

function CustomTopicForm({ classId }: { classId: number }) {
  const create = useCreateVizSuggestion(classId);
  const [concept, setConcept] = useState("");
  const [note, setNote] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = concept.trim();
    if (!trimmed) return;
    create.mutate(
      { concept: trimmed, note: note.trim() || null },
      {
        onSuccess: () => {
          setConcept("");
          setNote("");
        },
      },
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-labelledby={`viz-add-${classId}`}>
      <h3 id={`viz-add-${classId}`} className={styles.subheading}>
        Dodaj svoju temu
      </h3>
      <TextField
        label="Pojam"
        required
        value={concept}
        maxLength={200}
        onChange={(event) => setConcept(event.target.value)}
      />
      <TextArea
        label="Napomena (nije obavezno)"
        helper="Šta želiš da vidiš ili isprobaš."
        value={note}
        maxLength={2000}
        onChange={(event) => setNote(event.target.value)}
      />
      <Button type="submit" disabled={concept.trim() === "" || create.isPending}>
        Dodaj temu
      </Button>
      {create.isError && (
        <ErrorMessage>{errorText(create.error, "Dodavanje teme nije uspelo.")}</ErrorMessage>
      )}
    </form>
  );
}
