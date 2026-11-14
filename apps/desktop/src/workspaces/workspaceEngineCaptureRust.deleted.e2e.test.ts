import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { engine, openDeletedDocument } from "./workspaceEngineCaptureRust.fixture";

it.skipIf(engine.missing)(
  "saves a deleted file again after its tab closed, and the close finishes",
  async () => {
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
  },
  60_000,
);

it.skipIf(engine.missing).each(["quit"] as const)(
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
        await expect(deleted.capture.settleAndCloseAllLiveSessions()).rejects.toThrow(
          "conflict-stale-target",
        );
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
