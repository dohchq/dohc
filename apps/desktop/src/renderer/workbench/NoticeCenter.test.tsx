// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UpdateActionResult,
  UpdateStateEvent,
} from "../../ipc/bridgeContract";
import type { AgentNotification } from "./agentNotifications";
import { NoticeCenter } from "./NoticeCenter";
import { deferred } from "../../testing/deferred";

// Captures the renderer-side update listener exactly as the preload would
// install it — the auto-updater itself never runs in dev/test (gated on
// isPackaged + DOHC_UPDATE_URL), so the surface is driven with a fake.
let pushUpdate: ((state: UpdateStateEvent) => void) | null = null;
const unsubscribe = vi.fn();
const installUpdate = vi.fn(async (): Promise<UpdateActionResult> => ({
  accepted: true,
  state: {
    status: "ready" as const,
    message: "Update 1.2.3 is ready. Restart dohc to apply it.",
    currentVersion: "1.2.2",
    channel: "latest" as const,
    canCheck: false,
    canInstall: true,
    version: "1.2.3",
  },
}));

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

function noticeElement(props: Partial<Parameters<typeof NoticeCenter>[0]> = {}) {
  return (
    <NoticeCenter
      workspaceId="ws-status-test"
      syncStatus={props.syncStatus ?? null}
      agentActive={props.agentActive ?? false}
      conflictSummaries={props.conflictSummaries ?? []}
      onOpenHistory={props.onOpenHistory ?? (() => {})}
      onOpenConflicts={props.onOpenConflicts ?? (() => {})}
      onRefreshShareView={props.onRefreshShareView ?? (() => {})}
      {...(props.agentNotifications ? { agentNotifications: props.agentNotifications } : {})}
      {...(props.onDismissAgentNotification
        ? { onDismissAgentNotification: props.onDismissAgentNotification }
        : {})}
      onOpenSettings={props.onOpenSettings ?? (() => {})}
      onRebuildEngineStore={props.onRebuildEngineStore ?? (() => {})}
      {...(props.workspaceErrors ? { workspaceErrors: props.workspaceErrors } : {})}
      {...(props.onRetryWorkspaceError ? { onRetryWorkspaceError: props.onRetryWorkspaceError } : {})}
      {...(props.onHideWorkspaceError ? { onHideWorkspaceError: props.onHideWorkspaceError } : {})}
      {...(props.onDismissWorkspaceError ? { onDismissWorkspaceError: props.onDismissWorkspaceError } : {})}
    />
  );
}

function renderNotices(props: Partial<Parameters<typeof NoticeCenter>[0]> = {}) {
  return render(noticeElement(props));
}

