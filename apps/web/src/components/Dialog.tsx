import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./Button";
import styles from "./Dialog.module.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** Modal built on the native <dialog>: focus is trapped and Esc closes it. */
export function Dialog({ open, onClose, title, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open && (
        <div className={styles.body}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
  error?: string | null;
  children: ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  onConfirm,
  onClose,
  pending = false,
  error,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className={styles.message}>{children}</div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <DialogActions>
        <Button onClick={onClose}>Otkaži</Button>
        <Button variant="danger" onClick={onConfirm} disabled={pending}>
          {pending ? "Brisanje…" : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}
