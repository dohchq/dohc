import { execFile } from "node:child_process";

const WATCHER = "org.kde.StatusNotifierWatcher";

// Electron draws its Linux tray icon only for a StatusNotifierWatcher on the
// session bus that reports a registered host, as Chromium checks in
// status_icon_linux_dbus.cc. Stock GNOME runs no watcher, so the icon shows
// nowhere there. A failed check counts as no tray: a notice then comes when
// it isn't needed, never the other way round.
export async function linuxTrayShown(run: typeof execFile = execFile): Promise<boolean> {
  const answer = (destination: string, objectPath: string, method: string, ...args: string[]) =>
    new Promise<boolean>((resolve) => {
      run(
        "gdbus",
        ["call", "--session", "--dest", destination, "--object-path", objectPath, "--method", method, ...args],
        { timeout: 2000 },
        (error, stdout) => resolve(!error && /\btrue\b/.test(String(stdout))),
      );
    });
  // Asking the watcher before it exists could start one, so check its name first.
  return (
    (await answer("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", WATCHER)) &&
    (await answer(WATCHER, "/StatusNotifierWatcher", "org.freedesktop.DBus.Properties.Get", WATCHER, "IsStatusNotifierHostRegistered"))
  );
}
