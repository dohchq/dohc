import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { foldScene, insertElementRevision } from "@dohc/excalidraw-scene";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { waitForPathMoments } from "./waitForPathMoments";
import { engine, openRealCapture, writeOutside } from "./workspaceEngineCaptureRust.fixture";

// Capture keeps a note's unsaved text in History when it records an outside
// version, but has nothing that keeps a drawing's strokes. A drawing keeps its
// guarded close: the close refuses, and the strokes stay in the open drawing.
it.skipIf(engine.missing)("keeps a drawing's unsaved strokes when its file changed outside dohc (#2463)", async () => {
  const opened = await openRealCapture("drawing-outside-write", { settleDebounceMs: 60_000 });
  const scene = (elements: unknown[]) => JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements, appState: {}, files: {} });
  const stroke = { id: "stroke", x: 42, y: 17, type: "rectangle", version: 1, versionNonce: 1, isDeleted: false };
  try {
    const absolute = join(opened.root, "drawing.excalidraw");
    await writeFile(absolute, scene([]), "utf8");
    await waitForPathMoments(opened.capture, "drawing.excalidraw", 1);
    const editor = new Y.Doc();
    const states: string[] = [];
    const changedOutside: boolean[] = [];
    const session = await opened.capture.openYDocSession({
      path: "drawing.excalidraw", contentKind: "scene",
      onRemoteUpdate: (update) => Y.applyUpdate(editor, update),
      onSaveState: (state) => states.push(state),
      onChangedOutside: (unsaved) => changedOutside.push(unsaved),
    });
    Y.applyUpdate(editor, session.initialUpdate);
    await new Promise<void>((armed) => {
      const vector = Y.encodeStateVector(editor);
      insertElementRevision(editor, stroke);
      session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, vector), armed);
    });
    await writeOutside(absolute, scene([{ ...stroke, id: "outside" }]), "rename");
    opened.capture.start();
    await vi.waitFor(async () => expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ deferredWrites: ["drawing.excalidraw"] }), { timeout: REAL_DAEMON_DEADLINE_MS });
    const closed = await session.close().then(() => null, (error: unknown) => error);
    // The close stays refused, and the lease stays held with the strokes.
    expect(closed).not.toBeNull();
    expect(foldScene(session.doc).elements.map((element) => element.id)).toEqual(["stroke"]);
    expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ deferredWrites: ["drawing.excalidraw"] });
    // The drawing has no notice, and its chip promises nothing about History.
    expect(changedOutside).toEqual([]);
    expect(states).not.toContain("changed-on-disk");
  } finally {
    await opened.stop();
  }
}, 60_000);

it.skipIf(engine.missing)("keeps two open files' outside writes independent (#2463)", async () => {
  const opened = await openRealCapture("two-deferred-writes", { settleDebounceMs: 60_000 });
  try {
    const sessions = [];
    for (const path of ["first.md", "second.md"]) {
      await writeFile(join(opened.root, path), "base\n");
      await waitForPathMoments(opened.capture, path, 1);
      sessions.push(await opened.capture.openYDocSession({ path, contentKind: "plaintext", onRemoteUpdate: () => undefined }));
      await writeFile(join(opened.root, path), `outside ${path}\n`);
      expect.soft(await opened.health()).toEqual({ newestMoment: "read", health: null });
    }
    expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ deferredWrites: ["first.md", "second.md"] });
    await sessions[1]!.close().catch(() => undefined);
    await waitForPathMoments(opened.capture, "second.md", 2);
    expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: ["first.md"] });
    await sessions[0]!.close().catch(() => undefined);
    await waitForPathMoments(opened.capture, "first.md", 2);
    expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: [] });
  } finally { await opened.stop(); }
}, 60_000);

