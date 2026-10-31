import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, job, mockApi } from "../test/utils";
import { CumulativeButton } from "./CumulativeButton";

function setup(code: string | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (c: string | undefined) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CumulativeButton courseId={1} code={c} label="Napravi" />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(ui(code));
  return { rerender: (c: string | undefined) => view.rerender(ui(c)) };
}

afterEach(() => vi.unstubAllGlobals());

describe("CumulativeButton", () => {
  it("posts, shows the success note with a link, and re-enables once the code changes", async () => {
    const { requests } = mockApi({
      "POST /api/courses/1/cumulative": () => job({ classId: 7 }),
    });
    const user = userEvent.setup();
    const { rerender } = setup("K1");

    await user.click(screen.getByRole("button", { name: "Napravi" }));
    const link = await screen.findByRole("link", { name: /Prati tok/ });
    expect(link).toHaveAttribute("href", "/predavanja/7");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body as string)).toEqual({ code: "K1" });
    // Not stuck disabled after success.
    expect(screen.getByRole("button", { name: "Napravi" })).toBeEnabled();

    rerender("K2");
    await waitFor(() => expect(screen.queryByRole("link")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Napravi" }));
    await screen.findByRole("link", { name: /Prati tok/ });
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1]!.body as string)).toEqual({ code: "K2" });
  });

  it("is disabled while the request is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockApi({
      "POST /api/courses/1/cumulative": async () => {
        await gate;
        return job();
      },
    });
    const user = userEvent.setup();
    setup(undefined);

    await user.click(screen.getByRole("button", { name: "Napravi" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Napravi" })).toBeDisabled());
    release();
    await screen.findByRole("link", { name: /Prati tok/ });
    expect(screen.getByRole("button", { name: "Napravi" })).toBeEnabled();
  });

  it("shows a 409 refusal inline", async () => {
    mockApi({
      "POST /api/courses/1/cumulative": () => apiError(409, "conflict", "Test je već u toku."),
    });
    const user = userEvent.setup();
    setup("K1");

    await user.click(screen.getByRole("button", { name: "Napravi" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Test je već u toku.");
    expect(screen.getByRole("button", { name: "Napravi" })).toBeEnabled();
  });
});
