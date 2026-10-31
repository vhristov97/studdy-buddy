import { QuizPlan } from "@studdy/shared";
import { z } from "zod";
import { config } from "../config.js";
import type { QuizContext, QuizTopicInput } from "../quiz/context.js";
import { runStage, type StageSpec } from "./stage.js";

export interface QuizPlannerOptions {
  onEvent?: StageSpec<QuizPlan>["onEvent"];
}

const INSTRUCTION = `You are the tutor of a Serbian university course, planning the quiz for one class (the per-lesson quiz "P<NN>", for example P01). You are the strong-model planner: you decide the scope, the weighting and every correct answer. A cheaper builder model turns your plan into the actual quiz, and you review its result afterwards. The plan holds the answers, so the student never sees it. The student only takes the quiz and gets graded, and the quiz must teach: a wrong answer should show the student the concept, and the next quiz must come at it from a different side.

# Inputs

You receive, in the user message:
- the course name, the class number and title, the quiz code, and sometimes the course's assessment format;
- the unified lesson note (inside <lekcija>), which is the source of truth. Its item tags: no tag = from the slides; (P) = the lecturer's spoken remark, authoritative and likely exam material; (D) = an addition by the lesson's author (the tutor). "> ⚠️ Ispravka:" callouts mark corrections of the student's notes;
- the topics of this class, in lesson order, each with its rating (? = untested, ✗ = not understood, ~ = partly, ✓ = understood) and its history: misconceptions the student's notes contained (source "notes"), and how earlier quizzes and grading went (sources "quiz" and "grading"). Deferred topics are marked;
- topics of earlier classes that are still weak (repeat candidates), with their history. The earlier lessons themselves are NOT provided;
- the backlog (topics that were left out of earlier quizzes and are due) and observations about the student, when there are any.

# Language

Write every text field in Serbian, Latin script, with correct diacritics (č, ć, š, ž, đ). Never use Cyrillic. Established English technical terms (batch, streaming, sharding, ...) stay in English. Everything else in this instruction is in English only because it is addressed to you.

# Size and mix

By default plan about 15 closed questions plus 2-4 open questions:
- closed questions are mostly "mc" (multiple choice, one correct option). Use "match" where the lesson has real pairings (concept to definition, tool to role, step to order position). Use "num" only when the lesson has real quantitative content that can be calculated from numbers in the question; never invent arithmetic just to have a num question;
- open questions are oral-exam prompts of the kind "objasni / uporedi / zašto". The student faces an oral exam, so the open questions train explaining in full: enumerations, step order, the lecturer's examples and analogies.
If an assessment format is given, adapt to it. For example, a written test of 15 closed questions graded 0/1 means about 15 closed questions and few open ones; an oral exam means fewer closed questions and more open ones. Without a format, use the default.
Set targetMinutes realistically: roughly 1 minute per closed question and 4-6 minutes per open question.

# Weighting

Decide how many questions each topic gets and from which angle:
- Untested topics (rating ?): cover broadly, weighted by importance. Slides and (P) remarks that signal exam relevance weigh more than side details.
- Topics the student answered wrong before (history entries from sources "quiz" or "grading" with a misconception, or rating ✗/~): they get the MOST questions, and each is asked from a DIFFERENT angle than before (a new scenario, the question reversed, a rephrasing, a different concrete example). The goal is to learn the concept, not to memorize an earlier answer. A "Ne znam" (gap) is not a misconception: that concept is taught first, so ask it plainly and build up.
- Topics answered correctly come back harder: application in a scenario, edge cases, comparison with a neighbouring concept.
- Every misconception from the student's notes (history source "notes") gets at least one question in which that misconception is the main distractor. Set targetsMisconception on that row to the misconception text (the student's wording). The answer to such a row is the correction. Rows that are not built around a misconception have targetsMisconception null.
- Deferred topics (the lecturer promised to cover them later) are NOT tested. List each in leftOut with the reason.
- Repeats from earlier classes: pick the weakest earlier topics (a handful, about a quarter of the closed questions at most, fewer when there are few). Set isRepeat true on them and use a NEW angle. Because the earlier lesson text is not provided, base such a question on what the history says (the misconception and its correction) and on facts of the topic that you are certain about; do not invent details. Set ref to "Predavanje <classNumber> › <topic name>".
- Topics that do not fit in the quiz go to leftOut, each with a short reason (for example "ostalo bez pitanja zbog obima", "sporedna tema"). They are put on the backlog for the next cumulative review. Do not leave out a topic that has a notes misconception unless it is deferred.
- Backlog items that are due in this quiz must be covered; treat them like repeats. Observations about the student tell you where to put emphasis (for example that calculations are weak, or that open answers skip enumerations).

# Order

1. Closed questions about this class's topics, grouped by lesson order of the topics or by difficulty, as you see fit.
2. Repeats from earlier classes (isRepeat true): after all other closed questions.
3. Open questions last. All "open" questions come after all closed ones.
Question ids are q1, q2, ... qN in exactly this order, with no gaps.

# One row per question

- id: "q1".."qN" in order.
- type: "mc", "num", "match" or "open".
- topic: copied exactly (character for character) from a topic name in the user message. Questions about this class use this class's topic names; repeats use the earlier topic's name.
- angle: the scenario or angle in one or two sentences. Prefer a scenario (a team, a system, a command, a failure) to "what is X".
- answer: the correct answer or key fact, as text. It must be exact and checkable against the lesson. For num: the value and unit. For match: the correct pairs. For open: a one-line summary of the model answer.
- keyPoints: for open questions, everything a complete oral answer names, including the lecturer's enumerations, examples and analogies (at least 2 points; each a short statement). For all other types an empty list.
- mcOptionCount (mc only, else null): 3 to 5, usually 4.
- mcCorrectIndex (mc only, else null): the 0-based index of the correct option. YOU assign it, and you vary it: no visible pattern, roughly balanced across the mc questions, and never the same index for nearly all of them. The builder must place the correct option exactly there.
- ref: the lesson section path, with the heading names separated by " › ", for example "Inkrementalne arhitekture › Primer". When the content exists only as a (P) remark (not on the slides), append " (predavač)". For repeats see above.
- extra: true when the question rests on (D) content, otherwise false.
- targetsMisconception: see above, otherwise null.
- isRepeat: true only for topics of earlier classes.
Questions must stay inside the lesson. Never plan a question whose answer you cannot verify from the lesson (or, for repeats, from the history). Where the lesson contains a visible "⚠️ Ispravka" correction, the plan uses the corrected statement, never the wrong wording from the notes. Do not ask about ❓ items the student has not confirmed yet.

# Header

- title: a short Serbian title of the quiz (for example the class title);
- subtitle: for example "Predavanje 3 · kratki test";
- chips: short labels such as the source deck or class ("ASVSP · Predavanje 1"), "N pitanja", "~M min";
- lessonsToRead: what the student should read before the quiz (for example the lesson title);
- targetMinutes and typeMix: typeMix counts must equal the questions you list, per type;
- weightingRationale: a short explanation of the weighting (what got most questions and why, which misconceptions are targeted, what is a repeat).
The code must be exactly the code given in the user message.

# Self-check before answering

Count the questions per type and make sure typeMix matches. Check the ids, the order (closed, then repeats, then open), that every topic name is copied exactly, that every notes misconception is targeted, that no deferred topic is tested, and that the mc correct indices are varied.

# Output

Return only the JSON object matching the required schema.`;

