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

export interface GuestWebPreferences {
  partition: string;
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
  webviewTag: false;
}

/** The webPreferences every guest view is created with. No plugin-supplied
 * preload exists on this surface by construction: nothing here accepts one. */
export function guestWebPreferences(partition: string): GuestWebPreferences {
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

export interface GuestViewLike {
  webContents: GuestWebContentsLike & {
    session: GuestSessionLike;
    loadURL(url: string): Promise<unknown>;
  };
  setVisible(visible: boolean): void;
}

export interface PluginWebAppGuest<V extends GuestViewLike> {
  view: V;
  /** The credential-free origin. This — never the start URL — is what the
   * renderer and the view registry are told about. */
  origin: string;
  partition: string;
}

/**
 * Builds the guest for one plugin web app: the partition both this view and
 * uninstall derive from the same two identities, the webPreferences with no
 * preload in them, the origin lock, the once-per-partition session hardening,
 * and the navigation that carries the credential.
 *
 * main.ts owns the Electron objects and passes them in; every decision above
 * lives here, where a test can watch it.
 */
export function createPluginWebAppGuest<V extends GuestViewLike>(input: {
  workspaceRoot: string;
  pluginId: string;
  /** The start URL. Its fragment can be a one-time credential, so it reaches
   * loadURL and nothing else — not the registry, not the renderer, not a log. */
  url: string;
  /** Partitions whose session is already hardened, app-wide. */
  hardenedPartitions: Set<string>;
  ViewClass: new (options: { webPreferences: GuestWebPreferences }) => V;
  attach: (view: V, guest: { origin: string; partition: string }) => void;
  /** Runs when the navigation never lands. The credential is spent by then
   * and no session cookie replaced it, so the caller stops the web app and
   * lets the next open pair again. */
  onLoadFailure: (error: unknown) => void;
}): PluginWebAppGuest<V> {
  const { origin } = parsePluginWebAppUrl(input.url);
  const partition = pluginWebAppPartition(input.workspaceRoot, input.pluginId);
  const view = new input.ViewClass({
    webPreferences: guestWebPreferences(partition),
  });
  // Sessions are app-global per partition; hardening one twice is harmless
  // but hardening none is not, so the set records what has been done.
  if (!input.hardenedPartitions.has(partition)) {
    hardenGuestSession(view.webContents.session);
    input.hardenedPartitions.add(partition);
  }
  hardenGuestWebContents(view.webContents, origin);
  // Invisible until the renderer reports its placeholder's bounds.
  view.setVisible(false);
  input.attach(view, { origin, partition });
  void view.webContents.loadURL(input.url).catch(input.onLoadFailure);
  return { view, origin, partition };
}

export interface GuestPartitionSessionLike {
  clearStorageData(): Promise<void>;
}

/**
 * Clears one plugin web app's guest partition after uninstall. The partition
 * is derived here from the same two identities the guest used, so the clear
 * cannot target a partition no guest ever wrote to.
 */
export async function clearPluginWebAppPartition(input: {
  workspaceRoot: string;
  pluginId: string;
  hardenedPartitions: Set<string>;
  fromPartition: (partition: string) => GuestPartitionSessionLike;
  onError: (error: unknown) => void;
}): Promise<void> {
  const partition = pluginWebAppPartition(input.workspaceRoot, input.pluginId);
  input.hardenedPartitions.delete(partition);
  await input.fromPartition(partition).clearStorageData().catch(input.onError);
}
