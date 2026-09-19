// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSyncStatus } from "./WorkspaceSyncStatus";
import type { SyncStatusResult } from "../../ipc/bridgeContract";

afterEach(cleanup);
function renderStatus(props: { syncStatus: SyncStatusResult | null }) {
  return render(<WorkspaceSyncStatus {...props} />);
}

describe("sync status surface", () => {
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
});

