// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAuthoritativeValueRevision } from "./useAuthoritativeValueRevision";

it("commits a revision when the authoritative text is unchanged", () => {
  const { result } = renderHook(() => useAuthoritativeValueRevision());
  expect(result.current[0]).toBe(0);

  act(() => result.current[1]());

  expect(result.current[0]).toBe(1);
});
