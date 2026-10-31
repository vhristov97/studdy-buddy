# Implementation plan (PoC)

Owner: Opus (plans, verifies). Implementation: Sonnet subagents, one task at a time, per the workflow in `CLAUDE.md`. Each task below is sized to be one subagent brief. Tick tasks off here as they pass verification.

## Architecture

### Repo layout (npm workspaces)

```
apps/server     Fastify API, Mozaik runtime + agents, Drizzle/SQLite, file store
apps/web        React + Vite UI (course/class management, viewers, quiz player, progress)
packages/shared Zod schemas + TS types shared by both (Quiz, QuizPlan, Submission, …),
                the quiz validator (spec §7.3), scoring logic for the player
data/           runtime data, git-ignored: app.sqlite, files/<hash-prefix>/<sha256>.<ext>
```

Single local process: the server serves the API and, in production mode, the built web app. Dev runs Vite with a proxy to Fastify.

### Storage

SQLite via Drizzle (`better-sqlite3`). Uploaded files live on disk, content-addressed by sha256; the DB stores metadata, path, hash and the extracted text. Generated documents (lesson Markdown, results write-ups, visualization HTML) are text columns. The learner model is normalized tables. Quizzes store questions as JSON (quizzes are immutable once released).

Core tables (first cut; Drizzle schema is the source of truth once written):

| Table | Key columns |
|---|---|
| `course` | name, persona?, assessment_format?, review_cadence? (cumulative quiz every N classes) |
| `class` | course_id, number, title, status |
| `material` | class_id, kind (`material`\|`note`), original_name, mime, sha256, path, extracted_text |
| `lesson` | class_id, body_md, created_at |
| `topic` | course_id, class_id, name, rating (`?`\|`✗`\|`~`\|`✓`), deferred |
| `topic_event` | topic_id, source (`notes`\|`quiz`\|`grading`), ref, outcome, misconception_text, created_at |
| `backlog_item` | topic_id, due_quiz (`K1`…), reason (`weak`\|`gap`\|`left_out`), resolved_at? |
| `quiz_plan` | quiz_id, plan_json (never sent to the web app) |
| `quiz` | course_id, code (`P02`, `K1`), title, sub, chips_json, questions_json, status, created_at |
| `submission` | quiz_id, answers_json, auto_score, auto_max, dont_know_json, submitted_at |
| `result` | submission_id, scores_json, writeup_md, created_at |
| `next_step` | course_id, text, position (the "Sledeće" list; replaced wholesale by grading) |
| `learner_observation` | text, created_at (shared across courses) |
| `viz_suggestion` | class_id, concept, misconception, summary, origin (`agent`\|`user`), selected |
| `visualization` | class_id, suggestion_id, slug, title, html, plan_json, status, error? |
| `generation_job` | class_id, kind, stage, status, attempt, error?, parent_job_id?, timestamps |

### Agent runtime (Mozaik 4.1.0)

Facts verified in the 4.1.0 package source, which shape the design:

- One runtime per process. `defineRuntime` is called in one module (`apps/server/src/agents/runtime.ts`) that re-exports `join`, `leave`, `sendEvent`, `runLoop`, `resolveRuntime`.
- An agent's `instruction` becomes the first item of its memory context, and the context **accumulates across `runLoop` calls**. So: **create a fresh agent per job stage** (fresh context), run it, then `leave()` it. Review-fix cycles reuse the same builder agent on purpose, so it keeps the conversation history.
- `runLoop` is fire-and-forget, and **a failing loop emits no event**: an API error rejects an unawaited promise. Tool errors are caught and fed back to the model as text.
- `initializeRuntime({ inferenceRunnerConfig: { runner } })` accepts a custom `InferenceRunner`. We use this twice:
  1. **`ResilientRunner`** wraps Mozaik's default runner. `InferenceInputValidator` isn't exported, so the default runner is obtained from a throwaway second `defineRuntime()` initialized without a runner (`getInferenceRunner()`). It retries transient errors (429/5xx/529/network) with backoff. On final failure it publishes `stage.failed` with `{ contextId: input.context.id, error }` and **does not rethrow**: it returns a placeholder `ModelMessageItem`, so the loop ends cleanly instead of leaving an unhandled rejection. The stage helper ignores the placeholder answer because `stage.failed` arrives first.
  2. **`FakeRunner`** for tests: returns scripted `InferenceOutput`s, so the whole pipeline is testable without API calls.
