import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { ErrorMessage } from "./ErrorMessage";
import { Spinner } from "./Spinner";

interface QueryBoundaryProps<T> {
  query: UseQueryResult<T>;
  /** Where the "not found" message links back to. */
  backTo: string;
  backLabel: string;
  children: (data: T) => ReactNode;
}

/** Loading spinner, a friendly "Ne postoji" for a 404, a generic error otherwise. */
export function QueryBoundary<T>({ query, backTo, backLabel, children }: QueryBoundaryProps<T>) {
  if (query.isPending) return <Spinner />;
  if (query.isError) {
    const error = query.error;
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
      return (
        <section>
          <h1>Ne postoji</h1>
          <p>
            <Link to={backTo}>{backLabel}</Link>
          </p>
        </section>
      );
    }
    return (
      <ErrorMessage>
        {error instanceof ApiError ? error.message : "Došlo je do greške. Pokušajte ponovo."}
      </ErrorMessage>
    );
  }
  return <>{children(query.data)}</>;
}
