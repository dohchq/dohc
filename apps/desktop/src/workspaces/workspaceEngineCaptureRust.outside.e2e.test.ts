import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
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
