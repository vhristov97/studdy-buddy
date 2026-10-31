import { useState, type FormEvent } from "react";
import { CreateCourseInput, type CourseSummary } from "@studdy/shared";
import { ApiError } from "../api/client";
import { FORM_ERROR_KEY, issuesToFieldErrors, type FieldErrors } from "../lib/validation";
import { Button } from "./Button";
import { DialogActions } from "./Dialog";
import { ErrorMessage } from "./ErrorMessage";
import { NumberField, TextArea, TextField } from "./Field";

interface CourseFormProps {
  initial?: CourseSummary;
  submitLabel: string;
  onSubmit: (input: CreateCourseInput) => Promise<unknown>;
  onCancel: () => void;
}

export function CourseForm({ initial, submitLabel, onSubmit, onCancel }: CourseFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [persona, setPersona] = useState(initial?.persona ?? "");
  const [assessmentFormat, setAssessmentFormat] = useState(initial?.assessmentFormat ?? "");
  const [cadence, setCadence] = useState(
    initial?.reviewCadence != null ? String(initial.reviewCadence) : "",
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = CreateCourseInput.safeParse({
      name,
      persona,
      assessmentFormat,
      reviewCadence: cadence.trim() === "" ? null : Number(cadence),
    });
    if (!parsed.success) {
      setErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      await onSubmit(parsed.data);
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") {
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
    <form onSubmit={handleSubmit} noValidate>
      {errors[FORM_ERROR_KEY] && <ErrorMessage>{errors[FORM_ERROR_KEY]}</ErrorMessage>}
      <TextField
        label="Naziv"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
        autoComplete="off"
      />
      <TextArea
        label="Uloga tutora"
        helper="npr. iskusni data inženjer — utiče na ton beleški i pitanja"
        value={persona}
        onChange={(e) => setPersona(e.target.value)}
        error={errors.persona}
      />
      <TextArea
        label="Format ispita"
        helper="npr. pismeni test sa 15 zatvorenih pitanja + usmeni"
        value={assessmentFormat}
        onChange={(e) => setAssessmentFormat(e.target.value)}
        error={errors.assessmentFormat}
      />
      <NumberField
        label="Kumulativni test na svakih N predavanja"
        min={1}
        max={50}
        step={1}
        value={cadence}
        onChange={(e) => setCadence(e.target.value)}
        error={errors.reviewCadence}
      />
      <DialogActions>
        <Button onClick={onCancel}>Otkaži</Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Čuvanje…" : submitLabel}
        </Button>
      </DialogActions>
    </form>
  );
}
