import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  VersionedLiveAdapter,
  YdocLiveAdapter,
  type EngineTransport,
} from "@dohc/workspace-engine-client";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
  REAL_DAEMON_DEADLINE_MS,
  REAL_DAEMON_TEST_TIMEOUT_MS,
} from "../testing/realDaemonWorkspaceSessions";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createTestScratch } from "./testTemp";

// #1045. Row height lives only on the Y.Doc. A settled local close prunes
// that state, and the next open reseeds from the Markdown file, so the file
// itself has to carry the height. This drives the daemon's real open, record,
// settle, close, and reopen path: no Electron, no pointer, no timing.
const engine = requireEngineBinaryOrSkip();
const daemonWork = { timeout: REAL_DAEMON_DEADLINE_MS };
const WORKSPACE_ID = "ydoc-table-row-height";
const PATH = "table.md";
const TABLE = [
  "| Metric | Value |",
  "| ------ | ----- |",
  "| apples | 10    |",
  "| pears  | 4     |",
].join("\n");

function tableRow(doc: Y.Doc, index: number): Y.XmlElement {
  const table = doc
    .getXmlFragment("body")
    .toArray()
    .find((node) => node instanceof Y.XmlElement && node.nodeName === "table");
  const row = table instanceof Y.XmlElement ? table.get(index) : null;
  if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow") {
    throw new Error(`The document has no table row ${index}.`);
  }
  return row;
}

it("keeps a resized row and an external cell edit across a settled close and reopen", async () => {
  const root = await createTestScratch("dohc-ydoc-table-row-height-");
  const lifecycle = createRealDaemonLifecycle({
    command: engine.require(),
    maxRestarts: 0,
  });
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const workspace = {
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    attachmentId: Symbol("test-workspace-attachment"),
  };
  const capture = createWorkspaceEngineCapture({
    ...workspace,
    rustEngineSessions: sessions,
  });
  const file = join(root, PATH);
  // The daemon's own watcher ingests disk writes; a flush covers only the
  // changes it has already noticed, so wait for the head itself.
  const headText = (versionId: string) =>
    sessions.run(workspace, async (binding) => {
      await capture.flush();
      const head = await new VersionedLiveAdapter(binding.client, binding.workspace, {
        workspaceId: WORKSPACE_ID,
      }).readTextFile({ workspaceId: WORKSPACE_ID, versionId, path: PATH });
      return head?.contentKind === "text" ? head.text : null;
    });
  try {
    const original = `# Sizes\n\n${TABLE}\n`;
    await writeFile(file, original, "utf8");
    await capture.flush();
    const versionId = (await capture.listVersions()).activeVersionId;
    await expect.poll(() => headText(versionId), daemonWork).toBe(original);
    const settled = `# Sizes\n\n<!-- dohc:table row-heights=1:84 -->\n${TABLE}`;

    await sessions.run(workspace, async (binding) => {
      const adapter = new YdocLiveAdapter(binding.client as EngineTransport);
      const session = await adapter.openSession({
        workspace: binding.workspace,
        versionId,
        path: PATH,
        contentKind: "richdoc",
      });
      await session.applyLocalEdit((doc) => {
        tableRow(doc, 1).setAttribute("height", 84 as unknown as string);
      });
      // The desktop settles a while after an edit and closes later. A close
      // whose settle is still landing on disk keeps the lineage instead.
      await session.settle();
      await expect.poll(() => readFile(file, "utf8"), daemonWork).toBe(settled);
      await session.close();
      adapter.dispose();
    });

    // Somebody edits the closed file outside dohc and keeps the comment.
    const edited = settled.replace("apples", "plums ");
    await writeFile(file, edited, "utf8");
    await expect.poll(() => headText(versionId), daemonWork).toBe(edited);

    await sessions.run(workspace, async (binding) => {
      const adapter = new YdocLiveAdapter(binding.client as EngineTransport);
      const session = await adapter.openSession({
        workspace: binding.workspace,
        versionId,
        path: PATH,
        contentKind: "richdoc",
      });
      try {
        // The close pruned the lineage, so this open reseeded from the file:
        // the outside edit is here, and so is the height.
        expect(yDocToMarkdown(session.doc)).toBe(edited);
        expect(tableRow(session.doc, 1).getAttribute("height")).toBe(84);
      } finally {
        await session.evict();
        adapter.dispose();
      }
    });
  } finally {
    await capture.stop().catch(() => undefined);
    await sessions.closeAll().catch(() => undefined);
    await lifecycle.stop().catch(() => undefined);
  }
}, REAL_DAEMON_TEST_TIMEOUT_MS);
