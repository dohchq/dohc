// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useShellNotice } from "./useShellNotice";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps a replacement notice until its own deadline", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useShellNotice());

  act(() => result.current.showShellNotice("Imported 1 file."));
  expect(result.current.shellNotice).toBe("Imported 1 file.");
  act(() => vi.advanceTimersByTime(3000));
  act(() => result.current.showShellNotice("Imported 2 files."));
  expect(result.current.shellNotice).toBe("Imported 2 files.");

  act(() => vi.advanceTimersByTime(3000));
  expect(result.current.shellNotice).toBe("Imported 2 files.");
  act(() => vi.advanceTimersByTime(2999));
  expect(result.current.shellNotice).toBe("Imported 2 files.");
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.shellNotice).toBeNull();
});
