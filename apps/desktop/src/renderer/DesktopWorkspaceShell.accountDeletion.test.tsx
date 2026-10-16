// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ServerAccountDeletionPreview, ServerAccountDeleteResult } from "@dohc/cli/account";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { CollectionFieldWriteHost } from "./collections/recordFieldWrites";
import { DesktopRoot } from "./DesktopRoot";
import type { Workspace } from "./DesktopWorkspaceShell";
import { makeBridge, OTHER_WORKSPACE, renderShell, WORKSPACE } from "./DesktopWorkspaceShell.testHarness";

type SessionEvent = { sessionKey: string | null; phase: "changing" | "ready" };
type DeleteResult = ServerAccountDeleteResult;

// Kept across tests: the account row counts sign-ins with one listener for the
// life of the window, registered on the first bridge that asks.
const sessionListeners = new Set<(event: SessionEvent) => void>();
function announceSession(sessionKey: string | null) {
  act(() => {
    for (const listener of [...sessionListeners]) listener({ sessionKey, phase: "ready" });
  });
}

const server = "https://cloud.dohc.test";
const SIGNED_IN = { connected: true, email: "me@dohc.test", serverUrl: server, workspaceSynced: false };
const SIGNED_OUT = { connected: false, email: "", serverUrl: "", workspaceSynced: false };
const preview: ServerAccountDeletionPreview = {
  email: "me@dohc.test", server, workspaces: [{ workspaceId: "ws-notes", name: "Notes" }],
  workspacesElsewhere: 0, storedBytes: 1024, ownedShareCount: 0, heldGrantCount: 0, previewToken: "token-1",
};
const DELETED = `Deleted me@dohc.test on ${server}. Workspaces on this computer stay.`;

function deletionBridge(deleteAccount: () => Promise<DeleteResult>) {
  let signedIn = true;
  const bridge = Object.assign(makeBridge(Promise.resolve(null)), {
    previewServerAccountDeletion: vi.fn(async () => preview),
    deleteServerAccount: vi.fn(deleteAccount),
    retryServerAccountDisconnect: vi.fn(async (_input: Record<string, never>): Promise<null> => null),
    cloudLogout: vi.fn(async () => undefined),
  });
  bridge.onCloudSessionChanged = vi.fn((listener: (event: SessionEvent) => void) => {
    sessionListeners.add(listener);
    return () => { sessionListeners.delete(listener); };
  });
  bridge.cloudStatus = vi.fn(async () => (signedIn ? SIGNED_IN : SIGNED_OUT));
  // Main's own disconnect after the server deleted the account: it announces
  // the logout before the delete answers.
  const disconnect = () => {
    signedIn = false;
    announceSession(null);
  };
  return { bridge, disconnect };
}

async function openSyncSettings() {
  fireEvent.click(await screen.findByTestId("activity-settings"));
  fireEvent.click(await screen.findByTestId("settings-nav-cloud"));
  return screen.findByTestId("settings-row-account");
}

async function sendDelete(bridge: ReturnType<typeof deletionBridge>["bridge"]) {
  fireEvent.click(within(await openSyncSettings()).getByTestId("cloud-delete-account"));
  await screen.findByTestId("server-account-delete-scope");
  fireEvent.change(screen.getByTestId("server-account-delete-password"), { target: { value: "correct horse" } });
  fireEvent.click(screen.getByTestId("server-account-delete-confirm"));
  await waitFor(() => expect(bridge.deleteServerAccount).toHaveBeenCalledTimes(1));
}

