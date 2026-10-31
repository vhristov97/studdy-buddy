import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { materialDetail, mockApi, renderAt } from "../test/utils";

const noteDetail = (extractedText: string | null = "tekst") =>
  materialDetail({
    id: 11,
    kind: "note",
    mime: "text/markdown",
    originalName: "predavanje.md",
    pageCount: null,
    extractedText,
  });

function markdownRoutes(markdown: string, extractedText: string | null = markdown) {
  return {
    "GET /api/materials/11": () => noteDetail(extractedText),
    "GET /api/materials/11/file": () =>
      new Response(markdown, { headers: { "Content-Type": "text/markdown" } }),
  };
}

describe("MaterialPage", () => {
  it("shows a PDF in an iframe pointing at the file", async () => {
    mockApi({ "GET /api/materials/10": () => materialDetail() });
    renderAt("/materijali/10");
    expect(await screen.findByRole("heading", { level: 1, name: "uvod.pdf" })).toBeInTheDocument();
    const frame = screen.getByTitle("PDF: uvod.pdf");
    expect(frame).toHaveAttribute("src", "/api/materials/10/file");
    expect(frame).not.toHaveAttribute("sandbox");
    expect(screen.getByRole("link", { name: /Nazad na predavanje/ })).toHaveAttribute(
      "href",
      "/predavanja/5",
    );
  });

  it("sandboxes HTML with an empty sandbox attribute", async () => {
    mockApi({
      "GET /api/materials/12": () =>
        materialDetail({ id: 12, mime: "text/html", originalName: "s.html", pageCount: null }),
    });
    renderAt("/materijali/12");
    const frame = await screen.findByTitle("HTML: s.html");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("src", "/api/materials/12/file");
  });

  it("renders Markdown notes with GFM", async () => {
    mockApi(markdownRoutes("# Naslov\n\n~~stari~~ novi\n\n- [x] gotovo\n"));
    const { container } = renderAt("/materijali/11");
    expect(await screen.findByRole("heading", { level: 1, name: "Naslov" })).toBeInTheDocument();
    expect(container.querySelector("del")?.textContent).toBe("stari");
    expect(container.querySelector("input[type=checkbox]")).toBeChecked();
  });

  it("does not render raw HTML from Markdown", async () => {
    mockApi(markdownRoutes("Zdravo\n\n<script>window.hacked = 1</script>\n\n<b>podebljano</b>\n"));
    const { container } = renderAt("/materijali/11");
    await screen.findByText("Zdravo");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("opens Markdown links in a new tab with rel=noreferrer", async () => {
    mockApi(markdownRoutes("[sajt](https://example.com)"));
    renderAt("/materijali/11");
    const link = await screen.findByRole("link", { name: "sajt" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("toggles the extracted text, rendering markers as dividers", async () => {
    const text =
      "--- strana 1 ---\n\n## Uvod\n\n- tačka\n  - ugnježdena\n\n--- strana 2 ---\n\nDruga strana\n";
    mockApi({
      "GET /api/materials/10": () => materialDetail({ extractedText: text }),
    });
    const user = userEvent.setup();
    renderAt("/materijali/10");
    const toggle = await screen.findByRole("button", { name: "Prikaži izdvojeni tekst" });
    expect(screen.queryByText("Uvod")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByRole("heading", { level: 2, name: "Uvod" })).toBeInTheDocument();
    expect(screen.getByText("ugnježdena")).toBeInTheDocument();
    const markers = screen.getAllByRole("separator");
    expect(markers.map((m) => m.textContent)).toEqual(["strana 1", "strana 2"]);
    expect(screen.queryByText(/--- strana/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sakrij izdvojeni tekst" }));
    expect(screen.queryByText("Uvod")).not.toBeInTheDocument();
  });

  it("shows the error instead of text when extraction failed", async () => {
    mockApi({
      "GET /api/materials/10": () =>
        materialDetail({
          extractionStatus: "failed",
          extractionError: "Invalid PDF structure",
          extractedText: null,
        }),
    });
    const user = userEvent.setup();
    renderAt("/materijali/10");
    await user.click(await screen.findByRole("button", { name: "Prikaži izdvojeni tekst" }));
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/Invalid PDF structure/)).toBeInTheDocument();
  });

  it("shows a friendly message for an unknown material", async () => {
    mockApi({});
    renderAt("/materijali/99");
    expect(await screen.findByRole("heading", { name: "Ne postoji" })).toBeInTheDocument();
  });
});
