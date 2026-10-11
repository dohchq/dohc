// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { CloudSyncSettings, type CloudSettings } from "./CloudSyncSettings";

const bridgeMock = {
  cloudEnableSync: vi.fn(),
  cloudLogout: vi.fn(),
  cloudStatus: vi.fn(),
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

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.cloudEnableSync.mockResolvedValue(undefined);
  bridgeMock.cloudLogout.mockResolvedValue(undefined);
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

  it("marks a private server", () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SIGNED_IN, networkAccess: "private" })} />);

    const mark = screen.getByTestId("cloud-network-access");
    expect(mark.textContent).toBe("Private network");
    expect(mark.getAttribute("title")).toBe(
      "Everyone you share with needs access to this private network, from every device they use.",
    );
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
    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(settings.onChanged).toHaveBeenCalledOnce();
    // Main has no way to stop syncing one workspace, so on stays on.
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("cloud-sync-code").textContent).toBe("dohc-sync:ws-1:https://relay.hollis.studio");
  });

  it("copies the workspace code of a synced workspace", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);

    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
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
    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("cloud-sync-error")).toBeNull();

    await act(async () => {
      expect(report.retry?.()).toBe(true);
    });
    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(bridgeMock.cloudEnableSync).toHaveBeenCalledTimes(2);
  });

  it("refuses a retry once the page has moved to another workspace", async () => {
    bridgeMock.cloudEnableSync.mockRejectedValueOnce(new Error("relay offline"));
    const settings = cloud(SIGNED_IN);
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);
    fireEvent.click(syncSwitch());
    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());

    rerender(<CloudSyncSettings workspaceId="ws-2" cloud={cloud(SIGNED_IN)} />);
    expect(vi.mocked(settings.onError).mock.calls[0]![0].retry?.()).toBe(false);
    expect(bridgeMock.cloudEnableSync).toHaveBeenCalledTimes(1);
  });

  it("does not let an enable for the last workspace mark the next one synced", async () => {
    const stale = deferred<void>();
    bridgeMock.cloudEnableSync.mockReturnValueOnce(stale.promise);
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SIGNED_IN)} />);
    fireEvent.click(syncSwitch());
    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalled());

    const next = cloud(SIGNED_IN);
    rerender(<CloudSyncSettings workspaceId="ws-2" cloud={next} />);
    await act(async () => {
      stale.resolve();
    });

    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
    expect(next.onChanged).not.toHaveBeenCalled();
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

  it("pauses sync when this account cannot use the workspace's remote, and retries it", async () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSyncConnected: false })} />);

    expect(screen.getByTestId("cloud-workspace-relink").textContent).toBe("Paused until dohc verifies this account.");
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    fireEvent.click(screen.getByTestId("cloud-relink-workspace"));

    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalledWith({ workspaceId: "ws-1" }));
    await waitFor(() => expect(screen.queryByTestId("cloud-workspace-relink")).toBeNull());
  });

  // Signing in again undoes Disconnect, and Connect server takes its place,
  // so it asks nothing first. Its title says what it reaches.
  it("disconnects without a confirm, then asks the shell to read again", async () => {
    const settings = cloud(SIGNED_IN);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    const disconnect = screen.getByTestId("cloud-disconnect");
    expect(disconnect.getAttribute("title")).toBe(
      "Stops sync for every workspace on this machine. Your files stay where they are.",
    );
    fireEvent.click(disconnect);

    await waitFor(() => expect(settings.onChanged).toHaveBeenCalledOnce());
    expect(bridgeMock.cloudLogout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(settings.onError).not.toHaveBeenCalled();
  });

  it("reports a failed disconnect with a retry that needs no page", async () => {
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const settings = cloud(SIGNED_IN);
    const { unmount } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(screen.getByTestId("cloud-disconnect"));

    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    const report = vi.mocked(settings.onError).mock.calls[0]![0];
    expect(report.message).toBe("offline");
    // The session may be gone even so: the shell reads it again.
    await waitFor(() => expect(settings.onChanged).toHaveBeenCalledOnce());

    unmount();
    await act(async () => {
      expect(report.retry?.()).toBe(true);
    });
    expect(bridgeMock.cloudLogout).toHaveBeenCalledTimes(2);
  });
});
