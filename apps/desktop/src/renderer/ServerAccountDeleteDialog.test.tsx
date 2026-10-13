// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAccountDeletionPreview } from "@dohc/cli/account";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { CloudLogin } from "./CloudLogin";
import { ServerAccountDeleteDialog } from "./ServerAccountDeleteDialog";
import { deferred } from "../testing/deferred";

type SessionListener = Parameters<DohcDesktopBridge["onCloudSessionChanged"]>[0];
const sessionListeners = new Set<SessionListener>();
const bridgeMock = {
  cloudStatus: vi.fn(),
  cloudLogout: vi.fn(),
  previewServerAccountDeletion: vi.fn(),
  deleteServerAccount: vi.fn(),
  platform: "linux",
  getUpdateState: vi.fn(),
  onUpdateState: vi.fn(),
  onCloudSessionChanged: (listener: SessionListener) => {
    sessionListeners.add(listener);
    return () => { sessionListeners.delete(listener); };
  },
};

// What main broadcasts when another window signs in, switches, or disconnects.
function changeSession(sessionKey: string | null) {
  act(() => {
    for (const listener of [...sessionListeners]) listener({ sessionKey, phase: "ready" });
  });
}

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

const server = "https://dohc.example.test";
const preview: ServerAccountDeletionPreview = {
  email: "ice@dohc.dev", server,
  workspaces: [{ workspaceId: "ws-notes", name: "Notes" }, { workspaceId: "ws-trip", name: "Trip to Lisbon" }],
  workspacesElsewhere: 2, storedBytes: 5 * 1024 * 1024, ownedShareCount: 3, heldGrantCount: 1,
  previewToken: "token-1",
};
const connected = { connected: true, email: "ice@dohc.dev", serverUrl: server, workspaceSynced: false };

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue(connected);
  bridgeMock.previewServerAccountDeletion.mockResolvedValue(preview);
  bridgeMock.getUpdateState.mockResolvedValue({ status: "idle", message: "Up to date" });
  bridgeMock.onUpdateState.mockReturnValue(() => undefined);
});

afterEach(() => {
  cleanup();
  sessionListeners.clear();
});

function renderDialog(overrides: Partial<Parameters<typeof ServerAccountDeleteDialog>[0]> = {}) {
  const props = {
    email: "ice@dohc.dev", server,
    onClose: vi.fn(), onDeleted: vi.fn(), onError: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ServerAccountDeleteDialog {...props} />) };
}

function typePassword(value: string) {
  fireEvent.change(screen.getByTestId("server-account-delete-password"), { target: { value } });
}

