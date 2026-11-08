// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useShellError } from "./useShellError";
import { MERGE_RETRY_AFTER_CLOSE, MERGE_RETRY_AFTER_STORE, useVersionMergeNotices } from "./useVersionMergeNotices";

afterEach(() => { cleanup(); delete window.dohcDesktop; });

const IDENTITY = "version-merge:ws-1:draft";
const waiting = { conflictId: "c-1", path: "a.md", sourceVersionId: "draft", targetVersionId: "main", origin: "merge",
  contentKind: "text", currentText: "a", incomingText: "b", baseText: null };

function mount(conflictPages: unknown[] = []) {
  const listWorkspaceVersionConflicts = vi.fn(async () => conflictPages.shift() ?? { conflicts: [], nextAfterConflictId: null });
  window.dohcDesktop = { listWorkspaceVersionConflicts } as unknown as typeof window.dohcDesktop;
  const openHistory = vi.fn(), openConflictReview = vi.fn();
  const view = renderHook(({ captureOn }: { captureOn: boolean }) => {
    const shell = useShellError("ws-1");
    const merges = useVersionMergeNotices({ workspaceId: "ws-1", captureOn, reportShellFailure: shell.reportShellFailure,
      clearIdentity: shell.clearIdentity, openHistory, openConflictReview });
    return { shell, merges };
  }, { initialProps: { captureOn: true } });
  const row = () => view.result.current.shell.shellErrors.find((error) => error.identity === IDENTITY);
  return { ...view, row, openHistory, openConflictReview, listWorkspaceVersionConflicts };
}

it("keeps a row that waits on decisions until a review or merge dialog closes with none of its files waiting", async () => {
  const f = mount([{ conflicts: [waiting], nextAfterConflictId: null }]);
  act(() => f.result.current.merges.report({ identity: IDENTITY, tone: "warning", title: "Merging Draft into Main needs a decision",
    message: "2 files have two copies.", decideFrom: "draft" }));
  expect(f.row()).toMatchObject({ noDismiss: true, action: { label: "Decide what to keep" } });
  act(() => f.result.current.shell.runShellErrorAction(f.row()!.id));
  expect(f.openConflictReview).toHaveBeenCalledOnce();
  // A later merge of the same version takes back only a failure's row.
  act(() => f.result.current.merges.clear(IDENTITY));
  expect(f.row()).toBeDefined();
  act(() => f.result.current.merges.settle());
  await waitFor(() => expect(f.listWorkspaceVersionConflicts).toHaveBeenCalledOnce());
  expect(f.row()).toBeDefined();
  act(() => f.result.current.merges.onMergeOpenChange(false));
  await waitFor(() => expect(f.row()).toBeUndefined());
  expect(f.listWorkspaceVersionConflicts).toHaveBeenCalledTimes(2);
});

it("lets a later merge take back a failure's row", () => {
  const f = mount();
  act(() => f.result.current.merges.report({ identity: IDENTITY, title: "dohc could not merge Draft into Main",
    message: "Disk full.", retry: () => undefined }));
  expect(f.row()).toBeDefined();
  act(() => f.result.current.merges.clear(IDENTITY));
  expect(f.row()).toBeUndefined();
});

it("puts Open History after Try again on a merge that stopped partway", () => {
  const f = mount();
  act(() => f.result.current.merges.report({ identity: IDENTITY, title: "dohc could not finish merging Draft into Main",
    message: "Some of Draft's changes are in Main, and History shows which.", retry: () => undefined, offersHistory: true }));
  expect(f.row()).toMatchObject({ action: { label: "Open History", afterRetry: true, reads: true } });
  act(() => f.result.current.shell.runShellErrorAction(f.row()!.id));
  expect(f.openHistory).toHaveBeenCalledOnce();
});

it("says why a merge row's Try again waits, while a merge dialog is open or capture is off", () => {
  const f = mount();
  expect(f.result.current.merges.retryBlocked).toBeUndefined();
  act(() => f.result.current.merges.onMergeOpenChange(true));
  expect(f.result.current.merges.retryBlocked).toBe(MERGE_RETRY_AFTER_CLOSE);
  act(() => f.result.current.merges.onMergeOpenChange(false));
  expect(f.result.current.merges.retryBlocked).toBeUndefined();
  f.rerender({ captureOn: false });
  expect(f.result.current.merges.retryBlocked).toBe(MERGE_RETRY_AFTER_STORE);
});
