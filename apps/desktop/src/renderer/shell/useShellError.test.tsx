// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShellError } from "./useShellError";

afterEach(cleanup);

const strict = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);

describe("useShellError", () => {
  it("runs a retry exactly once, even under Strict Mode, and drops the row", () => {
    const retry = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"), { wrapper: strict });
    act(() => result.current.reportShellError("Could not refresh history.", new Error("timeout"), retry));
    expect(result.current.shellErrors).toHaveLength(1);
    const id = result.current.shellErrors[0]!.id;

    act(() => result.current.retryShellError(id));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.shellErrors).toEqual([]);
  });

  it("offers Send as proposal on a direct-write row and clears those rows when it runs", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.showDirectWriteNotice({
      kind: "direct-write-stale", message: "stale", retry: null, send: { label: "Send as proposal", run: send },
    }));
    act(() => result.current.showDirectWriteNotice({
      kind: "direct-write-refused", message: "refused", retry: null, send: { label: "Send as proposal", run: send },
    }));
    act(() => result.current.showDirectWriteNotice({
      kind: "direct-write-failed", message: "failed", retry: vi.fn(), send: null,
    }));
    expect(result.current.shellErrors.map((error) => [error.kind, error.action?.label])).toEqual([
      ["direct-write-stale", "Send as proposal"],
      ["direct-write-refused", "Send as proposal"],
      ["direct-write-failed", undefined],
    ]);
    act(() => result.current.runShellErrorAction(result.current.shellErrors[1]!.id));
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.shellErrors.map((error) => error.kind)).toEqual(["direct-write-failed"]);
  });

  it("runs a success notice's undo once and drops the row", () => {
    const undo = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"), { wrapper: strict });
    act(() => result.current.showSuccessNotice('Deleted "Stamp"', undo));
    expect(result.current.shellErrors[0]).toMatchObject({ tone: "success", retry: null, action: { label: "Undo" } });
    const id = result.current.shellErrors[0]!.id;

    act(() => result.current.runShellErrorAction(id));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(result.current.shellErrors).toEqual([]);
  });

  it("replaces a row that says the same thing or has the same kind", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellError("Could not refresh history.", new Error("a")));
    act(() => result.current.reportShellError("Could not refresh history.", new Error("a")));
    expect(result.current.shellErrors).toHaveLength(1);

    act(() => result.current.showTabLimitError(20, "open this file"));
    act(() => result.current.showTabLimitError(21, "open another tab"));
    const tabLimitRows = result.current.shellErrors.filter((error) => error.kind === "tab-limit");
    expect(tabLimitRows).toHaveLength(1);
    expect(tabLimitRows[0]!.message).toContain("21 open tabs");

    act(() => result.current.clearTabLimitError());
    expect(result.current.shellErrors.some((error) => error.kind === "tab-limit")).toBe(false);
    expect(result.current.shellErrors).toHaveLength(1);
  });

  it("files one sync failure row at a time, with or without a toast", () => {
    const retry = vi.fn();
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() =>
      result.current.reportSyncFailure(
        { message: "dohc could not sync this workspace.", detail: "Error: refused", toast: false },
        retry,
      ),
    );
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]).toMatchObject({
      kind: "cloud-sync",
      details: [["Detail", "Error: refused"]],
      seen: true,
    });
    act(() =>
      result.current.reportSyncFailure(
        { message: "dohc could not reach the server.", detail: "RelayUnreachableError", toast: true },
        retry,
      ),
    );
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]).toMatchObject({
      message: "dohc could not reach the server.",
      seen: false,
    });
    act(() => result.current.retryShellError(result.current.shellErrors[0]!.id));
    expect(retry).toHaveBeenCalledTimes(1);
    act(() =>
      result.current.reportSyncFailure(
        { message: "dohc could not sync this workspace.", detail: "Error: refused", toast: false },
        retry,
      ),
    );
    act(() => result.current.clearSyncFailure());
    expect(result.current.shellErrors).toEqual([]);
  });

  it("keeps a raw cause for Copy details out of the message", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() =>
      result.current.reportShellFailure({
        message: "Could not import files. The disk is full.",
        details: [["Cause", "ENOSPC: no space left on device, copyfile 'a.md'"]],
      }),
    );
    expect(result.current.shellErrors[0]).toMatchObject({
      message: "Could not import files. The disk is full.",
      details: [["Cause", "ENOSPC: no space left on device, copyfile 'a.md'"]],
      retry: null,
    });
  });

  it("keeps a hidden row until it is dismissed, and clears on a workspace switch", () => {
    const { result, rerender } = renderHook(({ id }) => useShellError(id), {
      initialProps: { id: "ws-a" },
    });
    act(() => result.current.reportShellFailure({ message: "Saved copy is stale." }));
    const id = result.current.shellErrors[0]!.id;

    act(() => result.current.hideShellError(id));
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]!.seen).toBe(true);

    act(() => result.current.dismissShellError(id));
    expect(result.current.shellErrors).toEqual([]);

    act(() => result.current.reportShellFailure({ message: "Saved copy is stale." }));
    rerender({ id: "ws-b" });
    expect(result.current.shellErrors).toEqual([]);
  });
});
