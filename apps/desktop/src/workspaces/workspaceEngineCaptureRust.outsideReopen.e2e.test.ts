import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture, isYDocOutsideWriteWaitingError } from "./workspaceEngineCapture";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { engine, openRealCapture, writeOutside, openNote } from "./workspaceEngineCaptureRust.fixture";

it.skipIf(engine.missing)("treats unsettled text a reopened note starts with as unsaved (#2463)", async () => {
  const opened = await openRealCapture("reload-unsettled-restart", { settleDebounceMs: 60_000 });
  let restarted: Awaited<ReturnType<typeof openRealCapture>> | undefined;
  let releaseSettle = (): void => undefined;
  const settleGate = new Promise<void>((resolve) => { releaseSettle = resolve; });
  try {
    const absolute = join(opened.root, "note.md");
    await writeFile(absolute, "base\n", "utf8");
    await waitForPathMoments(opened.capture, "note.md", 1);
    const note = await openNote(opened.capture);
    await new Promise<void>((armed) => {
      const vector = Y.encodeStateVector(note.editor);
      note.editor.getText("plainText").insert(0, "typed ");
      note.session.applyLocalUpdate(Y.encodeStateAsUpdate(note.editor, vector), armed);
    });
    // Stop the daemon before any save, then open the note again. Its save of
    // the text it starts with waits, so an outside write arrives first.
    await opened.stopEngine();
    restarted = await openRealCapture("reload-unsettled-restart", { settleDebounceMs: 60_000, openSettleGate: () => settleGate }, opened.root);
    const reopened = await openNote(restarted.capture);
    expect(reopened.text()).toBe("typed base\n");
    await writeOutside(absolute, "written outside dohc\n", "rename");
    restarted.capture.start();
    await vi.waitFor(() => expect(reopened.changedOutside).toEqual([true]), { timeout: REAL_DAEMON_DEADLINE_MS });
    releaseSettle();
    await reopened.session.close();
    expect(await readFile(absolute, "utf8")).toBe("written outside dohc\n");
  } finally {
    releaseSettle();
    await restarted?.stop();
    await opened.stop();
  }
}, 60_000);

it.skipIf(engine.missing)("does not open a note again until capture records its outside version (#2463)", async () => {
  const root = await createTestScratch("dohc-capture-unrecorded-");
  const workspace = { workspaceId: "capture-unrecorded", rootPath: root, attachmentId: Symbol("capture-unrecorded") };
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  // Capture that does not record the outside version: its status keeps the
  // path waiting. Its flush can also fail.
  let captureRecords = false;
  let flushFails = false;
  const live = createCaptureLiveStores(workspace, sessions).store;
  const store = new Proxy(live, {
    get(target, property) {
      if (property === "watcherStatus") {
        return async () => {
          const status = await target.watcherStatus!();
          return captureRecords ? status : { ...status, deferredWrites: [...new Set([...status.deferredWrites, "note.md"])] };
        };
      }
      if (property === "flushCapture") {
        return async () => {
          if (flushFails) throw new Error("capture did not settle");
          await target.flushCapture!();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const errors: string[] = [];
  const capture = createAttachedWorkspaceEngineCapture({
    ...workspace, rustEngineSessions: sessions, store, settleDebounceMs: 60_000,
    onError: (context) => errors.push(context),
  });
  try {
    const absolute = join(root, "note.md");
    await writeFile(absolute, "base\n", "utf8");
    await waitForPathMoments(capture, "note.md", 1);
    const note = await openNote(capture);
    await writeOutside(absolute, "written outside dohc\n", "rename");
    capture.start();
    await vi.waitFor(() => expect(note.changedOutside).toEqual([false]), { timeout: REAL_DAEMON_DEADLINE_MS });
    // The close waits for capture, then says it could not record the change.
    await note.session.close();
    expect(errors).toContain("capture of note.md after its close");
    // Opening again would take the file back and show the old version.
    const refusal = await openNote(capture).then(() => null, (error: unknown) => error);
    expect(isYDocOutsideWriteWaitingError(refusal)).toBe(true);
    // A check that fails proves nothing either: the open still waits, and
    // says why.
    flushFails = true;
    const failedCheck = await openNote(capture).then(() => null, (error: unknown) => error);
    expect(isYDocOutsideWriteWaitingError(failedCheck)).toBe(true);
    expect(String((failedCheck as Error).cause)).toContain("capture did not settle");
    flushFails = false;
    // Once capture records it, the note opens on the disk version.
    captureRecords = true;
    const reopened = await openNote(capture);
    expect(reopened.text()).toBe("written outside dohc\n");
    await reopened.session.close();
  } finally {
    await capture.stop().catch(() => undefined);
    await sessions.closeAll().catch(() => undefined);
    await lifecycle.stop().catch(() => undefined);
  }
}, 60_000);

