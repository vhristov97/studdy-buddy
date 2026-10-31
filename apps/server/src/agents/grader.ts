import {
  DONT_KNOW,
  GradingResult,
  type McQuestion,
  type MatchQuestion,
  type NumQuestion,
  type Question,
} from "@studdy/shared";
import { z } from "zod";
import { config } from "../config.js";
import type { GradingContext } from "../grading/context.js";
import { formatTopic } from "./quiz-planner.js";
import { runStage, type StageSpec } from "./stage.js";

export interface GraderOptions {
  onEvent?: StageSpec<GradingResult>["onEvent"];
}

const INSTRUCTION = `You are the tutor of a Serbian university course, grading one student's attempt at a quiz. You are the strong-model grader: grading is never delegated to a cheaper model. Your job is to find out what the student really knows, separate "didn't know" from "believed something wrong", keep the learner model honest, and tell the student exactly what to do next. The student reads your write-up, so it must be accurate, specific and encouraging without flattery.

# Inputs

You receive, in the user message:
- the course, the assessment format (when there is one), the quiz and its code, and when it was submitted;
- the quiz plan's rationale and, per question, whether it is a repeat of an earlier class's topic and which misconception it targets (when a plan exists);
- every question WITH its correct answer, explanation or key points, followed by the student's answer rendered readably (for multiple choice the text of the chosen option; for matching, per row the chosen choice or "Ne znam"; for numbers the value; for open questions the student's text) and the automatic result;
- the automatic score;
- the topics the quiz touched, each with its class, rating (? untested, ✗ weak, ~ partial, ✓ good) and history: misconceptions the student's notes contained (source "notes"), and how earlier quizzes and grading went;
- the topics the plan left out of the quiz;
- the lessons (inside <lekcija>), which are the source of truth for facts;
- the code of the next cumulative quiz, and the current backlog, the observations about the student and the current "Sledeće" (next steps) list, when there are any.

# Language

Write every text field in Serbian, Latin script, with correct diacritics (č, ć, š, ž, đ). Never use Cyrillic. Established English technical terms (batch, streaming, sharding, ...) stay in English. Everything else in this instruction is in English only because it is addressed to you. Topic names must be copied exactly (character for character) from the user message.

# Grading procedure

1. Re-check the automatic score by hand. Go through the closed questions, compare the student's answers to the correct ones, and recompute the score (a match question gives the share of correct rows; a number is correct within the tolerance). Set autoCheck.agrees to true and note to null when the automatic score is right. Otherwise set agrees to false and explain in note what differs and why. The automatic result is what the system stores; you only report a disagreement.
2. Grade the open answers. Every open question with status open_pending gets exactly one openGrades entry: score is a fraction from 0 to 1 (for example 0.4 or 0.75), judged against the question's key points, which list everything a complete oral answer names. In "right" say what was correct. In "missing" say what was missing: structure, step order, enumerations, the lecturer's examples and analogies, precise terms. Be strict about enumerations and the lecturer's examples, because the student faces an oral exam where a correct but skeletal answer is not enough. An answer that states something wrong loses credit for it. Open questions that were answered "Ne znam" or left empty are not graded here; they are gaps (see below).
3. Classify every miss. A miss is: a closed question that is wrong, partial, "Ne znam" or unanswered (for a match question, every affected row separately, with its 0-based rowIndex; all other types have rowIndex null), and every open question that is not fully scored (score below 1, including "Ne znam" and unanswered ones). There is exactly one item per miss and no item for anything answered correctly. Classification rules, which are invariants of the whole system:
   - "Ne znam" and an unanswered question are a GAP ("nije znao"), never a misconception. Use classification "gap" and set misconception to null. The concept will be taught first rather than targeted as a misconception.
   - A wrong answer is a MISCONCEPTION, never a mere gap. Use classification "misconception", set studentAnswer to the student's own wording or choice (for a closed question the text of the option or choice the student picked, or the number they typed) and set misconception to the wrong belief stated in the student's own wording, as short as possible. Fill likelyCause with a guess at why the student believed it when one is visible (for example "read 'not guaranteed' as 'doesn't use the host disk'"), otherwise null.
   - "partial" is only for an open answer with 0 < score < 1 that is incomplete but does not state anything wrong. If an open answer states something wrong, use "misconception" (with misconception and studentAnswer filled in). An open answer with score 0 is a gap when the student wrote nothing relevant, and a misconception when it states something wrong.
   - keyFact is the one fact that closes the miss, taken from the lesson or the question's explanation or key points. topic is the question's topic name.
   - A question the student "knew" only by luck cannot be detected; do not guess.
4. Misconceptions from the student's notes (history entries with source "notes") that this submission shows are now fixed, because the student answered a question that targeted them correctly, go to correctFixes (topic and the misconception text copied from the history). Only list a fix when a correct answer actually demonstrates it.
5. Update the learner model. Every topic of the quiz (the list in the message) gets exactly one topicUpdates entry with its classNumber, a rating and a short note. Rating: ✗ (weak) when the student got a misconception or mostly gaps on it, ~ (partial) when answers were mixed or an open answer was incomplete, ✓ (good) when all its questions were answered correctly. A topic with a single correct answer on an easy question is ✓ only when the question tested the concept itself. The note says what happened in a few words (for example "P02: pogrešno q3 (zabluda), ne znam q7").
6. Update the backlog for the next cumulative quiz, whose code is given in the message. backlogAdd: every topic you rated ✗ or ~ because of misconceptions goes in with reason "weak"; a topic with gaps ("Ne znam") goes in with reason "gap"; every topic the plan left out (listed in the message) goes in with reason "left_out", with classNumber from that list. dueQuiz must be exactly the given code. One entry per topic. backlogResolve: topics now solid (rated ✓) that are on the current backlog; use their topic name and classNumber.
7. Observations about the student (observations): only new, general patterns the evidence of this submission supports, shared across all courses (for example that calculations are weaker, that open answers skip enumerations and the lecturer's analogies, that the student uses "Ne znam" honestly, that repeated topics from earlier classes still fail). Do not repeat an observation that is already listed. Leave the list empty when there is nothing new and general.
8. Write the new "Sledeće" list (nextSteps): the FULL, ordered replacement of the current list, at least one entry. Typical order: teach the gap topics first (name them), then oral follow-ups on the weak open questions (name the question and what to practise: the full structure, the enumeration), then re-test each misconception from a new angle, then the next class to process or the next cumulative quiz. Keep old entries that are still true; drop those this grading settled.
9. Write the results write-up (writeupMd) in Markdown, addressed to the student, with these parts in this order:
   - a "## Rezultat" summary table: the automatic score with partial credit (x / y), the score under the exam's 0/1 rule (each closed question counts 1 only when fully correct, 0 otherwise; if the assessment format says otherwise, follow it), sub-scores for this class's questions versus repeats from earlier classes, the open-question score (sum of your open grades / number of open questions), and the total. If you disagree with the automatic score, say so here.
   - a "## Tačno" section: what was answered correctly, grouped by topic, and which misconceptions from the notes the student's answers show were fixed;
   - a "## Netačno (zabluda)" table with the columns Pitanje, Tema, Tvoj odgovor, Tačan odgovor, Šta je promaklo (one row per misconception item, including wrong match rows and open misconceptions); say "Nema" if empty;
   - a "## Ne znam (praznina)" table with the columns Pitanje, Tema, Ključna činjenica (one row per gap item); say "Nema" if empty. Gaps are not mistakes: say that they will be taught first;
   - a "## Otvorena pitanja" section with, for each open question, the score, what was right, what was missing, and the follow-up to do;
   - a "## Sledeći koraci" section repeating nextSteps.
   Reference questions by id and short topic (for example q7, Batch obrada). Never invent facts: everything stated as correct comes from the question, its explanation or the lessons.

# Self-check before answering

Check that: every open_pending question has one grade; every miss has exactly one item and nothing else has one; no gap has a misconception text and no misconception item lacks one; every quiz topic has exactly one topicUpdates entry; dueQuiz is the given code; every left-out topic is on backlogAdd; topic names are copied exactly; nextSteps is not empty; the write-up tables match the items.

# Output

Return only the JSON object matching the required schema.`;

