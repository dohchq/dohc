// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncStatusResult } from "../../ipc/bridgeContract";
import { useShellError } from "./useShellError";
import {
  forgetSyncFailureNoticesForTests,
  syncFailureMessage,
  useSyncFailureNotice,
} from "./useSyncFailureNotice";

afterEach(() => {
  cleanup();
  forgetSyncFailureNoticesForTests();
});

type Failure = NonNullable<SyncStatusResult["syncFailure"]>;

const HEALTHY: SyncStatusResult = {
  state: "synced",
  pendingChangeCount: 0,
  lastSyncedAtMs: null,
  historyRecordingUnavailable: false,
  historyShareView: false,
  liveSessionsGeneration: 0,
};

function unreachable(sinceMs: number, attempts: number): Failure {
  return {
    cause: "server-unreachable",
    detail: `RelayUnreachableError: attempt ${attempts}`,
    sinceMs,
    attempts,
  };
}

// The shell's two hooks together, as the shell wires them.
function renderNotice(
  initial: { workspaceId?: string; failure: Failure | null | undefined },
  retryCloudSync = vi.fn(async (_id: string, _reason: "person" | "reconnect"): Promise<SyncStatusResult> => HEALTHY),
) {
  const view = renderHook(
    ({ workspaceId, failure }: { workspaceId: string; failure: Failure | null | undefined }) => {
      const errors = useShellError(workspaceId);
      const notice = useSyncFailureNotice({
        workspaceId,
        failure,
        retryCloudSync,
        report: errors.reportSyncFailure,
        clear: errors.clearSyncFailure,
      });
      return { errors, notice };
    },
    { initialProps: { workspaceId: initial.workspaceId ?? "ws-a", failure: initial.failure } },
  );
  const rows = () => view.result.current.errors.shellErrors;
  const toasts = () => rows().filter((row) => !row.seen);
  return { ...view, rows, toasts, retryCloudSync };
}