- A process-level `unhandledRejection` handler logs, as a safety net only (it must not crash the server). A per-stage watchdog timeout marks stuck stages failed.
- Structured output: `runLoop(..., { structuredOutput: { name, schema, strict: true } })`. The answer arrives as JSON text in `model.answer`. Schemas are Zod in `packages/shared`, converted with `z.toJSONSchema()`, and the result is **always re-validated with Zod** before persisting.
- Telemetry: `@mozaik-ai/core` bundles `@mozaik-ai/cloud-sdk`, which ships **every event, including full agent memory** (study materials), to app.jigjoy.ai **if** `MOZAIK_API_KEY`/`MOZAIK_PROJECT_KEY` is set or `~/.mozaik/credentials.json` exists. Neither is present now. Never set them. **Hard guard:** agent-runtime init refuses to start if `MOZAIK_API_KEY`/`MOZAIK_PROJECT_KEY` is set (process env or a `.env` in the cwd, which the SDK also reads), and points `MOZAIK_CREDENTIALS_FILE` at a nonexistent path so paired credentials are never picked up.

### Orchestration by reaction

```
HTTP "generate" ──► coordinator creates generation_job, emits  lesson.requested
lesson-writer agent (Opus)          reacts → runLoop → model.answer
Coordinator (observer participant)  validates + persists lesson/topics, emits  lesson.ready
   ├─ quiz-planner agent (Opus)     reacts → plan → coordinator persists → quiz.plan.ready
   │    └─ quiz-builder (Sonnet) → quiz.built → quiz-reviewer (Opus) → approved | fixes
   │         fixes → same builder agent (≤3 cycles) → else stage failed + regen offer
   └─ viz-identifier agent (Opus)   reacts → suggestions persisted, job → awaiting_user
HTTP "select viz" ──► per suggestion: viz.requested
   viz-planner (Opus) → viz-builder (Sonnet) → viz-reviewer (Opus), ≤3 cycles, per viz
HTTP "submit quiz" ──► grading.requested → grader (Opus) → coordinator persists in one transaction
```

- The **Coordinator** is a Mozaik observer. It is the only code that writes pipeline results to the DB and emits domain events. Agents only read context and return structured output.
- Agents get the data they need in their message (lesson, plan, progress snapshot) rather than via tools. Read-only tools (`getLesson`, `getTopicHistory`) can be added where a context would get too large.
- Job progress is pushed to the browser over **SSE** (`GET /api/jobs/stream?classId=`), fed by the coordinator.
- **Regeneration** after 3 failed review cycles: the job is marked failed with the reviewer's last findings. The UI offers "regenerate from scratch". For a quiz, this re-plans and rebuilds the topics of the failed questions as a new quiz entry. For a visualization, it re-plans and rebuilds that visualization.

### Models

`MODEL_PLANNER=claude-opus-5-5`, `MODEL_BUILDER=claude-sonnet-5-5` in `.env` (4.x IDs as fallback). Planner tier: lesson-writer, quiz-planner, quiz-reviewer, viz-identifier, viz-planner, viz-reviewer, grader. Builder tier: quiz-builder, viz-builder.

### Prompts

Agent instructions live as Markdown files in `apps/server/src/agents/prompts/`, one per agent. They are derived from the spec sections (§5 lesson, §7.1–7.4 quiz, §9 grading, §12 viz), written for Serbian output, with the persona injected when set.

## Milestones

Dependencies: M0 → M1 → M2 → M3, then M4 ∥ M7 (M5 can start once the M4 quiz schema exists) → M6 → M8 → M9.

### M0: Scaffold
- [x] M0.1 Workspaces, TS config (`moduleResolution: bundler`), ESLint + Prettier, Vitest, root scripts (`dev`, `build`, `lint`, `typecheck`, `test`), `.env.example`, `.gitignore` (`data/`, `.env`).
- [x] M0.2 Fastify server skeleton with a health route, and a Drizzle + SQLite setup with migrations (`db:generate`, `db:migrate`).
- [x] M0.3 React + Vite app skeleton with a router, light/dark theme tokens and a dev proxy to the API.

### M1: Agent infrastructure
- [x] M1.1 `runtime.ts` (init + telemetry guard), `ResilientRunner`, `FakeRunner`, unhandledRejection safety net.
- [x] M1.2 Generic `runStage` helper (create agent → runLoop with structured output → resolve on its own `model.answer` / reject on its `stage.failed` or watchdog timeout → parse + Zod-validate → leave), plus a multi-turn variant for builder fix cycles, and a Coordinator skeleton that reacts to domain events. Unit tests with `FakeRunner` (success, invalid JSON, schema mismatch, API failure, timeout, concurrent stages).
- [x] M1.3 Real-API smoke script (`npm run smoke:agent`) with a trivial structured-output agent on both models. Opus runs it once to confirm 4.1.0 + Anthropic structured output work end to end.