describe("ServerAccountDeleteDialog", () => {
  it("names what the server deletes and what stays before it asks for the password", async () => {
    renderDialog();
    const scope = await screen.findByTestId("server-account-delete-scope");
    const dialog = screen.getByRole("dialog");

    expect(screen.getByText("Delete ice@dohc.dev on this server?")).toBeTruthy();
    expect(screen.getByTestId("server-account-delete-server").textContent).toBe(server);
    expect([...scope.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
      "Notes", "Trip to Lisbon", "2 workspaces not on this computer",
    ]);
    expect(screen.getByTestId("server-account-delete-size").textContent).toBe("5.0 MB of files, data, apps, chats, and history");
    expect(screen.getByTestId("server-account-delete-shares").textContent).toBe(
      "3 shares you own end. People you shared with lose access and keep their copies.",
    );
    // The server counts revoked grants too, so the dialog names no number.
    expect(screen.getByTestId("server-account-delete-grants").textContent).toBe("Your access to shares others gave you ends.");
    expect(dialog.textContent).toContain("Workspaces on this computer stay, with their files.");
    expect(dialog.textContent).toContain(
      "This cannot be undone. If you create an account again later, this server will not accept your old copies of these workspaces.",
    );
    expect(dialog.textContent).toContain("The server's backups keep this data until they expire.");
    expect(dialog.textContent).not.toMatch(/\d+ days/);

    const confirm = screen.getByTestId("server-account-delete-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    typePassword("correct horse");
    expect(confirm.disabled).toBe(false);
  });

  it("deletes with the reviewed token and the typed password", async () => {
    bridgeMock.deleteServerAccount.mockResolvedValue({ ok: true, finished: true, email: "ice@dohc.dev", server });
    const { props } = renderDialog();
    await screen.findByTestId("server-account-delete-scope");
    typePassword("correct horse");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));

    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith({ finished: true, email: "ice@dohc.dev", server }));
    expect(bridgeMock.deleteServerAccount).toHaveBeenCalledWith({ server, previewToken: "token-1", password: "correct horse" });
  });

  it("shows a fresh review when what deletion removes changed", async () => {
    bridgeMock.previewServerAccountDeletion
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...preview, workspacesElsewhere: 3, previewToken: "token-2" });
    bridgeMock.deleteServerAccount.mockResolvedValue({ ok: false, code: "preview-changed", reason: "Review it again." });
    const { props } = renderDialog();
    await screen.findByTestId("server-account-delete-scope");
    typePassword("correct horse");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));

    expect((await screen.findByTestId("server-account-delete-changed")).textContent).toBe(
      "What deletion removes changed, or the review expired. Check it again.",
    );
    expect((await screen.findByTestId("server-account-delete-elsewhere")).textContent).toBe("3 workspaces not on this computer");
    expect((screen.getByTestId("server-account-delete-password") as HTMLInputElement).value).toBe("");
    expect(bridgeMock.previewServerAccountDeletion).toHaveBeenCalledTimes(2);
    expect(props.onDeleted).not.toHaveBeenCalled();

    bridgeMock.deleteServerAccount.mockResolvedValue({ ok: true, finished: true, email: "ice@dohc.dev", server });
    typePassword("correct horse");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));
    await waitFor(() => expect(bridgeMock.deleteServerAccount).toHaveBeenLastCalledWith({ server, previewToken: "token-2", password: "correct horse" }));
  });

  it("can be cancelled after a refreshed review", async () => {
    bridgeMock.previewServerAccountDeletion
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...preview, previewToken: "token-2" });
    bridgeMock.deleteServerAccount.mockResolvedValue({ ok: false, code: "preview-changed", reason: "Review it again." });
    const { props } = renderDialog();
    await screen.findByTestId("server-account-delete-scope");
    typePassword("correct horse");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));
    await screen.findByTestId("server-account-delete-changed");
    await screen.findByTestId("server-account-delete-scope");

    expect(screen.getByTestId("server-account-delete-confirm").textContent).toBe("Delete account");
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(cancel);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps a wrong password beside the field and the dialog open", async () => {
    bridgeMock.deleteServerAccount.mockResolvedValue({ ok: false, code: "wrong-password", reason: "The password is incorrect." });
    const { props } = renderDialog();
    await screen.findByTestId("server-account-delete-scope");
    typePassword("wrong");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));

    expect((await screen.findByTestId("server-account-delete-password-problem")).textContent).toBe("The password is incorrect.");
    const field = screen.getByTestId("server-account-delete-password") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(props.onError).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("hands a paused attempt to the owner's error notice", async () => {
    const reason = "The server paused deletion after too many attempts. Wait a few minutes, then try again.";
    bridgeMock.deleteServerAccount.mockResolvedValue({ ok: false, code: "rate-limited", reason });
    const { props } = renderDialog();
    await screen.findByTestId("server-account-delete-scope");
    typePassword("correct horse");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));

    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(reason, expect.any(Error)));
    expect(screen.queryByTestId("server-account-delete-password-problem")).toBeNull();
  });

  it("ends a review whose preview is still loading when the session changes", async () => {
    const slow = deferred<ServerAccountDeletionPreview>();
    bridgeMock.previewServerAccountDeletion.mockReturnValueOnce(slow.promise);
    const { props } = renderDialog();
    changeSession("https://other.example.test##usr_b");
    expect(props.onClose).toHaveBeenCalledOnce();

    await act(async () => { slow.resolve(preview); });
    expect(screen.queryByTestId("server-account-delete-scope")).toBeNull();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("ends a shown review when the session changes", async () => {
    const { props } = renderDialog();
    await screen.findByTestId("server-account-delete-scope");
    changeSession(null);
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(bridgeMock.deleteServerAccount).not.toHaveBeenCalled();
  });

  it("still reports a sent delete whose own disconnect changed the session", async () => {
    const slow = deferred<{ ok: true; finished: boolean; email: string; server: string }>();
    bridgeMock.deleteServerAccount.mockReturnValue(slow.promise);
    const { props } = renderDialog();
    await screen.findByTestId("server-account-delete-scope");
    typePassword("correct horse");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));
    await waitFor(() => expect(bridgeMock.deleteServerAccount).toHaveBeenCalledOnce());
    changeSession(null);

    await act(async () => { slow.resolve({ ok: true, finished: true, email: "ice@dohc.dev", server }); });
    expect(props.onDeleted).toHaveBeenCalledWith({ finished: true, email: "ice@dohc.dev", server });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("does not review another session again after a refused delete", async () => {
    const slow = deferred<{ ok: false; code: "preview-changed"; reason: string }>();
    bridgeMock.deleteServerAccount.mockReturnValue(slow.promise);
    const { props } = renderDialog();
    await screen.findByTestId("server-account-delete-scope");
    typePassword("correct horse");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));
    await waitFor(() => expect(bridgeMock.deleteServerAccount).toHaveBeenCalledOnce());
    changeSession("https://dohc.example.test##usr_b");

    await act(async () => { slow.resolve({ ok: false, code: "preview-changed", reason: "Review it again." }); });
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(bridgeMock.previewServerAccountDeletion).toHaveBeenCalledOnce();
  });

  it("ignores a slow preview for an account the dialog no longer shows", async () => {
    const slow = deferred<ServerAccountDeletionPreview>();
    bridgeMock.previewServerAccountDeletion
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ ...preview, email: "other@dohc.dev", workspaces: [{ workspaceId: "ws-other", name: "Other" }], previewToken: "token-b" });
    const { props, rerender } = renderDialog();
    rerender(<ServerAccountDeleteDialog {...props} email="other@dohc.dev" />);
    await screen.findByText("Other");

    await act(async () => { slow.resolve(preview); });
    expect(screen.queryByText("Notes")).toBeNull();
    expect(screen.getByText("Delete other@dohc.dev on this server?")).toBeTruthy();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("ignores a delete that answers after the dialog closed", async () => {
    const slow = deferred<{ ok: true; finished: boolean; email: string; server: string }>();
    bridgeMock.deleteServerAccount.mockReturnValue(slow.promise);
    const { props, unmount } = renderDialog();
    await screen.findByTestId("server-account-delete-scope");
    typePassword("correct horse");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));
    await waitFor(() => expect(bridgeMock.deleteServerAccount).toHaveBeenCalledOnce());
    unmount();

    await act(async () => { slow.resolve({ ok: true, finished: true, email: "ice@dohc.dev", server }); });
    expect(props.onDeleted).not.toHaveBeenCalled();
  });
});

