import { useEffect } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { useRequestCumulative } from "../api/hooks";
import { Button } from "./Button";
import styles from "./CumulativeButton.module.css";

interface Props {
  courseId: number;
  /** The review to build; leave out for the due one, else the next free one. */
  code?: string;
  label: string;
  variant?: "primary" | "secondary";
}

/** Asks the server to build a cumulative review and reports a refusal (409) inline. */
export function CumulativeButton({ courseId, code, label, variant = "primary" }: Props) {
  const request = useRequestCumulative(courseId);
  const { reset } = request;
  // A new target review (K1 -> K2 once the parent's data refreshes) starts from a clean slate.
  useEffect(() => reset(), [code, reset]);
  return (
    <span className={styles.wrap}>
      <Button variant={variant} onClick={() => request.mutate(code)} disabled={request.isPending}>
        {label}
      </Button>
      {request.isSuccess && (
        <span className={styles.note}>
          Pravljenje je počelo.{" "}
          <Link to={`/predavanja/${request.data.classId}`}>Prati tok na stranici predavanja</Link>
        </span>
      )}
      {request.isError && (
        <span className={styles.error} role="alert">
          {request.error instanceof ApiError
            ? request.error.message
            : "Pravljenje kumulativnog testa nije uspelo."}
        </span>
      )}
    </span>
  );
}
