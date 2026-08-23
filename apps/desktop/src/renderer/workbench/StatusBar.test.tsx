// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStateEvent } from "../../ipc/bridgeContract";
import type { AgentNotification } from "./agentNotifications";
import { StatusBar } from "./StatusBar";

// Captures the renderer-side update listener exactly as the preload would
// install it — the auto-updater itself never runs in dev/test (gated on
// isPackaged + DOHC_UPDATE_URL), so the surface is driven with a fake.
let pushUpdate: ((state: UpdateStateEvent) => void) | null = null;
const unsubscribe = vi.fn();
const installUpdate = vi.fn(async () => ({
  accepted: true,
  completed: false,
  state: {
    status: "ready" as const,
    message: "Update 1.2.3 is ready — restart dohc to apply it.",
    currentVersion: "1.2.2",
    channel: "latest" as const,
    canCheck: false,
    canInstall: true,
    version: "1.2.3",
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", {
    getUpdateState: vi.fn(
      () => new Promise<UpdateStateEvent>(() => undefined),
    ),
    checkForUpdates: vi.fn(),
    installUpdate,
    onUpdateState: (listener: (state: UpdateStateEvent) => void) => {
      pushUpdate = listener;
      return unsubscribe;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  pushUpdate = null;
});

function renderBar(
  props: Partial<Parameters<typeof StatusBar>[0]> = {},
) {
  return render(
    <StatusBar
      workspaceId="ws-status-test"
      workspaceName="my-notes"
      syncStatus={props.syncStatus ?? null}
      agentActive={props.agentActive ?? false}
      conflictSummaries={props.conflictSummaries ?? []}
      onConnectCloud={() => {}}
      onOpenHistory={props.onOpenHistory ?? (() => {})}
      onOpenConflicts={props.onOpenConflicts ?? (() => {})}
      {...(props.agentNotifications ? { agentNotifications: props.agentNotifications } : {})}
      {...(props.onDismissAgentNotification
        ? { onDismissAgentNotification: props.onDismissAgentNotification }
        : {})}
      onOpenSettings={props.onOpenSettings ?? (() => {})}
      onRebuildEngineStore={props.onRebuildEngineStore ?? (() => {})}
      onToggleTheme={() => {}}
      onContextMenu={props.onContextMenu ?? (() => {})}
    />,
  );
}

function agentNotice(overrides: Partial<AgentNotification> = {}): AgentNotification {
  return {
    id: "ws-a::run-1::finished",
    kind: "finished",
    workspaceId: "ws-a",
    workspaceName: "Personal",
    agentName: "You's agent",
    runId: "run-1",
    title: "Your agent finished",
    body: "Reorganized /notes into three folders.",
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("update toast", () => {
  it("shows the machine's message when an update becomes ready, and dismisses", async () => {
    renderBar();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready — restart dohc to apply it.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.3",
    });
    const toast = await screen.findByTestId("update-toast");
    expect(toast.textContent).toContain("Update 1.2.3 is ready");

    await userEvent.click(screen.getByRole("button", { name: /dismiss update/i }));
    expect(screen.queryByTestId("update-toast")).toBeNull();
  });

  it("keeps subscription state when the initial update fetch resolves later", async () => {
    const pending = deferred<UpdateStateEvent>();
    (
      (window as unknown as {
        dohcDesktop: {
          getUpdateState: { mockReturnValueOnce(value: Promise<UpdateStateEvent>): void };
        };
      }).dohcDesktop as {
        getUpdateState: { mockReturnValueOnce(value: Promise<UpdateStateEvent>): void };
      }
    ).getUpdateState.mockReturnValueOnce(pending.promise);
    renderBar();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready — restart dohc to apply it.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.3",
    });
    await screen.findByTestId("update-toast");

    pending.resolve({
      status: "idle",
      message: "Updates have not been checked yet.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: true,
      canInstall: false,
    });

    await waitFor(() =>
      expect(screen.getByTestId("update-toast").textContent).toContain(
        "Update 1.2.3 is ready",
      ),
    );
  });

  it("ignores every non-ready state (checking/downloading/error stay silent)", () => {
    renderBar();
    for (const status of ["checking", "downloading", "offline", "error"] as const) {
      pushUpdate?.({ status, message: "noise" });
    }
    expect(screen.queryByTestId("update-toast")).toBeNull();
  });

  it("unsubscribes from the update channel on unmount", () => {
    renderBar().unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("sync status surface", () => {
  it("keeps the pinned testid/data-state and shows no count when clean", () => {
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
    });
    const status = screen.getByTestId("sync-status");
    expect(status.getAttribute("data-state")).toBe("synced");
    expect(status.textContent).not.toContain("(");
  });

  it("shows the workspace name in the left cluster (plan E2 status-bar item)", () => {
    renderBar();
    expect(screen.getByTestId("status-workspace").textContent).toBe("my-notes");
  });

  it("appends the conflict COUNT only in the conflict state", () => {
    renderBar({
      syncStatus: {
        state: "conflict",
        pendingChangeCount: 2,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
        conflictCount: 2,
      },
    });
    expect(screen.getByTestId("sync-status").textContent).toContain("Conflict (2)");
  });
});

describe("notice center", () => {
  it("keeps a clear notice for each file that is too large to sync", async () => {
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
        sharingDeclined: [
          {
            path: "notes/large.md",
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limitBytes: 262_144,
            observedBytes: 280_001,
          },
        ],
      },
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));

    const notice = screen.getByTestId(
      "notice-sharing-declined-notes/large.md",
    );
    expect(notice.textContent).toContain("File is too large to sync");
    expect(notice.textContent).toContain("notes/large.md");
    expect(notice.textContent).toContain("280,001 bytes");
    expect(notice.textContent).toContain("262,144 bytes");
    expect(notice.textContent).toContain("Your edit is saved on this machine.");
    expect(notice.textContent).toContain("Reduce the file to sync it.");
  });

  it("collects conflict, agent, and update notices in one popover", async () => {
    const onOpenConflicts = vi.fn();
    const onOpenHistory = vi.fn();
    renderBar({
      syncStatus: {
        state: "conflict",
        pendingChangeCount: 2,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
        conflictCount: 2,
      },
      agentActive: true,
      conflictSummaries: ["Both sides changed notes/today.md."],
      onOpenConflicts,
      onOpenHistory,
    });
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready — restart dohc to apply it.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.3",
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const center = screen.getByTestId("notice-center");
    expect(within(center).getByTestId("notice-center-count").textContent).toBe("3");
    expect(within(center).getByTestId("notice-sync-conflict").textContent).toContain(
      "Both sides changed notes/today.md.",
    );
    expect(within(center).getByTestId("notice-agent-active").textContent).toContain(
      "Agent running",
    );
    expect(within(center).getByTestId("notice-update-ready").textContent).toContain(
      "Update 1.2.3 is ready",
    );

    // The conflict notice's Review action opens the conflict review dialog
    // (0P-C), not History.
    await userEvent.click(within(center).getByRole("button", { name: "Review" }));
    expect(onOpenConflicts).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("notice-center")).toBeNull();

    // The running-agent notice points at History — the place the run's
    // edits land (the dedicated Agent panel is retired).
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(
      within(screen.getByTestId("notice-center")).getByRole("button", {
        name: "Open History",
      }),
    );
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });

  // #874: a database the engine refuses is a designed recovery outcome, not
  // a generic capture failure. The notice must say what was found in the
  // user's nouns, state that files are untouched, and offer the rebuild —
  // and it REPLACES the "History paused" copy, which says nothing is wrong
  // with the store and offers no recovery.
  it("explains an unreadable data store and offers the rebuild", async () => {
    const onRebuildEngineStore = vi.fn();
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyCaptureFailed: true,
        engineStoreRefused: "unsupported-fingerprint",
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
      onRebuildEngineStore,
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-engine-store-refused");
    expect(notice.textContent).toContain("dohc can't read this data store");
    expect(notice.textContent).toContain("Your files are untouched.");
    expect(notice.textContent).toContain(".dohc/engine/pre-v2-backup");
    expect(screen.queryByTestId("notice-history-capture-failed")).toBeNull();

    await userEvent.click(within(notice).getByRole("button", { name: "Rebuild" }));
    expect(onRebuildEngineStore).toHaveBeenCalledOnce();
  });

  it("uses the same facts for a foreign-database refusal", async () => {
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyCaptureFailed: true,
        engineStoreRefused: "foreign-database",
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
      onRebuildEngineStore: vi.fn(),
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-engine-store-refused");
    expect(notice.textContent).toContain("dohc can't read this data store");
    expect(notice.textContent).toContain("Your files are untouched.");
    expect(screen.queryByTestId("notice-history-capture-failed")).toBeNull();
  });

  it("titles the conflict notice in two-machine language with calm fallback copy", async () => {
    renderBar({
      syncStatus: {
        state: "conflict",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
        conflictCount: 1,
      },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-sync-conflict");
    expect(notice.textContent).toContain("A file changed on two machines");
    expect(notice.textContent).toContain(
      "Both copies are safe. Review the differences to choose what stays.",
    );
  });

  // AUDIT-OPTOUT: an unreadable settings file reads as opted out, so nothing is
  // recorded. The flip must never be silent, and it must not claim the user
  // turned the engine off in Settings.
  it("names the unreadable settings file instead of blaming the engine setting", async () => {
    const onOpenSettings = vi.fn();
    renderBar({
      onOpenSettings,
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
        historyRecordingOff: true,
        // #483: the cause rides main's open-time read, on the same status
        // that decided history is off. One read answers both.
        settingsWarning:
          "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.",
      },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-workspace-settings-unreadable");
    expect(notice.textContent).toContain("History is off for this workspace");
    expect(notice.textContent).toContain("/ws/.dohc/settings.local.json");
    expect(screen.queryByTestId("notice-history-recording-off")).toBeNull();
    // The notice owes a Next the user can act on, as a control.
    await userEvent.click(within(notice).getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("blames the engine setting when the settings file reads normally", async () => {
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
        historyRecordingOff: true,
      },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(
      screen.getByTestId("notice-history-recording-off").textContent,
    ).toContain("The workspace engine is turned off in Settings");
    expect(screen.queryByTestId("notice-history-recording-unavailable")).toBeNull();
  });

  // #505: the recorder failed to build. Nothing records, exactly as for the
  // opt-out — so the two states arrive at this surface together and only the
  // cause separates them. The failure must not wear the opt-out's copy.
  it("names the failure when the recorder could not be built", async () => {
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingOff: true,
        historyRecordingUnavailable: true,
        historyShareView: false,
      },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-history-recording-unavailable");
    expect(notice.textContent).toContain("History is off for this workspace");
    expect(notice.textContent).toContain(
      "dohc could not start recording history for this workspace.",
    );
    // The Next: main builds the recorder once per app session, so a reopen
    // retries nothing.
    expect(notice.textContent).toContain("Restart dohc to try again.");
    // Never the opt-out's cause, and never both notices at once.
    expect(notice.textContent).not.toContain("turned off in Settings");
    expect(screen.queryByTestId("notice-history-recording-off")).toBeNull();
  });

  // #540: a shared view records no history BY DESIGN — a capability, not an
  // opt-out and not a failure. Every history-off notice states a cause that
  // is false for a shared view, so the share banner speaks and this surface
  // stays quiet.
  it("raises no history-off notice for a shared view", async () => {
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingOff: true,
        historyRecordingUnavailable: false,
        historyShareView: true,
      },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    // The panel opened, so a missing notice means no notice — not a missed
    // render.
    expect(screen.getByTestId("notice-center")).toBeTruthy();
    // The opt-out's copy would blame a Settings toggle nobody touched.
    expect(screen.queryByTestId("notice-history-recording-off")).toBeNull();
    expect(screen.queryByTestId("notice-history-recording-unavailable")).toBeNull();
    expect(screen.queryByTestId("notice-workspace-settings-unreadable")).toBeNull();
  });

  it("shows all clear when there are no notices", async () => {
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).toContain("All clear");
  });

  it("shows the persistent history-capture-failure notice while capture is failing (PR 0M-7)", async () => {
    const onOpenHistory = vi.fn();
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
        engineStoreRefused: null,
        historyCaptureFailed: true,
      },
      onOpenHistory,
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const center = screen.getByTestId("notice-center");
    expect(within(center).getByTestId("notice-center-count").textContent).toBe("1");
    const notice = within(center).getByTestId("notice-history-capture-failed");
    expect(notice.textContent).toContain("History paused");
    expect(notice.textContent).toContain(
      "dohc couldn't record history for this workspace. Your files are safe on disk, but recent changes may be missing from History.",
    );
    await userEvent.click(
      within(center).getByRole("button", { name: "Open History" }),
    );
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });

  it("clears the history-capture-failure notice when the status reports recovery", async () => {
    const failedStatus = {
      state: "synced" as const,
      pendingChangeCount: 0,
      lastSyncedAtMs: null,
      historyRecordingUnavailable: false,
      historyShareView: false,
      engineStoreRefused: null,
      historyCaptureFailed: true as const,
    };
    const { rerender } = renderBar({ syncStatus: failedStatus });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(
      within(screen.getByTestId("notice-center")).getByTestId(
        "notice-history-capture-failed",
      ),
    ).toBeTruthy();

    const {
      historyCaptureFailed: _historyCaptureFailed,
      engineStoreRefused: _engineStoreRefused,
      ...recoveredStatus
    } = failedStatus;
    rerender(
      <StatusBar
        workspaceId="ws-status-test"
        workspaceName="my-notes"
        syncStatus={recoveredStatus}
        agentActive={false}
        conflictSummaries={[]}
        onConnectCloud={() => {}}
        onOpenHistory={() => {}}
        onOpenConflicts={() => {}}
        onOpenSettings={() => {}}
        onRebuildEngineStore={() => {}}
        onToggleTheme={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(screen.getByTestId("notice-center").textContent).toContain("All clear");
  });

  it("keeps the notice center open when dismissing the update toast", async () => {
    renderBar();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready — restart dohc to apply it.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.3",
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(screen.getByRole("button", { name: /dismiss update/i }));

    expect(screen.queryByTestId("update-toast")).toBeNull();
    expect(screen.getByTestId("notice-center").textContent).toContain(
      "Update 1.2.3 is ready",
    );
  });

  it("calls installUpdate from the update notice action", async () => {
    renderBar();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready — restart dohc to apply it.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.3",
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(
      within(screen.getByTestId("notice-center")).getByRole("button", {
        name: "Restart",
      }),
    );

    expect(installUpdate).toHaveBeenCalledOnce();
  });

  it("shows restart failures in the update notice and toast", async () => {
    installUpdate.mockResolvedValueOnce({
      accepted: false,
      completed: false,
      state: {
        status: "ready",
        message: "Update 1.2.3 is ready — restart dohc to apply it.",
        currentVersion: "1.2.2",
        channel: "latest",
        canCheck: false,
        canInstall: true,
        version: "1.2.3",
      },
    });
    renderBar();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready — restart dohc to apply it.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.3",
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(
      within(screen.getByTestId("notice-center")).getByRole("button", {
        name: "Restart",
      }),
    );

    await screen.findByText("Could not restart into the update.");
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-update-ready").textContent).toContain(
      "Could not restart into the update.",
    );
  });

  it("does not show the restart action when the update is not installable", async () => {
    renderBar();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready — restart dohc to apply it.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: false,
      version: "1.2.3",
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));

    expect(screen.getByTestId("notice-update-ready").textContent).toContain(
      "Update 1.2.3 is ready",
    );
    expect(
      within(screen.getByTestId("notice-center")).queryByRole("button", {
        name: "Restart",
      }),
    ).toBeNull();
  });

  it("surfaces agent notifications with specific copy, newest first", async () => {
    renderBar({
      agentNotifications: [
        agentNotice({ id: "ws-a::run-1::finished", createdAtMs: 1000 }),
        agentNotice({
          id: "ws-a::run-2::asked",
          kind: "asked",
          runId: "run-2",
          title: "Your agent has a question",
          body: "Which draft should I keep?",
          createdAtMs: 2000,
        }),
      ],
      onDismissAgentNotification: vi.fn(),
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const center = screen.getByTestId("notice-center");
    expect(within(center).getByTestId("notice-center-count").textContent).toBe("2");
    // Newest (the ask) leads; specific copy is shown verbatim.
    const items = within(center).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Which draft should I keep?");
    expect(within(center).getByText("Reorganized /notes into three folders.")).toBeTruthy();
  });

  it("dismisses an agent notification through its dismiss action", async () => {
    const onDismissAgentNotification = vi.fn();
    const notice = agentNotice();
    renderBar({
      agentNotifications: [notice],
      onDismissAgentNotification,
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(
      within(screen.getByTestId("notice-center")).getByTestId(
        "notice-ws-a::run-1::finished-dismiss",
      ),
    );
    expect(onDismissAgentNotification).toHaveBeenCalledWith("ws-a::run-1::finished");
  });

  it("closes the notice popover on outside click while preserving inside clicks", async () => {
    renderBar({
      syncStatus: {
        state: "cloud-disconnected",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(screen.getByTestId("notice-center"));
    expect(screen.getByTestId("notice-center")).toBeTruthy();

    await userEvent.click(document.body);
    expect(screen.queryByTestId("notice-center")).toBeNull();
  });
});
