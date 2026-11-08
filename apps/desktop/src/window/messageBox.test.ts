import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const electron = vi.hoisted(() => ({
  dialog: { showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 0, checkboxChecked: false })) },
}));
vi.mock("electron", () => electron);

const { showMessageBox } = await import("./messageBox");

const window = (destroyed: boolean) => ({ isDestroyed: () => destroyed }) as BrowserWindow;

beforeEach(() => vi.clearAllMocks());

describe("showMessageBox", () => {
  it("titles a box that has no title dohc", async () => {
    await showMessageBox({ message: "Do you trust the authors of the files in this workspace?" });
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith({
      title: "dohc",
      message: "Do you trust the authors of the files in this workspace?",
    });
  });

  it("keeps a box's own title", async () => {
    await showMessageBox({ title: "Forget this workspace?", message: "This workspace has typing waiting to recover." });
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ title: "Forget this workspace?" }));
  });

  it("opens over the window while it is open, and on its own once it closes", async () => {
    const open = window(false);
    await showMessageBox({ message: "dohc isn't responding." }, open);
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(open, { title: "dohc", message: "dohc isn't responding." });
    await showMessageBox({ message: "dohc isn't responding." }, window(true));
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith({ title: "dohc", message: "dohc isn't responding." });
  });
});
