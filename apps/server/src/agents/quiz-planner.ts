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
- topics of earlier classes that are still weak (repeat candidates), with their history, and the lessons of those earlier classes (each inside <ranija_lekcija>, with its class number), which are the source for repeat questions;
- the backlog (topics that were left out of earlier quizzes and are due; deferred ones are marked and are not tested) and observations about the student, when there are any.

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
- Every misconception from the student's notes (history source "notes") gets at least one question in which that misconception is the main distractor. That question must be a multiple-choice (mc) question, or a matching (match) question where it fits: only closed questions with options have distractors, so num and open questions do not count. The message lists these misconceptions explicitly, numbered per topic. Set targetsMisconception on that row to the misconception text copied exactly (character for character) from that list. Every listed misconception needs its own question on that same topic (topic set to that topic's name, isRepeat false, type mc or match; a question on another topic, a repeat, a num or an open question does not count): two misconceptions on one topic need two questions. The answer to such a row is the correction. Rows that are not built around a misconception, and every open row, have targetsMisconception null.
- Deferred topics (the lecturer promised to cover them later) are NOT tested. List each in leftOut with the reason.
- Repeats from earlier classes: pick the weakest earlier topics (a handful, about a quarter of the closed questions at most, fewer when there are few). Set isRepeat true on them, set classNumber to the number of the class that topic comes from (topic names are unique only per class, so the pair topic + classNumber must be one of the listed earlier topics or backlog items, each listed with its class number), and use a NEW angle. Base such a question on the earlier lesson (provided inside <ranija_lekcija>) together with the history (the misconception and its correction); never ask what you cannot verify from them. Set ref to "Predavanje <N> › <section path>", where N is exactly the classNumber of that row (the earlier class number) and the section path is the heading path in that earlier lesson, separated by " › ". A repeat's ref must start with "Predavanje <classNumber> ›" for its own classNumber; a question that is not a repeat never has a ref starting with "Predavanje <N> ›".
- Topics that do not fit in the quiz go to leftOut, each with a short reason (for example "ostalo bez pitanja zbog obima", "sporedna tema"). They are put on the backlog for the next cumulative review. Do not leave out a topic that has a notes misconception unless it is deferred.
- Deferred backlog items (marked "odloženo") are never tested and never repeats; the lecturer has not covered them yet. Leave them alone.
- Backlog items that are due in this quiz must be covered; treat them like repeats (isRepeat true, classNumber = the class number listed with the backlog item). Observations about the student tell you where to put emphasis (for example that calculations are weak, or that open answers skip enumerations).

# Order

1. Closed questions about this class's topics, grouped by lesson order of the topics or by difficulty, as you see fit.
2. Repeats from earlier classes (isRepeat true): after all other closed questions.
3. Open questions last. All "open" questions come after all closed ones.
Question ids are q1, q2, ... qN in exactly this order, with no gaps.

# One row per question

- id: "q1".."qN" in order.
- type: "mc", "num", "match" or "open".
- topic: copied exactly (character for character) from a topic name in the user message. Questions about this class use this class's topic names (isRepeat false); repeats use the earlier topic's name (isRepeat true). When a name occurs both in this class and among the earlier topics, either use is valid; isRepeat tells which one you mean, and classNumber tells which earlier class.
- angle: the scenario or angle in one or two sentences. Prefer a scenario (a team, a system, a command, a failure) to "what is X".
- answer: the correct answer or key fact, as text. It must be exact and checkable against the lesson. For num: the value and unit. For match: the correct pairs. For open: a one-line summary of the model answer.
- keyPoints: for open questions, everything a complete oral answer names, including the lecturer's enumerations, examples and analogies (at least 2 points; each a short statement). For all other types an empty list.
- mcOptionCount (mc only, else null): 3 to 5, usually 4.
- mcCorrectIndex (mc only, else null): the 0-based index of the correct option. YOU assign it, and you vary it: no visible pattern, roughly balanced across the mc questions, and never the same index for nearly all of them. The builder must place the correct option exactly there.
- ref: the lesson section path, with the heading names separated by " › ", for example "Inkrementalne arhitekture › Primer". When the content exists only as a (P) remark (not on the slides), append " (predavač)". For repeats see above.
- extra: true when the question rests on (D) content, otherwise false.
- targetsMisconception: see above, otherwise null.
- isRepeat: true only for topics of earlier classes.
- classNumber: for a repeat (isRepeat true) the class number of the earlier topic, exactly as listed with that topic (for example 1 for "predavanje 1"); null when isRepeat is false.
Questions must stay inside the lesson. Never plan a question whose answer you cannot verify from the lesson (or, for repeats, from the earlier lesson and the history). Where the lesson contains a visible "⚠️ Ispravka" correction, the plan uses the corrected statement, never the wrong wording from the notes. Do not ask about ❓ items the student has not confirmed yet.

