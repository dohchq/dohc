// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncStatusResult } from "../../ipc/bridgeContract";
import { useShellError } from "./useShellError";
import {
  collectionsWaitingMessage,
  forgetCollectionsWaitingNoticesForTests,
  useCollectionsWaitingNotice,
} from "./useCollectionsWaitingNotice";

afterEach(() => {
  cleanup();
  forgetCollectionsWaitingNoticesForTests();
});

type Waiting = SyncStatusResult["collectionsWaitingForSync"] | null;

const HEALTHY: SyncStatusResult = {
  state: "synced",
  pendingChangeCount: 0,
  lastSyncedAtMs: null,
  historyRecordingUnavailable: false,
  historyShareView: false,
  liveSessionsGeneration: 0,
};

// A retry whose answer the test sends when it chooses.
function pendingRetry() {
  let settle: { resolve: (status: SyncStatusResult) => void; reject: (error: unknown) => void } | null = null;
  const retryCloudSync = vi.fn(
    (_id: string, _reason: "person") =>
      new Promise<SyncStatusResult>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  return {
    retryCloudSync,
    answer: (waiting: Waiting) =>
      settle?.resolve({ ...HEALTHY, ...(waiting ? { collectionsWaitingForSync: waiting } : {}) }),
    fail: (error: unknown) => settle?.reject(error),
  };
}

// The shell's error hook and the notice together, as the shell wires them.
function renderNotice(
  initial: { workspaceId?: string; waiting: Waiting | undefined },
  retryCloudSync = vi.fn(async (_id: string, _reason: "person"): Promise<SyncStatusResult> => HEALTHY),
) {
  const openSyncSettings = vi.fn();
  const view = renderHook(
    ({ workspaceId, waiting }: { workspaceId: string; waiting: Waiting | undefined }) => {
      const errors = useShellError(workspaceId);
      const notice = useCollectionsWaitingNotice({
        workspaceId,
        waiting,
        retryCloudSync,
        openSyncSettings,
        report: errors.reportCollectionsWaiting,
        reportRetryFailure: (message, error, retry) =>
          errors.reportShellError(message, error, retry, undefined, "collections-waiting-retry"),
        clear: errors.clearCollectionsWaiting,
      });
      return { errors, notice };
    },
    { initialProps: { workspaceId: initial.workspaceId ?? "ws-a", waiting: initial.waiting } },
  );
  const rows = () => view.result.current.errors.shellErrors;
  const toasts = () => rows().filter((row) => !row.seen);
  return { ...view, rows, toasts, retryCloudSync, openSyncSettings };
}

describe("useCollectionsWaitingNotice", () => {
  it("toasts once, offers Try again and sync settings, and leaves after sync finishes", async () => {
    const view = renderNotice({ waiting: "sync" });
    expect(view.toasts()).toHaveLength(1);
    const row = view.rows()[0]!;
    expect(row.message).toBe(
      "Collection updates are waiting for sync to finish. To continue offline, pause sync in Settings.",
    );
    expect(row.tone).toBe("warning");
    expect(row.kind).toBe("collections-waiting");
    expect(row.action?.label).toBe("Sync settings");
    act(() => view.result.current.errors.runShellErrorAction(row.id));
    expect(view.openSyncSettings).toHaveBeenCalledOnce();
    act(() => view.result.current.errors.retryShellError(row.id));
    await waitFor(() => expect(view.retryCloudSync).toHaveBeenCalledWith("ws-a", "person"));
    expect(view.rows()).toEqual([]);
    view.rerender({ workspaceId: "ws-a", waiting: null });
    expect(view.rows()).toEqual([]);
  });

  it("replaces its row on each repeated deferral without another toast", () => {
    const view = renderNotice({ waiting: "sync" });
    act(() => view.result.current.errors.hideShellError(view.rows()[0]!.id));
    for (let pass = 0; pass < 3; pass += 1) {
      view.rerender({ workspaceId: "ws-a", waiting: "sync" });
    }
    expect(view.rows()).toHaveLength(1);
    expect(view.toasts()).toEqual([]);
  });

  it("files an ongoing wait without a toast when the shell remounts", () => {
    const first = renderNotice({ waiting: "sync" });
    act(() => first.result.current.errors.hideShellError(first.rows()[0]!.id));
    first.unmount();
    const second = renderNotice({ waiting: "sync" });
    expect(second.rows()).toHaveLength(1);
    expect(second.toasts()).toEqual([]);
  });

  it("waits through a loading status and ends only on a status with no wait", () => {
    const view = renderNotice({ waiting: "sync" });
    view.rerender({ workspaceId: "ws-a", waiting: undefined });
    expect(view.rows()).toHaveLength(1);
    view.rerender({ workspaceId: "ws-a", waiting: null });
    expect(view.rows()).toEqual([]);
  });

  it("keeps a dismissed row dismissed across a remount until the state changes", () => {
    const first = renderNotice({ waiting: "sync" });
    act(() => {
      first.result.current.notice.noteDismissed();
      first.result.current.errors.dismissShellError(first.rows()[0]!.id);
    });
    first.unmount();
    const second = renderNotice({ waiting: "sync" });
    expect(second.rows()).toEqual([]);
    // The reopen after a pause failing is news.
    second.rerender({ workspaceId: "ws-a", waiting: "reopen" });
    expect(second.toasts()).toHaveLength(1);
    expect(second.rows()[0]!.message).toBe(collectionsWaitingMessage("reopen"));
  });

  it("toasts again when the person asks and the updates still wait", async () => {
    const retry = pendingRetry();
    const view = renderNotice({ waiting: "sync" }, retry.retryCloudSync);
    act(() => view.result.current.errors.hideShellError(view.rows()[0]!.id));
    act(() => view.result.current.errors.retryShellError(view.rows()[0]!.id));
    await act(async () => retry.answer("sync"));
    await waitFor(() => expect(view.toasts()).toHaveLength(1));
  });

  it("names the reopen when retrying it fails, and its retry asks again", async () => {
    const retry = pendingRetry();
    const view = renderNotice({ waiting: "reopen" }, retry.retryCloudSync);
    expect(view.rows()[0]!.message).toBe(
      "dohc paused sync but could not reopen this workspace. Collection updates wait until it reopens.",
    );
    act(() => view.result.current.errors.retryShellError(view.rows()[0]!.id));
    await act(async () => retry.fail(new Error("open failed")));
    await waitFor(() =>
      expect(view.rows().map((row) => row.identity)).toContain("collections-waiting-retry"),
    );
    const failure = view.rows().find((row) => row.identity === "collections-waiting-retry")!;
    expect(failure.message).toContain("dohc could not reopen this workspace.");
    act(() => view.result.current.errors.retryShellError(failure.id));
    expect(retry.retryCloudSync).toHaveBeenCalledTimes(2);
  });

  it("drops an answer that arrives after the workspace changed", async () => {
    const retry = pendingRetry();
    const view = renderNotice({ waiting: "sync" }, retry.retryCloudSync);
    act(() => view.result.current.errors.retryShellError(view.rows()[0]!.id));
    view.rerender({ workspaceId: "ws-b", waiting: null });
    await act(async () => retry.answer("sync"));
    expect(view.rows()).toEqual([]);
  });
});
