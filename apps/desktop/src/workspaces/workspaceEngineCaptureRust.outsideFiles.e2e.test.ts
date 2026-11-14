import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { foldScene, insertElementRevision } from "@dohc/excalidraw-scene";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { waitForPathMoments } from "./waitForPathMoments";
import { engine, openRealCapture, writeOutside } from "./workspaceEngineCaptureRust.fixture";

it.skipIf(engine.missing)(
  "keeps a drawing's unsaved strokes when its file changed outside dohc (#2463)",
  async () => {
    const opened = await openRealCapture("drawing-outside-write", { settleDebounceMs: 60_000 });
    const scene = (elements: unknown[]) =>
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "test",
        elements,
        appState: {},
        files: {},
      });
    const stroke = {
      id: "stroke",
      x: 42,
      y: 17,
      type: "rectangle",
      version: 1,
      versionNonce: 1,
      isDeleted: false,
    };
    try {
      const absolute = join(opened.root, "drawing.excalidraw");
      await writeFile(absolute, scene([]), "utf8");
      await waitForPathMoments(opened.capture, "drawing.excalidraw", 1);
      const editor = new Y.Doc();
      const states: string[] = [];
      const changedOutside: boolean[] = [];
      const session = await opened.capture.openYDocSession({
        path: "drawing.excalidraw",
        contentKind: "scene",
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
      await vi.waitFor(
        async () =>
          expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({
            deferredWrites: ["drawing.excalidraw"],
          }),
        { timeout: REAL_DAEMON_DEADLINE_MS },
      );
      const closed = await session.close().then(
        () => null,
        (error: unknown) => error,
      );
      expect(closed).not.toBeNull();
      expect(foldScene(session.doc).elements.map((element) => element.id)).toEqual(["stroke"]);
      expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({
        deferredWrites: ["drawing.excalidraw"],
      });
      expect(changedOutside).toEqual([]);
      expect(states).not.toContain("changed-on-disk");
    } finally {
      await opened.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing)(
  "records a deferred outside write after the daemon restarts (#2463)",
  async () => {
    const opened = await openRealCapture("deferred-write-restart", { settleDebounceMs: 60_000 });
    let restarted: Awaited<ReturnType<typeof openRealCapture>> | undefined;
    try {
      await writeFile(join(opened.root, "note.md"), "base\n");
      await waitForPathMoments(opened.capture, "note.md", 1);
      await opened.capture.openYDocSession({
        path: "note.md",
        contentKind: "plaintext",
        onRemoteUpdate: () => undefined,
      });
      await writeFile(join(opened.root, "note.md"), "outside before restart\n");
      expect.soft(await opened.health()).toEqual({ newestMoment: "read", health: null });
      await opened.stopEngine();
      restarted = await openRealCapture("deferred-write-restart", {}, opened.root);
      const moments = await waitForPathMoments(restarted.capture, "note.md", 2);
      // Startup may also retain the abandoned Y.Doc as a recovery moment.
      // The outside bytes themselves must be captured exactly once.
      const texts = await Promise.all(
        moments
          .filter((moment) => moment.metadata.origin === "local-file")
          .map(async (moment) => {
            const detail = await restarted!.capture.readMoment(moment.id);
            return detail?.protected === false ? detail.moment.payload.after?.text : undefined;
          }),
      );
      expect(texts).toEqual(["outside before restart\n", "base\n"]);
      expect(await restarted.health()).toEqual({ newestMoment: "read", health: null });
      expect(await readFile(join(opened.root, "note.md"), "utf8")).toBe("outside before restart\n");
    } finally {
      await restarted?.stop();
      await opened.stop();
    }
  },
  60_000,
);
