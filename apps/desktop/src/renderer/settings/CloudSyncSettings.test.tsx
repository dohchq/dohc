// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toQR } from "toqr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudStatusResult, CloudStopSyncResult } from "../../ipc/bridgeContract";
import { testAgent } from "../../testing/agentSettings";
import { deferred } from "../../testing/deferred";
import { SYNC_NOT_CONNECTED, SYNC_SIGN_IN_EXPIRED, SYNC_UNCONFIRMED_ACCOUNT } from "../cloudSyncWords";
import { Overlay } from "../Overlay";
import { palette } from "../tokens";
import { DISCONNECT_EXPLANATION, PRIVATE_NETWORK_EXPLANATION } from "./CloudAccountRow";
import {
  CloudSyncSettings,
  SYNC_OFF_KEEPS,
  SYNC_OFF_KEEPS_WITH_RECEIVED,
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
const PAUSE_BY_UNNAMED: NonNullable<CloudStatusResult["syncPause"]> = {
  atMs: PAUSED_AT,
  author: { kind: "person", personId: "local-old", self: false },
};
const PAUSE_BY_AGENT: NonNullable<CloudStatusResult["syncPause"]> = {
  atMs: PAUSED_AT,
  author: { kind: "agent", agentId: "codex", onBehalfOf: "human-sam", depth: 1 },
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

  it.each([
    ["paused", { ...SIGNED_OUT_OWNED, syncPause: PAUSE_BY_YOU }, true],
    ["never synced", SIGNED_OUT_OWNED, false],
  ] as const)("holds a signed-out owner's switch off when %s, with the reason", (_state, status, paused) => {
    const settings = cloud(status);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("cloud-sync-paused") !== null).toBe(paused);
    expect(screen.getByTestId("cloud-sync-needs-server").textContent).toBe(SYNC_ON_NEEDS_SERVER);
    fireEvent.click(syncSwitch());
    expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("settings-cloud-connect"));
    expect(settings.onConnect).toHaveBeenCalledOnce();
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

  it("shows no Connect a phone code while signed out", () => {
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ connected: false })} />);
    expect(screen.queryByTestId("settings-row-connect-phone")).toBeNull();
    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SIGNED_OUT_OWNED)} />);
    expect(screen.queryByTestId("settings-row-connect-phone")).toBeNull();
    expect(screen.queryByRole("img", { name: /^QR code/ })).toBeNull();
  });

  // A dead session reads as signed out, with no server, so the page offers
  // its sign-in instead.
  it("shows no Connect a phone code once the sign-in expired", () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SIGNED_OUT_OWNED, { signInExpired: true })} />);

    expect(screen.getByTestId("settings-cloud-connect")).toBeTruthy();
    expect(screen.queryByTestId("settings-row-connect-phone")).toBeNull();
    expect(screen.queryByRole("img", { name: /^QR code/ })).toBeNull();
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

  it("offers only Connect server while signed out in a workspace this person does not own", () => {
    const settings = cloud({ connected: false });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    expect(screen.queryByTestId("settings-row-account")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-cloud-connect"));
    expect(settings.onConnect).toHaveBeenCalledOnce();
  });

  it("waits for the shell's read, and says the read failed beside Try again", () => {
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(null)} />);
    expect(screen.getByTestId("settings-cloud-checking")).toBeTruthy();
    expect(screen.queryByTestId("settings-cloud-unreadable")).toBeNull();
    expect(screen.queryByTestId("settings-cloud-connect")).toBeNull();

    const settings = cloud(null, { unreadable: true });
    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);
    expect(within(screen.getByTestId("settings-row-server")).getByTestId("settings-cloud-unreadable").textContent).toBe(
      "dohc could not read this workspace's sync status.",
    );
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

  it.each([
    ["you", PAUSE_BY_YOU, "Paused by you ·"],
    ["this computer under an earlier id", PAUSE_BY_UNNAMED, "Paused ·"],
    ["an agent", PAUSE_BY_AGENT, "Paused by agent codex ·"],
  ] as const)("shows a pause by %s from the shell's status", (_who, syncPause, line) => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SIGNED_IN, syncPause })} />);

    const paused = screen.getByTestId("cloud-sync-paused");
    expect(paused.textContent).toContain(line);
    expect(paused.querySelector("time")?.getAttribute("dateTime")).toBe(new Date(PAUSED_AT).toISOString());
    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
  });

  // History and chat name your agents the same way.
  it("names your agent's pause from Settings › Agents, and marks a connected agent's with the plug", () => {
    const { launch: _launch, ...youRun } = testAgent({ name: "Terminal", enabled: false });
    const agents = { terminal: youRun, codex: testAgent({ name: "Nova" }) };
    for (const [author, mark, words] of [
      [{ kind: "agent", agentId: "terminal", onBehalfOf: "human-sam", depth: 0 }, "agent", "Paused by agent Terminal ·"],
      [{ kind: "agent", agentId: "codex", onBehalfOf: "human-sam", depth: 1 }, "agent", "Paused by agent Nova ·"],
      [{ kind: "agent", agentId: "dohc-mcp", agentName: "Claude", onBehalfOf: "human-sam", depth: 0 }, "connected", "Paused by connected agent Claude ·"],
      [{ kind: "agent", agentId: "dohc-mcp", onBehalfOf: "human-sam", depth: 0 }, "connected", "Paused by connected agent Agent ·"],
      [{ kind: "agent", agentId: "claude", onBehalfOf: "human-sam", depth: 1 }, "agent", "Paused by agent claude ·"],
    ] as const) {
      render(<CloudSyncSettings workspaceId="ws-1" agents={agents} cloud={cloud({ ...SIGNED_IN, syncPause: { atMs: PAUSED_AT, author } })} />);
      const paused = screen.getByTestId("cloud-sync-paused");
      expect(paused.textContent).toContain(words);
      expect(paused.querySelector("[data-agent-mark]")?.getAttribute("data-agent-mark")).toBe(mark);
      cleanup();
    }
  });

  it("resumes a paused workspace through the turn-on path", async () => {
    const settings = cloud({ ...SIGNED_IN, syncPause: PAUSE_BY_YOU });
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
    // Turning on waits for main the same way: busy, with the spinner beside it.
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(syncSwitch().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("switch-busy")).toBeTruthy();

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

  describe("a press outside Settings", () => {
    const pressBackdrop = () => {
      const backdrop = document.querySelector<HTMLElement>('[data-dohc-modal="true"]')!;
      fireEvent.pointerDown(backdrop);
      fireEvent.click(backdrop);
    };

    it("stays open while a typed passphrase waits to be used, and says why after Tab to Protect", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(
        <Overlay onClose={onClose}>
          <CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSecretState: "protected-key-present" })} />
        </Overlay>,
      );
      await user.click(screen.getByTestId("cloud-protect-secrets"));
      const input = screen.getByTestId("cloud-sync-passphrase");
      await user.type(input, "shared passphrase");
      // Moving to Protect is how a passphrase gets used, so the row says nothing.
      await user.tab();
      expect(document.activeElement).toBe(screen.getByTestId("cloud-sync-passphrase-submit"));
      expect(screen.queryByTestId("cloud-sync-hint")).toBeNull();

      await user.click(document.querySelector<HTMLElement>('[data-dohc-modal="true"]')!);

      expect(onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
      expect(screen.getByTestId("cloud-sync-hint").textContent).toBe("Press Protect to use this passphrase.");
    });

    it.each([
      ["protect", "protected-key-present", "cloud-protect-secrets", "shared passphrase", "Press Protect to use this passphrase."],
      ["protect", "protected-key-present", "cloud-protect-secrets", "short", "Enter at least 8 characters to protect synced secrets."],
      ["unlock", "protected-key-missing", "cloud-unlock-secrets", "shared passphrase", "Press Unlock to use this passphrase."],
    ] as const)("says how to %s with a passphrase left in the field", async (_, secretState, start, typed, words) => {
      const user = userEvent.setup();
      render(
        <Overlay onClose={vi.fn()}>
          <CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSecretState: secretState })} />
        </Overlay>,
      );
      await user.click(screen.getByTestId(start));
      const input = screen.getByTestId("cloud-sync-passphrase");
      await user.type(input, typed);
      await user.click(document.querySelector<HTMLElement>('[data-dohc-modal="true"]')!);

      expect(document.activeElement).toBe(input);
      expect(screen.getByRole("alert").textContent).toBe(words);
      await user.type(input, "x");
      expect(screen.queryByTestId("cloud-sync-hint")).toBeNull();
    });

    it("closes from an empty passphrase prompt", async () => {
      bridgeMock.cloudEnableSync.mockRejectedValueOnce(new Error("Passphrase required to protect synced secrets."));
      const onClose = vi.fn();
      render(
        <Overlay onClose={onClose}>
          <CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SIGNED_IN, workspaceSecretState: "protected-key-present" })} />
        </Overlay>,
      );
      fireEvent.click(syncSwitch());
      expect((await screen.findByTestId("cloud-sync-passphrase")).getAttribute("aria-invalid")).toBe("true");

      pressBackdrop();

      expect(onClose).toHaveBeenCalledOnce();
    });
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

  // Protect and Unlock turn sync on, which needs an account. Signing out
  // closes the form; signing back in does not bring the passphrase back.
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

  it("lets a newer enable retire an older stop's retry", async () => {
    bridgeMock.cloudStopSync.mockRejectedValueOnce(new Error("A live document could not settle."));
    const enable = deferred<void>();
    bridgeMock.cloudEnableSync.mockReturnValueOnce(enable.promise);
    const settings = cloud({ ...SYNCED, workspaceSecretState: "protected-key-present" as const });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);
    fireEvent.click(syncSwitch());
    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    const report = vi.mocked(settings.onError).mock.calls[0]![0];

    fireEvent.click(screen.getByTestId("cloud-protect-secrets"));
    fireEvent.change(screen.getByTestId("cloud-sync-passphrase"), { target: { value: "shared passphrase" } });
    fireEvent.click(screen.getByTestId("cloud-sync-passphrase-submit"));
    await waitFor(() => expect(bridgeMock.cloudEnableSync).toHaveBeenCalledOnce());

    expect(report.retry?.()).toBe(false);
    expect(bridgeMock.cloudStopSync).toHaveBeenCalledOnce();
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

  // The person's setting is on, but nothing syncs: a switch could read
  // neither. The line says so, and Try again and Pause sync take its place.
  it("shows no switch while the account is unconfirmed, only the line, Try again and Pause sync", () => {
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSyncConnected: false })} />);

    const row = within(screen.getByTestId("settings-row-sync-workspace"));
    expect(row.queryByRole("switch")).toBeNull();
    const line = row.getByTestId("cloud-workspace-relink");
    expect(line.textContent).toBe(SYNC_UNCONFIRMED_ACCOUNT);
    expect(line.className).toContain("text-danger");
    const mark = line.firstElementChild!;
    expect(mark.getAttribute("class")).toContain("lucide-triangle-alert");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(row.getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again", "Pause sync"]);
    expect(row.queryByTestId("cloud-workspace-not-connected")).toBeNull();
    expect(screen.queryByTestId("cloud-sync-code-block")).toBeNull();
  });

  // The saved session still matches, but the server stopped accepting it, so
  // a switch would read on while nothing syncs. Sign in again takes Try
  // again's place, and enabling again is never asked for.
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

  // Pause sync is the switch's off. It saves the pause, so neither a restart
  // nor a sign-in resumes sync, and the row becomes the paused one.
  it("pauses sync from the unconfirmed row without a confirm, then shows the paused switch", async () => {
    const stop = deferred<CloudStopSyncResult>();
    bridgeMock.cloudStopSync.mockReturnValueOnce(stop.promise);
    const settings = cloud({ ...SYNCED, workspaceSyncConnected: false });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    const pause = screen.getByRole("button", { name: "Pause sync" }) as HTMLButtonElement;
    pause.focus();
    fireEvent.click(pause);

    expect(bridgeMock.cloudStopSync).toHaveBeenCalledOnce();
    expect(bridgeMock.cloudStopSync).toHaveBeenCalledWith();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pause.disabled).toBe(true);
    expect((screen.getByTestId("cloud-relink-workspace") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pause);
    expect(bridgeMock.cloudStopSync).toHaveBeenCalledOnce();

    await act(async () => {
      stop.resolve(stopped("ws-1"));
    });

    expect(screen.queryByTestId("cloud-workspace-relink")).toBeNull();
    expect(screen.queryByTestId("cloud-pause-sync")).toBeNull();
    expect(screen.queryByTestId("cloud-relink-workspace")).toBeNull();
    expect(syncSwitch().getAttribute("aria-checked")).toBe("false");
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("cloud-sync-paused").textContent).toContain("Paused by you");
    expect(document.activeElement).toBe(syncSwitch());
    expect(settings.onChanged).toHaveBeenCalledOnce();
    expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();
  });

  // The person's choice outlives the unconfirmed state: only Pause sync or
  // the switch's off records off.
  it("keeps sync on through an unconfirmed account, and shows it on again once confirmed", () => {
    const nothingCalled = () => {
      expect(bridgeMock.cloudStopSync).not.toHaveBeenCalled();
      expect(bridgeMock.cloudEnableSync).not.toHaveBeenCalled();
    };
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    nothingCalled();

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSyncConnected: false })} />);
    const row = within(screen.getByTestId("settings-row-sync-workspace"));
    expect(row.queryByRole("switch")).toBeNull();
    expect(row.getByTestId("cloud-workspace-relink").textContent).toBe(SYNC_UNCONFIRMED_ACCOUNT);
    expect(row.getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again", "Pause sync"]);
    nothingCalled();

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);
    expect(screen.queryByTestId("cloud-workspace-relink")).toBeNull();
    expect(screen.queryByTestId("cloud-pause-sync")).toBeNull();
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("cloud-sync-paused")).toBeNull();
    nothingCalled();
  });

  // A Disconnect whose file removal failed leaves main's cache empty while
  // the saved session still reads as signed in: the same account, not yet
  // read again. Enabling again reads it and resumes sync.
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
  it("hands another account's refusal to the shell, and stays paused", async () => {
    bridgeMock.cloudEnableSync.mockRejectedValueOnce(new Error("Sign in to the account that synced this workspace."));
    const settings = cloud({ ...SYNCED, workspaceSyncConnected: false });
    render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    fireEvent.click(screen.getByTestId("cloud-relink-workspace"));

    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    expect(vi.mocked(settings.onError).mock.calls[0]![0].message).toBe("Sign in to the account that synced this workspace.");
    expect(screen.getByTestId("cloud-workspace-relink").textContent).toBe(SYNC_UNCONFIRMED_ACCOUNT);
    expect(screen.getByTestId("cloud-disconnect")).toBeTruthy();
  });

  // Try again can ask for the passphrase. Once it unlocks, the form and the
  // buttons go, and focus moves to the switch.
  it("moves focus to the switch after unlocking from the unconfirmed row", async () => {
    bridgeMock.cloudEnableSync
      .mockRejectedValueOnce(new Error("Passphrase required to unlock synced secrets."))
      .mockResolvedValueOnce(undefined);
    render(<CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSyncConnected: false })} />);

    const again = screen.getByTestId("cloud-relink-workspace");
    again.focus();
    fireEvent.click(again);
    const input = await screen.findByTestId("cloud-sync-passphrase");
    fireEvent.change(input, { target: { value: "shared passphrase" } });
    const submit = screen.getByTestId("cloud-sync-passphrase-submit") as HTMLButtonElement;
    submit.focus();
    fireEvent.click(submit);

    await waitFor(() => expect(syncSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByTestId("cloud-sync-passphrase")).toBeNull();
    expect(document.activeElement).toBe(syncSwitch());
  });

  // The account can be confirmed on its own, which takes the buttons away
  // under a keyboard user.
  it.each(["cloud-relink-workspace", "cloud-pause-sync"])(
    "moves focus from %s to the switch when the account is confirmed on its own",
    (testId) => {
      const { rerender } = render(
        <CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSyncConnected: false })} />,
      );
      screen.getByTestId(testId).focus();

      rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);
      expect(document.activeElement).toBe(syncSwitch());
    },
  );

  // The switch stays disabled until Try again answers, so the move waits for it.
  it("moves focus to the switch once Try again answers, when the account is confirmed while it runs", async () => {
    const enable = deferred<void>();
    bridgeMock.cloudEnableSync.mockReturnValueOnce(enable.promise);
    const { rerender } = render(
      <CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSyncConnected: false })} />,
    );
    const again = screen.getByTestId("cloud-relink-workspace");
    again.focus();
    fireEvent.click(again);

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      enable.resolve();
    });
    expect((syncSwitch() as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(syncSwitch());
  });

  // A sign-in rereads the status, so the row shows its loading state between
  // the unconfirmed account and the confirmed one.
  it("moves focus to the switch when the account is confirmed after the status reloads", () => {
    const { rerender } = render(
      <CloudSyncSettings workspaceId="ws-1" cloud={cloud({ ...SYNCED, workspaceSyncConnected: false })} />,
    );
    screen.getByTestId("cloud-relink-workspace").focus();

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(null)} />);
    expect(document.activeElement).toBe(document.body);

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);
    expect(document.activeElement).toBe(syncSwitch());
  });

  // A failed Try again keeps its buttons. A confirmation that arrives later
  // moves focus only while one of them still has it.
  it("moves focus to the switch when the account is confirmed after a failed Try again", async () => {
    bridgeMock.cloudEnableSync.mockRejectedValueOnce(new Error("Sign in to the account that synced this workspace."));
    const settings = cloud({ ...SYNCED, workspaceSyncConnected: false });
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    const again = screen.getByTestId("cloud-relink-workspace") as HTMLButtonElement;
    again.focus();
    fireEvent.click(again);
    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    await waitFor(() => expect(again.disabled).toBe(false));

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);
    expect(document.activeElement).toBe(syncSwitch());
  });

  it("leaves focus where the person moved it when the account is confirmed after a failed Try again", async () => {
    bridgeMock.cloudEnableSync.mockRejectedValueOnce(new Error("Sign in to the account that synced this workspace."));
    const settings = cloud({ ...SYNCED, workspaceSyncConnected: false });
    const { rerender } = render(<CloudSyncSettings workspaceId="ws-1" cloud={settings} />);

    const again = screen.getByTestId("cloud-relink-workspace") as HTMLButtonElement;
    again.focus();
    fireEvent.click(again);
    await waitFor(() => expect(settings.onError).toHaveBeenCalledOnce());
    await waitFor(() => expect(again.disabled).toBe(false));
    const disconnect = screen.getByTestId("cloud-disconnect");
    disconnect.focus();

    rerender(<CloudSyncSettings workspaceId="ws-1" cloud={cloud(SYNCED)} />);
    expect(syncSwitch().getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(disconnect);
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