describe("CloudLogin account deletion", () => {
  async function noticesText(): Promise<string> {
    fireEvent.click(await screen.findByTestId("notice-center-toggle"));
    return (await screen.findByTestId("connection-notices")).textContent ?? "";
  }

  async function openAndDelete() {
    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-delete-account"));
    await screen.findByTestId("server-account-delete-scope");
    typePassword("correct horse");
    fireEvent.click(screen.getByTestId("server-account-delete-confirm"));
  }

  it("shows the connect form after deletion and says the workspaces on this computer stay", async () => {
    bridgeMock.deleteServerAccount.mockResolvedValue({ ok: true, finished: true, email: "ice@dohc.dev", server });
    bridgeMock.cloudStatus.mockResolvedValueOnce(connected).mockResolvedValueOnce({ connected: false, workspaceSynced: false });
    await openAndDelete();

    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(screen.queryByTestId("server-account-delete")).toBeNull();
    expect(await noticesText()).toContain(`Deleted ice@dohc.dev on ${server}. Workspaces on this computer stay.`);
    // Main disconnects; the window only asks what the session is now.
    expect(bridgeMock.cloudLogout).not.toHaveBeenCalled();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  });

  it("says the account is blocked when the server has not finished", async () => {
    bridgeMock.deleteServerAccount.mockResolvedValue({ ok: true, finished: false, email: "ice@dohc.dev", server });
    bridgeMock.cloudStatus.mockResolvedValueOnce(connected).mockResolvedValueOnce({ connected: false, workspaceSynced: false });
    await openAndDelete();

    expect(await noticesText()).toContain(
      `${server} blocked ice@dohc.dev and will finish deleting its data. Workspaces on this computer stay.`,
    );
    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
  });

  it("sends a network failure to the toast, whose Try again opens a new review", async () => {
    bridgeMock.deleteServerAccount.mockRejectedValue(new Error("dohc could not reach this server. Check your connection, then try again."));
    await openAndDelete();

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not reach this server.");
    expect(screen.queryByTestId("server-account-delete")).toBeNull();
    expect(screen.getByTestId("cloud-connected")).toBeTruthy();

    fireEvent.click(screen.getByTestId("workspace-shell-error-retry"));
    await screen.findByTestId("server-account-delete-scope");
    expect(bridgeMock.previewServerAccountDeletion).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId("server-account-delete-password") as HTMLInputElement).value).toBe("");
  });

  // Main announces the deletion's own disconnect before the delete answers.
  it.each([
    [true, `Deleted ice@dohc.dev on ${server}. Workspaces on this computer stay.`],
    [false, `${server} blocked ice@dohc.dev and will finish deleting its data. Workspaces on this computer stay.`],
  ])("reports a pending delete whose disconnect arrives first (finished: %s)", async (finished, notice) => {
    const slow = deferred<{ ok: true; finished: boolean; email: string; server: string }>();
    bridgeMock.deleteServerAccount.mockReturnValue(slow.promise);
    bridgeMock.cloudStatus.mockResolvedValueOnce(connected).mockResolvedValue({ connected: false, workspaceSynced: false });
    await openAndDelete();
    await waitFor(() => expect(bridgeMock.deleteServerAccount).toHaveBeenCalledOnce());

    changeSession(null);
    await act(async () => {});
    expect(screen.getByTestId("server-account-delete")).toBeTruthy();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledOnce();

    await act(async () => { slow.resolve({ ok: true, finished, email: "ice@dohc.dev", server }); });
    expect(await noticesText()).toContain(notice);
    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  });

  it("reads the session after a failed delete whose disconnect arrived first", async () => {
    const slow = deferred<never>();
    bridgeMock.deleteServerAccount.mockReturnValue(slow.promise);
    bridgeMock.cloudStatus.mockResolvedValueOnce(connected).mockResolvedValue({ connected: false, workspaceSynced: false });
    await openAndDelete();
    await waitFor(() => expect(bridgeMock.deleteServerAccount).toHaveBeenCalledOnce());

    changeSession(null);
    await act(async () => { slow.reject(new Error("dohc could not reach this server.")); });
    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain("dohc could not reach this server.");
    expect(await screen.findByTestId("cloud-server-url")).toBeTruthy();
    expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  });

  it("closes an open review when another window changes the session", async () => {
    const slow = deferred<ServerAccountDeletionPreview>();
    bridgeMock.previewServerAccountDeletion.mockReturnValueOnce(slow.promise);
    render(<CloudLogin workspaceId="ws-1" />);
    fireEvent.click(await screen.findByTestId("cloud-delete-account"));
    expect(screen.getByTestId("server-account-delete")).toBeTruthy();

    changeSession("https://dohc.example.test##usr_b");
    expect(screen.queryByTestId("server-account-delete")).toBeNull();
    await act(async () => { slow.resolve(preview); });
    expect(screen.queryByTestId("server-account-delete")).toBeNull();
  });

  it("sends a paused attempt to the toast and Notices", async () => {
    const reason = "The server paused deletion after too many attempts. Wait a few minutes, then try again.";
    bridgeMock.deleteServerAccount.mockResolvedValue({ ok: false, code: "rate-limited", reason });
    await openAndDelete();

    expect((await screen.findByTestId("workspace-shell-error")).textContent).toContain(reason);
    expect(await noticesText()).toContain(reason);
    expect(screen.getByTestId("cloud-connected")).toBeTruthy();
  });

  it("offers deletion only in the standalone panel", async () => {
    render(<CloudLogin workspaceId="ws-1" embedded />);
    await screen.findByTestId("cloud-connected");
    expect(screen.queryByTestId("cloud-delete-account")).toBeNull();
  });
});
