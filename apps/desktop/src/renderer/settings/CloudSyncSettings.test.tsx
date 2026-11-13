// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toQR } from "toqr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudStatusResult, CloudStopSyncResult } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { SYNC_NOT_CONNECTED, SYNC_SIGN_IN_EXPIRED, SYNC_UNCONFIRMED_ACCOUNT } from "../cloudSyncWords";
import { palette } from "../tokens";
import {
  CloudSyncSettings,
  SYNC_ON_NEEDS_SERVER,
  type CloudSettings,
} from "./CloudSyncSettings";

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
const PAUSE_BY_YOU: NonNullable<CloudStatusResult["syncPause"]> = {
  atMs: PAUSED_AT,
  author: { kind: "person", personId: "local-you", self: true },
};
const SIGNED_OUT_OWNED: CloudStatusResult = { connected: false, workspaceSyncOwned: true, workspaceSynced: false };
const stopped = (workspaceId: string, syncPause = PAUSE_BY_YOU): CloudStopSyncResult => ({
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
    onDeleteAccount: vi.fn(),
    ...overrides,
  };
}

const syncSwitch = () => screen.getByRole("switch", { name: "Sync this workspace" });

// The dark modules the Connect a phone code draws, read back from its path, and the side of its square.
const RUN = /M(\d+) (\d+)h(\d+)v1h-\3z/g;
function drawnCode(svg: Element): { side: number; dark: string[] } {
  const path = svg.querySelector("path")?.getAttribute("d") ?? "";
  expect(path.replace(RUN, "")).toBe("");
  const dark: string[] = [];
  for (const [, x, y, run] of path.matchAll(RUN)) {
    for (let i = 0; i < Number(run); i++) dark.push(`${Number(x) + i},${y}`);
  }
  return { side: Number(svg.getAttribute("viewBox")?.split(" ")[2]), dark: dark.sort() };
}
// The same text's modules from toQR, inside a 4-module quiet zone.
function encoded(text: string): { side: number; dark: string[] } {
  const modules = toQR(text);
  const width = Math.sqrt(modules.length);
  const dark: string[] = [];
  modules.forEach((module, index) => {
    if (module) dark.push(`${(index % width) + 4},${Math.floor(index / width) + 4}`);
  });
  return { side: width + 8, dark: dark.sort() };
}

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
  // Pausing needs no account. Turning sync on does, so signed out the switch
  // stays off and says why, below Connect server. Signed out, nothing syncs,
  // so Pause sync stands in for the switch, without Try again.
  it("lets a signed-out owner pause, then says turning sync on needs the server", async () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SIGNED_OUT_OWNED, workspaceSynced: true })} />);
    expect(screen.getByTestId("settings-cloud-connect")).toBeTruthy();
    expect(screen.queryByTestId("settings-row-account")).toBeNull();
    expect(screen.queryByTestId("cloud-relink-workspace")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    // Disconnecting was a choice: the line names the way back, not a fault.
    const row = within(screen.getByTestId("settings-row-sync-workspace"));
    expect(row.getByTestId("cloud-workspace-not-connected").textContent).toBe(SYNC_NOT_CONNECTED);
    expect(row.queryByTestId("cloud-workspace-relink")).toBeNull();
    expect(row.queryByText(/confirm/)).toBeNull();
    expect(row.getAllByRole("button").map((button) => button.textContent)).toEqual(["Pause sync"]);

    const pause = screen.getByRole("button", { name: "Pause sync" });
    pause.focus();
    fireEvent.click(pause);

    await waitFor(() => expect(bridgeMock.cloudStopSync).toHaveBeenCalledOnce());
    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("false"));
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(true);
    // The switch can't turn on signed out, so focus goes to Connect server.
    expect(document.activeElement).toBe(screen.getByTestId("settings-cloud-connect"));
    expect(screen.getByTestId("cloud-sync-paused").textContent).toContain("Paused by you");
    expect(screen.getByTestId("cloud-sync-needs-server").textContent).toBe(SYNC_ON_NEEDS_SERVER);
  });

  it("shows a QR code of the server's origin, and nothing else, for connecting a phone", () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, serverUrl: "https://dohc.hollis.studio/" })} />);

    const row = screen.getByTestId("settings-row-connect-phone");
    expect(row.textContent).toBe("Connect a phonedohc.hollis.studio");
    const code = within(row).getByRole("img", { name: "QR code for dohc.hollis.studio" });
    expect(drawnCode(code)).toEqual(encoded("https://dohc.hollis.studio"));
    expect(drawnCode(code)).not.toEqual(encoded("https://relay.hollis.studio"));
    // Dark on light in both themes.
    expect(code.querySelector("rect")?.getAttribute("fill")).toBe(palette.light.bg);
    expect(code.querySelector("path")?.getAttribute("fill")).toBe(palette.light.ink);
    // It sits under the account row.
    expect(screen.getByTestId("settings-row-account").nextElementSibling).toBe(row);
  });

  it("offers Delete account in More actions beside Disconnect, for the account the row shows", async () => {
    const logout = deferred<void>();
    bridgeMock.cloudLogout.mockReturnValueOnce(logout.promise);
    const settings = cloud({ ...SIGNED_IN, serverUrl: "https://dohc.hollis.studio/" });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    const row = within(screen.getByTestId("settings-row-account"));
    expect(row.getByTestId("cloud-disconnect")).toBeTruthy();
    expect(row.queryByTestId("cloud-delete-account")).toBeNull();
    const more = row.getByRole("button", { name: "More actions" }) as HTMLButtonElement;
    expect(more.title).toBe("More actions");
    fireEvent.click(more);
    const remove = screen.getByRole("menuitem", { name: "Delete account…" });
    expect(remove.className).toContain("text-danger");
    fireEvent.click(remove);
    expect(settings.onDeleteAccount).toHaveBeenCalledWith({ email: "sam@hollis.studio", server: "https://dohc.hollis.studio" });
    expect(screen.queryByRole("menu")).toBeNull();

    // Not while Disconnect is ending the same session.
    fireEvent.click(screen.getByTestId("cloud-disconnect"));
    expect(more.disabled).toBe(true);
    await act(async () => logout.resolve());
  });

  it("opens More actions from the keyboard, and Escape closes it back to the button", async () => {
    const user = userEvent.setup();
    const settings = cloud(SIGNED_IN);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    const more = screen.getByRole("button", { name: "More actions" });
    more.focus();
    await user.keyboard("{Enter}");
    const remove = screen.getByRole("menuitem", { name: "Delete account…" });
    expect(document.activeElement).toBe(remove);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete account…" }));
    await user.keyboard("{Enter}");
    expect(settings.onDeleteAccount).toHaveBeenCalledOnce();
  });

  // Main refuses to enroll a shared view, so the page offers no switch that
  // could only fail. The session is the installation's, so the account stays.
  it("shows the account but no sync switch in a shared view", () => {
    render(<CloudSyncSettings workspaceId="ws-1" sharedView cloud={cloud(SIGNED_IN)} />);

    expect(screen.getByTestId("settings-row-account")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

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
    const spinner = within(screen.getByTestId("settings-row-sync-workspace")).getByTestId("switch-busy");
    expect(spinner.getAttribute("class")).toContain("animate-spin");
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(control);
    expect(bridgeMock.cloudStopSync).toHaveBeenCalledOnce();
    expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();

    await act(async () => {
      stop.resolve(stopped("ws-1"));
    });

    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
    expect(syncSwitch().getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByTestId("switch-busy")).toBeNull();
    // The spinner's place stays, so the switch does not move when it goes.
    expect(syncSwitch().previousElementSibling?.className).toContain("size-3");
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("cloud-sync-paused").textContent).toContain("Paused by you");
    expect(screen.queryByTestId("cloud-sync-needs-server")).toBeNull();
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    expect(settings.onChanged).toHaveBeenCalledOnce();
    expect(settings.onError).not.toHaveBeenCalled();
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

  it("closes the passphrase form on sign-out", () => {
    const protectedSynced = { ...SYNCED, workspaceSecretState: "protected-key-present" as const };
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(protectedSynced)} />);
    fireEvent.click(screen.getByTestId("cloud-protect-secrets"));
    fireEvent.change(screen.getByTestId("cloud-sync-passphrase"), { target: { value: "shared passphrase" } });

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SIGNED_OUT_OWNED, workspaceSynced: true })} />);
    expect(screen.queryByTestId("cloud-sync-passphrase")).toBeNull();
    expect(screen.queryByTestId("settings-row-protected-files")).toBeNull();

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(protectedSynced)} />);
    expect(screen.queryByTestId("cloud-sync-passphrase")).toBeNull();
    expect(screen.getByTestId("cloud-protect-secrets")).toBeTruthy();
    expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();
  });

  it("ignores an unlock that answers after sign-out", async () => {
    const enable = deferred<void>();
    bridgeMock.cloudEnableSync.mockReturnValueOnce(enable.promise);
    const lockedSynced = { ...SYNCED, workspaceSecretState: "protected-key-missing" as const };
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(lockedSynced)} />);
    fireEvent.click(screen.getByTestId("cloud-unlock-secrets"));
    fireEvent.change(screen.getByTestId("cloud-sync-passphrase"), { target: { value: "shared passphrase" } });
    fireEvent.click(screen.getByTestId("cloud-sync-passphrase-submit"));
    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalledOnce());

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SIGNED_OUT_OWNED, workspaceSynced: true })} />);
    enable.reject(new Error("Passphrase could not unlock synced secrets."));
    await waitFor(() => expect((screen.getByTestId("cloud-pause-sync") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("cloud-sync-passphrase")).toBeNull();
    expect(screen.queryByTestId("cloud-sync-passphrase-submit")).toBeNull();
  });

  it("shows Sign in again and Pause sync, not the switch, once the sign-in expired", () => {
    const onSignInAgain = vi.fn();
    const { rerender } = render(
      <CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED, { signInExpired: true, onSignInAgain })} />,
    );

    const row = within(screen.getByTestId("settings-row-sync-workspace"));
    expect(row.queryByRole("switch")).toBeNull();
    const line = row.getByTestId("cloud-workspace-sign-in-expired");
    expect(line.textContent).toBe(SYNC_SIGN_IN_EXPIRED);
    expect(line.className).toContain("text-danger");
    expect(row.queryByText(SYNC_UNCONFIRMED_ACCOUNT)).toBeNull();
    expect(row.getAllByRole("button").map((button) => button.textContent)).toEqual(["Sign in again", "Pause sync"]);
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
    fireEvent.click(row.getByRole("button", { name: "Sign in again" }));
    expect(onSignInAgain).toHaveBeenCalledOnce();
    expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();
    expect(bridgeMock.cloudStopSync).not.toHaveBeenCalled();

    // A new sign-in rebuilt the engine: the switch reads on again.
    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED, { signInExpired: false, onSignInAgain })} />);
    expect(screen.queryByTestId("cloud-workspace-sign-in-expired")).toBeNull();
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("resumes sync with Try again through the enable path, for the same account", async () => {
    const enable = deferred<void>();
    bridgeMock.cloudEnableSync.mockReturnValueOnce(enable.promise);
    const settings = cloud({ ...SYNCED, workspaceSyncConnected: false });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    const again = screen.getByTestId("cloud-relink-workspace") as HTMLButtonElement;
    again.focus();
    fireEvent.click(again);

    expect(bridgeMock.cloudEnableSync).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(again.disabled).toBe(true);
    expect((screen.getByTestId("cloud-pause-sync") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("switch")).toBeNull();

    await act(async () => {
      enable.resolve();
    });

    expect(screen.queryByTestId("cloud-workspace-relink")).toBeNull();
    expect(screen.queryByTestId("cloud-pause-sync")).toBeNull();
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(syncSwitch());
    expect(screen.getByTestId("cloud-sync-code")).toBeTruthy();
    expect(settings.onChanged).toHaveBeenCalledOnce();
    expect(bridgeMock.cloudStopSync).not.toHaveBeenCalled();
  });

  // Another account owns the remote: main refuses, and its reason says what
  // to do. Disconnect stays on the row above.

  // Try again can ask for the passphrase. Once it unlocks, the form and the
  // buttons go, and focus moves to the switch.

  // The account can be confirmed on its own, which takes the buttons away
  // under a keyboard user.

  // A sign-in rereads the status, so the row shows its loading state between
  // the unconfirmed account and the confirmed one.

  // A failed Try again keeps its buttons. A confirmation that arrives later
  // moves focus only while one of them still has it.

  // Signing in again undoes Disconnect, and Connect server takes its place,
  // so it asks nothing first.

  // Disconnect reaches every workspace, so its failure goes through the
  // installation-wide report, never the workspace-guarded one. The shell's
  // tests follow it through a workspace switch.

  // Main announces the logout before the step that fails. The shell then
  // drops its status, and the page swaps the account row for loading lines.

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

  it.each(["changing"] as const)(
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
});
