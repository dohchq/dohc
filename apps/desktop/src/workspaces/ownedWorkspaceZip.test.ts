import { describe, expect, it } from "vitest";
import { ownedZipProjectionPlan } from "./ownedWorkspaceZip";

describe("ownedZipProjectionPlan", () => {
  it("replaces raw projections in a whole-workspace export", () => {
    const plan = ownedZipProjectionPlan({
      kind: "workspace-root",
      archiveRoot: null,
    });

    expect(plan.keepDiskEntry("notes/local.md")).toBe(true);
    expect(plan.keepDiskEntry("shared-with-me/owner/recipient-only.md")).toBe(
      false,
    );
    expect(plan.mountArchivePrefix("owner")).toBe(
      "shared-with-me/owner",
    );
  });

  it("uses resolved workspace ownership under an aliased archive root", () => {
    const plan = ownedZipProjectionPlan({
      kind: "workspace-root",
      archiveRoot: "workspace-alias",
    });

    expect(plan.keepDiskEntry("workspace-alias/notes/local.md")).toBe(true);
    expect(
      plan.keepDiskEntry(
        "workspace-alias/shared-with-me/owner/recipient-only.md",
      ),
    ).toBe(false);
    expect(plan.mountArchivePrefix("owner")).toBe(
      "workspace-alias/shared-with-me/owner",
    );
  });

  it("replaces every raw entry when the selection aliases the projection root", () => {
    const plan = ownedZipProjectionPlan({
      kind: "projection-root",
      archiveRoot: "inbox",
    });

    expect(plan.keepDiskEntry("inbox/owner/recipient-only.md")).toBe(false);
    expect(plan.mountArchivePrefix("owner")).toBe("inbox/owner");
  });

  it("leaves a resolved local selection alone", () => {
    const plan = ownedZipProjectionPlan({ kind: "local" });

    expect(plan.includesMounts).toBe(false);
    expect(plan.keepDiskEntry("notes/local.md")).toBe(true);
    expect(plan.mountArchivePrefix("owner")).toBeNull();
  });
});
