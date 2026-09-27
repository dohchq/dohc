// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSyncStatus } from "./WorkspaceSyncStatus";
import type { SyncStatusResult } from "../../ipc/bridgeContract";

afterEach(cleanup);
function renderStatus(props: { syncStatus: SyncStatusResult | null }) {
  return render(<WorkspaceSyncStatus {...props} />);
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
    rerender(<WorkspaceSyncStatus syncStatus={{ ...syncState("sync-failed"), claimingIdentity: true }} />);
    expect(screen.getByTestId("sync-status").textContent).toBe("Sync failed");
    rerender(<WorkspaceSyncStatus syncStatus={syncState("syncing")} />);
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
    expect(screen.getByText("Local · saved").classList.contains("sr-only")).toBe(false);
    expect(status.textContent).not.toContain("(");
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
  ])("labels $delivery owner live delivery as $label", ({ delivery, reason, label }) => {
    renderStatus({ syncStatus: liveDeliveryStatus(delivery, reason) });
    const live = screen.getByTestId("owner-live-delivery-status");
    expect(live.textContent).toBe(label);
    expect(live.getAttribute("data-state")).toBe(delivery);
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
