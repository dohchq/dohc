import { createConnection } from "node:net";
import { CLI_PROTOCOL_VERSION, cliTransportResponseSchema, parseCliResult } from "@dohc/cli/protocol";
import { startCliServer, type CliServerHandle, type CliServerOptions, type CliWorkspaceContext } from "../cli/cliServer";
import { agentWriteAuthor } from "../cli/desktopCliServer";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";
import { createLiveAgentDispatchStore } from "../agents/liveAgentDispatchStore";
import { readWorkspaceHistoryOperation, undoWorkspaceHistoryOperation } from "./workspaceHistoryOperations";
import { prepareMoveWorkspacePathAs } from "./workspaceFileMoves";
import { rm, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_DEADLINE_MS, REAL_DAEMON_TEST_TIMEOUT_MS } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createWorkspaceFileMutationOwner } from "./workspaceFileMutationOwner";
import { readLocalStateFrom } from "./workspaceLocalState";

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

it.skipIf(engine.missing)("workspace-engine-history rewrites closed links and undoes the move through IPC", async () => {
  const rootPath = await createTestScratch("dohc-link-rewrite-engine-");
  await writeFile(join(rootPath, "old.md"), "target\n");
  for (const name of ["one.md", "two.md", "open.md"]) await writeFile(join(rootPath, name), "[[old#part|label]]\n");
  const workspace = {workspaceId: "link-rewrites-engine", rootPath, attachmentId: Symbol("link-rewrites")};
  const lifecycle = createRealDaemonLifecycle({command: engine.require(), maxRestarts: 0});
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
  readLocalStateFrom(sessions);
  const capture = createWorkspaceEngineCapture({...workspace, rustEngineSessions: sessions});
  const operation = {workspace: {...workspace, readOnly: false, shareView: undefined}, state: {}, signal: new AbortController().signal, assertCurrent: vi.fn()};
  await lifecycle.start();
  try {
    capture.start(); await capture.flush();
    for (const name of ["old.md", "one.md", "two.md", "open.md"]) await waitForPathMoments(capture, name, 1);
    const history = await sessions.run(workspace, async binding => new VersionedLiveAdapter(binding.client, binding.workspace, {workspaceId: workspace.workspaceId}));
    const session = await sessions.run(workspace, binding => binding.client.sendRequest({id: 700, method: "ydoc.open", workspace: binding.workspace,
      params: {versionId: "main", path: "open.md", contentKind: "richdoc"}}));
    expect(session).not.toHaveProperty("error");
    const owner = createWorkspaceFileMutationOwner({historyFor: () => history, assertTrustedSender: () => undefined,
      withRendererWorkspaceOperation: async (_event, _id, work) => work({workspace: operation.workspace, signal: operation.signal, authorityId: workspace.attachmentId,
        capture, assertCurrent: operation.assertCurrent, yDocSessions: {withDocumentUnowned: async (_id, _path, work) => work(), markDeletedUnderPath: () => undefined}}),
      shareViewFiles: {change: async () => {throw new Error("No shares");}}, trashItem: async () => {throw new Error("No trash");}, localPerson: async () => person,
      notifyRenderer: () => undefined, shareViewEdited: () => undefined, logError: () => undefined});
    const renameStart = performance.now();
    const moved = await owner.movePath({}, {workspaceId: workspace.workspaceId, fromPath: "old.md", toPath: "new.md"});
    const renameMs = performance.now() - renameStart;
    expect(moved).toMatchObject({undo: {available: true}});
    const operationId = moved.operationId!;
    const passStart = performance.now();
    const result = await history.rewriteHistoryLinks({workspaceId: workspace.workspaceId, operationId, requestId: "closed-rewrite", author: person});
    const passMs = performance.now() - passStart;
    expect(result).toEqual({documents: 2, links: 2, unchecked: ["open.md"], uncheckedCount: 1, complete: false});
    expect(await history.rewriteHistoryLinks({workspaceId: workspace.workspaceId, operationId, requestId: "closed-rewrite", author: person})).toEqual(result);
    // Undo starts while forward materialization still has queued work.
    const undo = () => owner.undoHistoryOperation({}, {workspaceId: workspace.workspaceId, operationId});
    const undoStart = performance.now();
    // A successful Undo can still be publishing its compensation jobs.
    expect(await undo()).toMatchObject({ok: true, tracked: {state: expect.stringMatching(/^restor(?:ed|ing)$/), momentCount: 3}});
    console.info("link-rewrite-ipc-timing", JSON.stringify({renameMs, passMs, undoMs: performance.now() - undoStart}));
    for (const name of ["one.md", "two.md", "open.md"]) {
      await expect.poll(() => readFile(join(rootPath, name), "utf8"), {timeout: REAL_DAEMON_DEADLINE_MS}).toBe("[[old#part|label]]\n");
    }
    expect(await readFile(join(rootPath, "old.md"), "utf8")).toBe("target\n");
    const replay = await history.undoHistoryOperation({workspaceId: workspace.workspaceId, operationId, requestId: `move-undo:${operationId}`, author: person});
    expect(replay).toMatchObject({deduped: true, momentCount: 3});
  } finally {await capture.stop(); await sessions.closeAll(); await lifecycle.stop();}
}, REAL_DAEMON_TEST_TIMEOUT_MS);

