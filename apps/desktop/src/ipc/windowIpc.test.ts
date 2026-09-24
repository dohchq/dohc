import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowIpc } from "./windowIpc";
import { CHANNELS } from "./channels";
import { decideNavigation } from "../security/electronSecurity";
import { createExitRounds, createQuitGuard } from "../quitGuard";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import { createUserSettingsWriteQueue, createZoomMutation } from "../window/windowZoom";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../settings/userSettings";
import { createMarkRecorder } from "../performance/desktopMarks";
import { deferred } from "../testing/deferred";

const DOCUMENT = "123e4567-e89b-42d3-a456-426614174001";
const OTHER_DOCUMENT = "123e4567-e89b-42d3-a456-426614174002";
const frame = { url: "http://localhost:5173/app" };
function sender(id: number) {
  let destroyed = false;
  return {
    id, isDestroyed: () => destroyed, destroy: () => { destroyed = true; }, reload: vi.fn(),
    once(_event: "destroyed", _listener: () => void) { return this; },
  };
}
type Sender = ReturnType<typeof sender>;
type Event = { sender: Sender; senderFrame?: { url: string } | null };

async function harness(isPackaged = false) {
  const first = sender(1), second = sender(2);
  let retirement = Promise.resolve();
  const retiring = vi.fn(() => ({ requiredForAdmission: retirement, detachedFromAdmission: Promise.resolve() }));
  const sessions = new RendererWorkspaceSessionOwner<Sender>({ retirement: {
    retireSender: retiring, retireWorkspace: async () => undefined,
  } });
  await sessions.open(first, { workspaceId: "a", attachmentId: Symbol("a") }, DOCUMENT);
  await sessions.open(second, { workspaceId: "b", attachmentId: Symbol("b") }, DOCUMENT);
  const prepareForRendererReload = vi.fn((value: Sender, document: string) => sessions.retireForReload(value, document));
  const quit = vi.fn(), forceQuit = vi.fn(), ask = vi.fn();
  const quitGuard = createQuitGuard({ ask, quit, forceQuit });
  const requestIds: number[] = [];
  const confirmProceed = vi.fn(async () => false);
  const exitRounds = createExitRounds<Sender>({
    participants: () => [first, second],
    participantId: (value) => value.id,
    send: (_value, message) => { if (message.kind === "request") requestIds.push(message.roundId); },
    confirmProceed,
  });
  const enqueue = createUserSettingsWriteQueue();
  let stored: DesktopUserSettings = structuredClone(DEFAULT_USER_SETTINGS);
  const apply = vi.fn();
  const write = vi.fn(async (next: DesktopUserSettings) => { stored = next; return { settings: next, source: "stored" as const }; });
  const stepWindowZoom = createZoomMutation({ enqueue, read: async () => ({ settings: stored, source: "stored" }), write, apply });
  const clipboard = { writeText: vi.fn() };
  const shell = { openExternal: vi.fn(async (_url: string) => undefined) };
  const overlay = vi.fn();
  const windows = new Map<Sender, { setTitleBarOverlay?: typeof overlay }>([[first, { setTitleBarOverlay: overlay }]]);
  const BrowserWindow = { fromWebContents: vi.fn((value: Sender) => windows.get(value) ?? null) };
  const rememberChromeTheme = vi.fn();
  const titleBarOverlayOptions = vi.fn((_theme: "light" | "dark") => ({ height: 32, color: "paper", symbolColor: "ink" }));
  const launchSnapshot = { appReadyMs: 1, firstWindowMs: 2, firstPaintMs: 3 };
  const launchMarks = { firstPaint: vi.fn(), snapshot: vi.fn(() => launchSnapshot) };
  let clock = 10;
  const desktopMarks = createMarkRecorder(() => clock++);
  const logLaunchMarksOnce = vi.fn();
  const isTrustedFrame = (url: string) => decideNavigation(url, { httpOrigins: ["http://localhost:5173"], fileUrlPrefix: null }).action === "allow";
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const events = new Map<string, (event: Event) => void>();
  const order: string[] = [];
  const capability = createWindowIpc<Sender, Event, Event>({
    registerHandler: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
      handlers.set(channel, handler); order.push(channel);
    },
    registerEvent: (channel, handler) => { events.set(channel, handler); order.push(channel); },
    assertTrustedSender: event => { if (!isTrustedFrame(event.senderFrame?.url ?? "")) throw new Error("untrusted"); },
    prepareForRendererReload, shell, clipboard, BrowserWindow, rememberChromeTheme,
    titleBarOverlayOptions, stepWindowZoom, exitRounds, quitGuard, isTrustedFrame,
    launchMarks, desktopMarks, logLaunchMarksOnce, app: { isPackaged },
  });
  return {
    ...capability, first, second, handlers, events, order, sessions, retiring,
    prepareForRendererReload, setRetirement: (next: Promise<void>) => { retirement = next; },
    quit, forceQuit, ask, quitGuard, exitRounds, requestIds, confirmProceed,
    enqueue, write, apply, stored: () => stored, clipboard, shell, overlay, windows,
    BrowserWindow, rememberChromeTheme, titleBarOverlayOptions, launchMarks, desktopMarks,
    logLaunchMarksOnce,
    registerAll() { capability.registerReload(); capability.registerExternalUrl(); capability.registerWindowControls(); capability.registerQuitAndMarks(); },
    invoke: async (channel: string, payload?: unknown, value = first, senderFrame: Event["senderFrame"] = frame) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing handler: ${channel}`);
      return handler({ sender: value, senderFrame }, payload);
    },
    paint: (senderFrame: Event["senderFrame"]) => events.get(CHANNELS.firstPaint)!({ sender: first, senderFrame }),
  };
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("registered window IPC", () => {
  it("registers each group in place with the test mark handlers last", async () => {
    vi.stubEnv("DOHC_DESKTOP_TEST", "1");
    const h = await harness();
    h.registerReload(); h.order.push("registry");
    h.registerExternalUrl(); h.order.push("handoff");
    h.registerWindowControls(); h.order.push("ui-state", "updates");
    h.registerQuitAndMarks();
    expect(h.order).toEqual([
      CHANNELS.reloadRenderer, "registry", CHANNELS.openExternalUrl, "handoff",
      CHANNELS.writeClipboardText, CHANNELS.setTitlebarTheme, CHANNELS.stepWindowZoom,
      "ui-state", "updates", CHANNELS.exitRoundAnswer, CHANNELS.holdQuit,
      CHANNELS.resumeQuit, CHANNELS.firstPaint, CHANNELS.getLaunchMarks, CHANNELS.getDesktopMarks,
    ]);
  });

  it("rejects every invoke from an untrusted frame before side effects", async () => {
    vi.stubEnv("DOHC_DESKTOP_TEST", "1");
    const h = await harness(); h.registerAll();
    for (const channel of h.handlers.keys()) {
      await expect(h.invoke(channel, undefined, h.first, { url: "http://localhost:5173.evil.test" })).rejects.toThrow("untrusted");
    }
    expect(h.prepareForRendererReload).not.toHaveBeenCalled();
    expect(h.clipboard.writeText).not.toHaveBeenCalled();
    expect(h.shell.openExternal).not.toHaveBeenCalled();
    expect(h.rememberChromeTheme).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.launchMarks.snapshot).not.toHaveBeenCalled();
  });

  it("validates payloads before admitting reload, clipboard, theme, zoom or URL work", async () => {
    const h = await harness(); h.registerAll();
    for (const [channel, payload] of [
      [CHANNELS.reloadRenderer, { rendererDocumentId: "invalid" }],
      [CHANNELS.writeClipboardText, { text: "" }],
      [CHANNELS.writeClipboardText, { text: "a".repeat(20_001) }],
      [CHANNELS.setTitlebarTheme, { theme: "other" }],
      [CHANNELS.stepWindowZoom, { step: "twice" }],
      [CHANNELS.openExternalUrl, { url: 1 }],
    ] as const) await expect(h.invoke(channel, payload)).rejects.toThrow();
    expect(h.prepareForRendererReload).not.toHaveBeenCalled();
    expect(h.clipboard.writeText).not.toHaveBeenCalled();
    expect(h.rememberChromeTheme).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.shell.openExternal).not.toHaveBeenCalled();
  });

  it("reloads only the captured sender after its real session retirement drains", async () => {
    const h = await harness(); h.registerReload();
    const held = deferred(); h.setRetirement(held.promise);
    const reload = h.invoke(CHANNELS.reloadRenderer, { rendererDocumentId: DOCUMENT });
    try {
      expect(h.sessions.current(h.first)).toBeUndefined();
      expect(h.sessions.current(h.second)?.workspaceId).toBe("b");
      expect(h.retiring).toHaveBeenCalledTimes(1);
      expect(h.first.reload).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await Promise.allSettled([reload]);
    }
    await reload;
    expect(h.prepareForRendererReload).toHaveBeenCalledWith(h.first, DOCUMENT);
    expect(h.first.reload).toHaveBeenCalledOnce();
    expect(h.second.reload).not.toHaveBeenCalled();
  });

  it("refuses an obsolete document without retiring the current session", async () => {
    const h = await harness(); h.registerReload();
    await h.invoke(CHANNELS.reloadRenderer, { rendererDocumentId: OTHER_DOCUMENT });
    expect(h.sessions.current(h.first)?.rendererDocumentId).toBe(DOCUMENT);
    expect(h.retiring).not.toHaveBeenCalled();
    expect(h.first.reload).not.toHaveBeenCalled();
  });

  it("does not reload a sender destroyed while retirement is held", async () => {
    const h = await harness(); h.registerReload();
    const held = deferred(); h.setRetirement(held.promise);
    const reload = h.invoke(CHANNELS.reloadRenderer, { rendererDocumentId: DOCUMENT });
    h.first.destroy(); held.resolve(); await reload;
    expect(h.first.reload).not.toHaveBeenCalled();
  });

  it("propagates reload preparation failure without reloading", async () => {
    const h = await harness(); h.registerReload();
    h.prepareForRendererReload.mockRejectedValueOnce(new Error("retirement failed"));
    await expect(h.invoke(CHANNELS.reloadRenderer, { rendererDocumentId: DOCUMENT })).rejects.toThrow("retirement failed");
    expect(h.first.reload).not.toHaveBeenCalled();
  });

  it.each(["https://example.test/path", "http://example.test", "mailto:ice@example.test"])("opens an allowed external URL: %s", async url => {
    const h = await harness(); h.registerExternalUrl();
    await h.invoke(CHANNELS.openExternalUrl, { url });
    expect(h.shell.openExternal).toHaveBeenCalledWith(url);
  });

  it.each(["file:///private/file", "javascript:alert(1)", "custom:action"])("refuses an external protocol: %s", async url => {
    const h = await harness(); h.registerExternalUrl();
    await expect(h.invoke(CHANNELS.openExternalUrl, { url })).rejects.toThrow("Refusing to open non-http(s) URL externally");
    expect(h.shell.openExternal).not.toHaveBeenCalled();
  });

  it("propagates a failed OS browser request", async () => {
    const h = await harness(); h.registerExternalUrl();
    h.shell.openExternal.mockRejectedValueOnce(new Error("browser failed"));
    await expect(h.invoke(CHANNELS.openExternalUrl, { url: "https://example.test" })).rejects.toThrow("browser failed");
  });

  it("copies the exact bounded text", async () => {
    const h = await harness(); h.registerWindowControls();
    const text = " a\n".padEnd(20_000, "x");
    await h.invoke(CHANNELS.writeClipboardText, { text });
    expect(h.clipboard.writeText).toHaveBeenCalledWith(text);
  });

  it("persists theme before tinting only the sender's window", async () => {
    const h = await harness(); h.registerWindowControls();
    await h.invoke(CHANNELS.setTitlebarTheme, { theme: "dark" });
    expect(h.rememberChromeTheme).toHaveBeenCalledWith("dark");
    expect(h.rememberChromeTheme.mock.invocationCallOrder[0]).toBeLessThan(h.overlay.mock.invocationCallOrder[0]!);
    expect(h.BrowserWindow.fromWebContents).toHaveBeenCalledWith(h.first);
    expect(h.titleBarOverlayOptions).toHaveBeenCalledWith("dark");
    expect(h.overlay).toHaveBeenCalledWith({ height: 32, color: "paper", symbolColor: "ink" });
    await h.invoke(CHANNELS.setTitlebarTheme, { theme: "light" }, h.second);
    expect(h.rememberChromeTheme).toHaveBeenLastCalledWith("light");
    expect(h.overlay).toHaveBeenCalledTimes(1);
  });

  it("tolerates absent and throwing platform overlays", async () => {
    const h = await harness(); h.registerWindowControls();
    h.windows.set(h.first, {});
    await expect(h.invoke(CHANNELS.setTitlebarTheme, { theme: "dark" })).resolves.toBeUndefined();
    h.windows.set(h.first, { setTitleBarOverlay: h.overlay });
    h.overlay.mockImplementationOnce(() => { throw new Error("unsupported"); });
    await expect(h.invoke(CHANNELS.setTitlebarTheme, { theme: "light" })).resolves.toBeUndefined();
    expect(h.rememberChromeTheme).toHaveBeenCalledTimes(2);
  });

  it("queues zoom behind another settings write and persists before applying", async () => {
    const h = await harness(); h.registerWindowControls();
    const reached = deferred(), release = deferred();
    const settingsWrite = h.enqueue(async () => {
      reached.resolve(); await release.promise;
      await h.write({ ...h.stored(), appearance: { ...h.stored().appearance, zoomLevel: 2 } });
    });
    await reached.promise;
    const zoom = h.invoke(CHANNELS.stepWindowZoom, { step: "in" });
    h.apply.mockImplementation(level => { expect(h.stored().appearance.zoomLevel).toBe(level); });
    try { expect(h.apply).not.toHaveBeenCalled(); } finally {
      release.resolve();
      await Promise.allSettled([settingsWrite, zoom]);
    }
    await settingsWrite;
    await expect(zoom).resolves.toMatchObject({ source: "stored", settings: { appearance: { zoomLevel: 3 } } });
    expect(h.apply).toHaveBeenCalledWith(3);
    await expect(h.invoke(CHANNELS.stepWindowZoom, { step: "out" })).resolves.toMatchObject({ settings: { appearance: { zoomLevel: 2 } } });
  });

  it("does not apply failed zoom persistence and accepts the next queued mutation", async () => {
    const h = await harness(); h.registerWindowControls();
    const initial = h.stored().appearance.zoomLevel;
    h.write.mockRejectedValueOnce(new Error("disk failed"));
    await expect(h.invoke(CHANNELS.stepWindowZoom, { step: "in" })).rejects.toThrow("disk failed");
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.stored().appearance.zoomLevel).toBe(initial);
    await expect(h.invoke(CHANNELS.stepWindowZoom, { step: "in" })).resolves.toMatchObject({ settings: { appearance: { zoomLevel: initial + 1 } } });
  });

  it("holds an approved quit until the registered resume answer", async () => {
    const h = await harness(); h.registerQuitAndMarks();
    const event = { preventDefault: vi.fn() };
    h.quitGuard.beforeQuit(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(h.ask).toHaveBeenCalledOnce();
    await h.invoke(CHANNELS.holdQuit);
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.forceQuit).not.toHaveBeenCalled();
    await h.invoke(CHANNELS.resumeQuit);
    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.quitGuard.beforeQuit(event)).toBe("proceed");
    h.quitGuard.hold();
  });

  it("keys round answers to the sender and round, and ignores malformed answers", async () => {
    vi.useFakeTimers();
    const h = await harness(); h.registerQuitAndMarks();
    const round = h.exitRounds.begin("update");
    const settled = vi.fn();
    void round.outcome.then(settled);
    const roundId = round.roundId;
    for (const payload of [null, undefined, {}, { roundId, decision: "yes" }, { roundId: "1", decision: "clear" }]) {
      await h.invoke(CHANNELS.exitRoundAnswer, payload);
    }
    // A stale round, and a sender that is not in the round.
    await h.invoke(CHANNELS.exitRoundAnswer, { roundId: roundId + 7, decision: "clear" });
    await h.invoke(CHANNELS.exitRoundAnswer, { roundId, decision: "clear" }, sender(99));
    await h.invoke(CHANNELS.exitRoundAnswer, { roundId, decision: "clear" }, h.first);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled, "one clear window must not carry the other").not.toHaveBeenCalled();
    await h.invoke(CHANNELS.exitRoundAnswer, { roundId, decision: "clear" }, h.second);
    await expect(round.outcome).resolves.toBe("proceed");
    expect(h.confirmProceed).not.toHaveBeenCalled();
  });

  it.each([["0", false], ["1", true], ["0", true], ["1", false]] as const)("gates mark snapshots for test=%s packaged=%s", async (flag, packaged) => {
    vi.stubEnv("DOHC_DESKTOP_TEST", flag);
    const h = await harness(packaged); h.registerQuitAndMarks();
    expect(h.handlers.has(CHANNELS.getLaunchMarks)).toBe(flag === "1" && !packaged);
    expect(h.handlers.has(CHANNELS.getDesktopMarks)).toBe(flag === "1" && !packaged);
    expect(h.events.has(CHANNELS.firstPaint)).toBe(true);
  });

  it("records only trusted first paint and returns parsed mark snapshots", async () => {
    vi.stubEnv("DOHC_DESKTOP_TEST", "1");
    const h = await harness(); h.registerQuitAndMarks();
    h.paint(null); h.paint({ url: "https://outside.test" });
    expect(h.launchMarks.firstPaint).not.toHaveBeenCalled();
    expect(h.desktopMarks.snapshot().marks).toEqual({});
    h.paint(frame); h.paint(frame);
    expect(h.launchMarks.firstPaint).toHaveBeenCalledTimes(2);
    expect(h.logLaunchMarksOnce).toHaveBeenCalledTimes(2);
    await expect(h.invoke(CHANNELS.getDesktopMarks)).resolves.toEqual({ marks: { "first-renderer-paint": 10 }, measures: {} });
    await expect(h.invoke(CHANNELS.getLaunchMarks)).resolves.toEqual({ appReadyMs: 1, firstWindowMs: 2, firstPaintMs: 3 });
    h.launchMarks.snapshot.mockReturnValueOnce({ appReadyMs: -1, firstWindowMs: 2, firstPaintMs: 3 });
    await expect(h.invoke(CHANNELS.getLaunchMarks)).rejects.toThrow();
  });

  it("reads the test flag when the mark handlers register", async () => {
    vi.stubEnv("DOHC_DESKTOP_TEST", "0");
    const h = await harness();
    vi.stubEnv("DOHC_DESKTOP_TEST", "1");
    h.registerQuitAndMarks();
    expect(h.handlers.has(CHANNELS.getLaunchMarks)).toBe(true);
    expect(h.handlers.has(CHANNELS.getDesktopMarks)).toBe(true);
  });
});
