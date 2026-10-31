import type { Blockquote, Paragraph, Parent, PhrasingContent, Root, Strong } from "mdast";

/** Source tags a lesson item can start with. No tag means "from the slides". */
export const SOURCE_TAGS = {
  P: "Napomena predavača (iz beleški)",
  D: "Dodatak tutora",
} as const;
export type SourceTag = keyof typeof SOURCE_TAGS;

export type CalloutKind = "correction" | "question" | "deferred";

/**
 * Callout markers at the start of a blockquote. The emoji may carry the U+FE0F variation selector
 * or not; the writer is not consistent about it.
 */
const CALLOUTS: { kind: CalloutKind; pattern: RegExp }[] = [
  { kind: "correction", pattern: /^⚠️?\s*Ispravka:/ },
  { kind: "question", pattern: /^❓️?\s*Pitanje:/ },
  { kind: "deferred", pattern: /^⏳️?\s*Odloženo:/ },
];

const TAG_PATTERN = /^\((P|D)\)\s*/;

/** The `data-*` attributes that mark custom nodes; `LessonMarkdown` maps them to components. */
export const TAG_ATTR = "data-lesson-tag";
export const CALLOUT_ATTR = "data-lesson-callout";

/** The first child of a paragraph, when it is plain text. */
function firstText(paragraph: Paragraph) {
  const first = paragraph.children[0];
  return first?.type === "text" ? first : undefined;
}

/** `(P) rest` at the start of a paragraph becomes a tag node followed by `rest`. */
function tagParagraph(paragraph: Paragraph): void {
  const text = firstText(paragraph);
  const match = text && TAG_PATTERN.exec(text.value);
  if (!text || !match) return;
  const tag = match[1] as SourceTag;
  // A `strong` node rendered as a <span>, so the tree stays valid mdast for other plugins.
  const node: Strong = {
    type: "strong",
    data: {
      hName: "span",
      hProperties: { [TAG_ATTR]: tag },
    },
    children: [{ type: "text", value: tag }],
  };
  const rest = text.value.slice(match[0].length);
  const replacement: PhrasingContent[] = rest
    ? [node, { type: "text", value: ` ${rest}` }]
    : [node];
  paragraph.children.splice(0, 1, ...replacement);
}

/**
 * Marks a callout blockquote and bolds its marker word. The marker may already sit inside bold
 * text (`**⚠️ Ispravka:**`), in which case it is left as it is.
 */
function markCallout(quote: Blockquote): void {
  const paragraph = quote.children[0];
  if (paragraph?.type !== "paragraph") return;
  const first = paragraph.children[0];
  const lead = first?.type === "strong" ? first.children[0] : first;
  if (lead?.type !== "text") return;
  const callout = CALLOUTS.find(({ pattern }) => pattern.test(lead.value));
  if (!callout) return;
  quote.data = { ...quote.data, hProperties: { [CALLOUT_ATTR]: callout.kind } };
  if (first === lead) {
    const marker = /^[^:]+:/.exec(lead.value)?.[0] ?? "";
    paragraph.children.splice(
      0,
      1,
      { type: "strong", children: [{ type: "text", value: marker }] },
      { type: "text", value: lead.value.slice(marker.length) },
    );
  }
}

function walk(node: Parent): void {
  for (const child of node.children) {
    if (child.type === "paragraph") tagParagraph(child);
    else if (child.type === "blockquote") markCallout(child);
    if ("children" in child) walk(child as Parent);
  }
}

/**
 * Remark plugin for the lesson's conventions: a leading `(P)`/`(D)` in a paragraph (also inside
 * list items) becomes a tag node, and `⚠️ Ispravka:` / `❓ Pitanje:` / `⏳ Odloženo:` blockquotes
 * are marked as callouts. A `(P)` anywhere but the very start stays text.
 */
export function remarkLesson() {
  return (tree: Root): void => walk(tree);
}
