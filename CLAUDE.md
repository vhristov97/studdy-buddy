# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

PoC in progress. `docs/PLAN.md` holds the architecture and the milestone/task list; keep its checkboxes current.

## Commands

```bash
npm install
npm run dev            # server (tsx watch, :3000) + web (Vite, :5173, proxies /api) together
npm start              # build web, then serve it from Fastify on :3000
npm run typecheck      # tsc --noEmit in every workspace
npm run lint           # eslint .
npm run format         # prettier --write . (format:check in CI-style checks)
npm test               # all Vitest projects (apps/*, packages/*)
npx vitest run apps/server/src/routes/health.test.ts   # single file
npx vitest run -t "<test name>"                         # single test by name
npm run db:generate    # drizzle-kit migration from apps/server/src/db/schema.ts
npm run db:migrate     # apply migrations (also applied at server startup)
```

Config comes from the repo-root `.env` (see `.env.example`); `DATA_DIR` (default `./data`, git-ignored) holds `app.sqlite` and uploads. `samples/` holds private course material for real-API quality checks and is git-ignored.

**Stack**: TypeScript everywhere, npm workspaces (`apps/server`, `apps/web`, `packages/shared`). Server: Fastify + Mozaik + Drizzle on SQLite (`better-sqlite3`); uploads stored on disk content-addressed by sha256, everything else in the DB. Web: React + Vite. Tests: Vitest. Local-only app, no deployment.

## Source of truth

- `APP-SPEC.md` is the functional spec (written from an existing Claude Code study setup for Serbian university courses). It describes *what* the app does and leaves the stack open (§17).
- The user's product flow below **extends and partly overrides** the spec. Where they conflict, the flow below wins; everything else in the spec (learner model, grading, quiz player, invariants in §16, etc.) still applies unless the user says otherwise.

## Development workflow (mandatory)

- **Opus is the driver**: it plans every piece of work, splits it into tasks, and verifies results. Opus does not write the implementation itself.
- **Sonnet subagents implement**: delegate each implementation task with the Agent tool using `model: "sonnet"`. Give each subagent a self-contained brief (files, interfaces, acceptance criteria), since it starts without this conversation's context.
- **Opus verifies** each result (read the diff, run build/tests, check against the plan and spec).
- **Fix loop, max 3 cycles**: if verification fails, Opus diagnoses the problem and sends Sonnet concrete fix instructions; Sonnet fixes; Opus re-verifies. After the 3rd failed cycle, stop and report it in chat so the user can look into it, summarizing what was tried and what still fails.
- **Git**: one feature branch per milestone (e.g. `m0-scaffold`, `m1-agents`). Commit after each task passes verification, one commit per task. Subagents never commit; Opus does after verifying. Stage files by explicit path, never `git add -A`/`git add .` (a stray `.env` copy got committed that way once).
- **UI verification**: for UI tasks, take headless Chromium screenshots (`/usr/bin/chromium --headless=new --screenshot=… --window-size=1280,900` and `390,844`) of the changed pages and save them to `screenshots/<milestone>/` (git-ignored, they may show private course material) so the user can review them too.
- **PR loop**: when a milestone is done, push the branch, open a PR to `main`, and monitor it for Devin's review (inline comments, reviews and PR comments) with the Monitor tool running `scripts/watch-pr.sh <pr>` (`timeout_ms` 1800000; re-arm on expiry while the PR is open). Devin may also edit a finding in place (`EDITED`) or reply "The fix didn't resolve this Devin Review issue." (`UNRESOLVED`); treat both as open findings. Verify each finding; real ones go through the Sonnet fix loop, then commit, push and reply on the thread with what changed (or reply why a finding doesn't apply). When Devin posts "All Devin Review issues are resolved.", merge the PR (merge commit), update `main`, and start the next milestone on a new branch. If GitHub doesn't pick up a push, ask the user to close and reopen the PR.
- **Context between milestones**: after a milestone's PR is merged, create the next milestone's branch, make sure `docs/PLAN.md` (checkboxes + "Handoff notes") holds everything the next milestone needs, commit, then ask the user to run `/clear` and give them a one-line resume prompt. A fresh session resumes from `CLAUDE.md` + `docs/PLAN.md` alone.

## Product flow

Terminology: the user says **project/course** for the spec's *Course*, and **class** for the spec's *Lecture*.

1. The user creates a **project (course)**.
2. Inside it they add **classes**. Each class takes:
   - **class materials** (required): HTML or PDF files;
   - **personal notes** (optional): Markdown files.
3. Once a class has materials, its **Generate** button is enabled. Pressing it runs this agent pipeline:

