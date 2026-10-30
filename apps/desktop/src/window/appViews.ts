import { createHash } from "node:crypto";
import { app, BrowserWindow, session, type Input, type IpcMainInvokeEvent, type WebContents, type WebPreferences } from "electron";
import { isShareablePath } from "@dohc/security-contract/share-selector";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { AppViewRequest, type AppViewResult, type AppViewEvent } from "../ipc/bridgeContract";
import { CHANNELS } from "../ipc/channels";
import { matchesShortcut } from "../shortcuts/shortcutRegistry";
import { palette } from "../renderer/tokens";
import type { LocalAppLaunchSession } from "../workspaces/localAppLaunch";

type ColorScheme = "light" | "dark";
// One partition per app: every launch is on 127.0.0.1, so apps sharing one would share its cache and cookies.
export function appViewPartition(workspaceId: string, appRoot: string): string {
  return `dohc-app:${createHash("sha256").update(JSON.stringify([workspaceId, appRoot])).digest("hex").slice(0, 32)}`;
}

export function appViewExternalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || /^127(\.\d+){3}$/.test(host) ||
      host === "[::1]" || host === "[::]" || host.startsWith("[::ffff:7f")) return null;
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

// Like Chromium's popup blocker: a link leaves dohc only within 5 s of a real press in the app, once per press.
const EXTERNAL_LINK_ACTIVATION_MS = 5_000;
const ACTIVATING_INPUT = new Set(["mouseDown", "keyDown", "touchEnd", "gestureTap"]);
const NOT_A_PRESS = new Set(["Escape", "Control", "Shift", "Alt", "Meta", "AltGraph"]);

export function appViewLaunchUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" &&
      !url.username && !url.password && url.pathname === "/bootstrap" && !url.search &&
      /^#[A-Za-z0-9_-]{43}$/.test(url.hash) ? url.toString() : null;
  } catch { return null; }
}

export function appViewNavigationAllowed(raw: string, mainFrame: boolean, origin: string): boolean {
  if (!mainFrame) return raw === "about:srcdoc" || raw === "about:blank";
  try {
    const url = new URL(raw);
    return url.origin === origin && !url.username && !url.password && url.pathname === "/bootstrap" && !url.search;
  } catch { return false; }
}

type Shortcut = Extract<AppViewEvent, { kind: "shortcut" }>;
export function appViewShortcut(input: Pick<Input, "type" | "key" | "code" | "control" | "shift" | "alt" | "meta" | "isComposing">,
  platform: string = process.platform): Omit<Shortcut, "viewId" | "kind"> | null {
  if (input.type !== "keyDown" || input.isComposing) return null;
  if (["BrowserBack", "BrowserForward"].includes(input.key)) return {
    key: input.key === "BrowserBack" ? "ArrowLeft" : "ArrowRight", code: input.key === "BrowserBack" ? "ArrowLeft" : "ArrowRight",
    ctrlKey: false, shiftKey: false, altKey: true, metaKey: false,
  };
  const key = { key: input.key, code: input.code, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt, metaKey: input.meta };
  const shell = (["quick-open", "command-palette", "close-tab", "toggle-sidebar"] as const)
    .some(id => matchesShortcut(key, id, platform));
  const controlTab = input.key === "Tab" && input.control && !input.meta && !input.alt;
  const bare = !input.control && !input.meta && !input.alt && !input.shift;
  const reload = input.key.toLowerCase() === "r" && !input.alt && !input.shift &&
    (platform === "darwin" ? input.meta && !input.control : input.control && !input.meta);
  const history = ["ArrowLeft", "ArrowRight"].includes(input.key) && input.alt && !input.control && !input.meta && !input.shift;
  return shell || controlTab || (bare && ["F5", "F6"].includes(input.key)) || reload || history ? key : null;
}

interface AppViewOperation<Workspace> {
  workspace: Workspace;
  signal: AbortSignal;
  assertCurrent(): void;
}
interface Entry {
  owner: WebContents;
  workspaceId: string;
  appRoot: string;
  viewId: string;
  publicationId: string;
  partition: string;
  colorScheme: ColorScheme;
  launch?: LocalAppLaunchSession;
  guest?: WebContents;
  lastPress?: number;
  attached: boolean;
  closed: boolean;
  closing?: Promise<void>;
  themeUpdate?: Promise<void>;
  removeLifetime(): void;
}
const issuedByOwner = new Map<number, Map<string, Entry>>();
// The entry will-attach-webview admitted. Electron creates its guest in the same tick, before anything else runs.
let admitted: Entry | undefined;
const installedOwners = new WeakSet<WebContents>();