# Header

- title: a short Serbian title of the quiz (for example the class title);
- subtitle: for example "Predavanje 3 · kratki test";
- chips: short labels such as the source deck or class ("ASVSP · Predavanje 1"), "N pitanja", "~M min";
- lessonsToRead: what the student should read before the quiz (for example the lesson title);
- targetMinutes and typeMix: give your best estimate of the per-type counts; the app recomputes typeMix from your questions, so do not spend effort on it;
- weightingRationale: a short explanation of the weighting (what got most questions and why, which misconceptions are targeted, what is a repeat).
The code must be exactly the code given in the user message.

# Self-check before answering

Check the ids, the order (closed, then repeats, then open), that every topic name is copied exactly, that every listed notes misconception is targeted by its own question with the text copied exactly, that no deferred topic is tested, and that the mc correct indices are varied.

# Output

Return only the JSON object matching the required schema.`;

const CUMULATIVE_INSTRUCTION = `You are the tutor of a Serbian university course, planning a cumulative review quiz "K<n>" (for example K1) over several classes of the course (classes 1..N). You are the strong-model planner: you decide the scope, the weighting and every correct answer. A cheaper builder model turns your plan into the actual quiz, and you review its result afterwards. The plan holds the answers, so the student never sees it. The review must teach: a wrong answer should show the student the concept, and every weak concept must be approached from a different side than before.

A cumulative review is built from the lessons, the backlog and the student's weak spots, NOT from the slides: the lessons of all covered classes are the source of truth. There is no "current class": every question is a repeat of some class's topic.

# Inputs

You receive, in the user message:
- the course name, the quiz code, the list of covered classes, and sometimes the course's assessment format;
- the unified lesson note of every covered class (each inside <ranija_lekcija predavanje="N">). Its item tags: no tag = from the slides; (P) = the lecturer's spoken remark, authoritative and likely exam material; (D) = an addition by the lesson's author (the tutor). "> ⚠️ Ispravka:" callouts mark corrections of the student's notes;
- every topic of the covered classes (deferred ones are left out), each with its class number, its rating (? = untested, ✗ = not understood, ~ = partly, ✓ = understood) and its history: misconceptions from the student's notes (source "notes") and how earlier quizzes and grading went (sources "quiz" and "grading");
- the backlog: topics that are mandatory in a cumulative review, each with the class it belongs to and the review it is due in; items marked "odloženo" are deferred and are not tested;
- observations about the student, when there are any.

# Language

Write every text field in Serbian, Latin script, with correct diacritics (č, ć, š, ž, đ). Never use Cyrillic. Established English technical terms (batch, streaming, sharding, ...) stay in English. Everything else in this instruction is in English only because it is addressed to you.

# Size and mix

By default plan about 20-30 closed questions plus 3-5 open questions; scale with the number of covered classes (a review of two classes is shorter than a review of six). Closed questions are mostly "mc" (one correct option). Use "match" where the lessons have real pairings (concept to definition, tool to role). Use "num" only when the lessons have real quantitative content that can be calculated from numbers in the question. Open questions are oral-exam prompts of the kind "objasni / uporedi / zašto"; prefer ones that connect topics across classes. If an assessment format is given, adapt to it (a written test of closed questions means few open ones, an oral exam means more open ones). Set targetMinutes realistically: roughly 1 minute per closed question and 4-6 minutes per open question.

# Weighting

