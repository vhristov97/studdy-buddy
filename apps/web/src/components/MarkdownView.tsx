import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./MarkdownView.module.css";

// Raw HTML in the source is never rendered (no rehype-raw); links leave the app in a new tab.
const COMPONENTS: Components = {
  a: ({ href, children, title }) => (
    <a href={href} title={title} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

const PAGE_MARKER = /^--- strana (\d+) ---$/;

export function MarkdownView({ source }: { source: string }) {
  return (
    <div className={styles.markdown}>
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
}

interface Segment {
  page: number | null;
  text: string;
}

/** Splits extracted text at its `--- strana N ---` markers. */
export function splitPages(text: string): Segment[] {
  const segments: Segment[] = [{ page: null, text: "" }];
  for (const line of text.split("\n")) {
    const match = PAGE_MARKER.exec(line.trim());
    const current = segments[segments.length - 1];
    if (match) segments.push({ page: Number(match[1]), text: "" });
    else if (current) current.text += `${line}\n`;
  }
  return segments.filter((segment) => segment.page !== null || segment.text.trim() !== "");
}

/** Extracted text as Markdown, with the page markers shown as subtle labelled dividers. */
export function ExtractedTextView({ text }: { text: string }) {
  return (
    <div>
      {splitPages(text).map((segment, index) => (
        <div key={index}>
          {segment.page !== null && (
            <div className={styles.pageMarker} role="separator">
              <span>strana {segment.page}</span>
            </div>
          )}
          <MarkdownView source={segment.text} />
        </div>
      ))}
    </div>
  );
}
