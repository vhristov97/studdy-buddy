import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LessonMarkdown } from "./LessonMarkdown";

const P_TITLE = "Napomena predavača (iz beleški)";
const D_TITLE = "Dodatak tutora";

describe("LessonMarkdown tags", () => {
  it("turns a leading (P) or (D) of a list item into a tag", () => {
    render(<LessonMarkdown source={"- (P) Prva stavka\n- (D) Druga stavka\n- Treća stavka"} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByTitle(P_TITLE)).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("PNapomena predavača (iz beleški) Prva stavka");
    expect(within(items[1]!).getByTitle(D_TITLE)).toBeInTheDocument();
    expect(items[1]).not.toHaveTextContent("(D)");
    expect(within(items[2]!).queryByTitle(P_TITLE)).not.toBeInTheDocument();
  });

  it("tags a paragraph and a loose list item", () => {
    const { container } = render(
      <LessonMarkdown source={"(D) Dodatak u pasusu.\n\n- (P) Labava\n\n- Druga\n"} />,
    );
    expect(container.querySelectorAll("p > span[title]")).toHaveLength(2);
    expect(screen.getByText("Dodatak u pasusu.", { exact: false })).toBeInTheDocument();
    expect(screen.getByTitle(P_TITLE)).toBeInTheDocument();
  });

  it("tags nested list items", () => {
    render(<LessonMarkdown source={"- Gore\n  - (P) Dole"} />);
    expect(screen.getByTitle(P_TITLE)).toBeInTheDocument();
  });

  it("leaves a (P) in the middle of a sentence as text", () => {
    render(<LessonMarkdown source={"- Rekao je (P) nešto\n\nTekst (D) kraj"} />);
    expect(screen.queryByTitle(P_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByTitle(D_TITLE)).not.toBeInTheDocument();
    expect(screen.getByText("Rekao je (P) nešto")).toBeInTheDocument();
    expect(screen.getByText("Tekst (D) kraj")).toBeInTheDocument();
  });
});

describe("LessonMarkdown callouts", () => {
  it.each([
    ["⚠️ Ispravka:", "correction"],
    ["⚠ Ispravka:", "correction"],
    ["❓ Pitanje:", "question"],
    ["⏳ Odloženo:", "deferred"],
  ])("renders '%s' as a note with a bold marker", (marker, kind) => {
    render(<LessonMarkdown source={`> ${marker} nešto važno`} />);
    const note = screen.getByRole("note");
    expect(note.tagName).toBe("BLOCKQUOTE");
    expect(note.className).toContain(kind);
    const bold = within(note).getByText(/(Ispravka|Pitanje|Odloženo):$/);
    expect(bold.tagName).toBe("STRONG");
    expect(note).toHaveTextContent("nešto važno");
  });

  it("does not treat an ordinary quote as a callout", () => {
    render(<LessonMarkdown source={"> Običan citat"} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.getByText("Običan citat")).toBeInTheDocument();
  });

  it("keeps a marker that is already bold", () => {
    render(<LessonMarkdown source={"> **⚠️ Ispravka:** tekst"} />);
    expect(screen.getByRole("note").className).toContain("correction");
  });
});

describe("LessonMarkdown safety", () => {
  it("does not render raw HTML and opens links in a new tab", () => {
    const { container } = render(
      <LessonMarkdown
        source={"<script>alert(1)</script>\n\n<b>podebljano</b>\n\n[x](https://a.b)"}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("link", { name: "x" })).toHaveAttribute("target", "_blank");
  });
});