- EVERY backlog item marked "OBAVEZNO u <code>" in the message (all unresolved, non-deferred gaps of the covered classes) must get at least one question on exactly that topic and class. This is mandatory, not a suggestion. Deferred backlog items are never tested.
- Topics rated ✗ or ~, and topics with misconceptions in their history, weigh the MOST: several questions each, each from a DIFFERENT angle than before (a new scenario, the question reversed, a rephrasing, a different concrete example). The goal is to learn the concept, not to memorize an earlier answer. A "Ne znam" (gap) is not a misconception: ask it plainly and build up.
- Topics rated ✓ come back harder or as a comparison across classes (application in a scenario, edge cases, a neighbouring concept). Untested topics (?) are covered by importance; slides and (P) remarks that signal exam relevance weigh more.
- Spread the questions across ALL covered classes; no covered class may be left without questions unless it has nothing testable.
- Observations about the student tell you where to put emphasis (for example that calculations are weak, or that open answers skip enumerations).
- Topics that do not fit go to leftOut, each with a short reason. Deferred topics are never tested.

# Order

1. Closed questions, grouped by class number (ascending) or by difficulty, as you see fit.
2. Open questions last. All "open" questions come after all closed ones.
Question ids are q1, q2, ... qN in exactly this order, with no gaps.

# One row per question

- id: "q1".."qN" in order.
- type: "mc", "num", "match" or "open".
- topic: copied exactly (character for character) from a topic name in the user message.
- isRepeat: ALWAYS true in a cumulative review.
- classNumber: ALWAYS set: the number of the class the topic comes from, exactly as listed with that topic. Topic names are unique only per class, so the pair (topic, classNumber) must be one of the listed topics.
- ref: "Predavanje <N> › <section path>", where N is exactly the classNumber of that row and the section path is the heading path in that class's lesson, separated by " › " (for example "Predavanje 2 › Inkrementalne arhitekture › Primer"). When the content exists only as a (P) remark (not on the slides), append " (predavač)". Every ref starts with "Predavanje <classNumber> ›" for its own classNumber.
- angle: the scenario or angle in one or two sentences. Prefer a scenario (a team, a system, a command, a failure) to "what is X".
- answer: the correct answer or key fact, as text. It must be exact and checkable against the lesson. For num: the value and unit. For match: the correct pairs. For open: a one-line summary of the model answer.
- keyPoints: for open questions, everything a complete oral answer names, including the lecturer's enumerations, examples and analogies (at least 2 points; each a short statement). For all other types an empty list.
- mcOptionCount (mc only, else null): 3 to 5, usually 4.
- mcCorrectIndex (mc only, else null): the 0-based index of the correct option. YOU assign it, and you vary it: no visible pattern, roughly balanced across the mc questions, and never the same index for nearly all of them. The builder must place the correct option exactly there.
- extra: true when the question rests on (D) content, otherwise false.
- targetsMisconception: for a closed (mc or match) question that uses a misconception from a topic's history as its main distractor, that misconception text copied exactly; otherwise null. Open questions always null.
Questions must stay inside the lessons. Never plan a question whose answer you cannot verify from the lesson of its class. Where a lesson contains a visible "⚠️ Ispravka" correction, the plan uses the corrected statement, never the wrong wording from the notes. Do not ask about ❓ items the student has not confirmed yet.

# Header

- title: a short Serbian title of the review (for example "Kumulativni pregled 1");
- subtitle: for example "Predavanja 1-4 · kumulativni test";
- chips: short labels such as the course, "N pitanja", "~M min";
- lessonsToRead: what the student should read before the review (the covered lessons);
- targetMinutes and typeMix: give your best estimate of the per-type counts; the app recomputes typeMix from your questions, so do not spend effort on it;
- weightingRationale: a short explanation of the weighting (which backlog items are covered, what is weak and got most questions, how the classes are spread).
The code must be exactly the code given in the user message.

# Self-check before answering

Check the ids, the order (closed, then open), that every row is a repeat with classNumber, that every ref starts with "Predavanje <classNumber> ›", that every topic name is copied exactly, that every due backlog item is covered by a question on its topic and class, that no deferred topic is tested, and that the mc correct indices are varied.

# Output

