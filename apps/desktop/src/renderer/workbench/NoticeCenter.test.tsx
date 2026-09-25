// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SyncStatusResult,
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
      workspaceId={props.workspaceId ?? "ws-status-test"}
      {...(props.host ? { host: props.host } : {})}
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
      {...(props.onWorkspaceErrorAction ? { onWorkspaceErrorAction: props.onWorkspaceErrorAction } : {})}
      {...(props.onHideWorkspaceError ? { onHideWorkspaceError: props.onHideWorkspaceError } : {})}
      {...(props.onDismissWorkspaceError ? { onDismissWorkspaceError: props.onDismissWorkspaceError } : {})}
      {...(props.onRetryLiveDelivery ? { onRetryLiveDelivery: props.onRetryLiveDelivery } : {})}
      {...(props.onOpenLiveDocuments ? { onOpenLiveDocuments: props.onOpenLiveDocuments } : {})}
      {...(props.automationFailures ? { automationFailures: props.automationFailures } : {})}
      {...(props.automationHolds ? { automationHolds: props.automationHolds } : {})}
      {...(props.onAllowAutomationHold ? { onAllowAutomationHold: props.onAllowAutomationHold } : {})}
      {...(props.automationHoldsUnreadable ? { automationHoldsUnreadable: props.automationHoldsUnreadable } : {})}
      {...(props.onResetAutomationHolds ? { onResetAutomationHolds: props.onResetAutomationHolds } : {})}
      {...(props.onRevealAutomationHolds ? { onRevealAutomationHolds: props.onRevealAutomationHolds } : {})}
    />
  );
}

function renderNotices(props: Partial<Parameters<typeof NoticeCenter>[0]> = {}) {
  return render(noticeElement(props));
}

