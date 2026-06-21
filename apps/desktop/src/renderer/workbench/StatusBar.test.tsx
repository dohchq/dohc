// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStateEvent } from "../../ipc/bridgeContract";
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
      onOpenSettings={() => {}}
      onToggleTheme={() => {}}
      onContextMenu={props.onContextMenu ?? (() => {})}
    />,
  );
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
    const onOpenHistory = vi.fn();
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
      onOpenHistory,
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

    await userEvent.click(within(center).getByRole("button", { name: "Review" }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("notice-center")).toBeNull();

    await userEvent.click(screen.getByTestId("notice-center-toggle"));
    await userEvent.click(
      within(screen.getByTestId("notice-center")).getByRole("button", { name: "Open" }),
    );
    expect(onOpenAgent).toHaveBeenCalledOnce();
  });

  it("shows all clear when there are no notices", async () => {
    renderBar({
      syncStatus: { state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null },
    });
    await userEvent.click(screen.getByTestId("notice-center-toggle"));
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
