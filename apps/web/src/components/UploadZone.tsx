import { useRef, useState, type DragEvent } from "react";
import { ACCEPTED_FILE_TYPES, MAX_MATERIAL_SIZE_BYTES } from "@studdy/shared";
import { ApiError } from "../api/client";
import { useUploadMaterials } from "../api/hooks";
import { Button } from "./Button";
import styles from "./UploadZone.module.css";

const ACCEPT = Object.keys(ACCEPTED_FILE_TYPES).join(",");
const MAX_MB = MAX_MATERIAL_SIZE_BYTES / (1024 * 1024);

type EntryState = "uploading" | "done" | "error";

interface Entry {
  id: number;
  name: string;
  state: EntryState;
  message?: string;
}

/** Returns an error message for a file the server would refuse anyway, or null. */
export function checkFile(file: File): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!ACCEPTED_FILE_TYPES[ext]) {
    return `Nepodržan tip fajla. Dozvoljeno: ${Object.keys(ACCEPTED_FILE_TYPES).join(", ")}.`;
  }
  if (file.size === 0) return "Fajl je prazan.";
  if (file.size > MAX_MATERIAL_SIZE_BYTES) return `Fajl je veći od ${MAX_MB} MB.`;
  return null;
}

let nextEntryId = 1;

/**
 * Drag & drop / file picker. Each valid file goes in its own request, so one bad file doesn't
 * reject the rest and every file gets its own result.
 */
export function UploadZone({ classId }: { classId: number }) {
  const upload = useUploadMaterials(classId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);

  function patch(id: number, change: Partial<Entry>) {
    setEntries((current) => current.map((e) => (e.id === id ? { ...e, ...change } : e)));
  }

  async function handleFiles(files: File[]) {
    if (files.length === 0 || busy) return;
    const fresh: Entry[] = files.map((file) => {
      const problem = checkFile(file);
      return {
        id: nextEntryId++,
        name: file.name,
        state: problem ? "error" : "uploading",
        message: problem ?? undefined,
      };
    });
    setEntries(fresh);
    setBusy(true);
    try {
      for (const [index, file] of files.entries()) {
        const entry = fresh[index];
        if (!entry || entry.state === "error") continue;
        try {
          await upload.mutateAsync([file]);
          patch(entry.id, { state: "done" });
        } catch (err) {
          patch(entry.id, {
            state: "error",
            message: err instanceof ApiError ? err.message : "Otpremanje nije uspelo.",
          });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void handleFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div>
      <div
        className={`${styles.zone} ${dragging ? styles.dragging : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className={styles.prompt}>Prevuci fajlove ovde (PDF, HTML ili Markdown beleške)</p>
        <Button variant="primary" disabled={busy} onClick={() => inputRef.current?.click()}>
          Izaberi fajlove
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          aria-label="Fajlovi za otpremanje"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void handleFiles(files);
          }}
        />
        <p className={styles.limit}>Najviše {MAX_MB} MB po fajlu.</p>
      </div>

      {entries.length > 0 && (
        <ul className={styles.results} aria-label="Rezultati otpremanja">
          {entries.map((entry) => (
            <li key={entry.id} className={`${styles.result} ${styles[entry.state]}`}>
              <span className={styles.name}>{entry.name}</span>
              <span role={entry.state === "error" ? "alert" : "status"}>
                {entry.state === "uploading" && "Otpremanje…"}
                {entry.state === "done" && "Otpremljeno"}
                {entry.state === "error" && entry.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
