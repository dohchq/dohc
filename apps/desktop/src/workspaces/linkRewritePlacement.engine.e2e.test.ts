import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createWorkspaceFileMutationOwner } from "./workspaceFileMutationOwner";

const engine = requireEngineBinaryOrSkip();

// No replay, Undo, fence, or test placement runs before the disk assertion.
it.skipIf(engine.missing)("places forward link rewrites through the daemon's ordinary capture loop", async () => {
  const rootPath = await createTestScratch("dohc-link-placement-");
  const names = ["one.md", "two.md", "three.md"];
  await writeFile(join(rootPath, "old.md"), "target\n");
  for (const name of names) await writeFile(join(rootPath, name), "[[old#part|label]]\n");
  const workspace = {workspaceId: "link-placement", rootPath, attachmentId: Symbol("link-placement")};
  const lifecycle = createRealDaemonLifecycle({command: engine.require(), maxRestarts: 0});
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const capture = createWorkspaceEngineCapture({...workspace, rustEngineSessions: sessions});
  const operation = {workspace: {...workspace, readOnly: false, shareView: undefined}, state: {}, signal: new AbortController().signal, assertCurrent: vi.fn()};
  const disk = () => Promise.all(names.map(name => readFile(join(rootPath, name), "utf8")));
  const jobs = () => {
    const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {readOnly: true});
    try { return db.prepare("SELECT status,count(*) AS n FROM materialization_jobs WHERE job_id LIKE 'authored-mat_link-rewrite-%' GROUP BY status").all(); }
    finally { db.close(); }
  };
  const waitForDisk = async (timeout: number) => {
    try { await expect.poll(disk, {timeout, interval: 100}).toEqual(names.map(() => "[[new#part|label]]\n")); return true; }
    catch { return false; }
  };
  await lifecycle.start();
  try {
    capture.start(); await capture.flush();
    for (const name of ["old.md", ...names]) await waitForPathMoments(capture, name, 1);
    const history = await sessions.run(workspace, async binding => new VersionedLiveAdapter(binding.client, binding.workspace, {workspaceId: workspace.workspaceId}));
    await expect.poll(() => history.incomingLinks({subject: {path: "old.md"}}), {timeout: REAL_DAEMON_DEADLINE_MS})
      .toMatchObject({indexBuilding: false, entries: expect.arrayContaining(names.map(source => expect.objectContaining({source})))});
    const owner = createWorkspaceFileMutationOwner({historyFor: () => history, assertTrustedSender: () => undefined,
      withRendererWorkspaceOperation: async (_event, _id, work) => work({workspace: operation.workspace, signal: operation.signal, authorityId: workspace.attachmentId,
        capture, assertCurrent: operation.assertCurrent, yDocSessions: {withDocumentUnowned: async (_id, _path, work) => work(), markDeletedUnderPath: () => undefined}}),
      shareViewFiles: {change: async () => {throw new Error("No shares");}}, trashItem: async () => {throw new Error("No trash");},
      localPerson: async () => ({kind: "human", humanId: "local:placement"}), notifyRenderer: () => undefined, shareViewEdited: () => undefined, logError: () => undefined});
    const started = performance.now();
    const moved = await owner.movePath({}, {workspaceId: workspace.workspaceId, fromPath: "old.md", toPath: "new.md"});
    await expect(history.rewriteHistoryLinks({workspaceId: workspace.workspaceId, operationId: moved.operationId!, requestId: "placement-rewrite"})).resolves.toMatchObject({documents: 3, uncheckedCount: 0});
    const receiptMs = performance.now() - started;
    const before = performance.now();
    const automatic = await waitForDisk(REAL_DAEMON_DEADLINE_MS);
    console.info("link-placement ordinary", JSON.stringify({receiptMs, observedMs: performance.now() - before, automatic, jobs: jobs(), disk: await disk()}));
    expect(automatic, "Forward rewrites must reach disk without a workspace reopen or Undo").toBe(true);
  } finally { await capture.stop(); await sessions.closeAll(); await lifecycle.stop(); }
}, 6 * REAL_DAEMON_DEADLINE_MS);
