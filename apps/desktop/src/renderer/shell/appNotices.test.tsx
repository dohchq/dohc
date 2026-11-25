// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useShellError } from "./useShellError";

afterEach(cleanup);

it("files an app's notice in its own words, one row per app, with the app's Try again", () => {
  const { result } = renderHook(() => useShellError("w"));
  const open = vi.fn();
  const raw = "TypeError: Failed to fetch";
  act(() => result.current.reportShellFailure({ message: raw, identity: "dohc" }));
  const dohcWords = result.current.shellErrors[0]!.message;
  expect(dohcWords).not.toBe(raw);

  act(() =>
    result.current.reportAppNotice({
      identity: "app-notice:books",
      title: "books reported a problem",
      message: raw,
      detail: "Row 40 has no date.",
      retry: open,
    }),
  );
  const first = result.current.shellErrors.find((row) => row.identity === "app-notice:books")!;
  vi.spyOn(Date, "now").mockReturnValue(first.atMs + 3_600_000);
  act(() =>
    result.current.reportAppNotice({
      identity: "app-notice:books",
      title: "books reported a problem",
      message: "Bank import stopped at row 40",
      retry: open,
    }),
  );
  vi.restoreAllMocks();
  const rows = result.current.shellErrors.filter((row) => row.identity === "app-notice:books");
  expect(rows).toEqual([
    expect.objectContaining({
      title: "books reported a problem",
      message: "Bank import stopped at row 40",
      atMs: first.atMs + 3_600_000,
      seen: true,
    }),
  ]);
  expect(rows[0]!.id).not.toBe(first.id);
  expect(rows[0]!.details).toBeUndefined();
  rows[0]!.retry!();
  expect(open).toHaveBeenCalledOnce();

  act(() =>
    result.current.reportAppNotice({
      identity: "app-notice:books",
      title: "books reported a problem",
      message: raw,
      detail: "Row 40 has no date.",
      retry: open,
    }),
  );
  expect(result.current.shellErrors.find((row) => row.identity === "app-notice:books")).toEqual(
    expect.objectContaining({ message: raw, details: [["Detail", "Row 40 has no date."]] }),
  );
});
