import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useDeleteMaterial, useUploadMaterials } from "./hooks";
import { queryKeys } from "./keys";
import { mockApi } from "../test/utils";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.courses, []);
  client.setQueryData(queryKeys.course(1), {});
  client.setQueryData(queryKeys.class(5), {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

function invalidated(client: QueryClient, key: readonly unknown[]) {
  return client.getQueryState(key)?.isInvalidated === true;
}

describe("material mutations invalidate the parent course", () => {
  it("after an upload", async () => {
    mockApi({ "POST /api/classes/5/materials": () => [] });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useUploadMaterials(5), { wrapper });
    await result.current.mutateAsync([new File(["%PDF-"], "a.pdf")]);
    await waitFor(() => expect(invalidated(client, queryKeys.class(5))).toBe(true));
    expect(invalidated(client, queryKeys.course(1))).toBe(true);
    expect(invalidated(client, queryKeys.courses)).toBe(true);
  });

  it("after a delete", async () => {
    mockApi({ "DELETE /api/materials/10": () => undefined });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useDeleteMaterial(5), { wrapper });
    await result.current.mutateAsync(10);
    await waitFor(() => expect(invalidated(client, queryKeys.class(5))).toBe(true));
    expect(invalidated(client, queryKeys.course(1))).toBe(true);
  });
});
