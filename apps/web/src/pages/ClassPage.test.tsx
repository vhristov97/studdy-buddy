import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ClassDetail } from "@studdy/shared";
import { apiError, classDetail, material, mockApi, renderAt, type Handler } from "../test/utils";

const note = material({
  id: 11,
  kind: "note",
  mime: "text/markdown",
  originalName: "predavanje.md",
  sizeBytes: 2048,
  pageCount: null,
});
const html = material({
  id: 12,
  mime: "text/html",
  originalName: "slajdovi.html",
  sizeBytes: 900,
  pageCount: null,
});

function classRoute(detail: () => ClassDetail): Record<string, Handler> {
  return { "GET /api/classes/5": detail };
}

describe("ClassPage", () => {
  it("sorts items into Materijali and Beleške and shows their details", async () => {
    mockApi(classRoute(() => classDetail({ materials: [material(), html, note] })));
    renderAt("/predavanja/5");
    expect(await screen.findByRole("heading", { level: 1, name: "01 — Uvod" })).toBeInTheDocument();
    expect(screen.getByText("Nacrt")).toBeInTheDocument();

    const materials = screen.getByRole("region", { name: "Materijali" });
    expect(within(materials).getByText("uvod.pdf")).toBeInTheDocument();
    expect(within(materials).getByText("PDF · 1,5 MB · 12 strana")).toBeInTheDocument();
    expect(within(materials).getByText("slajdovi.html")).toBeInTheDocument();
    expect(within(materials).queryByText("predavanje.md")).not.toBeInTheDocument();

    const notes = screen.getByRole("region", { name: "Beleške" });
    expect(within(notes).getByText("predavanje.md")).toBeInTheDocument();
    expect(within(notes).getByText("Markdown · 2,0 KB")).toBeInTheDocument();
    expect(
      within(notes).getByText("Beleške nisu obavezne, ali poboljšavaju objedinjene beleške."),
    ).toBeInTheDocument();

    expect(within(materials).getByRole("link", { name: "Otvori uvod.pdf" })).toHaveAttribute(
      "href",
      "/materijali/10",
    );
    const crumbs = screen.getByRole("navigation", { name: "Putanja" });
    expect(within(crumbs).getByRole("link", { name: "ASVSP" })).toHaveAttribute(
      "href",
      "/kursevi/1",
    );
  });

  it("uploads picked files, one request each, and shows the results", async () => {
    let items = [] as ClassDetail["materials"];
    const { requests } = mockApi({
      ...classRoute(() => classDetail({ materials: items })),
      "POST /api/classes/5/materials": () => {
        items = [material()];
        return new Response(JSON.stringify([material()]), { status: 201 });
      },
    });
    const user = userEvent.setup();
    renderAt("/predavanja/5");
    await screen.findByRole("heading", { level: 1, name: "01 — Uvod" });
    const input = screen.getByLabelText("Fajlovi za otpremanje");
    expect(input).toHaveAttribute("accept", ".pdf,.html,.htm,.md,.markdown");
    await user.upload(input, new File(["%PDF-1.4"], "uvod.pdf", { type: "application/pdf" }));

    expect(await screen.findByText("Otpremljeno")).toBeInTheDocument();
    const post = requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/api/classes/5/materials");
    expect((post?.body as FormData).getAll("files")).toHaveLength(1);
    const materials = screen.getByRole("region", { name: "Materijali" });
    expect(await within(materials).findByText("uvod.pdf")).toBeInTheDocument();
  });

  it("shows the server's message when a file is rejected", async () => {
    mockApi({
      ...classRoute(() => classDetail()),
      "POST /api/classes/5/materials": () =>
        apiError(409, "conflict", "uvod.pdf is already in this class"),
    });
    const user = userEvent.setup();
    renderAt("/predavanja/5");
    await screen.findByRole("heading", { level: 1, name: "01 — Uvod" });
    await user.upload(
      screen.getByLabelText("Fajlovi za otpremanje"),
      new File(["%PDF-1.4"], "uvod.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findByText("uvod.pdf is already in this class")).toBeInTheDocument();
  });

  it("rejects .docx and files over 50 MB before uploading", async () => {
    const { requests } = mockApi(classRoute(() => classDetail()));
    const user = userEvent.setup({ applyAccept: false });
    renderAt("/predavanja/5");
    await screen.findByRole("heading", { level: 1, name: "01 — Uvod" });
    const big = new File(["x"], "veliki.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 50 * 1024 * 1024 + 1 });
    await user.upload(screen.getByLabelText("Fajlovi za otpremanje"), [
      new File(["x"], "izvestaj.docx"),
      big,
    ]);
    expect(await screen.findByText(/Nepodržan tip fajla/)).toBeInTheDocument();
    expect(screen.getByText("Fajl je veći od 50 MB.")).toBeInTheDocument();
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("shows failed extraction in red with the error message", async () => {
    mockApi(
      classRoute(() =>
        classDetail({
          materials: [
            material({
              extractionStatus: "failed",
              extractionError: "Invalid PDF structure",
              pageCount: null,
            }),
          ],
        }),
      ),
    );
    renderAt("/predavanja/5");
    expect(await screen.findByText("Izdvajanje teksta nije uspelo")).toBeInTheDocument();
    expect(screen.getByText(/Invalid PDF structure/)).toBeInTheDocument();
    expect(screen.getByText("Ukloni materijale čiji tekst nije izdvojen.")).toBeInTheDocument();
  });

  it("hides upload and delete when the class is not a draft", async () => {
    mockApi(classRoute(() => classDetail({ status: "ready", materials: [material()] })));
    renderAt("/predavanja/5");
    expect(
      await screen.findByText("Materijali se ne mogu menjati nakon generisanja."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Fajlovi za otpremanje")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Izaberi fajlove" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Obriši uvod\.pdf/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Otvori uvod.pdf" })).toBeInTheDocument();
  });

  it("confirms before deleting a file", async () => {
    let items = [material()];
    const { requests } = mockApi({
      ...classRoute(() => classDetail({ materials: items })),
      "DELETE /api/materials/10": () => {
        items = [];
        return undefined;
      },
    });
    const user = userEvent.setup();
    renderAt("/predavanja/5");
    await user.click(await screen.findByRole("button", { name: "Obriši uvod.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "Obriši fajl" });
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Obriši" }));
    await waitFor(() => expect(screen.queryByText("uvod.pdf")).not.toBeInTheDocument());
    expect(requests.some((r) => r.method === "DELETE")).toBe(true);
  });

  describe("Generiši button", () => {
    const generate = () => screen.findByRole("button", { name: "Generiši" });

    it("is disabled with no material", async () => {
      mockApi(classRoute(() => classDetail({ materials: [note] })));
      renderAt("/predavanja/5");
      expect(await generate()).toBeDisabled();
      expect(screen.getByText("Dodaj bar jedan PDF ili HTML materijal.")).toBeInTheDocument();
    });

    it("is disabled when extraction failed", async () => {
      mockApi(
        classRoute(() =>
          classDetail({
            materials: [material({ extractionStatus: "failed", extractionError: "x" })],
          }),
        ),
      );
      renderAt("/predavanja/5");
      expect(await generate()).toBeDisabled();
      expect(screen.getAllByText("Ukloni materijale čiji tekst nije izdvojen.")).toHaveLength(1);
    });

    it("is still disabled when ready, with the placeholder reason", async () => {
      mockApi(classRoute(() => classDetail({ materials: [material()] })));
      renderAt("/predavanja/5");
      expect(await generate()).toBeDisabled();
      expect(screen.getByText("Generisanje stiže u sledećoj verziji.")).toBeInTheDocument();
    });
  });

  it("renames the class and deletes it after confirming", async () => {
    const { requests } = mockApi({
      ...classRoute(() => classDetail()),
      "PATCH /api/classes/5": () => classDetail({ title: "Novi naslov" }),
      "DELETE /api/classes/5": () => undefined,
      "GET /api/courses/1": () => ({
        id: 1,
        name: "ASVSP",
        persona: null,
        assessmentFormat: null,
        reviewCadence: null,
        classCount: 0,
        createdAt: "x",
        classes: [],
      }),
    });
    const user = userEvent.setup();
    renderAt("/predavanja/5");
    await user.click(await screen.findByRole("button", { name: "Izmeni" }));
    const edit = screen.getByRole("dialog", { name: "Izmeni predavanje" });
    const title = within(edit).getByLabelText(/^Naslov/);
    expect(title).toHaveValue("Uvod");
    expect(within(edit).getByLabelText(/^Broj/)).toHaveValue(1);
    await user.clear(title);
    await user.type(title, "Novi naslov");
    await user.click(within(edit).getByRole("button", { name: "Sačuvaj" }));
    await waitFor(() => expect(requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(requests.find((r) => r.method === "PATCH")?.body))).toEqual({
      title: "Novi naslov",
      number: 1,
    });

    await user.click(screen.getByRole("button", { name: "Obriši predavanje" }));
    const confirm = await screen.findByRole("dialog", { name: "Obriši predavanje" });
    await user.click(within(confirm).getByRole("button", { name: "Obriši predavanje" }));
    expect(await screen.findByRole("heading", { level: 1, name: "ASVSP" })).toBeInTheDocument();
  });

  it("shows a friendly message for an unknown class", async () => {
    mockApi({});
    renderAt("/predavanja/99");
    expect(await screen.findByRole("heading", { name: "Ne postoji" })).toBeInTheDocument();
  });
});
