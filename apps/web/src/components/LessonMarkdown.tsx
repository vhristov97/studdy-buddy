import type { Components } from "react-markdown";
import {
  CALLOUT_ATTR,
  remarkLesson,
  TAG_ATTR,
  type CalloutKind,
  type SourceTag,
} from "../lib/lessonRemark";
import { LessonTag } from "./LessonTag";
import { MarkdownView } from "./MarkdownView";
import styles from "./LessonMarkdown.module.css";

const CALLOUT_CLASS: Record<CalloutKind, string> = {
  correction: styles.correction!,
  question: styles.question!,
  deferred: styles.deferred!,
};

const PLUGINS = [remarkLesson];

// The remark plugin leaves its marks as data-* attributes; these turn them into components.
const COMPONENTS: Components = {
  span: ({ children, ...props }) => {
    const tag = (props as Record<string, unknown>)[TAG_ATTR] as SourceTag | undefined;
    return tag ? <LessonTag tag={tag} /> : <span>{children}</span>;
  },
  blockquote: ({ children, ...props }) => {
    const kind = (props as Record<string, unknown>)[CALLOUT_ATTR] as CalloutKind | undefined;
    return kind ? (
      <blockquote role="note" className={`${styles.callout} ${CALLOUT_CLASS[kind]}`}>
        {children}
      </blockquote>
    ) : (
      <blockquote>{children}</blockquote>
    );
  },
};

/** Combined notes: Markdown with source tags and callouts. Raw HTML is never rendered. */
export function LessonMarkdown({ source }: { source: string }) {
  return (
    <div className={styles.lesson}>
      <MarkdownView source={source} remarkPlugins={PLUGINS} components={COMPONENTS} />
    </div>
  );
}
