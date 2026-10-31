import { useId } from "react";
import {
  DONT_KNOW,
  type GradingItem,
  type GradingOpenGrade,
  type PublicQuestion,
  type QuestionFeedback,
  type QuestionResult,
} from "@studdy/shared";
import { formatDecimal, formatExact } from "../lib/format";
import {
  getMatchDraft,
  getTextDraft,
  parseDecimal,
  type DraftValue,
  type MatchDraft,
} from "../lib/quizAnswers";
import { Badge } from "./Badge";
import { MarkdownView } from "./MarkdownView";
import styles from "./QuizQuestion.module.css";

const DONT_KNOW_LABEL = "Ne znam";

type Tone = "correct" | "wrong" | "partial" | "dontKnow" | "unanswered" | "pending";

function statusOf(result: QuestionResult): { label: string; tone: Tone } {
  switch (result.status) {
    case "correct":
      return { label: "Tačno", tone: "correct" };
    case "wrong":
      return { label: "Netačno", tone: "wrong" };
    case "partial":
      return {
        label: `Delimično (${result.correctRows ?? 0}/${result.totalRows ?? 0})`,
        tone: "partial",
      };
    case "dont_know":
      return { label: DONT_KNOW_LABEL, tone: "dontKnow" };
    case "unanswered":
      return { label: "Bez odgovora", tone: "unanswered" };
    case "open_pending":
      return { label: "Čeka ocenjivanje", tone: "pending" };
  }
}

/** The status chip of an open question once the grader has scored it. */
function gradedStatus(grade: GradingOpenGrade): { label: string; tone: Tone } {
  const tone: Tone = grade.score >= 1 ? "correct" : grade.score <= 0 ? "wrong" : "partial";
  return { label: `Ocena: ${formatDecimal(grade.score)} / 1`, tone };
}

interface Props {
  index: number;
  question: PublicQuestion;
  value: DraftValue | undefined;
  /** Replaces the value; undefined clears it. */
  onChange: (value: DraftValue | undefined) => void;
  /** Read-only: after a submission, and when viewing a past one. */
  locked: boolean;
  result?: QuestionResult;
  feedback?: QuestionFeedback;
  /** The grader's score for an open question (replaces its "waiting" chip). */
  openGrade?: GradingOpenGrade;
  /** The grader's classification of what was missed in this question. */
  gradingItems?: readonly GradingItem[];
}

