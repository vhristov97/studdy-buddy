# studdy-buddy

A local study app for university courses. You upload a class's slides (PDF/HTML) and, optionally, your own lecture notes (Markdown). AI agents merge them into one corrected study note, then build quizzes, grade your answers, track what you know topic by topic, and make interactive visualizations for hard concepts. It is built for Serbian-language courses and runs on your machine only.

The functional spec is in [`APP-SPEC.md`](APP-SPEC.md); the architecture and milestone plan are in [`docs/PLAN.md`](docs/PLAN.md).

## Status

Proof of concept, in progress.

| Milestone | State |
|---|---|
| M0 Scaffold, M1 agent infrastructure | done |
| M2 Courses, classes, material uploads and viewer | done |
| M3 Combined notes: Generate button, lesson writer, lesson view with tracking table | done |
| M4 Quiz branch (planner, builder, review loop) | done |
| M5 Quiz player and submissions | done |
| M6 Grading and progress | done |
| M7 Visualizations | done |
| M8 Cumulative reviews | next |
| M9 Import/export | planned |

What works today:

- Create a course (with an optional tutor persona, assessment format and review cadence) and add numbered classes.
- Upload class materials and notes. Text is extracted from PDFs and HTML, and you can view each file and its extracted text.
- Press **Generiši** to run the lesson writer, with live progress in the browser. It merges the slides and notes into a lesson that:
  - tags each item by source: (P) for the lecturer's remark, (D) for a tutor addition;
  - flags mistakes in the notes with `⚠️ Ispravka` callouts;
  - asks you about struck-through items;
  - lists the testable topics in a knowledge-tracking table (`Tema | Ocena | Testirano | Napomene`).
- After the lesson, a quiz (`P01`, …) is generated automatically:
  - a planner (Opus) decides the scope and the answers and targets the mistakes in your notes;
  - a builder (Sonnet) writes the questions;
  - the planner reviews them, with up to 3 fix rounds;
  - a failed quiz can be regenerated from scratch.
- Take a quiz in the browser:
  - question types: multiple choice, numeric, matching and open;
  - „Ne znam" on every question;
  - your draft autosaves;
  - after you submit you get instant feedback with the correct answers and explanations, plus a score;
  - open answers wait for grading, and past submissions stay viewable.
- Grading starts automatically after each submission (Opus, spec §9):
  - open answers are graded against their key points with fractional scores;
  - every miss is classified: „Ne znam" or unanswered is a gap, a wrong answer is a misconception (both invariants are re-checked on the server before saving);
  - topic ratings, the backlog („Obavezno u K…"), the „Sledeće" list and cross-course observations are updated in one transaction;
  - a results write-up is shown on the submission.
- Course progress page (`Napredak`): session-start flags (classes without a lesson, ungraded submissions), „Sledeće", backlog, topic mastery overview, quiz history and observations.
- Visualizations (spec §12), never built unasked:
  - after the lesson, an agent suggests 2–4 concepts that are easier to grasp interactively, each with a spoiler-free summary, the misconception it breaks, controls and scenarios; you can add your own topic;
  - for each topic you select (in parallel): a planner fixes the scenarios and the end state each must reach, a builder writes one self-contained HTML page, and the planner reviews it (up to 3 fix rounds) after an automatic design-contract check (title, light/dark, phone width, no external dependencies);
  - pages are served from `/viz/:id` with a strict CSP in a sandboxed iframe and linked from the lesson and the course page; a failed one can be rebuilt from scratch.

## Stack

TypeScript in npm workspaces:

- `apps/server`: Fastify, Drizzle on SQLite (`better-sqlite3`), and the agents built on [Mozaik](https://docs.jigjoy.ai/docs) (`@mozaik-ai/core` 4.1.0).
- `apps/web`: React and Vite.
- `packages/shared`: Zod schemas and types used by both.

The agents call Anthropic models: Opus for writing and planning, Sonnet for building.

## Setup

Requires Node.js 22 or newer and an Anthropic API key.

```bash
npm install
cp .env.example .env    # then set ANTHROPIC_API_KEY
npm run dev             # API on :3000, web app on http://127.0.0.1:5173
```

`npm start` builds the web app and serves everything from the API server on :3000.

Data lives in `DATA_DIR` (default `./data`, git-ignored): the SQLite database `app.sqlite` and the uploaded files, stored by content hash. Migrations run automatically at startup.

## Commands

```bash
npm run typecheck      # tsc in every workspace
npm run lint           # eslint
npm run format         # prettier --write (format:check to verify)
npm test               # all Vitest projects; agents are tested with a fake model runner, no API calls
npm run db:generate    # new migration from apps/server/src/db/schema.ts
npm run extract -- <file>               # print the text extracted from a PDF/HTML/Markdown file
npm run lesson:try -- --class <id>      # run the lesson writer on a class (real API, writes to data/tmp/)
npm run quiz:try -- --class <id>        # plan, build and review a quiz once (real API, writes to data/tmp/)
npm run grade:try -- --submission <id>  # grade a submission without saving it (real API, writes to data/tmp/)
npm run smoke:agent    # tiny real-API check of the agent stack
```

## Privacy

- Course material stays on your machine, except for what is sent to the Anthropic API to generate content.
- Mozaik's bundled cloud SDK uploads all agent events, including full agent memory, to app.jigjoy.ai if it finds credentials. The server guards against this in two ways:
  - it refuses to start if `MOZAIK_API_KEY` or `MOZAIK_PROJECT_KEY` is set in the environment or in `.env`;
  - it points the SDK's paired-machine credentials lookup at `/dev/null`, so a paired `~/.mozaik/credentials.json` is ignored.
- Still, don't set those keys or pair the machine.