export function buildGraderInstruction(persona: string | null): string {
  if (persona === null) return INSTRUCTION;
  return `${INSTRUCTION}\n\nYou are also ${persona}; let that practical experience shape your judgement of the answers and the follow-ups you recommend.`;
}

type Value = unknown;

const has = (answers: object, key: string): boolean => Object.hasOwn(answers, key);

function answerOf(ctx: GradingContext, id: string): Value {
  return has(ctx.submission.answers, id) ? ctx.submission.answers[id] : undefined;
}

function isRecord(value: Value): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, " ").trim());
}

function renderMc(q: McQuestion, value: Value): string {
  if (value === DONT_KNOW) return "Ne znam";
  if (typeof value !== "number") return "(bez odgovora)";
  const text = q.options[value];
  return `[${value}] ${text === undefined ? "(nepoznata opcija)" : quote(text)}`;
}

function renderNum(q: NumQuestion, value: Value): string {
  if (value === DONT_KNOW) return "Ne znam";
  if (typeof value !== "number") return "(bez odgovora)";
  return `${value}${q.unit ? ` ${q.unit}` : ""}`;
}

function renderMatchRow(q: MatchQuestion, value: Value, row: number): string {
  if (value === DONT_KNOW) return "Ne znam";
  if (!isRecord(value) || !has(value, String(row))) return "(bez odgovora)";
  const choice = value[String(row)];
  if (choice === DONT_KNOW) return "Ne znam";
  if (typeof choice !== "number") return "(bez odgovora)";
  const text = q.choices[choice];
  return `[${choice}] ${text === undefined ? "(nepoznata opcija)" : quote(text)}`;
}