// A lossy note (CONTEXT.md) the desktop shows read-only has no session, so the
// pass treats it as closed: it splices the link and leaves every other byte.
it.skipIf(engine.missing)("rewrites a closed lossy note's link by splicing its text", async () => {
  const rootPath = await createTestScratch("dohc-lossy-link-engine-");
  const lossy = "# Readme\n\n<details>\n<summary>More</summary>\n\nHidden.\n</details>\n\nSee [[old]] and [the docs][docs].\n\n![logo](/docs/logo.png)\n\n1. Install:\n\n       pnpm install\n\n[docs]: https://example.com/docs\n";
  await writeFile(join(rootPath, "old.md"), "target\n");
  await writeFile(join(rootPath, "readme.md"), lossy);
  const workspace = {workspaceId: "lossy-link-rewrite-engine", rootPath, attachmentId: Symbol("lossy-link-rewrite")};
  const lifecycle = createRealDaemonLifecycle({command: engine.require(), maxRestarts: 0});
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  readLocalStateFrom(sessions);
  const capture = createWorkspaceEngineCapture({...workspace, rustEngineSessions: sessions});
  const operation = {workspace: {...workspace, readOnly: false, shareView: undefined}, state: {}, signal: new AbortController().signal, assertCurrent: vi.fn()};
  await lifecycle.start();
  try {
    capture.start(); await capture.flush();
    for (const name of ["old.md", "readme.md"]) await waitForPathMoments(capture, name, 1);
    const history = await sessions.run(workspace, async binding => new VersionedLiveAdapter(binding.client, binding.workspace, {workspaceId: workspace.workspaceId}));
    const owner = createWorkspaceFileMutationOwner({historyFor: () => history, assertTrustedSender: () => undefined,
      withRendererWorkspaceOperation: async (_event, _id, work) => work({workspace: operation.workspace, signal: operation.signal, authorityId: workspace.attachmentId,
        capture, assertCurrent: operation.assertCurrent, yDocSessions: {withDocumentUnowned: async (_id, _path, work) => work(), markDeletedUnderPath: () => undefined}}),
      shareViewFiles: {change: async () => {throw new Error("No shares");}}, trashItem: async () => {throw new Error("No trash");}, localPerson: async () => person,
      notifyRenderer: () => undefined, shareViewEdited: () => undefined, logError: () => undefined});
    const moved = await owner.movePath({}, {workspaceId: workspace.workspaceId, fromPath: "old.md", toPath: "new.md"});
    const result = await history.rewriteHistoryLinks({workspaceId: workspace.workspaceId, operationId: moved.operationId!, requestId: "lossy-rewrite", author: person});
    expect(result).toEqual({documents: 1, links: 1, unchecked: [], uncheckedCount: 0, complete: true});
    const written = await history.readTextFile({workspaceId: workspace.workspaceId, versionId: "main", path: "readme.md"});
    expect(written?.text).toBe(lossy.replace("[[old]]", "[[new]]"));
  } finally {await capture.stop(); await sessions.closeAll(); await lifecycle.stop();}
}, REAL_DAEMON_TEST_TIMEOUT_MS);

