import {
  QuizDraft,
  formatQuizReport,
  validateQuiz,
  type QuizPlan,
  type QuizReport,
  type ReviewFix,
} from "@studdy/shared";
import { z } from "zod";
import { config } from "../config.js";
import type { EarlierLesson, NotesMisconception } from "../quiz/context.js";
import { openStageSession, runStage, type StageSession, type StageSpec } from "./stage.js";

export interface QuizBuilderOptions {
  onEvent?: StageSpec<QuizDraft>["onEvent"];
}

export interface QuizBuilderInput {
  plan: QuizPlan;
  lessonMd: string;
  notesMisconceptions: NotesMisconception[];
  /** Lessons of earlier classes, the source for repeat questions (plan rows with isRepeat true). */
  earlierLessons: EarlierLesson[];
}

const INSTRUCTION = `You are the quiz builder for a Serbian university course. A tutor (the planner) has written a quiz plan: for every question it fixes the topic, the type, the correct answer and where the answer sits. Your job is to turn that plan into the actual quiz that the student will take: the wording, the distractors, the explanations. The student never sees the plan. A reviewer will check your quiz against the plan and the lesson and may send you a list of fixes.

# Inputs

You receive, in the user message:
- the plan as JSON: the header (code, title, subtitle, chips) and one row per question (id, type, topic, angle, answer, keyPoints, mcOptionCount, mcCorrectIndex, ref, extra, targetsMisconception, isRepeat);
- the lesson note (inside <lekcija>), the source of truth. Its tags: no tag = from the slides; (P) = the lecturer's spoken remark, authoritative; (D) = the tutor's addition;
- the misconceptions found in the student's notes, each with the correction. They are the best distractors there are;
- when the plan has repeat questions (isRepeat true), the lessons of the earlier classes they come from (each inside <ranija_lekcija>). Use them as the source of truth for those questions; the ref of a repeat row names the earlier lesson ("Predavanje <N> › ..."). The quiz itself carries no isRepeat marker, so the reviewer identifies repeat questions through the plan and checks them against these earlier lessons.
- when the quiz code is a cumulative review "K<n>", there is no <lekcija> block: every question is a repeat, and the lessons of all covered classes (each inside <ranija_lekcija predavanje="N">) are the source of truth; every question is built from the lesson of the class its ref names.

# What the plan fixes (never change it)

For every question: id, order, type, topic, ref and extra stay exactly as planned. For mc: the number of options is mcOptionCount and the correct option sits at index mcCorrectIndex ("answer" = that index). For num: the value the plan gives is the answer. The key facts of the plan are the truth: the correct answer says what the plan's answer says, and open keys cover at least the plan's keyPoints. The header (code, title, subtitle, chips) is copied from the plan. The quiz has exactly the plan's questions, no more and no fewer.
If something in the plan looks wrong (the answer contradicts the lesson, the angle is unclear, the planned number of options is too few for good distractors), do NOT change it. Build the question as planned and add an entry to "flags" with the question id and what looks wrong. Without such problems, "flags" is an empty list.

# What you own

Wording, distractors, match rows, clean numbers, expanded open-question keys and explanations.

## Closed questions (mc, num, match)

- Exactly one defensible answer. Never write "sve navedeno", "ništa od navedenog" or similar, and no trick wording (no double negatives, no "osim", no hinging on a single word).
- Distractors are REAL misconceptions: take them from the notes' misconceptions and corrections, from the confusions typical for the topic, from the neighbouring concept that is easy to mix up. Not throwaways ("Nijedno od navedenog", absurd options, obviously unrelated terms). When the plan row has targetsMisconception, that misconception is the main distractor.
- All options are similar in length and style; the correct option must not stand out by being longer, more precise or more hedged. Mirror the structure in every option.
- Prefer scenarios (a team, a system, a command, a failure) to "what is X". Follow the plan's angle.
- mc options are plain texts without letters or numbers ("A)", "1."): the player adds the labels. The correct option is at mcCorrectIndex, and the other options go around it.
- num: choose numbers that make the arithmetic come out cleanly (round values the student can compute by hand). The prompt names the unit that the answer is expected in. "answer" is a number, "tolerance" a non-negative number (0 for an exact value, otherwise the rounding the student may reasonably use), "unit" the unit string or null when the answer is unitless.
- match: "rows" are the items to match, "choices" the shared options for the dropdowns, "answer[i]" is the index of the choice that belongs to row i. Shuffle: the rows' answers must NOT follow the order of the choices; at most one row may have answer[i] === i. There may be one extra choice that matches no row. Every pairing must be unambiguous.
- Every closed question has an explanation (Serbian, 2-4 sentences) that says why the right answer is right, why the tempting wrong answer is wrong, and names the concept.
- Never write a "Ne znam" option: the player adds it.

## Open questions

- The prompt is an oral-exam question: "Objasni ...", "Uporedi ...", "Zašto ...". It names the situation and what has to be explained, in one or two sentences.
- keyPoints: everything a complete oral answer names. Start from the plan's keyPoints and expand: full enumerations in the lesson's order, the steps in order, the lecturer's (P) examples and analogies, the contrasts. Each point is a short, checkable statement. Open questions have no explanation field.

# Language and format

Serbian, Latin script, with correct diacritics (č, ć, š, ž, đ). Never Cyrillic. Natural, clear wording as a Serbian lecturer would write it; established English technical terms (batch, streaming, sharding, ...) stay in English. Prompts may use Markdown: put code, commands and identifiers in backticks, and use fenced blocks for multi-line code.

# Output

Return only the JSON object {quiz, flags} matching the required schema. When you later receive a list of fixes from the reviewer, apply every one of them, change nothing else that the reviewer did not ask for (and never what the plan fixes), and return the COMPLETE corrected object again (the whole quiz, all questions), not only the changed questions.`;

