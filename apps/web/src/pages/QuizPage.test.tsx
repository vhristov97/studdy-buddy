import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PublicQuiz, QuizSummary, SubmissionDetail, SubmissionSummary } from "@studdy/shared";
import { apiError, json, mockApi, renderAt, type Handler } from "../test/utils";

const quiz = (over: Partial<PublicQuiz> = {}): PublicQuiz => ({
  id: 1,
  courseId: 1,
  courseName: "ASVSP",
  classId: 5,
  code: "P01",
  title: "Uvod u velike podatke",
  subtitle: "Predavanje 1",
  chips: ["6 pitanja", "Lako"],
  createdAt: "2026-01-02T10:00:00.000Z",
  questions: [
    {
      id: "q1",
      type: "mc",
      topic: "Matematika",
      prompt: "Koliko je **jedan plus jedan**?",
      ref: "Slajd 3 (predavač)",
      extra: false,
      options: ["Jedan", "Dva", "Tri"],
    },
    {
      id: "q2",
      type: "mc",
      topic: "Mreže",
      prompt: "Koji protokol garantuje isporuku?",
      ref: "Slajd 7",
      extra: false,
      options: ["TCP", "UDP"],
    },
    {
      id: "q3",
      type: "num",
      topic: "Mreže",
      prompt: "Kolika je tipična latencija?",
      ref: "Slajd 9",
      extra: true,
      unit: "ms",
    },
    {
      id: "q4",
      type: "match",
      topic: "Kontejneri",
      prompt: "Poveži alat sa ulogom.",
      ref: "Slajd 12",
      extra: false,
      rows: ["Docker", "Kubernetes"],
      choices: ["Kontejner", "Orkestrator", "Registar"],
    },
    {
      id: "q5",
      type: "open",
      topic: "Kontejneri",
      prompt: "Objasni pojam kontejnera.",
      ref: "Slajd 13",
      extra: false,
    },
    {
      id: "q6",
      type: "open",
      topic: "Kontejneri",
      prompt: "Objasni pojam slike.",
      ref: "Slajd 14",
      extra: false,
    },
  ],
  ...over,
});

const summary = (over: Partial<QuizSummary> = {}): QuizSummary => ({
  id: 1,
  courseId: 1,
  classId: 5,
  code: "P01",
  title: "Uvod u velike podatke",
  subtitle: "Predavanje 1",
  chips: [],
  questionCount: 6,
  createdAt: "2026-01-02T10:00:00.000Z",
  ...over,
});

const submissionSummary = (over: Partial<SubmissionSummary> = {}): SubmissionSummary => ({
  id: 9,
  quizId: 1,
  autoScore: 2.5,
  autoMax: 4,
  openPending: 1,
  dontKnow: [],
  submittedAt: new Date(2026, 0, 3, 14, 5).toISOString(),
  gradingStatus: "none",
  ...over,
});

/** One question per status: correct, wrong, dont_know, partial, open_pending, unanswered. */
const detail = (over: Partial<SubmissionDetail> = {}): SubmissionDetail => ({
  ...submissionSummary(),
  dontKnow: ["q3"],
  answers: { q1: 1, q2: 1, q3: "?", q4: { "0": 0, "1": 0 }, q5: "Kontejner je izolovan proces." },
  results: [
    { id: "q1", type: "mc", status: "correct", score: 1, max: 1 },
    { id: "q2", type: "mc", status: "wrong", score: 0, max: 1 },
    { id: "q3", type: "num", status: "dont_know", score: 0, max: 1 },
    {
      id: "q4",
      type: "match",
      status: "partial",
      score: 0.5,
      max: 1,
      correctRows: 1,
      totalRows: 2,
    },
    { id: "q5", type: "open", status: "open_pending", score: 0, max: 0 },
    { id: "q6", type: "open", status: "unanswered", score: 0, max: 0 },
  ],
  feedback: {
    questions: [
      { id: "q1", type: "mc", answer: 1, explanation: "Zbir je **dva**." },
      { id: "q2", type: "mc", answer: 0, explanation: "TCP potvrđuje prijem." },
      {
        id: "q3",
        type: "num",
        answer: 20,
        tolerance: 5.5,
        unit: "ms",
        explanation: "Tipično 20 ms.",
      },
      { id: "q4", type: "match", answer: [0, 1], explanation: "Docker pravi kontejnere." },
      { id: "q5", type: "open", keyPoints: ["Izolacija procesa", "Deli jezgro"] },
      { id: "q6", type: "open", keyPoints: ["Šablon za kontejner"] },
    ],
  },
  grading: { status: "none", error: null, result: null },
  ...over,
});

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /api/quizzes/1": () => quiz(),
    "GET /api/courses/1/quizzes": () => [summary()],
    "GET /api/quizzes/1/submissions": () => [],
    ...extra,
  };
}

