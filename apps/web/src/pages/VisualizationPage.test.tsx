import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiError, mockApi, renderAt, visualizationDetail } from "../test/utils";

describe("VisualizationPage", () => {
  it("embeds the page in a sandboxed iframe without allow-same-origin", async () => {
    mockApi({ "GET /api/visualizations/7": () => visualizationDetail() });
    renderAt("/vizualizacije/7");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sharding pod lupom" }),
    ).toBeInTheDocument();

    const frame = screen.getByTitle("Vizualizacija: Sharding pod lupom");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("src", "/viz/7");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toMatch(/allow-top-navigation|allow-popups/);

    expect(screen.getByText(/Shard je kopija podataka/)).toBeInTheDocument();
    const open = screen.getByRole("link", { name: "Otvori u novom prozoru" });
    expect(open).toHaveAttribute("href", "/viz/7");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open.getAttribute("rel")).toContain("noopener");
  });

  it("shows breadcrumbs through the course and class", async () => {
    mockApi({ "GET /api/visualizations/7": () => visualizationDetail() });
    renderAt("/vizualizacije/7");
    await screen.findByRole("heading", { level: 1 });
    const crumbs = screen.getByRole("navigation", { name: "Putanja" });
    expect(within(crumbs).getByRole("link", { name: "ASVSP" })).toHaveAttribute(
      "href",
      "/kursevi/1",
    );
    expect(within(crumbs).getByRole("link", { name: "01 — Uvod" })).toHaveAttribute(
      "href",
      "/predavanja/5",
    );
    expect(within(crumbs).getByText("Sharding pod lupom")).toHaveAttribute("aria-current", "page");
  });

  it("leaves out the misconception when there is none", async () => {
    mockApi({
      "GET /api/visualizations/7": () =>
        visualizationDetail({ misconception: null, concept: null }),
    });
    renderAt("/vizualizacije/7");
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/Ciljana zabluda/)).not.toBeInTheDocument();
  });

  it("shows a friendly message for an unknown visualization", async () => {
    mockApi({
      "GET /api/visualizations/9": () => apiError(404, "not_found", "Visualization not found"),
    });
    renderAt("/vizualizacije/9");
    expect(await screen.findByText("Ne postoji")).toBeInTheDocument();
    expect(screen.queryByTitle(/Vizualizacija/)).not.toBeInTheDocument();
  });
});
