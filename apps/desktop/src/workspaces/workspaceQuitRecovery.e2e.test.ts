import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { YDOC_METHOD } from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { waitForPathMoments } from "./waitForPathMoments";

const engine = requireEngineBinaryOrSkip();

it.skipIf(engine.missing).each(["quit", "workspace close"] as const)(
  "%s drains unacknowledged typing after a refused settle and recovers it once", async mode => {
    const rootPath = await createTestScratch("dohc-quit-refused-settle-");
    const workspaceId = "quit-refused-settle";
    const path = "note.md";
    const outside = "# Outside\n\nWritten by another app.\n";
    const human = "Typing that must survive teardown.";
    await writeFile(join(rootPath, path), "# Note\n\nBase paragraph.\n");
    const start = async () => {
      const daemon = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
      await daemon.start();
      const sessions = createRealDaemonWorkspaceSessions(daemon);
      const capture = createWorkspaceEngineCapture({ workspaceId, rootPath, attachmentId: Symbol("quit"),
        rustEngineSessions: sessions, settleDebounceMs: 600_000, onError: () => undefined });
      return { daemon, sessions, capture };
    };
    let running = await start();
    const editor = new Y.Doc();
    const recording = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    let journaled = false;
    try {
      await waitForPathMoments(running.capture, path, 1);
      const session = await running.capture.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate() {} });
      Y.applyUpdate(editor, session.initialUpdate);
      await writeFile(join(rootPath, path), outside);
      const client = running.daemon.currentClient();
      const send = client.sendRequest.bind(client);
      const spy = vi.spyOn(client, "sendRequest").mockImplementation(async (...args) => {
        if (args[0].method !== YDOC_METHOD.recordUpdate) return send(...args);
        recording.resolve();
        await acknowledge.promise;
        const result = await send(...args);
        journaled = true;
        return result;
      });
      const before = Y.encodeStateVector(editor);
      const paragraph = editor.getXmlFragment("body").get(1) as Y.XmlElement;
      const text = paragraph.get(0) as Y.XmlText;
      text.insert(text.length, human);
      session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
      await recording.promise;
      expect(journaled).toBe(false);
      if (mode === "quit") {
        running.capture.beginShutdown();
        running.sessions.beginShutdown();
      }
      const closing = session.close(mode === "quit" ? { shuttingDown: true } : undefined);
      const outcome = mode === "quit" ? expect(closing).resolves.toBeUndefined()
        : expect(closing).rejects.toThrow("conflict-stale-target");
      acknowledge.resolve();
      await outcome;
      expect(journaled).toBe(true);
      spy.mockRestore();
      await running.capture.stop();
      await running.sessions.closeAll();
      await running.daemon.stop();
      running = await start();
      await running.capture.flush();
      const siblings = (await readdir(rootPath)).filter(name => name.startsWith("note (recovered ") && name.endsWith(".md"));
      const recovered = await Promise.all(siblings.map(name => readFile(join(rootPath, name), "utf8")));
      expect(await readFile(join(rootPath, path), "utf8")).toBe(outside);
      expect(recovered).toEqual([`# Note\n\nBase paragraph.${human}`]);
    } finally {
      acknowledge.resolve();
      editor.destroy();
      running.capture.beginShutdown();
      await running.capture.stop().catch(() => undefined);
      await running.sessions.closeAll();
      await running.daemon.stop();
    }
  }, 60_000,
);