### M2: Courses, classes, materials
- [x] M2.1 Schema + CRUD API for courses (name, persona?, assessment format?, review cadence?) and classes.
- [x] M2.2 Upload API: PDF/HTML materials (required) and `.md` notes (optional). Content-addressed store. Text extraction: PDF via `pdfjs-dist` with noise stripping (spec §4), HTML via sanitize + `turndown`.
- [x] M2.3 UI: course list/create, course page with classes, class page with uploads, a material viewer (PDF.js viewer, sandboxed iframe for HTML, rendered Markdown for notes, "show extracted text" toggle). No editing after generation.

### M3: Combined notes
- [x] M3.1 lesson-writer prompt + output schema (`lessonMd`, `topics[]` with misconceptions found in notes, deferred flag). Works with no notes.
- [x] M3.2 `generation_job` table + repository (moved from M1, since it references `class`), generate endpoint, job lifecycle, SSE stream, persistence of lesson, topics, and `notes` topic_events.
- [x] M3.3 Lesson view: rendered Markdown with styled (P)/(D) tags and `⚠️ Ispravka` callouts, a live tracking table from the DB, a pipeline status panel.

### M4: Quiz branch
- [x] M4.1 Shared Zod schemas: QuizPlan, Quiz, Question (`mc`/`num`/`match`/`open`). The validator from §7.3, with tests.
- [x] M4.2 quiz-planner (inputs: lesson, topics with history, backlog, observations), quiz-builder and quiz-reviewer prompts.
- [x] M4.3 Review loop (validator + reviewer, ≤3 cycles with the same builder), release to the quiz library, failure + regeneration flow. Plans never leave the server.

### M5: Quiz player
- [x] M5.1 Player per spec §8: picker (newest preselected), all four question types, "Ne znam" on every question, metadata, autosave (fault-tolerant localStorage), progress bar, two-step submit, instant feedback for closed questions, score line, reset, JSON fallback with copy button.
- [x] M5.2 Submission API + persistence in the §8 format, with auto-scoring in `packages/shared` (shared with the server).

### M6: Grading + progress
- [x] M6.1 grader prompt + output schema (open-answer grades, gap vs misconception classification, topic rating changes, backlog changes, observations, next steps, write-up). Grading starts automatically on submit.
- [x] M6.2 Transactional persistence of grading results. Invariants: "Ne znam" is never a misconception and a wrong answer is never a gap.
- [x] M6.3 Progress page: Sledeće, backlog, topic mastery overview, quiz history with results write-ups, viz registry, cumulative schedule. Session-start flags: classes with materials but no lesson, ungraded submissions, a due cumulative test (§14).

### M7: Visualization branch
- [x] M7.1 viz-identifier prompt (spoiler-free suggestions), suggestion persistence, selection UI (multi-select + custom topic).
- [x] M7.2 viz-planner, viz-builder and viz-reviewer prompts. Design contract checks (title, themes, phone width, no external deps, optional storage). Per-viz review loop, failure + regeneration.
- [x] M7.3 Viz serving at `/viz/:id` with a strict CSP in a sandboxed iframe, links from the lesson and the registry.

### M8: Cumulative reviews
- [ ] M8.1 Cadence detection: offer `K<n>` when the class count reaches the cadence. The planner input is the covered lessons + backlog items due for that K + weak topics. It reuses the M4 build/review loop. Results go to the schedule and quiz history.

### M9: Import + export
- [ ] M9.1 Import of existing course data (lessons, results, progress, quizzes, visualizations, submission history). Needs a look at the real source folders first; probably an import agent for the Markdown progress/lesson tables.
- [ ] M9.2 One-way Markdown export of lessons, progress and results to a folder.

## Verification per task

Opus checks every task with `npm run typecheck && npm run lint && npm test`, reads the diff against the brief, and for UI tasks runs the app and looks at it. Pipeline stages are tested with `FakeRunner`. At each agent milestone (M3, M4, M6, M7) Opus does one real-API run on a fixture class to judge output quality. Prompt quality is judged by Opus, not by tests.

## Handoff notes

State and context a fresh session needs. Keep this section current at every milestone boundary.

