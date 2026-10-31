import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CourseProgress,
  CumulativeScheduleEntry,
  CumulativeStatus,
  ProgressQuizHistoryEntry,
} from "@studdy/shared";
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
  visualizations: [
    {
      id: 5,
      title: "Replikacija korak po korak",
      classNumber: 2,
      className: "Kafka",
      concept: "Replikacija",
      misconception: "Replikacija je isto što i particionisanje",
      createdAt: new Date(2026, 0, 4, 10, 0).toISOString(),
    },
  ],
  observations: ["Meša pojmove replikacije i particionisanja."],
  cumulative: [],
  flags: { classesWithoutLesson: [], ungradedSubmissions: [], cumulativeDue: null },
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
  describe("polling while grading runs", () => {
    afterEach(() => vi.useRealTimers());

    const running = () =>
      progress({
        quizHistory: [entry({ gradingStatus: "running", openScore: null, totalScore: null })],
      });
    const progressCalls = (requests: { method: string; path: string }[]) =>
      requests.filter((r) => r.method === "GET" && r.path === "/api/courses/1/progress").length;

    it("refetches every 5 s while grading runs, then stops once it is done", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let calls = 0;
      const { requests } = open(progress(), {
        "GET /api/courses/1/progress": () => (++calls < 3 ? running() : progress()),
      });
      await screen.findByText("ocenjivanje u toku", { exact: false });
      expect(progressCalls(requests)).toBe(1);

      await vi.advanceTimersByTimeAsync(5000);
      await waitFor(() => expect(progressCalls(requests)).toBe(2));
      await vi.advanceTimersByTimeAsync(5000);
      await waitFor(() => expect(progressCalls(requests)).toBe(3));
      await screen.findByText("Ukupno: 3,9");

      await vi.advanceTimersByTimeAsync(20000);
      expect(progressCalls(requests)).toBe(3);
    });

    it("does not poll when nothing is running", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { requests } = open(progress());
      await screen.findByText("Ukupno: 3,9");
      await vi.advanceTimersByTimeAsync(20000);
      expect(progressCalls(requests)).toBe(1);
    });

    it("starts polling after Oceni, because the refetch reports running", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let graded = false;
      const failed = () =>
        progress({
          flags: {
            classesWithoutLesson: [],
            ungradedSubmissions: [{ submissionId: 9, quizCode: "P01", submittedAt: "x" }],
            cumulativeDue: null,
          },
          quizHistory: [entry({ gradingStatus: "failed", openScore: null, totalScore: null })],
        });
      const { requests } = open(progress(), {
        "GET /api/courses/1/progress": () => (graded ? running() : failed()),
        "POST /api/submissions/9/grade": () => {
          graded = true;
          return { id: 1 };
        },
      });
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      await user.click(await screen.findByRole("button", { name: "Oceni" }));
      await waitFor(() => expect(progressCalls(requests)).toBe(2));
      await vi.advanceTimersByTimeAsync(5000);
      await waitFor(() => expect(progressCalls(requests)).toBe(3));
    });
  });

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

    const viz = within(section("Vizualizacije"));
    expect(viz.getByRole("link", { name: "Replikacija korak po korak" })).toHaveAttribute(
      "href",
      "/vizualizacije/5",
    );
    expect(viz.getByText("Predavanje 02 · Kafka")).toBeInTheDocument();
    expect(viz.getByText("Replikacija")).toBeInTheDocument();
    expect(viz.getByText("Cilj: Replikacija je isto što i particionisanje")).toBeInTheDocument();

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
    open(
      progress({
        nextSteps: [],
        backlog: [],
        topics: [],
        quizHistory: [],
        visualizations: [],
        observations: [],
      }),
    );
    await screen.findByRole("heading", { level: 1, name: "Napredak" });
    expect(within(section("Sledeće")).getByText(/Još nema predloga/)).toBeInTheDocument();
    expect(within(section("Obavezno u K…")).getByText(/Nema obaveznih tema/)).toBeInTheDocument();
    expect(within(section("Pregled tema")).getByText(/Još nema tema/)).toBeInTheDocument();
    expect(
      within(section("Istorija kvizova")).getByText("Još nema predatih kvizova."),
    ).toBeInTheDocument();
    expect(
      within(section("Vizualizacije")).getByText("Još nema vizualizacija."),
    ).toBeInTheDocument();
    expect(within(section("Zapažanja")).getByText(/Još nema zapažanja/)).toBeInTheDocument();
  });

  describe("session-start flags", () => {
    const flagged = () =>
      progress({
        flags: {
          cumulativeDue: null,
          classesWithoutLesson: [{ classId: 7, number: 3, title: "Kafka", status: "draft" }],
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

  describe("cumulative reviews", () => {
    const scheduleEntry = (
      over: Partial<CumulativeScheduleEntry> = {},
    ): CumulativeScheduleEntry => ({
      code: "K1",
      coversThrough: 4,
      status: "available",
      quizId: 11,
      submissionId: null,
      submittedAt: null,
      totalScore: null,
      ...over,
    });
    const status = (over: Partial<CumulativeStatus> = {}): CumulativeStatus => ({
      cadence: 4,
      readyClassCount: 4,
      due: null,
      existing: [],
      ...over,
    });
    const flags = (cumulativeDue: CourseProgress["flags"]["cumulativeDue"]) => ({
      classesWithoutLesson: [],
      ungradedSubmissions: [],
      cumulativeDue,
    });
    const openWith = (data: CourseProgress, cumulative: CumulativeStatus = status()) =>
      open(data, { "GET /api/courses/1/cumulative": () => cumulative });

    it("flags a due review at session start and posts the request", async () => {
      const { requests } = openWith(
        progress({
          cumulative: [scheduleEntry({ status: "due", quizId: null })],
          flags: flags({ code: "K1", coversThrough: 4 }),
        }),
        status({ due: { code: "K1", coversThrough: 4, classNumbers: [1, 2, 3, 4] } }),
      );
      const flagged = within(await screen.findByLabelText("Šta čeka"));
      expect(flagged.getByText("K1 je na redu (predavanja 1–4)")).toBeVisible();
      await userEvent.click(flagged.getByRole("button", { name: "Napravi K1" }));
      await waitFor(() => {
        const post = requests.find(
          (r) => r.method === "POST" && r.path === "/api/courses/1/cumulative",
        );
        expect(post?.body).toBe(JSON.stringify({ code: "K1" }));
      });
    });

    it("shows a 409 of the request inline", async () => {
      open(
        progress({
          cumulative: [scheduleEntry({ status: "due", quizId: null })],
          flags: flags({ code: "K1", coversThrough: 4 }),
        }),
        {
          "GET /api/courses/1/cumulative": () => status(),
          "POST /api/courses/1/cumulative": () => apiError(409, "conflict", "K1 se već pravi."),
        },
      );
      await userEvent.click(await screen.findByRole("button", { name: "Napravi K1" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("K1 se već pravi.");
    });

    it("lists the schedule with a status per review", async () => {
      openWith(
        progress({
          cumulative: [
            scheduleEntry({
              status: "graded",
              submittedAt: new Date(2026, 1, 3, 9, 30).toISOString(),
              totalScore: 17.5,
            }),
            scheduleEntry({ code: "K2", coversThrough: 8, status: "available", quizId: 12 }),
            scheduleEntry({
              code: "K3",
              coversThrough: 12,
              status: "submitted",
              quizId: 13,
              submittedAt: new Date(2026, 1, 4, 10, 0).toISOString(),
            }),
            scheduleEntry({ code: "K4", coversThrough: 16, status: "due", quizId: null }),
            scheduleEntry({ code: "K5", coversThrough: 20, status: "building", quizId: null }),
            scheduleEntry({
              code: "K6",
              coversThrough: 24,
              status: "grading_failed",
              quizId: 16,
              submissionId: 77,
            }),
          ],
        }),
      );
      const list = within(await screen.findByRole("region", { name: "Kumulativni testovi" }));
      const items = list.getAllByRole("listitem");
      expect(items).toHaveLength(6);
      expect(items[0]).toHaveTextContent("predavanja 1–4");
      expect(items[0]).toHaveTextContent("ocenjen");
      expect(items[0]).toHaveTextContent("Ukupno: 17,5");
      expect(items[0]).toHaveTextContent("Predat: 3. 2. 2026. 09:30");
      expect(within(items[0]!).getByRole("link", { name: "K1" })).toHaveAttribute(
        "href",
        "/kvizovi/11",
      );
      expect(items[1]).toHaveTextContent("spreman");
      expect(within(items[1]!).getByRole("link", { name: "K2" })).toHaveAttribute(
        "href",
        "/kvizovi/12",
      );
      expect(items[2]).toHaveTextContent("predat — ocenjivanje");
      expect(items[3]).toHaveTextContent("na redu");
      expect(within(items[3]!).queryByRole("link")).not.toBeInTheDocument();
      expect(within(items[4]!).getByRole("status")).toHaveTextContent("pravi se…");
      expect(items[5]).toHaveTextContent("ocenjivanje nije uspelo");
      expect(within(items[5]!).getByRole("button", { name: "Oceni ponovo" })).toBeInTheDocument();
    });

    it("re-grades a review whose grading failed", async () => {
      const { requests } = openWith(
        progress({
          cumulative: [scheduleEntry({ status: "grading_failed", submissionId: 77 })],
        }),
      );
      await userEvent.click(await screen.findByRole("button", { name: "Oceni ponovo" }));
      await waitFor(() =>
        expect(
          requests.some((r) => r.method === "POST" && r.path === "/api/submissions/77/grade"),
        ).toBe(true),
      );
    });

    describe("polling", () => {
      afterEach(() => vi.useRealTimers());
      const calls = (requests: { method: string; path: string }[]) =>
        requests.filter((r) => r.method === "GET" && r.path === "/api/courses/1/progress").length;

      it("does not poll a review whose grading failed", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { requests } = open(
          progress({
            cumulative: [scheduleEntry({ status: "grading_failed", submissionId: 77 })],
          }),
          { "GET /api/courses/1/cumulative": () => status() },
        );
        await screen.findByText("ocenjivanje nije uspelo");
        await vi.advanceTimersByTimeAsync(20000);
        expect(calls(requests)).toBe(1);
      });

      it.each(["building", "submitted"] as const)(
        "refetches every 5 s while a review is %s, then stops",
        async (busy) => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          let n = 0;
          const { requests } = open(progress(), {
            "GET /api/courses/1/cumulative": () => status(),
            "GET /api/courses/1/progress": () =>
              ++n < 2
                ? progress({ cumulative: [scheduleEntry({ status: busy })] })
                : progress({ cumulative: [scheduleEntry({ status: "graded", totalScore: 9 })] }),
          });
          await screen.findByText("Kumulativni testovi");
          expect(calls(requests)).toBe(1);
          await vi.advanceTimersByTimeAsync(5000);
          await waitFor(() => expect(calls(requests)).toBe(2));
          await screen.findByText("Ukupno: 9");
          await vi.advanceTimersByTimeAsync(20000);
          expect(calls(requests)).toBe(2);
        },
      );
    });

    it("offers a manual review when the course has no cadence", async () => {
      const { requests } = open(progress(), {
        "GET /api/courses/1/cumulative": () => status({ cadence: null, readyClassCount: 2 }),
        "POST /api/courses/1/cumulative": () => ({ id: 3, classId: 6 }),
      });
      expect(
        await screen.findByText("Kurs nema podešen ritam kumulativnih testova."),
      ).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Napravi kumulativni test" }));
      await waitFor(() => {
        const post = requests.find((r) => r.method === "POST");
        expect(post?.path).toBe("/api/courses/1/cumulative");
        expect(post?.body).toBeUndefined();
      });
      expect(await screen.findByRole("link", { name: /Prati tok/ })).toHaveAttribute(
        "href",
        "/predavanja/6",
      );
    });

    it("offers no manual review without a ready class, or when a cadence is set", async () => {
      openWith(progress(), status({ cadence: null, readyClassCount: 0 }));
      await screen.findByText("Kurs nema podešen ritam kumulativnih testova.");
      expect(screen.queryByRole("button", { name: "Napravi kumulativni test" })).toBeNull();
    });

    it("says there are no reviews yet when a cadence is set", async () => {
      openWith(progress());
      expect(await screen.findByText("Još nema kumulativnih testova.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Napravi kumulativni test" })).toBeNull();
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
