# Study Tutor: functional specification

A standalone version of the study setup currently run through Claude Code in this folder (ASVSP) and in `~/Documents/Fax/HPC/Predavanja/predavanja-HPC/` (HPC). This document describes **what the app does**, based on how the setup works today. It does not prescribe a tech stack.

## 1. Purpose

The app helps one student learn a university course **across the semester**, using spaced, cumulative practice instead of cramming before the exam. An LLM acts as an experienced practitioner and tutor:

- It merges the official slides and the student's own lecture notes into one corrected study note per lecture.
- It tracks what the student knows, topic by topic, across lectures and quizzes.
- It writes quizzes that target weak spots and that mirror the real exam format.
- It grades the answers, separating "didn't know" from "believed something wrong".
- It runs oral-exam-style follow-ups in chat.
- It builds interactive visualizations for concepts that are hard to picture, when the student agrees to one.

## 2. Core concepts

| Concept | Meaning |
|---|---|
| **Course** | One subject (e.g. ASVSP, HPC). Each course has its own sources, lessons, quizzes, progress and config. Several courses run in parallel and share one learner profile. |
| **Lecture** | Numbered unit `NN`. It pairs a slide deck (`NN_<Course>_<Topic>.pdf`) with a notes file (`Predavanje - NN.md`). |
| **Lesson** | The unified note the app produces for one lecture. It ends with a knowledge-tracking table. |
| **Topic** | A row in a lesson's tracking table. It is the unit of mastery. |
| **Mastery rating** | `?` not tested · `✗` weak · `~` partial · `✓` good. |
| **Gap** | The student answered "Ne znam" (don't know). The concept gets taught first and is not treated as a misconception. |
| **Misconception** | A wrong answer, or a wrong statement in the student's notes. It gets re-tested from a new angle. |
| **Quiz** | A set of questions with an id: `P02` (per lecture), `K1` (cumulative), `P01R` (retake/review). |
| **Submission** | One completed attempt at a quiz. |
| **Visualization** | An interactive page that teaches one concept and is built to break one specific misconception. |
| **Backlog ("obavezno u K…")** | Topics left out of a quiz that must appear in a named later quiz. |

## 3. Course setup

Per course, the student configures:

- **Sources**
  - Slides folder (PDFs, read-only). One file can be marked as non-lecture, e.g. `00_` grading rules.
  - Notes folder (an Obsidian vault of Markdown, read-only).
  - The pairing rule between slide decks and notes files (by `NN`).
- **Scope**: lectures only. Labs and project work are ignored unless the student asks for them.
- **Assessment format**, which drives quiz design. ASVSP example:
  - PZ: written test in week 12, 15 closed questions scored 0/1 each.
  - ZI: oral final worth 30 points. The student must answer every question competently to score above 0.
- **Review cadence**: a cumulative test every N lectures (ASVSP: K1 after lecture 04 covering 01–04, K2 after 08 covering 01–08, …), then a full-course review before the exam.
- **Key dates** (test weeks, exam period).
- **Language**: Serbian in Latin script with diacritics. Established English technical terms (batch, streaming, sharding…) stay in English, with the Serbian term alongside where the slides use one.
- **Persona**: the tutor's role (e.g. "experienced data engineer").

## 4. Ingestion

- **Slide extraction.** Extract text from each PDF and strip noise (blank lines, bare page numbers, date footers). The text comes out messy: bullet glyphs land on their own lines and columns can be scrambled, so the extraction is read for content, not layout. Large output is stored and read in chunks.
- **Notes import.** Read the student's notes for lecture `NN` from the vault without modifying the vault.
- **Readiness gate.** A lecture is processed only after the student marks its notes as done.
- **Change detection** (new for the app): notice when a slide deck or notes file changes after its lesson was built, and offer to rebuild.

## 5. Unified lesson note

One note per lecture (`lessons/NN-<topic>.md`), built by merging slides and notes:

- **Source tags on every item**:
  - no tag: from the slides;
  - **(P)**: the lecturer's spoken remark, taken from the student's notes. These remarks are treated as authoritative and likely exam material;
  - **(D)**: an addition by the tutor.
- **Corrections.** Where the notes are wrong or imprecise, the lesson shows a visible `> ⚠️ Ispravka:` callout, and the misconception is added to the tracking table. A misconception from the notes gets tested.
- **Strikethrough handling.** Struck-through text in the notes has no fixed meaning: it can be unfinished, misspelled or badly worded. It never means "skipped" or "not on the exam". Its wording is not trusted; that content comes from the slides. If a struck item affects exam scope, the app asks the student.
- **Deferred topics.** A topic the lecturer only mentioned and promised to cover later is noted in the lesson and tested once it has been covered (e.g. Lambda/Kappa mentioned in lecture 01).
- **Links** to the visualizations that cover the lesson's concepts.
- **Knowledge-tracking table** at the end, one row per topic: `Tema | Ocena | Testirano | Napomene`. The notes column holds the per-question history: which questions, results, the misconception in the student's words, and what happened in chat.

The lesson is the source of truth for every later step (quizzes, grading, cumulative reviews). Cumulative reviews are built from lessons and progress, not straight from the slides.

## 6. Learner model and progress

A per-course progress record that is read at the start of every session:

- **Status**: last processed lecture, and a dated log of what happened (quizzes graded, chat rounds and their outcome).
- **"Sledeće" (next steps)**: always current. Example: (1) teach the "don't know" topics first, (2) oral follow-up on o2 and o3, (3) process P03 once its notes are done.
- **Backlog**: topics that are mandatory in the next cumulative test, each with the reason (weak, don't know, or left out of the quiz).
- **Cumulative test schedule**: test, coverage, when, result.
- **Topic mastery overview**: one row per topic across all lectures (rating, which quizzes tested it, short notes), with details linked to the lesson tables.
- **Quiz history**: date, quiz, score breakdown, link to the results write-up.
- **Visualization registry**: name, link, file, what it shows, when and why it was built.
- **Observations about the student**, shared across courses. Current examples:
  - conceptual closed questions go well; calculations are weaker and sometimes answered with an estimate;
  - open answers are short, correct skeletons that skip enumerations, step order and the lecturer's analogies, which is the main risk for the oral exam;
  - uses "Ne znam" honestly;
  - asks good in-depth questions and catches the tutor's simplifications;
  - passive reading of corrections fixes errors in notes, but repeated topics from earlier lectures still fail, so they need active review.
- **Do-not-repeat hints**: e.g. "corrected in chat, don't ask a third time right away".

## 7. Quiz pipeline

### 7.1 Planning (strong model, hidden from the student)

The planner writes a quiz plan from progress, the lesson tracking tables and earlier results. Plans contain the answers, so **the student never sees them**. The student is only told that a quiz is being built.

Plan contents:
- Header: id, title, subtitle, chips (source PDF, question count, target time), lessons to read, type mix, target time.
- **Weighting rationale**:
  - Topics answered wrong get the most questions and are re-asked from a **different angle** each time (new scenario, reversed question, rephrasing). The aim is to learn the concept, not memorize an answer.
  - Topics answered correctly come back harder (application, edge cases, comparison).
  - Misconceptions from the notes each get at least one question in which the misconception is the main distractor.
  - Repeats from earlier lectures go at the end, before the open questions.
  - Topics left out are listed and written to the backlog as "obavezno u K…".
- **One row per question**: id, type, topic, angle or scenario, correct answer or key fact (for open questions, the points the keys must cover), slide-section ref, `extra` flag, and for `mc` the index of the correct option. The planner assigns these indices so they vary.

### 7.2 Building (cheaper model)

A builder turns the plan into a quiz entry. It owns wording, distractors, match rows, numbers that make the arithmetic come out cleanly, expanded open-question keys, and explanations. It never changes what the plan fixed. If something in the plan looks wrong, it keeps it as planned and flags it.

Quality rules the builder follows:
- Closed questions have exactly one defensible answer. No "all of the above" or "none of the above", and no trick wording.
- Distractors are real misconceptions (taken from the corrections and tracking tables), not throwaways.
- Options are similar in length, and the correct one doesn't stand out.
- Scenarios (a team, a system, a command, a failure) are preferred over "what is X".
- Every closed question has an explanation that says why the answer is right, why the tempting wrong answer is wrong, and names the concept.
- `match` rows are shuffled so their answers don't follow the order of the choices; at most one row lands on the diagonal.
- Open questions are oral-exam "explain / compare / why" prompts. Their keys list everything a complete answer names, including the lecturer's examples and analogies.
- The builder never writes a "Ne znam" option; the player adds it.

### 7.3 Validation

An automatic checker runs over all quizzes:
- **Errors**: duplicate quiz or question ids; missing id, title, subtitle, chips, questions, prompt or ref; a closed question without an explanation; an `mc` question with fewer than 2 options or an answer out of range; a `num` question with a non-numeric answer or tolerance; a `match` question without choices and rows, or with an answer out of range.
- **Warnings**: a `num` question without a unit; `match` rows that run along the diagonal.
- **Report**: the distribution of correct `mc` positions, so position bias is visible.

### 7.4 Review loop

The planner reviews the built quiz before release:
- runs the checker;
- checks every answer against the plan and the lesson;
- checks that distractors are real misconceptions and that the correct option doesn't stand out;
- checks language, `extra`/`ref` tags, and that `mc` positions and `match` rows vary.

Fixes go back to the builder as a list (question id, what's wrong, the change wanted), for at most **3 cycles**. After that the planner fixes what remains itself and logs what it changed.

### 7.5 Release

The quiz is added to the course's single quiz library. Old quizzes stay so they can be retaken, and the newest one opens by default. Progress "Sledeće" is updated.

## 8. Quiz player

- **Quiz picker** listing all quizzes in the course; the newest is preselected.
- **Header**: course eyebrow, title, subtitle, chips.
- **Question types**:
  - `mc`: one correct option out of several.
  - `num`: numeric answer with a tolerance and a unit.
  - `match`: each row gets a dropdown of shared choices. Partial credit is the share of correct rows.
  - `open`: free text, with the placeholder "Objasni svojim rečima, kao na usmenom…".
- **„Ne znam” on every question**, added by the player. It is a dashed last option on `mc`, a checkbox on `num` and `open`, and a choice in each `match` row's dropdown. It disables the input, scores 0, and gets its own feedback styling, kept apart from wrong answers.
- **Per-question metadata**: slide-section ref (lecturer-only remarks are marked "(predavač)"), and an "extra" marker on questions whose content came from the tutor's additions rather than the slides.
- **Draft autosave** per quiz in local storage, restored on reload. Storage failures are handled; the page works without it.
- **Progress bar** of answered questions.
- **Submit**: if questions are unanswered, the first click warns with the count and a second click confirms.
- **Instant feedback after submit**:
  - closed questions show Tačno / Netačno / Delimično (k/n) / Ne znam, the correct answer (correct options highlighted, the correct value for `num`, the correct pairs for `match`), and the explanation;
  - open questions show the key points to compare against.
- **Score line**: closed-question score / max, plus "N open questions await grading".
- **Persistence**: the submission (quiz id, timestamp, auto score and max, list of "don't know" ids such as `q3` or `q14.r2`, and all answers) is saved to the store. Options are stored as indexes, `match` answers as `{row: choiceIndex}`, and "don't know" as `"?"`.
- **Fallback**: if saving fails, the player shows the submission as JSON with a copy button, and the student can paste it to the tutor.
- **Reset / retake** button.
- **Presentation**: light and dark themes, works at phone width, respects reduced motion.

## 9. Grading

Done by the strong model. It is never delegated to the builder.

1. Load the submission and re-check the auto score by hand.
2. Grade open answers against their keys with fractional scores (e.g. 0.4/1). Note what was right and what was missing: structure, enumerations, the lecturer's examples.
3. Classify every miss:
   - **"Ne znam"** is a gap ("nije znao"). It is weighted like a wrong answer in the next quiz, but the concept is taught first rather than targeted as a misconception.
   - A **wrong answer** is a misconception. It gets recorded in the student's own wording, with a guess at the cause where one is visible (e.g. "read 'not guaranteed' as 'doesn't use the host disk'").
4. Write the **results write-up** (`PNN-rezultati.md`):
   - a summary table: auto score with partial credit, score under the exam's 0/1 rule, sub-scores (this lecture vs repeats), open-question score, and total;
   - correct items, with the notes misconceptions they show were fixed;
   - a "wrong (misconception)" table: question, topic, answer given, correct answer, what was missed;
   - a "don't know (gap)" table: question, topic, the key fact;
   - open-question grading and the follow-ups to do next.
5. Update the lesson tracking tables, the progress record (ratings, backlog, history, observations, next steps) and the cross-course observations.

## 10. Chat tutoring and oral practice

- **Teach first**: gap topics are explained before they are tested again.
- **Oral-style rounds**: "objasni mi…" questions on weak spots that ask for the full structure an oral answer needs.
- The tutor answers the student's own deeper questions, accepts justified objections (e.g. "the fix was in the question's premise, so it doesn't count as a miss") and records them.
- Outcomes of each round are logged in progress with per-point ✓/✗ and an updated rating.
- **Anti-drilling**: once a model has been corrected in chat, the same question is not asked again immediately. It comes back later from a new angle.

## 11. Cumulative reviews

- Scheduled by the course cadence (K1, K2, …, then a final review).
- Built from lessons, the backlog and weak spots, not straight from the slides.
- Must include every backlog item marked for that test.
- Results go into the cumulative test schedule and the quiz history.

## 12. Visualizations

- **Recommend, never build unasked.** When a concept would be easier to grasp interactively (sharding and repartitioning, CAP under a partition, Lambda vs Kappa, container image layers…), the tutor suggests one and waits for the student.
- **Approval**: the student sees a short, spoiler-free summary (concept, the misconception it targets, controls, scenarios) and confirms it.
- **Plan**: concept and lesson section; the misconception to break (the wrong model predicts X, the viz shows Y); layout; controls; scenarios with the state each must end in; terminology; 1–2 existing visualizations to match stylistically; output path and title.
- **Build** (cheaper model) under these rules:
  - every control changes visible state, and a caption or event log says what happened and why;
  - the misconception scenario is built in explicitly;
  - facts come from the lesson, and tutor additions are labeled "dopuna";
  - UI text is in the course language;
  - the page meets the design contract: a 2–4 word title, light and dark themes, phone width, no external dependencies or only pinned ones, storage access that is optional.
- **Review**: walk each scenario and check the design contract. Fixes go through the builder, at most 3 cycles.
- **Publish**: the visualization goes into the course library, and its link is added to the progress registry and to the relevant lesson.
- Existing ASVSP visualizations to port: Sharding pod lupom (mod N vs consistent hashing), Lambda u pokretu, Kappa u pokretu, Anatomija kontejnera, Slojevi pod lupom.

## 13. Model roles

| Role | Model tier | Owns | Never does |
|---|---|---|---|
| Tutor / planner | strong | scope, weighting, which misconceptions to target, correct answers, grading, lessons, progress, chat tutoring | — |
| Quiz builder | cheaper | question wording, distractors, explanations, the quiz entry | change planned answers, publish, grade, edit progress or lessons |
| Viz builder | cheaper | the visualization page | change scope, publish, edit progress or lessons |

Independent builds (a quiz and a visualization) can run in parallel.

## 14. Session start

At the start of every session the app:
1. Loads the course progress record and the cross-course learner observations.
2. Shows the "Sledeće" list and any due cumulative test.
3. Flags lectures whose notes are marked done but that have no lesson yet, and submissions that haven't been graded.

## 15. Data entities (summary)

- `Course` { id, name, persona, language, scope, assessment format, review cadence, dates, source paths }
- `Lecture` { course, NN, slide file, notes file, notesDone, extractedText }
- `Lesson` { lecture, body with source tags and corrections, tracking rows[], viz links[] }
- `TopicRow` { lesson, topic, rating, testedIn[], notes, misconceptions[] }
- `QuizPlan` { quizId, header, rationale, rows[] } (hidden from the student)
- `Quiz` { id, title, sub, chips[], questions[] }
- `Question` { id, type, ref, extra?, prompt, options/answer | answer/tol/unit | choices/rows[] | keys[], expl }
- `Submission` { quiz, submittedAt, autoScore, autoMax, dontKnow[], answers{} }
- `Result` { quiz, submission, scores, correct[], wrong[], dontKnow[], openGrades[], followUps[] }
- `ChatRound` { date, topics, per-point outcome, rating change }
- `Visualization` { slug, title, url/file, concept, misconception, lecture, createdAt, reason }
- `Progress` { status log, next steps, backlog[], test schedule, mastery overview, quiz history, viz registry }
- `LearnerProfile` { observations[] } (shared across courses)

## 16. Invariants

- Slides and notes are read-only inputs.
- Quiz plans and answers are never shown before the student submits.
- "Ne znam" is never recorded as a misconception, and a wrong answer is never recorded as a mere gap.
- A lecture is never processed before its notes are marked done.
- Old quizzes are never deleted or rewritten. Fixes ship as a new entry (e.g. `P01R`).
- The progress record's "next steps" are current at the end of every session.

## 17. Open decisions for the standalone build

- **LLM access**: which provider and models, API key handling, and cost limits per action (lesson, plan, build, grade).
- **Hosting**: a local desktop or web app vs hosted, and how quizzes and visualizations are served now that they are no longer claude.ai artifacts.
- **Storage**: keep the Markdown files as the source of truth (so Obsidian and git keep working) or move to a database with Markdown export.
- **Notes sync**: watch the vault folder, or import by hand.
- **Migration**: import the existing ASVSP and HPC lessons, results, progress, quiz entries and visualizations, and keep the old submission history.
- **Multi-device**: whether quizzes must be taken on a phone and sync back.
