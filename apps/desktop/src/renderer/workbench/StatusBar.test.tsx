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
      workspaceName="my-notes"
      syncStatus={props.syncStatus ?? null}
      agentActive={props.agentActive ?? false}
      conflictSummaries={props.conflictSummaries ?? []}
      onConnectCloud={() => {}}
      onOpenAgent={props.onOpenAgent ?? (() => {})}
      onOpenHistory={props.onOpenHistory ?? (() => {})}
      onOpenConflicts={props.onOpenConflicts ?? (() => {})}
      {...(props.onDismissSyncReview
        ? { onDismissSyncReview: props.onDismissSyncReview }
        : {})}
      {...(props.agentNotifications ? { agentNotifications: props.agentNotifications } : {})}
      {...(props.onOpenAgentNotification
        ? { onOpenAgentNotification: props.onOpenAgentNotification }
        : {})}
      {...(props.onDismissAgentNotification
        ? { onDismissAgentNotification: props.onDismissAgentNotification }
        : {})}
      onOpenSettings={() => {}}
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
      syncStatus: { state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null },
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
        conflictCount: 2,
      },
    });
    expect(screen.getByTestId("sync-status").textContent).toContain("Conflict (2)");
  });
});

describe("notice center", () => {
  it("collects conflict, agent, and update notices in one popover", async () => {
    const onOpenConflicts = vi.fn();
    const onOpenAgent = vi.fn();
    renderBar({
      syncStatus: {
        state: "conflict",
        pendingChangeCount: 2,
        lastSyncedAtMs: null,
        conflictCount: 2,
      },
      agentActive: true,
      conflictSummaries: ["Both sides changed notes/today.md."],
      onOpenConflicts,
      onOpenAgent,
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

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(
      within(screen.getByTestId("notice-center")).getByRole("button", { name: "Open" }),
    );
    expect(onOpenAgent).toHaveBeenCalledOnce();
  });

  it("titles the conflict notice in two-machine language with calm fallback copy", async () => {
    renderBar({
      syncStatus: {
        state: "conflict",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
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

  it("surfaces an unmatched remote conflict resolution as a review notice (0P-C)", async () => {
    const onOpenHistory = vi.fn();
    renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        unmatchedRemoteResolves: 1,
      },
      onOpenHistory,
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-sync-review");
    expect(notice.textContent).toContain("A choice made on another machine needs a look");
    await userEvent.click(within(notice).getByRole("button", { name: "Open History" }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });

  // 0P-C gate fix: the review notice reflects LIVE state — it disappears
  // when the pending set clears, and the X acknowledges it explicitly.
  it("dismisses the sync-review notice explicitly and clears it when the state clears", async () => {
    const onDismissSyncReview = vi.fn();
    const { rerender } = renderBar({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        unmatchedRemoteResolves: 1,
      },
      onDismissSyncReview,
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const notice = screen.getByTestId("notice-sync-review");
    await userEvent.click(within(notice).getByTestId("notice-sync-review-dismiss"));
    expect(onDismissSyncReview).toHaveBeenCalledOnce();

    // Live state: once main reports the set cleared, the notice is gone.
    rerender(
      <StatusBar
        workspaceName="my-notes"
        syncStatus={{
          state: "synced",
          pendingChangeCount: 0,
          lastSyncedAtMs: null,
          unmatchedRemoteResolves: 0,
        }}
        agentActive={false}
        conflictSummaries={[]}
        onConnectCloud={() => {}}
        onOpenAgent={() => {}}
        onOpenHistory={() => {}}
        onOpenConflicts={() => {}}
        onDismissSyncReview={onDismissSyncReview}
        onOpenSettings={() => {}}
        onToggleTheme={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(screen.queryByTestId("notice-sync-review")).toBeNull();
  });

  it("shows all clear when there are no notices", async () => {
    renderBar({
      syncStatus: { state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null },
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
      historyCaptureFailed: true,
    };
    const { rerender } = renderBar({ syncStatus: failedStatus });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(
      within(screen.getByTestId("notice-center")).getByTestId(
        "notice-history-capture-failed",
      ),
    ).toBeTruthy();

    rerender(
      <StatusBar
        workspaceName="my-notes"
        syncStatus={{ ...failedStatus, historyCaptureFailed: false }}
        agentActive={false}
        conflictSummaries={[]}
        onConnectCloud={() => {}}
        onOpenAgent={() => {}}
        onOpenHistory={() => {}}
        onOpenConflicts={() => {}}
        onOpenSettings={() => {}}
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
      onOpenAgentNotification: vi.fn(),
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

  it("opens and dismisses an agent notification through its actions", async () => {
    const onOpenAgentNotification = vi.fn();
    const onDismissAgentNotification = vi.fn();
    const notice = agentNotice();
    renderBar({
      agentNotifications: [notice],
      onOpenAgentNotification,
      onDismissAgentNotification,
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    const center = screen.getByTestId("notice-center");
    await userEvent.click(within(center).getByRole("button", { name: "Open" }));
    expect(onOpenAgentNotification).toHaveBeenCalledWith(notice);

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
      },
    });

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(screen.getByTestId("notice-center"));
    expect(screen.getByTestId("notice-center")).toBeTruthy();

    await userEvent.click(document.body);
    expect(screen.queryByTestId("notice-center")).toBeNull();
  });
});
