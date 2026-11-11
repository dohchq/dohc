import type { App } from "electron";

export const APP_NAME = "dohc";

// Electron names the secret that protects a saved sign-in after the app: the
// macOS keychain item "dohc Safe Storage", and the Linux keyring entry. It
// also names the settings folder after the app, and that folder, still named
// for the package (@dohc/desktop), keeps every workspace and setting. So the
// name changes and the folder stays. Call this before anything reads a path.
export function nameApp(app: Pick<App, "name" | "getPath" | "setPath">): void {
  const settingsFolder = app.getPath("userData");
  app.name = APP_NAME;
  app.setPath("userData", settingsFolder);
}
