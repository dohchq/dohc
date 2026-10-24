// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { DesktopWorkspaceShell, OTHER_WORKSPACE, WORKSPACE, makeBridge, renderShell, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";
import type { CaptureFileHold, SyncStatusResult } from "../ipc/bridgeContract";

const held = { workspaceId: WORKSPACE.workspaceId, sourceVersionId: "main", objectId: "held-object", path: "notes/held.md",
  observedSha256: "digest", observedSize: 4, reason: "ydoc-resolution-not-representable" as const,
  observedAtMs: 1, attemptCount: 1, retryRequested: false };
const message = 'dohc did not record the outside edit to "notes/held.md". dohc cannot take in this file\'s Markdown. Causes include nested lists in workspaces that sync, or deeply nested quotes. The file on this computer still has the outside edit. Restore the file\'s exact contents from before that edit. For nested lists, make the edit in dohc after the file opens again.';

function fixture() {
  const bridge = makeBridge(Promise.resolve(null));
  let files = [held];
  const original = bridge.getSyncStatus.getMockImplementation()!;
  bridge.getSyncStatus.mockImplementation(async () => ({ ...await original(), heldFiles: files }));
  const retryHeldCapture = vi.fn(async () => { listener?.({ workspaceId: WORKSPACE.workspaceId, heldFiles: files }); return { deferredWrites: [], settled: true, running: true, degraded: false, retried: true, heldFiles: files }; });
  Object.assign(bridge, { retryHeldCapture });
  let listener: ((event: { workspaceId: string; heldFiles: CaptureFileHold[] }) => void) | undefined;
  Object.assign(bridge, { onCaptureHolds: vi.fn((callback: typeof listener) => {
    listener = callback;
    return () => { listener = undefined; };
  }) });
  return { bridge, retryHeldCapture, emit: (heldFiles: CaptureFileHold[], workspaceId = WORKSPACE.workspaceId) => listener?.({ workspaceId, heldFiles }), clear: () => { files = []; }, set: (value: typeof files) => { files = value; } };
}

it("publishes idle hold changes without another status read and ignores another workspace's event", async () => {
  const f = fixture(); f.clear(); renderShell(f.bridge);
  await waitFor(() => expect(f.bridge.getCaptureRecoveryStatus).toHaveBeenCalled());
  const syncReads = f.bridge.getSyncStatus.mock.calls.length;
  const recoveryReads = f.bridge.getCaptureRecoveryStatus.mock.calls.length;
  act(() => f.emit([held]));
  await screen.findByText(message);
  act(() => f.emit([], OTHER_WORKSPACE.workspaceId));
  expect(screen.getByText(message)).toBeTruthy();
  expect(f.bridge.getSyncStatus.mock.calls.length).toBe(syncReads);
  expect(f.bridge.getCaptureRecoveryStatus.mock.calls.length).toBe(recoveryReads);
  act(() => f.emit([]));
  await waitFor(() => expect(screen.queryByText(message)).toBeNull());
});

