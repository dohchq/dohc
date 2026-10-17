import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_DEADLINE_MS, REAL_DAEMON_TEST_TIMEOUT_MS } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { deleteWorkspacePathByHand, undoWorkspaceDelete } from "./workspaceFileMoves";

const copy = vi.hoisted(() => ({ inspect: undefined as undefined | ((temp: string) => Promise<void>) }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    link: async () => { throw Object.assign(new Error("cross-volume link"), { code: "EXDEV" }); },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (args[1] === "wx" && !basename(String(args[0])).startsWith("delete-")) {
        const sync = file.sync.bind(file);
        file.sync = async () => { await sync(); await copy.inspect?.(String(args[0])); };
      }
      return file;
    },
  };
});
const engine = requireEngineBinaryOrSkip();
const person = { kind: "human", humanId: "local:delete-recovery" } as const;

it.skipIf(engine.missing)("undoes a folder delete through the real engine and restores files without History rows", async () => {
  const rootPath = await createTestScratch("dohc-delete-undo-engine-");
  await mkdir(join(rootPath, "folder/node_modules/pkg"), { recursive: true });
  await writeFile(join(rootPath, "folder/tracked.txt"), "tracked original\n");
  await writeFile(join(rootPath, "folder/node_modules/pkg/index.js"), "rowless original\n");
  const workspace = { workspaceId: "delete-recovery-engine", rootPath, attachmentId: Symbol("delete-recovery") };
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const capture = createWorkspaceEngineCapture({ ...workspace, rustEngineSessions: sessions });
  const operation = { workspace: { ...workspace, readOnly: false, shareView: undefined as unknown },
    state: {}, signal: new AbortController().signal, assertCurrent: vi.fn() };
  await lifecycle.start();
  try {
    capture.start();
    await capture.flush();
    await waitForPathMoments(capture, "folder/tracked.txt", 1);
    expect(await capture.fileObjectIdForPath("folder/node_modules/pkg/index.js")).toBeNull();
    const history = await sessions.run(workspace, async binding =>
      new VersionedLiveAdapter(binding.client, binding.workspace, { workspaceId: workspace.workspaceId }));
    const removed = await deleteWorkspacePathByHand(operation, "folder", person, {
      capture, requestId: "delete-folder", markDeleted: vi.fn(), trashItem: async () => { throw new Error("OS trash refuses"); },
    });
    expect(removed).toMatchObject({ trashed: false, undo: { available: true }, operationId: expect.any(String) });
    await expect(stat(join(rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
    const operationId = removed.operationId!;
    const undo = (requestId: string) => undoWorkspaceDelete(operation, { operationId, requestId }, person,
      { workspaceId: workspace.workspaceId, history });
    let inspection: Promise<void> | undefined;
    let inspectedTarget: string | undefined;
    copy.inspect = target => {
      inspectedTarget = target;
      inspection = (async () => {
        await writeFile(join(rootPath, "copy-barrier.txt"), "capture reached this copy");
        await capture.flush();
        await waitForPathMoments(capture, "copy-barrier.txt", 1);
        expect(await readFile(target, "utf8")).toBe("rowless original\n");
        expect(await capture.fileObjectIdForPath(relative(rootPath, target).split("\\").join("/"))).toBeNull();
      })();
      return inspection;
    };
    const first = await undo("undo-folder");
    expect(inspection).toBeDefined();
    await inspection;
    expect(first).toMatchObject({ ok: true, tracked: { momentCount: 1 }, restored: ["folder/node_modules"], remaining: [] });
    expect(relative(rootPath, inspectedTarget!).split("\\").join("/")).toBe("folder/node_modules/pkg/index.js");
    await expect.poll(() => undo("refresh-folder"), { timeout: REAL_DAEMON_DEADLINE_MS })
      .toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 1 } });
    await expect.poll(() => readFile(join(rootPath, "folder/tracked.txt"), "utf8"), { timeout: REAL_DAEMON_DEADLINE_MS }).toBe("tracked original\n");
    expect(await readFile(join(rootPath, "folder/node_modules/pkg/index.js"), "utf8")).toBe("rowless original\n");
    const moments = await waitForPathMoments(capture, "folder/tracked.txt", 3);
    const replay = await history.undoHistoryOperation({ workspaceId: workspace.workspaceId, operationId,
      requestId: `delete-undo:${operationId}`, author: person });
    expect(replay).toMatchObject({ deduped: true, momentCount: 1, compensationOperationId: expect.any(String) });
    expect(await history.undoHistoryOperation({ workspaceId: workspace.workspaceId, operationId,
      requestId: `delete-undo:${operationId}`, author: person })).toMatchObject({ deduped: true, compensationOperationId: replay.compensationOperationId });
    expect(await undo("new-caller-id")).toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 1 }, restored: ["folder/node_modules"], remaining: [] });
    expect((await waitForPathMoments(capture, "folder/tracked.txt", 3)).map(moment => moment.id)).toEqual(moments.map(moment => moment.id));
  } finally {
    copy.inspect = undefined;
    await capture.stop();
    await sessions.closeAll();
    await lifecycle.stop();
  }
}, REAL_DAEMON_TEST_TIMEOUT_MS);
