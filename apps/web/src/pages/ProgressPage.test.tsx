import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { CourseProgress, ProgressQuizHistoryEntry } from "@studdy/shared";
import { apiError, courseDetail, mockApi, renderAt, type Handler } from "../test/utils";

const entry = (over: Partial<ProgressQuizHistoryEntry> = {}): ProgressQuizHistoryEntry => ({
  quizId: 1,
  code: "P01",
  title: "Uvod u velike podatke",
  submissionId: 9,
  submittedAt: new Date(2026, 0, 3, 14, 5).toISOString(),
  autoScore: 2.5,
  autoMax: 4,
  openScore: 1.4,
  totalScore: 3.9,
  gradingStatus: "done",
  ...over,
});

const progress = (over: Partial<CourseProgress> = {}): CourseProgress => ({
  nextSteps: ["Ponovi Kafku", "Uradi P02"],
  backlog: [
    { topic: "Replikacija", classNumber: 2, dueQuiz: "K2", reason: "left_out", createdAt: "x" },
    { topic: "Particije", classNumber: 1, dueQuiz: "K1", reason: "weak", createdAt: "x" },
    { topic: "Brokeri", classNumber: 1, dueQuiz: "K1", reason: "gap", createdAt: "x" },
  ],
  topics: [
    {
      id: 1,
      classNumber: 1,
      name: "Veliki podaci",
      rating: "✓",
      deferred: false,
      testedRefs: ["P01"],
      lastNote: "Sve tačno.",
    },
    {
      id: 2,
      classNumber: 2,
      name: "Kontejneri",
      rating: "?",
      deferred: false,
      testedRefs: [],
      lastNote: null,
    },
  ],
  quizHistory: [entry()],
  observations: ["Meša pojmove replikacije i particionisanja."],
  flags: { classesWithoutLesson: [], ungradedSubmissions: [] },
  ...over,
});

function open(data: CourseProgress, extra: Record<string, Handler> = {}) {
  const api = mockApi({
    "GET /api/courses/1": () => courseDetail(),
    "GET /api/courses/1/progress": () => data,
    ...extra,
  });
  renderAt("/kursevi/1/napredak");
  return api;
}

const section = (name: string) => screen.getByRole("region", { name });