Return only the JSON object matching the required schema.`;

export function buildQuizPlannerInstruction(
  persona: string | null,
  kind: QuizContext["kind"] = "lesson",
): string {
  const base = kind === "cumulative" ? CUMULATIVE_INSTRUCTION : INSTRUCTION;
  if (persona === null) return base;
  return `${base}\n\nYou are also ${persona}; let that practical experience shape the scenarios and the angles you choose.`;
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim()}"`;
}

export function formatTopic(topic: QuizTopicInput, index: number, classNumber?: number): string {
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

/** True when `ref` starts with "Predavanje <classNumber> ›" (a leading zero on the number is fine). */
function refStartsWithClass(ref: string, classNumber: number): boolean {
  return new RegExp(`^\\s*Predavanje\\s+0*${classNumber}\\s*›`).test(ref);
}

/** Normalizes misconception text for comparison: trimmed, whitespace collapsed, case-folded. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The notes misconceptions of the current, non-deferred topics that the quiz must target. */
function requiredMisconceptions(ctx: QuizContext): { topic: string; texts: string[] }[] {
  const result: { topic: string; texts: string[] }[] = [];
  for (const topic of ctx.topics) {
    if (topic.deferred) continue;
    const texts: string[] = [];
    const seen = new Set<string>();
    for (const h of topic.history) {
      if (h.source !== "notes" || h.misconception === null) continue;
      const key = normalizeText(h.misconception);
      if (seen.has(key)) continue;
      seen.add(key);
      texts.push(h.misconception);
    }
    if (texts.length > 0) result.push({ topic: topic.name, texts });
  }
  return result;
}

/**
 * True when a backlog item must be covered by the cumulative review: not deferred. A cumulative
 * context's backlog holds only the unresolved items of the covered classes, so every such item is
 * required whatever its `dueQuiz` label says.
 */
function isRequiredBacklog(item: QuizContext["backlog"][number]): boolean {
  return !item.deferred;
}

function buildCumulativePlannerMessage(ctx: QuizContext): string {
  const header = [
    `Kurs: ${ctx.course.name}`,
    `Kumulativni pregled ${ctx.code}`,
    `Obuhvaćena predavanja: ${ctx.coveredClasses.map((c) => `${c.classNumber} (${c.title})`).join(", ")}`,
    `Šifra kviza: ${ctx.code}`,
  ];
  if (ctx.course.assessmentFormat !== null) {
    header.push(`Format ocenjivanja:\n${ctx.course.assessmentFormat}`);
  }
  const due = ctx.backlog.filter(isRequiredBacklog);
  const sections = [
    header.join("\n"),
    ...ctx.earlierLessons.map(
      (l) =>
        `Lekcija, predavanje ${l.classNumber}: ${l.title}\n<ranija_lekcija predavanje="${l.classNumber}">\n${l.lessonMd}\n</ranija_lekcija>`,
    ),
    ctx.earlierTopics.length > 0
      ? "Teme obuhvaćenih predavanja (bez odloženih), sa ocenom i istorijom:\n" +
        ctx.earlierTopics.map((t, i) => formatTopic(t, i, t.classNumber)).join("\n")
      : "Nema tema u obuhvaćenim predavanjima.",
    ctx.backlog.length > 0
      ? "Backlog:\n" +
        ctx.backlog
          .map((b) => {
            const where = `${b.topic} (predavanje ${String(b.classNumber).padStart(2, "0")})`;
            if (b.deferred) {
              return `- ${where} (odloženo — ne testirati dok se ne obradi): ${b.reason}`;
            }
            return `- ${where} — OBAVEZNO u ${ctx.code}: ${b.reason}`;
          })
          .join("\n") +
        (due.length > 0
          ? `\nObavezne stavke za ${ctx.code}: ${due.length}; svaka mora imati bar jedno pitanje na toj temi i tom predavanju.`
          : `\nNijedna stavka nije obavezna u ${ctx.code}.`)
      : "Backlog je prazan.",
    ctx.observations.length > 0
      ? `Zapažanja o studentu:\n${ctx.observations.map((o) => `- ${o}`).join("\n")}`
      : "Nema zapažanja o studentu.",
    `Napravi plan kumulativnog pregleda ${ctx.code} prema uputstvu.`,
  ];
  return sections.join("\n\n");
}

export function buildQuizPlannerMessage(ctx: QuizContext): string {
  if (ctx.kind === "cumulative") return buildCumulativePlannerMessage(ctx);
  const header = [
    `Kurs: ${ctx.course.name}`,
    `Predavanje ${ctx.class.number}: ${ctx.class.title}`,
    `Šifra kviza: ${ctx.code}`,
  ];
  if (ctx.course.assessmentFormat !== null) {
    header.push(`Format ocenjivanja:\n${ctx.course.assessmentFormat}`);
  }

  const required = requiredMisconceptions(ctx);
  const sections = [
    header.join("\n"),
    `<lekcija>\n${ctx.lessonMd}\n</lekcija>`,
    `Teme ovog predavanja (redom u lekciji), sa istorijom:\n${ctx.topics.map((t, i) => formatTopic(t, i)).join("\n")}`,
    required.length > 0
      ? "Zablude iz beleški studenta, svaka mora imati bar jedno pitanje; u targetsMisconception kopiraj tekst TAČNO kako je navedeno:\n" +
        required
          .map(
            (r) =>
              `Tema "${r.topic}":\n` +
              r.texts.map((t, i) => `  ${i + 1}. ${JSON.stringify(t)}`).join("\n"),
          )
          .join("\n")
      : "Student nema zabluda iz beleški za ovo predavanje.",
    ctx.earlierTopics.length > 0
      ? "Teme iz ranijih predavanja koje su još slabe (kandidati za ponavljanje; lekcije su priložene ispod):\n" +
        ctx.earlierTopics.map((t, i) => formatTopic(t, i, t.classNumber)).join("\n")
      : "Nema slabih tema iz ranijih predavanja za ponavljanje.",
    ...ctx.earlierLessons.map(
      (l) =>
        `Ranija lekcija, predavanje ${l.classNumber}: ${l.title}\n<ranija_lekcija predavanje="${l.classNumber}">\n${l.lessonMd}\n</ranija_lekcija>`,
    ),
    ctx.backlog.length > 0
      ? "Backlog (obavezno u ovom kvizu ako je dospeo):\n" +
        ctx.backlog
          .map((b) =>
            b.deferred
              ? `- ${b.topic} (predavanje ${String(b.classNumber).padStart(2, "0")}) (odloženo — ne testirati dok se ne obradi): ${b.reason}`
              : `- ${b.topic} (predavanje ${String(b.classNumber).padStart(2, "0")}) — obavezno u ${b.dueQuiz}: ${b.reason}`,
          )
          .join("\n")
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
  const cumulative = ctx.kind === "cumulative";
  const current = new Map(ctx.topics.map((t) => [t.name, t]));
  const earlierNames = new Set(ctx.earlierTopics.map((t) => t.name));
  const earlierPairs = new Set(
    ctx.earlierTopics.map((t) => JSON.stringify([t.name, t.classNumber])),
  );
  const validPairs = ctx.earlierTopics
    .map((t) => `("${t.name}", predavanje ${t.classNumber})`)
    .join(", ");
  const deferredBacklog = new Set(
    ctx.backlog.filter((b) => b.deferred).map((b) => JSON.stringify([b.topic, b.classNumber])),
  );
  const deferredBacklogNames = new Set(ctx.backlog.filter((b) => b.deferred).map((b) => b.topic));
  const validNames = [...new Set([...ctx.topics, ...ctx.earlierTopics].map((t) => t.name))];

  /** Rows of a cumulative review: every one is a repeat of a listed (topic, class) with a matching ref. */
  const checkCumulativeRow = (
    q: QuizPlan["questions"][number],
    at: (field: string) => (string | number)[],
    issue: (message: string, path: (string | number)[]) => void,
  ): void => {
    if (!q.isRepeat) {
      issue(
        `${q.id}: every question of a cumulative review is a repeat of a topic of a covered class; ` +
          'set isRepeat to true (and classNumber and a "Predavanje <N> ›" ref).',
        at("isRepeat"),
      );
    }
    if (deferredBacklogNames.has(q.topic) && !earlierNames.has(q.topic)) {
      issue(
        `${q.id}: topic "${q.topic}" is deferred (the lecturer has not covered it yet) and must not be tested. Remove the question.`,
        at("topic"),
      );
      return;
    }
    if (!earlierNames.has(q.topic)) {
      issue(
        `${q.id}: topic "${q.topic}" is not a known topic of the covered classes. Use a name copied exactly from: ` +
          `${[...earlierNames].map((n) => `"${n}"`).join(", ")}.`,
        at("topic"),
      );
      return;
    }
    if (q.classNumber === null) {
      issue(
        `${q.id}: classNumber must be set to the class the topic "${q.topic}" comes from. ` +
          `Valid (topic, class) pairs: ${validPairs}.`,
        at("classNumber"),
      );
    } else if (!earlierPairs.has(JSON.stringify([q.topic, q.classNumber]))) {
      issue(
        `${q.id}: topic "${q.topic}" is not a topic of predavanje ${q.classNumber}. ` +
          `Valid (topic, class) pairs: ${validPairs}.`,
        at("classNumber"),
      );
    } else if (!refStartsWithClass(q.ref, q.classNumber)) {
      issue(
        `${q.id}: ref must start with "Predavanje ${q.classNumber} ›" (the class named by classNumber ` +
          `${q.classNumber}), but ref is "${q.ref}". Grading updates the class from classNumber, so ` +
          "ref and classNumber must name the same class.",
        at("ref"),
      );
    }
  };

  return QuizPlan.superRefine((plan, zctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      zctx.addIssue({ code: "custom", message, path });
    };

    if (plan.code !== ctx.code) {
      issue(`The quiz code must be "${ctx.code}", not "${plan.code}".`, ["code"]);
    }

    plan.questions.forEach((q, i) => {
      const at = (field: string): (string | number)[] => ["questions", i, field];

      if (q.id !== `q${i + 1}`) {
        issue(
          `Question #${i + 1} has id "${q.id}"; ids must be q1..q${plan.questions.length} in order.`,
          at("id"),
        );
      }

      if (cumulative) {
        checkCumulativeRow(q, at, issue);
      } else if (
        q.isRepeat &&
        deferredBacklogNames.has(q.topic) &&
        (q.classNumber === null
          ? !earlierNames.has(q.topic)
          : deferredBacklog.has(JSON.stringify([q.topic, q.classNumber])))
      ) {
        issue(
          `${q.id}: topic "${q.topic}" is a deferred backlog item (the lecturer has not covered it yet), ` +
            "so it is not a repeat candidate and must not be tested. Remove the question.",
          at("topic"),
        );
      } else if (!validNames.includes(q.topic)) {
        issue(
          `${q.id}: topic "${q.topic}" is not a known topic. Use a name copied exactly from: ` +
            `${validNames.map((n) => `"${n}"`).join(", ")}.`,
          at("topic"),
        );
      } else {
        if (q.isRepeat && !earlierNames.has(q.topic)) {
          issue(
            `${q.id}: isRepeat is true but topic "${q.topic}" is not one of the earlier topics ` +
              "(repeat candidates); use an earlier topic's name or set isRepeat to false.",
            at("isRepeat"),
          );
        } else if (!q.isRepeat && !current.has(q.topic)) {
          issue(
            `${q.id}: topic "${q.topic}" belongs to an earlier class, so isRepeat must be true.`,
            at("isRepeat"),
          );
        }
        if (q.isRepeat && earlierNames.has(q.topic)) {
          if (q.classNumber === null) {
            issue(
              `${q.id}: a repeat must set classNumber to the class the topic "${q.topic}" comes from. ` +
                `Valid (topic, class) pairs: ${validPairs}.`,
              at("classNumber"),
            );
          } else if (!earlierPairs.has(JSON.stringify([q.topic, q.classNumber]))) {
            issue(
              `${q.id}: topic "${q.topic}" is not an earlier topic of predavanje ${q.classNumber}. ` +
                `Valid (topic, class) pairs: ${validPairs}.`,
              at("classNumber"),
            );
          }
        }
        if (q.isRepeat && q.classNumber !== null && !refStartsWithClass(q.ref, q.classNumber)) {
          issue(
            `${q.id}: a repeat's ref must start with "Predavanje ${q.classNumber} ›" (the class named ` +
              `by classNumber ${q.classNumber}), but ref is "${q.ref}". Grading updates the class from ` +
              "classNumber, so ref and classNumber must name the same class.",
            at("ref"),
          );
        }
        if (!q.isRepeat && /^\s*Predavanje\s+\d+\s*›/.test(q.ref)) {
          issue(
            `${q.id}: ref "${q.ref}" starts with "Predavanje <N> ›", which is only for repeats of ` +
              "earlier classes. Use a section path of this class's lesson, or set isRepeat to true.",
            at("ref"),
          );
        }
        if (!q.isRepeat && q.classNumber !== null) {
          issue(
            `${q.id}: classNumber must be null when isRepeat is false (it is only set for repeats ` +
              "of earlier classes).",
            at("classNumber"),
          );
        }
        if (!q.isRepeat && current.get(q.topic)?.deferred) {
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
        if (q.targetsMisconception !== null) {
          issue(
            `${q.id}: open questions have no distractors, so targetsMisconception must be null. ` +
              "Set it to null and target the misconception with an mc or match question.",
            at("targetsMisconception"),
          );
        }
        if (q.keyPoints.length < 2) {
          issue(`${q.id}: an open question needs at least 2 keyPoints.`, at("keyPoints"));
        }
      } else if (q.keyPoints.length > 0) {
        issue(`${q.id}: keyPoints must be empty for a ${q.type} question.`, at("keyPoints"));
      }
    });

    // Coverage is keyed by (topic, misconception): only a non-repeat mc or match question on the
    // topic counts, because the misconception must be a distractor and only those have distractors.
    const targeted = new Set(
      plan.questions.flatMap((q) =>
        q.targetsMisconception === null || q.isRepeat || (q.type !== "mc" && q.type !== "match")
          ? []
          : [JSON.stringify([q.topic, normalizeText(q.targetsMisconception)])],
      ),
    );
    for (const { topic, texts } of requiredMisconceptions(ctx)) {
      const uncovered = texts.filter(
        (t) => !targeted.has(JSON.stringify([topic, normalizeText(t)])),
      );
      if (uncovered.length > 0) {
        issue(
          `Topic "${topic}" has misconceptions from the student's notes that no question targets: ` +
            `${uncovered.map((t) => JSON.stringify(t)).join("; ")}. Add a question for each ` +
            "on that topic (an mc question, or match where it fits; isRepeat false, topic copied exactly), " +
            "with targetsMisconception set to the misconception text copied exactly. A question on " +
            "another topic, a repeat, or a num or open question does not count.",
          ["questions"],
        );
      }
    }

    if (cumulative) {
      // Every unresolved, non-deferred backlog item of a covered class needs a question on its topic and class.
      const covered = new Set(plan.questions.map((q) => JSON.stringify([q.topic, q.classNumber])));
      const missing = ctx.backlog.filter(
        (b) => isRequiredBacklog(b) && !covered.has(JSON.stringify([b.topic, b.classNumber])),
      );
      if (missing.length > 0) {
        issue(
          `Backlog items required in ${ctx.code} have no question: ` +
            `${missing.map((b) => `"${b.topic}" (predavanje ${b.classNumber})`).join(", ")}. ` +
            "Add at least one question for each, with that topic name and that classNumber.",
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
    instruction: buildQuizPlannerInstruction(ctx.course.persona, ctx.kind),
    model: config.MODEL_PLANNER,
    schema: quizPlanSchema(ctx),
    schemaName: "quiz_plan",
    maxOutputTokens: 32_000,
    timeoutMs: 20 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

/** typeMix is redundant with the questions; the planner often miscounts it, so recompute it. */
export function normalizeQuizPlan(plan: QuizPlan): QuizPlan {
  const typeMix = { mc: 0, num: 0, match: 0, open: 0 };
  for (const q of plan.questions) typeMix[q.type]++;
  return { ...plan, typeMix };
}

export async function planQuiz(ctx: QuizContext, opts: QuizPlannerOptions = {}): Promise<QuizPlan> {
  return normalizeQuizPlan(
    await runStage(quizPlannerSpec(ctx, opts), buildQuizPlannerMessage(ctx)),
  );
}
