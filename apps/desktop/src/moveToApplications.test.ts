import { describe, expect, it, vi } from "vitest";
import { offerMoveToApplications } from "./moveToApplications";

function harness(overrides: { inApplications?: boolean; declined?: boolean; replacesCopy?: boolean; response?: number; bundlePath?: string } = {}) {
  const deps = {
    bundlePath: overrides.bundlePath ?? "/Volumes/dohc 1.2.3/dohc.app",
    isInApplicationsFolder: () => overrides.inApplications ?? false,
    declined: () => overrides.declined ?? false,
    recordDecline: vi.fn(),
    replacesCopy: () => overrides.replacesCopy ?? false,
    showMessageBox: vi.fn(async () => ({ response: overrides.response ?? 0 })),
    move: vi.fn(),
    reportMoveFailure: vi.fn(async () => undefined),
  };
  return deps;
}

describe("offerMoveToApplications", () => {
  it("asks nothing in Applications, or after a decline", async () => {
    for (const deps of [harness({ inApplications: true }), harness({ declined: true })]) {
      await offerMoveToApplications(deps);
      expect(deps.showMessageBox).not.toHaveBeenCalled();
      expect(deps.move).not.toHaveBeenCalled();
    }
  });

  it("asks once from a disk image, naming what it replaces, and moves when the person agrees", async () => {
    const deps = harness({ replacesCopy: true });
    await offerMoveToApplications(deps);
    expect(deps.showMessageBox).toHaveBeenCalledWith({
      type: "question",
      message: "Move dohc to Applications?",
      detail: "dohc is running from a disk image or a temporary copy. dohc moves itself to Applications and opens again. "
        + "It replaces the copy of dohc already there.",
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
    deps.move.mockImplementation(() => { throw failure; });
    await offerMoveToApplications(deps);
    expect(deps.reportMoveFailure).toHaveBeenCalledWith(failure);
  });
});
