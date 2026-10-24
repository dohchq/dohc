import type { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { linuxTrayShown } from "./linuxTrayShown";

// Answers each gdbus call in turn: stdout, or an error.
function runner(...answers: Array<string | Error>) {
  return vi.fn((_file: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string) => void) => {
    const answer = answers.shift() ?? new Error("unexpected call");
    if (answer instanceof Error) callback(answer, "");
    else callback(null, answer);
  }) as unknown as typeof execFile & ReturnType<typeof vi.fn>;
}

describe("linuxTrayShown", () => {
  it("needs a StatusNotifierWatcher on the session bus that reports a registered host", async () => {
    const run = runner("(true,)\n", "(<true>,)\n");
    await expect(linuxTrayShown(run)).resolves.toBe(true);
    expect(run.mock.calls.map(([file, args, options]) => [file, args, options])).toEqual([
      ["gdbus", [
        "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus.NameHasOwner", "org.kde.StatusNotifierWatcher",
      ], { timeout: 2000 }],
      ["gdbus", [
        "call", "--session", "--dest", "org.kde.StatusNotifierWatcher", "--object-path", "/StatusNotifierWatcher",
        "--method", "org.freedesktop.DBus.Properties.Get", "org.kde.StatusNotifierWatcher", "IsStatusNotifierHostRegistered",
      ], { timeout: 2000 }],
    ]);
  });

  it("does not ask a watcher that isn't there", async () => {
    const run = runner("(false,)\n");
    await expect(linuxTrayShown(run)).resolves.toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("counts a watcher without a host, and a failed check, as no tray", async () => {
    await expect(linuxTrayShown(runner("(true,)\n", "(<false>,)\n"))).resolves.toBe(false);
    await expect(linuxTrayShown(runner("(true,)\n", new Error("no such property")))).resolves.toBe(false);
    await expect(linuxTrayShown(runner(new Error("spawn gdbus ENOENT")))).resolves.toBe(false);
  });
});
