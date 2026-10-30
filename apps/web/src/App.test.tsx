import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function mockHealth(ok: boolean) {
  const fetchMock = vi.fn(async () =>
    ok
      ? new Response(JSON.stringify({ status: "ok", db: "ok" }), { status: 200 })
      : Promise.reject(new TypeError("network down")),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("home page", () => {
  it("renders the empty state", async () => {
    mockHealth(true);
    renderAt("/");
    expect(screen.getByRole("heading", { name: "Kursevi" })).toBeInTheDocument();
    expect(screen.getByText("Još nema kurseva.")).toBeInTheDocument();
    expect(screen.getByText("Studdy Buddy")).toBeInTheDocument();
    await screen.findByText("Server: povezan");
  });

  it("shows povezan when the health call succeeds", async () => {
    const fetchMock = mockHealth(true);
    renderAt("/");
    expect(await screen.findByText("Server: povezan")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.anything());
  });

  it("shows nedostupan when the health call fails", async () => {
    mockHealth(false);
    renderAt("/");
    expect(await screen.findByText("Server: nedostupan")).toBeInTheDocument();
  });

  it("shows nedostupan on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    renderAt("/");
    expect(await screen.findByText("Server: nedostupan")).toBeInTheDocument();
  });
});

describe("not found page", () => {
  it("renders for unknown routes with a link home", async () => {
    mockHealth(true);
    renderAt("/nema-ovoga");
    expect(screen.getByRole("heading", { name: "Stranica ne postoji" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /početnu/ })).toHaveAttribute("href", "/");
  });
});

describe("theme toggle", () => {
  const root = document.documentElement;

  it("cycles system -> light -> dark -> system and sets data-theme", async () => {
    mockHealth(true);
    const user = userEvent.setup();
    renderAt("/");
    const button = screen.getByRole("button", { name: /Tema/ });
    expect(root).not.toHaveAttribute("data-theme");

    await user.click(button);
    expect(root).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("studdy-theme")).toBe("light");

    await user.click(button);
    expect(root).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("studdy-theme")).toBe("dark");

    await user.click(button);
    expect(root).not.toHaveAttribute("data-theme");
    expect(localStorage.getItem("studdy-theme")).toBeNull();
    await waitFor(() => expect(screen.getByText("Server: povezan")).toBeInTheDocument());
  });

  it("still works when localStorage throws", async () => {
    mockHealth(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const user = userEvent.setup();
    renderAt("/");
    const button = screen.getByRole("button", { name: /Tema/ });

    await user.click(button);
    expect(root).toHaveAttribute("data-theme", "light");
    await user.click(button);
    expect(root).toHaveAttribute("data-theme", "dark");
    await user.click(button);
    expect(root).not.toHaveAttribute("data-theme");
    await screen.findByText("Server: povezan");
  });
});
