// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ServerAccountDeletionPreview } from "@dohc/cli/account";
import { deferred } from "../testing/deferred";
import { makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";

type SessionEvent = { sessionKey: string | null; phase: "changing" | "ready" };
type DeleteResult =
  | { ok: true; finished: boolean; email: string; server: string }
  | { ok: false; code: "preview-changed" | "wrong-password" | "rate-limited"; reason: string };

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

    await act(async () => answer.resolve({ ok: true, finished, email: "me@dohc.test", server }));
    expect((await screen.findAllByText(notice)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("server-account-delete")).toBeNull();
    // Settings shows the signed-out page, and the workspace stays open.
    expect(await screen.findByTestId("settings-cloud-connect")).toBeTruthy();
    expect(screen.getByTestId("workspace-shell")).toBeTruthy();
    expect(bridge.cloudLogout).not.toHaveBeenCalled();
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
    await act(async () => answer.resolve({ ok: true, finished: true, email: "me@dohc.test", server }));
    expect((await screen.findAllByText(DELETED)).length).toBeGreaterThan(0);
  });

  it("reads the status again when the review is cancelled", async () => {
    const { bridge } = deletionBridge(async () => ({ ok: true, finished: true, email: "me@dohc.test", server }));
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
