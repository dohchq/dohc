import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => "1.0.0"),
    whenReady: vi.fn(async () => undefined),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) },
}));
const updater = vi.hoisted(() => {
  const controller = {
    awaitUpdate: vi.fn(async (): Promise<string | null> => "1.0.1"),
    installUpdate: vi.fn(async () => ({ accepted: true })),
    stop: vi.fn(),
  };
  return { controller, startAutoUpdates: vi.fn(async (): Promise<typeof controller | null> => controller) };
});
const marker = vi.hoisted(() => ({ abandonLaunch: vi.fn() }));

vi.mock("electron", () => electron);
vi.mock("../updates/electronUpdater", () => ({ startAutoUpdates: updater.startAutoUpdates }));
vi.mock("./launchMarker", () => marker);

const { checkForUpdateBeforeMain } = await import("./launchRecovery");

beforeEach(() => {
  vi.clearAllMocks();
  electron.app.requestSingleInstanceLock.mockReturnValue(true);
  electron.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
  updater.controller.awaitUpdate.mockResolvedValue("1.0.1");
  updater.startAutoUpdates.mockResolvedValue(updater.controller);
});

describe("update check before main loads", () => {
  it("restarts into an update the person accepts, waiting less for the feed than after a visible failure", async () => {
    await expect(checkForUpdateBeforeMain("unfinished-launch")).resolves.toBe(true);
    expect(updater.controller.awaitUpdate).toHaveBeenCalledWith(
      { verdictMs: 5_000, downloadMs: 300_000 }, expect.any(Function));
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

  it("leaves the exit to the entry when there is no update or no updater", async () => {
    updater.controller.awaitUpdate.mockResolvedValue(null);
    await expect(checkForUpdateBeforeMain("unfinished-launch")).resolves.toBe(false);
    updater.startAutoUpdates.mockResolvedValue(null);
    await expect(checkForUpdateBeforeMain("startup")).resolves.toBe(false);
    expect(electron.app.quit).not.toHaveBeenCalled();
  });

  it.each(["unfinished-launch", "startup"] as const)("hands a %s check to the process that already checks, so only one installs", async (failure) => {
    electron.app.requestSingleInstanceLock.mockReturnValue(false);
    await expect(checkForUpdateBeforeMain(failure)).resolves.toBe(true);
    expect(marker.abandonLaunch).toHaveBeenCalledOnce();
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(updater.startAutoUpdates).not.toHaveBeenCalled();
  });
});