// The review opens from Settings' account row, but the shell owns it: the
// deletion's own disconnect drops the shell's status and the row, and the
// answer still arrives.
describe("deleting the server account from Settings", () => {
  it.each([
    [true, DELETED],
    [false, `${server} blocked me@dohc.test and will finish deleting its data. Workspaces on this computer stay.`],
  ])("reports the answer after its disconnect removed the account row (finished: %s)", async (finished, notice) => {
    const answer = deferred<DeleteResult>();
    const { bridge, disconnect } = deletionBridge(() => answer.promise);
    renderShell(bridge);
    await sendDelete(bridge);

    disconnect();
    await waitFor(() => expect(screen.queryByTestId("settings-row-account")).toBeNull());
    expect(screen.getByTestId("server-account-delete")).toBeTruthy();

    await act(async () => answer.resolve({ ok: true, finished, email: "me@dohc.test", server, disconnectError: null }));
    expect((await screen.findAllByText(notice)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("server-account-delete")).toBeNull();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    // Settings shows the signed-out page, and the workspace stays open.
    expect(await screen.findByTestId("settings-cloud-connect")).toBeTruthy();
    expect(screen.getByTestId("workspace-shell")).toBeTruthy();
    expect(bridge.cloudLogout).not.toHaveBeenCalled();
  });

  it("keeps the deletion's message and reports a failed disconnect, whose Try again disconnects again", async () => {
    const DISCONNECT_FAILED = `dohc could not finish disconnecting from ${server}.`;
    const answer = deferred<DeleteResult>();
    const { bridge, disconnect } = deletionBridge(() => answer.promise);
    bridge.retryServerAccountDisconnect.mockRejectedValueOnce(new Error("store still failed"));
    renderShell(bridge);
    await sendDelete(bridge);

    disconnect();
    await act(async () => answer.resolve({ ok: true, finished: true, email: "me@dohc.test", server, disconnectError: "store failed" }));
    // The toast shows the failure, and Notices keeps the deletion's message.
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(DISCONNECT_FAILED);
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(within(await screen.findByTestId("notice-center")).getAllByText(DELETED).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    await screen.findByTestId("notice-toasts");
    expect(bridge.retryServerAccountDisconnect).not.toHaveBeenCalled();

    // The first retry fails too, so the notice comes back with Try again.
    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    expect(bridge.retryServerAccountDisconnect).toHaveBeenCalledWith({});
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(DISCONNECT_FAILED);
    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    expect(bridge.retryServerAccountDisconnect).toHaveBeenCalledTimes(2);
    await act(async () => {});
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("does nothing on an old notice's Try again while a delete is pending", async () => {
    const answer = deferred<DeleteResult>();
    const { bridge, disconnect } = deletionBridge(() => answer.promise);
    bridge.cloudLogout.mockRejectedValueOnce(new Error("dohc could not finish disconnecting."));
    renderShell(bridge);
    fireEvent.click(within(await openSyncSettings()).getByTestId("cloud-disconnect"));
    await screen.findByTestId("workspace-shell-error");
    await waitFor(() => expect((screen.getByTestId("cloud-disconnect") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByTestId("cloud-delete-account"));
    await screen.findByTestId("server-account-delete-scope");
    fireEvent.change(screen.getByTestId("server-account-delete-password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));
    await waitFor(() => expect(bridge.deleteServerAccount).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await act(async () => {});
    expect(bridge.cloudLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("cloud-sync-panel")).toBeNull();
    expect(screen.getByTestId("server-account-delete")).toBeTruthy();

    disconnect();
    await act(async () => answer.resolve({ ok: true, finished: true, email: "me@dohc.test", server, disconnectError: null }));
    expect((await screen.findAllByText(DELETED)).length).toBeGreaterThan(0);
  });

  it.each([false, true])("does not retry a sync change during deletion review (synced: %s)", async synced => {
    const { bridge } = deletionBridge(async () => ({ ok: true, finished: true, email: "me@dohc.test", server, disconnectError: null }));
    const changeSync = vi.fn(async () => { throw new Error("dohc could not change this workspace's sync."); });
    Object.assign(bridge, { cloudEnableSync: changeSync, cloudStopSync: changeSync });
    bridge.cloudStatus = vi.fn(async () => ({ ...SIGNED_IN, workspaceSynced: synced, workspaceSyncConnected: synced }));
    renderShell(bridge);
    await openSyncSettings();
    fireEvent.click(screen.getByRole("switch", { name: "Sync this workspace" }));
    await screen.findByTestId("workspace-shell-error");

    fireEvent.click(screen.getByTestId("cloud-delete-account"));
    await screen.findByTestId("server-account-delete-scope");
    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await act(async () => {});

    expect(changeSync).toHaveBeenCalledTimes(1);
    expect(bridge.cloudLogout).not.toHaveBeenCalled();
    expect(bridge.deleteServerAccount).not.toHaveBeenCalled();
    expect(screen.getByTestId("server-account-delete")).toBeTruthy();
  });

  it("reads the status again when the review is cancelled", async () => {
    const { bridge } = deletionBridge(async () => ({ ok: true, finished: true, email: "me@dohc.test", server, disconnectError: null }));
    renderShell(bridge);
    fireEvent.click(within(await openSyncSettings()).getByTestId("cloud-delete-account"));
    await screen.findByTestId("server-account-delete-scope");
    const reads = vi.mocked(bridge.cloudStatus).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("server-account-delete")).toBeNull();
    await waitFor(() => expect(bridge.cloudStatus).toHaveBeenCalledTimes(reads + 1));
    expect(screen.getByTestId("settings-row-account")).toBeTruthy();
    expect(bridge.deleteServerAccount).not.toHaveBeenCalled();
  });

  it("sends a failed delete to the toast, whose Try again opens a new review", async () => {
    const { bridge } = deletionBridge(async () => {
      throw new Error("dohc could not reach this server.");
    });
    renderShell(bridge);
    await sendDelete(bridge);

    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("dohc could not reach this server.");
    expect(screen.queryByTestId("server-account-delete")).toBeNull();

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await screen.findByTestId("server-account-delete-scope");
    expect(bridge.previewServerAccountDeletion).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId("server-account-delete-password") as HTMLInputElement).value).toBe("");
  });

  // The notice names one account. A Try again after someone signed in reviews
  // no account at all: Settings shows the session now.
  it("opens no review from a failed delete's Try again after another sign-in", async () => {
    const { bridge } = deletionBridge(async () => {
      throw new Error("dohc could not reach this server.");
    });
    renderShell(bridge);
    await sendDelete(bridge);
    await screen.findByTestId("workspace-shell-error");

    announceSession(`${server}##usr_b`);
    await screen.findByTestId("settings-row-account");
    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await act(async () => {});

    expect(screen.queryByTestId("server-account-delete")).toBeNull();
    expect(bridge.previewServerAccountDeletion).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("settings-section-cloud")).toBeTruthy();
  });
});

// File ▸ Open Workspace… while a delete is pending: the real DesktopRoot
// remounts the shell for the other workspace, and the answer reports there.
describe("a workspace switch while a delete is pending", () => {
  function renderRoot(deleteAccount: () => Promise<DeleteResult>) {
    const { bridge, disconnect } = deletionBridge(deleteAccount);
    let registry: Workspace[] = [WORKSPACE, OTHER_WORKSPACE];
    let activate: ((workspace: Workspace) => void) | null = null;
    const root = Object.assign(bridge, {
      windowRole: "workspace" as const,
      getWorkspaceRegistry: vi.fn(async () => ({ workspaces: registry })),
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
      pickWorkspaceRoot: vi.fn(async () => OTHER_WORKSPACE.rootPath),
      attachWorkspaceFolder: vi.fn(async () => OTHER_WORKSPACE),
      getDefaultWorkspaceRoot: vi.fn(async () => "/home/sam/dohc/new"),
    });
    vi.stubGlobal("dohcDesktop", root);
    render(
      <>
        <CollectionFieldWriteHost />
        <DesktopRoot />
      </>,
    );
    return {
      bridge: root,
      disconnect,
      // Every workspace leaves the registry, as a Forget in the manager window does.
      forgetAll: async () => {
        registry = [];
        await act(async () => root.emitWorkspaceActivity());
      },
      activate: (workspace: Workspace) => act(() => activate?.(workspace)),
    };
  }

  async function switchWhileDeleting(bridge: ReturnType<typeof renderRoot>["bridge"]) {
    await sendDelete(bridge);
    const shellA = screen.getByTestId("workspace-shell");
    act(() => bridge.emitMenuCommand("open-workspace"));
    await waitFor(() => {
      const shell = screen.getByTestId("workspace-shell");
      expect(shell).not.toBe(shellA);
      expect(shell.dataset.ready).toBe("true");
    });
    expect(bridge.attachWorkspaceFolder).toHaveBeenCalledTimes(1);
    expect(shellA.isConnected).toBe(false);
    // The sent delete stays on screen over the other workspace.
    expect(screen.getByTestId("server-account-delete-confirm").textContent).toBe("Deleting…");
  }

  it.each([
    [true, DELETED],
    [false, `${server} blocked me@dohc.test and will finish deleting its data. Workspaces on this computer stay.`],
  ])("reports the answer in the workspace switched to (finished: %s)", async (finished, notice) => {
    const answer = deferred<DeleteResult>();
    const { bridge, disconnect } = renderRoot(() => answer.promise);
    await switchWhileDeleting(bridge);
    const shellB = screen.getByTestId("workspace-shell");

    disconnect();
    await act(async () => answer.resolve({ ok: true, finished, email: "me@dohc.test", server, disconnectError: null }));
    expect((await screen.findAllByText(notice)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("server-account-delete")).toBeNull();
    expect(screen.getByTestId("workspace-shell")).toBe(shellB);
  });

  it("reports a failure in the workspace switched to, whose Try again opens a new review", async () => {
    const answer = deferred<DeleteResult>();
    const { bridge } = renderRoot(() => answer.promise);
    await switchWhileDeleting(bridge);

    await act(async () => answer.reject(new Error("dohc could not reach this server.")));
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("dohc could not reach this server.");
    expect(screen.queryByTestId("server-account-delete")).toBeNull();

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await screen.findByTestId("server-account-delete-scope");
    expect(bridge.previewServerAccountDeletion).toHaveBeenCalledTimes(2);
  });

  it("holds the answer through first run and reports it in the next workspace that opens", async () => {
    const answer = deferred<DeleteResult>();
    const { bridge, disconnect, forgetAll, activate } = renderRoot(() => answer.promise);
    await sendDelete(bridge);

    await forgetAll();
    await waitFor(() => expect(screen.queryByTestId("workspace-shell")).toBeNull());
    expect(screen.getByTestId("server-account-delete-confirm").textContent).toBe("Deleting…");

    disconnect();
    await act(async () => answer.resolve({ ok: true, finished: true, email: "me@dohc.test", server, disconnectError: null }));
    expect(screen.queryByTestId("server-account-delete")).toBeNull();

    activate(OTHER_WORKSPACE);
    await screen.findByTestId("workspace-shell");
    expect((await screen.findAllByText(DELETED)).length).toBeGreaterThan(0);
  });
});
