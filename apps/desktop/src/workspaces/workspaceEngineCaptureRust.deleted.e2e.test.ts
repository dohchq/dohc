import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { listLiveDraftRecovery, workspaceDraftStore } from "./liveDraftRecovery";
import { waitForPathMoments } from "./waitForPathMoments";
import { createWorkspaceEngineCapture, engine, NO_WINDOWS, openRealCapture, openDeletedDocument } from "./workspaceEngineCaptureRust.fixture";

// dohc#2342. Capture leaves a deleted file's head alone while its document
// is open, because that document still holds it. Capture is waiting, not
// failing: the person already has the save notice with Save it again, so
// History stays readable and capture reads as healthy.
it.skipIf(engine.missing).each(["recorded", "new"] as const)(
  "reports no capture or History failure while a %s file deleted outside dohc is open",
  async (shape) => {
    const deleted = await openDeletedDocument(shape);
    try {
      expect(await deleted.health()).toEqual({ newestMoment: "read", health: null });
      // The save notice stays: the next save is refused the same way.
      deleted.type("more\n");
      await expect(deleted.session.settleNow()).rejects.toThrow("conflict-stale-target");
      expect(existsSync(deleted.absolute)).toBe(false);
    } finally {
      await deleted.stop();
    }
  },
  60_000,
);

// The wait ends with the document: once it closes, History records the delete.
// History already holds all of the document, so the close is no failed save
// and sets nothing aside (dohc#2366).
it.skipIf(engine.missing).each(["no edit", "an edit saved before the delete"] as const)(
  "records a file deleted outside dohc once its document closes, with %s and no failed save",
  async (edit) => {
    const workspaceId = `deleted-file-closed-${edit === "no edit" ? "unedited" : "saved"}`;
    const draftStore = await createTestScratch("dohc-deleted-file-closed-drafts-");
    const store = workspaceDraftStore(draftStore, workspaceId, NO_WINDOWS);
    const opened = await openRealCapture(workspaceId, {
      settleDebounceMs: 60_000, preserveUnsentState: store.preserveUnsentState, discardUnsentState: store.discardUnsentState,
    });
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      const states: string[] = [];
      const session = await opened.capture.openYDocSession({
        path: "note.md", contentKind: "plaintext", onRemoteUpdate: () => undefined, onSaveState: (state) => states.push(state),
      });
      const writes = edit === "no edit" ? ["write"] : ["write", "write"];
      if (edit !== "no edit") {
        const editor = new Y.Doc();
        Y.applyUpdate(editor, session.initialUpdate);
        const before = Y.encodeStateVector(editor);
        editor.getText("plainText").insert(0, "saved\n");
        await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
        await session.settleNow();
        await waitForPathMoments(opened.capture, "note.md", 2);
      }
      await rm(absolute);
      opened.capture.observeFileEvents([{ path: "note.md", operation: "delete" }]);
      expect(await opened.health()).toEqual({ newestMoment: "read", health: null });
      const before = await waitForPathMoments(opened.capture, "note.md", writes.length);
      expect(before.map((moment) => moment.operation)).toEqual(writes);

      await expect(session.close()).resolves.toBeUndefined();
      const after = await waitForPathMoments(opened.capture, "note.md", writes.length + 1);
      expect(after.map((moment) => moment.operation)).toEqual(["delete", ...writes]);
      expect(existsSync(absolute)).toBe(false);
      expect(states).not.toContain("error");
      expect(await listLiveDraftRecovery(draftStore, workspaceId)).toEqual([]);
    } finally {
      await opened.stop();
    }
  },
  60_000,
);