it.skipIf(engine.missing)("undoes a folder delete through the real engine and restores files without History rows", async () => {
  const rootPath = await createTestScratch("dohc-delete-undo-engine-");
  await mkdir(join(rootPath, "folder/node_modules/pkg"), { recursive: true });
  await writeFile(join(rootPath, "folder/tracked.txt"), "tracked original\n");
  await writeFile(join(rootPath, "folder/node_modules/pkg/index.js"), "rowless original\n");
  const workspace = { workspaceId: "delete-recovery-engine", rootPath, attachmentId: Symbol("delete-recovery") };
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
  readLocalStateFrom(sessions);
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
    const owner = createWorkspaceFileMutationOwner({
      historyFor: () => history, assertTrustedSender: () => undefined,
      withRendererWorkspaceOperation: async (_event, _id, work) => work({ workspace: operation.workspace, signal: operation.signal, authorityId: workspace.attachmentId, capture,
        yDocSessions: { withDocumentUnowned: async (_id, _path, work) => work(), markDeletedUnderPath: () => undefined }, assertCurrent: operation.assertCurrent }),
      shareViewFiles: { change: async () => { throw new Error("No shares"); } },
      trashItem: async () => { throw new Error("OS trash refuses"); }, localPerson: async () => person, notifyRenderer: () => undefined, shareViewEdited: () => undefined, logError: () => undefined,
    });
    const removed = await owner.deletePath({}, { workspaceId: workspace.workspaceId, relativePath: "folder" });
    expect(removed).toMatchObject({ trashed: false, undo: { available: true }, operationId: expect.any(String) });
    await expect(stat(join(rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
    const operationId = removed.operationId!;
    const undo = () => owner.undoHistoryOperation({}, { workspaceId: workspace.workspaceId, operationId });
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
    const first = await undo();
    expect(inspection).toBeDefined();
    await inspection;
    expect(first).toMatchObject({ ok: true, tracked: { momentCount: 1 }, restored: ["folder/node_modules"], remaining: [] });
    expect(relative(rootPath, inspectedTarget!).split("\\").join("/")).toBe("folder/node_modules/pkg/index.js");
    await expect.poll(() => undo(), { timeout: REAL_DAEMON_DEADLINE_MS })
      .toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 1 } });
    await expect.poll(() => readFile(join(rootPath, "folder/tracked.txt"), "utf8"), { timeout: REAL_DAEMON_DEADLINE_MS }).toBe("tracked original\n");
    expect(await readFile(join(rootPath, "folder/node_modules/pkg/index.js"), "utf8")).toBe("rowless original\n");
    const moments = await waitForPathMoments(capture, "folder/tracked.txt", 3);
    const replay = await history.undoHistoryOperation({ workspaceId: workspace.workspaceId, operationId,
      requestId: `delete-undo:${operationId}`, author: person });
    expect(replay).toMatchObject({ deduped: true, momentCount: 1, compensationOperationId: expect.any(String) });
    expect(await history.undoHistoryOperation({ workspaceId: workspace.workspaceId, operationId,
      requestId: `delete-undo:${operationId}`, author: person })).toMatchObject({ deduped: true, compensationOperationId: replay.compensationOperationId });
    expect(await undo()).toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 1 }, restored: ["folder/node_modules"], remaining: [] });
    expect((await waitForPathMoments(capture, "folder/tracked.txt", 3)).map(moment => moment.id)).toEqual(moments.map(moment => moment.id));
  } finally {
    copy.inspect = undefined;
    await capture.stop();
    await sessions.closeAll();
    await lifecycle.stop();
  }
}, REAL_DAEMON_TEST_TIMEOUT_MS);

