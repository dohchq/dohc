// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { DISCONNECT_EXPLANATION, PRIVATE_NETWORK_EXPLANATION } from "./CloudAccountRow";
import { CloudSyncSettings, type CloudSettings } from "./CloudSyncSettings";

type SessionEvent = { sessionKey: string | null; phase: "changing" | "ready" };
const sessionListeners = new Set<(event: SessionEvent) => void>();
const bridgeMock = {
  cloudEnableSync: vi.fn(),
  cloudLogout: vi.fn(),
  cloudStatus: vi.fn(),
  onCloudSessionChanged: vi.fn((listener: (event: SessionEvent) => void) => {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
  }),
};
const announceSession = (event: SessionEvent) => {
  for (const listener of [...sessionListeners]) listener(event);
};

vi.mock("../bridge", () => ({
  bridge: () => bridgeMock,
}));

const SIGNED_IN: CloudStatusResult = {
  connected: true,
  email: "sam@hollis.studio",
  serverUrl: "https://dohc.hollis.studio",
  relayUrl: "https://relay.hollis.studio",
  workspaceSynced: false,
  workspaceSyncConnected: false,
  workspaceSecretState: "none",
};
const SYNCED: CloudStatusResult = { ...SIGNED_IN, workspaceSynced: true, workspaceSyncConnected: true };

