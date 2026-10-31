import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  apiError,
  classDetail,
  lessonView,
  mockApi,
  renderAt,
  topic,
  topicEvent,
  visualizationFixture,
} from "../test/utils";

const BODY = [
  "## Osnove",
  "",
  "- (P) Predavač je naglasio rok.",
  "- (D) Dodatno objašnjenje.",
  "- Iz slajdova.",
  "",
  "> ⚠️ Ispravka: u beleškama piše pogrešno.",
].join("\n");

describe("LessonPage", () => {
  it("renders breadcrumbs, the lesson and the tracking table", async () => {
    mockApi({
      "GET /api/classes/5": () => classDetail({ status: "ready" }),
      "GET /api/classes/5/lesson": () =>
        lessonView({
          bodyMd: BODY,
          topics: [
            topic({
              name: "Rokovi",
              rating: "✓",
              events: [topicEvent({ source: "quiz", ref: "P01" })],
            }),
          ],
        }),
    });
    renderAt("/predavanja/5/lekcija");
    expect(await screen.findByRole("heading", { level: 1, name: "01 — Uvod" })).toBeInTheDocument();

    const crumbs = screen.getByRole("navigation", { name: "Putanja" });
    expect(within(crumbs).getByRole("link", { name: "ASVSP" })).toHaveAttribute(
      "href",
      "/kursevi/1",
    );
    expect(within(crumbs).getByRole("link", { name: "01 — Uvod" })).toHaveAttribute(
      "href",
      "/predavanja/5",
    );
    expect(within(crumbs).getByText("Objedinjene beleške")).toHaveAttribute("aria-current", "page");

    const lesson = await screen.findByRole("article", { name: "Objedinjene beleške" });
    expect(within(lesson).getByRole("heading", { level: 2, name: "Osnove" })).toBeInTheDocument();
    expect(within(lesson).getByText(/Predavač je naglasio rok/)).toBeInTheDocument();
    expect(within(lesson).getByRole("note")).toHaveTextContent("u beleškama piše pogrešno");

    const tracking = screen.getByRole("region", { name: "Praćenje znanja" });
    expect(within(tracking).getByText("Rokovi")).toBeInTheDocument();
    expect(within(tracking).getByText("P01")).toBeInTheDocument();
    expect(within(tracking).getByText("Dobro")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Legenda" })).toBeInTheDocument();
  });

  it("shows an empty state with a link back when there is no lesson", async () => {
    mockApi({
      "GET /api/classes/5": () => classDetail(),
      "GET /api/classes/5/lesson": () => apiError(404, "not_found", "Lesson not found"),
    });
    renderAt("/predavanja/5/lekcija");
    expect(await screen.findByText("Objedinjene beleške još nisu generisane.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Nazad na predavanje" })).toHaveAttribute(
      "href",
      "/predavanja/5",
    );
    expect(screen.queryByRole("region", { name: "Praćenje znanja" })).not.toBeInTheDocument();
  });

  it("shows a friendly message for an unknown class", async () => {
    mockApi({});
    renderAt("/predavanja/99/lekcija");
    expect(await screen.findByRole("heading", { name: "Ne postoji" })).toBeInTheDocument();
  });

  it("links the visualizations of the class near the top", async () => {
    mockApi({
      "GET /api/classes/5": () => classDetail({ status: "ready" }),
      "GET /api/classes/5/lesson": () => lessonView(),
      "GET /api/classes/5/jobs": () => ({ jobs: [] }),
      "GET /api/classes/5/viz-suggestions": () => [],
      "GET /api/classes/5/visualizations": () => [
        visualizationFixture({ id: 7, title: "Sharding pod lupom" }),
        visualizationFixture({ id: 8, title: "Replikacija na delu" }),
      ],
    });
    renderAt("/predavanja/5/lekcija");
    const box = await screen.findByRole("region", { name: "Vizualizacije za ovu lekciju" });
    expect(within(box).getByRole("link", { name: "Sharding pod lupom" })).toHaveAttribute(
      "href",
      "/vizualizacije/7",
    );
    expect(within(box).getByRole("link", { name: "Replikacija na delu" })).toHaveAttribute(
      "href",
      "/vizualizacije/8",
    );
    // The compact selection section is there too, without the form for own topics.
    expect(screen.getByRole("region", { name: "Vizualizacije" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dodaj temu" })).not.toBeInTheDocument();
    // The box comes before the lesson.
    const lesson = await screen.findByRole("article", { name: "Objedinjene beleške" });
    expect(box.compareDocumentPosition(lesson) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no visualizations box when there are none", async () => {
    mockApi({
      "GET /api/classes/5": () => classDetail({ status: "ready" }),
      "GET /api/classes/5/lesson": () => lessonView(),
      "GET /api/classes/5/jobs": () => ({ jobs: [] }),
      "GET /api/classes/5/viz-suggestions": () => [],
      "GET /api/classes/5/visualizations": () => [],
    });
    renderAt("/predavanja/5/lekcija");
    await screen.findByRole("article", { name: "Objedinjene beleške" });
    expect(
      screen.queryByRole("region", { name: "Vizualizacije za ovu lekciju" }),
    ).not.toBeInTheDocument();
  });
});
