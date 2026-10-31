import domino from "@mixmark-io/domino";
import TurndownService from "turndown";
import type { ExtractedText } from "./types.js";

const STRIPPED_TAGS = ["script", "style", "noscript", "iframe", "svg", "nav", "footer"];

/** Converts an HTML page to Markdown. Never touches the network. */
export function extractHtml(buffer: Buffer): ExtractedText {
  const document = domino.createDocument(buffer.toString("utf8"));
  for (const element of document.querySelectorAll(STRIPPED_TAGS.join(","))) element.remove();

  const root = document.querySelector("main") ?? document.querySelector("article") ?? document.body;
  const html = root?.innerHTML ?? "";

  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  // Turndown's default pads list markers to four columns ("-   item"); use "- item".
  turndown.addRule("compactListItem", {
    filter: "li",
    replacement: (content, node) => {
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/g, "\n  ");
      const parent = node.parentNode as HTMLElement | null;
      let prefix = "- ";
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? 1) || 1;
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start + index}. `;
      }
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "");
    },
  });
  const markdown = turndown.turndown(html);
  return { text: markdown.replace(/\n{3,}/g, "\n\n").trim(), pageCount: null };
}
