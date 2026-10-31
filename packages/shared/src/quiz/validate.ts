/**
 * The spec §7.3 quiz checker. Pure and independent of Zod so it works on raw JSON (builder
 * output, imported quizzes) and reports every problem instead of stopping at the first.
 */

export interface QuizIssue {
  severity: "error" | "warning";
  /** Stable machine-readable code, e.g. "mc_answer_range". */
  code: string;
  message: string;
  /** e.g. "questions[3].answer". */
  path: string;
  questionId?: string;
}

export interface QuizReport {
  errors: QuizIssue[];
  warnings: QuizIssue[];
  /** How often each option index (0..maxOptions-1) is the correct one across `mc` questions. */
  mcAnswerPositions: number[];
}

export interface ValidateQuizOptions {
  /** Codes of quizzes already in the library; a quiz reusing one is an error. */
  existingCodes?: Iterable<string>;
}

type Obj = Record<string, unknown>;

const QUESTION_TYPES = new Set(["mc", "num", "match", "open"]);
/** The correct option counts as standing out when longer than this multiple of the others' average. */
const STAND_OUT_RATIO = 1.5;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isIndex(value: unknown, length: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < length;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function validateQuiz(input: unknown, opts: ValidateQuizOptions = {}): QuizReport {
  const errors: QuizIssue[] = [];
  const warnings: QuizIssue[] = [];
  const mcAnswerPositions: number[] = [];
  let maxOptions = 0;
  const report = (): QuizReport => ({
    errors,
    warnings,
    // Zero-filled so every option index up to the largest mc question has a count.
    mcAnswerPositions: Array.from(
      { length: Math.max(maxOptions, mcAnswerPositions.length) },
      (_, i) => mcAnswerPositions[i] ?? 0,
    ),
  });

  const error = (code: string, message: string, path: string, questionId?: string) =>
    errors.push({ severity: "error", code, message, path, ...(questionId ? { questionId } : {}) });
  const warn = (code: string, message: string, path: string, questionId?: string) =>
    warnings.push({
      severity: "warning",
      code,
      message,
      path,
      ...(questionId ? { questionId } : {}),
    });

  if (!isObject(input)) {
    error("quiz_not_object", "The quiz must be an object.", "");
    return report();
  }

  for (const field of ["code", "title", "subtitle"] as const) {
    if (!isNonEmptyString(input[field])) {
      error(`missing_${field}`, `The quiz ${field} is missing or empty.`, field);
    }
  }
  if (isNonEmptyString(input.code) && opts.existingCodes) {
    for (const existing of opts.existingCodes) {
      if (existing === input.code) {
        error("duplicate_quiz_code", `Quiz code "${input.code}" is already in use.`, "code");
        break;
      }
    }
  }
  if (!isNonEmptyStringArray(input.chips)) {
    error("invalid_chips", "chips must be a non-empty array of non-empty strings.", "chips");
  }

  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    error("missing_questions", "The quiz needs a non-empty questions array.", "questions");
    return report();
  }

  const seenIds = new Set<string>();
  input.questions.forEach((raw: unknown, index: number) => {
    const path = `questions[${index}]`;
    if (!isObject(raw)) {
      error("question_not_object", "A question must be an object.", path);
      return;
    }
    const q = raw;
    const id = isNonEmptyString(q.id) ? q.id : undefined;
    const err = (code: string, message: string, field: string) =>
      error(code, message, `${path}.${field}`, id);
    const warnQ = (code: string, message: string, field: string) =>
      warn(code, message, `${path}.${field}`, id);

    if (!id) {
      err("missing_id", "The question id is missing or empty.", "id");
    } else if (seenIds.has(id)) {
      err("duplicate_question_id", `Duplicate question id "${id}".`, "id");
    } else {
      seenIds.add(id);
    }

    if (!isNonEmptyString(q.topic)) err("missing_topic", "The question topic is missing.", "topic");
    if (!isNonEmptyString(q.prompt)) {
      err("missing_prompt", "The question prompt is missing or empty.", "prompt");
    }
    if (!isNonEmptyString(q.ref))
      err("missing_ref", "The question ref is missing or empty.", "ref");

    const type = q.type;
    if (typeof type !== "string" || !QUESTION_TYPES.has(type)) {
      err("unknown_type", `Unknown question type ${JSON.stringify(type)}.`, "type");
      return;
    }

    if (type !== "open" && !isNonEmptyString(q.explanation)) {
      err("missing_explanation", "A closed question needs a non-empty explanation.", "explanation");
    }

    if (type === "mc") {
      const options = Array.isArray(q.options) ? q.options : undefined;
      if (!options || options.length < 2) {
        err("mc_options_count", "An mc question needs at least 2 options.", "options");
      } else {
        options.forEach((option, i) => {
          if (!isNonEmptyString(option)) {
            err("mc_empty_option", `Option ${i} is empty.`, `options[${i}]`);
          }
        });
      }
      const optionCount = options?.length ?? 0;
      maxOptions = Math.max(maxOptions, optionCount);
      if (!isIndex(q.answer, optionCount)) {
        err(
          "mc_answer_range",
          `The mc answer must be an integer index into the options (0..${Math.max(optionCount - 1, 0)}).`,
          "answer",
        );
      } else {
        mcAnswerPositions[q.answer] = (mcAnswerPositions[q.answer] ?? 0) + 1;
        if (options && options.length >= 2 && options.every(isNonEmptyString)) {
          const others = options.filter((_, i) => i !== q.answer) as string[];
          const average = others.reduce((sum, o) => sum + o.length, 0) / others.length;
          if ((options[q.answer] as string).length > STAND_OUT_RATIO * average) {
            warnQ(
              "mc_correct_stands_out",
              "The correct option is much longer than the others and may stand out.",
              "options",
            );
          }
        }
      }
    } else if (type === "num") {
      if (typeof q.answer !== "number" || !Number.isFinite(q.answer)) {
        err("num_answer", "A num answer must be a finite number.", "answer");
      }
      if (typeof q.tolerance !== "number" || !Number.isFinite(q.tolerance)) {
        err("num_tolerance", "A num tolerance must be a finite number.", "tolerance");
      } else if (q.tolerance < 0) {
        err("num_tolerance_negative", "A num tolerance must not be negative.", "tolerance");
      }
      if (!isNonEmptyString(q.unit)) {
        warnQ("num_missing_unit", "A num question should have a unit.", "unit");
      }
    } else if (type === "match") {
      const rowsOk = Array.isArray(q.rows) && q.rows.length > 0;
      const choicesOk = Array.isArray(q.choices) && q.choices.length > 0;
      if (!rowsOk) err("match_rows", "A match question needs a non-empty rows array.", "rows");
      if (!choicesOk) {
        err("match_choices", "A match question needs a non-empty choices array.", "choices");
      }
      if (rowsOk) {
        (q.rows as unknown[]).forEach((row, i) => {
          if (!isNonEmptyString(row)) {
            err("match_empty_row", `Row ${i} is empty or not a string.`, `rows[${i}]`);
          }
        });
      }
      if (choicesOk) {
        (q.choices as unknown[]).forEach((choice, i) => {
          if (!isNonEmptyString(choice)) {
            err("match_empty_choice", `Choice ${i} is empty or not a string.`, `choices[${i}]`);
          }
        });
      }
      const rowCount = rowsOk ? (q.rows as unknown[]).length : 0;
      const choiceCount = choicesOk ? (q.choices as unknown[]).length : 0;
      if (!Array.isArray(q.answer) || (rowsOk && q.answer.length !== rowCount)) {
        err(
          "match_answer_length",
          "A match answer must be an array with one entry per row.",
          "answer",
        );
      } else {
        const answer: unknown[] = q.answer;
        answer.forEach((entry, i) => {
          if (!isIndex(entry, choiceCount)) {
            err(
              "match_answer_range",
              `Answer ${i} must be an integer index into the choices (0..${Math.max(choiceCount - 1, 0)}).`,
              `answer[${i}]`,
            );
          }
        });
        if (answer.filter((entry, i) => entry === i).length > 1) {
          warnQ(
            "match_diagonal",
            "More than one row maps to the choice with its own index; vary the order.",
            "answer",
          );
        }
      }
    } else if (!isNonEmptyStringArray(q.keyPoints)) {
      err("open_key_points", "An open question needs non-empty key points.", "keyPoints");
    }
  });

  return report();
}

