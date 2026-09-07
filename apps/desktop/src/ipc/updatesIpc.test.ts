import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerUpdatesIpcHandlers } from "./updatesIpc";
import { CHANNELS } from "./channels";
import { createQuitGuard, createRecoveryChecker } from "../quitGuard";
import { startAutoUpdates, publicUpdateState, type AutoUpdateController } from "../updates/electronUpdater";
import { initialUpdateState } from "../updates/updateMachine";
import { deferred } from "../testing/deferred";

class Updater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn<() => Promise<unknown>>(async () => undefined);
  quitAndInstall = vi.fn<(silent?: boolean, forceRunAfter?: boolean) => void>();
}

type Event = { trusted: boolean };
const channels = [CHANNELS.getUpdateState, CHANNELS.checkForUpdates, CHANNELS.installUpdate];
const cleanup: Array<() => Promise<void>> = [];

function harness() {
  const handlers = new Map<string, (event: Event, payload?: unknown) => unknown>();
  const pending = new Set<Promise<unknown>>();
  const controllers: AutoUpdateController[] = [];
  const requests: number[] = [];
  const requested = deferred<number>();
  let decision: boolean | null = false;
  let controller: AutoUpdateController | null = null;
  const fallback = { ...publicUpdateState(initialUpdateState, { currentVersion: "1.2.3", channel: "latest" }), canCheck: false, canInstall: false };
  const askRenderer = vi.fn();
  const quitGuard = createQuitGuard({
    askRenderer, confirmForceQuit: async () => false, quit: vi.fn(), forceQuit: vi.fn(), timeoutMs: 60 * 60_000,
  });
  const recoveryChecker = createRecoveryChecker({
    send: (id) => {
      requests.push(id);
      requested.resolve(id);
      if (decision !== null) recoveryChecker.answer(id, decision);
      return true;
    },
    confirmProceed: async () => false, timeoutMs: 60 * 60_000,
  });
  const currentUpdateState = vi.fn(() => controller?.publicState() ?? fallback);
  const readController = vi.fn(() => controller);
  const approve = vi.spyOn(quitGuard, "approve");
  const revoke = vi.spyOn(quitGuard, "revoke");
  registerUpdatesIpcHandlers<Event>({
    registerHandler: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`);
      handlers.set(channel, handler);
    },
    assertTrustedSender: event => { if (!event.trusted) throw new Error("untrusted"); },
    currentUpdateState, recoveryChecker, quitGuard,
    get autoUpdateController() { return readController(); },
  });
  const invoke = (channel: string, payload?: unknown, trusted = true) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`unregistered channel: ${channel}`);
    const result = handler({ trusted }, payload);
    if (result instanceof Promise) {
      pending.add(result);
      void result.then(() => pending.delete(result), () => pending.delete(result));
    }
    return result;
  };
  const start = async () => {
    const updater = new Updater();
    const quitForStagedRestart = vi.fn();
    const started = await startAutoUpdates({
      isPackaged: true, env: {}, currentVersion: "1.2.3",
      startupDelayMs: 60 * 60_000, pollIntervalMs: 60 * 60_000,
      importUpdater: async () => ({ autoUpdater: updater }), quitForStagedRestart,
    });
    if (!started) throw new Error("packaged updater did not start");
    controllers.push(started);
    controller = started;
    return { updater, controller: started, quitForStagedRestart };
  };
  const canQuit = () => {
    const result = quitGuard.beforeQuit({ preventDefault: vi.fn() });
    if (result === "asked") quitGuard.hold();
    return result === "proceed";
  };
  cleanup.push(async () => {
    for (const id of requests) recoveryChecker.answer(id, true);
    try { await Promise.allSettled([...pending]); }
    finally {
      for (const owner of controllers) owner.stop();
      quitGuard.hold();
    }
  });
  return {
    handlers, invoke, start, fallback, currentUpdateState, readController,
    quitGuard, approve, revoke, recoveryChecker, requests, requested, canQuit,
    setDecision: (value: boolean | null) => { decision = value; },
    setController: (value: AutoUpdateController | null) => { controller = value; },
  };
}

afterEach(async () => {
  try { for (const close of cleanup.splice(0)) await close(); }
  finally { vi.restoreAllMocks(); }
});

describe("registered updater IPC", () => {
  it("registers the original channels and returns the initial public state synchronously", () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual(channels);
    expect(h.invoke(CHANNELS.getUpdateState, { ignored: true })).toEqual({
      status: "idle", message: "Updates have not been checked yet.", currentVersion: "1.2.3",
      channel: "latest", canCheck: false, canInstall: false,
    });
    expect(h.readController).not.toHaveBeenCalled();
  });

  it("rejects untrusted callers before reading state, resolving a controller, or approving quit", async () => {
    const h = harness();
    for (const channel of channels) {
      await expect(Promise.resolve().then(() => h.invoke(channel, null, false))).rejects.toThrow("untrusted");
    }
    expect(h.currentUpdateState).not.toHaveBeenCalled();
    expect(h.readController).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("returns unavailable actions without a controller or a recovery request", async () => {
    const h = harness();
    await expect(h.invoke(CHANNELS.checkForUpdates, null)).resolves.toEqual({ checked: false, state: h.fallback });
    await expect(h.invoke(CHANNELS.installUpdate, { ignored: true })).resolves.toEqual({ accepted: false, state: h.fallback });
    expect(h.requests).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
  });

  it("reads a controller attached after registration and returns its current state", async () => {
    const h = harness();
    const { updater } = await h.start();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-not-available");
    });
    await expect(h.invoke(CHANNELS.checkForUpdates)).resolves.toMatchObject({ checked: true, state: { status: "up-to-date" } });
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(h.invoke(CHANNELS.getUpdateState)).toMatchObject({ status: "up-to-date", canCheck: true });
    h.setController(null);
    await expect(h.invoke(CHANNELS.checkForUpdates)).resolves.toEqual({ checked: false, state: h.fallback });
  });

  it("waits for the real controller check and retains its in-flight refusal", async () => {
    const h = harness();
    const { updater } = await h.start();
    const reached = deferred(), release = deferred();
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update"); reached.resolve(); await release.promise;
      updater.emit("update-not-available");
    });
    const first = h.invoke(CHANNELS.checkForUpdates);
    try {
      await reached.promise;
      await expect(h.invoke(CHANNELS.checkForUpdates)).resolves.toMatchObject({ checked: false, state: { status: "checking", canCheck: false } });
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
      release.resolve();
      await expect(first).resolves.toMatchObject({ checked: true, state: { status: "up-to-date" } });
    } finally {
      release.resolve();
      await Promise.allSettled([first]);
    }
  });

  it("waits for a fresh recovery answer before approving quit or calling the updater", async () => {
    const h = harness();
    const { updater } = await h.start();
    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "1.2.4" });
    h.setDecision(null);
    updater.quitAndInstall.mockImplementation(() => {
      expect(h.canQuit()).toBe(true);
    });
    const result = h.invoke(CHANNELS.installUpdate);
    try {
      const requestId = await h.requested.promise;
      expect(h.approve).not.toHaveBeenCalled();
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      h.recoveryChecker.answer(requestId, false);
      await expect(result).resolves.toMatchObject({ accepted: true, state: { status: "ready", version: "1.2.4" } });
      expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
      expect(h.revoke).not.toHaveBeenCalled();
    } finally {
      for (const id of h.requests) h.recoveryChecker.answer(id, true);
      await Promise.allSettled([result]);
    }
  });

  it("returns current state when recovery blocks installation and leaves quit unapproved", async () => {
    const h = harness();
    const { updater } = await h.start();
    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "1.2.4" });
    h.setDecision(true);
    await expect(h.invoke(CHANNELS.installUpdate)).resolves.toMatchObject({ accepted: false, state: { status: "ready" } });
    expect(h.requests).toHaveLength(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.canQuit()).toBe(false);
  });

  it("resolves the shared controller again after recovery settles", async () => {
    const h = harness();
    const first = await h.start();
    first.updater.emit("checking-for-update");
    first.updater.emit("update-downloaded", { version: "1.2.4" });
    h.setDecision(null);
    const result = h.invoke(CHANNELS.installUpdate);
    try {
      const requestId = await h.requested.promise;
      const second = await h.start();
      second.updater.emit("checking-for-update");
      second.updater.emit("update-downloaded", { version: "1.2.5" });
      h.recoveryChecker.answer(requestId, false);
      await expect(result).resolves.toMatchObject({ accepted: true, state: { version: "1.2.5" } });
      expect(first.updater.quitAndInstall).not.toHaveBeenCalled();
      expect(second.updater.quitAndInstall).toHaveBeenCalledOnce();
    } finally {
      for (const id of h.requests) h.recoveryChecker.answer(id, true);
      await Promise.allSettled([result]);
    }
  });

  it("revokes approval when the real controller refuses an install", async () => {
    const h = harness();
    const { updater } = await h.start();
    await expect(h.invoke(CHANNELS.installUpdate)).resolves.toMatchObject({ accepted: false, state: { status: "idle" } });
    expect(h.approve).toHaveBeenCalledOnce();
    expect(h.revoke).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(h.canQuit()).toBe(false);
  });

  it("keeps approval until an awaited install refusal arrives", async () => {
    const h = harness();
    const { controller } = await h.start();
    const reached = deferred(), release = deferred();
    const install = controller.installUpdate;
    vi.spyOn(controller, "installUpdate").mockImplementationOnce(async () => {
      const result = await install();
      reached.resolve();
      await release.promise;
      return result;
    });
    const result = h.invoke(CHANNELS.installUpdate);
    try {
      await reached.promise;
      expect(h.approve).toHaveBeenCalledOnce();
      expect(h.revoke).not.toHaveBeenCalled();
      expect(h.canQuit()).toBe(true);
      release.resolve();
      await expect(result).resolves.toMatchObject({ accepted: false });
      expect(h.canQuit()).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([result]);
    }
  });

  it("revokes after restart failure and lets the shared controller retry", async () => {
    const h = harness();
    const { updater } = await h.start();
    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "1.2.4" });
    updater.quitAndInstall.mockImplementationOnce(() => { throw new Error("restart failed"); });
    await expect(h.invoke(CHANNELS.installUpdate)).resolves.toMatchObject({ accepted: false, state: { status: "ready" } });
    expect(h.canQuit()).toBe(false);
    await expect(h.invoke(CHANNELS.installUpdate)).resolves.toMatchObject({ accepted: true });
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(2);
    expect(h.canQuit()).toBe(true);
  });

  it("uses the existing staged-restart path after a quit was held", async () => {
    const h = harness();
    const { updater, quitForStagedRestart } = await h.start();
    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "1.2.4" });
    await h.invoke(CHANNELS.installUpdate);
    h.quitGuard.hold();
    await expect(h.invoke(CHANNELS.installUpdate)).resolves.toMatchObject({ accepted: true });
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(quitForStagedRestart).toHaveBeenCalledOnce();
    expect(h.canQuit()).toBe(true);
  });

  it("propagates recovery failure before approving quit", async () => {
    const h = harness();
    const { updater } = await h.start();
    const error = new Error("recovery failed");
    vi.spyOn(h.recoveryChecker, "ask").mockRejectedValueOnce(error);
    await expect(h.invoke(CHANNELS.installUpdate)).rejects.toBe(error);
    expect(h.approve).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("parses check results after awaiting the controller", async () => {
    const h = harness();
    const { controller } = await h.start();
    vi.spyOn(controller, "checkForUpdates").mockResolvedValueOnce({ checked: true, state: { ...controller.publicState(), message: "" } });
    await expect(h.invoke(CHANNELS.checkForUpdates)).rejects.toThrow();
  });

  it.each(["rejection", "malformed result"])("preserves install %s ordering after quit approval", async mode => {
    const h = harness();
    const { controller } = await h.start();
    const install = vi.spyOn(controller, "installUpdate");
    if (mode === "rejection") install.mockRejectedValueOnce(new Error("install failed"));
    else install.mockResolvedValueOnce({ accepted: false, state: { ...controller.publicState(), message: "" } });
    await expect(h.invoke(CHANNELS.installUpdate)).rejects.toThrow();
    expect(h.approve).toHaveBeenCalledOnce();
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.canQuit()).toBe(true);
  });
});
