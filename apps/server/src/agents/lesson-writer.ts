import { LessonDraft } from "@studdy/shared";
import { z } from "zod";
import { config } from "../config.js";
import { runStage, type StageSpec } from "./stage.js";

export interface LessonSource {
  /** File name as uploaded. */
  name: string;
  text: string;
}

export interface LessonWriterInput {
  course: { name: string; persona: string | null; assessmentFormat: string | null };
  class: { number: number; title: string };
  /** At least one; the caller passes only successfully extracted ones. */
  materials: LessonSource[];
  /** May be empty. */
  notes: LessonSource[];
}

export interface LessonWriterOptions {
  onEvent?: StageSpec<LessonDraft>["onEvent"];
}

const INSTRUCTION = `You are an experienced tutor for a Serbian university course. Your job is to write the unified lesson note for one class. The note is the single source of truth for every later step (quizzes, grading, cumulative reviews), so it must be complete with respect to the slides' content and the lecturer's remarks in the student's notes, and it must be correct.

# Inputs

You receive, in the user message:
- the course name, the class number and title, and sometimes the course's assessment format;
- the class materials, inside <materijal ime="..."> blocks: the official slides, as extracted text. The extraction is messy: bullet glyphs may sit on their own lines, columns can be scrambled, and one page can hold two slides (pages start with "--- strana N ---", slide titles are "## ...", bullets are "- ..."). Read it for content, not layout;
- the student's own lecture notes, inside <beleske ime="..."> blocks, as verbatim Markdown (possibly with ~~strikethrough~~). The notes are optional. If the message says there are no notes, build the lesson from the materials alone.

# Language

Write in Serbian, Latin script, with correct diacritics (č, ć, š, ž, đ). Never use Cyrillic. Established English technical terms (batch, streaming, sharding, ...) stay in English; where the slides use a Serbian term for one, give it alongside.

# The lesson (lessonMd)

Merge slides and notes into ONE study note for this class, as Markdown:
- No H1: the app shows the class title. Start with an overview paragraph of 2-4 sentences.
- Then "##" sections following the slides' order. Merge slides that continue the same topic into one section. Use "###" for subsections.
- Write content as bullets or short paragraphs. Keep enumerations, step orders, definitions and the lecturer's analogies complete: the student faces an oral exam where a skipped item in an enumeration costs points. Do not summarize away detail that could be asked.
- Put code and commands in fenced code blocks.
- Skip non-content slides (title page, agenda, contact information, "pitanja?"). If the slides list literature or sources, keep a short references line.

## Source tags

Every item (bullet or paragraph) carries its source:
- no tag: the item comes from the slides;
- (P): the lecturer's spoken remark, taken from the student's notes. Treat these as authoritative and likely exam material;
- (D): your own addition as a tutor. Use it sparingly, only where it clarifies something or fills a gap that is needed to understand the slides, and only if it is correct.
Write the tag literally as "(P)" or "(D)" at the START of the item text, with no bold and no other placement, for example:
- (P) Netflix generiše oko 25% internet saobraćaja.
Content that appears in both the slides and the notes is untagged (it comes from the slides). If the notes add extra detail to it, put that detail in a separate (P) item.

## Corrections

Where the notes are wrong or imprecise, put the correct content in the lesson, and right after it add a visible blockquote callout in this exact form:
> ⚠️ Ispravka: <what the notes say> — <what is correct and why>
Every such correction must also be listed as a misconception ({claim, correction}) on the matching topic. Claim stays close to the student's own wording; correction is the correct statement. Do not flag typos, informal wording or abbreviations; only content that is factually wrong or misleading.

## Strikethrough in the notes

Text struck through with ~~...~~ has no fixed meaning: it may be unfinished, misspelled or badly worded. It never means "skipped" or "not on the exam". Do not trust the struck wording; take that content from the slides. If a struck item could affect exam scope (for example it might mean "this will not be tested"), keep the content in the lesson and add a callout asking the student to confirm:
> ❓ Pitanje: <question for the student>

## Deferred topics

If the lecturer only mentioned a topic and promised to cover it later (for example "o Lambda/Kappa arhitekturi više kasnije"), give it a short mention in the lesson followed by a callout:
> ⏳ Odloženo: <what was promised, and when if known>
and record it as a topic with deferred = true and a deferredNote.

## Without notes

When there are no notes, build the lesson from the materials alone: no (P) items, no corrections, no misconceptions, every topic has an empty misconceptions list.

## What not to include

Do not write the knowledge-tracking table (columns Tema | Ocena | Testirano | Napomene) into lessonMd. The app builds it from the topics list.

# Topics (topics)

Return one entry per testable unit of the lesson, typically 6-20, in lesson order. Name each with a short Serbian name that the student would recognize, ideally matching or close to a section heading. Names must be unique within the lesson. Every topic must be covered by the lesson text. Put each misconception on the topic it belongs to. Include deferred topics (deferred = true, with a deferredNote; for all other topics deferredNote is null).

# Assessment format

If an assessment format is given, use it to judge emphasis (what must be stated precisely and completely), not to change the structure of the lesson.

# Output

Return only the JSON object matching the required schema.`;

