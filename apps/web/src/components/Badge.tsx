import type { ClassStatus } from "@studdy/shared";
import styles from "./Badge.module.css";

export type BadgeTone = "neutral" | "info" | "success" | "danger";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: string }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}

const STATUS: Record<ClassStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: "Nacrt", tone: "neutral" },
  generating: { label: "Generiše se", tone: "info" },
  ready: { label: "Spremno", tone: "success" },
  failed: { label: "Greška", tone: "danger" },
};

export function StatusBadge({ status }: { status: ClassStatus }) {
  const { label, tone } = STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}
