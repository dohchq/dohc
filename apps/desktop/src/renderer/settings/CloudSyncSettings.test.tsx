// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudStatusResult, CloudStopSyncResult } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { SYNC_PAUSED_FOR_ACCOUNT } from "../cloudSyncWords";
import { DISCONNECT_EXPLANATION, PRIVATE_NETWORK_EXPLANATION } from "./CloudAccountRow";
import { CloudSyncSettings, SYNC_OFF_KEEPS, SYNC_OFF_KEEPS_WITH_RECEIVED, type CloudSettings } from "./CloudSyncSettings";

type SessionEvent = { sessionKey: string | null; phase: "changing" | "ready" };
const sessionListeners = new Set<(event: SessionEvent) => void>();
const bridgeMock = {
  cloudEnableSync: vi.fn(),
  cloudStopSync: vi.fn(),
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
const PAUSED_AT = Date.UTC(2026, 9, 14, 13, 5);
const PAUSE_BY_PERSON: NonNullable<CloudStatusResult["syncPause"]> = {
  atMs: PAUSED_AT,
  author: { kind: "person", personId: "local-sam", self: false, displayName: "Sam Hollis" },
};
const PAUSE_BY_AGENT: NonNullable<CloudStatusResult["syncPause"]> = {
  atMs: PAUSED_AT,
  author: { kind: "agent", agentId: "codex", onBehalfOf: "human-sam", depth: 1 },
};
const stopped = (workspaceId: string, syncPause = PAUSE_BY_PERSON): CloudStopSyncResult => ({
  workspaceId,
  workspaceSynced: false,
  syncPause,
  status: {
    state: "local-changes",
    syncPause,
    pendingChangeCount: 0,
    lastSyncedAtMs: null,
    historyRecordingUnavailable: false,
    historyShareView: false,
    liveSessionsGeneration: 0,
  },
});

function cloud(status: CloudStatusResult | null, overrides: Partial<CloudSettings> = {}): CloudSettings {
  return {
    status,
    unreadable: false,
    onChanged: vi.fn(),
    onConnect: vi.fn(),
    onError: vi.fn(),
    onAccountError: vi.fn(),
    ...overrides,
  };
}

const syncSwitch = () => screen.getByRole("switch", { name: "Sync this workspace" });
const describedBy = (element: HTMLElement) =>
  document.getElementById(element.getAttribute("aria-describedby") ?? "")?.textContent;

beforeEach(() => {
  // The row's session listener lives as long as the window, so it is kept
  // across tests, as it is across Disconnect attempts.
  vi.clearAllMocks();
  bridgeMock.cloudEnableSync.mockReset().mockResolvedValue(undefined);
  bridgeMock.cloudStopSync.mockReset().mockResolvedValue(stopped("ws-1"));
  bridgeMock.cloudLogout.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("CloudSyncSettings", () => {
  it("allows a signed-out person to pause an owned synced workspace", async () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ connected: false, workspaceSyncOwned: true, workspaceSynced: true })} />);
    expect(screen.getByTestId("settings-cloud-connect")).toBeTruthy();
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(syncSwitch());
    await waitFor(() => expect(bridgeMock.cloudStopSync).toHaveBeenCalledOnce());
    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("false"));
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a signed-out pause by this computer's person as you", () => {
    const syncPause = { ...PAUSE_BY_PERSON, author: { kind: "person" as const, personId: "local-sam", self: true } };
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ connected: false, workspaceSyncOwned: true, workspaceSynced: false, syncPause })} />);
    expect(screen.getByTestId("cloud-sync-paused").textContent).toContain("Paused by you");
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(true);
  });

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

  it("says what turning sync off keeps, naming received shares when there are any", () => {
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);
    const row = screen.getByTestId("settings-row-sync-workspace");
    expect(row.querySelector("p")?.textContent).toBe(SYNC_OFF_KEEPS);

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED, { hasReceivedShares: true })} />);
    expect(row.querySelector("p")?.textContent).toBe(SYNC_OFF_KEEPS_WITH_RECEIVED);
  });

  // A pause is reversible, so it asks nothing first. The switch holds still
  // until main answers, so a second click cannot queue another stop.
  it("turns sync off without a confirm, holds the switch while it runs, then shows who paused it", async () => {
    const stop = deferred<CloudStopSyncResult>();
    bridgeMock.cloudStopSync.mockReturnValueOnce(stop.promise);
    const settings = cloud(SYNCED);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(syncSwitch());

    expect(bridgeMock.cloudStopSync).toHaveBeenCalledOnce();
    expect(bridgeMock.cloudStopSync).toHaveBeenCalledWith();
    expect(screen.queryByRole("dialog")).toBeNull();
    const control = syncSwitch() as HTMLButtonElement;
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(bridgeMock.cloudStopSync).toHaveBeenCalledOnce();
    expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();

    await act(async () => {
      stop.resolve(stopped("ws-1"));
    });

    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
    expect(syncSwitch().getAttribute("aria-busy")).toBeNull();
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("cloud-sync-paused").textContent).toContain("Paused by Sam Hollis");
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    expect(settings.onChanged).toHaveBeenCalledOnce();
    expect(settings.onError).not.toHaveBeenCalled();
  });

  it.each([
    ["a person", PAUSE_BY_PERSON, "Paused by Sam Hollis"],
    ["an agent", PAUSE_BY_AGENT, "Paused by agent codex"],
  ] as const)("shows a pause by %s from the shell's status", (_who, syncPause, line) => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SIGNED_IN, syncPause })} />);

    const paused = screen.getByTestId("cloud-sync-paused");
    expect(paused.textContent).toContain(line);
    expect(paused.querySelector("time")?.getAttribute("dateTime")).toBe(new Date(PAUSED_AT).toISOString());
    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("resumes a paused workspace through the turn-on path", async () => {
    const settings = cloud({ ...SIGNED_IN, syncPause: PAUSE_BY_PERSON });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(syncSwitch());

    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalledWith({ workspaceId: "ws-1" }));
    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByTestId("cloud-sync-paused")).toBeNull();
    expect(bridgeMock.cloudStopSync).not.toHaveBeenCalled();
  });

  it("sends a failed stop to the shell with a retry, and shows sync still on", async () => {
    bridgeMock.cloudStopSync
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'desktop:cloud-stop-sync': Error: A live document could not settle.",
      ))
      .mockResolvedValueOnce(stopped("ws-1"));
    const settings = cloud(SYNCED);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(syncSwitch());

    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    const report = vi.mocked(settings.onError).mock.calls[0]![0];
    expect(report.message).toBe("A live document could not settle.");
    expect(report.serverUrl).toBeNull();
    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByTestId("cloud-sync-paused")).toBeNull();
    expect(settings.onChanged).not.toHaveBeenCalled();

    await act(async () => {
      expect(report.retry?.()).toBe(true);
    });
    await waitFor(() => expect(screen.getByTestId("cloud-sync-paused")).toBeTruthy());
    expect(bridgeMock.cloudStopSync).toHaveBeenCalledTimes(2);
  });

  // A slow answer for one workspace must not repaint the next.
  it("ignores a stop that answers after another workspace opened", async () => {
    const stop = deferred<CloudStopSyncResult>();
    bridgeMock.cloudStopSync.mockReturnValueOnce(stop.promise);
    const first = cloud(SYNCED);
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={first} />);
    fireEvent.click(syncSwitch());

    const next = cloud(SYNCED);
    rerender(<CloudSyncSettings workspaceId="ws-2" cloud={next} />);
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      stop.resolve(stopped("ws-1"));
    });

    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("cloud-sync-paused")).toBeNull();
    expect(first.onChanged).toHaveBeenCalledOnce();
    expect(next.onChanged).not.toHaveBeenCalled();
  });

  it("ignores a stop failure that arrives after another workspace opened, with a retry that declines", async () => {
    const stop = deferred<CloudStopSyncResult>();
    bridgeMock.cloudStopSync.mockReturnValueOnce(stop.promise);
    const first = cloud(SYNCED);
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={first} />);
    fireEvent.click(syncSwitch());

    const next = cloud(SYNCED);
    rerender(<CloudSyncSettings workspaceId="ws-2" cloud={next} />);
    await act(async () => {
      stop.reject(new Error("relay offline"));
    });

    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(first.onError).toHaveBeenCalledOnce();
    expect(next.onError).not.toHaveBeenCalled();
    expect(vi.mocked(first.onError).mock.calls[0]![0].retry?.()).toBe(false);
    expect(bridgeMock.cloudStopSync).toHaveBeenCalledOnce();
  });

  it("ignores a stop answer for a workspace other than the one it was asked for", async () => {
    bridgeMock.cloudStopSync.mockResolvedValueOnce(stopped("ws-other"));
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);

    fireEvent.click(syncSwitch());

    await waitFor(() => expect((syncSwitch() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("cloud-sync-paused")).toBeNull();
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

  // A Disconnect whose file removal failed leaves main's cache empty while
  // the saved session still reads as signed in: the same account, not yet
  // read again. Enabling again reads it and resumes sync.
  it("pauses sync in About's words, and resumes it with Try again for the same account", async () => {
    const settings = cloud({ ...SYNCED, workspaceSyncConnected: false });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    expect(screen.getByTestId("cloud-workspace-relink").textContent).toBe(SYNC_PAUSED_FOR_ACCOUNT);
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    fireEvent.click(screen.getByTestId("cloud-relink-workspace"));

    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalledWith({ workspaceId: "ws-1" }));
    await waitFor(() => expect(screen.queryByTestId("cloud-workspace-relink")).toBeNull());
    expect(screen.getByTestId("cloud-sync-code")).toBeTruthy();
    expect(settings.onChanged).toHaveBeenCalledOnce();
  });

  // Another account owns the remote: main refuses, and its reason says what
  // to do. Disconnect stays on the row above.
  it("hands another account's refusal to the shell, and stays paused", async () => {
    bridgeMock.cloudEnableSync.mockRejectedValueOnce(new Error("Sign in to the account that synced this workspace."));
    const settings = cloud({ ...SYNCED, workspaceSyncConnected: false });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(screen.getByTestId("cloud-relink-workspace"));

    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    expect(vi.mocked(settings.onError).mock.calls[0]![0].message).toBe("Sign in to the account that synced this workspace.");
    expect(screen.getByTestId("cloud-workspace-relink").textContent).toBe(SYNC_PAUSED_FOR_ACCOUNT);
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
    expect(settings.onAccountError).not.toHaveBeenCalled();
  });

  // Disconnect reaches every workspace, so its failure goes through the
  // installation-wide report, never the workspace-guarded one. The shell's
  // tests follow it through a workspace switch.
  it("reports a disconnect failure installation-wide, not for this workspace only", async () => {
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline"));
    const settings = cloud(SIGNED_IN);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(screen.getByTestId("cloud-disconnect"));

    await waitFor(() => expect(settings.onAccountError).toHaveBeenCalledOnce());
    expect(vi.mocked(settings.onAccountError).mock.calls[0]![0].message).toBe("offline");
    expect(settings.onError).not.toHaveBeenCalled();
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

    expect(settings.onAccountError).toHaveBeenCalledOnce();
    expect(vi.mocked(settings.onAccountError).mock.calls[0]![0].message).toBe("dohc could not stop sync for Notes.");
    // Nothing on the page repaints for a row that is gone.
    expect(settings.onChanged).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-cloud-checking")).toBeTruthy();
  });

  it("retries a failed disconnect while no one has signed in since", async () => {
    bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const settings = cloud(SIGNED_IN);
    const { unmount } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(screen.getByTestId("cloud-disconnect"));
    await waitFor(() => expect(settings.onAccountError).toHaveBeenCalledOnce());
    const report = vi.mocked(settings.onAccountError).mock.calls[0]![0];
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
  // Main saves the new session before it announces "changing", and engine
  // cleanup can hold "ready" back, so the first announcement already counts.
  it.each(["changing", "ready"] as const)(
    "refuses to retry a failed disconnect once a sign-in is announced (%s)",
    async (phase) => {
      bridgeMock.cloudLogout.mockRejectedValueOnce(new Error("offline"));
      const settings = cloud(SIGNED_IN);
      const { unmount } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

      fireEvent.click(screen.getByTestId("cloud-disconnect"));
      await waitFor(() => expect(settings.onAccountError).toHaveBeenCalledOnce());
      const report = vi.mocked(settings.onAccountError).mock.calls[0]![0];

      unmount();
      act(() => announceSession({ sessionKey: "new-session", phase }));

      expect(report.retry?.()).toBe(false);
      expect(bridgeMock.cloudLogout).toHaveBeenCalledTimes(1);
    },
  );

  // One listener counts sign-ins for the window, however many attempts fail
  // and whether or not anyone presses Try again.
  it("keeps one session listener for the window across failed attempts", async () => {
    bridgeMock.cloudLogout.mockRejectedValue(new Error("offline"));
    const settings = cloud(SIGNED_IN);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    for (const attempt of [1, 2, 3]) {
      fireEvent.click(screen.getByTestId("cloud-disconnect"));
      await waitFor(() => expect(settings.onAccountError).toHaveBeenCalledTimes(attempt));
    }

    expect(sessionListeners.size).toBe(1);
  });
});
