import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { waitForPathMoments } from "./waitForPathMoments";
import {
  engine,
  openRealCapture,
  writeOutside,
  openNote,
} from "./workspaceEngineCaptureRust.fixture";

it.skipIf(engine.missing)(
  "treats unsettled text a reopened note starts with as unsaved (#2463)",
  async () => {
    const opened = await openRealCapture("reload-unsettled-restart", { settleDebounceMs: 60_000 });
    let restarted: Awaited<ReturnType<typeof openRealCapture>> | undefined;
    let releaseSettle = (): void => undefined;
    const settleGate = new Promise<void>((resolve) => {
      releaseSettle = resolve;
    });
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
      restarted = await openRealCapture(
        "reload-unsettled-restart",
        { settleDebounceMs: 60_000, openSettleGate: () => settleGate },
        opened.root,
      );
      const reopened = await openNote(restarted.capture);
      expect(reopened.text()).toBe("typed base\n");
      await writeOutside(absolute, "written outside dohc\n", "rename");
      restarted.capture.start();
      await vi.waitFor(() => expect(reopened.changedOutside).toEqual([true]), {
        timeout: REAL_DAEMON_DEADLINE_MS,
      });
      releaseSettle();
      await reopened.session.close();
      expect(await readFile(absolute, "utf8")).toBe("written outside dohc\n");
    } finally {
      releaseSettle();
      await restarted?.stop();
      await opened.stop();
    }
  },
  60_000,
);
