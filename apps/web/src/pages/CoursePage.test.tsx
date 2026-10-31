import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ClassSummary } from "@studdy/shared";
import {
  apiError,
  course,
  courseDetail,
  courseVisualization,
  mockApi,
  renderAt,
} from "../test/utils";

const summary = (
  id: number,
  number: number,
  title: string,
  status: ClassSummary["status"],
  materialCount = 0,
  noteCount = 0,
): ClassSummary => ({
  id,
  courseId: 1,
  number,
  title,
  status,
  materialCount,
  noteCount,
  createdAt: "x",
});

const classes = [
  summary(5, 1, "Uvod", "ready", 1, 1),
  summary(6, 2, "Kontejneri", "draft", 3, 0),
  summary(7, 3, "Orkestracija", "generating", 0, 5),
  summary(8, 4, "Neuspelo", "failed"),
];

function courseRoutes() {
  return {
    "GET /api/courses/1": () =>
      courseDetail({ persona: "iskusni data inženjer", reviewCadence: 4, classes, classCount: 4 }),
  };
}

describe("CoursePage", () => {
  it("shows the course, breadcrumb and classes with status badges", async () => {
    mockApi(courseRoutes());
    renderAt("/kursevi/1");
    expect(await screen.findByRole("heading", { level: 1, name: "ASVSP" })).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Putanja" });
    expect(within(crumbs).getByRole("link", { name: "Kursevi" })).toHaveAttribute("href", "/");
    expect(screen.getByText("iskusni data inženjer")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "01 — Uvod" });
    expect(link).toHaveAttribute("href", "/predavanja/5");
    const items = screen
      .getAllByRole("listitem")
      .filter((li) => li.querySelector("a[href^='/predavanja']"));
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("01 — Uvod"),
      expect.stringContaining("02 — Kontejneri"),
      expect.stringContaining("03 — Orkestracija"),
      expect.stringContaining("04 — Neuspelo"),
    ]);
    expect(screen.getByText("Spremno")).toBeInTheDocument();
    expect(screen.getByText("Nacrt")).toBeInTheDocument();
    expect(screen.getByText("Generiše se")).toBeInTheDocument();
    expect(screen.getByText("Greška")).toBeInTheDocument();
    expect(screen.getByText("1 materijal · 1 beleška")).toBeInTheDocument();
    expect(screen.getByText("3 materijala · 0 beležaka")).toBeInTheDocument();
    expect(screen.getByText("0 materijala · 5 beležaka")).toBeInTheDocument();
    expect(screen.getByText("na svaka 4 predavanja")).toBeInTheDocument();
  });

  it("adds a class, suggesting the next number", async () => {
    const created = summary(9, 5, "Novo", "draft");
    const { requests } = mockApi({
      ...courseRoutes(),
      "POST /api/courses/1/classes": () => new Response(JSON.stringify(created), { status: 201 }),
    });
    const user = userEvent.setup();
    renderAt("/kursevi/1");
    await screen.findByRole("link", { name: "01 — Uvod" });
    expect(screen.getByLabelText(/^Broj/)).toHaveAttribute("placeholder", "5");
    await user.type(screen.getByLabelText(/^Naslov/), "Novo");
    await user.click(screen.getByRole("button", { name: "Dodaj predavanje" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    const post = requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/api/courses/1/classes");
    expect(JSON.parse(String(post?.body))).toEqual({ title: "Novo" });
    await waitFor(() => expect(screen.getByLabelText(/^Naslov/)).toHaveValue(""));
  });

  it("requires a title", async () => {
    mockApi(courseRoutes());
    const user = userEvent.setup();
    renderAt("/kursevi/1");
    await screen.findByRole("link", { name: "01 — Uvod" });
    await user.click(screen.getByRole("button", { name: "Dodaj predavanje" }));
    expect(await screen.findByText("Naslov je obavezan.")).toBeInTheDocument();
  });

  it("shows a 409 conflict inline", async () => {
    mockApi({
      ...courseRoutes(),
      "POST /api/courses/1/classes": () =>
        apiError(409, "conflict", "A class with number 2 already exists in this course"),
    });
    const user = userEvent.setup();
    renderAt("/kursevi/1");
    await screen.findByRole("link", { name: "01 — Uvod" });
    await user.type(screen.getByLabelText(/^Naslov/), "Drugo");
    await user.type(screen.getByLabelText(/^Broj/), "2");
    await user.click(screen.getByRole("button", { name: "Dodaj predavanje" }));
    expect(await screen.findByText("Predavanje sa brojem 2 već postoji.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Naslov/)).toHaveValue("Drugo");
  });

  it("edits the course with a prefilled PATCH form", async () => {
    const { requests } = mockApi({
      ...courseRoutes(),
      "PATCH /api/courses/1": () => course({ name: "ASVSP 2" }),
    });
    const user = userEvent.setup();
    renderAt("/kursevi/1");
    await user.click(await screen.findByRole("button", { name: "Izmeni kurs" }));
    const dialog = screen.getByRole("dialog", { name: "Izmeni kurs" });
    const name = within(dialog).getByLabelText(/^Naziv/);
    expect(name).toHaveValue("ASVSP");
    expect(within(dialog).getByLabelText(/^Kumulativni test/)).toHaveValue(4);
    await user.clear(name);
    await user.type(name, "ASVSP 2");
    await user.click(within(dialog).getByRole("button", { name: "Sačuvaj" }));
    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(requests.find((r) => r.method === "PATCH")?.body))).toMatchObject({
      name: "ASVSP 2",
      persona: "iskusni data inženjer",
      reviewCadence: 4,
    });
  });

  it("confirms before deleting the course, naming it", async () => {
    const { requests } = mockApi({
      ...courseRoutes(),
      "DELETE /api/courses/1": () => undefined,
      "GET /api/courses": () => [],
    });
    const user = userEvent.setup();
    renderAt("/kursevi/1");
    await user.click(await screen.findByRole("button", { name: "Obriši kurs" }));
    const dialog = screen.getByRole("dialog", { name: "Obriši kurs" });
    expect(within(dialog).getByText("ASVSP")).toBeInTheDocument();
    expect(within(dialog).getByText(/predavanja i materijali/)).toBeInTheDocument();
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Obriši kurs" }));
    expect(await screen.findByRole("heading", { name: "Kursevi" })).toBeInTheDocument();
    expect(requests.some((r) => r.method === "DELETE")).toBe(true);
  });

  it("shows a friendly message for an unknown course", async () => {
    mockApi({});
    renderAt("/kursevi/99");
    expect(await screen.findByRole("heading", { name: "Ne postoji" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /kurseve/ })).toHaveAttribute("href", "/");
  });

  it("lists the quiz library newest first, and an empty state without quizzes", async () => {
    const quiz = (id: number, code: string, over = {}) => ({
      id,
      courseId: 1,
      classId: 5,
      code,
      title: `Kviz ${code}`,
      subtitle: "Predavanje 1",
      chips: [],
      questionCount: 20,
      createdAt: "2026-03-05T12:00:00.000Z",
      ...over,
    });
    mockApi({
      ...courseRoutes(),
      "GET /api/courses/1/quizzes": () => [
        quiz(2, "P02", { chips: ["Ponavljanje", "Teže"], questionCount: 8 }),
        quiz(1, "P01"),
      ],
    });
    renderAt("/kursevi/1");
    expect(await screen.findByRole("heading", { level: 2, name: "Kvizovi" })).toBeInTheDocument();
    const items = (await screen.findAllByText(/^Kviz P0\d$/)).map((el) => el.closest("li")!);
    expect(items.map((li) => within(li).getByText(/^P0\d$/).textContent)).toEqual(["P02", "P01"]);
    expect(within(items[0]!).getByText("Ponavljanje")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Teže")).toBeInTheDocument();
    expect(within(items[0]!).getByText("8 pitanja · 5. 3. 2026.")).toBeInTheDocument();
    expect(within(items[1]!).getByText("20 pitanja · 5. 3. 2026.")).toBeInTheDocument();
    expect(within(items[0]!).getByRole("link", { name: /P02/ })).toHaveAttribute(
      "href",
      "/kvizovi/2",
    );
    expect(within(items[1]!).getByRole("link", { name: /P01/ })).toHaveAttribute(
      "href",
      "/kvizovi/1",
    );
  });

  it("shows an empty state when the course has no quizzes", async () => {
    mockApi({ ...courseRoutes(), "GET /api/courses/1/quizzes": () => [] });
    renderAt("/kursevi/1");
    expect(
      await screen.findByText(
        "Još nema kvizova. Kviz se pravi automatski posle objedinjenih beleški.",
      ),
    ).toBeInTheDocument();
  });

  it("lists the visualizations of all classes with a link", async () => {
    mockApi({
      ...courseRoutes(),
      "GET /api/courses/1/visualizations": () => [
        courseVisualization({
          id: 7,
          title: "Sharding pod lupom",
          classNumber: 1,
          className: "Uvod",
        }),
        courseVisualization({
          id: 8,
          title: "Kontejner iznutra",
          classNumber: 2,
          className: "Kontejneri",
        }),
      ],
    });
    renderAt("/kursevi/1");
    expect(
      await screen.findByRole("heading", { level: 2, name: "Vizualizacije" }),
    ).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: "Sharding pod lupom" });
    expect(link).toHaveAttribute("href", "/vizualizacije/7");
    expect(link.closest("li")).toHaveTextContent("01 — Uvod");
    expect(screen.getByRole("link", { name: "Kontejner iznutra" })).toHaveAttribute(
      "href",
      "/vizualizacije/8",
    );
  });

  it("explains when the course has no visualizations yet", async () => {
    mockApi({ ...courseRoutes(), "GET /api/courses/1/visualizations": () => [] });
    renderAt("/kursevi/1");
    expect(await screen.findByText(/Još nema vizualizacija/)).toBeInTheDocument();
  });

  describe("cumulative review", () => {
    const status = (over = {}) => ({
      cadence: 4,
      readyClassCount: 4,
      due: null,
      existing: [],
      ...over,
    });

    it("shows a due review with a button that posts the request", async () => {
      const { requests } = mockApi({
        ...courseRoutes(),
        "GET /api/courses/1/quizzes": () => [],
        "GET /api/courses/1/cumulative": () =>
          status({ due: { code: "K1", coversThrough: 4, classNumbers: [1, 2, 3, 4] } }),
        "POST /api/courses/1/cumulative": () => ({ id: 2, classId: 8 }),
      });
      renderAt("/kursevi/1");
      expect(await screen.findByText("K1 je na redu")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Napravi K1" }));
      await waitFor(() =>
        expect(
          requests.some((r) => r.method === "POST" && r.path === "/api/courses/1/cumulative"),
        ).toBe(true),
      );
    });

    it("shows nothing when no review is due", async () => {
      mockApi({ ...courseRoutes(), "GET /api/courses/1/cumulative": () => status() });
      renderAt("/kursevi/1");
      await screen.findByRole("heading", { level: 2, name: "Kvizovi" });
      await waitFor(() => expect(screen.queryByText(/je na redu/)).toBeNull());
      expect(screen.queryByRole("button", { name: /Napravi/ })).toBeNull();
    });

    it("offers a manual review without a cadence", async () => {
      mockApi({
        ...courseRoutes(),
        "GET /api/courses/1/cumulative": () => status({ cadence: null }),
      });
      renderAt("/kursevi/1");
      expect(await screen.findByRole("button", { name: "Napravi kumulativni test" })).toBeVisible();
    });
  });

  it("lists a cumulative quiz without a class, marked as cumulative", async () => {
    mockApi({
      ...courseRoutes(),
      "GET /api/courses/1/quizzes": () => [
        {
          id: 3,
          courseId: 1,
          classId: null,
          code: "K1",
          title: "Kumulativni pregled 1",
          subtitle: "Predavanja 1–4",
          chips: [],
          questionCount: 30,
          createdAt: "2026-03-05T12:00:00.000Z",
        },
      ],
    });
    renderAt("/kursevi/1");
    const item = (await screen.findByRole("link", { name: /K1/ })).closest("li")!;
    expect(item).toHaveAttribute("class", expect.stringContaining("quizItem"));
    expect(within(item).getByText("kumulativni")).toBeVisible();
    expect(within(item).getByRole("link", { name: /K1/ })).toHaveAttribute("href", "/kvizovi/3");
    expect(within(item).getByText("30 pitanja · 5. 3. 2026.")).toBeInTheDocument();
  });
});
