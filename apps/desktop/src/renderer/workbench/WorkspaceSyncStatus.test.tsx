// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSyncStatus } from "./WorkspaceSyncStatus";
import type { SyncStatusResult } from "../../ipc/bridgeContract";

afterEach(cleanup);
function renderStatus(props: { syncStatus: SyncStatusResult | null; failedSaves?: number }) {
  return render(<WorkspaceSyncStatus failedSaves={0} {...props} />);
}

// The dot's kind: saved, working, waiting or attention.
const dotOf = () => screen.getByTestId("sync-status").querySelector("[data-dot]")?.getAttribute("data-dot");
// Whether the label shows beside the dot, or only names it.
const worded = () => !screen.getByTestId("sync-status").querySelector("span:not([data-dot])")?.classList.contains("sr-only");

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

function syncState(
  state: SyncStatusResult["state"],
  syncFailure?: SyncStatusResult["syncFailure"],
): SyncStatusResult {
  return {
    state,
    pendingChangeCount: 1,
    lastSyncedAtMs: null,
    liveSessionsGeneration: 0,
    historyRecordingUnavailable: false,
    historyShareView: false,
    ...(syncFailure ? { syncFailure } : {}),
  };
}

describe("sync status surface", () => {
  it("names identity setup while keeping the existing sync state", () => {
    const { rerender } = renderStatus({ syncStatus: { ...syncState("syncing"), claimingIdentity: true } });
    expect(screen.getByTestId("sync-status").textContent).toBe("Setting up sync…");
    expect(screen.getByTestId("sync-status").getAttribute("data-state")).toBe("syncing");
    rerender(<WorkspaceSyncStatus syncStatus={{ ...syncState("sync-failed"), claimingIdentity: true }} failedSaves={0} />);
    expect(screen.getByTestId("sync-status").textContent).toBe("Sync failed");
    rerender(<WorkspaceSyncStatus syncStatus={syncState("syncing")} failedSaves={0} />);
    expect(screen.getByTestId("sync-status").textContent).toBe("Syncing…");
  });

  // edges-05: a pass in flight read "Saving…" beside a document that said
  // Saved. The files are on disk; only the sync is under way.
  it("calls a pass in flight syncing, never saving", () => {
    renderStatus({ syncStatus: syncState("syncing") });
    const status = screen.getByTestId("sync-status");
    expect(status.textContent).toBe("Syncing…");
    expect(status.textContent).not.toContain("Sav");
  });

  it("names the server when the server is what failed", () => {
    const { rerender } = renderStatus({
      syncStatus: syncState("sync-failed", {
        cause: "server-unreachable",
        detail: "RelayUnreachableError: dohc could not reach the server.",
        sinceMs: 1,
        attempts: 1,
      }),
    });
    const status = screen.getByTestId("sync-status");
    expect(status.getAttribute("data-state")).toBe("sync-failed");
    expect(status.textContent).toBe("Server unreachable");
    rerender(
      <WorkspaceSyncStatus
        syncStatus={syncState("sync-failed", { cause: "unknown", detail: "Error: refused", sinceMs: 1, attempts: 1 })}
        failedSaves={0}
      />,
    );
    expect(screen.getByTestId("sync-status").textContent).toBe("Sync failed");
  });

  it("keeps the pinned testid/data-state and shows no count when clean", () => {
    renderStatus({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
    });
    const status = screen.getByTestId("sync-status");
    expect(status.getAttribute("data-state")).toBe("synced");
    expect(status.textContent).not.toContain("(");
  });

  // One saved mark in one place: a saved workspace shows the dot alone, and
  // its words stay its accessible name and tooltip.
  it("shows a saved workspace as the dot alone, named for screen readers", () => {
    renderStatus({ syncStatus: syncState("synced") });
    const status = screen.getByRole("status", { name: "Local · saved" });
    expect(status.getAttribute("title")).toBe("Local · saved");
    expect(dotOf()).toBe("saved");
    expect(worded()).toBe(false);
  });

  // A sync pass is work in flight: a ring, its words kept for the name.
  it("shows a sync pass as a ring and a lost server in words", () => {
    const { rerender } = renderStatus({ syncStatus: syncState("syncing") });
    const status = screen.getByTestId("sync-status");
    expect(dotOf()).toBe("working");
    expect(worded()).toBe(false);
    rerender(<WorkspaceSyncStatus syncStatus={syncState("cloud-disconnected")} failedSaves={0} />);
    expect(status.getAttribute("data-state")).toBe("cloud-disconnected");
    expect(dotOf()).toBe("waiting");
    expect(worded()).toBe(true);
  });

  // A file whose save failed: the title bar must not say saved over it.
  it("names the files that couldn't save instead of saved, and says saved again once they clear", () => {
    const { rerender } = renderStatus({ syncStatus: syncState("synced"), failedSaves: 1 });
    const status = screen.getByTestId("sync-status");
    expect(status.textContent).toBe("Couldn't save 1 file");
    expect(status.getAttribute("aria-label")).toBe("Couldn't save 1 file");
    expect(status.getAttribute("data-state")).toBe("save-failed");
    expect(dotOf()).toBe("attention");
    expect(worded()).toBe(true);
    expect(status.textContent).not.toContain("saved");

    // It stays through a sync pass, so the mark does not flicker to Syncing.
    rerender(<WorkspaceSyncStatus syncStatus={syncState("syncing")} failedSaves={2} />);
    expect(status.textContent).toBe("Couldn't save 2 files");

    rerender(<WorkspaceSyncStatus syncStatus={syncState("synced")} failedSaves={0} />);
    expect(status.textContent).toBe("Local · saved");
    expect(status.getAttribute("data-state")).toBe("synced");
    expect(dotOf()).toBe("saved");
    expect(worded()).toBe(false);
  });

  it("leaves conflicts, failed syncs and required updates ahead of a failed save", () => {
    const { rerender } = renderStatus({ syncStatus: { ...syncState("conflict"), conflictCount: 1 }, failedSaves: 1 });
    const status = screen.getByTestId("sync-status");
    expect(status.textContent).toBe("Conflict (1)");
    expect(status.getAttribute("data-state")).toBe("conflict");
    rerender(<WorkspaceSyncStatus syncStatus={syncState("sync-failed")} failedSaves={1} />);
    expect(status.textContent).toBe("Sync failed");
    rerender(
      <WorkspaceSyncStatus syncStatus={{ ...syncState("cloud-disconnected"), updateRequired: "app" }} failedSaves={1} />,
    );
    expect(status.textContent).toBe("Update dohc to sync");
    expect(dotOf()).toBe("attention");
  });

  it("appends the conflict COUNT only in the conflict state", () => {
    renderStatus({
      syncStatus: {
        state: "conflict",
        pendingChangeCount: 2,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
        conflictCount: 2,
      },
    });
    expect(screen.getByTestId("sync-status").textContent).toContain("Conflict (2)");
  });

  // Self-hosting: the thing the user connects is their server, and every
  // other surface that names this state says the same word.
  it("names a lost connection as the server, not the cloud", () => {
    renderStatus({
      syncStatus: {
        state: "cloud-disconnected",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
    });
    const status = screen.getByTestId("sync-status");
    expect(status.textContent).toBe("Server disconnected");
    expect(status.textContent).not.toMatch(/cloud/i);
  });

  // Owner live delivery reads beside the local save state, never inside it:
  // a saved file proves nothing about live editing.
  it.each([
    { delivery: "preparing" as const, reason: undefined, label: "Preparing live editing" },
    { delivery: "active" as const, reason: undefined, label: "Live editing active" },
    { delivery: "retrying" as const, reason: undefined, label: "Live editing retrying" },
    {
      delivery: "retrying" as const,
      reason: "document-unavailable" as const,
      label: "Live editing paused",
    },
    {
      delivery: "retrying" as const,
      reason: "restart-required" as const,
      label: "Live editing paused",
    },
    {
      delivery: "retrying" as const,
      reason: "session-host-refused" as const,
      label: "Live editing stopped",
    },
    {
      delivery: "retrying" as const,
      reason: "session-host-diverged" as const,
      label: "Live editing stopped",
    },
    {
      delivery: "retrying" as const,
      reason: "live-document-without-lineage" as const,
      label: "Live editing can't start",
    },
    {
      delivery: "retrying" as const,
      reason: "live-edit-unadmitted" as const,
      label: "Live editing can't resume",
    },
    {
      delivery: "retrying" as const,
      reason: "conflict-parent-withheld" as const,
      label: "Live editing can't resume",
    },
  ])("labels $delivery owner live delivery as $label", ({ delivery, reason, label }) => {
    renderStatus({ syncStatus: liveDeliveryStatus(delivery, reason) });
    const live = screen.getByTestId("owner-live-delivery-status");
    expect(live.textContent).toBe(label);
    expect(live.getAttribute("data-state")).toBe(delivery);
    if (reason === "conflict-parent-withheld") {
      expect(live.querySelector(".bg-warning")).not.toBeNull();
      expect(live.querySelector(".animate-spin")).toBeNull();
    }
    // Local saving keeps its own line, and active delivery never claims it.
    const status = screen.getByTestId("sync-status");
    expect(status.textContent).toContain("Local · saved");
    expect(status.contains(live)).toBe(false);
    expect(live.textContent).not.toMatch(/synced|up to date/i);
  });

  it("says nothing about live delivery when the status reports none", () => {
    renderStatus({
      syncStatus: {
        state: "synced",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
      },
    });
    expect(screen.queryByTestId("owner-live-delivery-status")).toBeNull();
  });

  it.each([
    ["app", "Update dohc to sync"],
    ["server", "Server needs an update"],
  ] as const)("names the side to update when sync stopped on the relay API version (%s)", (updateRequired, label) => {
    renderStatus({
      syncStatus: {
        state: "cloud-disconnected",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
        updateRequired,
      },
    });
    const status = screen.getByTestId("sync-status");
    expect(status.getAttribute("data-state")).toBe("cloud-disconnected");
    expect(status.getAttribute("aria-label")).toBe(label);
    expect(status.textContent).toBe(label);
  });
});