export function buildQuizBuilderInstruction(): string {
  return INSTRUCTION;
}

function earlierLessonSections(lessons: EarlierLesson[]): string[] {
  return lessons.map(
    (l) =>
      `Ranija lekcija, predavanje ${l.classNumber}: ${l.title} (izvor za pitanja za ponavljanje)\n` +
      `<ranija_lekcija predavanje="${l.classNumber}">\n${l.lessonMd}\n</ranija_lekcija>`,
  );
}

export function buildQuizBuilderMessage(input: QuizBuilderInput): string {
  const misconceptions =
    input.notesMisconceptions.length > 0
      ? "Zablude iz beleški studenta (dobri distraktori):\n" +
        input.notesMisconceptions
          .map((m) => `- Tema "${m.topic}": zabluda "${m.claim}" — ispravno: "${m.correction}"`)
          .join("\n")
      : "Student nema zabluda iz beleški za ovo predavanje; distraktore uzmi iz tipičnih zabuna oko teme.";
  return [
    `Plan kviza (JSON):\n${JSON.stringify(input.plan, null, 2)}`,
    ...(input.lessonMd === "" ? [] : [`<lekcija>\n${input.lessonMd}\n</lekcija>`]),
    ...earlierLessonSections(input.earlierLessons),
    misconceptions,
    `Napravi kviz ${input.plan.code} prema planu i uputstvu, i vrati {quiz, flags}.`,
  ].join("\n\n");
}

/** The message for a fix cycle on the builder's session (M4.3's review loop). */
export function buildQuizFixMessage(fixes: ReviewFix[], report?: QuizReport): string {
  const parts = [
    "Recenzent traži ispravke. Primeni svaku od njih; ne menjaj ništa što nije traženo " +
      "(i nikad ono što plan fiksira):",
    ...fixes.map((f, i) => `${i + 1}. ${f.questionId}: ${f.problem}\n   Izmena: ${f.change}`),
  ];
  if (report && (report.errors.length > 0 || report.warnings.length > 0)) {
    parts.push(`Izveštaj automatske provere kviza:\n${formatQuizReport(report)}`);
  }
  parts.push("Vrati KOMPLETAN ispravljen objekat {quiz, flags} (svih pitanja), ne samo izmenjena.");
  return parts.join("\n\n");
}

/**
 * The draft schema plus the checks that the quiz keeps what the plan fixed and passes the §7.3
 * validator's errors (its warnings are left to the reviewer).
 */
