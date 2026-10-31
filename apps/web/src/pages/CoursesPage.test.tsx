import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { apiError, course, mockApi, renderAt } from "../test/utils";

describe("CoursesPage", () => {
  it("shows the empty state with a Novi kurs button", async () => {
    mockApi({ "GET /api/courses": () => [] });
    renderAt("/");
    expect(await screen.findByText("Još nema kurseva.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Novi kurs" })).toBeInTheDocument();
  });

  it("lists courses with class count and persona", async () => {
    mockApi({
      "GET /api/courses": () => [
        course({ id: 1, name: "ASVSP", classCount: 3, persona: "iskusni data inženjer" }),
        course({ id: 2, name: "Baze", classCount: 1 }),
      ],
    });
    renderAt("/");
    const link = await screen.findByRole("link", { name: "ASVSP" });
    expect(link).toHaveAttribute("href", "/kursevi/1");
    expect(screen.getByText("3 predavanja")).toBeInTheDocument();
    expect(screen.getByText("1 predavanje")).toBeInTheDocument();
    expect(screen.getByText("iskusni data inženjer")).toBeInTheDocument();
  });

  it("creates a course and shows it in the list", async () => {
    const courses = [] as ReturnType<typeof course>[];
    const { requests } = mockApi({
      "GET /api/courses": () => courses,
      "POST /api/courses": (req) => {
        const body = JSON.parse(String(req.body)) as { name: string };
        const created = course({ id: 7, name: body.name });
        courses.push(created);
        return new Response(JSON.stringify(created), { status: 201 });
      },
    });
    const user = userEvent.setup();
    renderAt("/");
    await user.click(await screen.findByRole("button", { name: "Novi kurs" }));
    const dialog = screen.getByRole("dialog", { name: "Novi kurs" });
    await user.type(within(dialog).getByLabelText(/^Naziv/), "  ASVSP  ");
    await user.type(within(dialog).getByLabelText(/^Uloga tutora/), "data inženjer");
    await user.type(within(dialog).getByLabelText(/^Kumulativni test/), "4");
    await user.click(within(dialog).getByRole("button", { name: "Napravi kurs" }));

    expect(await screen.findByRole("link", { name: "ASVSP" })).toBeInTheDocument();
    const post = requests.find((r) => r.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({
      name: "ASVSP",
      persona: "data inženjer",
      assessmentFormat: null,
      reviewCadence: 4,
    });
    expect(post?.headers.get("Content-Type")).toBe("application/json");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows a validation message for an empty name and does not post", async () => {
    const { requests } = mockApi({ "GET /api/courses": () => [] });
    const user = userEvent.setup();
    renderAt("/");
    await user.click(await screen.findByRole("button", { name: "Novi kurs" }));
    await user.click(screen.getByRole("button", { name: "Napravi kurs" }));
    expect(await screen.findByText("Naziv je obavezan.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Naziv/)).toHaveAttribute("aria-invalid", "true");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("rejects a cadence outside 1-50", async () => {
    mockApi({ "GET /api/courses": () => [] });
    const user = userEvent.setup();
    renderAt("/");
    await user.click(await screen.findByRole("button", { name: "Novi kurs" }));
    await user.type(screen.getByLabelText(/^Naziv/), "X");
    await user.type(screen.getByLabelText(/^Kumulativni test/), "60");
    await user.click(screen.getByRole("button", { name: "Napravi kurs" }));
    expect(await screen.findByText("Unesite ceo broj od 1 do 50.")).toBeInTheDocument();
  });

  it("shows server validation errors", async () => {
    mockApi({
      "GET /api/courses": () => [],
      "POST /api/courses": () =>
        apiError(400, "validation", "Invalid request body", [
          { code: "too_big", origin: "string", maximum: 1000, path: ["persona"] },
        ]),
    });
    const user = userEvent.setup();
    renderAt("/");
    await user.click(await screen.findByRole("button", { name: "Novi kurs" }));
    await user.type(screen.getByLabelText(/^Naziv/), "X");
    await user.click(screen.getByRole("button", { name: "Napravi kurs" }));
    expect(
      await screen.findByText("Uloga tutora može imati najviše 1000 karaktera."),
    ).toBeInTheDocument();
  });
});
