import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: Object.assign(new EventEmitter(), { isPackaged: false }),
    BrowserWindow: { fromWebContents: vi.fn() }, session: { fromPartition: vi.fn() } };
});
import { app, BrowserWindow, session, type IpcMainInvokeEvent, type WebContents } from "electron";
import { AppViewRequest } from "../ipc/bridgeContract";
import { CHANNELS } from "../ipc/channels";
import { installAppViewEmbedder, registerAppViews } from "./appViews";

let nextId = 1000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  app.removeAllListeners(); vi.clearAllMocks();
});
function fixture() {
  const isolated = Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } });
  vi.mocked(session.fromPartition).mockReturnValue(isolated as unknown as Electron.Session);
  const owner = Object.assign(new EventEmitter(), { id: nextId++, isDestroyed: () => false, send: vi.fn() });
  const window = Object.assign(new EventEmitter(), { webContents: owner });
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(window as unknown as Electron.BrowserWindow);
  const lifetime = new AbortController();
  const operation = { workspace: { workspaceId: "w" }, signal: lifetime.signal, assertCurrent: () => lifetime.signal.throwIfAborted() };
  const launches: Array<{ url: string; ended: AbortSignal; stop: ReturnType<typeof vi.fn>; isAlive(): boolean; end(reason: string): void }> = [];
  const activePublication = vi.fn(async () => "approved" as string | null);
  let handler!: (event: IpcMainInvokeEvent, payload: unknown) => unknown;
  const manager = registerAppViews({ registerHandler: (_channel, callback) => { handler = callback; },
    assertTrustedSender: () => {},
    withWorkspaceOperation: async (_sender, workspaceId, work) => {
      if (workspaceId !== "w") throw Error("Wrong workspace");
      return work(operation);
    }, activePublication,
    launch: vi.fn(async () => {
      const ended = new AbortController();
      const launch = { url: `http://127.0.0.1:${43000 + launches.length}/bootstrap#${"a".repeat(43)}`, ended: ended.signal,
        stop: vi.fn(async () => { ended.abort("ended"); }), isAlive: () => !ended.signal.aborted,
        end: (reason: string) => ended.abort(reason) };
      launches.push(launch); return launch;
    }),
  });
  installAppViewEmbedder(owner as unknown as WebContents);
  cleanups.push(() => manager.closeOwner(owner.id));
  const invoke = (payload: unknown) => Promise.resolve(handler({ sender: owner } as unknown as IpcMainInvokeEvent, payload));
  const open = (viewId = "one") => invoke({ action: "open", workspaceId: "w", appRoot: "app", viewId, colorScheme: "dark" });
  return { manager, owner, isolated, activePublication, launches, lifetime, invoke, open };
}
it("denies unissued attachments and strips every renderer-supplied preference from an issued one", async () => {
  const f = fixture();
  const reject = { preventDefault: vi.fn() };
  f.owner.emit("will-attach-webview", reject, { preload: "evil" }, { src: "file:///evil" });
  expect(reject.preventDefault).toHaveBeenCalledOnce();
  const result = await f.open() as { url: string; partition: string };
  const prefs: Record<string, unknown> = { preload: "evil", preloadURL: "file:///evil", nodeIntegration: true,
    nodeIntegrationInSubFrames: true, webviewTag: true, webSecurity: false, session: "default", arbitrary: true };
  const params = { src: result.url, preload: "evil", webpreferences: "nodeIntegration=yes", partition: "persist:evil" };
  const allow = { preventDefault: vi.fn() };
  f.owner.emit("will-attach-webview", allow, prefs, params);
  expect(allow.preventDefault).not.toHaveBeenCalled();
  expect(prefs).toMatchObject({ partition: result.partition, sandbox: true, contextIsolation: true,
    nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, disablePopups: false, webSecurity: true });
  for (const key of ["preload", "preloadURL", "session", "arbitrary"]) expect(prefs).not.toHaveProperty(key);
  expect(params.partition).toBe(result.partition);
  f.owner.emit("will-attach-webview", reject, {}, { src: result.url });
  expect(reject.preventDefault).toHaveBeenCalledTimes(2);
});
it("creates no launch or guest authorization without an active approval", async () => {
  const f = fixture(); f.activePublication.mockResolvedValue(null);
  expect(await f.open()).toEqual({ kind: "unapproved", viewId: "one" });
  expect(f.launches).toHaveLength(0);
  const event = { preventDefault: vi.fn() };
  f.owner.emit("will-attach-webview", event, {}, { src: "http://127.0.0.1:43000/bootstrap" });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await expect(f.invoke({ action: "open", workspaceId: "other", appRoot: "app", viewId: "one", colorScheme: "dark" })).rejects.toThrow("Wrong workspace");
});
it("refuses a launch URL issued to another owning window", async () => {
  const first = fixture();
  const opened = await first.open() as { url: string };
  const second = fixture();
  const event = { preventDefault: vi.fn() };
  second.owner.emit("will-attach-webview", event, {}, { src: opened.url });
  expect(event.preventDefault).toHaveBeenCalledOnce();
});
it("limits pending opens to eight and replaces or closes their launcher sessions", async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 8 }, (_, i) => f.open(`tab${i}`)));
  await expect(f.open("ninth")).rejects.toThrow("Close another app before opening this one.");
  await f.open("tab0");
  expect(f.launches[0]!.stop).toHaveBeenCalled();
  await f.invoke({ action: "close", workspaceId: "w", viewId: "tab0" });
  expect(f.launches[8]!.stop).toHaveBeenCalled();
  await f.manager.closeWorkspace("w");
  expect(f.launches.every(launch => launch.stop.mock.calls.length > 0)).toBe(true);
});
it("denies permission checks and display capture, and guards main-frame requests before guest load", async () => {
  const f = fixture();
  const opened = await f.open() as { url: string; partition: string };
  const prefs: Record<string, unknown> = {};
  f.owner.emit("will-attach-webview", { preventDefault: vi.fn() }, prefs, { src: opened.url });
  const guest = Object.assign(new EventEmitter(), { id: nextId++, hostWebContents: f.owner, session: f.isolated,
    getType: () => "webview", getLastWebPreferences: () => prefs, isDestroyed: () => false,
    close: vi.fn(), setWindowOpenHandler: vi.fn(), debugger: { isAttached: () => true, sendCommand: vi.fn(async () => {}) } });
  app.emit("web-contents-created", {}, guest);
  const permission = vi.fn();
  f.isolated.setPermissionRequestHandler.mock.calls[0]![0](guest, "notifications", permission);
  expect(permission).toHaveBeenCalledExactlyOnceWith(false);
  expect(f.isolated.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false);
  expect(f.isolated.setDevicePermissionHandler.mock.calls[0]![0]()).toBe(false);
  const capture = vi.fn(); f.isolated.setDisplayMediaRequestHandler.mock.calls[0]![0]({}, capture);
  expect(capture).toHaveBeenCalledExactlyOnceWith({});
  const request = f.isolated.webRequest.onBeforeRequest.mock.calls[0]![0];
  for (const [url, cancel] of [[opened.url, false], ["https://example.com/", true], ["http://127.0.0.1:43001/bootstrap", true],
    ["http://127.0.0.1:43000/backend", true], ["file:///evil", true]] as const) {
    const callback = vi.fn(); request({ resourceType: "mainFrame", webContentsId: guest.id, url }, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel });
  }
  const download = { getFilename: () => "blocked.txt", cancel: vi.fn() };
  f.isolated.emit("will-download", {}, download, guest);
  expect(download.cancel).toHaveBeenCalledOnce();
  expect(f.owner.send).toHaveBeenCalledWith(CHANNELS.appViewEvent, { kind: "download-blocked", viewId: "one", filename: "blocked.txt" });
  const links = () => f.owner.send.mock.calls.filter(([, event]) => (event as { kind: string }).kind === "external-link");
  const unprompted = { url: "https://example.com/unprompted", isMainFrame: false, preventDefault: vi.fn() };
  guest.emit("will-frame-navigate", unprompted);
  expect(unprompted.preventDefault).toHaveBeenCalledOnce();
  expect(links()).toHaveLength(0);
  guest.emit("input-event", {}, { type: "mouseMove" });
  guest.emit("will-frame-navigate", unprompted);
  expect(links()).toHaveLength(0);
  guest.emit("before-mouse-event", {}, { type: "mouseDown" });
  const navigation = { url: "https://example.com/out", isMainFrame: false, preventDefault: vi.fn() };
  guest.emit("will-frame-navigate", navigation);
  expect(navigation.preventDefault).toHaveBeenCalledOnce();
  expect(f.owner.send).toHaveBeenCalledWith(CHANNELS.appViewEvent, { kind: "external-link", viewId: "one", url: navigation.url });
  guest.emit("will-frame-navigate", { ...navigation, url: "https://example.com/again" });
  expect(links()).toHaveLength(1);
  expect(guest.setWindowOpenHandler.mock.calls[0]![0]({ url: "file:///evil" })).toEqual({ action: "deny" });
  guest.emit("destroyed");
  await expect.poll(() => f.launches[0]!.stop.mock.calls.length).toBeGreaterThan(0);
});
it("retires a session when its owner reloads", async () => {
  const f = fixture(); await f.open();
  f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  await expect.poll(() => f.launches[0]!.stop.mock.calls.length).toBeGreaterThan(0);
  expect(AppViewRequest.safeParse({ action: "reload", workspaceId: "w", viewId: "one" }).success).toBe(false);
});
it("keeps a page whose session ended until its tab reloads, and removes one whose approval ended", async () => {
  const f = fixture();
  const attach = async (viewId: string) => {
    const opened = await f.open(viewId) as { url: string };
    const prefs: Record<string, unknown> = {};
    f.owner.emit("will-attach-webview", { preventDefault: vi.fn() }, prefs, { src: opened.url });
    const guest = Object.assign(new EventEmitter(), { id: nextId++, hostWebContents: f.owner, session: f.isolated,
      getType: () => "webview", getLastWebPreferences: () => prefs, isDestroyed: () => false,
      close: vi.fn(), setWindowOpenHandler: vi.fn(), debugger: { isAttached: () => true, sendCommand: vi.fn(async () => {}) } });
    app.emit("web-contents-created", {}, guest);
    return guest;
  };
  const kept = await attach("one");
  f.launches[0]!.end("ended");
  expect(f.owner.send).toHaveBeenCalledWith(CHANNELS.appViewEvent, { kind: "session-ended", viewId: "one" });
  await Promise.resolve();
  expect(kept.close).not.toHaveBeenCalled();
  await f.open("one");
  expect(kept.close).toHaveBeenCalledOnce();
  const removed = await attach("two");
  f.launches.at(-1)!.end("needs-approval");
  expect(f.owner.send).toHaveBeenCalledWith(CHANNELS.appViewEvent, { kind: "approval-ended", viewId: "two" });
  await expect.poll(() => removed.close.mock.calls.length).toBe(1);
});