export function buildLessonWriterInstruction(persona: string | null): string {
  if (persona === null) return INSTRUCTION;
  return `${INSTRUCTION}\n\nYou are also ${persona}; draw on that practical experience in your (D) additions.`;
}

function block(tag: string, source: LessonSource): string {
  return `<${tag} ime="${source.name}">\n${source.text}\n</${tag}>`;
}

export function buildLessonWriterMessage(input: LessonWriterInput): string {
  const parts = [
    `Kurs: ${input.course.name}`,
    `Predavanje ${input.class.number}: ${input.class.title}`,
  ];
  if (input.course.assessmentFormat !== null) {
    parts.push(`Format ocenjivanja:\n${input.course.assessmentFormat}`);
  }
  const sections = [
    parts.join("\n"),
    ...input.materials.map((m) => block("materijal", m)),
    ...(input.notes.length > 0
      ? input.notes.map((n) => block("beleske", n))
      : [
          "Za ovo predavanje nema beleški. Lekcija se pravi samo na osnovu materijala " +
            "(bez (P) stavki, ispravki i zabluda).",
        ]),
    "Napiši objedinjenu lekciju za ovo predavanje i listu tema, prema uputstvu.",
  ];
  return sections.join("\n\n");
}

const TRACKING_TABLE_HEADER = /^[ \t]*\|[^\n]*\bTema\b[^\n]*\bOcena\b[^\n]*$/im;
const ISPRAVKA_CALLOUT = /^[ \t]*>[ \t]*⚠️?[ \t]*Ispravka:/m;
const ISPRAVKA_ANY = /⚠️?[ \t]*Ispravka/;
const P_TAG = /\(P\)/;

/**
 * The lesson draft schema plus the cross-field checks the model can fix when told about them
 * (the stage's repair loop sends these messages back).
 */
export function lessonDraftSchema(opts: { hasNotes: boolean }): z.ZodType<LessonDraft> {
  return LessonDraft.superRefine((draft, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: "custom", message, path });
    };

    const seen = new Map<string, number>();
    draft.topics.forEach((topic, i) => {
      const key = topic.name.trim().toLowerCase();
      const first = seen.get(key);
      if (first !== undefined) {
        issue(
          `Topic name "${topic.name}" duplicates topic #${first + 1}; topic names must be unique ` +
            "(ignoring case and surrounding whitespace).",
          ["topics", i, "name"],
        );
      } else {
        seen.set(key, i);
      }

      if (!topic.deferred && topic.deferredNote !== null) {
        issue(`Topic "${topic.name}" is not deferred, so deferredNote must be null.`, [
          "topics",
          i,
          "deferredNote",
        ]);
      }
      if (topic.deferred && (topic.deferredNote === null || topic.deferredNote.trim() === "")) {
        issue(`Topic "${topic.name}" is deferred, so deferredNote must say what was promised.`, [
          "topics",
          i,
          "deferredNote",
        ]);
      }
    });

    if (TRACKING_TABLE_HEADER.test(draft.lessonMd)) {
      issue(
        "lessonMd contains the knowledge-tracking table (header with Tema and Ocena). Remove it; " +
          "the app builds that table from the topics list.",
        ["lessonMd"],
      );
    }

    const misconceptionCount = draft.topics.reduce((n, t) => n + t.misconceptions.length, 0);

    if (!opts.hasNotes) {
      draft.topics.forEach((topic, i) => {
        if (topic.misconceptions.length > 0) {
          issue(
            `Topic "${topic.name}" has misconceptions, but there are no notes; misconceptions ` +
              "come only from the student's notes. Use an empty list.",
            ["topics", i, "misconceptions"],
          );
        }
      });
      if (P_TAG.test(draft.lessonMd)) {
        issue(
          "lessonMd contains a (P) tag, but there are no notes; (P) marks the lecturer's remarks " +
            "from the student's notes. Remove every (P) tag.",
          ["lessonMd"],
        );
      }
      if (ISPRAVKA_ANY.test(draft.lessonMd)) {
        issue(
          "lessonMd contains a ⚠️ Ispravka callout, but there are no notes to correct. Remove it.",
          ["lessonMd"],
        );
      }
    } else if (misconceptionCount > 0 && !ISPRAVKA_CALLOUT.test(draft.lessonMd)) {
      issue(
        "Some topics list misconceptions, but lessonMd has no '> ⚠️ Ispravka: ...' callout. " +
          "Put a callout in the lesson right after each corrected item.",
        ["lessonMd"],
      );
    }
  });
}

export function lessonWriterSpec(
  input: LessonWriterInput,
  opts: LessonWriterOptions = {},
): StageSpec<LessonDraft> {
  return {
    name: "lesson-writer",
    instruction: buildLessonWriterInstruction(input.course.persona),
    model: config.MODEL_PLANNER,
    schema: lessonDraftSchema({ hasNotes: input.notes.length > 0 }),
    schemaName: "lesson_draft",
    maxOutputTokens: 64_000,
    timeoutMs: 30 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

export async function writeLesson(
  input: LessonWriterInput,
  opts: LessonWriterOptions = {},
): Promise<LessonDraft> {
  if (input.materials.length === 0) {
    throw new Error("Cannot write a lesson without class materials.");
  }
  return runStage(lessonWriterSpec(input, opts), buildLessonWriterMessage(input));
}