export function appViewGuestPreferences(partition: string, packaged: boolean): WebPreferences & { transparent: true; disablePopups: false } {
  return {
    partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    webviewTag: false, devTools: !packaged, spellcheck: false, webSecurity: true, allowRunningInsecureContent: false,
    navigateOnDragDrop: false, transparent: true, disablePopups: false,
  };
}

// This gate is present before the workspace renderer can create any guest.
export function installAppViewEmbedder(owner: WebContents): void {
  if (installedOwners.has(owner)) return;
  installedOwners.add(owner);
  owner.on("will-attach-webview", (event, preferences, params) => {
    admitted = undefined;
    const entry = [...(issuedByOwner.get(owner.id)?.values() ?? [])].find(candidate =>
      !candidate.closed && !candidate.attached && candidate.launch?.url === params.src && candidate.launch.isAlive());
    if (!entry) { event.preventDefault(); return; }
    // Replace the entire renderer-supplied preference set, including preload and preloadURL.
    for (const key of Object.keys(preferences)) Reflect.deleteProperty(preferences, key);
    Object.assign(preferences, appViewGuestPreferences(entry.partition, app.isPackaged));
    for (const key of ["preload", "preloadURL", "webpreferences", "httpreferrer", "useragent"]) Reflect.deleteProperty(params, key);
    params.partition = entry.partition;
    entry.attached = true;
    admitted = entry;
    // Electron creates the guest before this task ends. An admission it didn't use doesn't outlast the task.
    queueMicrotask(() => { if (admitted === entry) admitted = undefined; });
  });
}

