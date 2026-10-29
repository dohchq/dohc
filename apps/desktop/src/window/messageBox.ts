import { dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";

/**
 * Shows a message box from main, over `window` while it is open. A box without
 * a title gets "dohc": otherwise Windows titles it with the app's name, which
 * is the package name "@dohc/desktop".
 */
export function showMessageBox(options: MessageBoxOptions, window?: BrowserWindow | null): Promise<MessageBoxReturnValue> {
  const titled = { title: "dohc", ...options };
  return window && !window.isDestroyed() ? dialog.showMessageBox(window, titled) : dialog.showMessageBox(titled);
}
