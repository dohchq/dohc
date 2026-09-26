// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcErrorMessage } from "../ipcError";
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

  it("keeps a hidden row until it is dismissed, and clears on a workspace switch", () => {
    const { result, rerender } = renderHook(({ id }) => useShellError(id), {
      initialProps: { id: "ws-a" },
    });
    act(() => result.current.showShellError("Saved copy is stale."));
    const id = result.current.shellErrors[0]!.id;

    act(() => result.current.hideShellError(id));
    expect(result.current.shellErrors).toHaveLength(1);
    expect(result.current.shellErrors[0]!.seen).toBe(true);

    act(() => result.current.dismissShellError(id));
    expect(result.current.shellErrors).toEqual([]);

    act(() => result.current.showShellError("Saved copy is stale."));
    rerender({ id: "ws-b" });
    expect(result.current.shellErrors).toEqual([]);
  });

  it("shows words instead of Electron's prefix, a class name or a code, and keeps them for Copy", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const refused = new Error(
      "Error invoking remote method 'desktop:list-collections': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    );
    act(() => result.current.reportShellError("Could not read Collections.", refused));
    act(() => result.current.reportLaneFailure("dohc could not refresh sync status.", refused, () => {}));
    act(() => result.current.showShellError(
      "Error invoking remote method 'desktop:dataset': PersistentRuntimeError [worker_stopped]: The dataset worker stopped. Reopen it from the journal.",
    ));
    act(() => result.current.showShellError("Version controls are unavailable right now.", refused));
    expect(result.current.shellErrors.map(({ message, cause }) => ({ message, cause }))).toEqual([
      {
        message: "Could not read Collections. dohc is still reading this workspace's files. Try again when it finishes.",
        cause: "DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
      },
      {
        message: "dohc could not refresh sync status. dohc is still reading this workspace's files. Try again when it finishes.",
        cause: "DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
      },
      {
        message: "It stopped before it finished. Try again.",
        cause: "PersistentRuntimeError [worker_stopped]: The dataset worker stopped. Reopen it from the journal.",
      },
      {
        message: "Version controls are unavailable right now.",
        cause: "DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
      },
    ]);
  });

  it("keeps two failures with the same reason apart by what failed", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const stopped = new Error(
      "Error invoking remote method 'desktop:dataset': PersistentRuntimeError [worker_stopped]: The dataset worker stopped.",
    );
    act(() => result.current.showShellError(ipcErrorMessage(stopped, "Could not send that message."), stopped));
    act(() => result.current.showShellError(ipcErrorMessage(stopped, "Could not load this chat."), stopped));
    expect(result.current.shellErrors.map(({ message }) => message)).toEqual([
      "Could not send that message. It stopped before it finished. Try again.",
      "Could not load this chat. It stopped before it finished. Try again.",
    ]);
  });

  it("says what failed, then a Collection reply as written", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellError(
      "Could not open this Collection.",
      new Error("Error invoking remote method 'desktop:dataset': Error: Dataset changed after this preview. Preview it again."),
    ));
    expect(result.current.shellErrors[0]!.message)
      .toBe("Could not open this Collection. Dataset changed after this preview. Preview it again.");
  });
});