export function registerAppViews<Workspace extends { workspaceId: string }>(dependencies: {
  registerHandler(channel: string, handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown): void;
  assertTrustedSender(event: IpcMainInvokeEvent): void;
  withWorkspaceOperation<Result>(sender: WebContents, workspaceId: string,
    work: (operation: AppViewOperation<Workspace>) => Promise<Result>): Promise<Result>;
  activePublication(operation: AppViewOperation<Workspace>, appRoot: string): Promise<string | null>;
  launch(operation: AppViewOperation<Workspace>, publicationId: string): Promise<LocalAppLaunchSession>;
}) {
  const partitions = new Map<string, Map<number, Entry>>();
  const pendingByView = new Map<string, Promise<AppViewResult>>();
  const emit = (entry: Entry, event: AppViewEvent) => {
    if (!entry.closed && !entry.owner.isDestroyed()) entry.owner.send(CHANNELS.appViewEvent, event);
  };
  const external = (entry: Entry, raw: string) => {
    const pressed = entry.lastPress !== undefined && Date.now() - entry.lastPress <= EXTERNAL_LINK_ACTIVATION_MS;
    entry.lastPress = undefined;
    const url = appViewExternalUrl(raw);
    if (url && pressed) emit(entry, { kind: "external-link", viewId: entry.viewId, url });
  };
  const close = (entry: Entry): Promise<void> => {
    if (entry.closing) return entry.closing;
    entry.closed = true;
    if (issuedByOwner.get(entry.owner.id)?.get(entry.viewId) === entry) issuedByOwner.get(entry.owner.id)?.delete(entry.viewId);
    if (admitted === entry) admitted = undefined;
    if (entry.guest) partitions.get(entry.partition)?.delete(entry.guest.id);
    entry.removeLifetime();
    entry.closing = Promise.resolve().then(async () => {
      if (entry.guest && !entry.guest.isDestroyed()) entry.guest.close({ waitForBeforeUnload: false });
      await entry.launch?.stop();
    });
    return entry.closing;
  };
  const closeOwner = async (ownerId: number) => {
    await Promise.all([...(issuedByOwner.get(ownerId)?.values() ?? [])].map(close));
  };
  const ownerEntries = (owner: WebContents) => {
    let entries = issuedByOwner.get(owner.id);
    if (!entries) {
      entries = new Map(); issuedByOwner.set(owner.id, entries);
      const ownerViews = entries;
      const retire = () => { void closeOwner(owner.id); };
      owner.on("did-start-navigation", event => { if (event.isMainFrame && !event.isSameDocument) retire(); });
      owner.once("destroyed", () => { retire(); issuedByOwner.delete(owner.id); });
      const window = BrowserWindow.fromWebContents(owner);
      window?.once("closed", retire);
      window?.on("app-command", (event, command) => {
        if (command !== "browser-backward" && command !== "browser-forward") return;
        const entry = [...ownerViews.values()].find(candidate => !candidate.closed && candidate.guest?.isFocused());
        if (!entry) return;
        event.preventDefault();
        const key = command === "browser-backward" ? "ArrowLeft" : "ArrowRight";
        emit(entry, { kind: "shortcut", viewId: entry.viewId, key, code: key,
          ctrlKey: false, shiftKey: false, altKey: true, metaKey: false });
      });
    }
    return entries;
  };
  const partitionEntries = (name: string) => {
    let entries = partitions.get(name);
    if (!entries) {
      entries = new Map(); partitions.set(name, entries);
      const partitionViews = entries;
      const isolated = session.fromPartition(name);
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.setDevicePermissionHandler(() => false);
      isolated.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      isolated.on("will-download", (_event, item, contents) => {
        const filename = item.getFilename(); item.cancel();
        const entry = contents && partitionViews.get(contents.id);
        if (entry) emit(entry, { kind: "download-blocked", viewId: entry.viewId, filename });
      });
      isolated.webRequest.onBeforeRequest((details, callback) => {
        if (details.resourceType !== "mainFrame") { callback({}); return; }
        const entry = details.webContentsId === undefined ? undefined : partitionViews.get(details.webContentsId);
        const allowed = !!entry && !entry.closed && !!entry.launch?.isAlive() &&
          appViewNavigationAllowed(details.url, true, new URL(entry.launch.url).origin);
        callback({ cancel: !allowed });
      });
    }
    return entries;
  };
  const theme = (entry: Entry): Promise<void> => {
    const guest = entry.guest;
    if (!guest || guest.isDestroyed()) return Promise.resolve();
    const update = async () => {
      if (entry.closed || guest.isDestroyed()) return;
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
      await guest.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: entry.colorScheme }],
      });
      const hex = palette[entry.colorScheme].bg;
      await guest.debugger.sendCommand("Emulation.setDefaultBackgroundColorOverride", { color: {
        r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a: 1,
      } });
    };
    entry.themeUpdate = (entry.themeUpdate ?? Promise.resolve()).catch(() => {}).then(update);
    return entry.themeUpdate;
  };
  // Electron creates the guest before loading src, but emits did-attach-webview after loadURL. createGuest emits
  // will-attach-webview and then creates the guest, which emits this, with nothing in between.
  app.on("web-contents-created", (_event, guest) => {
    if (guest.getType() !== "webview") return;
    const entry = admitted;
    admitted = undefined;
    if (!entry || entry.closed || guest.hostWebContents !== entry.owner || guest.session !== session.fromPartition(entry.partition)) {
      guest.close({ waitForBeforeUnload: false }); return;
    }
    entry.guest = guest;
    partitionEntries(entry.partition).set(guest.id, entry);
    const navigate = (details: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
      if (entry.launch?.isAlive() && appViewNavigationAllowed(details.url, details.isMainFrame, new URL(entry.launch.url).origin)) return;
      details.preventDefault(); external(entry, details.url);
    };
    guest.on("will-navigate", navigate);
    guest.on("will-redirect", navigate);
    guest.on("will-frame-navigate", navigate);
    guest.setWindowOpenHandler(({ url }) => { external(entry, url); return { action: "deny" }; });
    // The before- events cover the app's child frames. input-event sees only the guest's main frame, so it adds only taps.
    const press = (input: { type: string }) => { if (ACTIVATING_INPUT.has(input.type)) entry.lastPress = Date.now(); };
    guest.on("before-mouse-event", (_event, mouse) => press(mouse));
    guest.on("input-event", (_event, input) => { if (input.type === "touchEnd" || input.type === "gestureTap") press(input); });
    guest.on("before-input-event", (event, input) => {
      const shortcut = appViewShortcut(input);
      if (shortcut) { event.preventDefault(); emit(entry, { kind: "shortcut", viewId: entry.viewId, ...shortcut }); }
      // dohc's shortcuts, a modifier key alone and Escape aren't a press in the app.
      else if (!NOT_A_PRESS.has(input.key)) press(input);
    });
    // A press doesn't carry over into a page dohc reloads. A navigation the page starts has an initiator.
    guest.on("did-start-navigation", event => {
      if (event.isMainFrame && !event.isSameDocument && !event.initiator) entry.lastPress = undefined;
    });
    guest.once("destroyed", () => { void close(entry); });
    void theme(entry).catch(() => {
      emit(entry, { kind: "session-ended", viewId: entry.viewId }); void close(entry);
    });
  });
  dependencies.registerHandler(CHANNELS.appView, async (event, raw): Promise<AppViewResult> => {
    dependencies.assertTrustedSender(event);
    const input = AppViewRequest.parse(raw);
    return dependencies.withWorkspaceOperation(event.sender, input.workspaceId, async operation => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.webContents !== event.sender) throw Error("Open this app from its workspace window.");
      const entries = ownerEntries(event.sender);
      if (input.action === "colorScheme") {
        await Promise.all([...entries.values()].filter(entry => entry.workspaceId === input.workspaceId).map(entry => {
          entry.colorScheme = input.colorScheme; return theme(entry);
        }));
        operation.assertCurrent(); return { kind: "colorScheme" };
      }
      const execute = async (): Promise<AppViewResult> => {
        operation.assertCurrent();
        const previous = entries.get(input.viewId);
        if (previous && previous.workspaceId !== input.workspaceId) throw Error("This app belongs to another workspace.");
        if (previous) await close(previous);
        if (input.action === "close") return { kind: "closed", viewId: input.viewId };
        if (!isShareablePath(input.appRoot) || isSharedWithMePath(input.appRoot)) throw Error("Choose an app in your workspace.");
        if (entries.size >= 8) throw Error("Close another app before opening this one.");
        const entry: Entry = { owner: event.sender, workspaceId: input.workspaceId, appRoot: input.appRoot,
          viewId: input.viewId, publicationId: "", partition: appViewPartition(input.workspaceId, input.appRoot),
          colorScheme: input.colorScheme, attached: false, closed: false, removeLifetime() {} };
        entries.set(input.viewId, entry);
        const retire = () => { void close(entry); };
        operation.signal.addEventListener("abort", retire, { once: true });
        entry.removeLifetime = () => operation.signal.removeEventListener("abort", retire);
        try {
          const publicationId = await dependencies.activePublication(operation, input.appRoot);
          operation.assertCurrent();
          if (entry.closed) throw Error("This app tab closed. Open the app again.");
          if (!publicationId) { await close(entry); return { kind: "unapproved", viewId: input.viewId }; }
          partitionEntries(entry.partition);
          const launch = await dependencies.launch(operation, publicationId);
          entry.launch = launch;
          if (entry.closed) { await launch.stop(); throw Error("This app tab closed. Open the app again."); }
          operation.assertCurrent();
          const url = appViewLaunchUrl(launch.url);
          if (!url) throw Error("The app address is not on this device. Open the app again.");
          entry.publicationId = publicationId;
          // An ended approval removes the page. Any other ending keeps it on screen until the tab reloads or closes.
          const ended = () => {
            const approval = launch.ended.reason === "needs-approval";
            emit(entry, { kind: approval ? "approval-ended" : "session-ended", viewId: entry.viewId });
            if (approval) void close(entry);
          };
          launch.ended.addEventListener("abort", ended, { once: true });
          if (!launch.isAlive()) { ended(); throw Error("This app's approval changed. Review the app again."); }
          return { kind: "opened", viewId: input.viewId, publicationId, url, partition: entry.partition };
        } catch (error) {
          await close(entry);
          if (error instanceof Error && error.message === "Close another app before opening this one.") throw error;
          throw Error("dohc could not open this app. Review its approval and try again.", { cause: error });
        }
      };
      const key = `${event.sender.id}:${input.viewId}`;
      const pending = (pendingByView.get(key) ?? Promise.resolve()).catch(() => {}).then(execute);
      pendingByView.set(key, pending);
      try { return await pending; } finally { if (pendingByView.get(key) === pending) pendingByView.delete(key); }
    });
  });
  return {
    closeOwner,
    async closeWorkspace(workspaceId: string) {
      await Promise.all([...issuedByOwner.values()].flatMap(entries => [...entries.values()])
        .filter(entry => entry.workspaceId === workspaceId).map(close));
    },
  };
}
