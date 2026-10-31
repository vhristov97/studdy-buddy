import { useState, type FormEvent } from "react";
import { CreateClassInput } from "@studdy/shared";
import { ApiError } from "../api/client";
import { FORM_ERROR_KEY, issuesToFieldErrors, type FieldErrors } from "../lib/validation";
import { Button } from "./Button";
import { DialogActions } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";
import { NumberField, TextField } from "./Field";
import styles from "./ClassForm.module.css";

interface ClassFormProps {
  initial?: { title: string; number: number };
  submitLabel: string;
  /** Shown as the Broj placeholder (the number the server picks when it's left empty). */
  suggestedNumber?: number;
  onSubmit: (input: CreateClassInput) => Promise<unknown>;
  onCancel?: () => void;
  /** Clear the fields after a successful submit (the inline "add" form). */
  resetOnSuccess?: boolean;
  inline?: boolean;
}

export function ClassForm({
  initial,
  submitLabel,
  suggestedNumber,
  onSubmit,
  onCancel,
  resetOnSuccess = false,
  inline = false,
}: ClassFormProps) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [number, setNumber] = useState(initial ? String(initial.number) : "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = CreateClassInput.safeParse({
      title,
      number: number.trim() === "" ? undefined : Number(number),
    });
    if (!parsed.success) {
      setErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      await onSubmit(parsed.data);
      if (resetOnSuccess) {
        setTitle("");
        setNumber("");
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setErrors({
          number:
            parsed.data.number !== undefined
              ? `Predavanje sa brojem ${parsed.data.number} već postoji.`
              : err.message,
        });
      } else if (err instanceof ApiError && err.code === "validation") {
        const fieldErrors = issuesToFieldErrors(err.details);
        setErrors(
          Object.keys(fieldErrors).length > 0 ? fieldErrors : { [FORM_ERROR_KEY]: err.message },
        );
      } else {
        setErrors({
          [FORM_ERROR_KEY]: err instanceof ApiError ? err.message : "Čuvanje nije uspelo.",
        });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className={inline ? styles.inline : undefined}>
      {errors[FORM_ERROR_KEY] && <ErrorMessage>{errors[FORM_ERROR_KEY]}</ErrorMessage>}
      <div className={inline ? styles.fields : undefined}>
        <TextField
          label="Naslov"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={errors.title}
          autoComplete="off"
        />
        <NumberField
          label="Broj"
          min={1}
          max={999}
          step={1}
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder={suggestedNumber !== undefined ? String(suggestedNumber) : undefined}
          error={errors.number}
        />
      </div>
      <DialogActions>
        {onCancel && <Button onClick={onCancel}>Otkaži</Button>}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Čuvanje…" : submitLabel}
        </Button>
      </DialogActions>
    </form>
  );
}