it("lands an in-flight status read without replacing a newer held event", async () => {
  const f = fixture(); f.clear(); renderShell(f.bridge);
  await waitFor(() => expect(f.bridge.getCaptureRecoveryStatus).toHaveBeenCalled());
  const current = await f.bridge.getSyncStatus();
  const stale = deferred<SyncStatusResult>();
  f.bridge.getSyncStatus.mockImplementationOnce(() => stale.promise);
  const calls = f.bridge.getSyncStatus.mock.calls.length;
  act(() => f.bridge.emitWorkspaceActivity());
  await waitFor(() => expect(f.bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(calls));
  act(() => f.emit([held]));
  await screen.findByText(message);
  await act(async () => stale.resolve({ ...current, heldFiles: [], state: "sync-failed",
    syncFailure: { cause: "server-unreachable", detail: "offline", sinceMs: 1, attempts: 1 } }));
  const user = userEvent.setup();
  await user.click(screen.getByTestId("notice-center-toggle"));
  expect(await screen.findByText("dohc could not reach the server.")).toBeTruthy();
  expect(screen.getAllByText(message).length).toBeGreaterThan(0);
});

it("keeps a hold event received while the workspace is opening", async () => {
  const f = fixture(); f.clear();
  const opening = deferred<SyncStatusResult>();
  f.bridge.openWorkspace.mockImplementationOnce(() => opening.promise);
  renderShell(f.bridge);
  await waitFor(() => expect(f.bridge.openWorkspace).toHaveBeenCalled());
  act(() => f.emit([held]));
  const current = await f.bridge.getSyncStatus();
  await act(async () => opening.resolve(current));
  await screen.findByText(message);
});

it("keeps one row per held path and offers each toast once in the existing queue", async () => {
  const f = fixture(); f.set([held, { ...held, objectId: "second", path: "second.md" }]);
  const user = userEvent.setup(); renderShell(f.bridge);
  const second = await screen.findByTestId("workspace-shell-notice");
  expect(second.textContent).toContain('"second.md"');
  await user.click(within(second).getByRole("button", { name: "Dismiss workspace notice" }));
  expect(screen.getByTestId("workspace-shell-notice").textContent).toContain(message);
  await user.click(screen.getByTestId("notice-center-toggle"));
  const rows = screen.getAllByRole("listitem").filter(row => row.hasAttribute("data-notice-row") && row.textContent?.includes("Outside edit not recorded"));
  expect(rows).toHaveLength(2);
});

it("files one held-file toast and one Notices row with adjacent copy and Try again", async () => {
  const f = fixture(); const user = userEvent.setup(); renderShell(f.bridge);
  const toast = await screen.findByTestId("workspace-shell-notice");
  expect(toast.textContent).toContain(message);
  expect(screen.getAllByTestId("workspace-shell-notice")).toHaveLength(1);
  expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(within(toast).getByRole("button", { name: /Copy/ })).toBeTruthy();
  act(() => f.bridge.emitWorkspaceActivity());
  await waitFor(() => expect(f.bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(1));
  await user.click(screen.getByTestId("notice-center-toggle"));
  const rows = screen.getAllByRole("listitem").filter(row => row.hasAttribute("data-notice-row"));
  expect(rows.filter(row => row.textContent?.includes(message))).toHaveLength(1);
  expect(within(rows.find(row => row.textContent?.includes(message))!).getByRole("button", { name: /Copy/ })).toBeTruthy();
});

it("Try again retries this path and removes the notice when the hold clears", async () => {
  const f = fixture(); const user = userEvent.setup(); renderShell(f.bridge);
  const toast = await screen.findByTestId("workspace-shell-notice");
  f.clear();
  await user.click(within(toast).getByRole("button", { name: "Try again" }));
  expect(f.retryHeldCapture).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE.workspaceId, path: held.path });
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-notice")).toBeNull());
  await user.click(screen.getByTestId("notice-center-toggle"));
  expect(screen.queryByText(message)).toBeNull();
});

it.each(["editing", "deleting", "renaming"])("removes a notice after %s releases its hold", async () => {
  const f = fixture(); const user = userEvent.setup(); renderShell(f.bridge);
  await screen.findByTestId("workspace-shell-notice");
  await user.click(screen.getByTestId("notice-center-toggle"));
  f.clear(); act(() => f.bridge.emitWorkspaceActivity());
  await waitFor(() => expect(screen.queryByText(message)).toBeNull());
  expect(f.retryHeldCapture).not.toHaveBeenCalled();
});

it("keeps the notice when an unchanged retry is still held", async () => {
  const f = fixture(); const user = userEvent.setup(); renderShell(f.bridge);
  const toast = await screen.findByTestId("workspace-shell-notice");
  await user.click(within(toast).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(f.retryHeldCapture).toHaveBeenCalledOnce());
  await user.click(screen.getByTestId("notice-center-toggle"));
  expect(screen.getAllByText(message).length).toBeGreaterThan(0);
});

