// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { observeLiveSessions, useReopenKey, watchLiveSessions } from "./documentVersionKey";

it("moves the key once for each change main makes, whichever shell reads it first", () => {
  const key = renderHook(() => useReopenKey("ws-observe"));
  const shellA = watchLiveSessions("ws-observe");
  act(() => observeLiveSessions("ws-observe", 0, false));
  // Main retires its sessions, and a shell that opens now reads the new generation first.
  const shellB = watchLiveSessions("ws-observe");
  act(() => observeLiveSessions("ws-observe", 1, false));
  act(() => observeLiveSessions("ws-observe", 1, true));
  expect(key.result.current).toBe(1);
  act(() => { observeLiveSessions("ws-observe", 2, true); observeLiveSessions("ws-observe", 2, true); });
  expect(key.result.current).toBe(2);
  // The workspace closes, and main counts again from where its reopened state starts.
  shellA(); shellB();
  watchLiveSessions("ws-observe");
  act(() => observeLiveSessions("ws-observe", 1, false));
  act(() => observeLiveSessions("ws-observe", 2, true));
  expect(key.result.current).toBe(3);
});
