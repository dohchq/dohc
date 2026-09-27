import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The real entry module, with a main module that throws while it loads.
const profile = vi.hoisted(() => ({ dir: "" }));
const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => profile.dir),
    getAppPath: vi.fn(() => profile.dir),
    getVersion: vi.fn(() => "1.0.0"),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  dialog: { showErrorBox: vi.fn() },
}));
const recovery = vi.hoisted(() => ({ checkForUpdateBeforeMain: vi.fn(async () => false) }));
const marker = vi.hoisted(() => ({ beginLaunch: vi.fn(() => ({ unfinished: 0, checked: false })) }));

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
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    profile.dir = mkdtempSync(join(tmpdir(), "dohc-entry-"));
    // Electron sets this; the crash report uses it to find dohc's own code.
    Object.defineProperty(process, "resourcesPath", { value: join(profile.dir, "resources"), configurable: true });
    try {
      await import("./entry");
      await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce());
      // Kept in the file main's crash report store reads, before the check ran.
      expect(logged.mock.calls.map((call) => String(call[0]))).not.toContain("[desktop] Could not keep a crash report:");
      const report = JSON.parse(readFileSync(join(profile.dir, "crash-report.json"), "utf8"));
      expect(report).toMatchObject({ version: 2, seq: 1, problems: [{ seq: 1, source: "main" }] });
      expect(report.problems[0].text).toContain("What happened: The main module failed to load");
      expect(electron.dialog.showErrorBox.mock.invocationCallOrder[0])
        .toBeLessThan(recovery.checkForUpdateBeforeMain.mock.invocationCallOrder[0]!);
    } finally {
      rmSync(profile.dir, { recursive: true, force: true });
    }
    // The lock comes before any marker read or write.
    expect(electron.app.requestSingleInstanceLock.mock.invocationCallOrder[0])
      .toBeLessThan(marker.beginLaunch.mock.invocationCallOrder[0]!);
    expect(marker.beginLaunch).toHaveBeenCalledWith(expect.stringContaining("dohc-launch.json"), "1.0.0", null);
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
