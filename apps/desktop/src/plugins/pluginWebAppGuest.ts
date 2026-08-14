// The hardened guest surface for wrapper plugins' embedded web apps
// (2026-08-13 plugin-system design): a main-process-owned WebContentsView —
// never a renderer webview tag, never a plain iframe — with a
// per-workspace-per-plugin storage partition. The guest grants NO workspace
// authority: no preload, no Node, no IPC; it renders one loopback origin and
// nothing else. This module holds the decisions; main.ts owns the Electron
// objects and calls these against them.

import { createHash } from "node:crypto";
import { workspaceStateKey } from "./pluginLocalState";

export interface GuestBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One storage partition per workspace per plugin, both identities hashed:
 * cookies scope by host, not port, so two loopback-served plugins in one
 * partition could read each other's sessions — and a raw plugin id or
 * workspace path must never become a Partitions/ directory name.
 */
export function pluginWebAppPartition(
  workspaceRoot: string,
  pluginId: string,
): string {
  const key = createHash("sha256")
    .update(`${workspaceStateKey(workspaceRoot)}\0${pluginId}`)
    .digest("hex")
    .slice(0, 32);
  return `persist:dohc-plugin-${key}`;
}

/**
 * The exact loopback origin a plugin's web app URL must use. The bridge
 * contract binds wrapper servers to 127.0.0.1, so that literal host — not
 * localhost, not ::1 — is the whole allowed space.
 */
export function parsePluginWebAppUrl(value: string): { url: URL; origin: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The plugin web app URL is not a valid URL.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error(
      "The plugin web app URL must use http on the loopback host 127.0.0.1.",
    );
  }
  return { url, origin: url.origin };
}

/** Same-origin http only. Everything else — other ports, other hosts, other
 * schemes — is denied; the guest shows one spawned server and nothing else. */
export function allowGuestNavigation(origin: string, targetUrl: string): boolean {
  try {
    return new URL(targetUrl).origin === origin;
  } catch {
    return false;
  }
}

/** The webPreferences every guest view is created with. No plugin-supplied
 * preload exists on this surface by construction: nothing here accepts one. */
export function guestWebPreferences(partition: string): {
  partition: string;
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
  webviewTag: false;
} {
  return {
    partition,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webviewTag: false,
  };
}

export interface GuestNavigationEvent {
  preventDefault(): void;
}

export interface GuestWebContentsLike {
  on(
    event: "will-navigate",
    listener: (event: GuestNavigationEvent, url: string) => void,
  ): unknown;
  on(
    event: "will-redirect",
    listener: (event: GuestNavigationEvent, url: string) => void,
  ): unknown;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

export interface GuestSessionLike {
  on(
    event: "will-download",
    listener: (event: { preventDefault(): void }) => void,
  ): unknown;
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
}

/**
 * Locks a guest's navigation to the exact spawned origin and denies popups.
 * will-redirect is locked as well as will-navigate: a server redirect leaves
 * the origin just as effectively as a link click.
 */
export function hardenGuestWebContents(
  webContents: GuestWebContentsLike,
  origin: string,
): void {
  const lock = (event: GuestNavigationEvent, url: string): void => {
    if (!allowGuestNavigation(origin, url)) event.preventDefault();
  };
  webContents.on("will-navigate", lock);
  webContents.on("will-redirect", lock);
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/**
 * Denies downloads and permission requests for a guest partition's session.
 * Sessions are app-global per partition, so the caller applies this once per
 * partition, not once per view.
 */
export function hardenGuestSession(session: GuestSessionLike): void {
  session.on("will-download", (event) => event.preventDefault());
  session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false));
}