describe("ProgressPage", () => {
  it("renders all sections", async () => {
    open(progress());
    await screen.findByRole("heading", { level: 1, name: "Napredak" });

    const next = within(section("Sledeće"));
    expect(next.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Ponovi Kafku",
      "Uradi P02",
    ]);

    const backlog = within(section("Obavezno u K…"));
    expect(backlog.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Obavezno u K1",
      "Obavezno u K2",
    ]);
    expect(backlog.getByText(/Particije/).parentElement).toHaveTextContent(
      "Particije · predavanje 01 · slabo",
    );
    expect(backlog.getByText(/Brokeri/).parentElement).toHaveTextContent("ne znam");
    expect(backlog.getByText(/Replikacija/).parentElement).toHaveTextContent(
      "izostavljeno iz kviza",
    );

    const topics = within(section("Pregled tema"));
    const rows = topics.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("Veliki podaci");
    expect(rows[1]).toHaveTextContent("P01");
    expect(rows[1]).toHaveTextContent("Sve tačno.");
    expect(rows[2]).toHaveTextContent("Kontejneri");

    const history = within(section("Istorija kvizova"));
    expect(history.getByRole("link", { name: /P01 — Uvod u velike podatke/ })).toHaveAttribute(
      "href",
      "/kvizovi/1/predaje/9",
    );
    expect(history.getByText("auto 2,5/4 + otvorena 1,4")).toBeInTheDocument();
    expect(history.getByText("Ukupno: 3,9")).toBeInTheDocument();

    const observations = within(section("Zapažanja"));
    expect(observations.getByText(/Meša pojmove/)).toBeInTheDocument();
    expect(observations.getByText(/zajednička za sve kurseve/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Šta čeka")).not.toBeInTheDocument();
  });

  it("shows the grading state of each quiz in the history", async () => {
    open(
      progress({
        quizHistory: [
          entry({ submissionId: 4, gradingStatus: "none", openScore: null, totalScore: null }),
          entry({ submissionId: 3, gradingStatus: "running", openScore: null, totalScore: null }),
          entry({ submissionId: 2, gradingStatus: "failed", openScore: null, totalScore: null }),
        ],
      }),
    );
    const history = within(await screen.findByRole("region", { name: "Istorija kvizova" }));
    expect(history.getByText("auto 2,5/4 · čeka ocenjivanje")).toBeInTheDocument();
    expect(history.getByText("auto 2,5/4 · ocenjivanje u toku")).toBeInTheDocument();
    expect(history.getByText("auto 2,5/4 · ocenjivanje nije uspelo")).toBeInTheDocument();
    expect(history.queryByText(/^Ukupno/)).not.toBeInTheDocument();
  });

  it("shows an empty state for every section", async () => {
    open(progress({ nextSteps: [], backlog: [], topics: [], quizHistory: [], observations: [] }));
    await screen.findByRole("heading", { level: 1, name: "Napredak" });
    expect(within(section("Sledeće")).getByText(/Još nema predloga/)).toBeInTheDocument();
    expect(within(section("Obavezno u K…")).getByText(/Nema obaveznih tema/)).toBeInTheDocument();
    expect(within(section("Pregled tema")).getByText(/Još nema tema/)).toBeInTheDocument();
    expect(
      within(section("Istorija kvizova")).getByText("Još nema predatih kvizova."),
    ).toBeInTheDocument();
    expect(within(section("Zapažanja")).getByText(/Još nema zapažanja/)).toBeInTheDocument();
  });

  describe("session-start flags", () => {
    const flagged = () =>
      progress({
        flags: {
          classesWithoutLesson: [{ classId: 7, number: 3, title: "Kafka" }],
          ungradedSubmissions: [
            {
              submissionId: 9,
              quizCode: "P01",
              submittedAt: new Date(2026, 0, 3, 14, 5).toISOString(),
            },
            {
              submissionId: 10,
              quizCode: "P02",
              submittedAt: new Date(2026, 0, 4, 9, 0).toISOString(),
            },
          ],
        },
        quizHistory: [
          entry({ submissionId: 9, gradingStatus: "failed", openScore: null, totalScore: null }),
          entry({
            submissionId: 10,
            quizId: 2,
            code: "P02",
            gradingStatus: "running",
            openScore: null,
            totalScore: null,
          }),
        ],
      });

    it("lists classes without a lesson and ungraded submissions with links", async () => {
      open(flagged());
      const flags = within(await screen.findByLabelText("Šta čeka"));
      expect(flags.getByText("Predavanja sa materijalima bez objedinjenih beleški")).toBeVisible();
      expect(flags.getByRole("link", { name: "03 — Kafka" })).toHaveAttribute(
        "href",
        "/predavanja/7",
      );
      expect(flags.getByText("Neocenjene predaje")).toBeVisible();
      expect(flags.getByRole("link", { name: "P01 · 3. 1. 2026. 14:05" })).toHaveAttribute(
        "href",
        "/kvizovi/1/predaje/9",
      );
      // A running grading offers no button.
      expect(flags.getAllByRole("button", { name: "Oceni" })).toHaveLength(1);
      expect(flags.getByText("ocenjivanje u toku")).toBeInTheDocument();
    });

    it("posts to the grade endpoint", async () => {
      const { requests } = open(flagged(), {
        "POST /api/submissions/9/grade": () => ({ id: 1 }),
      });
      await userEvent.click(await screen.findByRole("button", { name: "Oceni" }));
      await waitFor(() =>
        expect(
          requests.some((r) => r.method === "POST" && r.path === "/api/submissions/9/grade"),
        ).toBe(true),
      );
    });

    it("shows a 409 inline", async () => {
      open(flagged(), {
        "POST /api/submissions/9/grade": () => apiError(409, "conflict", "Ocenjivanje već traje."),
      });
      await userEvent.click(await screen.findByRole("button", { name: "Oceni" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Ocenjivanje već traje.");
    });
  });

  it("is linked from the course page", async () => {
    mockApi({ "GET /api/courses/1": () => courseDetail() });
    renderAt("/kursevi/1");
    expect(await screen.findByRole("link", { name: "Napredak" })).toHaveAttribute(
      "href",
      "/kursevi/1/napredak",
    );
  });
});
