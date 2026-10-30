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
  1. **`ResilientRunner`** wraps `DefaultInferenceRunner(supportedModels, new InferenceInputValidator())`. It retries transient errors (429/5xx/network) with backoff. On final failure it publishes `stage.failed` with `{ contextId: input.context.id, error }` and rethrows. The coordinator maps context id to job stage.
  2. **`FakeRunner`** for tests: returns scripted `InferenceOutput`s, so the whole pipeline is testable without API calls.
- A process-level `unhandledRejection` handler logs (it must not crash the server). A per-stage watchdog timeout marks stuck stages failed.
- Structured output: `runLoop(..., { structuredOutput: { name, schema, strict: true } })`. The answer arrives as JSON text in `model.answer`. Schemas are Zod in `packages/shared`, converted with `z.toJSONSchema()`, and the result is **always re-validated with Zod** before persisting.
- Telemetry: `@mozaik-ai/core` bundles `@mozaik-ai/cloud-sdk`, which ships **every event, including full agent memory** (study materials), to app.jigjoy.ai **if** `MOZAIK_API_KEY`/`MOZAIK_PROJECT_KEY` is set or `~/.mozaik/credentials.json` exists. Neither is present now. Never set them. The server should log a warning at startup if one appears.

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
- [ ] M0.2 Fastify server skeleton with a health route, and a Drizzle + SQLite setup with migrations (`db:generate`, `db:migrate`).
- [ ] M0.3 React + Vite app skeleton with a router, light/dark theme tokens and a dev proxy to the API.

### M1: Agent infrastructure
- [ ] M1.1 `runtime.ts`, `ResilientRunner`, `FakeRunner`, the Coordinator skeleton, a generation_job repository, stage-failure mapping, watchdog, unhandledRejection guard, telemetry-credential warning.
- [ ] M1.2 Generic "stage" helper: create agent → runLoop with structured output → parse + Zod-validate → hand to the coordinator → leave. Unit tests with `FakeRunner` (success, invalid JSON, API failure, timeout).
- [ ] M1.3 Real-API smoke script (`npm run smoke:agent`) with a trivial structured-output agent on both models. Opus runs it once to confirm 4.1.0 + Anthropic structured output work end to end.

### M2: Courses, classes, materials
- [ ] M2.1 Schema + CRUD API for courses (name, persona?, assessment format?, review cadence?) and classes.
- [ ] M2.2 Upload API: PDF/HTML materials (required) and `.md` notes (optional). Content-addressed store. Text extraction: PDF via `pdfjs-dist` with noise stripping (spec §4), HTML via sanitize + `turndown`.
- [ ] M2.3 UI: course list/create, course page with classes, class page with uploads, a material viewer (PDF.js viewer, sandboxed iframe for HTML, rendered Markdown for notes, "show extracted text" toggle). No editing after generation.

### M3: Combined notes
- [ ] M3.1 lesson-writer prompt + output schema (`lessonMd`, `topics[]` with misconceptions found in notes, deferred flag). Works with no notes.
- [ ] M3.2 Generate endpoint, job lifecycle, SSE stream, persistence of lesson, topics, and `notes` topic_events.
- [ ] M3.3 Lesson view: rendered Markdown with styled (P)/(D) tags and `⚠️ Ispravka` callouts, a live tracking table from the DB, a pipeline status panel.

### M4: Quiz branch
- [ ] M4.1 Shared Zod schemas: QuizPlan, Quiz, Question (`mc`/`num`/`match`/`open`). The validator from §7.3, with tests.
- [ ] M4.2 quiz-planner (inputs: lesson, topics with history, backlog, observations), quiz-builder and quiz-reviewer prompts.
- [ ] M4.3 Review loop (validator + reviewer, ≤3 cycles with the same builder), release to the quiz library, failure + regeneration flow. Plans never leave the server.

### M5: Quiz player
- [ ] M5.1 Player per spec §8: picker (newest preselected), all four question types, "Ne znam" on every question, metadata, autosave (fault-tolerant localStorage), progress bar, two-step submit, instant feedback for closed questions, score line, reset, JSON fallback with copy button.
- [ ] M5.2 Submission API + persistence in the §8 format, with auto-scoring in `packages/shared` (shared with the server).

### M6: Grading + progress
- [ ] M6.1 grader prompt + output schema (open-answer grades, gap vs misconception classification, topic rating changes, backlog changes, observations, next steps, write-up). Grading starts automatically on submit.
- [ ] M6.2 Transactional persistence of grading results. Invariants: "Ne znam" is never a misconception and a wrong answer is never a gap.
- [ ] M6.3 Progress page: Sledeće, backlog, topic mastery overview, quiz history with results write-ups, viz registry, cumulative schedule. Session-start flags: classes with materials but no lesson, ungraded submissions, a due cumulative test (§14).

### M7: Visualization branch
- [ ] M7.1 viz-identifier prompt (spoiler-free suggestions), suggestion persistence, selection UI (multi-select + custom topic).
- [ ] M7.2 viz-planner, viz-builder and viz-reviewer prompts. Design contract checks (title, themes, phone width, no external deps, optional storage). Per-viz review loop, failure + regeneration.
- [ ] M7.3 Viz serving at `/viz/:id` with a strict CSP in a sandboxed iframe, links from the lesson and the registry.

### M8: Cumulative reviews
- [ ] M8.1 Cadence detection: offer `K<n>` when the class count reaches the cadence. The planner input is the covered lessons + backlog items due for that K + weak topics. It reuses the M4 build/review loop. Results go to the schedule and quiz history.

### M9: Import + export
- [ ] M9.1 Import of existing course data (lessons, results, progress, quizzes, visualizations, submission history). Needs a look at the real source folders first; probably an import agent for the Markdown progress/lesson tables.
- [ ] M9.2 One-way Markdown export of lessons, progress and results to a folder.

## Verification per task

Opus checks every task with `npm run typecheck && npm run lint && npm test`, reads the diff against the brief, and for UI tasks runs the app and looks at it. Pipeline stages are tested with `FakeRunner`. At each agent milestone (M3, M4, M6, M7) Opus does one real-API run on a fixture class to judge output quality. Prompt quality is judged by Opus, not by tests.