function renderOpen(value: Value): string {
  if (value === DONT_KNOW) return "Ne znam";
  if (typeof value !== "string" || value.trim() === "") return "(bez odgovora)";
  return `\n"""\n${value.trim()}\n"""`;
}

function renderQuestion(ctx: GradingContext, q: Question, index: number): string {
  const planRow = ctx.plan?.questions.find((p) => p.id === q.id);
  const result = ctx.submission.results.find((r) => r.id === q.id);
  const value = answerOf(ctx, q.id);

  const head = `### ${q.id} (${index + 1}. pitanje) · ${q.type} · tema: ${q.topic} · ref: ${q.ref}${q.extra ? " · dopuna (D)" : ""}`;
  const lines: string[] = [head];
  if (planRow?.isRepeat) lines.push("Ponavljanje teme iz ranijeg predavanja.");
  if (planRow?.targetsMisconception) {
    lines.push(`Pitanje cilja zabludu: ${quote(planRow.targetsMisconception)}`);
  }
  lines.push(`Pitanje: ${q.prompt}`);

  switch (q.type) {
    case "mc":
      q.options.forEach((o, i) => {
        lines.push(`  [${i}] ${o}${i === q.answer ? "   <- TAČNO" : ""}`);
      });
      lines.push(`Objašnjenje: ${q.explanation}`);
      lines.push(`Odgovor studenta: ${renderMc(q, value)}`);
      break;
    case "num":
      lines.push(
        `Tačan odgovor: ${q.answer}${q.unit ? ` ${q.unit}` : ""} (tolerancija ${q.tolerance})`,
      );
      lines.push(`Objašnjenje: ${q.explanation}`);
      lines.push(`Odgovor studenta: ${renderNum(q, value)}`);
      break;
    case "match":
      q.rows.forEach((row, i) => {
        const correctIndex = q.answer[i];
        const correctText = correctIndex === undefined ? "?" : (q.choices[correctIndex] ?? "?");
        const given = renderMatchRow(q, value, i);
        const raw = isRecord(value) && has(value, String(i)) ? value[String(i)] : undefined;
        const mark =
          typeof raw === "number"
            ? raw === correctIndex
              ? "tačno"
              : "NETAČNO"
            : given === "Ne znam"
              ? "ne znam"
              : "bez odgovora";
        lines.push(
          `  red ${i} (rowIndex ${i}): ${quote(row)} -> tačno ${quote(correctText)}; student: ${given} [${mark}]`,
        );
      });
      lines.push(`Objašnjenje: ${q.explanation}`);
      break;
    case "open":
      lines.push("Ključne tačke potpunog odgovora:");
      q.keyPoints.forEach((k) => lines.push(`  - ${k}`));
      lines.push(`Odgovor studenta: ${renderOpen(value)}`);
      break;
  }

  if (result) {
    const parts = [
      `status: ${result.status}`,
      `automatski bodovi: ${Math.round(result.score * 100) / 100}/${result.max}`,
    ];
    if (result.totalRows !== undefined) {
      parts.push(`tačnih redova: ${result.correctRows ?? 0}/${result.totalRows}`);
    }
    lines.push(`Automatski rezultat: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

export function buildGraderMessage(ctx: GradingContext): string {
  const header = [
    `Kurs: ${ctx.course.name}`,
    `Kviz ${ctx.quiz.code}: ${ctx.quiz.title} (${ctx.quiz.subtitle})`,
    `Predato: ${ctx.submission.submittedAt}`,
    `Šifra sledećeg kumulativnog kviza: ${ctx.nextCumulativeCode}`,
  ];
  if (ctx.course.assessmentFormat !== null) {
    header.push(`Format ocenjivanja:\n${ctx.course.assessmentFormat}`);
  }

  const sub = ctx.submission;
  const sections = [
    header.join("\n"),
    ctx.plan
      ? `Obrazloženje plana kviza:\n${ctx.plan.weightingRationale}`
      : "Plan kviza nije dostupan.",
    `Automatski rezultat zatvorenih pitanja: ${sub.autoScore} / ${sub.autoMax}. ` +
      `Odgovori "Ne znam": ${sub.dontKnow.length > 0 ? sub.dontKnow.join(", ") : "nema"}.`,
    `Pitanja, tačni odgovori i odgovori studenta:\n\n${ctx.quiz.questions
      .map((q, i) => renderQuestion(ctx, q, i))
      .join("\n\n")}`,
    `Teme kviza (svaka mora dobiti tačno jedan topicUpdates), sa istorijom:\n${
      ctx.topics.length > 0
        ? ctx.topics.map((t, i) => formatTopic(t, i, t.classNumber)).join("\n")
        : "(nema)"
    }`,
    ctx.leftOutTopics.length > 0
      ? "Teme koje je plan izostavio iz kviza (idu u backlog kao left_out):\n" +
        ctx.leftOutTopics
          .map((t) => `- ${t.name} (predavanje ${t.classNumber}): ${t.reason}`)
          .join("\n")
      : "Plan nije izostavio nijednu temu.",
    ...ctx.lessons.map(
      (l) =>
        `Lekcija, predavanje ${l.classNumber}: ${l.title}\n<lekcija predavanje="${l.classNumber}">\n${l.lessonMd}\n</lekcija>`,
    ),
    ctx.backlog.length > 0
      ? "Trenutni backlog:\n" +
        ctx.backlog.map((b) => `- ${b.topic} (obavezno u ${b.dueQuiz}): ${b.reason}`).join("\n")
      : "Backlog je prazan.",
    ctx.observations.length > 0
      ? `Postojeća zapažanja o studentu:\n${ctx.observations.map((o) => `- ${o}`).join("\n")}`
      : "Nema postojećih zapažanja o studentu.",
    ctx.nextSteps.length > 0
      ? `Trenutna lista "Sledeće":\n${ctx.nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : 'Lista "Sledeće" je prazna.',
    `Oceni predaju kviza ${ctx.quiz.code} prema uputstvu.`,
  ];
  return sections.join("\n\n");
}

interface Miss {
  /** "gap" for "Ne znam" and unanswered; "wrong" for a wrong answer. */
  kind: "gap" | "wrong";
  rowIndex: number | null;
}

/** The misses of a closed question, per affected row for match questions. Open questions have none. */
export function closedMisses(q: Question, value: Value, status: string): Miss[] {
  switch (q.type) {
    case "open":
      return [];
    case "mc":
    case "num":
      if (status === "dont_know" || status === "unanswered")
        return [{ kind: "gap", rowIndex: null }];
      return status === "wrong" ? [{ kind: "wrong", rowIndex: null }] : [];
    case "match": {
      if (status === "correct") return [];
      const misses: Miss[] = [];
      q.rows.forEach((_, i) => {
        if (!isRecord(value) || !has(value, String(i)) || value[String(i)] === DONT_KNOW) {
          misses.push({ kind: "gap", rowIndex: i });
        } else if (value[String(i)] !== q.answer[i]) {
          misses.push({ kind: "wrong", rowIndex: i });
        }
      });
      return misses;
    }
  }
}

const missKey = (questionId: string, rowIndex: number | null): string =>
  `${questionId}|${rowIndex ?? ""}`;
const pairKey = (topic: string, classNumber: number): string =>
  JSON.stringify([topic, classNumber]);
const label = (questionId: string, rowIndex: number | null): string =>
  rowIndex === null ? questionId : `${questionId} row ${rowIndex}`;

/**
 * The result schema plus the cross-field checks the model can fix when told about them (the
 * stage's repair loop sends these messages back).
 */
export function gradingResultSchema(ctx: GradingContext): z.ZodType<GradingResult> {
  const questions = new Map(ctx.quiz.questions.map((q) => [q.id, q]));
  const results = new Map(ctx.submission.results.map((r) => [r.id, r]));
  const topicNames = new Set(ctx.topics.map((t) => t.name));
  const topicPairs = new Set(ctx.topics.map((t) => pairKey(t.name, t.classNumber)));
  const leftOutPairs = new Set(ctx.leftOutTopics.map((t) => pairKey(t.name, t.classNumber)));
  const topicList = ctx.topics.map((t) => `"${t.name}" (classNumber ${t.classNumber})`).join(", ");

  return GradingResult.superRefine((result, zctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      zctx.addIssue({ code: "custom", message, path });
    };

    // Open grades.
    const grades = new Map<string, number>();
    result.openGrades.forEach((g, i) => {
      const q = questions.get(g.questionId);
      const at = ["openGrades", i, "questionId"];
      if (!q) {
        issue(`openGrades: "${g.questionId}" is not a question of this quiz.`, at);
        return;
      }
      const status = results.get(g.questionId)?.status;
      if (q.type !== "open" || status !== "open_pending") {
        issue(
          `openGrades: ${g.questionId} must not be graded; only open questions with status ` +
            `open_pending are (this one is ${q.type}${status ? `, status ${status}` : ""}).`,
          at,
        );
        return;
      }
      if (grades.has(g.questionId)) {
        issue(`openGrades: ${g.questionId} is graded more than once; keep a single entry.`, at);
        return;
      }
      grades.set(g.questionId, g.score);
    });
    for (const q of ctx.quiz.questions) {
      if (results.get(q.id)?.status === "open_pending" && !grades.has(q.id)) {
        issue(`openGrades: open question ${q.id} (open_pending) has no grade; add one.`, [
          "openGrades",
        ]);
      }
    }

    // Items.
    const seen = new Set<string>();
    const present = new Set<string>();
    result.items.forEach((item, i) => {
      const at = (field: string): (string | number)[] => ["items", i, field];
      const where = label(item.questionId, item.rowIndex);
      const q = questions.get(item.questionId);
      if (!q) {
        issue(`items: "${item.questionId}" is not a question of this quiz.`, at("questionId"));
        return;
      }
      const key = missKey(item.questionId, item.rowIndex);
      if (seen.has(key)) {
        issue(
          `items: ${where} has more than one item; keep a single item per miss.`,
          at("questionId"),
        );
        return;
      }
      seen.add(key);

      if (item.topic !== q.topic) {
        issue(
          `items: ${where} is a question on topic "${q.topic}", but the item says "${item.topic}". ` +
            "Copy the question's topic name exactly.",
          at("topic"),
        );
      }

      const value = answerOf(ctx, q.id);
      const status = results.get(q.id)?.status ?? "unanswered";
      let required: "gap" | "wrong" | "open" | undefined;
      let unneeded = "";

      if (q.type === "open") {
        if (item.rowIndex !== null) {
          issue(`items: ${where} is an open question, so rowIndex must be null.`, at("rowIndex"));
        }
        if (status === "open_pending") {
          const score = grades.get(q.id);
          if (score === undefined) return; // reported under openGrades
          if (score >= 1) {
            unneeded = `${q.id} was graded 1 (fully correct), so it must have no item.`;
          } else {
            required = "open";
          }
        } else if (status === "dont_know" || status === "unanswered") {
          required = "gap";
        } else {
          unneeded = `${q.id} has status ${status}; open questions get an item only when they are missed.`;
        }
      } else {
        const misses = closedMisses(q, value, status);
        const miss = misses.find((m) => m.rowIndex === item.rowIndex);
        if (q.type === "match" && item.rowIndex === null) {
          issue(
            `items: ${q.id} is a match question; give one item per affected row with its 0-based rowIndex.`,
            at("rowIndex"),
          );
          return;
        }
        if (q.type !== "match" && item.rowIndex !== null) {
          issue(
            `items: ${q.id} is not a match question, so rowIndex must be null.`,
            at("rowIndex"),
          );
          return;
        }
        if (!miss) {
          unneeded =
            q.type === "match"
              ? `${where} was answered correctly (or does not exist); remove its item.`
              : `${q.id} was answered correctly (status ${status}); remove its item.`;
        } else {
          required = miss.kind;
        }
      }

      if (unneeded) {
        issue(`items: ${unneeded}`, at("questionId"));
        return;
      }
      present.add(key);

      if (required === "gap") {
        if (item.classification !== "gap" || item.misconception !== null) {
          issue(
            `items: ${where} was answered "Ne znam" or left unanswered, so it is a gap: ` +
              'classification must be "gap" and misconception must be null. "Ne znam" is never a misconception.',
            at("classification"),
          );
        }
      } else if (required === "wrong") {
        if (
          item.classification !== "misconception" ||
          item.misconception === null ||
          item.studentAnswer === null
        ) {
          issue(
            `items: ${where} was answered wrong, so it is a misconception: classification must be ` +
              '"misconception" with the wrong belief in misconception and the student\'s own wording in ' +
              "studentAnswer (both non-null). A wrong answer is never a mere gap.",
            at("classification"),
          );
        }
      } else if (required === "open") {
        if (item.classification === "gap" && item.misconception !== null) {
          issue(
            `items: ${where} is classified "gap", so misconception must be null. If the answer states ` +
              'something wrong, classify it "misconception" instead.',
            at("misconception"),
          );
        }
        if (
          item.classification === "misconception" &&
          (item.misconception === null || item.studentAnswer === null)
        ) {
          issue(
            `items: ${where} is classified "misconception", so misconception and studentAnswer must ` +
              "be non-null.",
            at("misconception"),
          );
        }
      }
      if (item.classification === "partial") {
        const score = grades.get(q.id);
        if (q.type !== "open" || (score !== undefined && (score <= 0 || score >= 1))) {
          issue(
            `items: ${where} is classified "partial"; that is only for an open answer with a score ` +
              "above 0 and below 1.",
            at("classification"),
          );
        }
      }
    });

    // Every miss has an item.
    for (const q of ctx.quiz.questions) {
      const status = results.get(q.id)?.status ?? "unanswered";
      if (q.type === "open") {
        const score = grades.get(q.id);
        const missed =
          status === "dont_know" ||
          status === "unanswered" ||
          (status === "open_pending" && score !== undefined && score < 1);
        if (missed && !present.has(missKey(q.id, null))) {
          issue(
            `items: ${q.id} is an open question that was not fully answered ` +
              `(${status === "open_pending" ? `graded ${score}` : status}); add an item for it.`,
            ["items"],
          );
        }
        continue;
      }
      for (const miss of closedMisses(q, answerOf(ctx, q.id), status)) {
        if (!present.has(missKey(q.id, miss.rowIndex))) {
          issue(
            `items: ${label(q.id, miss.rowIndex)} was a miss (${miss.kind === "gap" ? '"Ne znam" or unanswered, a gap' : "wrong, a misconception"}) ` +
              "and has no item; add one" +
              (q.type === "match" ? " with its rowIndex." : "."),
            ["items"],
          );
        }
      }
    }

    // Topic references.
    const checkName = (name: string, path: (string | number)[], where: string): void => {
      if (!topicNames.has(name)) {
        issue(
          `${where}: topic "${name}" is not a topic of this quiz. Use one of: ${topicList}.`,
          path,
        );
      }
    };
    result.correctFixes.forEach((f, i) => {
      checkName(f.topic, ["correctFixes", i, "topic"], "correctFixes");
    });

    const updated = new Set<string>();
    result.topicUpdates.forEach((u, i) => {
      const key = pairKey(u.topic, u.classNumber);
      if (!topicPairs.has(key)) {
        issue(
          `topicUpdates: topic "${u.topic}" with classNumber ${u.classNumber} is not a topic of this ` +
            `quiz. Use one of: ${topicList}.`,
          ["topicUpdates", i, "topic"],
        );
      } else if (updated.has(key)) {
        issue(
          `topicUpdates: topic "${u.topic}" (classNumber ${u.classNumber}) appears more than once; keep one entry.`,
          ["topicUpdates", i, "topic"],
        );
      }
      updated.add(key);
    });
    for (const t of ctx.topics) {
      if (!updated.has(pairKey(t.name, t.classNumber))) {
        issue(
          `topicUpdates: quiz topic "${t.name}" (classNumber ${t.classNumber}) has no entry; add exactly one.`,
          ["topicUpdates"],
        );
      }
    }

    // Backlog.
    const added = new Set<string>();
    result.backlogAdd.forEach((b, i) => {
      const key = pairKey(b.topic, b.classNumber);
      const at = (field: string): (string | number)[] => ["backlogAdd", i, field];
      if (b.dueQuiz !== ctx.nextCumulativeCode) {
        issue(
          `backlogAdd: dueQuiz must be "${ctx.nextCumulativeCode}", not "${b.dueQuiz}".`,
          at("dueQuiz"),
        );
      }
      if (b.reason === "left_out") {
        if (!leftOutPairs.has(key)) {
          issue(
            `backlogAdd: reason left_out is only for topics the plan left out: ` +
              `${ctx.leftOutTopics.map((t) => `"${t.name}" (classNumber ${t.classNumber})`).join(", ") || "none"}. ` +
              `"${b.topic}" (classNumber ${b.classNumber}) is not one; use weak or gap for quiz topics.`,
            at("topic"),
          );
        }
      } else if (!topicPairs.has(key)) {
        issue(
          `backlogAdd: topic "${b.topic}" with classNumber ${b.classNumber} is not a topic of this ` +
            `quiz. Use one of: ${topicList}.`,
          at("topic"),
        );
      }
      if (added.has(key)) {
        issue(
          `backlogAdd: topic "${b.topic}" (classNumber ${b.classNumber}) is added more than once.`,
          at("topic"),
        );
      }
      added.add(key);
    });
    for (const t of ctx.leftOutTopics) {
      if (
        !result.backlogAdd.some(
          (b) =>
            b.reason === "left_out" &&
            pairKey(b.topic, b.classNumber) === pairKey(t.name, t.classNumber),
        )
      ) {
        issue(
          `backlogAdd: the plan left out "${t.name}" (classNumber ${t.classNumber}); add it with reason left_out and dueQuiz "${ctx.nextCumulativeCode}".`,
          ["backlogAdd"],
        );
      }
    }
    result.backlogResolve.forEach((b, i) => {
      const key = pairKey(b.topic, b.classNumber);
      if (!topicPairs.has(key)) {
        issue(
          `backlogResolve: topic "${b.topic}" with classNumber ${b.classNumber} is not a topic of this ` +
            `quiz. Use one of: ${topicList}.`,
          ["backlogResolve", i, "topic"],
        );
      } else if (added.has(key)) {
        issue(
          `backlogResolve: topic "${b.topic}" (classNumber ${b.classNumber}) is both added to and ` +
            "resolved from the backlog; keep only one.",
          ["backlogResolve", i, "topic"],
        );
      }
    });

    if (result.writeupMd.trim() === "") {
      issue("writeupMd must not be empty; write the results write-up.", ["writeupMd"]);
    }
  });
}

export function graderSpec(
  ctx: GradingContext,
  opts: GraderOptions = {},
): StageSpec<GradingResult> {
  return {
    name: "grader",
    instruction: buildGraderInstruction(ctx.course.persona),
    model: config.MODEL_PLANNER,
    schema: gradingResultSchema(ctx),
    schemaName: "grading_result",
    maxOutputTokens: 32_000,
    timeoutMs: 20 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

export async function gradeSubmission(
  ctx: GradingContext,
  opts: GraderOptions = {},
): Promise<GradingResult> {
  return runStage(graderSpec(ctx, opts), buildGraderMessage(ctx));
}
