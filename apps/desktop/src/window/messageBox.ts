import { dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";

/**
 * Shows a message box from main, over `window` while it is open. A box without
 * a title gets "dohc": otherwise Windows titles it with the app's name, which
 * is the package name "@dohc/desktop". `noLink` keeps every button a push
 * button: without it, Windows draws any label it doesn't know, such as
 * "Go back", as a command link.
 */
export function showMessageBox(options: MessageBoxOptions, window?: BrowserWindow | null): Promise<MessageBoxReturnValue> {
  const titled = { title: "dohc", noLink: true, ...options };
  return window && !window.isDestroyed() ? dialog.showMessageBox(window, titled) : dialog.showMessageBox(titled);
}