/** Validates every quiz and also flags quiz codes used more than once across the library. */
export function validateQuizLibrary(quizzes: unknown[]): QuizReport {
  const result: QuizReport = { errors: [], warnings: [], mcAnswerPositions: [] };
  const codes: string[] = [];
  quizzes.forEach((quiz, index) => {
    const report = validateQuiz(quiz, { existingCodes: codes });
    const prefix = `quizzes[${index}]`;
    for (const issue of report.errors) {
      result.errors.push({ ...issue, path: issue.path ? `${prefix}.${issue.path}` : prefix });
    }
    for (const issue of report.warnings) {
      result.warnings.push({ ...issue, path: issue.path ? `${prefix}.${issue.path}` : prefix });
    }
    report.mcAnswerPositions.forEach((count, i) => {
      result.mcAnswerPositions[i] = (result.mcAnswerPositions[i] ?? 0) + count;
    });
    if (isObject(quiz) && isNonEmptyString(quiz.code)) codes.push(quiz.code);
  });
  return result;
}

function formatIssue(issue: QuizIssue): string {
  const where = issue.questionId ? `${issue.questionId} (${issue.path})` : issue.path || "quiz";
  return `- [${issue.code}] ${where}: ${issue.message}`;
}

/** A compact, human-readable list of the report, for review prompts and logs. */
export function formatQuizReport(report: QuizReport): string {
  const lines: string[] = [];
  lines.push(`Errors (${report.errors.length}):`);
  lines.push(...(report.errors.length ? report.errors.map(formatIssue) : ["- none"]));
  lines.push(`Warnings (${report.warnings.length}):`);
  lines.push(...(report.warnings.length ? report.warnings.map(formatIssue) : ["- none"]));
  const positions = report.mcAnswerPositions;
  lines.push(
    `mc correct-answer positions: ${positions.length ? positions.map((c, i) => `#${i + 1}: ${c}`).join(", ") : "no mc questions"}`,
  );
  return lines.join("\n");
}
