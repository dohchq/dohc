import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";

const engine = requireEngineBinaryOrSkip();

it.skipIf(engine.missing)("restart capture preserves outside text and displaced typing in restorable History", async () => {
  const rootPath = await createTestScratch("dohc-restart-capture-");
  const workspaceId = "restart-capture";
  const file = join(rootPath, "note.md");
  await writeFile(file, "base\n");
  const start = async () => {
    const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({ workspaceId, rootPath, attachmentId: Symbol("recovery"),
      rustEngineSessions: sessions, settleDebounceMs: 600_000, onError: () => undefined });
    return { lifecycle, sessions, capture };
  };
  let running = await start();
  const editor = new Y.Doc();
  try {
    await waitForPathMoments(running.capture, "note.md", 1);
    const session = await running.capture.openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined });
    Y.applyUpdate(editor, session.initialUpdate);
    await writeFile(file, "outside\n");
    const before = Y.encodeStateVector(editor);
    editor.getText("plainText").insert(0, "human\n");
    await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
    await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
    running.capture.beginShutdown();
    running.sessions.beginShutdown();
    await session.close({ shuttingDown: true }).catch(() => undefined);
    await running.capture.stop();
    await running.sessions.closeAll();
    await running.lifecycle.stop();
    running = await start();
    const history = await waitForPathMoments(running.capture, "note.md", 3);
    const recovery = history.find(moment => moment.metadata.origin === "capture-recovery");
    expect(recovery, "the native typing has a committed recovery preimage").toBeDefined();
    const detail = await running.capture.readMoment(recovery!.id);
    expect(detail?.protected).toBe(false);
    if (!detail || detail.protected) throw new Error("recovery must have a readable payload");
    expect(detail.moment.payload.before?.text).toBe("human\nbase\n");
    expect(detail.moment.payload.after?.text).toBe("outside\n");
    expect(await readFile(file, "utf8")).toBe("outside\n");
    const outside = history.find(moment => moment.id === recovery!.metadata.correlationId);
    expect(outside).toBeDefined();
    expect(outside!.momentOrder).toBeLessThan(recovery!.momentOrder);
    await running.capture.restoreFileToBeforeMoment(recovery!.id, {kind: "human", humanId: "person"});
    expect(await readFile(file, "utf8")).toBe("human\nbase\n");
    const reopened = await running.capture.openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined });
    const restored = new Y.Doc();
    Y.applyUpdate(restored, reopened.initialUpdate);
    try { expect(restored.getText("plainText").toString()).toBe("human\nbase\n"); }
    finally { restored.destroy(); await reopened.close(); }
  } finally {
    editor.destroy();
    running.capture.beginShutdown();
    await running.capture.stop().catch(() => undefined);
    await running.sessions.closeAll();
    await running.lifecycle.stop();
  }
}, 60_000);