```
Generate
  └─ Combined-notes agent  (materials + notes → unified lesson note, spec §5)
       ├─ Quiz planner agent   (spec §7.1, plan hidden from the student)
       │    └─ Quiz builder agent  (spec §7.2)
       └─ Viz topic identifier agent  (recommends visualization topics)
            └─ USER picks topics (multi-select) and/or adds their own
                 └─ for each selected topic, in parallel:
                      Viz planner agent → Viz builder agent  (spec §12)
```

- The quiz branch and the viz-topic branch start **in parallel** as soon as the combined notes exist.
- The viz branch pauses for user input; nothing is built unasked (spec §12).
- Notes are optional: Generate works from materials alone (no "notes done" readiness gate from spec §4). With no notes there are no (P) items or note corrections.
- Planner agents run on Opus (`claude-opus-5-5`), builder agents on Sonnet (`claude-sonnet-5-5`); 4.x models are an acceptable fallback. Planners review builders' output with at most 3 fix cycles (spec §7.4, §12).
- **When review fails after 3 cycles** (quiz or visualization), report an error for the failed part, stop creating it, and offer the user a **from-scratch regeneration** (re-plan + re-build) of the failed topics. This replaces spec §7.4's "planner fixes the rest itself". Other parts (other visualizations, the other branch) carry on.

## PoC scope decisions

- **In scope**: the generate pipeline above, the quiz player (§8), grading (§9), progress tracking / learner model (§6), cumulative reviews (§11), and local import of existing material (lessons, results, progress, quizzes, visualizations; §17). Grading, progress and cumulative reviews are the core of the system, not extras.
- **Deferred** (GitHub issues): note editing and combined-notes update (#1), chat tutoring and oral practice (#2), quiz retakes like `P01R` (#3), multi-device access and sync (#4). The PoC runs locally with no deployment.
- **Language**: Serbian only (materials and notes are Serbian). No per-project language setting yet.
- **Persona**: an optional free-text field when creating a course (the tutor's role, e.g. "experienced data engineer"); passed to the agents' instructions.
- **No editing after generation**: materials and notes are fixed once a class is generated. Changing materials after generation is not planned.

## Agent framework: Mozaik

All app agents are built with Mozaik (`@mozaik-ai/core`, TypeScript). Docs: https://docs.jigjoy.ai/docs — read the relevant page (runtime, agent-loop, situation-handlers, semantic-events, runtime-state, structured-output, models) before implementing against it; the API changed in v4 and older examples may not apply.

Key concepts that shape the architecture:

- `defineRuntime<State>()` returns `initializeRuntime`, `join`, `sendMessage`, `runLoop`, `leave`. Initialize once per process (a second call throws). Shared mutable data lives on a `RuntimeState` subclass.
- Agents come from `createAgent({ name, capabilities, instruction, tools, handlers })`. Behavior lives in **situation handlers** (a `SituationSpecification.isSatisfiedBy` + a `processor.apply`), not subclasses.
- There is no orchestrator API. Pipelines are composed **by reaction**: a downstream agent's handler matches the upstream agent's `model.answer` event and calls its own `runLoop`. Parallel branches are just several handlers reacting to the same event.
- Do not `await` `runLoop`/`sendMessage` inside a processor.
- Pass data between agents with `structuredOutput` (JSON schema, `strict: true`) on `runLoop`; the result arrives as JSON text in `model.answer`.
- Tools are `FunctionTool` objects (`name`, `description`, `parameters`, `strict`, `invoke`), passed both to `createAgent` and to `runLoop`.
- **Pin `@mozaik-ai/core@4.1.0`** (exact version). 4.2 is considered not stable yet; don't upgrade without the user's approval.
- The provider is chosen by the `model` string (Anthropic models via `ANTHROPIC_API_KEY` in `.env`). 4.1.0 supports `claude-opus-5-5` and `claude-sonnet-5-5` (function calling, structured output, streaming), even though the docs' models page only lists 4.x models.
- Streaming: `streaming: true` on `runLoop` emits `inference.stream` events, useful for showing pipeline progress in the UI.

Gotchas verified in the 4.1.0 source (details and how we handle them are in `docs/PLAN.md` → Agent runtime):

- An agent's memory context accumulates across `runLoop` calls, so create a fresh agent per job stage.
- A failing `runLoop` (API error) emits no event; it's an unhandled rejection. We detect failures through a wrapping `InferenceRunner`.
- `initializeRuntime({ inferenceRunnerConfig: { runner } })` accepts a custom runner; tests use a fake one, not the real API.
- The bundled `@mozaik-ai/cloud-sdk` uploads all events **including full agent memory** to app.jigjoy.ai when `MOZAIK_API_KEY`/`MOZAIK_PROJECT_KEY` is set or `~/.mozaik/credentials.json` exists. Never set these or pair the machine.
