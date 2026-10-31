import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { GenerationJob, VisualizationSummary, VizSuggestion } from "@studdy/shared";
import {
  apiError,
  classDetail,
  job,
  json,
  mockApi,
  renderAt,
  visualizationFixture,
  vizSuggestionFixture,
} from "../test/utils";

const topicsJob = (over: Partial<GenerationJob> = {}) =>
  job({
    id: 2,
    kind: "viz_topics",
    stage: "viz-identifier",
    status: "succeeded",
    finishedAt: "2026-01-01T10:06:00.000Z",
    ...over,
  });
const vizJob = (over: Partial<GenerationJob> = {}) =>
  job({ id: 3, kind: "viz", stage: "viz-planner", suggestionId: 1, ...over });

function setup(
  data: {
    jobs?: GenerationJob[];
    suggestions?: VizSuggestion[];
    visualizations?: VisualizationSummary[];
  },
  extra: Parameters<typeof mockApi>[0] = {},
) {
  return mockApi({
    "GET /api/classes/5": () => classDetail({ status: "ready" }),
    "GET /api/classes/5/jobs": () => ({ jobs: data.jobs ?? [] }),
    "GET /api/classes/5/viz-suggestions": () => data.suggestions ?? [],
    "GET /api/classes/5/visualizations": () => data.visualizations ?? [],
    ...extra,
  });
}

async function section() {
  return within(await screen.findByRole("region", { name: "Vizualizacije" }));
}