describe("useSyncFailureNotice", () => {
  // Opus and Codex on #1233: every network blip raised an alert toast.
  it("files a row but never toasts a failure that alternates with success", () => {
    const view = renderNotice({ failure: null });
    for (let round = 1; round <= 4; round += 1) {
      view.rerender({ workspaceId: "ws-a", failure: unreachable(round * 100, 1) });
      expect(view.rows()).toHaveLength(1);
      expect(view.toasts()).toEqual([]);
      view.rerender({ workspaceId: "ws-a", failure: null });
      expect(view.rows()).toEqual([]);
    }
  });

  it("toasts once when a failure outlives one automatic retry, then only updates the row", () => {
    const view = renderNotice({ failure: unreachable(100, 1) });
    expect(view.toasts()).toEqual([]);
    view.rerender({ workspaceId: "ws-a", failure: unreachable(100, 2) });
    expect(view.toasts()).toHaveLength(1);
    expect(view.toasts()[0]!.message).toBe(
      "dohc could not reach the server.",
    );
    act(() => view.result.current.errors.hideShellError(view.rows()[0]!.id));
    view.rerender({ workspaceId: "ws-a", failure: unreachable(100, 3) });
    expect(view.toasts()).toEqual([]);
    // The row carries the newest failure, so its copied detail is current.
    expect(view.rows()).toHaveLength(1);
    expect(view.rows()[0]!.detail).toBe("RelayUnreachableError: attempt 3");
  });

  it("keeps a dismissed failure dismissed when the shell remounts, until it ends", () => {
    const first = renderNotice({ failure: unreachable(100, 2) });
    expect(first.toasts()).toHaveLength(1);
    act(() => {
      first.result.current.notice.noteDismissed();
      first.result.current.errors.dismissShellError(first.rows()[0]!.id);
    });
    first.unmount();

    // Back to this workspace: the same failure shows neither toast nor row.
    const second = renderNotice({ failure: unreachable(100, 3) });
    expect(second.rows()).toEqual([]);
    // A new failure after recovery is news again.
    second.rerender({ workspaceId: "ws-a", failure: null });
    second.rerender({ workspaceId: "ws-a", failure: unreachable(900, 1) });
    expect(second.rows()).toHaveLength(1);
  });

  // The shell remounts on every workspace switch, and its status starts
  // unknown until the workspace answers. That is not a recovery.
  // #1233 review: each new attempt refiled the row as seen, which closed an
  // open toast by itself.
  it("keeps an open toast open when the next attempt fails", () => {
    const view = renderNotice({ failure: unreachable(100, 2) });
    expect(view.toasts()).toHaveLength(1);
    view.rerender({ workspaceId: "ws-a", failure: unreachable(100, 3) });
    expect(view.toasts()).toHaveLength(1);
    expect(view.toasts()[0]!.detail).toBe("RelayUnreachableError: attempt 3");
  });

  // #1233 review: a reconnect retry changed the cause without counting an
  // attempt, and the row kept the old message and detail.
  it("refiles the row when a reconnect retry changes the cause, without a toast", () => {
    const view = renderNotice({
      failure: { cause: "unknown", detail: "RelayError: first", sinceMs: 100, attempts: 1 },
    });
    expect(view.rows()[0]!.message).toBe("dohc could not sync this workspace.");
    view.rerender({
      workspaceId: "ws-a",
      failure: { cause: "server-unreachable", detail: "RelayUnreachableError: reconnect", sinceMs: 100, attempts: 1 },
    });
    expect(view.rows()).toHaveLength(1);
    expect(view.rows()[0]!.message).toBe("dohc could not reach the server.");
    expect(view.rows()[0]!.detail).toBe("RelayUnreachableError: reconnect");
    expect(view.toasts()).toEqual([]);
  });

  // #1233 review: a retry answered after the shell unmounted marked the
  // failure as toasted, so coming back showed a quiet row and later failures
  // never interrupted.
  it("ignores a retry that answers after the shell unmounted", async () => {
    let answer: ((status: SyncStatusResult) => void) | null = null;
    const retryCloudSync = vi.fn(
      (_id: string, _reason: "person" | "reconnect") =>
        new Promise<SyncStatusResult>((resolve) => {
          answer = resolve;
        }),
    );
    const first = renderNotice({ failure: unreachable(100, 1) }, retryCloudSync);
    act(() => first.result.current.notice.retry());
    await waitFor(() => expect(answer).not.toBeNull());
    first.unmount();
    await act(async () => {
      answer?.({ ...HEALTHY, state: "sync-failed", syncFailure: unreachable(100, 2) });
    });

    const second = renderNotice({ failure: undefined });
    second.rerender({ workspaceId: "ws-a", failure: unreachable(100, 2) });
    expect(second.toasts()).toHaveLength(1);
  });

  it("keeps a dismissal through a remount that starts with the status still loading", () => {
    const first = renderNotice({ failure: unreachable(100, 2) });
    act(() => {
      first.result.current.notice.noteDismissed();
      first.result.current.errors.dismissShellError(first.rows()[0]!.id);
    });
    first.unmount();

    const second = renderNotice({ failure: undefined });
    expect(second.rows()).toEqual([]);
    second.rerender({ workspaceId: "ws-a", failure: unreachable(100, 3) });
    expect(second.rows()).toEqual([]);
    expect(second.toasts()).toEqual([]);
  });

  it("does not toast again after a remount that starts with the status still loading", () => {
    const first = renderNotice({ failure: unreachable(100, 2) });
    expect(first.toasts()).toHaveLength(1);
    first.unmount();
    const second = renderNotice({ failure: undefined });
    second.rerender({ workspaceId: "ws-a", failure: unreachable(100, 2) });
    expect(second.rows()).toHaveLength(1);
    expect(second.toasts()).toEqual([]);
  });

  it("does not toast again after a remount for a failure already toasted", () => {
    const first = renderNotice({ failure: unreachable(100, 2) });
    expect(first.toasts()).toHaveLength(1);
    first.unmount();
    const second = renderNotice({ failure: unreachable(100, 2) });
    expect(second.rows()).toHaveLength(1);
    expect(second.toasts()).toEqual([]);
  });

  it("toasts when a retry the person asked for fails, and clears when it works", async () => {
    const retryCloudSync = vi
      .fn(async (_id: string): Promise<SyncStatusResult> => HEALTHY)
      .mockImplementationOnce(async () => ({
        ...HEALTHY,
        state: "sync-failed",
        syncFailure: unreachable(100, 2),
      }));
    const view = renderNotice({ failure: unreachable(100, 1) }, retryCloudSync);
    expect(view.toasts()).toEqual([]);

    act(() => view.result.current.errors.retryShellError(view.rows()[0]!.id));
    await waitFor(() => expect(view.toasts()).toHaveLength(1));
    expect(retryCloudSync).toHaveBeenCalledWith("ws-a", "person");

    act(() => view.result.current.errors.retryShellError(view.rows()[0]!.id));
    await waitFor(() => expect(retryCloudSync).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.rows()).toEqual([]));
  });

  it("files a failed retry request as the sync failure, so recovery clears it", async () => {
    const retryCloudSync = vi.fn(async (_id: string, _reason: "person" | "reconnect"): Promise<SyncStatusResult> => {
      throw new Error("This workspace is no longer active.");
    });
    const view = renderNotice({ failure: unreachable(100, 1) }, retryCloudSync);
    act(() => view.result.current.notice.retry());
    await waitFor(() =>
      expect(view.rows()[0]?.message).toBe("dohc could not retry sync for this workspace."),
    );
    expect(view.rows()[0]!.kind).toBe("cloud-sync");
    view.rerender({ workspaceId: "ws-a", failure: null });
    expect(view.rows()).toEqual([]);
  });

  it("tries again at once when the machine comes back online", () => {
    const view = renderNotice({ failure: unreachable(100, 1) });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(view.retryCloudSync).toHaveBeenCalledWith("ws-a", "reconnect");
  });

  // A failed sync pass proves nothing about this machine's copy, so no
  // message claims the changes are saved here.
  it("never claims the changes are saved", () => {
    expect(syncFailureMessage(unreachable(1, 1))).toBe("dohc could not reach the server.");
    expect(
      syncFailureMessage({ cause: "unknown", detail: "Error: disk full", sinceMs: 1, attempts: 1 }),
    ).toBe("dohc could not sync this workspace.");
  });
});