const card = (name: RegExp | string) => screen.getByRole("article", { name });

async function openPlayer(extra: Record<string, Handler> = {}) {
  const api = mockApi(routes(extra));
  const user = userEvent.setup();
  renderAt("/kvizovi/1");
  await screen.findByRole("heading", { level: 1, name: "Uvod u velike podatke" });
  return { ...api, user };
}

describe("QuizPage player", () => {
  it("renders the header and all four question types with their metadata", async () => {
    await openPlayer();
    expect(screen.getAllByText("ASVSP").length).toBeGreaterThan(0);
    expect(screen.getByText("Predavanje 1")).toBeInTheDocument();
    expect(screen.getByText("Lako")).toBeInTheDocument();

    const mc = card(/jedan plus jedan/);
    expect(within(mc).getByText("Pitanje 1")).toBeInTheDocument();
    expect(within(mc).getByText("Slajd 3 (predavač)")).toBeInTheDocument();
    expect(within(mc).queryByText("dodatak tutora")).not.toBeInTheDocument();
    expect(
      within(mc)
        .getAllByRole("radio")
        .map((r) => r.closest("label")?.textContent),
    ).toEqual(["Jedan", "Dva", "Tri", "Ne znam"]);

    const num = card(/latencija/);
    expect(within(num).getByText("dodatak tutora")).toBeInTheDocument();
    expect(within(num).getByLabelText("Odgovor (broj)")).toBeInTheDocument();
    expect(within(num).getByText("ms")).toBeInTheDocument();
    expect(within(num).getByRole("checkbox", { name: "Ne znam" })).toBeInTheDocument();

    const match = card(/Poveži alat/);
    const select = within(match).getByLabelText("Docker");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["— izaberi —", "Kontejner", "Orkestrator", "Registar", "Ne znam"]);
    expect(within(match).getByLabelText("Kubernetes")).toBeInTheDocument();

    const open = card(/kontejnera/);
    expect(within(open).getByLabelText("Odgovor")).toHaveAttribute(
      "placeholder",
      "Objasni svojim rečima, kao na usmenom…",
    );
    expect(within(open).getByRole("checkbox", { name: "Ne znam" })).toBeInTheDocument();
  });

  it("disables an input when Ne znam is chosen and counts it as answered", async () => {
    const { user } = await openPlayer();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "6");

    const num = card(/latencija/);
    await user.type(within(num).getByLabelText("Odgovor (broj)"), "12");
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    await user.click(within(num).getByRole("checkbox", { name: "Ne znam" }));
    expect(within(num).getByLabelText("Odgovor (broj)")).toBeDisabled();
    expect(within(num).getByLabelText("Odgovor (broj)")).toHaveValue("");
    expect(bar).toHaveAttribute("aria-valuenow", "1");

    const open = card(/kontejnera/);
    await user.click(within(open).getByRole("checkbox", { name: "Ne znam" }));
    expect(within(open).getByLabelText("Odgovor")).toBeDisabled();

    const mc = card(/jedan plus jedan/);
    await user.click(within(mc).getByRole("radio", { name: "Ne znam" }));
    expect(within(mc).getByRole("radio", { name: "Ne znam" })).toBeChecked();
    expect(bar).toHaveAttribute("aria-valuenow", "3");

    // A match question counts only when every row is filled.
    const match = card(/Poveži alat/);
    await user.selectOptions(within(match).getByLabelText("Docker"), "Kontejner");
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    await user.selectOptions(within(match).getByLabelText("Kubernetes"), "Ne znam");
    expect(bar).toHaveAttribute("aria-valuenow", "4");
    expect(screen.getByText("Odgovoreno 4 od 6")).toBeInTheDocument();
  });

  it("asks for a number when the text is not one, and does not count it", async () => {
    const { user } = await openPlayer();
    const num = card(/latencija/);
    await user.type(within(num).getByLabelText("Odgovor (broj)"), "abc");
    expect(within(num).getByText("Unesi broj, npr. 3,5.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  describe("draft", () => {
    it("is restored from localStorage and saved as the student answers", async () => {
      localStorage.setItem(
        "studdy:quiz-draft:1",
        JSON.stringify({
          q1: 1,
          q3: { text: "4,5", dontKnow: false },
          q4: { "1": 2 },
          q5: { text: "", dontKnow: true },
          unknown: 3,
        }),
      );
      const { user } = await openPlayer();
      expect(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" })).toBeChecked();
      expect(within(card(/latencija/)).getByLabelText("Odgovor (broj)")).toHaveValue("4,5");
      expect(within(card(/Poveži alat/)).getByLabelText("Kubernetes")).toHaveValue("2");
      expect(within(card(/kontejnera/)).getByLabelText("Odgovor")).toBeDisabled();

      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Tri" }));
      const stored = JSON.parse(localStorage.getItem("studdy:quiz-draft:1") ?? "{}") as unknown;
      expect(stored).toMatchObject({ q1: 2, q3: { text: "4,5" } });
    });

    it("ignores a corrupt stored draft", async () => {
      localStorage.setItem("studdy:quiz-draft:1", "{not json");
      await openPlayer();
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    });

    it("works when localStorage throws", async () => {
      const boom = () => {
        throw new Error("storage blocked");
      };
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
      const { user } = await openPlayer();
      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      expect(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" })).toBeChecked();
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    });
  });

  describe("submit", () => {
    const submitted = (req: { body: BodyInit | null | undefined }) =>
      JSON.parse(req.body as string) as { answers: unknown };

    it("warns with the unanswered count first and posts on the second click", async () => {
      const { user, requests } = await openPlayer({
        "POST /api/quizzes/1/submissions": () => json(detail(), 201),
      });

      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      await user.click(within(card(/Koji protokol/)).getByRole("radio", { name: "Ne znam" }));
      await user.type(within(card(/latencija/)).getByLabelText("Odgovor (broj)"), "3,5");
      const match = card(/Poveži alat/);
      await user.selectOptions(within(match).getByLabelText("Docker"), "Orkestrator");
      await user.selectOptions(within(match).getByLabelText("Kubernetes"), "Ne znam");
      await user.type(within(card(/kontejnera/)).getByLabelText("Odgovor"), "  Tekst  ");

      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Nisi odgovorio na 1 pitanje. Klikni ponovo da predaš.",
      );
      expect(requests.some((r) => r.method === "POST")).toBe(false);

      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await screen.findAllByText("Rezultat: 2,5 / 4");
      const post = requests.find((r) => r.method === "POST");
      expect(post?.headers.get("Content-Type")).toBe("application/json");
      expect(submitted(post as { body: BodyInit })).toEqual({
        answers: {
          q1: 1,
          q2: "?",
          q3: 3.5,
          q4: { "0": 1, "1": "?" },
          q5: "Tekst",
        },
      });
      // The draft is gone after a successful submit.
      expect(localStorage.getItem("studdy:quiz-draft:1")).toBeNull();
    });

    it("blocks a submission without any answer and does not post", async () => {
      const { user, requests } = await openPlayer({
        "POST /api/quizzes/1/submissions": () => json(detail(), 201),
      });
      await user.type(within(card(/kontejnera/)).getByLabelText("Odgovor"), "   ");
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Nijedno pitanje nije odgovoreno.");
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Nijedno pitanje nije odgovoreno.");
      expect(requests.some((r) => r.method === "POST")).toBe(false);

      // Ne znam is an answer: the usual two-step warning follows instead.
      await user.click(within(card(/Koji protokol/)).getByRole("radio", { name: "Ne znam" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Nisi odgovorio na");
    });

    it("submits straight away when everything is answered", async () => {
      const { user, requests } = await openPlayer({
        "POST /api/quizzes/1/submissions": () => json(detail(), 201),
      });
      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      await user.click(within(card(/Koji protokol/)).getByRole("radio", { name: "TCP" }));
      await user.click(within(card(/latencija/)).getByRole("checkbox", { name: "Ne znam" }));
      const match = card(/Poveži alat/);
      await user.selectOptions(within(match).getByLabelText("Docker"), "Kontejner");
      await user.selectOptions(within(match).getByLabelText("Kubernetes"), "Orkestrator");
      await user.click(within(card(/kontejnera/)).getByRole("checkbox", { name: "Ne znam" }));
      await user.click(within(card(/slike/)).getByRole("checkbox", { name: "Ne znam" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await screen.findAllByText(/^Rezultat:/);
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
      expect(
        submitted(requests.find((r) => r.method === "POST") as { body: BodyInit }).answers,
      ).toEqual({
        q1: 1,
        q2: 0,
        q3: "?",
        q4: { "0": 0, "1": 1 },
        q5: "?",
        q6: "?",
      });
    });

    it("shows the validation details of a 400", async () => {
      const { user } = await openPlayer({
        "POST /api/quizzes/1/submissions": () =>
          apiError(400, "validation", "Invalid answers", ["q1: option 7 is out of range"]),
      });
      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      expect(await screen.findByText("q1: option 7 is out of range")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Kopiraj" })).not.toBeInTheDocument();
    });
  });

  describe("feedback", () => {
    async function submitAll() {
      const api = await openPlayer({
        "POST /api/quizzes/1/submissions": () => json(detail(), 201),
      });
      await api.user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      await api.user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await api.user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await screen.findAllByText("Rezultat: 2,5 / 4");
      return api;
    }

    it("shows a status, the correct answer and the explanation per question", async () => {
      await submitAll();

      const q1 = card(/jedan plus jedan/);
      expect(within(q1).getByText("Tačno")).toBeInTheDocument();
      expect(within(q1).getByText("Zbir je", { exact: false })).toBeInTheDocument();

      const q2 = card(/Koji protokol/);
      expect(within(q2).getByText("Netačno")).toBeInTheDocument();
      expect(within(q2).getByText("tačan odgovor")).toBeInTheDocument();

      const q3 = card(/latencija/);
      // The checkbox label and the status chip.
      expect(within(q3).getAllByText("Ne znam")).toHaveLength(2);
      expect(within(q3).getByText(/Tačan odgovor:/).parentElement).toHaveTextContent(
        "Tačan odgovor: 20 ± 5,5 ms",
      );

      const q4 = card(/Poveži alat/);
      expect(within(q4).getByText("Delimično (1/2)")).toBeInTheDocument();
      expect(within(q4).getByText("Tačno")).toBeInTheDocument();
      expect(within(q4).getByText("Netačno. Tačan odgovor: Orkestrator")).toBeInTheDocument();

      const q5 = card(/kontejnera/);
      expect(within(q5).getByText("Čeka ocenjivanje")).toBeInTheDocument();
      expect(within(q5).getByText("Izolacija procesa")).toBeInTheDocument();
      expect(within(q5).getByText("Deli jezgro")).toBeInTheDocument();

      const q6 = card(/slike/);
      expect(within(q6).getByText("Bez odgovora")).toBeInTheDocument();
    });

    it("makes the inputs read-only and marks the chosen wrong option", async () => {
      await submitAll();
      const q2 = card(/Koji protokol/);
      expect(within(q2).getByRole("radio", { name: /UDP/ })).toBeDisabled();
      expect(within(q2).getByRole("radio", { name: /UDP/ }).closest("label")).toHaveTextContent(
        "tvoj odgovor",
      );
      expect(within(card(/Poveži alat/)).getByLabelText("Docker")).toBeDisabled();
      expect(within(card(/kontejnera/)).getByLabelText("Odgovor")).toHaveAttribute("readonly");
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Predaj kviz" })).not.toBeInTheDocument();
    });

    it("shows the score line at the top and bottom with the pending open questions", async () => {
      await submitAll();
      const lines = screen.getAllByText("Rezultat: 2,5 / 4");
      expect(lines).toHaveLength(2);
      expect(screen.getAllByText("1 otvoreno pitanje čeka ocenjivanje")).toHaveLength(2);
    });

    it("pluralizes the pending open questions", async () => {
      const { user } = await openPlayer({
        "POST /api/quizzes/1/submissions": () => json(detail({ openPending: 2 }), 201),
      });
      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      expect(await screen.findAllByText("2 otvorena pitanja čekaju ocenjivanje")).toHaveLength(2);
    });

    it("clears answers and feedback on 'Pokušaj ponovo'", async () => {
      const { user } = await submitAll();
      await user.click(screen.getByRole("button", { name: "Pokušaj ponovo" }));
      expect(screen.queryByText(/^Rezultat:/)).not.toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
      expect(within(card(/Koji protokol/)).getByRole("radio", { name: "UDP" })).toBeEnabled();
      expect(within(card(/Koji protokol/)).getByRole("radio", { name: "UDP" })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Predaj kviz" })).toBeInTheDocument();
    });
  });

  describe("when saving fails", () => {
    const failing = (): Handler => () => {
      throw new TypeError("Failed to fetch");
    };

    it("shows the submission JSON with a copy button and keeps the draft", async () => {
      const { user } = await openPlayer({ "POST /api/quizzes/1/submissions": failing() });
      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));

      const box = await screen.findByLabelText("Odgovori u JSON formatu");
      expect(box).toHaveAttribute("readonly");
      const parsed = JSON.parse((box as HTMLTextAreaElement).value) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(["quizId", "submittedAt", "answers"]);
      expect(parsed).toMatchObject({ quizId: 1, answers: { q1: 1 } });
      expect(Number.isNaN(Date.parse(parsed.submittedAt as string))).toBe(false);
      expect(localStorage.getItem("studdy:quiz-draft:1")).not.toBeNull();

      await user.click(screen.getByRole("button", { name: "Kopiraj" }));
      expect(await screen.findByText("Kopirano")).toBeInTheDocument();
      expect(await navigator.clipboard.readText()).toBe((box as HTMLTextAreaElement).value);
    });

    it("falls back to a select-all hint when the clipboard is unavailable", async () => {
      const { user } = await openPlayer({ "POST /api/quizzes/1/submissions": failing() });
      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await screen.findByLabelText("Odgovori u JSON formatu");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
      await user.click(screen.getByRole("button", { name: "Kopiraj" }));
      expect(await screen.findByText(/Kopiranje nije uspelo/)).toBeInTheDocument();
    });

    it("also falls back on a server error", async () => {
      const { user } = await openPlayer({
        "POST /api/quizzes/1/submissions": () => apiError(500, "internal", "Boom"),
      });
      await user.click(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      await user.click(screen.getByRole("button", { name: "Predaj kviz" }));
      expect(await screen.findByLabelText("Odgovori u JSON formatu")).toBeInTheDocument();
    });
  });

  describe("picker", () => {
    const library = [
      summary({ id: 3, code: "P03", title: "Treće" }),
      summary({ id: 2, code: "P02", title: "Drugo" }),
      summary({ id: 1 }),
    ];

    it("opens the newest quiz of the course and navigates when changed", async () => {
      mockApi({
        "GET /api/courses/1/quizzes": () => library,
        "GET /api/quizzes/3": () => quiz({ id: 3, code: "P03", title: "Treće" }),
        "GET /api/quizzes/2": () => quiz({ id: 2, code: "P02", title: "Drugo" }),
        "GET /api/quizzes/3/submissions": () => [],
        "GET /api/quizzes/2/submissions": () => [],
      });
      const user = userEvent.setup();
      renderAt("/kursevi/1/kvizovi");
      expect(await screen.findByRole("heading", { level: 1, name: "Treće" })).toBeInTheDocument();
      const select = await screen.findByLabelText("Kviz");
      expect(select).toHaveValue("3");
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["P03 — Treće", "P02 — Drugo", "P01 — Uvod u velike podatke"]);

      await user.selectOptions(select, "P02 — Drugo");
      expect(await screen.findByRole("heading", { level: 1, name: "Drugo" })).toBeInTheDocument();
      expect(screen.getByLabelText("Kviz")).toHaveValue("2");
    });

    it("says so when the course has no quizzes", async () => {
      mockApi({ "GET /api/courses/1/quizzes": () => [] });
      renderAt("/kursevi/1/kvizovi");
      expect(await screen.findByText("Još nema kvizova.")).toBeInTheDocument();
    });
  });

  describe("past submissions", () => {
    it("lists them with links to a read-only view", async () => {
      const past = [
        submissionSummary(),
        submissionSummary({ id: 8, autoScore: 1, autoMax: 4, openPending: 0 }),
      ];
      mockApi(
        routes({
          "GET /api/quizzes/1/submissions": () => past,
          "GET /api/submissions/9": () => detail(),
        }),
      );
      const user = userEvent.setup();
      renderAt("/kvizovi/1");
      const section = (await screen.findByRole("heading", { name: "Ranije predaje" })).closest(
        "section",
      ) as HTMLElement;
      expect(within(section).getAllByRole("listitem")).toHaveLength(2);
      expect(within(section).getByText("2,5 / 4")).toBeInTheDocument();
      expect(within(section).getByText("1 / 4")).toBeInTheDocument();
      expect(within(section).getByText("1 otvoreno pitanje čeka ocenjivanje")).toBeInTheDocument();

      await user.click(within(section).getAllByRole("link")[0] as HTMLElement);
      expect(await screen.findAllByText("Rezultat: 2,5 / 4")).toHaveLength(2);
      expect(screen.getByText(/Predaja od 3\. 1\. 2026\. 14:05/)).toBeInTheDocument();
      expect(within(card(/Koji protokol/)).getByText("Netačno")).toBeInTheDocument();
      expect(within(card(/kontejnera/)).getByLabelText("Odgovor")).toHaveValue(
        "Kontejner je izolovan proces.",
      );
      expect(within(card(/latencija/)).getByLabelText("Odgovor (broj)")).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Predaj kviz" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Pokušaj ponovo" })).toHaveAttribute(
        "href",
        "/kvizovi/1",
      );
    });

    it("rejects a submission of another quiz", async () => {
      mockApi(routes({ "GET /api/submissions/9": () => detail({ quizId: 2 }) }));
      renderAt("/kvizovi/1/predaje/9");
      expect(await screen.findByText("Ova predaja ne pripada ovom kvizu.")).toBeInTheDocument();
    });
  });

  it("shows a friendly message for a missing quiz", async () => {
    mockApi({});
    renderAt("/kvizovi/99");
    expect(await screen.findByRole("heading", { name: "Ne postoji" })).toBeInTheDocument();
  });

  it("is usable by keyboard", async () => {
    const { user } = await openPlayer();
    const dva = within(card(/jedan plus jedan/)).getByRole("radio", { name: "Dva" });
    dva.focus();
    await user.keyboard(" ");
    expect(dva).toBeChecked();
    await user.keyboard("{ArrowDown}");
    expect(within(card(/jedan plus jedan/)).getByRole("radio", { name: "Tri" })).toBeChecked();
  });
});