// A folder capture cannot read is a real failure, so both workspace notices
// still come, also while a deleted file's document is open.
it.skipIf(engine.missing).each(["no document", "a deleted file's document"] as const)(
  "still reports a folder capture cannot read, with %s open",
  async (open) => {
    const opened = open === "no document" ? await openRealCapture("unreadable-folder") : await openDeletedDocument("recorded");
    const locked = join(opened.root, "locked");
    try {
      await mkdir(locked);
      await writeFile(join(locked, "note.md"), "Out of reach.\n");
      await chmod(locked, 0o000);
      // Root reads any folder, so there this fixture cannot fail capture.
      if (await readdir(locked).then(() => true, () => false)) return;
      expect(await opened.health()).toEqual({ newestMoment: "still updating", health: "other" });
    } finally {
      await chmod(locked, 0o755).catch(() => undefined);
      await opened.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing).each(["recorded", "new"] as const)(
  "saves a %s file deleted outside dohc again only when the person asks",
  async (shape) => {
    const deleted = await openDeletedDocument(shape);
    try {
      // Try again repeats the save, and the engine refuses it the same way.
      // The draft takes the newest text.
      deleted.type("more\n");
      await expect(deleted.session.settleNow()).rejects.toThrow("conflict-stale-target");
      expect(existsSync(deleted.absolute)).toBe(false);
      await vi.waitFor(async () => expect(await deleted.drafts()).toEqual([`note.md: ${deleted.text()}`]));

      await expect(deleted.capture.saveDeletedFileAgain("note.md")).resolves.toBe(true);
      expect(await readFile(deleted.absolute, "utf8")).toBe(deleted.text());
      expect(deleted.states.at(-1)).toBe("saved");
      await vi.waitFor(async () => expect(await deleted.drafts()).toEqual([]));

      deleted.type("later\n");
      await deleted.session.settleNow();
      expect(await readFile(deleted.absolute, "utf8")).toBe(deleted.text());
      await expect(deleted.session.close()).resolves.toBeUndefined();
      expect(await deleted.drafts()).toEqual([]);
    } finally {
      await deleted.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing)("saves a deleted file again after its tab closed, and the close finishes", async () => {
  const deleted = await openDeletedDocument("recorded");
  try {
    // The close is refused, so the session keeps the text, nothing is
    // written, and the draft stays.
    await expect(deleted.session.close()).rejects.toThrow("conflict-stale-target");
    expect(existsSync(deleted.absolute)).toBe(false);
    expect(await deleted.drafts()).toEqual(["note.md: unsaved\nsaved\nbase\n"]);

    await expect(deleted.capture.saveDeletedFileAgain("note.md")).resolves.toBe(true);
    expect(await readFile(deleted.absolute, "utf8")).toBe("unsaved\nsaved\nbase\n");
    await expect(deleted.session.close()).resolves.toBeUndefined();
    await vi.waitFor(async () => expect(await deleted.drafts()).toEqual([]));

    // Nothing holds the document now, so nothing more is written.
    await rm(deleted.absolute);
    await expect(deleted.capture.saveDeletedFileAgain("note.md")).resolves.toBe(false);
    expect(existsSync(deleted.absolute)).toBe(false);
  } finally {
    await deleted.stop();
  }
}, 60_000);

it.skipIf(engine.missing)("removes a replaced draft the store first refused to remove, by the time the session ends", async () => {
  const deleted = await openDeletedDocument("recorded", 1);
  try {
    deleted.type("more\n");
    await expect(deleted.session.settleNow()).rejects.toThrow("conflict-stale-target");
    // The newer draft is written, and the older one stays until a removal works.
    await vi.waitFor(async () => expect(await deleted.drafts()).toHaveLength(2));
    await expect(deleted.session.close()).rejects.toThrow("conflict-stale-target");
    expect(await deleted.drafts()).toEqual([`note.md: ${deleted.text()}`]);
  } finally {
    await deleted.stop();
  }
}, 60_000);

it.skipIf(engine.missing).each(["workspace close", "quit"] as const)(
  "keeps the draft of a deleted file through a %s, and does not write the file",
  async (ending) => {
    const deleted = await openDeletedDocument("recorded");
    try {
      deleted.type("last\n");
      const newest = ["note.md: last\nunsaved\nsaved\nbase\n"];
      if (ending === "quit") {
        deleted.capture.beginShutdown();
        await deleted.session.close({ shuttingDown: true }).catch(() => undefined);
        // The app exits right after a quit, so the close itself waits for
        // the draft its refused save sets aside.
        expect(await deleted.drafts()).toEqual(newest);
      } else {
        await expect(deleted.capture.settleAndCloseAllLiveSessions()).rejects.toThrow("conflict-stale-target");
        await vi.waitFor(async () => expect(await deleted.drafts()).toEqual(newest));
      }
      // Releasing the session lets capture retire the path. The draft stays.
      await deleted.capture.stop();
      await deleted.sessions.closeAll();
      expect(await deleted.drafts()).toEqual(newest);
      expect(existsSync(deleted.absolute)).toBe(false);
    } finally {
      await deleted.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing)("sets nothing aside for a document whose saves are not refused over a deleted file", async () => {
  const root = await createTestScratch("dohc-no-draft-");
  const draftStore = await createTestScratch("dohc-no-draft-drafts-");
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const store = workspaceDraftStore(draftStore, "no-draft", NO_WINDOWS);
  const preserve = vi.fn(store.preserveUnsentState);
  const capture = createWorkspaceEngineCapture({
    workspaceId: "no-draft", rootPath: root, rustEngineSessions: sessions, settleDebounceMs: 60_000, onError: () => undefined,
    preserveUnsentState: preserve, discardUnsentState: store.discardUnsentState,
  });
  try {
    await writeFile(join(root, "note.md"), "base\n", "utf8");
    await waitForPathMoments(capture, "note.md", 1);
    const session = await capture.openYDocSession({ path: "note.md", contentKind: "plaintext", onRemoteUpdate: () => undefined });
    const editor = new Y.Doc();
    Y.applyUpdate(editor, session.initialUpdate);
    const type = (text: string) => {
      const before = Y.encodeStateVector(editor);
      editor.getText("plainText").insert(0, text);
      session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
    };
    type("saved\n");
    await session.settleNow();
    // A save refused because the file changed outside dohc leaves the text
    // in History, and the file is there to open.
    await writeFile(join(root, "note.md"), "outside\n", "utf8");
    type("typed\n");
    await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
    await session.close().catch(() => undefined);
    await capture.stop();
    expect(preserve).not.toHaveBeenCalled();
    expect(await listLiveDraftRecovery(draftStore, "no-draft")).toEqual([]);
  } finally {
    await capture.stop().catch(() => undefined);
    await sessions.closeAll().catch(() => undefined);
    await lifecycle.stop().catch(() => undefined);
  }
}, 60_000);
