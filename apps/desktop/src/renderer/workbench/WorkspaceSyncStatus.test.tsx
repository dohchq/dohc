// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSyncStatus } from "./WorkspaceSyncStatus";
import type { SyncStatusResult } from "../../ipc/bridgeContract";

afterEach(cleanup);
function renderStatus(props: { syncStatus: SyncStatusResult | null; failedSaves?: number }) {
  return render(<WorkspaceSyncStatus failedSaves={0} {...props} />);
}

// The dot's kind: saved, working, waiting, off or attention.
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

  // #3294: a busy server needs nothing from the person, so it is a ring with
  // its words kept for the name, and a failed save still shows over it.
  it("shows a busy server as a ring, not a failure", () => {
    const busy = syncState("sync-failed", {
      cause: "server-busy", detail: "RelayBusyError: The server is busy.", sinceMs: 1, attempts: 3,
    });
    const { rerender } = renderStatus({ syncStatus: busy });
    const status = screen.getByRole("status", { name: "Server busy. dohc keeps trying to sync." });
    expect(status.getAttribute("data-state")).toBe("sync-failed");
    expect(status.getAttribute("title")).toBe("Server busy. dohc keeps trying to sync.");
    expect(status.textContent).toBe("Server busy");
    expect(dotOf()).toBe("working");
    expect(worded()).toBe(false);
    rerender(<WorkspaceSyncStatus syncStatus={busy} failedSaves={1} />);
    expect(status.textContent).toBe("Couldn't save 1 file");
    expect(dotOf()).toBe("attention");
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
  it("shows a sync pass as a ring", () => {
    renderStatus({ syncStatus: syncState("syncing") });
    expect(dotOf()).toBe("working");
    expect(worded()).toBe(false);
  });

  // The server isn't the cause, so the title bar never names it. Signed out
  // is a choice, so it shows sync off, not a fault; an account dohc can't
  // confirm, or an expired sign-in, needs the person, so it takes the
  // attention mark. None borrows another's words.
  const BLOCKED_TITLE_BAR = {
    "not-connected": {
      words: "Connect server to sync",
      description: "Not syncing. Connect your server to sync this workspace.",
      dot: "off",
    },
    "account-unconfirmed": {
      words: "Couldn't confirm account",
      description: "Not syncing. dohc couldn't confirm this workspace's account.",
      dot: "attention",
    },
    "sign-in-expired": {
      words: "Sign in again to sync",
      description: "Not syncing. Your sign-in expired.",
      dot: "attention",
    },
  } as const;
  it.each(Object.keys(BLOCKED_TITLE_BAR) as Array<keyof typeof BLOCKED_TITLE_BAR>)(
    "says why a synced workspace isn't syncing (%s), and reads saved again once it can",
    (state) => {
      const expected = BLOCKED_TITLE_BAR[state];
      const { rerender } = renderStatus({ syncStatus: syncState(state) });
      const status = screen.getByRole("status", { name: expected.description });
      expect(status.getAttribute("data-state")).toBe(state);
      expect(status.textContent).toBe(expected.words);
      expect(status.getAttribute("title")).toBe(expected.description);
      expect(status.textContent).not.toMatch(/server unreachable/i);
      expect(`${status.textContent} ${status.getAttribute("title")}`).not.toMatch(/could not/);
      for (const other of Object.values(BLOCKED_TITLE_BAR)) {
        if (other !== expected) expect(status.textContent).not.toBe(other.words);
      }
      expect(dotOf()).toBe(expected.dot);
      expect(worded()).toBe(true);

      rerender(<WorkspaceSyncStatus syncStatus={syncState("synced")} failedSaves={0} />);
      expect(status.getAttribute("data-state")).toBe("synced");
      expect(status.getAttribute("aria-label")).toBe("Local · saved");
      expect(dotOf()).toBe("saved");
    },
  );

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
      <WorkspaceSyncStatus syncStatus={{ ...syncState("update-required"), updateRequired: "app" }} failedSaves={1} />,
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
        ...syncState("sync-failed"),
        syncFailure: { cause: "server-unreachable", detail: "dohc could not reach the server.", sinceMs: 1, attempts: 1 },
      },
    });
    const status = screen.getByTestId("sync-status");
    expect(status.textContent).toBe("Server unreachable");
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
      label: "Live editing stopped",
    },
    {
      delivery: "retrying" as const,
      reason: "conflict-parent-withheld" as const,
      label: "Live editing can't resume",
    },
    {
      delivery: "retrying" as const,
      reason: "live-history-over-budget" as const,
      label: "Live editing can't start",
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

  // A retry with no reason is dohc still dialling, so it takes the ring a sync
  // pass uses. A named reason waits on someone and keeps the filled dot.
  it("shows a live retry with no reason as a ring", () => {
    const liveDot = () =>
      screen.getByTestId("owner-live-delivery-status").querySelector("[data-dot]")?.getAttribute("data-dot");
    const { rerender } = renderStatus({ syncStatus: liveDeliveryStatus("retrying") });
    expect(liveDot()).toBe("working");

    rerender(<WorkspaceSyncStatus syncStatus={liveDeliveryStatus("retrying", "document-unavailable")} failedSaves={0} />);
    expect(liveDot()).toBeUndefined();
    rerender(<WorkspaceSyncStatus syncStatus={liveDeliveryStatus("active")} failedSaves={0} />);
    expect(liveDot()).toBeUndefined();
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

  // Live editing needs the server. While the title bar names the server as
  // the problem, live editing adds nothing, and it comes back by itself.
  it.each([
    {
      label: "Server unreachable",
      server: {
        state: "sync-failed" as const,
        syncFailure: { cause: "server-unreachable" as const, detail: "dohc could not reach the server.", sinceMs: 1, attempts: 1 },
      },
    },
  ])("hides live editing while the title bar says $label", ({ label, server }) => {
    const { rerender } = renderStatus({ syncStatus: { ...liveDeliveryStatus("retrying"), ...server } });
    expect(screen.getByTestId("sync-status").textContent).toBe(label);
    expect(screen.queryByTestId("owner-live-delivery-status")).toBeNull();

    rerender(<WorkspaceSyncStatus syncStatus={liveDeliveryStatus("preparing")} failedSaves={0} />);
    expect(screen.getByTestId("owner-live-delivery-status").textContent).toBe("Preparing live editing");
    rerender(<WorkspaceSyncStatus syncStatus={liveDeliveryStatus("active")} failedSaves={0} />);
    expect(screen.getByTestId("owner-live-delivery-status").textContent).toBe("Live editing active");
  });

  // Any other failure leaves the server's reach unknown, so live editing still speaks.
  it("keeps live editing beside a sync failure that does not name the server", () => {
    renderStatus({
      syncStatus: {
        ...liveDeliveryStatus("retrying"),
        state: "sync-failed",
        syncFailure: { cause: "unknown", detail: "Error: boom", sinceMs: 1, attempts: 1 },
      },
    });
    expect(screen.getByTestId("sync-status").textContent).toBe("Sync failed");
    expect(screen.getByTestId("owner-live-delivery-status").textContent).toBe("Live editing retrying");
  });

  // The title bar doesn't name the server, so live editing shows beside its
  // words: no server connection, an account dohc can't confirm, a failed save,
  // or a required update.
  it.each([
    { label: "Connect server to sync", status: { state: "not-connected" as const }, failedSaves: 0 },
    { label: "Couldn't confirm account", status: { state: "account-unconfirmed" as const }, failedSaves: 0 },
    { label: "Sign in again to sync", status: { state: "sign-in-expired" as const }, failedSaves: 0 },
    { label: "Couldn't save 1 file", status: { state: "account-unconfirmed" as const }, failedSaves: 1 },
    { label: "Update dohc to sync", status: { state: "update-required" as const, updateRequired: "app" as const }, failedSaves: 0 },
  ])("keeps live editing beside $label", ({ label, status, failedSaves }) => {
    renderStatus({ syncStatus: { ...liveDeliveryStatus("retrying"), ...status }, failedSaves });
    expect(screen.getByTestId("sync-status").textContent).toBe(label);
    expect(screen.getByTestId("owner-live-delivery-status").textContent).toBe("Live editing retrying");
  });

  it.each([
    ["app", "Update dohc to sync"],
    ["server", "Server needs an update"],
  ] as const)("names the side to update when sync stopped on the relay API version (%s)", (updateRequired, label) => {
    renderStatus({
      syncStatus: {
        state: "update-required",
        pendingChangeCount: 0,
        lastSyncedAtMs: null,
        liveSessionsGeneration: 0,
        historyRecordingUnavailable: false,
        historyShareView: false,
        updateRequired,
      },
    });
    const status = screen.getByTestId("sync-status");
    expect(status.getAttribute("data-state")).toBe("update-required");
    expect(status.getAttribute("aria-label")).toBe(label);
    expect(status.textContent).toBe(label);
  });
});
