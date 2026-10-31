import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as baseRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuizSummary } from "@studdy/shared";
import { apiError, job, mockApi, vizSuggestionFixture } from "../test/utils";
import { PipelinePanel, PipelineStages } from "./PipelinePanel";

/** The panel links to the player, so it needs a router. */
const render = (ui: ReactElement) => baseRender(ui, { wrapper: MemoryRouter });

const NOW = Date.parse("2026-01-01T10:01:05.000Z");

describe("PipelineStages", () => {
  it("shows a running job with elapsed time and progress", () => {
    render(<PipelineStages jobs={[job()]} progress={new Map([[1, 12_437]])} now={NOW} />);
    expect(screen.getByText("Objedinjene beleške")).toBeInTheDocument();
    expect(screen.getByText("U toku…")).toBeInTheDocument();
    expect(screen.getByText("1 min 05 s")).toBeInTheDocument();
    expect(screen.getByText("~12.400 znakova")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("announces updates politely", () => {
    const { container } = render(<PipelineStages jobs={[job()]} progress={new Map()} now={NOW} />);
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("shows the final duration and attempt of a succeeded job", () => {
    const done = job({
      status: "succeeded",
      attempt: 2,
      finishedAt: "2026-01-01T10:03:20.000Z",
    });
    render(<PipelineStages jobs={[done]} progress={new Map([[1, 500]])} now={NOW} />);
    expect(screen.getByText("Završeno")).toBeInTheDocument();
    expect(screen.getByText("3 min 20 s")).toBeInTheDocument();
    expect(screen.getByText("pokušaj 2")).toBeInTheDocument();
    expect(screen.queryByText(/znakova/)).not.toBeInTheDocument();
  });

  it("shows the error of a failed job and retries on click", async () => {
    const onRetry = vi.fn();
    const failed = job({
      status: "failed",
      error: "Model je prekinuo odgovor",
      finishedAt: "2026-01-01T10:00:30.000Z",
    });
    render(<PipelineStages jobs={[failed]} progress={new Map()} now={NOW} onRetry={onRetry} />);
    expect(screen.getByText("Neuspešno")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Model je prekinuo odgovor");
    await userEvent.click(screen.getByRole("button", { name: "Pokušaj ponovo" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("offers no retry without a handler", () => {
    render(
      <PipelineStages
        jobs={[job({ status: "failed", error: "x", finishedAt: "2026-01-01T10:00:30.000Z" })]}
        progress={new Map()}
        now={NOW}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps earlier attempts inside a collapsed details element", () => {
    const jobs = [
      job({ id: 3, attempt: 3 }),
      job({
        id: 2,
        attempt: 2,
        status: "failed",
        error: "druga greška",
        finishedAt: "2026-01-01T10:00:20.000Z",
      }),
      job({
        id: 1,
        status: "failed",
        error: "prva greška",
        finishedAt: "2026-01-01T10:00:10.000Z",
      }),
    ];
    const { container } = render(<PipelineStages jobs={jobs} progress={new Map()} now={NOW} />);
    const details = container.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(within(details!).getByText("Ranija pokušaja: 2")).toBeInTheDocument();
    expect(within(details!).getByText("druga greška")).toBeInTheDocument();
    // The latest attempt is the headline row, outside the details.
    expect(screen.getByText("U toku…")).toBeInTheDocument();
    expect(details).not.toContainElement(screen.getByText("U toku…"));
  });
});

const quizJob = (over: Parameters<typeof job>[0] = {}) =>
  job({ id: 2, kind: "quiz", stage: "quiz-planner", ...over });
const lessonDone = (over: Parameters<typeof job>[0] = {}) =>
  job({ status: "succeeded", finishedAt: "2026-01-01T10:00:50.000Z", ...over });
const FAILED = { status: "failed", finishedAt: "2026-01-01T10:00:55.000Z" } as const;

const quizSummary = (over: Partial<QuizSummary> = {}): QuizSummary => ({
  id: 1,
  courseId: 1,
  classId: 5,
  code: "P01",
  title: "Uvod",
  subtitle: "Predavanje 1",
  chips: [],
  questionCount: 20,
  createdAt: "2026-01-01T12:00:00.000Z",
  ...over,
});

describe("PipelineStages quiz rows", () => {
  it("lists the lesson before the quiz, whatever their ids", () => {
    const { container } = render(
      <PipelineStages
        jobs={[quizJob({ id: 9 }), lessonDone({ id: 3 })]}
        progress={new Map()}
        now={NOW}
      />,
    );
    const labels = [...container.querySelectorAll("strong")].map((el) => el.textContent);
    expect(labels).toEqual(["Objedinjene beleške", "Kviz"]);
  });

  it.each([
    [{ stage: "quiz-planner", cycle: null }, "Planiranje"],
    [{ stage: "quiz-builder", cycle: null }, "Izrada"],
    [{ stage: "quiz-reviewer", cycle: 1 }, "Provera (krug 1)"],
    [{ stage: "quiz-builder", cycle: 2 }, "Ispravke (krug 2)"],
    [{ stage: "quiz-reviewer", cycle: 2 }, "Provera (krug 2)"],
  ])("shows the step of a running quiz job: %o", (over, text) => {
    render(<PipelineStages jobs={[quizJob(over), lessonDone()]} progress={new Map()} now={NOW} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("shows no step on the lesson row", () => {
    render(<PipelineStages jobs={[job()]} progress={new Map()} now={NOW} />);
    expect(screen.queryByText("Planiranje")).not.toBeInTheDocument();
  });

  it("shows the error of a failed quiz job and starts it again on click", async () => {
    const onStartQuiz = vi.fn();
    render(
      <PipelineStages
        jobs={[quizJob({ ...FAILED, error: "Kviz nije prošao proveru" }), lessonDone()]}
        progress={new Map()}
        now={NOW}
        onStartQuiz={onStartQuiz}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Kviz nije prošao proveru");
    await userEvent.click(screen.getByRole("button", { name: "Napravi kviz ispočetka" }));
    expect(onStartQuiz).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Pokušaj ponovo" })).not.toBeInTheDocument();
  });

  it("shows the start error under the button", () => {
    render(
      <PipelineStages
        jobs={[quizJob({ ...FAILED, error: "x" }), lessonDone()]}
        progress={new Map()}
        now={NOW}
        onStartQuiz={vi.fn()}
        startQuizError="Kviz se već pravi"
      />,
    );
    expect(screen.getByText("Kviz se već pravi")).toBeInTheDocument();
  });

  it("offers no quiz button without a handler", () => {
    render(
      <PipelineStages
        jobs={[quizJob({ ...FAILED, error: "x" }), lessonDone()]}
        progress={new Map()}
        now={NOW}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers to start a quiz when the lesson is done and there never was a quiz job", async () => {
    const onStartQuiz = vi.fn();
    render(
      <PipelineStages
        jobs={[lessonDone()]}
        progress={new Map()}
        now={NOW}
        onStartQuiz={onStartQuiz}
      />,
    );
    expect(screen.getByText("Kviz")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Napravi kviz" }));
    expect(onStartQuiz).toHaveBeenCalledOnce();
  });

  it("does not offer a quiz while the lesson is not done", () => {
    render(<PipelineStages jobs={[job()]} progress={new Map()} now={NOW} onStartQuiz={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the code and size of the released quiz on a succeeded job", () => {
    render(
      <PipelineStages
        jobs={[
          quizJob({ status: "succeeded", finishedAt: "2026-01-01T10:02:00.000Z" }),
          lessonDone(),
        ]}
        progress={new Map()}
        now={NOW}
        releasedQuiz={quizSummary()}
        onStartQuiz={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Završeno")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "P01 · 20 pitanja" })).toHaveAttribute(
      "href",
      "/kvizovi/1",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

const gradingJob = (over: Parameters<typeof job>[0] = {}) =>
  job({
    id: 4,
    kind: "grading",
    stage: "grader",
    submissionId: 9,
    status: "succeeded",
    finishedAt: "2026-01-01T10:02:00.000Z",
    ...over,
  });
const TARGET = { quizId: 1, code: "P01", submittedAt: new Date(2026, 0, 3, 14, 5).toISOString() };

describe("PipelineStages grading rows", () => {
  it("labels a grading job with the quiz code and submission date, linked to the submission", () => {
    render(
      <PipelineStages
        jobs={[gradingJob()]}
        progress={new Map()}
        now={NOW}
        gradingTargets={new Map([[9, TARGET]])}
      />,
    );
    expect(screen.getByText("Ocenjivanje")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "P01 · 3. 1. 2026. 14:05" })).toHaveAttribute(
      "href",
      "/kvizovi/1/predaje/9",
    );
  });

  it("lists one row per graded submission", () => {
    render(
      <PipelineStages
        jobs={[gradingJob({ id: 6, submissionId: 10 }), gradingJob()]}
        progress={new Map()}
        now={NOW}
        gradingTargets={
          new Map([
            [9, TARGET],
            [10, { ...TARGET, quizId: 2, code: "P02" }],
          ])
        }
      />,
    );
    expect(screen.getAllByText("Ocenjivanje")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /^P02/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^P01/ })).toBeInTheDocument();
  });

  it("offers 'Oceni ponovo' on a failed grading job", async () => {
    const onGrade = vi.fn();
    render(
      <PipelineStages
        jobs={[gradingJob({ ...FAILED, error: "Model nije odgovorio" })]}
        progress={new Map()}
        now={NOW}
        gradingTargets={new Map([[9, TARGET]])}
        onGrade={onGrade}
        gradeError={{ submissionId: 9, message: "Ocenjivanje već traje." }}
      />,
    );
    expect(screen.getByText("Model nije odgovorio")).toBeInTheDocument();
    expect(screen.getByText("Ocenjivanje već traje.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Oceni ponovo" }));
    expect(onGrade).toHaveBeenCalledWith(9);
  });

  it("offers no regrade on a running or succeeded grading job", () => {
    render(
      <PipelineStages jobs={[gradingJob()]} progress={new Map()} now={NOW} onGrade={vi.fn()} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("PipelinePanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  function renderPanel(classStatus: "ready" | "generating" = "ready") {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <PipelinePanel classId={5} courseId={1} classStatus={classStatus} />
      </QueryClientProvider>,
    );
  }

  it("posts to the regenerate endpoint from the failed quiz row", async () => {
    const { requests } = mockApi({
      "GET /api/classes/5/jobs": () => ({
        jobs: [quizJob({ ...FAILED, error: "Kviz nije prošao proveru" }), lessonDone()],
      }),
      "POST /api/classes/5/quiz/regenerate": () => quizJob({ id: 3, attempt: 2 }),
    });
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Napravi kviz ispočetka" }));
    await waitFor(() =>
      expect(requests).toContainEqual(
        expect.objectContaining({ method: "POST", path: "/api/classes/5/quiz/regenerate" }),
      ),
    );
  });

  it("shows the server message when the regeneration is refused", async () => {
    mockApi({
      "GET /api/classes/5/jobs": () => ({ jobs: [lessonDone()] }),
      "POST /api/classes/5/quiz/regenerate": () =>
        apiError(409, "conflict", "The quiz is already generating"),
    });
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Napravi kviz" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The quiz is already generating");
  });

  it("offers 'Napravi kviz' for a ready class without a quiz job", async () => {
    mockApi({ "GET /api/classes/5/jobs": () => ({ jobs: [lessonDone()] }) });
    renderPanel();
    expect(await screen.findByRole("button", { name: "Napravi kviz" })).toBeInTheDocument();
  });

  it("offers no quiz button while the class is not ready", async () => {
    mockApi({ "GET /api/classes/5/jobs": () => ({ jobs: [job({ ...FAILED, error: "x" })] }) });
    renderPanel("ready");
    await screen.findByText("Neuspešno");
    expect(screen.queryByRole("button", { name: /kviz/i })).not.toBeInTheDocument();
  });

  it("shows code and question count of the released quiz of this class only", async () => {
    mockApi({
      "GET /api/classes/5/jobs": () => ({
        jobs: [
          quizJob({ status: "succeeded", finishedAt: "2026-01-01T10:02:00.000Z" }),
          lessonDone(),
        ],
      }),
      "GET /api/courses/1/quizzes": () => [
        quizSummary({ id: 2, classId: 6, code: "P02", questionCount: 8 }),
        quizSummary(),
      ],
    });
    renderPanel();
    expect(await screen.findByRole("link", { name: "P01 · 20 pitanja" })).toHaveAttribute(
      "href",
      "/kvizovi/1",
    );
    expect(screen.queryByText(/P02/)).not.toBeInTheDocument();
  });

  it("labels a grading job from its submission and regrades from the failed row", async () => {
    const { requests } = mockApi({
      "GET /api/classes/5/jobs": () => ({
        jobs: [gradingJob({ ...FAILED, error: "Greška" }), lessonDone()],
      }),
      "GET /api/submissions/9": () => ({ id: 9, quizId: 1, submittedAt: TARGET.submittedAt }),
      "GET /api/courses/1/quizzes": () => [quizSummary()],
      "POST /api/submissions/9/grade": () => gradingJob({ id: 7 }),
    });
    renderPanel();
    expect(await screen.findByRole("link", { name: "P01 · 3. 1. 2026. 14:05" })).toHaveAttribute(
      "href",
      "/kvizovi/1/predaje/9",
    );
    await userEvent.click(screen.getByRole("button", { name: "Oceni ponovo" }));
    await waitFor(() =>
      expect(requests).toContainEqual(
        expect.objectContaining({ method: "POST", path: "/api/submissions/9/grade" }),
      ),
    );
  });

  it("keeps the event stream open while a quiz job runs on a ready class", async () => {
    const sources: string[] = [];
    class Stub {
      constructor(url: string) {
        sources.push(url);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", Stub);
    mockApi({
      "GET /api/classes/5/jobs": () => ({
        jobs: [quizJob({ stage: "quiz-reviewer", cycle: 2 }), lessonDone()],
      }),
    });
    renderPanel("ready");
    expect(await screen.findByText("Provera (krug 2)")).toBeInTheDocument();
    expect(sources).toEqual(["/api/classes/5/events"]);
  });

  it("labels viz rows with the topic and keeps the stream open while one runs", async () => {
    const sources: string[] = [];
    class Stub {
      constructor(url: string) {
        sources.push(url);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", Stub);
    mockApi({
      "GET /api/classes/5/jobs": () => ({
        jobs: [
          job({ id: 6, kind: "viz", stage: "viz-builder", cycle: null, suggestionId: 1 }),
          job({ id: 5, kind: "viz", stage: "viz-planner", suggestionId: 2 }),
          job({ id: 4, kind: "viz_topics", stage: "viz-identifier", status: "succeeded" }),
          lessonDone(),
        ],
      }),
      "GET /api/classes/5/viz-suggestions": () => [
        { ...vizSuggestionFixture({ id: 1, concept: "Sharding" }), selected: true },
        { ...vizSuggestionFixture({ id: 2, concept: "Replikacija" }), selected: true },
      ],
    });
    renderPanel("ready");
    expect(await screen.findByText("Vizualizacija: Sharding")).toBeInTheDocument();
    expect(screen.getByText("Vizualizacija: Replikacija")).toBeInTheDocument();
    expect(screen.getByText("Predlozi vizualizacija")).toBeInTheDocument();
    expect(sources).toEqual(["/api/classes/5/events"]);
  });
});

describe("PipelineStages cumulative rows", () => {
  const kJob = (over: Parameters<typeof job>[0] = {}) =>
    quizJob({ id: 5, quizCode: "K1", ...over });
  const labelsOf = (container: HTMLElement) =>
    [...container.querySelectorAll("strong")].map((el) => el.textContent);

  it("shows a K job as its own row, apart from the class's own quiz", () => {
    const { container } = render(
      <PipelineStages
        jobs={[kJob(), quizJob({ id: 4, ...FAILED, error: "lekcija" }), lessonDone({ id: 1 })]}
        progress={new Map()}
        now={NOW}
        onStartQuiz={vi.fn()}
      />,
    );
    expect(labelsOf(container)).toEqual(["Objedinjene beleške", "Kviz", "Kumulativni test K1"]);
    expect(container.querySelectorAll("details")).toHaveLength(0);
  });

  it("offers the class's first quiz even when only a K job exists", () => {
    render(
      <PipelineStages
        jobs={[kJob(), lessonDone({ id: 1 })]}
        progress={new Map()}
        now={NOW}
        onStartQuiz={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Napravi kviz" })).toBeInTheDocument();
  });

  it("ignores a failed K job for the lesson quiz button", () => {
    const onStartQuiz = vi.fn();
    render(
      <PipelineStages
        jobs={[
          kJob({ ...FAILED, error: "K greška" }),
          quizJob({ id: 4, status: "succeeded", finishedAt: "2026-01-01T10:00:55.000Z" }),
          lessonDone({ id: 1 }),
        ]}
        progress={new Map()}
        now={NOW}
        onStartQuiz={onStartQuiz}
      />,
    );
    expect(screen.queryByRole("button", { name: "Napravi kviz ispočetka" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Napravi kviz" })).toBeNull();
  });

  it("rebuilds a failed K job with its code", async () => {
    const onStartQuiz = vi.fn();
    const onRebuildCumulative = vi.fn();
    render(
      <PipelineStages
        jobs={[
          kJob({ ...FAILED, error: "K greška" }),
          quizJob({ id: 4, status: "succeeded", finishedAt: "2026-01-01T10:00:55.000Z" }),
          lessonDone({ id: 1 }),
        ]}
        progress={new Map()}
        now={NOW}
        onStartQuiz={onStartQuiz}
        onRebuildCumulative={onRebuildCumulative}
        rebuildCumulativeError={{ code: "K1", message: "K1 već postoji." }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Napravi ispočetka" }));
    expect(onRebuildCumulative).toHaveBeenCalledWith("K1");
    expect(onStartQuiz).not.toHaveBeenCalled();
    expect(screen.getByText("K1 već postoji.")).toBeInTheDocument();
  });

  it("links a succeeded K job to its released quiz", () => {
    render(
      <PipelineStages
        jobs={[kJob({ status: "succeeded", finishedAt: "2026-01-01T10:00:55.000Z" })]}
        progress={new Map()}
        now={NOW}
        releasedQuiz={quizSummary({ id: 1, code: "P01", classId: 5 })}
        cumulativeQuizzes={[quizSummary({ id: 9, code: "K1", classId: null })]}
      />,
    );
    expect(screen.getByRole("link", { name: /^K1/ })).toHaveAttribute("href", "/kvizovi/9");
  });
});

describe("PipelineStages viz rows", () => {
  const vizJob = (over: Parameters<typeof job>[0] = {}) =>
    job({ id: 5, kind: "viz", stage: "viz-planner", suggestionId: 1, ...over });
  const labels = (container: HTMLElement) =>
    [...container.querySelectorAll("strong")].map((el) => el.textContent);

  it("renders one row per suggestion, after the topics row", () => {
    const { container } = render(
      <PipelineStages
        jobs={[
          vizJob({ id: 9, suggestionId: 2, stage: "viz-builder", cycle: 1 }),
          vizJob({ id: 8, suggestionId: 1 }),
          job({ id: 7, kind: "viz_topics", stage: "viz-identifier", status: "succeeded" }),
          lessonDone({ id: 3 }),
        ]}
        progress={new Map()}
        now={NOW}
        vizConcepts={
          new Map([
            [1, "Sharding"],
            [2, "Replikacija"],
          ])
        }
      />,
    );
    expect(labels(container)).toEqual([
      "Objedinjene beleške",
      "Predlozi vizualizacija",
      "Vizualizacija: Sharding",
      "Vizualizacija: Replikacija",
    ]);
    expect(screen.getByText("Planiranje")).toBeInTheDocument();
    expect(screen.getByText("Ispravke (krug 1)")).toBeInTheDocument();
  });

  it("falls back to a plain label while the topic name is unknown", () => {
    const { container } = render(
      <PipelineStages jobs={[vizJob()]} progress={new Map()} now={NOW} />,
    );
    expect(labels(container)).toEqual(["Vizualizacija"]);
  });

  it("keeps retries of one suggestion as earlier attempts of its row", () => {
    const { container } = render(
      <PipelineStages
        jobs={[
          vizJob({ id: 12, suggestionId: 1, attempt: 2 }),
          vizJob({ id: 11, suggestionId: 1, ...FAILED, error: "prva greška" }),
          vizJob({ id: 10, suggestionId: 2, ...FAILED, error: "druga greška" }),
        ]}
        progress={new Map()}
        now={NOW}
        vizConcepts={
          new Map([
            [1, "Sharding"],
            [2, "Replikacija"],
          ])
        }
      />,
    );
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(screen.getByText("prva greška")).toBeInTheDocument();
    expect(screen.getByText("druga greška")).toBeInTheDocument();
    expect(screen.getAllByText(/Vizualizacija: Sharding/)).toHaveLength(2);
  });
});