describe("VizSection (class page)", () => {
  it("is not shown before the class is ready", async () => {
    mockApi({ "GET /api/classes/5": () => classDetail({ status: "draft" }) });
    renderAt("/predavanja/5");
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("region", { name: "Vizualizacije" })).not.toBeInTheDocument();
  });

  it("shows progress while the topics are being identified", async () => {
    setup({ jobs: [topicsJob({ status: "running", finishedAt: null })] });
    renderAt("/predavanja/5");
    const view = await section();
    expect(await view.findByText("Tražim teme za vizualizacije…")).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Predloži teme" })).not.toBeInTheDocument();
  });

  it("shows the error of a failed identification and offers to retry", async () => {
    const { requests } = setup(
      { jobs: [topicsJob({ status: "failed", error: "Model je odustao" })] },
      { "POST /api/classes/5/viz-topics/regenerate": () => json(job({ id: 4 }), 202) },
    );
    renderAt("/predavanja/5");
    const view = await section();
    expect(await view.findByRole("alert")).toHaveTextContent("Model je odustao");
    await userEvent.click(view.getByRole("button", { name: "Predloži teme" }));
    await waitFor(() =>
      expect(requests.some((r) => r.path === "/api/classes/5/viz-topics/regenerate")).toBe(true),
    );
  });

  it("offers to suggest topics when none were ever requested", async () => {
    setup({});
    renderAt("/predavanja/5");
    const view = await section();
    expect(await view.findByRole("button", { name: "Predloži teme" })).toBeInTheDocument();
  });

  it("says there are no suggestions after a succeeded job and still offers own topics", async () => {
    setup({ jobs: [topicsJob()] });
    renderAt("/predavanja/5");
    const view = await section();
    expect(
      await view.findByText("Za ovu lekciju nema predloga za vizualizacije."),
    ).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "Dodaj svoju temu" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Dodaj temu" })).toBeInTheDocument();
  });

  it("selects suggestions and builds only the checked ones", async () => {
    const { requests } = setup(
      {
        jobs: [topicsJob()],
        suggestions: [
          vizSuggestionFixture({ id: 1, concept: "Sharding" }),
          vizSuggestionFixture({ id: 2, concept: "Replikacija", controls: [], scenarios: [] }),
          vizSuggestionFixture({ id: 3, concept: "CAP teorema", origin: "user" }),
        ],
      },
      {
        "POST /api/classes/5/viz-suggestions/select": () => [
          vizSuggestionFixture({ id: 1, selected: true }),
        ],
      },
    );
    renderAt("/predavanja/5");
    const view = await section();

    const build = await view.findByRole("button", { name: "Napravi izabrane" });
    expect(build).toBeDisabled();
    expect(view.getAllByRole("checkbox")).toHaveLength(3);
    expect(view.getByText("tvoja tema")).toBeInTheDocument();
    expect(view.getAllByText("2.1 Particionisanje")).toHaveLength(3);
    // Controls and scenarios are inside collapsed details; the misconception is never shown.
    expect(view.getAllByText("Kontrole i scenariji")).toHaveLength(2);
    expect(view.queryByText(/Shard je kopija/)).not.toBeInTheDocument();
    expect(requests.some((r) => r.method === "POST")).toBe(false);

    await userEvent.click(view.getByRole("checkbox", { name: /Sharding/ }));
    await userEvent.click(view.getByRole("checkbox", { name: /CAP teorema/ }));
    expect(build).toBeEnabled();
    await userEvent.click(build);

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    const post = requests.find((r) => r.path === "/api/classes/5/viz-suggestions/select")!;
    expect(JSON.parse(String(post.body))).toEqual({ ids: [1, 3] });
  });

  it("shows the build status instead of a checkbox for selected suggestions", async () => {
    setup({
      jobs: [
        topicsJob(),
        vizJob({ id: 10, suggestionId: 1, stage: "viz-planner" }),
        vizJob({ id: 11, suggestionId: 2, stage: "viz-builder", cycle: 1 }),
        vizJob({ id: 12, suggestionId: 3, stage: "viz-reviewer", cycle: 2 }),
        vizJob({ id: 13, suggestionId: 4, stage: "viz-builder", cycle: null }),
      ],
      suggestions: [
        vizSuggestionFixture({ id: 1, concept: "Prva", selected: true }),
        vizSuggestionFixture({ id: 2, concept: "Druga", selected: true }),
        vizSuggestionFixture({ id: 3, concept: "Treća", selected: true }),
        vizSuggestionFixture({ id: 4, concept: "Četvrta", selected: true }),
        vizSuggestionFixture({ id: 5, concept: "Peta", selected: true }),
      ],
    });
    renderAt("/predavanja/5");
    const view = await section();
    expect(await view.findByText("Planiranje")).toBeInTheDocument();
    expect(view.getByText("Ispravke (krug 1)")).toBeInTheDocument();
    expect(view.getByText("Provera (krug 2)")).toBeInTheDocument();
    expect(view.getByText("Izrada")).toBeInTheDocument();
    expect(view.getByText("Čeka na početak…")).toBeInTheDocument();
    expect(view.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Napravi izabrane" })).not.toBeInTheDocument();
  });

  it("links a finished visualization", async () => {
    setup({
      jobs: [topicsJob(), vizJob({ status: "succeeded", finishedAt: "2026-01-01T11:00:00.000Z" })],
      suggestions: [vizSuggestionFixture({ id: 1, selected: true })],
      visualizations: [visualizationFixture({ id: 7, suggestionId: 1 })],
    });
    renderAt("/predavanja/5");
    const view = await section();
    expect(await view.findByText("Gotovo")).toBeInTheDocument();
    expect(view.getByRole("link", { name: "Sharding pod lupom" })).toHaveAttribute(
      "href",
      "/vizualizacije/7",
    );
  });

  it("shows a failed build with its error and rebuilds from scratch", async () => {
    const { requests } = setup(
      {
        jobs: [
          topicsJob(),
          vizJob({ status: "failed", error: "Provera nije prošla", suggestionId: 1 }),
        ],
        suggestions: [vizSuggestionFixture({ id: 1, selected: true })],
      },
      { "POST /api/viz-suggestions/1/regenerate": () => json(vizJob({ id: 20 }), 202) },
    );
    renderAt("/predavanja/5");
    const view = await section();
    expect(await view.findByText("Provera nije prošla")).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: "Napravi ispočetka" }));
    await waitFor(() =>
      expect(requests.some((r) => r.path === "/api/viz-suggestions/1/regenerate")).toBe(true),
    );
  });

  it("shows a server error when building cannot start", async () => {
    setup(
      { jobs: [topicsJob()], suggestions: [vizSuggestionFixture({ id: 1 })] },
      {
        "POST /api/classes/5/viz-suggestions/select": () =>
          apiError(409, "conflict", "Already selected: 1"),
      },
    );
    renderAt("/predavanja/5");
    const view = await section();
    await userEvent.click(await view.findByRole("checkbox"));
    await userEvent.click(view.getByRole("button", { name: "Napravi izabrane" }));
    expect(await view.findByRole("alert")).toHaveTextContent("Already selected: 1");
  });

  it("adds a topic of the student's own", async () => {
    const { requests } = setup(
      { jobs: [topicsJob()] },
      {
        "POST /api/classes/5/viz-suggestions": () =>
          json(vizSuggestionFixture({ id: 9, concept: "CAP", origin: "user" }), 201),
      },
    );
    renderAt("/predavanja/5");
    const view = await section();
    const add = await view.findByRole("button", { name: "Dodaj temu" });
    expect(add).toBeDisabled();
    await userEvent.type(view.getByRole("textbox", { name: /Pojam/ }), "  CAP teorema ");
    await userEvent.type(view.getByRole("textbox", { name: /Napomena/ }), "Particija mreže");
    await userEvent.click(add);
    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    const post = requests.find(
      (r) => r.path === "/api/classes/5/viz-suggestions" && r.method === "POST",
    )!;
    expect(JSON.parse(String(post.body))).toEqual({
      concept: "CAP teorema",
      note: "Particija mreže",
    });
    await waitFor(() => expect(view.getByRole("textbox", { name: /Pojam/ })).toHaveValue(""));
  });

  it("sends a missing note as null", async () => {
    const { requests } = setup(
      { jobs: [topicsJob()] },
      { "POST /api/classes/5/viz-suggestions": () => json(vizSuggestionFixture(), 201) },
    );
    renderAt("/predavanja/5");
    const view = await section();
    await userEvent.type(await view.findByRole("textbox", { name: /Pojam/ }), "Tema");
    await userEvent.click(view.getByRole("button", { name: "Dodaj temu" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    const post = requests.find((r) => r.method === "POST")!;
    expect(JSON.parse(String(post.body))).toEqual({ concept: "Tema", note: null });
  });
});