function cloud(status: CloudStatusResult | null, overrides: Partial<CloudSettings> = {}): CloudSettings {
  return {
    status,
    unreadable: false,
    onChanged: vi.fn(),
    onConnect: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

const syncSwitch = () => screen.getByRole("switch", { name: "Sync this workspace" });
const describedBy = (element: HTMLElement) =>
  document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent;

beforeEach(() => {
  vi.clearAllMocks();
  sessionListeners.clear();
  bridgeMock.cloudEnableSync.mockReset().mockResolvedValue(undefined);
  bridgeMock.cloudLogout.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("CloudSyncSettings", () => {
  it("shows the account, its server, Disconnect, and the sync switch while signed in", () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SIGNED_IN)} />);

    const account = screen.getByTestId("settings-row-account");
    expect(account.textContent).toContain("sam@hollis.studio");
    expect(within(account).getByTestId("cloud-connected-server").textContent).toBe("https://dohc.hollis.studio");
    expect(within(account).getByTestId("cloud-disconnect").textContent).toBe("Disconnect");
    expect(within(account).queryByTestId("cloud-network-access")).toBeNull();
    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(false);
    // Settings holds no connect form.
    expect(screen.queryByTestId("cloud-server-url")).toBeNull();
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    // The page draws from the shell's read; it reads nothing itself.
    expect(bridgeMock.cloudStatus).not.toHaveBeenCalled();
  });

  // The words a mark cannot carry reach the keyboard and a screen reader, not
  // only a pointer's title.
  it("explains a private server on keyboard focus and to a screen reader", async () => {
    const user = userEvent.setup();
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SIGNED_IN, networkAccess: "private" })} />);

    const mark = screen.getByTestId("cloud-network-access");
    expect(mark.textContent).toBe("Private network");
    expect(mark.getAttribute("title")).toBeNull();
    expect(describedBy(mark)).toBe(PRIVATE_NETWORK_EXPLANATION);
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.tab();
    expect(document.activeElement).toBe(mark);
    expect(screen.getByRole("tooltip").textContent).toBe(PRIVATE_NETWORK_EXPLANATION);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("says what Disconnect reaches, on keyboard focus and to a screen reader", async () => {
    const user = userEvent.setup();
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SIGNED_IN)} />);

    const disconnect = screen.getByTestId("cloud-disconnect");
    expect(describedBy(disconnect)).toBe(DISCONNECT_EXPLANATION);
    await user.tab();
    expect(document.activeElement).toBe(disconnect);
    expect(screen.getByRole("tooltip").textContent).toBe(DISCONNECT_EXPLANATION);
  });

  it("offers Connect server while signed out, which opens the connect flow", () => {
    const settings = cloud({ connected: false });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    expect(screen.queryByTestId("settings-row-account")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-cloud-connect"));
    expect(settings.onConnect).toHaveBeenCalledOnce();
  });

  it("waits for the shell's read, and offers to read again after it failed", () => {
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(null)} />);
    expect(screen.getByTestId("settings-cloud-checking")).toBeTruthy();
    expect(screen.queryByTestId("settings-cloud-connect")).toBeNull();

    const settings = cloud(null, { unreadable: true });
    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);
    fireEvent.click(within(screen.getByTestId("settings-row-server")).getByRole("button", { name: "Try again" }));
    expect(settings.onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("settings-cloud-connect")).toBeNull();
  });

  // Main refuses to enroll a shared view, so the page offers no switch that
  // could only fail. The session is the installation's, so the account stays.
  it("shows the account but no sync switch in a shared view", () => {
    render(<CloudSyncSettings workspaceId="ws-1" sharedView cloud={cloud(SIGNED_IN)} />);

    expect(screen.getByTestId("settings-row-account")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("turns on sync, shows it at once, and asks the shell to read again", async () => {
    const settings = cloud(SIGNED_IN);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(syncSwitch());

    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalledWith({ workspaceId: "ws-1" }));
    await waitFor(() => expect(screen.getByTestId("cloud-sync-code").textContent).toBe("dohc-sync:ws-1:https://relay.hollis.studio"));
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(settings.onChanged).toHaveBeenCalledOnce();
  });

  // Main has no way to stop syncing one workspace yet. The switch reads as on
  // at full strength, not as unavailable, and a click changes nothing.
  it("shows a synced workspace's switch on and read-only, not disabled", () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);

    const control = syncSwitch() as HTMLButtonElement;
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.getAttribute("aria-readonly")).toBe("true");
    expect(control.disabled).toBe(false);
    fireEvent.click(control);
    expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();
  });

  it("copies the workspace code of a synced workspace, with no description under it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);

    expect(screen.getByTestId("cloud-sync-code-block").querySelector("p")).toBeNull();
    fireEvent.click(screen.getByTestId("cloud-copy-sync-code"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("dohc-sync:ws-1:https://relay.hollis.studio"));
  });

  it("omits the workspace code when the session has no relay", () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, relayUrl: undefined })} />);

    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
  });

  // A claim, relay, or engine failure is nothing the page can fix, so it
  // leaves through the shell's toast and Notices row. Passphrase problems stay
  // beside the field.
  it("sends a failed enable to the shell with a retry", async () => {
    bridgeMock.cloudEnableSync
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'desktop:cloud-enable-sync': Error: This workspace is already claimed by another account.",
      ))
      .mockResolvedValueOnce(undefined);
    const settings = cloud(SIGNED_IN);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(syncSwitch());

    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    const report = vi.mocked(settings.onError).mock.calls[0]![0];
    expect(report.message).toBe("This workspace is already claimed by another account.");
    expect(report.serverUrl).toBeNull();
    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByTestId("cloud-sync-error")).toBeNull();

    await act(async () => {
      expect(report.retry?.()).toBe(true);
    });
    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(bridgeMock.cloudEnableSync).toHaveBeenCalledTimes(2);
  });

  // The switch shows on from the click, which invites closing Settings.
  // Closing must not lose the answer: the shell reads its status again.
  it("asks the shell to read again when an enable finishes after the page closed", async () => {
    const enable = deferred<void>();
    bridgeMock.cloudEnableSync.mockReturnValueOnce(enable.promise);
    const settings = cloud(SIGNED_IN);
    const { unmount } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);
    fireEvent.click(syncSwitch());
    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalled());

    unmount();
    await act(async () => {
      enable.resolve();
    });

    expect(settings.onChanged).toHaveBeenCalledOnce();
    expect(settings.onError).not.toHaveBeenCalled();
  });

  it("reports an enable that fails after the page closed, with a retry that reopens it", async () => {
    const enable = deferred<void>();
    bridgeMock.cloudEnableSync.mockReturnValueOnce(enable.promise);
    const settings = cloud(SIGNED_IN);
    const { unmount } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);
    fireEvent.click(syncSwitch());
    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalled());

    unmount();
    await act(async () => {
      enable.reject(new Error("relay offline"));
    });

    expect(settings.onError).toHaveBeenCalledOnce();
    const report = vi.mocked(settings.onError).mock.calls[0]![0];
    expect(report.message).toBe("relay offline");
    // No page is watching the attempt, so the shell opens the page instead.
    expect(report.retry?.()).toBe(false);
    expect(bridgeMock.cloudEnableSync).toHaveBeenCalledTimes(1);
  });

  // The page reports through the callbacks of the workspace that started
  // the attempt. The shell drops those once another workspace is open.
  it("answers through the starting workspace's callbacks, and paints nothing on the next", async () => {
    const stale = deferred<void>();
    bridgeMock.cloudEnableSync.mockReturnValueOnce(stale.promise);
    const first = cloud(SIGNED_IN);
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={first} />);
    fireEvent.click(syncSwitch());
    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalled());

    const next = cloud(SIGNED_IN);
    rerender(<CloudSyncSettings workspaceId="ws-2" cloud={next} />);
    await act(async () => {
      stale.reject(new Error("relay offline"));
    });

    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
    expect(first.onError).toHaveBeenCalledOnce();
    expect(next.onError).not.toHaveBeenCalled();
    expect(next.onChanged).not.toHaveBeenCalled();
    expect(vi.mocked(first.onError).mock.calls[0]![0].retry?.()).toBe(false);
  });

  it("asks for a passphrase before enrolling a protected-file key", async () => {
    bridgeMock.cloudEnableSync
      .mockRejectedValueOnce(new Error("Passphrase required to protect synced secrets."))
      .mockResolvedValueOnce(undefined);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SIGNED_IN, workspaceSecretState: "protected-key-present" })} />);

    fireEvent.click(syncSwitch());
    const input = await screen.findByTestId("cloud-sync-passphrase");
    expect(screen.getByTestId("cloud-sync-error").textContent).toBe(
      "Enter at least 8 characters to protect synced secrets.",
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(true);
    const submit = screen.getByTestId("cloud-sync-passphrase-submit") as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "1234567" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "12345678" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() =>
      expect(bridgeMock.cloudEnableSync).toHaveBeenLastCalledWith({ workspaceId: "ws-1", passphrase: "12345678" }),
    );
    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByTestId("cloud-sync-passphrase")).toBeNull();
  });

  it("protects a synced workspace with a passphrase", async () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSecretState: "protected-key-present" })} />);

    fireEvent.click(screen.getByTestId("cloud-protect-secrets"));
    fireEvent.change(screen.getByTestId("cloud-sync-passphrase"), { target: { value: "shared passphrase" } });
    fireEvent.submit(screen.getByTestId("cloud-sync-passphrase"));

    await waitFor(() =>
      expect(bridgeMock.cloudEnableSync).toHaveBeenLastCalledWith({ workspaceId: "ws-1", passphrase: "shared passphrase" }),
    );
  });

  it("unlocks protected files, then offers to protect them", async () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSecretState: "protected-key-missing" })} />);

    fireEvent.click(screen.getByTestId("cloud-unlock-secrets"));
    const submit = screen.getByTestId("cloud-sync-passphrase-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("cloud-sync-passphrase"), { target: { value: "shared passphrase" } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(bridgeMock.cloudEnableSync).toHaveBeenLastCalledWith({ workspaceId: "ws-1", passphrase: "shared passphrase" }),
    );
    expect(await screen.findByTestId("cloud-protect-secrets")).toBeTruthy();
  });

  it("keeps the passphrase field open when the passphrase cannot unlock", async () => {
    bridgeMock.cloudEnableSync.mockRejectedValue(new Error("Passphrase could not unlock synced secrets."));
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSecretState: "protected-key-missing" })} />);

    fireEvent.click(screen.getByTestId("cloud-unlock-secrets"));
    fireEvent.change(screen.getByTestId("cloud-sync-passphrase"), { target: { value: "wrong passphrase" } });
    fireEvent.click(screen.getByTestId("cloud-sync-passphrase-submit"));

    expect((await screen.findByTestId("cloud-sync-error")).textContent).toBe(
      "That passphrase couldn't unlock synced secrets.",
    );
    expect(screen.getByTestId("cloud-sync-passphrase")).toBeTruthy();
    expect(screen.queryByTestId("cloud-protect-secrets")).toBeNull();
  });

  // About says the same facts the same way. Sync again cannot fix another
  // account; Disconnect, on the row above, is the way to that account.
  it("names a workspace that syncs with another account in About's words, and points at Disconnect", () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSyncConnected: false })} />);

    expect(screen.getByTestId("cloud-workspace-relink").textContent).toBe(
      "This workspace syncs with another account. Disconnect, then connect that account.",
    );
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("cloud-relink-workspace")).toBeNull();
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    expect(screen.getByTestId("cloud-disconnect")).toBeTruthy();
  });

  // Signing in again undoes Disconnect, and Connect server takes its place,
  // so it asks nothing first.
  it("disconnects without a confirm, then asks the shell to read again", async () => {
    const settings = cloud(SIGNED_IN);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(screen.getByTestId("cloud-disconnect"));

    await waitFor(() => expect(settings.onChanged).toHaveBeenCalledOnce());
    expect(bridgeMock.cloudLogout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(settings.onError).not.toHaveBeenCalled();
    expect(sessionListeners.size).toBe(0);
  });

  // Main announces the logout before the step that fails. The shell then
  // drops its status, and the page swaps the account row for loading lines.
  it("reports a disconnect that fails after the session change took the row away", async () => {
    const logout = deferred<void>();
    bridgeMock.cloudLogout.mockReturnValueOnce(logout.promise);
    const settings = cloud(SIGNED_IN);
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);
    fireEvent.click(screen.getByTestId("cloud-disconnect"));
    await waitFor(() => expect(bridgeMock.cloudLogout).toHaveBeenCalled());

    act(() => announceSession({ sessionKey: null, phase: "ready" }));
    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={{ ...settings, status: null }} />);
    expect(screen.queryByTestId("settings-row-account")).toBeNull();
    await act(async () => {
      logout.reject(new Error("dohc could not stop sync for Notes."));
    });

    expect(settings.onError).toHaveBeenCalledOnce();
    expect(vi.mocked(settings.onError).mock.calls[0]![0].message).toBe("dohc could not stop sync for Notes.");
    // Nothing on the page repaints for a row that is gone.
    expect(settings.onChanged).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-cloud-checking")).toBeTruthy();
  });

  it("retries a failed disconnect while no one has signed in since", async () => {
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const settings = cloud(SIGNED_IN);
    const { unmount } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(screen.getByTestId("cloud-disconnect"));
    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    const report = vi.mocked(settings.onError).mock.calls[0]![0];
    expect(report.message).toBe("offline");
    // The session may be gone even so: the shell reads it again.
    await waitFor(() => expect(settings.onChanged).toHaveBeenCalledOnce());

    // The logout's own announcement carries no session.
    act(() => announceSession({ sessionKey: null, phase: "ready" }));
    unmount();
    await act(async () => {
      expect(report.retry?.()).toBe(true);
    });
    expect(bridgeMock.cloudLogout).toHaveBeenCalledTimes(2);
  });

  // The notice outlives the row. A Try again after a new sign-in would end
  // the new session, so the retry declines and the shell opens Settings.
  it("refuses to retry a failed disconnect once someone has signed in again", async () => {
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline"));
    const settings = cloud(SIGNED_IN);
    const { unmount } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(screen.getByTestId("cloud-disconnect"));
    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    const report = vi.mocked(settings.onError).mock.calls[0]![0];

    unmount();
    act(() => announceSession({ sessionKey: "new-session", phase: "changing" }));
    act(() => announceSession({ sessionKey: "new-session", phase: "ready" }));

    expect(report.retry?.()).toBe(false);
    expect(bridgeMock.cloudLogout).toHaveBeenCalledTimes(1);
    expect(sessionListeners.size).toBe(0);
  });
});
