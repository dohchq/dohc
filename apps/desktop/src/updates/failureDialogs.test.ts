import { describe, expect, it, vi } from "vitest";
import { confirmRestartDialog } from "./failureDialogs";

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
