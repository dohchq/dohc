import { describe, expect, it, vi } from "vitest";
import { compareAppVersions, offerMoveToApplications } from "./moveToApplications";

function harness(overrides: {
  inApplications?: boolean;
  declined?: boolean;
  installedVersion?: string | null;
  response?: number;
  bundlePath?: string;
} = {}) {
  return {
    bundlePath: overrides.bundlePath ?? "/Volumes/dohc 0.2.0/dohc.app",
    runningVersion: "0.2.0",
    isInApplicationsFolder: () => overrides.inApplications ?? false,
    declined: () => overrides.declined ?? false,
    recordDecline: vi.fn(),
    installedVersion: () => overrides.installedVersion ?? null,
    showMessageBox: vi.fn(async () => ({ response: overrides.response ?? 0 })),
    move: vi.fn(async (): Promise<void> => undefined),
    reportMoveFailure: vi.fn(),
  };
}

describe("compareAppVersions", () => {
  it("orders releases and nightly prereleases as semver does", () => {
    expect(compareAppVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareAppVersions("0.1.1", "0.1.1-nightly.20261017.3.1")).toBeGreaterThan(0);
    expect(compareAppVersions("0.1.1-nightly.20261017.3.1", "0.1.1-nightly.20261017.12.1")).toBeLessThan(0);
    expect(compareAppVersions("0.1.1-nightly.20261018.1.1", "0.1.1-nightly.20261017.12.1")).toBeGreaterThan(0);
    expect(compareAppVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareAppVersions("1.0.0", "")).toBeNull();
  });
});

describe("offerMoveToApplications", () => {
  it("asks nothing in Applications, after a decline, or over the same, a newer, or an unreadable dohc there", async () => {
    for (const deps of [
      harness({ inApplications: true }), harness({ declined: true }),
      harness({ installedVersion: "0.2.0" }), harness({ installedVersion: "0.3.0" }), harness({ installedVersion: "" }),
    ]) {
      await offerMoveToApplications(deps);
      expect(deps.showMessageBox).not.toHaveBeenCalled();
      expect(deps.move).not.toHaveBeenCalled();
    }
  });

  it("asks once from a disk image, naming the older copy it replaces, and moves when the person agrees", async () => {
    const deps = harness({ installedVersion: "0.1.0" });
    await offerMoveToApplications(deps);
    expect(deps.showMessageBox).toHaveBeenCalledWith({
      type: "question",
      message: "Move dohc to Applications?",
      detail: "dohc is running from a disk image or a temporary copy. dohc moves itself to Applications and opens again. "
        + "It replaces the older dohc 0.1.0 already there.",
      buttons: ["Move to Applications", "Don't move"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    expect(deps.move).toHaveBeenCalledTimes(1);
    expect(deps.recordDecline).not.toHaveBeenCalled();
  });

  it("remembers Don't move, and does not call a lasting folder temporary", async () => {
    const deps = harness({ response: 1, bundlePath: "/Users/sam/Tools/dohc.app" });
    await offerMoveToApplications(deps);
    expect(deps.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      detail: "dohc moves itself to Applications and opens again.",
    }));
    expect(deps.recordDecline).toHaveBeenCalledTimes(1);
    expect(deps.move).not.toHaveBeenCalled();
  });

  it("reports a move that fails", async () => {
    const deps = harness();
    const failure = new Error("Failed to copy dohc.app");
    deps.move.mockRejectedValueOnce(failure);
    await offerMoveToApplications(deps);
    expect(deps.reportMoveFailure).toHaveBeenCalledWith(failure);
  });
});