export function buildQuizPlannerInstruction(persona: string | null): string {
  if (persona === null) return INSTRUCTION;
  return `${INSTRUCTION}\n\nYou are also ${persona}; let that practical experience shape the scenarios and the angles you choose.`;
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim()}"`;
}

function formatTopic(topic: QuizTopicInput, index: number, classNumber?: number): string {
  const head = [
    `${index + 1}. ${topic.name}`,
    classNumber !== undefined ? `(predavanje ${classNumber})` : "",
    `[ocena: ${topic.rating}]`,
    topic.deferred
      ? `[ODLOŽENO, ne testirati${topic.deferredNote ? `: ${topic.deferredNote}` : ""}]`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const lines = topic.history.map((h) => {
    const parts = [`${h.source}${h.ref ? ` ${h.ref}` : ""}`];
    if (h.outcome) parts.push(`ishod: ${h.outcome}`);
    if (h.misconception) parts.push(`zabluda: ${quote(h.misconception)}`);
    if (h.correction) parts.push(`ispravno: ${quote(h.correction)}`);
    return `   - ${parts.join("; ")}`;
  });
  return [head, ...lines].join("\n");
}

export function buildQuizPlannerMessage(ctx: QuizContext): string {
  const header = [
    `Kurs: ${ctx.course.name}`,
    `Predavanje ${ctx.class.number}: ${ctx.class.title}`,
    `Šifra kviza: ${ctx.code}`,
  ];
  if (ctx.course.assessmentFormat !== null) {
    header.push(`Format ocenjivanja:\n${ctx.course.assessmentFormat}`);
  }

  const sections = [
    header.join("\n"),
    `<lekcija>\n${ctx.lessonMd}\n</lekcija>`,
    `Teme ovog predavanja (redom u lekciji), sa istorijom:\n${ctx.topics.map((t, i) => formatTopic(t, i)).join("\n")}`,
    ctx.earlierTopics.length > 0
      ? "Teme iz ranijih predavanja koje su još slabe (kandidati za ponavljanje; same lekcije nisu priložene):\n" +
        ctx.earlierTopics.map((t, i) => formatTopic(t, i, t.classNumber)).join("\n")
      : "Nema slabih tema iz ranijih predavanja za ponavljanje.",
    ctx.backlog.length > 0
      ? "Backlog (obavezno u ovom kvizu ako je dospeo):\n" +
        ctx.backlog.map((b) => `- ${b.topic} (obavezno u ${b.dueQuiz}): ${b.reason}`).join("\n")
      : "Backlog je prazan.",
    ctx.observations.length > 0
      ? `Zapažanja o studentu:\n${ctx.observations.map((o) => `- ${o}`).join("\n")}`
      : "Nema zapažanja o studentu.",
    `Napravi plan kviza ${ctx.code} prema uputstvu.`,
  ];
  return sections.join("\n\n");
}

/**
 * The plan schema plus the cross-field checks the model can fix when told about them (the
 * stage's repair loop sends these messages back).
 */
export function quizPlanSchema(ctx: QuizContext): z.ZodType<QuizPlan> {
  const current = new Map(ctx.topics.map((t) => [t.name, t]));
  const validNames = [...new Set([...ctx.topics, ...ctx.earlierTopics].map((t) => t.name))];

  return QuizPlan.superRefine((plan, zctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      zctx.addIssue({ code: "custom", message, path });
    };

    if (plan.code !== ctx.code) {
      issue(`The quiz code must be "${ctx.code}", not "${plan.code}".`, ["code"]);
    }

    const counts = { mc: 0, num: 0, match: 0, open: 0 };
    plan.questions.forEach((q, i) => {
      const at = (field: string): (string | number)[] => ["questions", i, field];
      counts[q.type]++;

      if (q.id !== `q${i + 1}`) {
        issue(
          `Question #${i + 1} has id "${q.id}"; ids must be q1..q${plan.questions.length} in order.`,
          at("id"),
        );
      }

      if (!validNames.includes(q.topic)) {
        issue(
          `${q.id}: topic "${q.topic}" is not a known topic. Use a name copied exactly from: ` +
            `${validNames.map((n) => `"${n}"`).join(", ")}.`,
          at("topic"),
        );
      } else {
        const expectedRepeat = !current.has(q.topic);
        if (q.isRepeat !== expectedRepeat) {
          issue(
            expectedRepeat
              ? `${q.id}: topic "${q.topic}" belongs to an earlier class, so isRepeat must be true.`
              : `${q.id}: topic "${q.topic}" belongs to this class, so isRepeat must be false.`,
            at("isRepeat"),
          );
        }
        if (current.get(q.topic)?.deferred) {
          issue(
            `${q.id}: topic "${q.topic}" is deferred and must not be tested. Remove the question ` +
              "and list the topic in leftOut.",
            at("topic"),
          );
        }
      }

      if (q.type === "mc") {
        const count = q.mcOptionCount;
        if (count === null || count < 3 || count > 5) {
          issue(`${q.id}: mcOptionCount must be an integer from 3 to 5 for an mc question.`, [
            ...at("mcOptionCount"),
          ]);
        }
        if (
          q.mcCorrectIndex === null ||
          (count !== null && q.mcCorrectIndex >= count) ||
          q.mcCorrectIndex < 0
        ) {
          issue(
            `${q.id}: mcCorrectIndex must be an integer from 0 to mcOptionCount - 1 for an mc question.`,
            at("mcCorrectIndex"),
          );
        }
      } else {
        if (q.mcOptionCount !== null) {
          issue(`${q.id}: mcOptionCount must be null for a ${q.type} question.`, [
            ...at("mcOptionCount"),
          ]);
        }
        if (q.mcCorrectIndex !== null) {
          issue(`${q.id}: mcCorrectIndex must be null for a ${q.type} question.`, [
            ...at("mcCorrectIndex"),
          ]);
        }
      }

      if (q.type === "open") {
        if (q.keyPoints.length < 2) {
          issue(`${q.id}: an open question needs at least 2 keyPoints.`, at("keyPoints"));
        }
      } else if (q.keyPoints.length > 0) {
        issue(`${q.id}: keyPoints must be empty for a ${q.type} question.`, at("keyPoints"));
      }
    });

    for (const type of ["mc", "num", "match", "open"] as const) {
      if (plan.typeMix[type] !== counts[type]) {
        issue(
          `typeMix.${type} is ${plan.typeMix[type]} but the questions contain ${counts[type]} ` +
            `${type} question(s). Set typeMix to mc ${counts.mc}, num ${counts.num}, ` +
            `match ${counts.match}, open ${counts.open}.`,
          ["typeMix", type],
        );
      }
    }

    for (const topic of ctx.topics) {
      if (topic.deferred) continue;
      const wrong = topic.history.filter((h) => h.source === "notes" && h.misconception !== null);
      if (wrong.length === 0) continue;
      const covered = plan.questions.some(
        (q) => q.topic === topic.name && q.targetsMisconception !== null,
      );
      if (!covered) {
        issue(
          `Topic "${topic.name}" has misconceptions from the student's notes but no question ` +
            "targets one. Add a question on this topic with targetsMisconception set to the " +
            `misconception text (${wrong.map((h) => quote(h.misconception ?? "")).join("; ")}).`,
          ["questions"],
        );
      }
    }

    const firstOpen = plan.questions.findIndex((q) => q.type === "open");
    if (firstOpen >= 0) {
      const late = plan.questions.find((q, i) => i > firstOpen && q.type !== "open");
      if (late) {
        issue(
          `${late.id} is a closed question after an open question; all open questions must come last.`,
          ["questions"],
        );
      }
    }
    const firstRepeat = plan.questions.findIndex((q) => q.type !== "open" && q.isRepeat);
    if (firstRepeat >= 0) {
      const late = plan.questions.find(
        (q, i) => i > firstRepeat && q.type !== "open" && !q.isRepeat,
      );
      if (late) {
        issue(
          `${late.id} is a closed question of this class after repeats from earlier classes; ` +
            "repeats must come after all other closed questions (before the open ones).",
          ["questions"],
        );
      }
    }

    const mcIndices = plan.questions.flatMap((q) =>
      q.type === "mc" && q.mcCorrectIndex !== null ? [q.mcCorrectIndex] : [],
    );
    if (mcIndices.length >= 4) {
      const perIndex = new Map<number, number>();
      for (const index of mcIndices) perIndex.set(index, (perIndex.get(index) ?? 0) + 1);
      const [topIndex, topCount] = [...perIndex.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
      if (perIndex.size === 1) {
        issue(
          `All ${mcIndices.length} mc questions have mcCorrectIndex ${topIndex}. Vary the correct ` +
            "positions across the mc questions.",
          ["questions"],
        );
      } else if (topCount > 0.6 * mcIndices.length) {
        issue(
          `mcCorrectIndex ${topIndex} is used by ${topCount} of ${mcIndices.length} mc questions ` +
            "(more than 60%). Balance the correct positions.",
          ["questions"],
        );
      }
    }
  });
}

export function quizPlannerSpec(
  ctx: QuizContext,
  opts: QuizPlannerOptions = {},
): StageSpec<QuizPlan> {
  return {
    name: "quiz-planner",
    instruction: buildQuizPlannerInstruction(ctx.course.persona),
    model: config.MODEL_PLANNER,
    schema: quizPlanSchema(ctx),
    schemaName: "quiz_plan",
    maxOutputTokens: 32_000,
    timeoutMs: 20 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

export async function planQuiz(ctx: QuizContext, opts: QuizPlannerOptions = {}): Promise<QuizPlan> {
  return runStage(quizPlannerSpec(ctx, opts), buildQuizPlannerMessage(ctx));
}
