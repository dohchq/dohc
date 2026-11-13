import { createConnection } from "node:net";
import {
  CLI_PROTOCOL_VERSION,
  cliTransportResponseSchema,
  parseCliResult,
} from "@dohc/cli/protocol";
import {
  startCliServer,
  type CliServerHandle,
  type CliServerOptions,
  type CliWorkspaceContext,
} from "../cli/cliServer";
import { agentWriteAuthor } from "../cli/desktopCliServer";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";
import { createLiveAgentDispatchStore } from "../agents/liveAgentDispatchStore";
import {
  readWorkspaceHistoryOperation,
  undoWorkspaceHistoryOperation,
} from "./workspaceHistoryOperations";
import { prepareMoveWorkspacePathAs } from "./workspaceFileMoves";
import { rm, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  VersionedLiveAdapter,
  YdocLiveAdapter,
  type EngineTransport,
} from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
  REAL_DAEMON_DEADLINE_MS,
  REAL_DAEMON_TEST_TIMEOUT_MS,
} from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createWorkspaceFileMutationOwner } from "./workspaceFileMutationOwner";
import { undoOperation as mcpUndoOperation } from "@dohc/mcp/tools";
import { readLocalStateFrom } from "./workspaceLocalState";

const engine = requireEngineBinaryOrSkip();
const person = { kind: "human", humanId: "local:delete-recovery" } as const;

