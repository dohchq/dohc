// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcErrorMessage } from "../ipcError";
import { useShellError } from "./useShellError";
import { CreationPartialError } from "@dohc/cli/creation";
import { errorDetails } from "./copyDetails";

afterEach(cleanup);

const strict = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);

describe("useShellError", () => {
  it.each([true, false])("keeps separate partial creations and replaces only the retried creation (record: %s)", record => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const firstRetry = vi.fn();
    const secondRetry = vi.fn();
    const updatedRetry = vi.fn();
    const partial = (name: string, failedStage: "settle" | "close" = "settle") => new CreationPartialError({
      kind: "partial", created: [record ? `tasks/${name}.md` : `${name}/frontend.js`],
      failedStage, reason: `${name}: ${failedStage} failed`,
      retry: { mode: "resume", instruction: "Try again.",
        ...(record ? { recordId: `rec_${name.repeat(26)}` } : {}),
      },
    });
    act(() => {
      result.current.reportShellError("Creation failed.", partial("a"), firstRetry);
      result.current.reportShellError("Creation failed.", partial("b"), secondRetry);
    });
    expect(result.current.shellErrors).toHaveLength(2);
    act(() => result.current.reportShellError("Creation failed.", partial("a", "close"), updatedRetry));
    expect(result.current.shellErrors).toHaveLength(2);
    const [second, updated] = result.current.shellErrors;
    expect(errorDetails(second!.details!)).toContain("Reason: b: settle failed");
    expect(errorDetails(updated!.details!)).toContain("Reason: a: close failed");
    act(() => result.current.retryShellError(second!.id));
    act(() => result.current.retryShellError(updated!.id));
    expect(secondRetry).toHaveBeenCalledOnce();
    expect(updatedRetry).toHaveBeenCalledOnce();
    expect(firstRetry).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps partial creation facts in copy details and offers the human retry (record: %s)", record => {
    const retry = vi.fn();
    const partial = { kind: "partial" as const, created: [record ? "tasks/retry.md" : "form/frontend.js"],
      failedStage: "settle" as const, reason: "settle failed", retry: { mode: "resume" as const,
        ...(record ? { recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa" } : {}),
        instruction: "Try again with the same record ID and fields." } };
    const error = new CreationPartialError(partial);
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellError("Creation failed.", error, retry));
    const notice = result.current.shellErrors[0]!;
    expect(notice.message).toBe(record
      ? "dohc created the record file but could not finish the record."
      : "dohc created form files but could not finish the form.");
    const copied = errorDetails(notice.details!);
    expect(copied).toContain(`Created: ${partial.created[0]}`);
    expect(copied).toContain("Reason: settle failed");
    expect(copied).toContain(`Next: ${partial.retry.instruction}`);
    if (record) expect(copied).toContain(`Record ID: ${partial.retry.recordId}`);
    expect(notice.message).not.toContain("rec_");
    act(() => result.current.retryShellError(notice.id));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers copy details as the next action when creation cannot resume", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const paths = Array.from({ length: 4 }, (_, index) => `${"long-folder/".repeat(20)}file-${index}.js`);
    const error = new CreationPartialError({ kind: "partial", created: paths, failedStage: "revision",
      reason: "Collection rules changed.", retry: { mode: "remove-and-retry", instruction: "Review the listed files in Files, then remove them." } });
    act(() => result.current.reportShellError("Creation failed.", error));
    expect(result.current.shellErrors[0]).toMatchObject({
      message: "dohc created form files; copy the details to review them in Files.", retry: null,
    });
    const copied = errorDetails(result.current.shellErrors[0]!.details!);
    for (const path of paths) expect(copied).toContain(`Created: ${path}`);
    expect(copied).toContain(`Next: ${error.partial.retry.instruction}`);
  });
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

  it("shows words instead of Electron's prefix, a class name or a code, and keeps them for Copy", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    const refused = new Error(
      "Error invoking remote method 'desktop:list-collections': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    );
    act(() => result.current.reportShellError("Could not read Collections.", refused));
    act(() => result.current.reportLaneFailure("dohc could not refresh sync status.", refused, () => {}));
    act(() => result.current.reportShellFailure({
      message: "Error invoking remote method 'desktop:dataset': PersistentRuntimeError [worker_stopped]: The dataset worker stopped. Reopen it from the journal.",
    }));
    act(() => result.current.reportShellFailure({ message: "Version controls are unavailable right now.", cause: refused }));
    expect(result.current.shellErrors.map(({ message, details }) => ({
      message,
      cause: details?.find(([label]) => label === "Cause")?.[1],
    }))).toEqual([
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
    act(() => result.current.reportShellFailure({ message: ipcErrorMessage(stopped, "Could not send that message."), cause: stopped }));
    act(() => result.current.reportShellFailure({ message: ipcErrorMessage(stopped, "Could not load this chat."), cause: stopped }));
    expect(result.current.shellErrors.map(({ message }) => message)).toEqual([
      "Could not send that message. It stopped before it finished. Try again.",
      "Could not load this chat. It stopped before it finished. Try again.",
    ]);
  });

  it("says what failed, then a Collection reply as written", () => {
    const { result } = renderHook(() => useShellError("ws-a"));
    act(() => result.current.reportShellError(
      "Could not open this Collection.",
      new Error("Error invoking remote method 'desktop:dataset': Error: The Collection changed after this preview. Preview the change again."),
    ));
    expect(result.current.shellErrors[0]!.message)
      .toBe("Could not open this Collection. The Collection changed after this preview. Preview the change again.");
  });
});