it.skipIf(engine.missing)("undoes a person's file through IPC and an agent's rename through the real socket, refusing folder Undo", async () => {
  const rootPath = await createTestScratch("dohc-move-undo-engine-");
  await mkdir(join(rootPath, "folder/node_modules/pkg"), { recursive: true });
  await writeFile(join(rootPath, "folder/tracked.txt"), "before\n");
  await writeFile(join(rootPath, "folder/node_modules/pkg/index.js"), "rowless\n");
  const workspace = { workspaceId: "move-recovery-engine", rootPath, attachmentId: Symbol("move-recovery") };
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
  readLocalStateFrom(sessions);
  const capture = createWorkspaceEngineCapture({ ...workspace, rustEngineSessions: sessions });
  const operation = { workspace: { ...workspace, readOnly: false, shareView: undefined as unknown },
    state: {}, signal: new AbortController().signal, assertCurrent: vi.fn() };
  let server: CliServerHandle | undefined;
  await lifecycle.start();
  try {
    capture.start(); await capture.flush();
    await waitForPathMoments(capture, "folder/tracked.txt", 1);
    const object = await capture.fileObjectIdForPath("folder/tracked.txt");
    const history = await sessions.run(workspace, async binding =>
      new VersionedLiveAdapter(binding.client, binding.workspace, { workspaceId: workspace.workspaceId }));
    const owner = createWorkspaceFileMutationOwner({
      historyFor: () => history, assertTrustedSender: () => undefined,
      withRendererWorkspaceOperation: async (_event, _id, work) => work({ workspace: operation.workspace, signal: operation.signal,
        authorityId: workspace.attachmentId, capture, assertCurrent: operation.assertCurrent,
        yDocSessions: { withDocumentUnowned: async (_id, _path, work) => work(), markDeletedUnderPath: () => undefined } }),
      shareViewFiles: { change: async () => { throw new Error("No shares"); } },
      trashItem: async () => { throw new Error("No trash expected"); }, localPerson: async () => person,
      notifyRenderer: () => undefined, shareViewEdited: () => undefined, logError: () => undefined,
    });
    const moved = await owner.movePath({}, { workspaceId: workspace.workspaceId, fromPath: "folder/tracked.txt", toPath: "archive/tracked.txt" });
    expect(moved).toMatchObject({ path: "archive/tracked.txt", operationId: expect.any(String), undo: { available: true } });
    await writeFile(join(rootPath, "archive/tracked.txt"), "typed after move\n");
    const undo = () => owner.undoHistoryOperation({}, { workspaceId: workspace.workspaceId, operationId: moved.operationId! });
    await expect.poll(undo, { timeout: REAL_DAEMON_DEADLINE_MS }).toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 1 } });
    expect(await readFile(join(rootPath, "folder/tracked.txt"), "utf8")).toBe("typed after move\n");
    expect(await readFile(join(rootPath, "folder/node_modules/pkg/index.js"), "utf8")).toBe("rowless\n");
    expect(await capture.fileObjectIdForPath("folder/tracked.txt")).toBe(object);
    await expect(stat(join(rootPath, "archive/tracked.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const context: CliWorkspaceContext = {
      ...workspace, readOnly: false,
      store: createLiveLinkedChatStore(workspace, sessions),
      dispatchStore: createLiveAgentDispatchStore(workspace, sessions).store,
      fileObjectIdForPath: path => capture.fileObjectIdForPath(path), filePathForObjectId: async () => null,
      listMoments: async () => [], readMoment: async () => null,
      daemonReads: { queryChatMessagesGranular: async () => ({ results: [], saturated: false }), listUnreadFileThreads: async () => [], collectionsWaiting: async () => false },
      deletePath: async () => { throw new Error("No delete expected"); },
      historyOperation: input => readWorkspaceHistoryOperation(operation, input, history),
      historyUndo: (input, origin) => undoWorkspaceHistoryOperation(operation, input, agentWriteAuthor(origin), { history, agent: true }),
      movePath: async (input, origin, requestId) => (await prepareMoveWorkspacePathAs(operation, input, agentWriteAuthor(origin),
        { capture, requestId, trashItem: async () => { throw new Error("No trash expected"); }, markDeleted: () => undefined }))(),
    };
    // A Unix socket path must stay short (107 bytes on Linux, 103 on macOS), so the socket gets its own folder.
    server = await startCliServer({ stateDir: await createTestScratch("cli-"), listWorkspaces: () => [workspace], openWorkspace: async () => context,
      chatWrites: {} as CliServerOptions["chatWrites"], localUserDisplayName: () => "Test", localPersonId: () => person.humanId,
      agentRunDepth: () => 0, dispatchedAgent: () => null, agentRunWorkspace: () => undefined });
    const token = (await readFile(server.tokenPath, "utf8")).trim();
    const request = async (verb: "fileMove" | "historyUndo", args: object) => {
      const socket = createConnection(server!.socketPath); socket.setEncoding("utf8");
      try {
        return await new Promise<unknown>((resolve, reject) => {
          let buffer = "";
          socket.once("error", reject);
          socket.once("connect", () => socket.write(JSON.stringify({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb,
            args: { cwd: rootPath, actor: "agent", ...args } }) + "\n"));
          socket.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) {
            try { const response = cliTransportResponseSchema.parse(JSON.parse(buffer.split("\n")[0]!));
              if (!response.ok) reject(new Error(response.error)); else resolve(parseCliResult(verb, response.result));
            } catch (error) { reject(error); }
          } });
          socket.once("end", () => reject(new Error("Socket closed without a response")));
        });
      } finally { socket.destroy(); }
    };
    await rm(join(rootPath, "folder/node_modules"), { recursive: true });
    for (const name of ["one.md", "two.md"]) {
      await writeFile(join(rootPath, name), "[[folder/tracked.txt#part|label]]\n");
      await waitForPathMoments(capture, name, 1);
    }
    const renamed = await request("fileMove", { fromPath: "folder/tracked.txt", toPath: "folder/renamed.txt", requestId: "real-agent-rename" });
    expect(renamed).toMatchObject({ ok: true, undo: { available: true } });
    const operationId = (renamed as { operationId: string }).operationId;
    expect(await history.rewriteHistoryLinks({workspaceId: workspace.workspaceId, operationId,
      requestId: "socket-rewrite", author: {kind: "agent", agentId: "dohc-mcp", onBehalfOf: person.humanId}}))
      .toEqual({documents: 2, links: 2, unchecked: [], uncheckedCount: 0, complete: true});
    const agentUndo = () => request("historyUndo", { operationId });
    await expect.poll(agentUndo, { timeout: REAL_DAEMON_DEADLINE_MS }).toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 3 } });
    for (const name of ["one.md", "two.md"]) {
      await expect.poll(() => readFile(join(rootPath, name), "utf8"), {timeout: REAL_DAEMON_DEADLINE_MS}).toBe("[[folder/tracked.txt#part|label]]\n");
    }
    expect(await capture.fileObjectIdForPath("folder/tracked.txt")).toBe(object);
    expect(await readFile(join(rootPath, "folder/tracked.txt"), "utf8")).toBe("typed after move\n");
    const replay = await history.undoHistoryOperation({ workspaceId: workspace.workspaceId, operationId, requestId: `move-undo:${operationId}`,
      author: { kind: "agent", agentId: "dohc-mcp", onBehalfOf: person.humanId } });
    expect(replay).toMatchObject({ deduped: true, momentCount: 3 });
    await agentUndo();
    const folder = await request("fileMove", { fromPath: "folder", toPath: "archive/folder", requestId: "real-agent-folder" });
    const folderReason = "Undo for a folder move isn't available yet. Move it back yourself.";
    expect(folder).toMatchObject({ ok: true, undo: { available: false, reason: folderReason, paths: [] } });
    const folderId = (folder as { operationId: string }).operationId;
    expect(await request("historyUndo", { operationId: folderId })).toEqual({ ok: false, reason: folderReason });
    expect(await owner.undoHistoryOperation({}, { workspaceId: workspace.workspaceId, operationId: folderId })).toEqual({ ok: false, reason: folderReason });
    expect(await capture.fileObjectIdForPath("archive/folder/tracked.txt")).toBe(object);
    await expect(stat(join(rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await server?.close(); await capture.stop(); await sessions.closeAll(); await lifecycle.stop();
  }
}, REAL_DAEMON_TEST_TIMEOUT_MS);
