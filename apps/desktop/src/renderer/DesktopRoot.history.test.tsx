// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { EngineMomentRecord, ShareHandoffStatus } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { timelinePage, type TimelinePage } from "../testing/historyPageFixture";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import { DesktopRoot } from "./DesktopRoot";
import type { Workspace } from "./DesktopWorkspaceShell";
import { makeBridge, OTHER_WORKSPACE, WORKSPACE } from "./DesktopWorkspaceShell.testHarness";

function historyPage(workspaceId: string, id: string, summary: string): TimelinePage {
  const moment: EngineMomentRecord = {
    id,
    versionId: "main",
    path: "notes/plan.md",
    recordedAtMs: 100,
    operation: "write",
    origin: "local-file",
    momentOrder: 1,
    summary,
  };
  return timelinePage([{ kind: "file", moment }], { workspaceId });
}

// The narrower shell test supplies the key itself. This one mounts the real
// DesktopRoot and the real shell, so the remount on a switch is the root's.
it("remounts the shell when main activates B and keeps A's late history answer out of B", async () => {
  const A_CONTROL = "A_CONTROL wrote the A plan";
  const A_STALE = "A_STALE answered after the switch";
  const B_ONLY = "B_ONLY wrote the B note";
  const heldA = deferred<TimelinePage>();
  let holdA = false;
  let activate: ((workspace: Workspace) => void) | null = null;
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    windowRole: "workspace" as const,
    getWorkspaceRegistry: vi.fn(async () => ({ workspaces: [WORKSPACE, OTHER_WORKSPACE] })),
    listNotices: vi.fn(async () => ({ account: null, notices: [] })),
    onNoticesChanged: vi.fn(() => () => undefined),
    onWorkspacePathOpenFailed: vi.fn(() => () => undefined),
    takeWorkspacePathOpenFailures: vi.fn(async () => []),
    onShareHandoffStatus: vi.fn(() => () => undefined),
    getShareHandoffStatus: vi.fn(async (): Promise<ShareHandoffStatus> => ({ status: "idle" })),
    onWorkspaceActivated: vi.fn((callback: (workspace: Workspace) => void) => {
      activate = callback;
      return () => {
        activate = null;
      };
    }),
  });
  // Each answer follows the workspace the read names, so a read from the wrong
  // workspace cannot come back with plausible B rows.
  bridge.listHistory = vi.fn(async (payload?: { workspaceId: string }) => {
    const workspaceId = payload?.workspaceId;
    if (workspaceId === OTHER_WORKSPACE.workspaceId) return historyPage(workspaceId, "m-b", B_ONLY);
    if (workspaceId !== WORKSPACE.workspaceId) throw new Error(`Unexpected workspace ${workspaceId}`);
    return holdA ? heldA.promise : historyPage(workspaceId, "m-a", A_CONTROL);
  });
  vi.stubGlobal("dohcDesktop", bridge);
  const user = userEvent.setup();
  render(
    <>
      <CollectionFieldWriteHost />
      <DesktopRoot />
    </>,
  );

  // A's answers paint in A: the control that makes the absence below mean
  // something.
  await user.click(await screen.findByTestId("activity-history"));
  expect(await screen.findByText(A_CONTROL)).toBeTruthy();
  const shellA = screen.getByTestId("workspace-shell");

  // A asks again, and that answer is held.
  holdA = true;
  const readsBeforeHold = bridge.listHistory.mock.calls.length;
  act(() => {
    bridge.emitWorkspaceActivity();
  });
  await waitFor(() =>
    expect(bridge.listHistory.mock.calls.length).toBeGreaterThan(readsBeforeHold),
  );
  expect(bridge.listHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspaceId: WORKSPACE.workspaceId }),
  );

  // Main activates B in this window, and B paints its own history.
  expect(activate).not.toBeNull();
  act(() => {
    activate?.(OTHER_WORKSPACE);
  });
  await waitFor(() => {
    const shell = screen.getByTestId("workspace-shell");
    expect(shell).not.toBe(shellA);
    expect(shell.dataset.ready).toBe("true");
  });
  // The root mounted a new shell for B; A's shell left the document.
  expect(shellA.isConnected).toBe(false);
  await user.click(screen.getByTestId("activity-history"));
  expect(await screen.findByText(B_ONLY)).toBeTruthy();
  expect(screen.queryByText(A_CONTROL)).toBeNull();

  // Only now does A's held answer land, and the renderer consumes it.
  await act(async () => {
    heldA.resolve(historyPage(WORKSPACE.workspaceId, "m-a-stale", A_STALE));
    await heldA.promise;
  });
  await act(async () => {});

  expect(screen.queryByText(A_STALE)).toBeNull();
  expect(screen.queryByText(A_CONTROL)).toBeNull();
  expect(screen.getByText(B_ONLY)).toBeTruthy();
  expect(screen.getAllByTestId("engine-moment-open")).toHaveLength(1);
});