it.skipIf(engine.missing)(
  "undoes a person's file through IPC and an agent's rename through the real socket, refusing folder Undo",
  async () => {
    const rootPath = await createTestScratch("dohc-move-undo-engine-");
    await mkdir(join(rootPath, "folder/node_modules/pkg"), { recursive: true });
    await writeFile(join(rootPath, "folder/tracked.txt"), "before\n");
    await writeFile(join(rootPath, "folder/node_modules/pkg/index.js"), "rowless\n");
    const workspace = {
      workspaceId: "move-recovery-engine",
      rootPath,
      attachmentId: Symbol("move-recovery"),
    };
    const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
    readLocalStateFrom(sessions);
    const capture = createWorkspaceEngineCapture({ ...workspace, rustEngineSessions: sessions });
    const operation = {
      workspace: { ...workspace, readOnly: false, shareView: undefined as unknown },
      state: {},
      signal: new AbortController().signal,
      assertCurrent: vi.fn(),
    };
    let server: CliServerHandle | undefined;
    let editor: YdocLiveAdapter | undefined;
    await lifecycle.start();
    try {
      capture.start();
      await capture.flush();
      await waitForPathMoments(capture, "folder/tracked.txt", 1);
      const object = await capture.fileObjectIdForPath("folder/tracked.txt");
      const history = await sessions.run(
        workspace,
        async (binding) =>
          new VersionedLiveAdapter(binding.client, binding.workspace, {
            workspaceId: workspace.workspaceId,
          }),
      );
      const owner = createWorkspaceFileMutationOwner({
        historyFor: () => history,
        assertTrustedSender: () => undefined,
        withRendererWorkspaceOperation: async (_event, _id, work) =>
          work({
            workspace: operation.workspace,
            signal: operation.signal,
            authorityId: workspace.attachmentId,
            capture,
            assertCurrent: operation.assertCurrent,
            yDocSessions: {
              withDocumentUnowned: async (_id, _path, work) => work(),
              markDeletedUnderPath: () => undefined,
            },
          }),
        shareViewFiles: {
          change: async () => {
            throw new Error("No shares");
          },
        },
        trashItem: async () => {
          throw new Error("No trash expected");
        },
        localPerson: async () => person,
        notifyRenderer: () => undefined,
        shareViewEdited: () => undefined,
        logError: () => undefined,
      });
      const moved = await owner.movePath(
        {},
        {
          workspaceId: workspace.workspaceId,
          fromPath: "folder/tracked.txt",
          toPath: "archive/tracked.txt",
        },
      );
      expect(moved).toMatchObject({
        path: "archive/tracked.txt",
        operationId: expect.any(String),
        undo: { available: true },
      });
      await writeFile(join(rootPath, "archive/tracked.txt"), "typed after move\n");
      const undo = () =>
        owner.undoHistoryOperation(
          {},
          { workspaceId: workspace.workspaceId, operationId: moved.operationId! },
        );
      await expect
        .poll(undo, { timeout: REAL_DAEMON_DEADLINE_MS })
        .toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 1 } });
      expect(await readFile(join(rootPath, "folder/tracked.txt"), "utf8")).toBe(
        "typed after move\n",
      );
      expect(await readFile(join(rootPath, "folder/node_modules/pkg/index.js"), "utf8")).toBe(
        "rowless\n",
      );
      expect(await capture.fileObjectIdForPath("folder/tracked.txt")).toBe(object);
      await expect(stat(join(rootPath, "archive/tracked.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const context: CliWorkspaceContext = {
        ...workspace,
        readOnly: false,
        store: createLiveLinkedChatStore(workspace, sessions),
        dispatchStore: createLiveAgentDispatchStore(workspace, sessions).store,
        fileObjectIdForPath: (path) => capture.fileObjectIdForPath(path),
        filePathForObjectId: async () => null,
        listMoments: async () => [],
        readMoment: async () => null,
        daemonReads: {
          queryChatMessagesGranular: async () => ({ results: [], saturated: false }),
          listUnreadFileThreads: async () => [],
          collectionsWaiting: async () => false,
        },
        deletePath: async () => {
          throw new Error("No delete expected");
        },
        historyOperation: (input) =>
          readWorkspaceHistoryOperation(operation, input, history, { agent: true }),
        historyUndo: (input, origin) =>
          undoWorkspaceHistoryOperation(operation, input, agentWriteAuthor(origin), {
            history,
            agent: true,
          }),
        movePath: async (input, origin, requestId) =>
          (
            await prepareMoveWorkspacePathAs(operation, input, agentWriteAuthor(origin), {
              capture,
              requestId,
              linkRewrites: {
                workspaceId: workspace.workspaceId,
                signal: operation.signal,
                history,
              },
              trashItem: async () => {
                throw new Error("No trash expected");
              },
              markDeleted: () => undefined,
            })
          )(),
      };
      // A Unix socket path must stay short (107 bytes on Linux, 103 on macOS), so the socket gets its own folder.
      const socketHome = await createTestScratch("cli-");
      server = await startCliServer({
        stateDir: socketHome,
        listWorkspaces: () => [workspace],
        openWorkspace: async () => context,
        chatWrites: {} as CliServerOptions["chatWrites"],
        localUserDisplayName: () => "Test",
        localPersonId: () => person.humanId,
        agentRunDepth: () => 0,
        dispatchedAgent: () => null,
        dispatchedRunId: () => null,
        dispatchedRunSecret: () => null,
        agentWriteRunId: () => null,
        agentRunWorkspace: () => undefined,
        connectedAgent: async () => null,
      });
      const token = (await readFile(server.tokenPath, "utf8")).trim();
      const request = async (verb: "fileMove" | "historyUndo", args: object) => {
        const socket = createConnection(server!.socketPath);
        socket.setEncoding("utf8");
        try {
          return await new Promise<unknown>((resolve, reject) => {
            let buffer = "";
            socket.once("error", reject);
            socket.once("connect", () =>
              socket.write(
                JSON.stringify({
                  token,
                  protocolVersion: CLI_PROTOCOL_VERSION,
                  verb,
                  args: { cwd: rootPath, actor: "agent", ...args },
                }) + "\n",
              ),
            );
            socket.on("data", (chunk) => {
              buffer += chunk;
              if (buffer.includes("\n")) {
                try {
                  const response = cliTransportResponseSchema.parse(
                    JSON.parse(buffer.split("\n")[0]!),
                  );
                  if (!response.ok) reject(new Error(response.error));
                  else resolve(parseCliResult(verb, response.result));
                } catch (error) {
                  reject(error);
                }
              }
            });
            socket.once("end", () => reject(new Error("Socket closed without a response")));
          });
        } finally {
          socket.destroy();
        }
      };
      await rm(join(rootPath, "folder/node_modules"), { recursive: true });
      for (const name of ["open.md"]) {
        await writeFile(join(rootPath, name), "[[folder/tracked.txt#part|label]]\n");
        await waitForPathMoments(capture, name, 1);
      }
      await expect
        .poll(() => history.incomingLinks({ subject: { path: "folder/tracked.txt" } }), {
          timeout: REAL_DAEMON_DEADLINE_MS,
        })
        .toMatchObject({
          indexBuilding: false,
          entries: expect.arrayContaining([expect.objectContaining({ source: "open.md" })]),
        });
      const session = await sessions.run(workspace, async (binding) => {
        editor = new YdocLiveAdapter(binding.client as EngineTransport);
        return editor.openSession({
          workspace: binding.workspace,
          versionId: "main",
          path: "open.md",
          contentKind: "richdoc",
        });
      });
      await session.settle();
      const renamed = await request("fileMove", {
        fromPath: "folder/tracked.txt",
        toPath: "folder/renamed.txt",
        requestId: "real-agent-rename",
      });
      expect(renamed).toMatchObject({ ok: true, undo: { available: true } });
      const operationId = (renamed as { operationId: string }).operationId;
      await expect
        .poll(() => context.historyOperation!({ operationId }), {
          timeout: REAL_DAEMON_DEADLINE_MS,
        })
        .toMatchObject({
          ok: true,
          links: { state: "done", documents: 1, unchecked: [], uncheckedCount: 0 },
        });
      const agentUndo = () =>
        mcpUndoOperation({ root: rootPath, home: socketHome }, { operationId }, "dohc-mcp");
      await expect
        .poll(agentUndo, { timeout: REAL_DAEMON_DEADLINE_MS })
        .toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 2 } });
      for (const name of ["open.md"]) {
        await expect
          .poll(() => readFile(join(rootPath, name), "utf8"), { timeout: REAL_DAEMON_DEADLINE_MS })
          .toBe("[[folder/tracked.txt#part|label]]\n");
      }
      expect(await capture.fileObjectIdForPath("folder/tracked.txt")).toBe(object);
      expect(await readFile(join(rootPath, "folder/tracked.txt"), "utf8")).toBe(
        "typed after move\n",
      );
      const replay = await history.undoHistoryOperation({
        workspaceId: workspace.workspaceId,
        operationId,
        requestId: `move-undo:${operationId}`,
        author: { kind: "agent", agentId: "dohc-mcp", onBehalfOf: person.humanId },
      });
      expect(replay).toMatchObject({ deduped: true, momentCount: 2 });
      await agentUndo();
      const folder = await request("fileMove", {
        fromPath: "folder",
        toPath: "archive/folder",
        requestId: "real-agent-folder",
      });
      const folderReason = "Undo for a folder move isn't available yet. Move it back yourself.";
      expect(folder).toMatchObject({
        ok: true,
        undo: { available: false, reason: folderReason, paths: [] },
      });
      const folderId = (folder as { operationId: string }).operationId;
      const refused = { ok: false, reason: folderReason, refusal: { code: "unexplained" } };
      expect(await request("historyUndo", { operationId: folderId })).toEqual(refused);
      expect(
        await owner.undoHistoryOperation(
          {},
          { workspaceId: workspace.workspaceId, operationId: folderId },
        ),
      ).toEqual(refused);
      expect(await capture.fileObjectIdForPath("archive/folder/tracked.txt")).toBe(object);
      await expect(stat(join(rootPath, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      editor?.dispose();
      await server?.close();
      await capture.stop();
      await sessions.closeAll();
      await lifecycle.stop();
    }
  },
  REAL_DAEMON_TEST_TIMEOUT_MS,
);
