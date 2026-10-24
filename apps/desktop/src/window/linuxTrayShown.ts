import { execFile } from "node:child_process";

// Electron draws its Linux tray icon for a StatusNotifierWatcher on the
// session bus. Stock GNOME runs none, so the icon shows nowhere there. A
// failed check counts as no tray: a notice then comes when it isn't needed,
// never the other way round.
export function linuxTrayShown(run: typeof execFile = execFile): Promise<boolean> {
  return new Promise((resolve) => {
    run(
      "gdbus",
      [
        "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus.NameHasOwner", "org.kde.StatusNotifierWatcher",
      ],
      { timeout: 2000 },
      (error, stdout) => resolve(!error && String(stdout).trim() === "(true,)"),
    );
  });
}
