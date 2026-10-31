import {
  QuizReview,
  formatQuizReport,
  type Quiz,
  type QuizDraftFlag,
  type QuizPlan,
  type QuizReport,
} from "@studdy/shared";
import { z } from "zod";
import { config } from "../config.js";
import type { EarlierLesson } from "../quiz/context.js";
import { runStage, type StageSpec } from "./stage.js";

export interface QuizReviewerOptions {
  onEvent?: StageSpec<QuizReview>["onEvent"];
}

export interface QuizReviewerInput {
  plan: QuizPlan;
  quiz: Quiz;
  flags: QuizDraftFlag[];
  lessonMd: string;
  /** Lessons of earlier classes, the source for repeat questions (plan rows with isRepeat true). */
  earlierLessons: EarlierLesson[];
  /** The §7.3 validator's report on `quiz`. */
  report: QuizReport;
}

const INSTRUCTION = `You are the tutor of a Serbian university course, reviewing a quiz that a cheaper builder model has built from your own quiz plan. The plan holds the answers and is never shown to the student. You decide whether the quiz can be released to the student, or which fixes the builder must make first. A wrong answer key, an ambiguous question or a giveaway option does real damage: the student studies from the quiz and from its explanations.

# Inputs

You receive, in the user message:
- the plan as JSON (your own earlier work: one row per question with the correct answer, keyPoints, planned mc position, ref, extra, targetsMisconception);
- the built quiz as JSON;
- the builder's flags: places where it thinks the plan looks wrong (it kept them as planned);
- the automatic checker's report (errors, warnings, the distribution of correct mc positions);
- the lesson note (inside <lekcija>), the source of truth. Its tags: no tag = from the slides; (P) = the lecturer's remark, authoritative; (D) = the tutor's addition;
- when the plan has repeat questions (isRepeat true), the lessons of the earlier classes they come from (each inside <ranija_lekcija>). The quiz does not mark repeat questions, so identify them through the plan (isRepeat true, ref "Predavanje <N> › ...") and check them against the matching earlier lesson instead of the current one.
- when the quiz code is a cumulative review "K<n>", there is no <lekcija> block: every question is a repeat of some covered class, so check EVERY question against the lesson of the class its ref names ("Predavanje <N> › ..."), and check that the ref names a real section of that lesson.

# What to check

Go through EVERY question. Correctness comes first.
1. Correctness: the keyed answer is right according to the plan AND the lesson (for a repeat question, the earlier lesson of the class named in its ref). Re-derive it yourself: for num check the arithmetic and the unit; for match check every row; for mc check that the option at the answer index is the correct one and that no other option is also defensible. The explanation must agree with the key.
2. Exactly one defensible answer: no second option that is also right under a reasonable reading; no "sve navedeno" / "ništa od navedenog"; no trick wording.
3. Distractors: real misconceptions or typical confusions, plausible to someone who half-knows the topic. Not throwaways. Where the plan has targetsMisconception, that misconception is the main distractor.
4. The correct option does not stand out: similar length, structure and hedging as the others. The checker's mc_correct_stands_out warning is a hint, not a verdict.
5. Language: Serbian, Latin script, correct diacritics, natural wording, English technical terms kept. No Cyrillic. Markdown in prompts renders properly (code in backticks).
6. Tags: ref and extra equal the plan's; ref names a real section of the lesson.
7. Variety: mc correct positions vary (see the checker's distribution); match rows are shuffled with at most one row on the diagonal.
8. Explanations: complete (why the right answer is right, why the tempting wrong one is wrong, names the concept) and correct.
9. Open questions: an oral-exam "objasni / uporedi / zašto" prompt; the keyPoints are complete against the plan's keyPoints and the lesson (enumerations in order, the lecturer's examples and analogies), none missing, none wrong.
10. No "Ne znam" option has been written (the player adds it).
11. The builder's flags: weigh each. If a flag shows a real error in the plan, ask for the fix. You are the planner, so when the lesson clearly contradicts the plan's answer you may correct your own plan's answer: request the new answer in "change" and say explicitly that this corrects the plan (the builder then follows the change, even though it differs from the plan). A flag that is not a real problem needs no fix.

# Verdict

- approved = true only when nothing material is left. Cosmetic nits alone (a slightly clumsy phrase, a marginally uneven option length) do not block approval; mention them in the summary if at all.
- approved = false when anything material is wrong: a wrong or doubtful key, two defensible answers, a stand-out correct option, throwaway distractors, an incorrect or missing explanation, missing or wrong keyPoints, a plan/quiz mismatch, wrong language, a broken mc/match layout.
- When approved, "fixes" is an empty list. When not approved, "fixes" has at least one entry.
- A fix is concrete: the question id, what is wrong (problem) and the exact change you want (change), for example the new wording of an option, the option to replace, the point to add to the key. The builder applies it without further thinking, so be specific, and never ask for anything the builder cannot do within the plan (except the explicit plan corrections described above). Do not repeat nits you already waved through. Keep the list to what really needs fixing; do not rewrite questions that are fine.
- summary: two to four sentences in English about the overall quality and what the fixes cover.

Write problem and change in English, quoting Serbian wording where you need it to be exact. Serbian text you ask for follows the same rules as the quiz: Latin script, correct diacritics.

# Output

Return only the JSON object matching the required schema.`;