### Where things stand (after M5, merged in PR #10)
- **Done**: M0–M5.
- **Next, in parallel** (the user's decision):
  - **M6** on branch `m6-grading` in this checkout;
  - **M7** on branch `m7-viz` in the git worktree `../studdy-buddy-m7`, which has its own `node_modules` and a copy of `.env`.
- **Same workflow for both**: Opus plans and verifies, Sonnet implements, and each branch gets its own PR and Devin loop.
- **Merge order**: M6 merges first. Then M7 rebases on `main`; on a migration conflict, delete M7's migration, re-run `npm run db:generate` on top of `main`'s, and re-test.
- **Shared files likely to conflict** (keep edits small there): `db/schema.ts`, `pipeline/events.ts`, `JOB_KINDS`, `lib/pipeline.ts`, `PipelinePanel`, `docs/PLAN.md` checkboxes and `README.md`.
- **M7 real-API runs**: the worktree's `DATA_DIR` defaults to its own empty `./data`. For runs on class 01, point `DATA_DIR` at a copy of this checkout's `data/`.
- **Player and submissions (M5)**:
  - `GET /api/quizzes/:id` returns `PublicQuiz` (no answers).
  - `POST /api/quizzes/:id/submissions` scores on the server with the shared `scoreQuiz`, rejects empty submissions, stores a `submission` row (`answers_json`, `results_json`, `dont_know_json`, `auto_score`/`auto_max`, `open_pending`), emits **`submission.created` `{quizId, submissionId}`** (M6 grading starts from this), and returns feedback.
  - `GET /api/submissions/:id` returns the detail. The player is `/kvizovi/:quizId`, with read-only past submissions at `/kvizovi/:quizId/predaje/:submissionId`.
  - Numeric scoring: tolerance 0 means an exact match.
- **Quiz layer (M4)**:
  - Shared (`packages/shared/src/quiz/`): `Quiz`/`Question` (`mc`/`num`/`match`/`open`), `QuizPlan`, `QuizDraft`, `QuizReview`, `validateQuiz`, `lessonQuizCode`.
  - Server: `pipeline/quiz-branch.ts` runs on `lesson.ready`: plan → build → review, with ≤3 fix rounds on one builder session, then release or fail. It emits `quiz.released` `{classId, quizId, code}`.
  - DB: `quiz` holds the released quiz with answers in `questions_json`; `quiz_plan` holds the plan, draft and per-cycle log, and no route exposes it.
  - Regeneration: `POST /api/classes/:classId/quiz/regenerate`, which also starts the first quiz for classes generated before M4.
  - Read API: `GET /api/courses/:courseId/quizzes` returns `QuizSummary[]` with no questions. **The player API (questions without answers before submit) is M5's job.**
  - Real-run behaviour: a P01 quiz on class 01 takes ~8 min, and the reviewer typically requests real fixes for 2–3 rounds, so some quizzes may fail at the 3-round limit and need the regenerate button. Watch the failure rate before loosening the reviewer.
  - Topic linkage: quiz questions carry `topic` (name) and plan rows carry `isRepeat` and, for repeats, `classNumber` (the source class; topic names are unique only per class). To map a question to a `topic` row for M6 grading events, match the name within the class (for repeats, within the class given by `classNumber`; the most-recent-earlier-class heuristic remains only for plans stored without it).
- **Agent layer** (`apps/server/src/agents/`):
  - Run agent steps with `runStage(spec, message)` or `openStageSession(spec)` (multi-turn, for builder fix cycles) from `stage.ts`. Pass `model: config.MODEL_PLANNER` / `config.MODEL_BUILDER` and a Zod `schema`. Optional fields must be `.nullable()`, never `.optional()`; `z.record` is rejected.
  - Put cross-field checks in a `.superRefine` on the stage schema. Failures go back to the model through the repair loop (`repairAttempts`). `lessonDraftSchema` in `lesson-writer.ts` is the pattern to copy.
  - Long outputs: the lesson stage uses `maxOutputTokens: 64000` and a 30-minute timeout. A real lesson for a 64-page deck takes ~4.7 min on Opus.
  - Tests use `FakeRunner` (`agents/testing/fake-runner.ts`) through `initAgentRuntime({ runner, cwd, repoRoot })`. Vitest isolates files, so it's one runtime per test file.
- **Pipeline** (`apps/server/src/pipeline/`):
  - `createPipeline({ db, coordinator, logger, writeLesson? })` reacts to domain events (`events.ts`): `class.generate_requested` → lesson stage → `lesson.ready` `{classId, lessonId}`.
  - **M4 and M7 hook in here**: register handlers on `lesson.ready` that each create their own `generation_job` (`kind` `quiz` / `viz_topics`; add them to `JOB_KINDS` in `packages/shared/src/api/lessons.ts`, with `parent_job_id` = the lesson job).
  - Job updates go out via `job.updated` / `job.progress`, which the SSE route forwards per class. `recoverInterruptedJobs()` marks running jobs failed at startup.
  - Generation is refused (409) when any class file failed extraction.
- **Data**:
  - Existing tables: `course`, `class` (`draft|generating|ready|failed`), `material`, `generation_job`, `lesson` (one per class), `topic` (`rating` `?|✗|~|✓`, `position`, `deferred`, `deferred_note`), and `topic_event` (`source` `notes|quiz|grading`, `ref`, `outcome`, `misconception_text`, `correction_text`).
  - Notes misconceptions are stored as `topic_event` rows with source `notes` and outcome `misconception`. They are the quiz planner's "misconceptions from notes" input.
  - Repositories: `repositories/lessons.ts` (`getLessonView`, `listJobs`, …).
- **Routes**: `POST /api/classes/:classId/generate`, `GET …/lesson`, `GET …/jobs`, `GET …/events` (SSE). They are registered only when `buildApp` gets `pipeline` + `coordinator`; `createTestApp({ pipeline })` sets this up for tests.
- **Web**:
  - Class page: Generate/Retry + `PipelinePanel`. Add new job kinds to `JOB_KIND_LABELS` in `src/lib/pipeline.ts`.
  - Lesson page: `/predavanja/:classId/lekcija`, with `LessonMarkdown` (remark plugin `lib/lessonRemark.ts` for (P)/(D) tags and callouts) and `TrackingTable`. Its Testirano column already shows `quiz` event refs.
  - Live updates: `useClassEvents` in `src/api/events.ts`.
- **Known nit**: the lesson writer once wrote `(D: …)` inside a line instead of a leading `(D)` tag. Harmless, so the prompt was left as is.

### Local data and samples
- `samples/materials/`:
  - `00_ASVSP_Pravila_Ocenjivanja.pdf` (grading rules, not a lecture);
  - `01_ASVSP_Uvod.pdf` (64 pages);
  - `02_ASVSP_Kontejnerizacija_Orkestracija.pdf` (52 pages).
- `samples/notes/`: `Predavanje - 01.md`, `Predavanje - 02.md`.
- These files are private and git-ignored. Never copy them into the repo or tests.
- **Local dev DB** (`data/app.sqlite`):
  - course "ASVSP (test)" (id 1, persona "iskusni data inženjer", cadence 4);
  - class 01 "Uvod" (id 1) is **`ready`** with a real generated lesson (20 topics, 4 notes misconceptions). Use it as the M4 quiz-planner input and for M4/M5 screenshots.
- `npm run extract -- <file>` prints extracted text. `npm run lesson:try -- --class <id>` runs the lesson writer alone, without the DB pipeline (real API; output goes to `data/tmp/`).
- Screenshots: `screenshots/<milestone>/` (git-ignored). For long pages, use `--window-size=1280,50000 --force-device-scale-factor=0.5`, then crop with `magick`.

### M5 guidance
- **Player API**:
  - `GET /api/quizzes/:id` returns the quiz **without** answers, explanations or key points: options/rows/choices/prompt/ref/extra/topic only, enforcing spec §16 (answers never shown before submit). A `toPublicQuiz` in shared keeps both sides in sync.
  - After a submission, the server returns the full feedback (correct answers, explanations, key points) for that submission.
- **Submission format** (spec §8):
  - options as indexes;
  - `match` answers as `{row: choiceIndex}`;
  - "Ne znam" as `"?"`;
  - don't-know ids like `q3` / `q14.r2`;
  - auto score/max computed by shared scoring code (`match` partial credit = share of correct rows; `num` within tolerance).
  - Open answers are stored ungraded; M6 grades them.
- **Player UI** (spec §8):
  - picker with the newest quiz preselected;
  - "Ne znam" on every question (dashed last option on mc, checkbox on num/open, a choice in each match dropdown);
  - metadata: ref with "(predavač)", extra marker;
  - progress bar;
  - two-step submit when questions are unanswered;
  - instant feedback (Tačno / Netačno / Delimično (k/n) / Ne znam), score line plus "N otvorenih pitanja čeka ocenjivanje";
  - reset/retake;
  - draft autosave in localStorage (try/catch, works without it);
  - JSON fallback with a copy button if saving fails;
  - light/dark, phone width, reduced motion.
- **Entry points**: link the quiz from the course "Kvizovi" list and from the class pipeline panel's finished quiz row.
- **Data for screenshots**: the dev DB has P01 (22 questions) for class 01.
