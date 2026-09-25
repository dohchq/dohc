import { describe, expect, it, vi } from "vitest";

// The real entry module, with a main module that throws while it loads.
const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => "/profile"),
    getVersion: vi.fn(() => "1.0.0"),
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  dialog: { showErrorBox: vi.fn() },
}));
const recovery = vi.hoisted(() => ({ checkForUpdateBeforeMain: vi.fn(async () => false) }));
const marker = vi.hoisted(() => ({ beginLaunch: vi.fn(() => 0) }));

vi.mock("electron", () => electron);
vi.mock("./main", () => {
  throw new Error("main failed to load");
});
vi.mock("./launch/launchRecovery", () => recovery);
vi.mock("./launch/launchMarker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launch/launchMarker")>()),
  beginLaunch: marker.beginLaunch,
}));

describe("electron main entry", () => {
  it("reports a main module that fails to load, checks for a newer build, then quits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await import("./entry");
    expect(marker.beginLaunch).toHaveBeenCalledWith(expect.stringContaining("dohc-launch.json"), "1.0.0");
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      "dohc failed to start",
      // vitest wraps the factory's throw in its own mocking error.
      expect.stringContaining("Restart dohc."),
    );
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce());
    expect(recovery.checkForUpdateBeforeMain).toHaveBeenCalledWith("startup");
    expect(electron.app.relaunch).not.toHaveBeenCalled();
  });
});