export function quizDraftSchema(plan: QuizPlan): z.ZodType<QuizDraft> {
  return QuizDraft.superRefine((draft, zctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      zctx.addIssue({ code: "custom", message, path });
    };
    const quiz = draft.quiz;

    if (quiz.code !== plan.code) {
      issue(`quiz.code must be "${plan.code}", as in the plan.`, ["quiz", "code"]);
    }
    if (quiz.title !== plan.title) {
      issue(`quiz.title must be "${plan.title}", as in the plan.`, ["quiz", "title"]);
    }
    if (quiz.subtitle !== plan.subtitle) {
      issue(`quiz.subtitle must be "${plan.subtitle}", as in the plan.`, ["quiz", "subtitle"]);
    }
    if (
      quiz.chips.length !== plan.chips.length ||
      quiz.chips.some((chip, i) => chip !== plan.chips[i])
    ) {
      issue(
        `quiz.chips must be exactly the plan's chips, in the same order: ${JSON.stringify(plan.chips)}.`,
        ["quiz", "chips"],
      );
    }
    if (quiz.questions.length !== plan.questions.length) {
      issue(
        `The quiz has ${quiz.questions.length} questions but the plan has ${plan.questions.length}; ` +
          "build exactly the planned questions.",
        ["quiz", "questions"],
      );
    }

    plan.questions.forEach((planned, i) => {
      const q = quiz.questions[i];
      if (!q) return;
      const at = (field: string): (string | number)[] => ["quiz", "questions", i, field];
      if (q.id !== planned.id) {
        issue(
          `Question #${i + 1} has id "${q.id}" but the plan has "${planned.id}" there; keep the ` +
            "planned ids and order.",
          at("id"),
        );
        return;
      }
      if (q.type !== planned.type) {
        issue(`${q.id}: type must be "${planned.type}" as planned, not "${q.type}".`, at("type"));
        return;
      }
      if (q.topic !== planned.topic) {
        issue(`${q.id}: topic must be "${planned.topic}" as planned.`, at("topic"));
      }
      if (q.ref !== planned.ref) {
        issue(`${q.id}: ref must be "${planned.ref}" as planned.`, at("ref"));
      }
      if (q.extra !== planned.extra) {
        issue(`${q.id}: extra must be ${planned.extra} as planned.`, at("extra"));
      }
      if (q.type === "mc") {
        if (planned.mcOptionCount !== null && q.options.length !== planned.mcOptionCount) {
          issue(
            `${q.id}: the plan fixes ${planned.mcOptionCount} options but the question has ` +
              `${q.options.length}.`,
            at("options"),
          );
        }
        if (planned.mcCorrectIndex !== null && q.answer !== planned.mcCorrectIndex) {
          issue(
            `${q.id}: the correct option must be at index ${planned.mcCorrectIndex} as planned, ` +
              `not ${q.answer}. Reorder the options.`,
            at("answer"),
          );
        }
      }
    });

    const ids = new Set(quiz.questions.map((q) => q.id));
    draft.flags.forEach((flag, i) => {
      if (!ids.has(flag.questionId)) {
        issue(`Flag #${i + 1} refers to unknown question id "${flag.questionId}".`, [
          "flags",
          i,
          "questionId",
        ]);
      }
    });

    for (const e of validateQuiz(quiz).errors) {
      issue(`Quiz check [${e.code}] ${e.questionId ?? ""} ${e.path}: ${e.message}`, [
        "quiz",
        ...(e.path ? e.path.split(/[.[\]]+/).filter(Boolean) : []),
      ]);
    }
  });
}

export function quizBuilderSpec(
  plan: QuizPlan,
  opts: QuizBuilderOptions = {},
): StageSpec<QuizDraft> {
  return {
    name: "quiz-builder",
    instruction: buildQuizBuilderInstruction(),
    model: config.MODEL_BUILDER,
    schema: quizDraftSchema(plan),
    schemaName: "quiz_draft",
    maxOutputTokens: 32_000,
    timeoutMs: 20 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

/** A multi-turn builder: send the build message, then fix rounds on the same conversation. */
export function openQuizBuilderSession(
  plan: QuizPlan,
  opts: QuizBuilderOptions = {},
): StageSession<QuizDraft> {
  return openStageSession(quizBuilderSpec(plan, opts));
}

/** One-shot build, without fix cycles. */
export async function buildQuiz(
  plan: QuizPlan,
  lessonMd: string,
  notesMisconceptions: NotesMisconception[],
  earlierLessons: EarlierLesson[],
  opts: QuizBuilderOptions = {},
): Promise<QuizDraft> {
  return runStage(
    quizBuilderSpec(plan, opts),
    buildQuizBuilderMessage({ plan, lessonMd, notesMisconceptions, earlierLessons }),
  );
}
