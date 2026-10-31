import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { job } from "../test/utils";
import { PipelineStages } from "./PipelinePanel";

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
