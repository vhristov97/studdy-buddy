import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import styles from "./Field.module.css";

interface FieldShellProps {
  label: string;
  helper?: string;
  error?: string;
  required?: boolean;
  render: (props: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": true | undefined;
  }) => ReactNode;
}

function FieldShell({ label, helper, error, required, render }: FieldShellProps) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const describedBy =
    [helper ? helperId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
        {required && (
          <span className={styles.required} aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      {render({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {helper && (
        <p id={helperId} className={styles.helper}>
          {helper}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}

interface CommonProps {
  label: string;
  helper?: string;
  error?: string;
}

export function TextField({
  label,
  helper,
  error,
  required,
  ...rest
}: CommonProps & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <FieldShell
      label={label}
      helper={helper}
      error={error}
      required={required}
      render={(a11y) => <input type="text" className={styles.control} {...a11y} {...rest} />}
    />
  );
}

export function NumberField({
  label,
  helper,
  error,
  required,
  ...rest
}: CommonProps & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <FieldShell
      label={label}
      helper={helper}
      error={error}
      required={required}
      render={(a11y) => (
        <input type="number" inputMode="numeric" className={styles.control} {...a11y} {...rest} />
      )}
    />
  );
}

export function TextArea({
  label,
  helper,
  error,
  required,
  ...rest
}: CommonProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell
      label={label}
      helper={helper}
      error={error}
      required={required}
      render={(a11y) => <textarea rows={3} className={styles.control} {...a11y} {...rest} />}
    />
  );
}