it.each([{ staleFiles: [] }, { staleFiles: [held] }])("ignores a stale status containing $staleFiles after a workspace switch", async ({ staleFiles }) => {
  const f = fixture();
  const view = renderShell(f.bridge);
  await screen.findByTestId("workspace-shell-notice");
  const stale = deferred<SyncStatusResult>();
  f.bridge.getSyncStatus.mockImplementationOnce(() => stale.promise);
  const calls = f.bridge.getSyncStatus.mock.calls.length;
  act(() => f.bridge.emitWorkspaceActivity());
  await waitFor(() => expect(f.bridge.getSyncStatus.mock.calls.length).toBeGreaterThan(calls));
  const other = { ...held, workspaceId: OTHER_WORKSPACE.workspaceId, path: "other.md" };
  f.set([other]);
  view.rerender(<DesktopWorkspaceShell workspace={OTHER_WORKSPACE} workspaces={[WORKSPACE, OTHER_WORKSPACE]} {...shellBootstrapProps(f.bridge)} onSwitchWorkspace={() => {}} />);
  await screen.findByText('dohc did not record the outside edit to "other.md". dohc cannot take in this file\'s Markdown. Causes include nested lists in workspaces that sync, or deeply nested quotes. The file on this computer still has the outside edit. Restore the file\'s exact contents from before that edit. For nested lists, make the edit in dohc after the file opens again.');
  const current = await f.bridge.getSyncStatus();
  await act(async () => stale.resolve({ ...current, heldFiles: staleFiles }));
  expect(screen.queryByText(message)).toBeNull();
  expect(screen.getByTestId("workspace-shell-notice").textContent).toContain('"other.md"');
});

it("ignores a retry that answers after leaving and reopening the same workspace", async () => {
  const f = fixture(); const user = userEvent.setup(); const view = renderShell(f.bridge);
  const toast = await screen.findByTestId("workspace-shell-notice");
  const stale = deferred<Awaited<ReturnType<typeof f.retryHeldCapture>>>();
  f.retryHeldCapture.mockImplementationOnce(() => stale.promise);
  await user.click(within(toast).getByRole("button", { name: "Try again" }));
  const shell = (workspace: typeof WORKSPACE) => <DesktopWorkspaceShell workspace={workspace} workspaces={[WORKSPACE, OTHER_WORKSPACE]} {...shellBootstrapProps(f.bridge)} onSwitchWorkspace={() => {}} />;
  f.clear(); view.rerender(shell(OTHER_WORKSPACE));
  await waitFor(() => expect(screen.queryByText(message)).toBeNull());
  f.set([held]); view.rerender(shell(WORKSPACE));
  await screen.findByText(message);
  await act(async () => stale.resolve({ deferredWrites: [], settled: true, running: true, degraded: false, retried: true, heldFiles: [] }));
  expect(screen.getByTestId("workspace-shell-notice").textContent).toContain(message);
});

it.each([true, false])("keeps an unfinished healthy retry out of degraded capture notices (running=%s)", async running => {
  const f = fixture(); const user = userEvent.setup(); renderShell(f.bridge);
  const toast = await screen.findByTestId("workspace-shell-notice");
  f.retryHeldCapture.mockResolvedValueOnce({ deferredWrites: [], settled: false, running, degraded: false, retried: true, heldFiles: [held] });
  await user.click(within(toast).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(f.retryHeldCapture).toHaveBeenCalledOnce());
  await user.click(screen.getByTestId("notice-center-toggle"));
  const rows = screen.getAllByRole("listitem").filter(row => row.hasAttribute("data-notice-row"));
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain(message);
});

it("reports genuine degraded capture after retry", async () => {
  const f = fixture(); const user = userEvent.setup(); renderShell(f.bridge);
  const toast = await screen.findByTestId("workspace-shell-notice");
  f.retryHeldCapture.mockResolvedValueOnce({ deferredWrites: [], settled: false, running: true, degraded: true, retried: true, heldFiles: [held] });
  await user.click(within(toast).getByRole("button", { name: "Try again" }));
  await screen.findByText("dohc could not record outside edits. Reopen the workspace.");
});
