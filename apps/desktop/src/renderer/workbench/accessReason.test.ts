import { describe, expect, it } from "vitest";
import { accessReasonForLane } from "./accessReason";

describe("accessReasonForLane", () => {
  it("prioritizes signed-out over not-synced when no server is connected", () => {
    expect(
      accessReasonForLane(
        {
          cloud: { connected: false, workspaceSynced: false, workspaceSyncConnected: false },
          shareView: false,
        },
        "granted",
      ),
    ).toBe("signed-out");
  });

  it("reports not-synced when signed in to a server but the workspace is not synced", () => {
    expect(
      accessReasonForLane(
        {
          cloud: { connected: true, workspaceSynced: false, workspaceSyncConnected: false },
          shareView: false,
        },
        "granted",
      ),
    ).toBe("not-synced");
  });

  it("reports other-account when signed in to a different account than the synced workspace", () => {
    expect(
      accessReasonForLane(
        {
          cloud: { connected: true, workspaceSynced: true, workspaceSyncConnected: false },
          shareView: false,
        },
        "granted",
      ),
    ).toBe("other-account");
  });
});
