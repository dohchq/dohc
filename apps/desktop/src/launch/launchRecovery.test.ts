import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => "1.0.0"),
    getPath: vi.fn(() => "C:\profile"),
    whenReady: vi.fn(async () => undefined),
    quit: vi.fn(),
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) },
}));
const updater = vi.hoisted(() => {
  const controller = {
    awaitUpdate: vi.fn(async (_bounds: unknown, _confirmDownload: (version: string) => Promise<boolean>): Promise<string | null> => "1.0.1"),
    installUpdate: vi.fn(async () => ({ accepted: true })),
    stop: vi.fn(),
  };
  return { controller, startAutoUpdates: vi.fn(async (): Promise<typeof controller | null> => controller) };
});

vi.mock("electron", () => electron);
vi.mock("../updates/electronUpdater", () => ({ startAutoUpdates: updater.startAutoUpdates, installsOnQuit: () => true }));

const { checkForUpdateBeforeMain } = await import("./launchRecovery");

beforeEach(() => {
  vi.clearAllMocks();
  electron.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
  updater.controller.awaitUpdate.mockResolvedValue("1.0.1");
  updater.startAutoUpdates.mockResolvedValue(updater.controller);
});

describe("update check before main loads", () => {
  it("restarts into an update the person accepts, waiting less for the feed than after a visible failure", async () => {
    await expect(checkForUpdateBeforeMain("unfinished-launch")).resolves.toBe(true);
    expect(updater.controller.awaitUpdate).toHaveBeenCalledWith(
      { verdictMs: 5_000, downloadMs: 300_000 }, expect.any(Function), expect.any(Function));
    expect(updater.controller.installUpdate).toHaveBeenCalledOnce();
    expect(updater.controller.stop).toHaveBeenCalledOnce();
    expect(electron.app.quit).not.toHaveBeenCalled();
  });

  it("quits when the person declines a downloaded update, so the install on quit does not race a relaunch", async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await expect(checkForUpdateBeforeMain("unfinished-launch")).resolves.toBe(true);
    expect(updater.controller.installUpdate).not.toHaveBeenCalled();
    expect(electron.app.quit).toHaveBeenCalledOnce();
  });

  it("asks before downloading, and leaves the exit to the entry when the person declines", async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    updater.controller.awaitUpdate.mockImplementation(async (_bounds: unknown, confirmDownload: (version: string) => Promise<boolean>) =>
      await confirmDownload("1.0.1") ? "1.0.1" : null);
    await expect(checkForUpdateBeforeMain("unfinished-launch")).resolves.toBe(false);
    expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ["Download", "Not now"] }));
    expect(electron.app.quit).not.toHaveBeenCalled();
  });

  it("leaves the exit to the entry when there is no update or no updater", async () => {
    updater.controller.awaitUpdate.mockResolvedValue(null);
    await expect(checkForUpdateBeforeMain("unfinished-launch")).resolves.toBe(false);
    updater.startAutoUpdates.mockResolvedValue(null);
    await expect(checkForUpdateBeforeMain("startup")).resolves.toBe(false);
    expect(electron.app.quit).not.toHaveBeenCalled();
  });

});
