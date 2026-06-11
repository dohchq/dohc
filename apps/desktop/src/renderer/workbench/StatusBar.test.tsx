// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStateEvent } from "../../ipc/bridgeContract";
import { StatusBar } from "./StatusBar";

// Captures the renderer-side update listener exactly as the preload would
// install it — the auto-updater itself never runs in dev/test (gated on
// isPackaged + DOHC_UPDATE_URL), so the surface is driven with a fake.
let pushUpdate: ((state: UpdateStateEvent) => void) | null = null;
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.stubGlobal("dohcDesktop", {
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

function renderBar(syncStatus: Parameters<typeof StatusBar>[0]["syncStatus"] = null) {
  return render(
    <StatusBar
      workspaceName="my-notes"
      syncStatus={syncStatus}
      agentActive={false}
      onConnectCloud={() => {}}
      onOpenSettings={() => {}}
      onToggleTheme={() => {}}
    />,
  );
}

describe("update toast", () => {
  it("shows the machine's message when an update becomes ready, and dismisses", async () => {
    renderBar();
    pushUpdate?.({
      status: "ready",
      message: "Update 1.2.3 is ready — restart dohc to apply it.",
    });
    const toast = await screen.findByTestId("update-toast");
    expect(toast.textContent).toContain("Update 1.2.3 is ready");

    await userEvent.click(screen.getByRole("button", { name: /dismiss update/i }));
    expect(screen.queryByTestId("update-toast")).toBeNull();
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
    renderBar({ state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null });
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
      state: "conflict",
      pendingChangeCount: 2,
      lastSyncedAtMs: null,
      conflictCount: 2,
    });
    expect(screen.getByTestId("sync-status").textContent).toContain("Conflict (2)");
  });
});
