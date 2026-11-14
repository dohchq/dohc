import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { waitForPathMoments } from "./waitForPathMoments";
import {
  engine,
  openRealCapture,
  writeOutside,
  openNote,
  RECOVERED_COPY,
} from "./workspaceEngineCaptureRust.fixture";

it.skipIf(engine.missing).each([["person", "reload", "rename"]] as const)(
  "keeps the %s's unsaved edit in a copy on %s after a %s write outside dohc (#2463)",
  async (author, action, style) => {
    const opened = await openRealCapture(`reload-unsaved-${author}-${action}-${style}`, {
      settleDebounceMs: 60_000,
    });
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      const note = await openNote(opened.capture);
      note.type("typed ", author);
      await writeOutside(absolute, "written outside dohc\n", style);
      opened.capture.start();
      await vi.waitFor(() => expect(note.changedOutside).toEqual([true]), {
        timeout: REAL_DAEMON_DEADLINE_MS,
      });
      expect(note.text()).toBe("typed base\n");
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
      expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({
        degraded: false,
        deferredWrites: [],
      });
    } finally {
      await opened.stop();
    }
  },
  60_000,
);