export function QuizQuestion({
  index,
  question,
  value,
  onChange,
  locked,
  result,
  feedback,
  openGrade,
  gradingItems,
}: Props) {
  const id = useId();
  const promptId = `${id}-prompt`;
  const status = openGrade ? gradedStatus(openGrade) : result ? statusOf(result) : null;
  const toneClass = status ? styles[`card_${status.tone}`] : "";
  const explanation =
    feedback && feedback.type !== "open" && feedback.type === question.type
      ? feedback.explanation
      : null;

  return (
    <article
      className={`${styles.card} ${toneClass}`}
      aria-labelledby={promptId}
      data-question={question.id}
    >
      <header className={styles.head}>
        <span className={styles.number}>Pitanje {index + 1}</span>
        <span className={styles.ref}>{question.ref}</span>
        {question.extra && <Badge tone="info">dodatak tutora</Badge>}
        {status && (
          <span className={`${styles.status} ${styles[`status_${status.tone}`]}`}>
            {status.label}
          </span>
        )}
      </header>

      <div id={promptId} className={styles.prompt}>
        <MarkdownView source={question.prompt} />
      </div>

      {question.type === "mc" && (
        <McInput
          id={id}
          labelId={promptId}
          question={question}
          value={value}
          onChange={onChange}
          locked={locked}
          feedback={feedback?.type === "mc" ? feedback : undefined}
        />
      )}
      {question.type === "num" && (
        <NumInput
          id={id}
          question={question}
          value={value}
          onChange={onChange}
          locked={locked}
          feedback={feedback?.type === "num" ? feedback : undefined}
        />
      )}
      {question.type === "match" && (
        <MatchInput
          id={id}
          question={question}
          value={value}
          onChange={onChange}
          locked={locked}
          feedback={feedback?.type === "match" ? feedback : undefined}
        />
      )}
      {question.type === "open" && (
        <OpenInput
          id={id}
          question={question}
          value={value}
          onChange={onChange}
          locked={locked}
          feedback={feedback?.type === "open" ? feedback : undefined}
        />
      )}

      {explanation && (
        <div className={styles.explanation}>
          <strong>Objašnjenje</strong>
          <MarkdownView source={explanation} />
        </div>
      )}

      {openGrade && (
        <div className={styles.grade}>
          <p>
            <strong>Tačno:</strong> {openGrade.right}
          </p>
          <p>
            <strong>Nedostaje:</strong> {openGrade.missing}
          </p>
        </div>
      )}

      {gradingItems && gradingItems.length > 0 && (
        <ul className={styles.gradingNotes} aria-label="Beleške ocenjivača">
          {gradingItems.map((item, i) => (
            <li key={i} className={styles[`note_${item.classification}`]}>
              <GradingNote item={item} question={question} />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function GradingNote({ item, question }: { item: GradingItem; question: PublicQuestion }) {
  const row =
    item.rowIndex !== null && question.type === "match" ? question.rows[item.rowIndex] : null;
  return (
    <>
      {row && <strong className={styles.noteRow}>{row}: </strong>}
      {item.classification === "gap" && <strong>Ne znam — prvo učimo ovo.</strong>}
      {item.classification === "misconception" && (
        <>
          <strong>Zabluda:</strong> {item.misconception ?? item.studentAnswer ?? "—"}
        </>
      )}
      {item.classification === "partial" && <strong>Nepotpun odgovor.</strong>}
      {item.classification === "misconception" && item.likelyCause && (
        <span className={styles.noteLine}>
          <strong>Verovatan uzrok:</strong> {item.likelyCause}
        </span>
      )}
      <span className={styles.noteLine}>
        <strong>Ključna činjenica:</strong> {item.keyFact}
      </span>
    </>
  );
}

interface InputProps<Q extends PublicQuestion, F extends QuestionFeedback> {
  id: string;
  question: Q;
  value: DraftValue | undefined;
  onChange: (value: DraftValue | undefined) => void;
  locked: boolean;
  feedback?: F;
}

type Of<T extends PublicQuestion["type"]> = Extract<PublicQuestion, { type: T }>;
type FbOf<T extends QuestionFeedback["type"]> = Extract<QuestionFeedback, { type: T }>;

function McInput({
  id,
  labelId,
  question,
  value,
  onChange,
  locked,
  feedback,
}: InputProps<Of<"mc">, FbOf<"mc">> & { labelId: string }) {
  const options: { key: string; text: string; choice: number | typeof DONT_KNOW }[] = [
    ...question.options.map((text, i) => ({ key: String(i), text, choice: i })),
    { key: "dk", text: DONT_KNOW_LABEL, choice: DONT_KNOW },
  ];
  return (
    <div role="radiogroup" aria-labelledby={labelId} className={styles.options}>
      {options.map(({ key, text, choice }) => {
        const chosen = value === choice;
        const correct = feedback !== undefined && choice === feedback.answer;
        const marks = [
          chosen && locked ? "tvoj odgovor" : null,
          correct ? "tačan odgovor" : null,
        ].filter(Boolean);
        const cls = [
          styles.option,
          choice === DONT_KNOW ? styles.optionDontKnow : "",
          correct ? styles.optionCorrect : "",
          feedback && chosen && !correct && choice !== DONT_KNOW ? styles.optionWrong : "",
          feedback && chosen && choice === DONT_KNOW ? styles.optionDontKnowChosen : "",
        ].join(" ");
        return (
          <label key={key} className={cls}>
            <input
              type="radio"
              name={id}
              checked={chosen}
              disabled={locked}
              onChange={() => onChange(choice)}
            />
            <span className={styles.optionText}>{text}</span>
            {marks.length > 0 && <span className={styles.mark}>{marks.join(" · ")}</span>}
          </label>
        );
      })}
    </div>
  );
}

function DontKnowCheckbox({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.dontKnow}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{DONT_KNOW_LABEL}</span>
    </label>
  );
}

function NumInput({
  id,
  question,
  value,
  onChange,
  locked,
  feedback,
}: InputProps<Of<"num">, FbOf<"num">>) {
  const draft = getTextDraft(value);
  const invalid = !locked && draft.text.trim() !== "" && parseDecimal(draft.text) === null;
  const inputId = `${id}-num`;
  const errorId = `${id}-num-error`;
  return (
    <div>
      <div className={styles.numRow}>
        <label htmlFor={inputId} className={styles.srOnly}>
          Odgovor (broj)
        </label>
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className={styles.control}
          value={draft.dontKnow ? "" : draft.text}
          disabled={draft.dontKnow}
          readOnly={locked}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(e) => onChange({ text: e.target.value, dontKnow: false })}
        />
        {question.unit && <span className={styles.unit}>{question.unit}</span>}
        <DontKnowCheckbox
          checked={draft.dontKnow}
          disabled={locked}
          onChange={(checked) => onChange(checked ? { text: "", dontKnow: true } : undefined)}
        />
      </div>
      {invalid && (
        <p id={errorId} className={styles.fieldError}>
          Unesi broj, npr. 3,5.
        </p>
      )}
      {feedback && (
        <p className={styles.correctAnswer}>
          <strong>Tačan odgovor:</strong> {formatExact(feedback.answer)}
          {feedback.tolerance > 0 && ` ± ${formatExact(feedback.tolerance)}`}
          {feedback.unit ? ` ${feedback.unit}` : ""}
        </p>
      )}
    </div>
  );
}

function MatchInput({
  id,
  question,
  value,
  onChange,
  locked,
  feedback,
}: InputProps<Of<"match">, FbOf<"match">>) {
  const rows: MatchDraft = getMatchDraft(value);
  const setRow = (i: number, raw: string) => {
    const next: MatchDraft = { ...rows };
    if (raw === "") delete next[String(i)];
    else next[String(i)] = raw === DONT_KNOW ? DONT_KNOW : Number(raw);
    onChange(Object.keys(next).length === 0 ? undefined : next);
  };
  return (
    <ul className={styles.matchRows}>
      {question.rows.map((row, i) => {
        const chosen = rows[String(i)];
        const selectId = `${id}-row-${i}`;
        const right = feedback?.answer[i];
        let verdict: { text: string; tone: string } | null = null;
        if (feedback && right !== undefined) {
          const correctText = question.choices[right] ?? "";
          if (chosen === right) verdict = { text: "Tačno", tone: styles.rowCorrect ?? "" };
          else if (chosen === DONT_KNOW) {
            verdict = {
              text: `Ne znam. Tačan odgovor: ${correctText}`,
              tone: styles.rowDontKnow ?? "",
            };
          } else if (chosen === undefined) {
            verdict = {
              text: `Bez odgovora. Tačan odgovor: ${correctText}`,
              tone: styles.rowUnanswered ?? "",
            };
          } else {
            verdict = {
              text: `Netačno. Tačan odgovor: ${correctText}`,
              tone: styles.rowWrong ?? "",
            };
          }
        }
        return (
          <li key={i} className={styles.matchRow}>
            <label htmlFor={selectId} className={styles.matchLabel}>
              {row}
            </label>
            <select
              id={selectId}
              className={styles.control}
              value={chosen === undefined ? "" : String(chosen)}
              disabled={locked}
              onChange={(e) => setRow(i, e.target.value)}
            >
              <option value="">— izaberi —</option>
              {question.choices.map((choice, c) => (
                <option key={c} value={String(c)}>
                  {choice}
                </option>
              ))}
              <option value={DONT_KNOW}>{DONT_KNOW_LABEL}</option>
            </select>
            {verdict && <p className={`${styles.rowVerdict} ${verdict.tone}`}>{verdict.text}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function OpenInput({
  id,
  value,
  onChange,
  locked,
  feedback,
}: InputProps<Of<"open">, FbOf<"open">>) {
  const draft = getTextDraft(value);
  const inputId = `${id}-open`;
  return (
    <div>
      <label htmlFor={inputId} className={styles.srOnly}>
        Odgovor
      </label>
      <textarea
        id={inputId}
        className={styles.control}
        rows={5}
        placeholder="Objasni svojim rečima, kao na usmenom…"
        value={draft.dontKnow ? "" : draft.text}
        disabled={draft.dontKnow}
        readOnly={locked}
        onChange={(e) => onChange({ text: e.target.value, dontKnow: false })}
      />
      <DontKnowCheckbox
        checked={draft.dontKnow}
        disabled={locked}
        onChange={(checked) => onChange(checked ? { text: "", dontKnow: true } : undefined)}
      />
      {feedback && (
        <div className={styles.keyPoints}>
          <strong>Ključne tačke za poređenje</strong>
          <ul>
            {feedback.keyPoints.map((point, i) => (
              <li key={i}>
                <MarkdownView source={point} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
