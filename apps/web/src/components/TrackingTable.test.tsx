import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { topic, topicEvent } from "../test/utils";
import { TrackingTable } from "./TrackingTable";

function rowOf(name: string) {
  return screen.getByRole("row", { name: new RegExp(`^${name}\\b`) });
}

describe("TrackingTable", () => {
  it("has the four columns and orders rows by position", () => {
    render(
      <TrackingTable
        topics={[
          topic({ id: 2, name: "Drugo", position: 1 }),
          topic({ id: 1, name: "Prvo", position: 0 }),
        ]}
      />,
    );
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Tema",
      "Ocena",
      "Testirano",
      "Napomene",
    ]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Prvo");
    expect(rows[1]).toHaveTextContent("Drugo");
  });

  it("labels every rating", () => {
    render(
      <TrackingTable
        topics={[
          topic({ id: 1, name: "A", position: 0, rating: "?" }),
          topic({ id: 2, name: "B", position: 1, rating: "✗" }),
          topic({ id: 3, name: "C", position: 2, rating: "~" }),
          topic({ id: 4, name: "D", position: 3, rating: "✓" }),
        ]}
      />,
    );
    expect(within(rowOf("A")).getByText("Nije testirano")).toBeInTheDocument();
    expect(within(rowOf("B")).getByText("Slabo")).toBeInTheDocument();
    expect(within(rowOf("C")).getByText("Delimično")).toBeInTheDocument();
    expect(within(rowOf("D")).getByText("Dobro")).toBeInTheDocument();
    expect(within(rowOf("D")).getByTitle("Dobro")).toHaveTextContent("✓");
  });

  it("lists unique quiz refs in order, or a dash", () => {
    render(
      <TrackingTable
        topics={[
          topic({
            id: 1,
            name: "Testirana",
            events: [
              topicEvent({ id: 1, source: "quiz", ref: "P01" }),
              topicEvent({ id: 2, source: "grading", ref: "P01" }),
              topicEvent({ id: 3, source: "quiz", ref: "P02" }),
              topicEvent({ id: 4, source: "quiz", ref: "P01" }),
            ],
          }),
          topic({ id: 2, name: "Netestirana", position: 1 }),
        ]}
      />,
    );
    expect(within(rowOf("Testirana")).getByText("P01, P02")).toBeInTheDocument();
    expect(within(rowOf("Netestirana")).getAllByText("—")).toHaveLength(2);
  });

  it("shows misconceptions from the notes and from later events", () => {
    render(
      <TrackingTable
        topics={[
          topic({
            events: [
              topicEvent({
                id: 1,
                source: "notes",
                outcome: "misconception",
                misconceptionText: "Veliki podaci su samo količina",
                correctionText: "Bitne su i brzina i raznovrsnost",
              }),
              topicEvent({ id: 2, source: "notes", outcome: "ok" }),
              topicEvent({
                id: 3,
                source: "quiz",
                ref: "P01",
                misconceptionText: "Pomešao pojmove",
              }),
            ],
          }),
        ]}
      />,
    );
    expect(
      screen.getByText(
        "Zabluda iz beleški: Veliki podaci su samo količina → Bitne su i brzina i raznovrsnost",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Zabluda (P01): Pomešao pojmove")).toBeInTheDocument();
  });

  it("marks a deferred topic with a badge and its note", () => {
    render(
      <TrackingTable
        topics={[topic({ deferred: true, deferredNote: "Obrađuje se na 4. predavanju" })]}
      />,
    );
    expect(screen.getByText("Odloženo")).toBeInTheDocument();
    expect(screen.getByText("Obrađuje se na 4. predavanju")).toBeInTheDocument();
  });

  it("marks empty Testirano and Napomene cells so phone cards can hide them", () => {
    render(
      <TrackingTable
        topics={[
          topic({ id: 1, name: "Prazna", position: 0 }),
          topic({
            id: 2,
            name: "Puna",
            position: 1,
            events: [
              topicEvent({ id: 1, source: "quiz", ref: "P01" }),
              topicEvent({ id: 2, outcome: "misconception", misconceptionText: "Greška" }),
            ],
          }),
        ]}
      />,
    );
    const empty = rowOf("Prazna");
    expect(within(empty).getAllByRole("cell")[1]).toHaveAttribute("data-empty");
    expect(within(empty).getAllByRole("cell")[2]).toHaveAttribute("data-empty");
    const full = rowOf("Puna");
    expect(within(full).getAllByRole("cell")[1]).not.toHaveAttribute("data-empty");
    expect(within(full).getAllByRole("cell")[2]).not.toHaveAttribute("data-empty");
    // The rating label stays in the markup either way.
    expect(within(empty).getByText("Nije testirano")).toBeInTheDocument();
  });
});
