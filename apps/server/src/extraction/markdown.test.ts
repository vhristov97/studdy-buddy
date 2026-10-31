import { describe, expect, it } from "vitest";
import { extractMarkdown } from "./markdown.js";
import { extractText } from "./index.js";

const BOM = String.fromCharCode(0xfeff);

describe("extractMarkdown", () => {
  it("normalizes line endings and strips a UTF-8 BOM", () => {
    const { text, pageCount } = extractMarkdown(
      Buffer.from(`${BOM}# Naslov\r\n\r\nred\rkraj\n`, "utf8"),
    );
    expect(text).toBe("# Naslov\n\nred\nkraj\n");
    expect(pageCount).toBeNull();
  });

  it("keeps strikethrough and everything else as written", () => {
    const source = "- ~~prekrižano~~ ostaje\n- **bold** `kod` čćšžđ\n";
    expect(extractMarkdown(Buffer.from(source, "utf8")).text).toBe(source);
  });
});

describe("extractText", () => {
  it("dispatches on the mime type", async () => {
    expect((await extractText("note", "text/markdown", Buffer.from("~~a~~"))).text).toBe("~~a~~");
    expect((await extractText("material", "text/html", Buffer.from("<p>x</p>"))).text).toBe("x");
  });

  it("throws for an unsupported mime type", async () => {
    await expect(extractText("material", "image/png", Buffer.from("x"))).rejects.toThrow(
      /no text extractor/i,
    );
  });
});
