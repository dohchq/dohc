import type { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { linuxTrayShown } from "./linuxTrayShown";

function runner(error: Error | null, stdout: string) {
  return vi.fn((_file: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string) => void) => {
    callback(error, stdout);
  }) as unknown as typeof execFile & ReturnType<typeof vi.fn>;
}

describe("linuxTrayShown", () => {
  it("asks the session bus whether a StatusNotifierWatcher runs", async () => {
    const run = runner(null, "(true,)\n");
    await expect(linuxTrayShown(run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(
      "gdbus",
      [
        "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus.NameHasOwner", "org.kde.StatusNotifierWatcher",
      ],
      { timeout: 2000 },
      expect.any(Function),
    );
  });

  it("counts no watcher, and a failed check, as no tray", async () => {
    await expect(linuxTrayShown(runner(null, "(false,)\n"))).resolves.toBe(false);
    await expect(linuxTrayShown(runner(new Error("spawn gdbus ENOENT"), ""))).resolves.toBe(false);
  });
});
