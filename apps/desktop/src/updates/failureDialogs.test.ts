import { describe, expect, it, vi } from "vitest";
import { confirmDownloadDialog, confirmRestartDialog } from "./failureDialogs";

describe("confirmRestartDialog", () => {
  it("promises an install on quit only where one runs", async () => {
    const detail = async (platform: NodeJS.Platform) => {
      const showMessageBox = vi.fn(async (..._args: unknown[]) => ({ response: 1, checkboxChecked: false }));
      await expect(confirmRestartDialog({ showMessageBox }, "startup", "1.2.4", platform)).resolves.toBe(false);
      return showMessageBox;
    };
    for (const platform of ["win32", "darwin"] as const) {
      expect(await detail(platform)).toHaveBeenCalledWith(expect.objectContaining({
        detail: "Restart now to open dohc on the new version. If you quit, the update installs as dohc closes.",
      }));
    }
    expect(await detail("linux")).toHaveBeenCalledWith(expect.objectContaining({
      detail: "Restart now to open dohc on the new version.",
    }));
  });
});

describe("confirmDownloadDialog", () => {
  it("asks before anything downloads, and only a failed startup offers Quit", async () => {
    const asked = async (failure: "startup" | "unfinished-launch" | "window-crash", response: number) => {
      const showMessageBox = vi.fn(async (..._args: unknown[]) => ({ response, checkboxChecked: false }));
      const accepted = await confirmDownloadDialog({ showMessageBox }, failure, "1.2.4");
      return { accepted, options: showMessageBox.mock.calls[0]![0] };
    };
    const startup = await asked("startup", 0);
    expect(startup.accepted).toBe(true);
    expect(startup.options).toMatchObject({
      message: "dohc could not start.",
      detail: "Update 1.2.4 is available. Download it?",
      buttons: ["Download", "Quit"],
      cancelId: 1,
    });
    for (const failure of ["unfinished-launch", "window-crash"] as const) {
      const other = await asked(failure, 1);
      expect(other.accepted).toBe(false);
      expect(other.options).toMatchObject({ buttons: ["Download", "Not now"] });
    }
  });
});