function agentNotice(overrides: Partial<AgentNotification> = {}): AgentNotification {
  return {
    id: "ws-a::run-1::finished",
    kind: "finished",
    workspaceId: "ws-a",
    workspaceName: "Personal",
    agentName: "You",
    runId: "run-1",
    title: "Your agent finished",
    body: "Reorganized /notes into three folders.",
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("update toast", () => {
  it("shows the machine's message when an update becomes ready, and dismisses", async () => {
    renderNotices();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
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
    renderNotices();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
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

  it.each(["checking", "downloading", "offline"] as const)(
    "keeps the %s state silent",
    (status) => {
      renderNotices();
      const listener = pushUpdate;
      expect(listener).toBeTypeOf("function");
      if (!listener) throw new Error("The update listener was not installed.");

      act(() => listener({ status, message: "noise" }));

      expect(screen.queryByTestId("update-toast")).toBeNull();
    },
  );

  it("unsubscribes from the update channel on unmount", () => {
    renderNotices().unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("notice center", () => {
  it("offers to repair shared files whose folder projection is pending", async () => {
    const onRefreshShareView = vi.fn();
    renderNotices({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: true,
        historyCaptureFailed: false,
        shareProjection: {
          state: "pending",
          pendingPathCount: 2,
          pendingPaths: ["notes/one.md", "notes/two.md"],
          collisionPathCount: 0,
          collisionPaths: [],
          pullInFlight: false,
        },
      },
      onRefreshShareView,
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-share-projection-pending");
    expect(notice.textContent).toContain("Shared files need repair");
    expect(notice.textContent).toContain(
      "Some shared files are not current in this folder. Refresh the shared view to repair them.",
    );

    await userEvent.click(within(notice).getByRole("button", { name: "Refresh" }));
    expect(onRefreshShareView).toHaveBeenCalledOnce();
  });

  it("keeps a clear notice for each file that is too large to sync", async () => {
    renderNotices({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
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
    renderNotices({
      syncStatus: {
        state: "conflict",
        pendingChangeCount: 2,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
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
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
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

  it.each([
    {
      cause: "unsupported-fingerprint" as const,
      sentence:
        "This workspace's data store is not in the format this version of dohc uses.",
      otherSentence: "dohc cannot read this workspace's data store.",
    },
    {
      cause: "foreign-database" as const,
      sentence: "dohc cannot read this workspace's data store.",
      otherSentence:
        "This workspace's data store is not in the format this version of dohc uses.",
    },
  ])("explains the $cause refusal and offers the rebuild", async ({
    cause,
    sentence,
    otherSentence,
  }) => {
    const onRebuildEngineStore = vi.fn();
    renderNotices({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyCaptureFailed: true,
        engineStoreRefused: cause,
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
      onRebuildEngineStore,
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-engine-store-refused");
    expect(within(notice).getByText(sentence)).toBeTruthy();
    expect(within(notice).queryByText(otherSentence)).toBeNull();
    expect(notice.textContent).not.toContain("older");
    expect(notice.textContent).not.toContain("not created by dohc");
    expect(notice.textContent).toContain("Your files are untouched.");
    expect(notice.textContent).toContain(".dohc/engine/pre-v2-backup");
    expect(screen.queryByTestId("notice-history-capture-failed")).toBeNull();

    await userEvent.click(within(notice).getByRole("button", { name: "Rebuild" }));
    expect(onRebuildEngineStore).toHaveBeenCalledOnce();
  });

  // A store this build could not migrate is intact. The notice names the
  // failure and the next step, and offers no rebuild that would lose it.
  it("names a migration failure without offering the rebuild", async () => {
    const onRebuildEngineStore = vi.fn();
    renderNotices({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyCaptureFailed: true,
        engineStoreRefused: "migration-failed",
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
      onRebuildEngineStore,
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-engine-store-refused");
    expect(notice.textContent).toContain(
      "dohc could not update this workspace's data store to this version.",
    );
    expect(notice.textContent).toContain("Update dohc to continue. Your files are unchanged.");
    expect(within(notice).queryByRole("button", { name: "Rebuild" })).toBeNull();
    expect(onRebuildEngineStore).not.toHaveBeenCalled();
  });

  // A workspace error arrives as a toast in the corner and stays as a row in
  // Notices. Try again and Copy ride with it; closing the toast keeps the row.
  it("shows a workspace error as a toast and a notice with retry and copy", async () => {
    const onRetryWorkspaceError = vi.fn();
    const onDismissWorkspaceError = vi.fn();
    const user = userEvent.setup();
    const error = {
      id: "shell-error-1",
      message: "Could not refresh history. The engine did not answer.",
      details: "Error: Could not refresh history. The engine did not answer.\nWorkspace: personal",
      atMs: 1_000,
      canRetry: true,
      seen: false,
    };
    const barProps = (seen: boolean) => ({
      workspaceErrors: [{ ...error, seen }],
      onRetryWorkspaceError,
      onHideWorkspaceError: vi.fn(),
      onDismissWorkspaceError,
    });
    const { rerender } = renderNotices(barProps(false));

    const toast = screen.getByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("Could not refresh history.");
    await user.click(within(toast).getByRole("button", { name: "Copy error details" }));
    expect(await navigator.clipboard.readText()).toContain("Workspace: personal");
    expect(screen.getAllByRole("status").some((el) => el.textContent === "Copied")).toBe(true);
    // Closing the toast marks the error seen: the toast goes, the row stays.
    await user.click(within(toast).getByRole("button", { name: "Dismiss workspace error" }));
    rerender(noticeElement(barProps(true)));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = screen.getByTestId("notice-shell-error-1");
    expect(row.textContent).toContain("Could not refresh history.");
    await user.click(within(row).getByRole("button", { name: "Try again" }));
    expect(onRetryWorkspaceError).toHaveBeenCalledWith("shell-error-1");
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(within(screen.getByTestId("notice-shell-error-1")).getByRole("button", { name: "Dismiss notice" }));
    expect(onDismissWorkspaceError).toHaveBeenCalledWith("shell-error-1");
  });

  it("titles the conflict notice in two-machine language with calm fallback copy", async () => {
    renderNotices({
      syncStatus: {
        state: "conflict",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
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

  // The recorder failed to build, so nothing records.
  it("names the failure when the recorder could not be built", async () => {
    renderNotices({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
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
  });

  // A shared view records no history by design, a capability, not a
  // failure. The share banner speaks and this surface stays quiet.
  it("raises no history-off notice for a shared view", async () => {
    renderNotices({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: true,
      },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    // The panel opened, so a missing notice means no notice — not a missed
    // render.
    expect(screen.getByTestId("notice-center")).toBeTruthy();
    expect(screen.queryByTestId("notice-history-recording-unavailable")).toBeNull();
  });

  it("shows all clear when there are no notices", async () => {
    renderNotices({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).toContain("All clear");
  });

  it("shows the persistent history-capture-failure notice while capture is failing", async () => {
    const onOpenHistory = vi.fn();
    renderNotices({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
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
      liveSessionsGeneration: 0,
      historyRecordingUnavailable: false,
      historyShareView: false,
      engineStoreRefused: null,
      historyCaptureFailed: true as const,
    };
    const { rerender } = renderNotices({ syncStatus: failedStatus });
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
      <NoticeCenter
        workspaceId="ws-status-test"
        syncStatus={recoveredStatus}
        agentActive={false}
        conflictSummaries={[]}
        onOpenHistory={() => {}}
        onOpenConflicts={() => {}}
        onRefreshShareView={() => {}}
        onOpenSettings={() => {}}
        onRebuildEngineStore={() => {}}
      />,
    );
    expect(screen.getByTestId("notice-center").textContent).toContain("All clear");
  });

  it("keeps the notice center open when dismissing the update toast", async () => {
    renderNotices();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
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
    renderNotices();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
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

  it("keeps the install result after an older update event arrives", async () => {
    const pendingInstall = deferred<UpdateActionResult>();
    installUpdate.mockReturnValueOnce(pendingInstall.promise);
    renderNotices();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
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
    await waitFor(() => expect(installUpdate).toHaveBeenCalledOnce());

    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.3",
    });
    pendingInstall.resolve({
      accepted: true,
      state: {
        status: "ready",
        message: "Update 1.2.4 is ready. Restart dohc to apply it.",
        currentVersion: "1.2.2",
        channel: "latest",
        canCheck: false,
        canInstall: true,
        version: "1.2.4",
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("update-toast").textContent).toContain(
        "Update 1.2.4 is ready",
      ),
    );
  });

  it("shows restart failures in the update notice and toast", async () => {
    installUpdate.mockResolvedValueOnce({
      accepted: false,
      state: {
        status: "ready",
        message: "Update 1.2.3 is ready. Restart dohc to apply it.",
        currentVersion: "1.2.2",
        channel: "latest",
        canCheck: false,
        canInstall: true,
        version: "1.2.3",
      },
    });
    renderNotices();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
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

  it("shows a restart failure after the ready toast was dismissed", async () => {
    installUpdate.mockResolvedValueOnce({
      accepted: false,
      state: {
        status: "ready",
        message: "Update 1.2.3 is ready. Restart dohc to apply it.",
        currentVersion: "1.2.2",
        channel: "latest",
        canCheck: false,
        canInstall: true,
        version: "1.2.3",
      },
    });
    renderNotices();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: true,
      version: "1.2.3",
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss update notice" }),
    );
    expect(screen.queryByTestId("update-toast")).toBeNull();

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(
      within(screen.getByTestId("notice-center")).getByRole("button", {
        name: "Restart",
      }),
    );

    expect((await screen.findByTestId("update-toast")).textContent).toContain(
      "Could not restart into the update.",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss update notice" }),
    );
    expect(screen.queryByTestId("update-toast")).toBeNull();
  });

  it("keeps updater errors visible with a working next step", async () => {
    const onOpenSettings = vi.fn();
    installUpdate.mockResolvedValueOnce({
      accepted: false,
      state: {
        status: "error",
        message: "dohc could not install the update. Try again.",
        currentVersion: "1.2.2",
        channel: "latest",
        canCheck: true,
        canInstall: false,
      },
    });
    renderNotices({ onOpenSettings });
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
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

    const toast = await screen.findByTestId("update-toast");
    expect(toast.textContent).toContain(
      "dohc could not install the update. Try again.",
    );
    expect(within(toast).queryByRole("button", { name: "Restart" })).toBeNull();
    await userEvent.click(
      within(toast).getByRole("button", { name: "Open Settings" }),
    );
    expect(onOpenSettings).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const updateNotice = screen.getByTestId("notice-update-error");
    expect(updateNotice.textContent).toContain(
      "dohc could not install the update. Try again.",
    );
    expect(within(updateNotice).queryByRole("button", { name: "Restart" }))
      .toBeNull();
    expect(within(updateNotice).getByRole("button", { name: "Open Settings" }))
      .toBeTruthy();
  });

  it("surfaces live updater errors in the toast and notice center", async () => {
    const onOpenSettings = vi.fn();
    renderNotices({ onOpenSettings });

    pushUpdate?.({
      status: "error",
      message: "dohc could not check for updates. Try again.",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: true,
      canInstall: false,
    });

    const toast = await screen.findByTestId("update-toast");
    expect(toast.textContent).toContain(
      "dohc could not check for updates. Try again.",
    );
    await userEvent.click(
      within(toast).getByRole("button", { name: "Open Settings" }),
    );
    expect(onOpenSettings).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const updateNotice = screen.getByTestId("notice-update-error");
    expect(updateNotice.textContent).toContain(
      "dohc could not check for updates. Try again.",
    );
    expect(
      within(updateNotice).getByRole("button", { name: "Open Settings" }),
    ).toBeTruthy();

    pushUpdate?.({
      status: "checking",
      message: "Checking for updates…",
      currentVersion: "1.2.2",
      channel: "latest",
      canCheck: false,
      canInstall: false,
    });
    await waitFor(() => expect(screen.queryByTestId("update-toast")).toBeNull());
    expect(screen.queryByTestId("notice-update-error")).toBeNull();
  });

  it("does not show the restart action when the update is not installable", async () => {
    renderNotices();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready. Restart dohc to apply it.",
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
    renderNotices({
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
    renderNotices({
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
    renderNotices({
      syncStatus: {
        state: "cloud-disconnected",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
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
