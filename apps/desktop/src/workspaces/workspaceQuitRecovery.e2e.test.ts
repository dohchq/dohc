import { EventEmitter } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createAppLifecycle } from "../appLifecycle";
import { createShareHandoffIntentSlot } from "../shareHandoffIngress";
import { WILL_QUIT_BUDGET_MS } from "../shutdownBudgets";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { waitForPathMoments } from "./waitForPathMoments";

const engine = requireEngineBinaryOrSkip();

it.skipIf(engine.missing)("quit after a refused settle exits cleanly and recovers typing once", async () => {
  const rootPath = await createTestScratch("dohc-quit-refused-settle-");
  const workspaceId = "quit-refused-settle";
  const path = "note.md";
  const outside = "# Outside\n\nWritten by another app.\n";
  const human = "Typing that must survive quit.";
  await writeFile(join(rootPath, path), "# Note\n\nBase paragraph.\n");
  const start = async () => {
    const daemon = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
    await daemon.start();
    const sessions = createRealDaemonWorkspaceSessions(daemon);
    const capture = createWorkspaceEngineCapture({ workspaceId, rootPath, attachmentId: Symbol("quit"),
      rustEngineSessions: sessions, settleDebounceMs: 600_000, onError: () => undefined });
    return { daemon, sessions, capture };
  };
  let running = await start();
  const editor = new Y.Doc();
  try {
    await waitForPathMoments(running.capture, path, 1);
    const session = await running.capture.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate() {} });
    Y.applyUpdate(editor, session.initialUpdate);
    await writeFile(join(rootPath, path), outside);
    const before = Y.encodeStateVector(editor);
    const paragraph = editor.getXmlFragment("body").get(1) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    text.insert(text.length, human);
    await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
    await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
    const exited = Promise.withResolvers<number>();
    const stopped = Promise.withResolvers<void>();
    let closeError: unknown;
    const noop = () => undefined;
    const done = async () => undefined;
    const app = Object.assign(new EventEmitter(), {
      requestSingleInstanceLock: () => true, whenReady: done, quit: noop,
      exit: (code: number) => exited.resolve(code),
    });
    createAppLifecycle({
      app, runtime: process,
      handoff: { slot: createShareHandoffIntentSlot(), pendingCodeChanged: noop },
      windows: { create: noop, whenLoaded: async () => true,
        openFailureTarget: () => ({ whenReady: async () => true, isCurrent: () => true }),
        current: noop, hasWorkspace: () => false, hasAny: () => false,
        showOrCreate: done, activate: noop },
      workspaces: { openPath: async () => null, recordOpenFailure: noop, reportOpenFailure: noop, refreshNativeSurfaces: noop },
      bootstrap: { markReady: noop, startEngine: async () => true, loadSettings: done, applySettings: noop,
        prepareCli: noop, registerHandlers: noop, markFirstWindow: noop, reportFailure: noop },
      services: { startCli: async () => ({ close: done }), reportCliFailure: noop,
        dispatch: { start: noop, stop: done }, refreshTray: async () => false,
        releaseIdleWorkspaces: done, reportTrayFailure: noop, warmCredentials: done, reconcileCloud: noop,
        startUpdates: noop, updateAfterStartupFailure: async () => false, updateAfterWindowLoadFailure: async () => false },
      launch: { finished: noop }, beforeQuit: noop,
      shutdown: {
        budgetMs: WILL_QUIT_BUDGET_MS, deadlineExitCode: 1,
        beginEngineShutdown() { running.capture.beginShutdown(); running.sessions.beginShutdown(); },
        stopSearch: done, stopSitePreviews: done, stopAgentIntegration: done, flushReports: done,
        // The session owner reports close failure and lets workspace teardown continue.
        settleYDocs: async () => { await session.close({ shuttingDown: true }).catch(error => { closeError = error; }); },
        closeWorkspaces: async () => {
          await running.capture.settleAndCloseAllLiveSessions().catch(() => undefined);
          await running.capture.stop();
          await running.sessions.closeAll();
        },
        disposeDatabase: done, closeRelay: done,
        stopEngine: async () => { try { await running.daemon.stop(); } finally { stopped.resolve(); } },
      },
    });
    app.emit("will-quit", { preventDefault: vi.fn() });
    const code = await exited.promise;
    await stopped.promise;
    running = await start();
    await running.capture.flush();
    const siblings = (await readdir(rootPath)).filter(name => name.startsWith("note (recovered ") && name.endsWith(".md"));
    const recovered = await Promise.all(siblings.map(name => readFile(join(rootPath, name), "utf8")));
    expect(await readFile(join(rootPath, path), "utf8")).toBe(outside);
    expect(recovered).toEqual([`# Note\n\nBase paragraph.${human}`]);
    expect(code).toBe(0);
    expect(closeError).toBeUndefined();
  } finally {
    editor.destroy();
    running.capture.beginShutdown();
    await running.capture.stop().catch(() => undefined);
    await running.sessions.closeAll();
    await running.daemon.stop();
  }
}, 60_000);