export function buildQuizReviewerInstruction(): string {
  return INSTRUCTION;
}

export function buildQuizReviewerMessage(input: QuizReviewerInput): string {
  return [
    `Plan kviza (JSON):\n${JSON.stringify(input.plan, null, 2)}`,
    `Izgrađeni kviz (JSON):\n${JSON.stringify(input.quiz, null, 2)}`,
    input.flags.length > 0
      ? "Zastavice graditelja (mesta gde plan izgleda pogrešno):\n" +
        input.flags.map((f) => `- ${f.questionId}: ${f.issue}`).join("\n")
      : "Graditelj nije postavio zastavice.",
    `Izveštaj automatske provere:\n${formatQuizReport(input.report)}`,
    ...(input.lessonMd === "" ? [] : [`<lekcija>\n${input.lessonMd}\n</lekcija>`]),
    ...input.earlierLessons.map(
      (l) =>
        `Ranija lekcija, predavanje ${l.classNumber}: ${l.title} (izvor za pitanja za ponavljanje)\n` +
        `<ranija_lekcija predavanje="${l.classNumber}">\n${l.lessonMd}\n</ranija_lekcija>`,
    ),
    `Pregledaj kviz ${input.quiz.code} prema uputstvu.`,
  ].join("\n\n");
}

/** The review schema plus the checks the model can fix when told about them. */
export function quizReviewSchema(quiz: Quiz): z.ZodType<QuizReview> {
  const ids = new Set(quiz.questions.map((q) => q.id));
  return QuizReview.superRefine((review, zctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      zctx.addIssue({ code: "custom", message, path });
    };
    if (review.approved && review.fixes.length > 0) {
      issue("approved is true but fixes is not empty; approve only with an empty fixes list.", [
        "fixes",
      ]);
    }
    if (!review.approved && review.fixes.length === 0) {
      issue("approved is false, so fixes must list at least one concrete fix.", ["fixes"]);
    }
    review.fixes.forEach((fix, i) => {
      if (!ids.has(fix.questionId)) {
        issue(
          `Fix #${i + 1} refers to unknown question id "${fix.questionId}"; valid ids: ` +
            `${[...ids].join(", ")}.`,
          ["fixes", i, "questionId"],
        );
      }
    });
  });
}

export function quizReviewerSpec(
  quiz: Quiz,
  opts: QuizReviewerOptions = {},
): StageSpec<QuizReview> {
  return {
    name: "quiz-reviewer",
    instruction: buildQuizReviewerInstruction(),
    model: config.MODEL_PLANNER,
    schema: quizReviewSchema(quiz),
    schemaName: "quiz_review",
    maxOutputTokens: 16_000,
    timeoutMs: 15 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

export async function reviewQuiz(
  input: QuizReviewerInput,
  opts: QuizReviewerOptions = {},
): Promise<QuizReview> {
  return runStage(quizReviewerSpec(input.quiz, opts), buildQuizReviewerMessage(input));
}