// A clean workspace whose only news is owner live delivery. A fresh object
// every call, so a rerender models a new status read rather than the same
// snapshot handed back.
function liveDeliveryStatus(
  ownerLiveDelivery: NonNullable<SyncStatusResult["ownerLiveDelivery"]>,
  ownerLiveDeliveryReason?: SyncStatusResult["ownerLiveDeliveryReason"],
): SyncStatusResult {
  return {
    state: "synced",
    pendingChangeCount: 0,
    lastSyncedAtMs: null,
    liveSessionsGeneration: 0,
    historyRecordingUnavailable: false,
    historyShareView: false,
    ownerLiveDelivery,
    ...(ownerLiveDeliveryReason ? { ownerLiveDeliveryReason } : {}),
  };
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

describe("automation failure notices", () => {
  it("sends a Collection automation's failure to its automations.yaml, not to a plugin's source", async () => {
    renderNotices({
      automationFailures: [
        { automationId: "collection:Projects/Tasks#finished-date", claimId: "atc_1", chainStopped: false,
          error: "ana@dohc.test cannot edit Budget.", updatedAtMs: 5_000, generation: 1 },
        { automationId: "collection:Projects/Tasks#nudge", claimId: "atc_2", chainStopped: true,
          error: "chain-stopped", updatedAtMs: 6_000, generation: 2 },
      ],
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const failed = await screen.findByTestId("notice-automation-failure-collection:Projects/Tasks#finished-date");
    expect(failed.textContent).toContain('Automation "finished-date" failed');
    expect(failed.textContent).toContain(
      "ana@dohc.test cannot edit Budget. Open Projects/Tasks/automations.yaml to fix the automation.",
    );
    const stopped = screen.getByTestId("notice-automation-failure-collection:Projects/Tasks#nudge");
    expect(stopped.textContent).toContain('"nudge" did not run. Open Projects/Tasks/automations.yaml to shorten the chain.');
    expect(document.body.textContent).not.toContain("plugin's source");
  });

  it("says every automation waits when dohc cannot read the allowed steps, and offers a way back", async () => {
    const onResetAutomationHolds = vi.fn();
    const onRevealAutomationHolds = vi.fn();
    renderNotices({ automationHoldsUnreadable: true, onResetAutomationHolds, onRevealAutomationHolds });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = await screen.findByTestId("notice-automation-holds-unreadable");
    expect(notice.textContent).toContain("Automations are waiting");
    await userEvent.click(within(notice).getByRole("button", { name: "Reset holds" }));
    // An action closes the panel, so open it again for the other one.
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const again = await screen.findByTestId("notice-automation-holds-unreadable");
    await userEvent.click(within(again).getByRole("button", { name: "Open folder" }));
    expect(onResetAutomationHolds).toHaveBeenCalledOnce();
    expect(onRevealAutomationHolds).toHaveBeenCalledOnce();
  });

  it("asks once to allow a step that reaches more only because an editor left", async () => {
    const hold = {
      automationId: "collection:Trip#spend", automationName: "Spend", definitionHash: "0123456789abcdef",
      step: 0, seq: 4, collection: "Trip", target: "Budget", action: "change" as const, stoppedFor: "bob@dohc.test",
    };
    const onAllowAutomationHold = vi.fn();
    renderNotices({ automationHolds: [hold], onAllowAutomationHold });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = await screen.findByTestId("notice-automation-hold-collection:Trip#spend-0");
    expect(notice.textContent).toContain('Automation "Spend" is waiting');
    expect(notice.textContent).toContain(
      "A step in Trip can now change Budget. It stopped before because bob@dohc.test could not. Allow it to run?",
    );
    await userEvent.click(within(notice).getByRole("button", { name: "Allow" }));
    expect(onAllowAutomationHold).toHaveBeenCalledWith(hold);
  });
});

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
    expect(document.activeElement).toBe(screen.getByTestId("notice-center-toggle"));
  });

  it("preserves focus assigned by a notice action", async () => {
    render(<input aria-label="History filter" />);
    const destination = screen.getByRole("textbox", { name: "History filter" });
    renderNotices({ agentActive: true, onOpenHistory: () => destination.focus() });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(within(screen.getByTestId("notice-center")).getByRole("button", { name: "Open History" }));
    expect(document.activeElement).toBe(destination);
    expect(screen.queryByTestId("notice-center")).toBeNull();
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

  it("offers a workspace error its fixing step beside Try again, on the toast and the row", async () => {
    const onWorkspaceErrorAction = vi.fn();
    const onRetryWorkspaceError = vi.fn();
    const user = userEvent.setup();
    const error = {
      id: "shell-error-2",
      message: "dohc ignored accent in dohc-settings.json because it is not a setting dohc knows. The other settings apply.",
      details: "Error: dohc ignored accent",
      atMs: 1_000,
      canRetry: true,
      actionLabel: "Open settings file",
      seen: false,
    };
    renderNotices({ workspaceErrors: [error], onWorkspaceErrorAction, onRetryWorkspaceError });
    const toast = screen.getByTestId("workspace-shell-error");
    await user.click(within(toast).getByRole("button", { name: "Open settings file" }));
    expect(onWorkspaceErrorAction).toHaveBeenCalledWith("shell-error-2");
    expect(within(toast).getByRole("button", { name: "Try again" })).toBeTruthy();

    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = screen.getByTestId("notice-shell-error-2");
    expect(within(row).getAllByRole("button").map((button) => button.textContent))
      .toEqual(expect.arrayContaining(["Open settings file", "Try again"]));
    await user.click(within(row).getByRole("button", { name: "Try again" }));
    expect(onRetryWorkspaceError).toHaveBeenCalledWith("shell-error-2");
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

  it.each([
    ["app", "Update dohc to sync", "This server needs a newer version of dohc. Update dohc to sync again."],
    ["server", "Server needs an update", "Ask the person who runs it to update it. Then restart dohc."],
  ] as const)("says who must update when sync stopped on the relay API version (%s)", async (updateRequired, title, next) => {
    renderNotices({
      syncStatus: {
        state: "cloud-disconnected",
        pendingChangeCount: 1,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
        updateRequired,
      },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-relay-update-required");
    expect(notice.textContent).toContain(title);
    expect(notice.textContent).toContain(next);
    expect(notice.textContent).toContain("Your changes stay on this computer.");
    // Reconnecting would not help, so the disconnected notice stays away.
    expect(screen.queryByTestId("notice-cloud-disconnected")).toBeNull();
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

  it("stands the toast stack down while the notice center is open", async () => {
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

    // Every toast has a row in the panel, so the stack gets out of the way
    // instead of sitting over the surface the user just opened.
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.queryByTestId("update-toast")).toBeNull();
    expect(screen.getByTestId("notice-center").textContent).toContain(
      "Update 1.2.3 is ready",
    );

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(
      await screen.findByRole("button", { name: /dismiss update/i }),
    );
    expect(screen.queryByTestId("update-toast")).toBeNull();
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

  // Owner live delivery is its own fact. Only "retrying" raises a notice, and
  // what it offers depends on whether anything can be dialled again.
  it("raises a toast and a notice with Copy while live delivery retries", async () => {
    const onRetryLiveDelivery = vi.fn();
    const user = userEvent.setup();
    renderNotices({ syncStatus: liveDeliveryStatus("retrying"), onRetryLiveDelivery });

    const toast = screen.getByTestId("owner-live-delivery-toast");
    expect(toast.textContent).toContain("Live editing retrying");
    expect(toast.textContent).toContain("Your edits are saved on this device.");

    await user.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-owner-live-delivery");
    expect(notice.textContent).toContain("Live editing retrying");
    await user.click(
      within(notice).getByRole("button", { name: "Copy error details" }),
    );
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("Live editing: Live editing retrying");
    expect(copied).toContain("Workspace id: ws-status-test");

    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    expect(onRetryLiveDelivery).toHaveBeenCalledOnce();
  });

  it("runs the shell's retry from the live delivery toast", async () => {
    const onRetryLiveDelivery = vi.fn();
    renderNotices({ syncStatus: liveDeliveryStatus("retrying"), onRetryLiveDelivery });

    await userEvent.click(screen.getByTestId("owner-live-delivery-toast-action"));
    expect(onRetryLiveDelivery).toHaveBeenCalledOnce();
  });

  // A document that moved, or a workspace that changed, is not a connection
  // to dial again: the way forward is the live-document list, and nothing
  // here re-binds a document identity on the user's behalf.
  it.each([
    {
      reason: "document-unavailable" as const,
      body: "A document this workspace was editing live is no longer available.",
    },
    {
      reason: "workspace-changed" as const,
      body: "This workspace changed while live editing was running.",
    },
  ])("offers the live documents list for a $reason pause", async ({ reason, body }) => {
    const onOpenLiveDocuments = vi.fn();
    const onRetryLiveDelivery = vi.fn();
    renderNotices({
      syncStatus: liveDeliveryStatus("retrying", reason),
      onOpenLiveDocuments,
      onRetryLiveDelivery,
    });

    expect(screen.getByTestId("owner-live-delivery-toast").textContent).toContain(body);
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-owner-live-delivery");
    expect(notice.textContent).toContain("Live editing paused");
    expect(notice.textContent).toContain(body);
    expect(within(notice).queryByRole("button", { name: "Try again" })).toBeNull();

    await userEvent.click(
      within(notice).getByRole("button", { name: "Live documents" }),
    );
    expect(onOpenLiveDocuments).toHaveBeenCalledOnce();
    expect(onRetryLiveDelivery).not.toHaveBeenCalled();
  });

  // There is no command that restarts the app for the user, so the notice
  // names the step instead of offering a control that cannot run.
  it("names the restart without offering a retry", async () => {
    const onRetryLiveDelivery = vi.fn();
    const onOpenLiveDocuments = vi.fn();
    renderNotices({
      syncStatus: liveDeliveryStatus("retrying", "restart-required"),
      onRetryLiveDelivery,
      onOpenLiveDocuments,
    });

    expect(
      screen.queryByTestId("owner-live-delivery-toast-action"),
    ).toBeNull();
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-owner-live-delivery");
    expect(notice.textContent).toContain("Restart dohc to enable live editing.");
    expect(within(notice).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(
      within(notice).queryByRole("button", { name: "Live documents" }),
    ).toBeNull();
  });

  it("clears the live delivery toast and notice when delivery recovers", async () => {
    const { rerender } = renderNotices({ syncStatus: liveDeliveryStatus("retrying") });
    expect(screen.getByTestId("owner-live-delivery-toast")).toBeTruthy();

    rerender(noticeElement({ syncStatus: liveDeliveryStatus("active") }));
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.queryByTestId("notice-owner-live-delivery")).toBeNull();
    expect(screen.getByTestId("notice-center").textContent).toContain("All clear");
  });

  // Status snapshots arrive on every workspace activity. A dismissed toast
  // must not come back because an equal snapshot was read again.
  it("does not raise the live delivery toast again for a repeated snapshot", async () => {
    const { rerender } = renderNotices({ syncStatus: liveDeliveryStatus("retrying") });
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss live editing notice" }),
    );
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();

    rerender(noticeElement({ syncStatus: liveDeliveryStatus("retrying") }));
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();
    // The row stays: the state is still true, only its announcement is over.
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-owner-live-delivery")).toBeTruthy();
  });

  // A dismissal answers one workspace. The same failure in the next workspace
  // is news the user has not seen, so it must still be announced.
  it("announces an identical live delivery failure in another workspace", async () => {
    const { rerender } = renderNotices({ syncStatus: liveDeliveryStatus("retrying") });
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss live editing notice" }),
    );
    expect(screen.queryByTestId("owner-live-delivery-toast")).toBeNull();

    rerender(
      noticeElement({
        workspaceId: "ws-status-other",
        syncStatus: liveDeliveryStatus("retrying"),
      }),
    );
    expect(screen.getByTestId("owner-live-delivery-toast")).toBeTruthy();
  });

  // Recovery forgets the dismissal, so the next failure is announced again.
  it("announces a new live delivery failure after a recovery", async () => {
    const { rerender } = renderNotices({ syncStatus: liveDeliveryStatus("retrying") });
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss live editing notice" }),
    );

    rerender(noticeElement({ syncStatus: liveDeliveryStatus("active") }));
    rerender(noticeElement({ syncStatus: liveDeliveryStatus("retrying") }));
    expect(screen.getByTestId("owner-live-delivery-toast")).toBeTruthy();
  });

  // Enrollment refusals are one boolean on the status: however many shares it
  // covers, the user gets one announcement and one row, and the list is the
  // only surface that can name the files.
  describe("owner live refusals", () => {
    function refusalsStatus(hasOwnerLiveRefusals: boolean): SyncStatusResult {
      return {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
        hasOwnerLiveRefusals,
      };
    }

    it("raises one toast and one row that open the live documents list", async () => {
      const onOpenLiveDocuments = vi.fn();
      const user = userEvent.setup();
      const { rerender } = renderNotices({
        syncStatus: refusalsStatus(true),
        onOpenLiveDocuments,
      });

      const toast = screen.getByTestId("owner-live-refusals-toast");
      expect(toast.textContent).toContain("Some shares could not start live editing");
      // A repeated status read is the same fact, not a second one.
      rerender(
        noticeElement({ syncStatus: refusalsStatus(true), onOpenLiveDocuments }),
      );
      expect(screen.getAllByTestId("owner-live-refusals-toast")).toHaveLength(1);

      await user.click(screen.getByTestId("notice-center-toggle"));
      const notice = screen.getByTestId("notice-owner-live-refusals");
      expect(screen.getAllByTestId("notice-owner-live-refusals")).toHaveLength(1);
      await user.click(within(notice).getByRole("button", { name: "Live documents" }));
      expect(onOpenLiveDocuments).toHaveBeenCalledOnce();
    });

    // The toast and the row are the same fact, so they must paste the same
    // generic report — no share id, no engine code, no engine message.
    it("copies matching safe details from the toast and the row", async () => {
      const user = userEvent.setup();
      renderNotices({ syncStatus: refusalsStatus(true), onOpenLiveDocuments: vi.fn() });

      await user.click(screen.getByTestId("owner-live-refusals-toast-copy"));
      const fromToast = await navigator.clipboard.readText();
      expect(fromToast).toContain(
        "Live editing: Some shares could not start live editing",
      );
      expect(fromToast).toContain("Workspace id: ws-status-test");

      await user.click(screen.getByTestId("notice-center-toggle"));
      await user.click(screen.getByTestId("notice-owner-live-refusals-copy"));
      expect(await navigator.clipboard.readText()).toBe(fromToast);
    });

    it("keeps the row after the toast is closed, and stays closed for a repeat", async () => {
      const user = userEvent.setup();
      const { rerender } = renderNotices({ syncStatus: refusalsStatus(true) });

      await user.click(
        screen.getByRole("button", { name: "Dismiss live editing refusals notice" }),
      );
      expect(screen.queryByTestId("owner-live-refusals-toast")).toBeNull();

      rerender(noticeElement({ syncStatus: refusalsStatus(true) }));
      expect(screen.queryByTestId("owner-live-refusals-toast")).toBeNull();

      await user.click(screen.getByTestId("notice-center-toggle"));
      expect(screen.getByTestId("notice-owner-live-refusals")).toBeTruthy();
    });

    it("clears the toast and the row once the workspace reports no refusals", async () => {
      const { rerender } = renderNotices({ syncStatus: refusalsStatus(true) });
      expect(screen.getByTestId("owner-live-refusals-toast")).toBeTruthy();

      rerender(noticeElement({ syncStatus: refusalsStatus(false) }));
      expect(screen.queryByTestId("owner-live-refusals-toast")).toBeNull();

      await userEvent.click(screen.getByTestId("notice-center-toggle"));
      expect(screen.queryByTestId("notice-owner-live-refusals")).toBeNull();
      expect(screen.getByTestId("notice-center").textContent).toContain("All clear");
    });

    // Recovery forgets the dismissal: the next refusal is news again.
    it("announces a refusal again after a recovery", async () => {
      const { rerender } = renderNotices({ syncStatus: refusalsStatus(true) });
      await userEvent.click(
        screen.getByRole("button", { name: "Dismiss live editing refusals notice" }),
      );

      rerender(noticeElement({ syncStatus: refusalsStatus(false) }));
      rerender(noticeElement({ syncStatus: refusalsStatus(true) }));
      expect(screen.getByTestId("owner-live-refusals-toast")).toBeTruthy();
    });

    // A dismissal answers one workspace. The next workspace's refusals are a
    // fact this user has not seen yet.
    it("announces the same refusal in another workspace", async () => {
      const { rerender } = renderNotices({ syncStatus: refusalsStatus(true) });
      await userEvent.click(
        screen.getByRole("button", { name: "Dismiss live editing refusals notice" }),
      );
      expect(screen.queryByTestId("owner-live-refusals-toast")).toBeNull();

      rerender(
        noticeElement({
          workspaceId: "ws-status-other",
          syncStatus: refusalsStatus(true),
        }),
      );
      expect(screen.getByTestId("owner-live-refusals-toast")).toBeTruthy();
    });

    // A share view has no live-document list to open, so the notice must not
    // offer a way in that cannot exist.
    it("states the refusal without an action when no list is available", async () => {
      renderNotices({ syncStatus: refusalsStatus(true) });

      expect(screen.queryByTestId("owner-live-refusals-toast-action")).toBeNull();
      await userEvent.click(screen.getByTestId("notice-center-toggle"));
      const notice = screen.getByTestId("notice-owner-live-refusals");
      expect(
        within(notice).queryByRole("button", { name: "Live documents" }),
      ).toBeNull();
    });
  });

  // Where the bell is decides where the rest of this center may sit. The rail
  // hosts it on the left; a surface with no rail hosts it in the corner the
  // toasts would otherwise take, so neither may cover the toggle.
  describe("host placement", () => {
    const shellError = {
      id: "shell-error-1",
      message: "dohc could not check this connection.",
      details: "Error: dohc could not check this connection.",
      atMs: 1_700_000_000_000,
      canRetry: false,
      seen: false,
    };

    it("keeps the toast corner and the rail-side panel by default", async () => {
      renderNotices({ workspaceErrors: [shellError] });

      const toasts = screen.getByTestId("notice-toasts");
      expect(toasts.className).toContain("bottom-3");
      expect(toasts.className).toContain("right-3");

      await userEvent.click(screen.getByTestId("notice-center-toggle"));
      expect(screen.getByTestId("notice-center").className).toContain("left-14");
      // Every toast row is in the panel now, so the stack goes away.
      expect(screen.queryByTestId("notice-toasts")).toBeNull();
    });

    it("clears a corner-hosted bell with the toasts and the panel", async () => {
      renderNotices({ workspaceErrors: [shellError], host: "corner" });

      // The toggle owns the bottom-right corner here, so the stack starts
      // above it instead of landing on top of it.
      const toasts = screen.getByTestId("notice-toasts");
      expect(toasts.className).toContain("bottom-14");
      expect(toasts.className).not.toContain("bottom-3");
      expect(toasts.className).toContain("right-3");

      await userEvent.click(screen.getByTestId("notice-center-toggle"));
      // The panel opens next to the toggle that owns it, not across the window.
      const panel = screen.getByTestId("notice-center");
      expect(panel.className).toContain("bottom-14");
      expect(panel.className).toContain("right-3");
      expect(panel.className).not.toContain("left-14");
      expect(screen.queryByTestId("notice-toasts")).toBeNull();
    });
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
