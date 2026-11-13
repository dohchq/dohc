// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import {
  DesktopWorkspaceShell,
  OTHER_WORKSPACE,
  WORKSPACE,
  makeBridge,
  renderShell,
  shellBootstrapProps,
} from "./DesktopWorkspaceShell.testHarness";
import type { CaptureFileHold, SyncStatusResult } from "../ipc/bridgeContract";

const held = {
  workspaceId: WORKSPACE.workspaceId,
  sourceVersionId: "main",
  objectId: "held-object",
  path: "notes/held.md",
  observedSha256: "digest",
  observedSize: 4,
  reason: "ydoc-resolution-not-representable" as const,
  observedAtMs: 1,
  attemptCount: 1,
  retryRequested: false,
};
const message =
  "dohc did not record the outside edit to \"notes/held.md\". dohc cannot take in this file's Markdown. Causes include nested lists in workspaces that sync, or deeply nested quotes. The file on this computer still has the outside edit. Copy the outside edit first. Restore the file's exact contents from before that edit. If dohc still cannot take in the file, add a newline at the end. For nested lists, make the edit in dohc after the file opens again.";

function fixture() {
  const bridge = makeBridge(Promise.resolve(null));
  let files = [held];
  const original = bridge.getSyncStatus.getMockImplementation()!;
  bridge.getSyncStatus.mockImplementation(async () => ({
    ...(await original()),
    heldFiles: files,
  }));
  const retryHeldCapture = vi.fn(async () => {
    listener?.({ workspaceId: WORKSPACE.workspaceId, heldFiles: files });
    return {
      deferredWrites: [],
      settled: true,
      running: true,
      degraded: false,
      retried: true,
      heldFiles: files,
    };
  });
  Object.assign(bridge, { retryHeldCapture });
  let listener:
    | ((event: { workspaceId: string; heldFiles: CaptureFileHold[] }) => void)
    | undefined;
  Object.assign(bridge, {
    onCaptureHolds: vi.fn((callback: typeof listener) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    }),
  });
  return {
    bridge,
    retryHeldCapture,
    emit: (heldFiles: CaptureFileHold[], workspaceId = WORKSPACE.workspaceId) =>
      listener?.({ workspaceId, heldFiles }),
    clear: () => {
      files = [];
    },
    set: (value: typeof files) => {
      files = value;
    },
  };
}

it("publishes idle hold changes without another status read and ignores another workspace's event", async () => {
  const f = fixture();
  f.clear();
  renderShell(f.bridge);
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

it("Try again retries this path and removes the notice when the hold clears", async () => {
  const f = fixture();
  const user = userEvent.setup();
  renderShell(f.bridge);
  const toast = await screen.findByTestId("workspace-shell-notice");
  f.clear();
  await user.click(within(toast).getByRole("button", { name: "Try again" }));
  expect(f.retryHeldCapture).toHaveBeenCalledExactlyOnceWith({
    workspaceId: WORKSPACE.workspaceId,
    path: held.path,
  });
  await waitFor(() => expect(screen.queryByTestId("workspace-shell-notice")).toBeNull());
  await user.click(screen.getByTestId("notice-center-toggle"));
  expect(screen.queryByText(message)).toBeNull();
});

it.each([{ staleFiles: [] }, { staleFiles: [held] }])(
  "ignores a stale status containing $staleFiles after a workspace switch",
  async ({ staleFiles }) => {
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
    view.rerender(
      <DesktopWorkspaceShell
        workspace={OTHER_WORKSPACE}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(f.bridge)}
        onSwitchWorkspace={() => {}}
      />,
    );
    await screen.findByText(
      "dohc did not record the outside edit to \"other.md\". dohc cannot take in this file's Markdown. Causes include nested lists in workspaces that sync, or deeply nested quotes. The file on this computer still has the outside edit. Copy the outside edit first. Restore the file's exact contents from before that edit. If dohc still cannot take in the file, add a newline at the end. For nested lists, make the edit in dohc after the file opens again.",
    );
    const current = await f.bridge.getSyncStatus();
    await act(async () => stale.resolve({ ...current, heldFiles: staleFiles }));
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.getByTestId("workspace-shell-notice").textContent).toContain('"other.md"');
  },
);

it("ignores a retry that answers after leaving and reopening the same workspace", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const view = renderShell(f.bridge);
  const toast = await screen.findByTestId("workspace-shell-notice");
  const stale = deferred<Awaited<ReturnType<typeof f.retryHeldCapture>>>();
  f.retryHeldCapture.mockImplementationOnce(() => stale.promise);
  await user.click(within(toast).getByRole("button", { name: "Try again" }));
  const shell = (workspace: typeof WORKSPACE) => (
    <DesktopWorkspaceShell
      workspace={workspace}
      workspaces={[WORKSPACE, OTHER_WORKSPACE]}
      {...shellBootstrapProps(f.bridge)}
      onSwitchWorkspace={() => {}}
    />
  );
  f.clear();
  view.rerender(shell(OTHER_WORKSPACE));
  await waitFor(() => expect(screen.queryByText(message)).toBeNull());
  f.set([held]);
  view.rerender(shell(WORKSPACE));
  await screen.findByText(message);
  await act(async () =>
    stale.resolve({
      deferredWrites: [],
      settled: true,
      running: true,
      degraded: false,
      retried: true,
      heldFiles: [],
    }),
  );
  expect(screen.getByTestId("workspace-shell-notice").textContent).toContain(message);
});
