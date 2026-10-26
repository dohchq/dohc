import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter, openEngineYdocProviderSession, type EngineTransport } from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_TEST_TIMEOUT_MS } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { createDatasetSources } from "./datasetSourceCreation";
import { flushDatasetSourceCapture } from "./datasetSourceCapture";

const engine = requireEngineBinaryOrSkip();
it.skipIf(engine.missing)("reports a held written source before verification and keeps unrelated source usable", async () => {
  const root = await createTestScratch("dohc-held-source-");
  await mkdir(join(root, "sources"));
  await writeFile(join(root, "sources/note.md"), "Original\n");
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const workspace = { workspaceId: "held-source", rootPath: root, attachmentId: Symbol("held-source") };
  await lifecycle.start();
  try {
    await sessions.run(workspace, async ({ client, workspace: handle }) => {
      const adapter = new VersionedLiveAdapter(client, handle, { workspaceId: workspace.workspaceId });
      await flushDatasetSourceCapture(adapter, new AbortController().signal);
      const document = await openEngineYdocProviderSession({ transport: client as EngineTransport, workspace: handle,
        versionId: "main", path: "sources/note.md", contentKind: "richdoc", onRemoteUpdate: () => {} });
      await document.evict();
      const unsupported = "> ".repeat(121) + "Too deep\n";
      await writeFile(join(root, "sources/note.md"), unsupported);
      const verify = vi.fn(async () => {});
      const finish = { register: async () => {}, capture: () => flushDatasetSourceCapture(adapter, new AbortController().signal, ["sources/note.md"]), verify };
      await expect(createDatasetSources(root, { "sources/note.md": unsupported }, new AbortController().signal, finish))
        .rejects.toThrow('dohc cannot use "sources/note.md" for this change. dohc cannot take in this file\'s Markdown. Causes include nested lists in workspaces that sync, or deeply nested quotes. The file on this computer still has the outside edit. Restore the file\'s exact contents from before that edit. For nested lists, make the edit in dohc after the file opens again.');
      expect(verify).not.toHaveBeenCalled();
      expect(await readFile(join(root, "sources/note.md"), "utf8")).toBe(unsupported);
      await expect(flushDatasetSourceCapture(adapter, new AbortController().signal, ["sources/note.md"])).rejects.toThrow("sources/note.md");
      await createDatasetSources(root, { "sources/schema.sql": "CREATE TABLE notes (id TEXT);\n" }, new AbortController().signal, {
        register: async () => {}, capture: () => flushDatasetSourceCapture(adapter, new AbortController().signal, ["sources/schema.sql"]), verify,
      });
      expect(verify).toHaveBeenCalledOnce();
      await writeFile(join(root, "sources/note.md"), "Repaired\n");
      await flushDatasetSourceCapture(adapter, new AbortController().signal);
    });
  } finally {
    await sessions.closeWorkspace(workspace);
    await lifecycle.stop();
  }
}, REAL_DAEMON_TEST_TIMEOUT_MS);
