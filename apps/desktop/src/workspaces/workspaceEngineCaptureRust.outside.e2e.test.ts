import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { foldScene, insertElementRevision } from "@dohc/excalidraw-scene";
import { isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";
import { createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture, isYDocOutsideWriteWaitingError } from "./workspaceEngineCapture";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { engine, openRealCapture, writeOutside, openNote, RECOVERED_COPY } from "./workspaceEngineCaptureRust.fixture";

it.skipIf(engine.missing)(
  "captures an outside rename write into an open document without pausing History (#2463)",
  async () => {
    const opened = await openRealCapture("outside-write-rename", { settleDebounceMs: 60_000 });
    const editor = new Y.Doc();
    const base = "base\n";
    const outside = "written outside dohc\n";
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, base, "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      const session = await opened.capture.openYDocSession({
        path: "note.md", contentKind: "plaintext",
        onRemoteUpdate: (update) => Y.applyUpdate(editor, update),
      });
      Y.applyUpdate(editor, session.initialUpdate);
      expect(editor.getText("plainText").toString()).toBe(base);

      const temporary = join(opened.root, "note.md.tmp");
      await writeFile(temporary, outside, "utf8");
      await rename(temporary, absolute);

      // Part (a) keeps this editor unchanged. Part (b) takes in the edit.
      expect.soft(await opened.health()).toEqual({ newestMoment: "read", health: null });
      expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ deferredWrites: ["note.md"] });
      expect(await opened.withEngine((engine) => engine.flushCapture())).toMatchObject({ settled: true, deferredWrites: ["note.md"] });
      expect(await opened.withEngine((engine) => engine.reconcileCapture())).toMatchObject({ degraded: false, deferredWrites: ["note.md"] });
      expect(await opened.health()).toEqual({ newestMoment: "read", health: null });
      await writeFile(join(opened.root, "other.md"), "other file\n");
      await waitForPathMoments(opened.capture, "other.md", 1);
      await opened.withEngine(async (engine) => {
        const operationId = "dohc-operation:other-during-rename";
        const hold = await engine.holdCapture({ operationId });
        try {
          await engine.renameTextFile({ workspaceId: opened.workspaceId, versionId: "main",
            fromPath: "other.md", toPath: "moved.md", captureHoldId: hold.holdId, metadata: { origin: "api" } });
          await rename(join(opened.root, "other.md"), join(opened.root, "moved.md"));
        } finally { await engine.releaseCapture(hold.holdId); }
        await engine.undoHistoryOperation({ workspaceId: opened.workspaceId, operationId, requestId: "undo-other-rename" });
        expect(await engine.watcherStatus()).toMatchObject({ deferredWrites: ["note.md"] });
      });
      expect.soft(await readFile(absolute, "utf8")).toBe(outside);
      // A refused pre-close save must still release the session's lease.
      await session.close().catch(() => undefined);
      await waitForPathMoments(opened.capture, "note.md", 2);
      const history = await opened.capture.listMoments({ limit: 100 }).then(async (page) =>
        Promise.all(page.moments.filter((moment) => moment.path === "note.md").map(async (moment) => {
          const detail = await opened.capture.readMoment(moment.id);
          return detail?.protected === false ? detail.moment.payload.after?.text : undefined;
        })),
      (error: unknown) => isWorkspaceUpdatingRefusal(error) ? "still updating" : Promise.reject(error));
      expect.soft(history).toEqual([outside, base]);
      expect.soft(await readFile(absolute, "utf8")).toBe(outside);
      expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: [] });
    } finally {
      await opened.stop();
      editor.destroy();
    }
  },
  60_000,
);

it.skipIf(engine.missing)(
  "reloads an open note with nothing unsaved after an in-place write outside dohc (#2463)",
  async () => {
    const opened = await openRealCapture("reload-untouched-in-place", { settleDebounceMs: 60_000 });
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      const note = await openNote(opened.capture);
      await writeOutside(absolute, "written outside dohc\n", "in-place");
      opened.capture.start();
      await vi.waitFor(() => expect(note.changedOutside).toEqual([false]), { timeout: REAL_DAEMON_DEADLINE_MS });
      const reported = note.states.length;
      // The editor reopens by itself: its close saves nothing and answers
      // once capture recorded the disk version.
      await note.session.close();
      expect(note.states.slice(reported)).not.toContain("error");
      const reopened = await openNote(opened.capture);
      expect(reopened.text()).toBe("written outside dohc\n");
      await reopened.session.close();
      expect(await readdir(opened.root)).toEqual([".dohc", "note.md"]);
      expect(await readFile(absolute, "utf8")).toBe("written outside dohc\n");
      expect(await opened.health()).toEqual({ newestMoment: "read", health: null });
      expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: [] });
    } finally {
      await opened.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing).each([
  ["person", "reload", "rename"], ["agent", "close", "in-place"],
] as const)(
  "keeps the %s's unsaved edit in a copy on %s after a %s write outside dohc (#2463)",
  async (author, action, style) => {
    const opened = await openRealCapture(`reload-unsaved-${author}-${action}-${style}`, { settleDebounceMs: 60_000 });
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      const note = await openNote(opened.capture);
      note.type("typed ", author);
      await writeOutside(absolute, "written outside dohc\n", style);
      opened.capture.start();
      await vi.waitFor(() => expect(note.changedOutside).toEqual([true]), { timeout: REAL_DAEMON_DEADLINE_MS });
      // The editor keeps the person's text until they act.
      expect(note.text()).toBe("typed base\n");
      // Reload closes the session and opens it again. Closing the note is
      // the same close without the reopen.
      await note.session.close();
      if (action === "reload") {
        const reopened = await openNote(opened.capture);
        expect(reopened.text()).toBe("written outside dohc\n");
        await reopened.session.close();
      }
      expect(await readFile(absolute, "utf8")).toBe("written outside dohc\n");
      const copies = (await readdir(opened.root)).filter((name) => RECOVERED_COPY.test(name));
      expect(copies).toHaveLength(1);
      expect(await readFile(join(opened.root, copies[0]!), "utf8")).toBe("typed base\n");
      expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: [] });
    } finally {
      await opened.stop();
    }
  },
  60_000,
);

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