it.skipIf(engine.missing)("records a deferred outside write after the daemon restarts (#2463)", async () => {
  const opened = await openRealCapture("deferred-write-restart", { settleDebounceMs: 60_000 });
  let restarted: Awaited<ReturnType<typeof openRealCapture>> | undefined;
  try {
    await writeFile(join(opened.root, "note.md"), "base\n");
    await waitForPathMoments(opened.capture, "note.md", 1);
    await opened.capture.openYDocSession({ path: "note.md", contentKind: "plaintext", onRemoteUpdate: () => undefined });
    await writeFile(join(opened.root, "note.md"), "outside before restart\n");
    expect.soft(await opened.health()).toEqual({ newestMoment: "read", health: null });
    // Stop the daemon without closing or settling the document session.
    await opened.stopEngine();
    restarted = await openRealCapture("deferred-write-restart", {}, opened.root);
    const moments = await waitForPathMoments(restarted.capture, "note.md", 2);
    // Startup may also retain the abandoned Y.Doc as a recovery moment.
    // The outside bytes themselves must be captured exactly once.
    const texts = await Promise.all(moments.filter((moment) => moment.metadata.origin === "local-file").map(async (moment) => {
      const detail = await restarted!.capture.readMoment(moment.id);
      return detail?.protected === false ? detail.moment.payload.after?.text : undefined;
    }));
    expect(texts).toEqual(["outside before restart\n", "base\n"]);
    expect(await restarted.health()).toEqual({ newestMoment: "read", health: null });
    expect(await readFile(join(opened.root, "note.md"), "utf8")).toBe("outside before restart\n");
  } finally {
    await restarted?.stop();
    await opened.stop();
  }
}, 60_000);

it.skipIf(engine.missing)("keeps an outside write when a rename rewrites the open note's links (#2463)", async () => {
  const opened = await openRealCapture("deferred-write-rename", { settleDebounceMs: 60_000 });
  const outside = "agent text [[old]]\n";
  try {
    await writeFile(join(opened.root, "old.md"), "target\n");
    await writeFile(join(opened.root, "note.md"), "[[old]]\n");
    await waitForPathMoments(opened.capture, "old.md", 1);
    await waitForPathMoments(opened.capture, "note.md", 1);
    const session = await opened.capture.openYDocSession({ path: "note.md", contentKind: "richdoc", onRemoteUpdate: () => undefined });
    await writeFile(join(opened.root, "note.md"), outside);
    expect.soft(await opened.health()).toEqual({ newestMoment: "read", health: null });
    const operationId = "dohc-operation:deferred-rename";
    await opened.withEngine(async (engine) => {
      const hold = await engine.holdCapture({ operationId });
      try {
        await engine.renameTextFile({ workspaceId: opened.workspaceId, versionId: "main",
          fromPath: "old.md", toPath: "new.md", captureHoldId: hold.holdId, metadata: { origin: "api" } });
        await rename(join(opened.root, "old.md"), join(opened.root, "new.md"));
      } finally { await engine.releaseCapture(hold.holdId); }
    });
    const rewritten = await opened.withEngine((engine) => engine.rewriteHistoryLinks({ workspaceId: opened.workspaceId, operationId, requestId: "rewrite-deferred" }));
    expect(rewritten).toMatchObject({ documents: 0, complete: false, unchecked: ["note.md"] });
    expect(await readFile(join(opened.root, "note.md"), "utf8")).toBe(outside);
    await session.close().catch(() => undefined);
    await vi.waitFor(async () => {
      expect(await readFile(join(opened.root, "note.md"), "utf8")).toBe("agent text [[new]]\n");
    }, { timeout: REAL_DAEMON_DEADLINE_MS });
    const completed = await opened.withEngine((engine) => engine.rewriteHistoryLinks({ workspaceId: opened.workspaceId, operationId, requestId: "rewrite-deferred" }));
    expect(completed).toMatchObject({ documents: 1, complete: true, unchecked: [] });
    expect((await readdir(opened.root)).filter((path) => path.includes(".conflict"))).toEqual([]);
    const undone = await opened.withEngine((engine) => engine.undoHistoryOperation({ workspaceId: opened.workspaceId, operationId: operationId!, requestId: "undo-deferred" }));
    expect(undone.notRestored).not.toContain("note.md");
    await vi.waitFor(async () => {
      expect(await readFile(join(opened.root, "note.md"), "utf8")).toBe(outside);
    }, { timeout: REAL_DAEMON_DEADLINE_MS });
    await vi.waitFor(async () => {
      const moments = await opened.capture.listMoments({ limit: 100 });
      const note = moments.moments.filter((moment) => moment.path === "note.md");
      const texts = await Promise.all(note.map(async (moment) => {
        const detail = await opened.capture.readMoment(moment.id);
        return detail?.protected === false ? detail.moment.payload.after?.text : undefined;
      }));
      expect(texts).toContain(outside);
    }, { timeout: REAL_DAEMON_DEADLINE_MS });
  } finally { await opened.stop(); }
}, 60_000);
