import {
  disconnectLinkAgent,
  getShareCopyDetails,
  listLinkAgents,
  listLiveDocuments,
  resumeLiveEditing,
  retryKeptEdits,
  saveRecoveryCopy,
  stopAgain as stopAgainTool,
  stopLiveEditing,
  workspaceStatus,
} from "@dohc/mcp/tools";
import { type OwnerLiveQuarantine } from "../ipc/bridgeContract";
import { pendingStopHarness } from "../testing/ownerLiveStop.test-helper";
import { stopNamedOwnerLiveDocument } from "../ipc/relaySharesIpc";
import { createShareCopyReader } from "../ipc/shareCopyHandler";
import { createShareLinkAgentActions } from "../ipc/shareLinkAgentActions";
import { workspaceRemoteMatchesCredentials } from "../workspaces/chatRelayIdentity";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import {
  closeTestStorages,
  testStorage,
  testHandler,
  request as relayRequest,
  inspectDatabase,
  storagePath,
  SHARE_WEB_ORIGIN,
  RELAY_EXCHANGE_KEY,
} from "@dohc/sync-relay/testing";
import { historyPageFields } from "../testing/historyPageFixture";
import { createHash } from "node:crypto";
import { parseCliResult, type CliFileWrite } from "@dohc/cli/protocol";
import { createTestScratch } from "../workspaces/testTemp";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  documentEditUpdate,
  documentMarkdown,
  markdownToYDoc,
  yDocToMarkdown,
} from "@dohc/ydoc-projection";
import { directDocumentProjection } from "../workspaces/documentProjection";
import { WORKSPACE_METHOD, type VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { executeCli } from "@dohc/cli";
import {
  CLI_PROTOCOL_VERSION,
  cliTransportResponseSchema,
  type CliRequestWithoutToken,
} from "@dohc/cli/protocol";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import { createDesktopCliServer } from "./desktopCliServer";
import { handleCliRequestLine } from "./cliServer";
import type { CliServerOptions, CliServerHandle } from "./cliServer";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { createChatWrites } from "../workspaces/chatWrites";
import type { CollectionRecordEditContext } from "@dohc/automation-executor/collection-record-edits";
import { desktopRecordEditContext } from "../workspaces/desktopRecordEdits";
import type {
  AuthoredPathChanges,
  WorkspaceEngineMomentSummary,
  WorkspaceEngineYDocProviderSession,
} from "../workspaces/workspaceEngineCapture";
import { readWorkspaceEnginePolicy } from "../workspaces/workspaceEnginePolicyFile";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { createWorkspaceFolder } from "../workspaces/createWorkspaceFolder";
import { realpathSync } from "node:fs";
import { readDeleteRecovery, waitForRecovery } from "../workspaces/workspaceDeleteRecovery";
import { openedLocalState } from "../testing/preparedLocalState";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

type State = Record<string, never>;
type Dependencies = Parameters<typeof createDesktopCliServer<State>>[0];
type Capture = NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>;

function fixture(
  rootPath = resolve("cli-workspace"),
  canonicalizeRoot: (root: string) => string = resolve,
) {
  const workspace: RegistryEntry = {
    workspaceId: "workspace",
    rootPath,
    kind: "personal",
    mode: "local-first",
    remote: { serverUrl: "https://cloud.test", ownerUserId: "owner" },
  };
  const rows = new Map([[workspace.workspaceId, workspace]]);
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => rows.get(id) ?? null,
    canonicalizeRoot,
    createState: (): State => ({}),
  });
  const store = {
    findThreadChannelId: vi.fn(async () => "channel"),
    getChannelWireId: vi.fn(async () => "wire"),
  } as unknown as DesktopLinkedChatStore;
  const dispatchStore = {} as ReturnType<Dependencies["agentDispatchStoreHandleFor"]>["store"];
  const capture = {
    fileObjectIdForPath: vi.fn(async () => "object"),
    filePathForObjectId: vi.fn(async () => "notes.md"),
    listMoments:
      vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listMoments"]>(),
    readMoment:
      vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["readMoment"]>(),
    listKeptCopies:
      vi.fn<
        NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listKeptCopies"]
      >(),
    saveKeptCopy:
      vi.fn<
        NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["saveKeptCopy"]
      >(),
    restoreProtectedCopy: vi.fn<Capture["restoreProtectedCopy"]>(),
    discardProtectedCopy: vi.fn<Capture["discardProtectedCopy"]>(),
    heldNoteChange:
      vi.fn<
        NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["heldNoteChange"]
      >(),
    listRetainedCopies:
      vi.fn<
        NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listRetainedCopies"]
      >(),
    deleteRetainedCopies:
      vi.fn<
        NonNullable<
          ReturnType<Dependencies["activity"]["engineCaptureFor"]>
        >["deleteRetainedCopies"]
      >(),
    listVersions: vi.fn<
      NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listVersions"]
    >(async () => ({ versions: [], activeVersionId: "main" })),
    ...historyPageFields,
    compareVersions: vi.fn<Capture["compareVersions"]>(async () => ({
      files: [],
      nextAfterPath: null,
    })),
    listOpenConflictsPage: vi.fn<Capture["listOpenConflictsPage"]>(async () => ({
      conflicts: [],
      nextAfterConflictId: null,
    })),
    createVersion: vi.fn<Capture["createVersion"]>(async (name) => ({
      versions: [
        {
          id: "created",
          workspaceId: "workspace",
          kind: "named",
          name,
          createdAtMs: 1,
          forkPoint: { versionId: "main" },
        },
      ],
      activeVersionId: "created",
    })),
    switchVersion: vi.fn<Capture["switchVersion"]>(async (versionId) => ({
      activeVersionId: versionId,
      changedFileCount: 2,
    })),
    mergeVersionIntoMain: vi.fn<Capture["mergeVersionIntoMain"]>(async () => ({
      mergedFileCount: 3,
      unchangedFileCount: 1,
      conflictCount: 0,
      replacedProtectedPaths: [".env"],
    })),
    resolveConflict: vi.fn<Capture["resolveConflict"]>(),
    // Writes the file as the capture chain does, refusing one that exists.
    writeAuthoredFile: vi.fn<Capture["writeAuthoredFile"]>(
      async (absolutePath, text, _author, options) => {
        await mkdir(dirname(absolutePath), { recursive: true });
        try {
          await writeFile(absolutePath, text, { flag: options?.createOnly ? "wx" : "w" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          throw new VersionedTextStoreError("target-path-exists", "File already exists");
        }
        return {
          resolvedAbsolutePath: absolutePath,
          materializeOutcome: "applied",
          objectId: "object",
          momentId: "moment",
          deduped: false,
        };
      },
    ),
    // Runs the move or delete as the capture does, with no live documents to
    // settle: the policy is read once the change runs, History holds every
    // regular file, and the disk has no rename that refuses to replace.
    changePathsAs: vi.fn(
      async (
        _paths: readonly string[],
        _authored: unknown,
        work: (engine: AuthoredPathChanges) => Promise<unknown>,
      ) =>
        await work({
          policy: await readWorkspaceEnginePolicy(rootPath),
          readDuplicate: async () => null,
          hasPath: async () => false,
          duplicateFile: async () => {
            throw new Error("unexpected Duplicate");
          },
          recordDisk: async (_path, files) => [...files],
          moveFile: async () => false,
          rename: async () => undefined,
          delete: async () => "moment",
          undoDelete: async () => undefined,
        }),
    ) as Capture["changePathsAs"],
  };
  const requestWorkspace = vi.fn(
    async (_root: string, _id: string, method: string, _input: unknown) =>
      method === WORKSPACE_METHOD.searchQueryChatMessagesGranular
        ? { results: [{ threadId: "thread", messageId: null, text: "Title" }], saturated: false }
        : [{ threadId: "thread", messageCount: 2, lastReadSequence: 1 }],
  );
  let currentCapture: ReturnType<Dependencies["activity"]["engineCaptureFor"]> = capture;
  let daemon: ReturnType<Dependencies["currentDaemon"]> = { requestWorkspace };
  let options!: CliServerOptions;
  const handle: CliServerHandle = {
    socketPath: "socket",
    tokenPath: "token",
    close: vi.fn(async () => undefined),
  };
  const chatWrites = createChatWrites({
    findWorkspace: (id) => rows.get(id) ?? null,
    warmCredentials: async () => undefined,
    currentCredentialGeneration: () => 0,
    currentCredentials: () => null,
    localUserDisplayName: () => "Local name",
    agentDisplayName: async () => "Agent",
    agentIdsToWake: async (_body, dmAgentId) => (dmAgentId === null ? [] : [dmAgentId]),
    localInstallationId: () => "local:device",
    projectChatBookmarks: vi.fn(),
    queueCloudSync: vi.fn(),
    syncSharedChannelsForChatTarget: async () => undefined,
    scanChatDispatch: async () => undefined,
    betweenDispatchScans: (_workspaceId, write) => write(),
    notifyRenderer: () => undefined,
  });
  const dependencies: Dependencies = {
    notices: vi.fn(async () => []),
    heldChanges: { change: vi.fn(async () => null) },
    reads: {
      chatFileMentions: vi.fn(async () => null),
      chatLinks: vi.fn(async () => null),
      linksEdges: vi.fn(async () => ({
        versionId: "main",
        files: [],
        entries: [],
        unchecked: [],
        complete: true,
        indexBuilding: false,
        mountsCovered: true,
        nextCursor: null,
      })),
      linksIn: vi.fn(async () => null),
      linksResolve: vi.fn(async () => ({ versionId: "main", results: [], mountsCovered: true })),
    },
    automations: () => ({
      automationIdAt: vi.fn(),
      runs: vi.fn(),
      run: vi.fn(),
      serverRuns: vi.fn(),
      serverRun: vi.fn(),
      retry: vi.fn(),
    }),
    buttons: () => ({ inspect: vi.fn(async () => []), press: vi.fn() }),
    findWorkspace: (id) => rows.get(id) ?? null,
    agentYouRun: vi.fn(async (agentId: string) =>
      agentId === "terminal" ? { name: "Terminal" } : null,
    ),
    listWorkspaces: () => [...rows.values()],
    openWorkspaceActivity: vi.fn(async () => undefined),
    activity: {
      engineCaptureFor: vi.fn(() => currentCapture),
      queueCloudSync: vi.fn(),
      agentRunDepth: vi.fn(() => 0),
      dispatchedAgent: vi.fn(() => null),
      dispatchedRunId: vi.fn(() => null),
      dispatchedRunSecret: vi.fn(() => null),
      agentWriteRunId: vi.fn(() => null),
      agentRunWorkspace: vi.fn(() => undefined),
      getStatus: vi.fn(() => ({})),
    },
    linkedChatStoreFor: vi.fn(() => store),
    accountReadOwner: vi.fn(async (): Promise<string | undefined> => undefined),
    currentDaemon: vi.fn(() => daemon),
    agentDispatchStoreHandleFor: vi.fn(() => ({ store: dispatchStore })),
    sharedViewOf: vi.fn(() => null),
    shareProjection: vi.fn(async () => undefined),
    withPhysicalWorkspaceOperation: (id, work) => authorities.withOperation(id, work),
    collectionEditContextFor: vi.fn(async () => {
      throw new Error("No edit context configured");
    }),
    localPerson: async () => ({ kind: "human", humanId: "local:test" }),
    withEngineAdapter: async () => null,
    liveDocuments: {
      readDocument: vi.fn<Dependencies["liveDocuments"]["readDocument"]>(async ({ path }) => ({
        path,
        state: null,
      })),
      editDocument: vi.fn<Dependencies["liveDocuments"]["editDocument"]>(async ({ path }) => ({
        path,
        changed: false,
      })),
    },
    trashItem: vi.fn(async () => {
      throw new Error("No system trash in tests");
    }),
    markDeletedUnderPath: vi.fn(),
    documentProjection: directDocumentProjection,
    chatWrites,
    startCliServer: vi.fn(async (input) => {
      options = input;
      return handle;
    }),
    stateDir: () => "state",
    localUserDisplayName: () => "Local name",
    localPersonId: () => "person-local",
    notifyRenderer: vi.fn(),
    notifyNoticesChanged: vi.fn(),
    versionRound: (_workspaceId, change) => change(),
    syncSharedChannelsForChatTarget: vi.fn(async () => undefined),
    chatDispatchService: {
      scanWorkspace: vi.fn(async () => undefined),
      dispatchStateForThread: vi.fn(async () => ({
        liveRunId: null,
        liveTriggerMessageId: null,
        pendingCount: 0,
        paused: false,
      })),
      retryStoppedRun: vi.fn(async () => false),
      endRunQuietly: vi.fn(() => "not-running" as const),
    },
    rememberPendingCliRunMessageLink: vi.fn(),
  };
  return {
    workspace,
    rows,
    authorities,
    capture,
    store,
    dispatchStore,
    requestWorkspace,
    handle,
    dependencies,
    chatWrites,
    create: () => createDesktopCliServer(dependencies),
    options: () => options,
    setCapture: (value: typeof currentCapture) => {
      currentCapture = value;
    },
    setDaemon: (value: typeof daemon) => {
      daemon = value;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("desktop CLI workspace context", () => {
  it("binds sync stop to the registered workspace and fences a retired attachment", async () => {
    const f = fixture();
    f.dependencies.stopWorkspaceSync = vi.fn(async (operation, author) => {
      operation.assertCurrent();
      expect(operation.workspace.workspaceId).toBe(f.workspace.workspaceId);
      expect(author).toBeUndefined();
      return {
        ok: true as const,
        workspaceId: operation.workspace.workspaceId,
        workspaceSynced: false as const,
      };
    });
    const server = f.create();
    const context = await server.openCliWorkspace(f.workspace);
    await expect(context.stopSync!()).resolves.toMatchObject({
      ok: true,
      workspaceId: "workspace",
    });
    const retired = f.authorities.invalidate("workspace");
    await retired;
    await expect(context.stopSync!()).rejects.toThrow(
      "This workspace changed while this ran. Try again.",
    );
    expect(f.dependencies.stopWorkspaceSync).toHaveBeenCalledOnce();
  });

  it("keeps owner app actions bound to the CLI's original physical attachment", async () => {
    const f = fixture();
    const publish = vi.fn<NonNullable<Dependencies["ownerAppPublication"]>>(async () => ({
      kind: "cancelled",
    }));
    f.dependencies.ownerAppPublication = publish;
    const context = await f.create().openCliWorkspace(f.workspace);
    const request = {
      action: "cancel" as const,
      workspaceId: f.workspace.workspaceId,
      approvalId: "00000000-0000-4000-8000-000000000001",
    };
    expect(await context.appPublication!(request)).toEqual({ kind: "cancelled" });
    expect(publish).toHaveBeenCalledWith(request, null);
    await f.authorities.invalidate(f.workspace.workspaceId);
    await expect(context.appPublication!(request)).rejects.toThrow(
      "This workspace changed while this ran. Try again.",
    );
    expect(publish).toHaveBeenCalledOnce();
  });

  it("stops showing history the workspace's current policy no longer tracks, to the CLI and the MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-history-"));
    try {
      await mkdir(join(root, ".dohc"));
      const f = fixture(root);
      const summary = (id: string, path: string): WorkspaceEngineMomentSummary => ({
        id,
        versionId: "main",
        objectId: `object-${id}`,
        path,
        recordedAtMs: 20,
        operation: "write",
        metadata: { origin: "local-file" },
        momentOrder: 1,
        protected: false,
        contentKind: "text",
        byteLength: 4,
      });
      // The summary desktop capture records for a rename (workspaceEngineCapture.ts, beginFileRename).
      const renamed = "Renamed private/moved.md to notes/moved.md";
      const snapshot = (path: string, text: string) => ({
        path,
        contentKind: "text" as const,
        sha256: "sha",
        byteLength: text.length,
        text,
      });
      const detail = (
        id: string,
        operation: VersionedTextMoment["operation"],
        payload: VersionedTextMoment["payload"],
      ): VersionedTextMoment => ({
        id,
        workspaceId: "workspace",
        versionId: "main",
        objectId: `object-${id}`,
        path: payload.after.path,
        recordedAtMs: 20,
        operation,
        payload,
        metadata: { origin: "local-file" },
      });
      const details: Record<string, VersionedTextMoment> = {
        journal: detail("journal", "write", {
          before: null,
          after: snapshot("private/journal.md", "dear diary"),
        }),
        moved: {
          ...detail("moved", "rename", {
            before: snapshot("private/moved.md", "was private"),
            after: snapshot("notes/moved.md", "was private"),
          }),
          metadata: { origin: "local-file", summary: renamed },
        },
        notes: detail("notes", "write", { before: null, after: snapshot("notes.md", "plain") }),
      };
      f.capture.listMoments.mockResolvedValue({
        moments: [
          summary("notes", "notes.md"),
          summary("journal", "private/journal.md"),
          {
            ...summary("moved", "notes/moved.md"),
            operation: "rename",
            metadata: { origin: "local-file", summary: renamed },
          },
        ],
        nextCursor: null,
        latestMomentOrder: 1,
        activeVersionId: "main",
        ...historyPageFields,
      });
      f.capture.readMoment.mockImplementation(async (id) => ({
        protected: false,
        moment: details[id]!,
      }));
      await f.create().startDesktopCliServer();
      const token = "a".repeat(64);
      const send = async (request: CliRequestWithoutToken) => {
        const response = cliTransportResponseSchema.parse(
          JSON.parse(
            await handleCliRequestLine(JSON.stringify({ ...request, token }), token, f.options()),
          ) as unknown,
        );
        if (!response.ok) throw new Error(response.error);
        return response.result;
      };
      const cli = (...argv: string[]) => executeCli({ argv, cwd: root, env: {}, request: send });
      // The MCP's dohc_list_changes and dohc_read_change send these as the agent.
      const mcp = <Verb extends "moments" | "moment">(verb: Verb, args: Record<string, unknown>) =>
        send({
          protocolVersion: CLI_PROTOCOL_VERSION,
          verb,
          args: { cwd: root, actor: "agent", ...args },
        } as CliRequestWithoutToken);

      expect((await cli("history", "show", "journal")).stdout).toBe("dear diary");
      f.capture.listVersions.mockResolvedValueOnce({ versions: [], activeVersionId: "draft" });
      expect(await cli("history", "show", "journal")).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "dohc: change not found: journal\n",
      });
      expect(await mcp("moment", { id: "journal" })).toMatchObject({ ok: true });

      await writeFile(
        join(root, ".dohc", "files.toml"),
        '[[rule]]\npath = "private/**"\ntracked = false\n',
      );
      expect(await cli("history", "show", "journal")).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "dohc: change journal is hidden because History no longer tracks its file\n",
      });
      expect(await cli("history", "show", "moved")).toMatchObject({
        exitCode: 1,
        stderr: "dohc: change moved is hidden because History no longer tracks its file\n",
      });
      expect((await cli("history", "show", "notes")).stdout).toBe("plain");
      expect((await cli("history", "list")).stdout).toBe(
        [
          `moved · ${new Date(20).toISOString()} · rename · notes/moved.md`,
          `notes · ${new Date(20).toISOString()} · write · notes.md`,
        ].join("\n") + "\n",
      );
      expect(await mcp("moment", { id: "journal" })).toEqual({
        ok: false,
        status: "untracked",
        reason: "change journal is hidden because History no longer tracks its file",
      });
      expect(await mcp("moment", { id: "moved" })).toEqual({
        ok: false,
        status: "untracked",
        reason: "change moved is hidden because History no longer tracks its file",
      });
      expect(await mcp("moments", {})).toMatchObject({
        changes: [{ id: "moved" }, { id: "notes" }],
        count: 2,
      });
      expect(JSON.stringify(await mcp("moments", { includeFiles: true }))).not.toContain(
        "private/",
      );
      expect((await cli("history", "list", "--json")).stdout).not.toContain("private/");
      expect((await cli("history", "list")).stdout).not.toContain("private/");

      // A policy file dohc cannot read hides all history, as it blocks search.
      await writeFile(join(root, ".dohc", "files.toml"), "[[rule]\n");
      // Unreadable rules hide every change, so the answer names the rules
      // file and no change. An empty list would say there is no History.
      const unreadable = {
        ok: false,
        status: "policy-unreadable",
        unreadable: [".dohc/files.toml"],
        reason: "History is hidden because dohc can't read .dohc/files.toml",
      };
      expect(await mcp("moments", {})).toEqual(unreadable);
      expect(await mcp("moments", { includeFiles: true })).toEqual(unreadable);
      expect(await cli("history", "list")).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "dohc: History is hidden because dohc can't read .dohc/files.toml\n",
      });
      expect(await mcp("moment", { id: "notes" })).toEqual(unreadable);
      expect(await mcp("moment", { id: "no-such-change" })).toEqual(unreadable);
      expect(await cli("history", "show", "notes")).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "dohc: History is hidden because dohc can't read .dohc/files.toml\n",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows versions, a comparison and open conflicts to the CLI and the MCP, only for files History tracks", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-versions-"));
    try {
      await mkdir(join(root, ".dohc"));
      await writeFile(
        join(root, ".dohc", "files.toml"),
        '[[rule]]\npath = "private/**"\ntracked = false\n',
      );
      const f = fixture(root);
      const version = (id: string, name: string, kind: "main" | "named") => ({
        id,
        workspaceId: "workspace",
        kind,
        name,
        createdAtMs: 10,
        ...(kind === "named" ? { forkPoint: { versionId: "main" } } : {}),
      });
      f.capture.listVersions.mockResolvedValue({
        versions: [version("main", "Main", "main"), version("draft", "Draft", "named")],
        activeVersionId: "draft",
      });
      // Each engine page continues after its last path, shown or hidden.
      const pages: Record<string, Awaited<ReturnType<Capture["compareVersions"]>>> = {
        first: {
          files: [
            { path: "keys.env", status: "modified", protected: true },
            { path: "notes.md", status: "modified", currentText: "old", incomingText: "new" },
            { path: "private/journal.md", status: "added", incomingText: "dear diary" },
          ],
          nextAfterPath: "private/journal.md",
        },
        "notes.md": {
          files: [
            { path: "private/journal.md", status: "added", incomingText: "dear diary" },
            { path: "private/later.md", status: "added", incomingText: "later" },
          ],
          nextAfterPath: "private/later.md",
        },
        "private/later.md": {
          files: [{ path: "zeta.md", status: "added", incomingText: "z" }],
          nextAfterPath: null,
        },
      };
      f.capture.compareVersions.mockImplementation(
        async (_id, options) => pages[options?.afterPath ?? "first"]!,
      );
      const side = (path: string, text: string) => ({
        exists: true,
        path,
        contentKind: "text" as const,
        text,
      });
      const conflict = (id: string, path: string, incomingPath = path) => ({
        id,
        workspaceId: "workspace",
        path,
        targetVersionId: "main",
        sourceVersionId: "draft",
        createdAtMs: 10,
        updatedAtMs: 10,
        base: side(path, "base"),
        current: side(path, "mine"),
        incoming: side(incomingPath, "theirs"),
        status: "open" as const,
        chosenFrom: "current" as const,
        metadata: { origin: "local-file" as const },
        waitingVersion: null,
      });
      f.capture.listOpenConflictsPage.mockResolvedValue({
        conflicts: [
          conflict("c1", "notes.md"),
          conflict("c2", "private/journal.md"),
          conflict("c3", "moved.md", "private/moved.md"),
        ],
        nextAfterConflictId: null,
      });
      await f.create().startDesktopCliServer();
      const token = "a".repeat(64);
      const send = async (request: CliRequestWithoutToken) => {
        const response = cliTransportResponseSchema.parse(
          JSON.parse(
            await handleCliRequestLine(JSON.stringify({ ...request, token }), token, f.options()),
          ) as unknown,
        );
        if (!response.ok) throw new Error(response.error);
        return response.result;
      };
      const cli = (...argv: string[]) => executeCli({ argv, cwd: root, env: {}, request: send });
      // The MCP's dohc_list_versions, dohc_compare_version and dohc_list_version_conflicts send these as the agent.
      const mcp = (
        verb: "versionList" | "versionCompare" | "versionConflicts",
        args: Record<string, unknown> = {},
      ) =>
        send({
          protocolVersion: CLI_PROTOCOL_VERSION,
          verb,
          args: { cwd: root, actor: "agent", ...args },
        } as CliRequestWithoutToken);

      expect(await mcp("versionList")).toEqual({
        ok: true,
        activeVersionId: "draft",
        versions: [
          { id: "main", name: "Main", kind: "main", createdAtMs: 10, canMergeIntoMain: false },
          {
            id: "draft",
            name: "Draft",
            kind: "named",
            createdAtMs: 10,
            canMergeIntoMain: true,
            madeFromVersionId: "main",
          },
        ],
      });
      expect((await cli("version", "list")).stdout).toBe(
        "  Main · main\n* Draft · draft · made from Main\n",
      );

      expect((await cli("version", "compare", "Draft")).stdout).toBe(
        "modified · notes.md\nMore files; use --after notes.md\n",
      );
      expect(await mcp("versionCompare", { version: "draft" })).toEqual({
        ok: true,
        version: { id: "draft", name: "Draft" },
        files: [{ path: "notes.md", status: "modified", currentText: "old", incomingText: "new" }],
        nextAfterPath: "notes.md",
      });
      expect((await cli("version", "compare", "Draft", "--after", "notes.md")).stdout).toBe(
        "added · zeta.md\n",
      );
      expect(f.capture.compareVersions).toHaveBeenLastCalledWith("draft", {
        afterPath: "private/later.md",
      });
      expect(await mcp("versionCompare", { version: "Draft", afterPath: "notes.md" })).toEqual({
        ok: true,
        version: { id: "draft", name: "Draft" },
        files: [{ path: "zeta.md", status: "added", incomingText: "z" }],
        nextAfterPath: null,
      });
      expect((await cli("version", "compare", "Draft", "--json")).stdout).not.toMatch(
        /private\/|keys\.env/,
      );
      expect(await cli("version", "compare", "Later")).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "dohc: No version is called Later. Run dohc version list to see them.\n",
      });
      expect(await mcp("versionCompare", { version: "Main" })).toEqual({
        ok: false,
        reason: "Versions compare with Main. Name another version.",
      });

      expect((await cli("version", "conflicts")).stdout).toBe("c1 · merge · notes.md\n");
      expect(await mcp("versionConflicts")).toMatchObject({
        ok: true,
        nextAfterConflictId: null,
        conflicts: [
          {
            conflictId: "c1",
            path: "notes.md",
            currentText: "mine",
            incomingText: "theirs",
            baseText: "base",
          },
        ],
      });
      expect(JSON.stringify(await mcp("versionConflicts"))).not.toContain("private/");
      expect(JSON.stringify(await mcp("versionConflicts"))).not.toContain("waiting");
      const waitingVersion = {
        code: "resolve-existing-conflict" as const,
        objectId: "notes-object",
        originId: "computer-d",
        originSeq: 4,
      };
      const held = {
        conflicts: [
          {
            ...conflict("c1", "notes.md", "moved/notes.md"),
            metadata: { origin: "sync" as const },
            waitingVersion,
          },
        ],
        nextAfterConflictId: null,
      };
      f.capture.listOpenConflictsPage.mockResolvedValueOnce(held);
      expect(await mcp("versionConflicts")).toMatchObject({
        ok: true,
        conflicts: [
          {
            conflictId: "c1",
            origin: "sync",
            waiting: {
              code: "resolve-existing-conflict",
              message:
                "A newer version of notes.md from another computer is waiting. It comes in after this conflict is resolved.",
              objectId: "notes-object",
              originId: "computer-d",
              originSeq: 4,
            },
          },
        ],
      });
      f.capture.listOpenConflictsPage.mockResolvedValueOnce(held);
      expect(JSON.stringify(await mcp("versionConflicts"))).not.toContain("waitingVersion");
      f.capture.listOpenConflictsPage.mockResolvedValueOnce(held);
      expect((await cli("version", "conflicts")).stdout).toBe(
        "c1 · sync · notes.md\n  A newer version from another computer is waiting. It comes in after you resolve this conflict.\n",
      );
      f.capture.listOpenConflictsPage.mockResolvedValueOnce({
        conflicts: [],
        nextAfterConflictId: null,
      });
      expect(await mcp("versionConflicts")).toEqual({
        ok: true,
        conflicts: [],
        nextAfterConflictId: null,
      });

      await writeFile(join(root, ".dohc", "files.toml"), "[[rule]\n");
      expect(await mcp("versionCompare", { version: "Draft" })).toEqual({
        ok: false,
        status: "policy-unreadable",
        unreadable: [".dohc/files.toml"],
        reason: "Version files are hidden because dohc can't read .dohc/files.toml",
      });
      expect(await cli("version", "conflicts")).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "dohc: Conflicts are hidden because dohc can't read .dohc/files.toml\n",
      });
      expect((await cli("version", "list")).stdout).toBe(
        "  Main · main\n* Draft · draft · made from Main\n",
      );

      vi.mocked(f.dependencies.sharedViewOf).mockReturnValue({});
      expect(await mcp("versionList")).toEqual({
        ok: false,
        reason: "Versions belong to the owning workspace. Open it to continue.",
      });
      const agent = (
        verb: "keptCopies" | "saveKeptCopy" | "retainedCopies" | "deleteRetainedCopies",
        args: Record<string, unknown> = {},
      ) =>
        send({
          protocolVersion: CLI_PROTOCOL_VERSION,
          verb,
          args: { cwd: root, actor: "agent", ...args },
        } as CliRequestWithoutToken);
      const kept = { ok: false, reason: "kept copies are not available in this workspace" };
      const old = {
        ok: false,
        reason: "Old file copies are kept only in the owning workspace. Open it to continue.",
      };
      expect(await agent("keptCopies")).toEqual(kept);
      expect(await agent("saveKeptCopy", { id: 1 })).toEqual(kept);
      expect(await agent("retainedCopies")).toEqual(old);
      expect(
        await agent("deleteRetainedCopies", {
          copies: [{ id: 3, revision: 10 }],
          acceptLateWriteRisk: true,
        }),
      ).toEqual(old);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates, switches, merges and resolves versions for the CLI and the MCP, after the windows save their edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-version-writes-"));
    try {
      await mkdir(join(root, ".dohc"));
      await writeFile(
        join(root, ".dohc", "files.toml"),
        '[[rule]]\npath = "private/**"\ntracked = false\n',
      );
      const f = fixture(root);
      // The round as main runs it, recording what each change tells the windows.
      const rounds: Array<{ workspaceId: string; told: { activeVersionId?: string } | null }> = [];
      f.dependencies.versionRound = async (workspaceId, change, announce) => {
        try {
          const result = await change();
          rounds.push({ workspaceId, told: announce.done(result) });
          return result;
        } catch (error) {
          rounds.push({ workspaceId, told: announce.failed ?? null });
          throw error;
        }
      };
      const version = (id: string, name: string, kind: "main" | "named", forkedFrom = "main") => ({
        id,
        workspaceId: "workspace",
        kind,
        name,
        createdAtMs: 10,
        ...(kind === "named" ? { forkPoint: { versionId: forkedFrom } } : {}),
      });
      f.capture.listVersions.mockResolvedValue({
        activeVersionId: "main",
        versions: [
          version("main", "Main", "main"),
          version("draft", "Draft", "named"),
          version("nested", "Nested", "named", "draft"),
        ],
      });
      const text = (path: string, value: string) => ({
        exists: true,
        path,
        contentKind: "text" as const,
        text: value,
      });
      const binary = (path: string) => ({
        exists: true,
        path,
        contentKind: "binary" as const,
        sha256: "a".repeat(64),
        byteLength: 5,
      });
      const conflict = (id: string, path: string, side: typeof text | typeof binary = text) => ({
        id,
        workspaceId: "workspace",
        path,
        targetVersionId: "main",
        sourceVersionId: "draft",
        createdAtMs: 10,
        updatedAtMs: 10,
        base: side(path, "base"),
        current: side(path, "mine"),
        incoming: side(path, "theirs"),
        status: "open" as const,
        chosenFrom: "current" as const,
        metadata: { origin: "local-file" as const },
        waitingVersion: null,
      });
      const open = {
        conflicts: [
          conflict("c1", "notes.md"),
          conflict("c2", "logo.png", binary),
          conflict("c3", "private/journal.md"),
        ],
        nextAfterConflictId: null,
      };
      f.capture.listOpenConflictsPage.mockResolvedValue(open);
      await f.create().startDesktopCliServer();
      const token = "a".repeat(64);
      const send = async (request: CliRequestWithoutToken) => {
        const response = cliTransportResponseSchema.parse(
          JSON.parse(
            await handleCliRequestLine(JSON.stringify({ ...request, token }), token, f.options()),
          ) as unknown,
        );
        if (!response.ok) throw new Error(response.error);
        return response.result;
      };
      const cli = (...argv: string[]) => executeCli({ argv, cwd: root, env: {}, request: send });
      const mcp = (
        verb: "versionCreate" | "versionSwitch" | "versionMerge" | "versionResolve",
        args: Record<string, unknown>,
      ) =>
        send({
          protocolVersion: CLI_PROTOCOL_VERSION,
          verb,
          args: { cwd: root, actor: "agent", ...args },
        } as CliRequestWithoutToken);

      expect((await cli("version", "create", "Ideas")).stdout).toBe(
        "Created and switched to Ideas · created\n",
      );
      expect(f.capture.createVersion).toHaveBeenCalledWith("Ideas");
      expect(rounds.at(-1)).toEqual({
        workspaceId: "workspace",
        told: { activeVersionId: "created" },
      });
      f.capture.createVersion.mockRejectedValueOnce(
        new VersionedTextStoreError("version-name-conflict", "version-name-conflict"),
      );
      expect(await mcp("versionCreate", { name: "Draft" })).toEqual({
        ok: false,
        reason: "Another version is called Draft. Choose another name.",
      });
      // Each change closes the editors' documents before it can fail, so a
      // failed one tells the windows to look again.
      expect(rounds.at(-1)!.told).toEqual({});

      expect((await cli("version", "switch", "Draft")).stdout).toBe(
        "Switched to Draft · 2 files changed\n",
      );
      expect(f.capture.switchVersion).toHaveBeenCalledWith("draft");
      expect(rounds.at(-1)!.told).toEqual({ activeVersionId: "draft" });
      // The active version needs no switch, and the windows hear nothing.
      const roundsBefore = rounds.length;
      expect(await mcp("versionSwitch", { version: "main" })).toEqual({
        ok: true,
        version: { id: "main", name: "Main" },
        changedFileCount: 0,
      });
      expect(rounds).toHaveLength(roundsBefore);
      f.capture.switchVersion.mockRejectedValueOnce(new Error("The engine stopped."));
      expect(await mcp("versionSwitch", { version: "Draft" })).toEqual({
        ok: false,
        reason: "The engine stopped.",
      });
      expect(rounds.at(-1)!.told).toEqual({});

      expect(await mcp("versionMerge", { version: "Main" })).toEqual({
        ok: false,
        reason: "Versions merge into Main. Name another version.",
      });
      expect(await mcp("versionMerge", { version: "Nested" })).toEqual({
        ok: false,
        reason: "Only versions made from Main can merge into Main.",
      });
      expect(await mcp("versionMerge", { version: "Later" })).toEqual({
        ok: false,
        reason: "No version is called Later. Run dohc version list to see them.",
      });
      expect(f.capture.mergeVersionIntoMain).not.toHaveBeenCalled();
      f.capture.mergeVersionIntoMain.mockResolvedValueOnce({
        mergedFileCount: 3,
        unchangedFileCount: 1,
        conflictCount: 3,
        replacedProtectedPaths: [],
      });
      expect((await cli("version", "merge", "Draft")).stdout).toBe(
        "Merged Draft into Main · 3 files merged · 3 conflicts\nc1 · merge · notes.md\nc2 · merge · logo.png · binary\n",
      );
      expect(rounds.at(-1)!.told).toEqual({});
      f.capture.mergeVersionIntoMain.mockRejectedValueOnce(new Error("The engine stopped."));
      expect(await mcp("versionMerge", { version: "Draft" })).toEqual({
        ok: false,
        reason: "The engine stopped.",
      });
      expect(rounds.at(-1)!.told).toEqual({});

      expect(
        await mcp("versionResolve", { conflictId: "c3", resolution: { keep: "current" } }),
      ).toEqual({
        ok: false,
        reason: "No open conflict has the ID c3. Run dohc version conflicts to see them.",
      });
      expect(
        await mcp("versionResolve", {
          conflictId: "c2",
          resolution: { keep: "combined", text: "both" },
        }),
      ).toEqual({
        ok: false,
        reason:
          "This conflict is between binary files, so it takes no combined text. Keep current or incoming.",
      });
      expect(f.capture.resolveConflict).not.toHaveBeenCalled();
      await cli("version", "resolve", "c2", "--keep", "incoming");
      expect(f.capture.resolveConflict).toHaveBeenLastCalledWith("c2", { kind: "apply-incoming" });
      f.capture.listOpenConflictsPage.mockResolvedValueOnce(open).mockResolvedValueOnce({
        conflicts: [conflict("c2", "logo.png", binary)],
        nextAfterConflictId: null,
      });
      expect((await cli("version", "resolve", "c1", "--text", "mine and theirs")).stdout).toBe(
        "c2 · merge · logo.png · binary\n",
      );
      expect(f.capture.resolveConflict).toHaveBeenLastCalledWith("c1", {
        kind: "apply-merged",
        text: "mine and theirs",
      });
      expect(f.dependencies.notifyNoticesChanged).toHaveBeenCalled();
      expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({ workspaceId: "workspace" });
      f.capture.resolveConflict.mockRejectedValueOnce(new Error("The engine stopped."));
      expect(
        await mcp("versionResolve", { conflictId: "c1", resolution: { keep: "current" } }),
      ).toEqual({ ok: false, reason: "The engine stopped." });
      expect(rounds.at(-1)!.told).toEqual({});

      f.dependencies.versionRound = async () => {
        throw new Error("A Collection write failed. Try again.");
      };
      await f.create().startDesktopCliServer();
      expect(await cli("version", "switch", "Draft")).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "dohc: A Collection write failed. Try again.\n",
      });

      vi.mocked(f.dependencies.sharedViewOf).mockReturnValue({});
      expect(await mcp("versionCreate", { name: "Ideas" })).toEqual({
        ok: false,
        reason: "Versions belong to the owning workspace. Open it to continue.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs collection fields through physical admission and the existing Y.Doc edit", async () => {
    // A field write first reads its record to check it is not a lossy note.
    const root = await createTestScratch("dohc-cli-fields-");
    await mkdir(join(root, "tasks"));
    await writeFile(join(root, "tasks", "one.md"), "# One\n");
    const f = fixture(root);
    const doc = new Y.Doc();
    const events: string[] = [];
    const session = {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      applyDecidedLocalUpdate: async (
        decide: (doc: Y.Doc) => Uint8Array | null,
        armed?: () => void,
      ) => {
        const update = decide(doc);
        if (update === null) return false;
        Y.applyUpdate(doc, update);
        events.push("apply");
        armed?.();
        return true;
      },
      settleNow: async () => {
        events.push("settle");
        return { materialized: true };
      },
      close: async () => {
        events.push("close");
      },
    } as unknown as WorkspaceEngineYDocProviderSession;
    const admitted: symbol[] = [];
    const opened = vi.fn(async () => session);
    f.dependencies.collectionEditContextFor = async (operation, person, signal) => {
      operation.assertCurrent();
      admitted.push(operation.workspace.attachmentId);
      return desktopRecordEditContext({
        person,
        workspaceRoot: operation.workspace.rootPath,
        capture: { openRecordSession: opened, writeAuthoredFile: vi.fn() },
        withAdapter: async () => null,
        onCaptureSettled: () => () => undefined,
        signal,
      });
    };
    const context = await f.create().openCliWorkspace(f.workspace);
    try {
      expect(
        await context.collections!.writes.setFields({
          recordPath: "tasks/one.md",
          fields: { status: "done" },
          author: { kind: "user", userId: "owner" },
        }),
      ).toEqual({ path: "tasks/one.md", replaced: { status: null }, kept: {} });
      expect(doc.getMap("frontmatter").get("status")).toBe("done");
      expect(events).toEqual(["apply", "settle", "close"]);
      await expect(
        context.collections!.writes.createRecord({
          collectionPath: "tasks",
          name: "../bad",
          author: { kind: "user", userId: "owner" },
        }),
      ).rejects.toThrow("plain file name");
      expect(admitted).toHaveLength(2);
      expect(admitted[0]).toBe(admitted[1]);
      expect(opened).toHaveBeenCalledOnce();
    } finally {
      doc.destroy();
      await f.authorities.close();
    }
  });

  it("reads a lossy note as its file, and refuses to edit it before any session opens", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-lossy-"));
    const lossy =
      "# Readme\n\n<details>\n<summary>More</summary>\n\nHidden.\n</details>\n\nSee [the docs][docs].\n\n[docs]: https://example.com/docs\n";
    try {
      await writeFile(join(root, "readme.md"), lossy);
      await writeFile(join(root, "plan.md"), "# Plan\n\nText.\n");
      const f = fixture(root);
      const context = await f.create().openCliWorkspace(f.workspace);
      vi.mocked(f.dependencies.liveDocuments.readDocument).mockResolvedValueOnce({
        path: "readme.md",
        state: Y.encodeStateAsUpdate(markdownToYDoc(lossy)),
      });
      expect(await context.documents!.read("readme.md")).toEqual({
        path: "readme.md",
        markdown: lossy,
      });
      vi.mocked(f.dependencies.liveDocuments.readDocument).mockResolvedValueOnce({
        path: "draft.md",
        state: Y.encodeStateAsUpdate(markdownToYDoc("# Draft")),
      });
      expect(await context.documents!.read("draft.md")).toEqual({
        path: "draft.md",
        markdown: "# Draft\n",
      });

      const origin = {
        attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 0 },
      };
      await context.documents!.edit({
        path: "readme.md",
        edit: { find: "Hidden.", replacement: "Shown." },
        origin,
      });
      const [input] = vi.mocked(f.dependencies.liveDocuments.editDocument).mock.calls[0]!;
      await expect(input.assertEditable("readme.md")).rejects.toThrow(
        "dohc can't change readme.md without also changing parts it can't show, such as raw HTML or reference links. Edit the file directly instead.",
      );
      await expect(input.assertEditable("plan.md")).resolves.toBeUndefined();
      await mkdir(join(root, "folder.md"));
      await expect(input.assertEditable("folder.md")).rejects.toThrow(
        "dohc couldn't read folder.md to check it, so nothing changed. Try again.",
      );
      // At the turn that changes it, the session's own document is judged: a
      // file replaced after the read can't slip through.
      const sha = (text: string) => createHash("sha256").update(text).digest("hex");
      const session = markdownToYDoc(lossy);
      session.getMap("meta").set("dohcMarkdownSource", lossy);
      session.getMap("meta").set("dohcMarkdownSourceSha256", sha(lossy));
      session
        .getMap("meta")
        .set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(session)));
      await expect(
        input.change(Y.encodeStateAsUpdate(session), { keepBlocks: true, headSha256: sha(lossy) }),
      ).rejects.toThrow("dohc can't change readme.md without also changing parts it can't show");
      expect(await readFile(join(root, "readme.md"), "utf8")).toBe(lossy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the authoritative head for an edited witness and forwards explicit consent with an absent head", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-consent-"));
    const source = "# Readme\n\n<details>Hidden.</details>\n\nEditable.\n";
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const doc = markdownToYDoc(source);
    doc.getMap("meta").set("dohcMarkdownSource", source);
    doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(source));
    doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
    Y.applyUpdate(
      doc,
      documentEditUpdate(
        Y.encodeStateAsUpdate(doc),
        { replacement: "Unsettled tail." },
        { keepBlocks: true },
      )!,
    );
    try {
      await writeFile(join(root, "readme.md"), source);
      const f = fixture(root);
      const context = await f.create().openCliWorkspace(f.workspace);
      const origin = {
        attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 0 },
      };
      const edit = {
        path: "readme.md",
        edit: { find: "Editable.", replacement: "Changed." },
        origin,
      };
      await context.documents!.edit(edit);
      const [guarded] = vi.mocked(f.dependencies.liveDocuments.editDocument).mock.calls[0]!;
      const state = Y.encodeStateAsUpdate(doc);
      for (const headSha256 of [null, sha(source)]) {
        await expect(guarded.change(state, { keepBlocks: true, headSha256 })).rejects.toThrow(
          "parts it can't show",
        );
      }
      const converted = await guarded.change(state, {
        keepBlocks: true,
        headSha256: sha("converted head"),
      });
      expect(converted).toBeInstanceOf(Uint8Array);
      await expect(guarded.change(state, { keepBlocks: true })).rejects.toThrow(
        "dohc is still checking readme.md for parts it can't show, so nothing changed. Try again in a moment.",
      );

      await context.documents!.edit({ ...edit, allowLossySourceSha256: sha(source) });
      const [consented] = vi.mocked(f.dependencies.liveDocuments.editDocument).mock.calls[1]!;
      expect(consented.allowLossySourceSha256).toBe(sha(source));
      await expect(consented.assertEditable("readme.md")).resolves.toBeUndefined();
      const update = await consented.change(state, { keepBlocks: true, headSha256: null });
      Y.applyUpdate(doc, update!);
      expect(yDocToMarkdown(doc)).toContain("Changed.");
      expect(await readFile(join(root, "readme.md"), "utf8")).toBe(source);

      await writeFile(join(root, "readme.md"), source.replace("Hidden.", "Another source."));
      await expect(consented.assertEditable("readme.md")).rejects.toThrow("parts it can't show");
    } finally {
      doc.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hands a document edit to the live sessions as an update against their state", async () => {
    const f = fixture();
    const edit = vi.mocked(f.dependencies.liveDocuments.editDocument);
    const context = await f.create().openCliWorkspace(f.workspace);
    const origin = {
      attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 0 },
    };
    await context.documents!.edit({
      path: "notes.md",
      edit: { find: "Draft", replacement: "Final" },
      origin,
    });
    const [input] = edit.mock.calls[0]!;
    expect(input).toMatchObject({ workspaceId: "workspace", path: "notes.md", origin });
    const current = markdownToYDoc("Draft plan.");
    Y.applyUpdate(
      current,
      (await input.change(Y.encodeStateAsUpdate(current), { keepBlocks: true, headSha256: null }))!,
    );
    expect(documentMarkdown(Y.encodeStateAsUpdate(current))).toBe("Final plan.\n");
    expect(
      await input.change(Y.encodeStateAsUpdate(markdownToYDoc("Draft plan.")), {
        keepBlocks: true,
      }),
    ).toBeInstanceOf(Uint8Array);
    await expect(
      input.change(Y.encodeStateAsUpdate(markdownToYDoc("Final plan.")), {
        keepBlocks: true,
        headSha256: null,
      }),
    ).rejects.toThrow("not in the document");
  });

  it("creates a document as an empty file, then writes its text through the live session", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-create-"));
    try {
      await writeFile(join(root, "taken.md"), "Already here.\n");
      const f = fixture(root);
      const edit = vi.mocked(f.dependencies.liveDocuments.editDocument);
      const created = new Map<string, Y.Doc>();
      edit.mockImplementation(async (input) => {
        expect(await readFile(join(root, input.path), "utf8")).toBe("");
        const doc = new Y.Doc();
        const update = await input.change(Y.encodeStateAsUpdate(doc), { keepBlocks: false });
        if (update) Y.applyUpdate(doc, update);
        created.set(input.path, doc);
        return { path: input.path, changed: update !== null };
      });
      const context = await f.create().openCliWorkspace(f.workspace);
      const origin = {
        attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 0 },
      };

      await expect(
        context.documents!.create({
          path: "notes/new.md",
          markdown: "# New\n\nFirst line.",
          origin,
        }),
      ).resolves.toEqual({ path: "notes/new.md" });
      expect(documentMarkdown(Y.encodeStateAsUpdate(created.get("notes/new.md")!))).toBe(
        "# New\n\nFirst line.\n",
      );
      expect(edit.mock.calls[0]![0]).toMatchObject({
        workspaceId: "workspace",
        path: "notes/new.md",
        origin,
      });
      const write = vi.mocked(f.capture.writeAuthoredFile);
      expect(write.mock.calls[0]).toEqual([
        join(root, "notes/new.md"),
        "",
        { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local" },
        { createOnly: true },
      ]);
      await context.documents!.create({
        path: "named.md",
        markdown: "Hi.",
        origin: { ...origin, actorOriginId: "Codex" },
      });
      expect(write.mock.calls[1]![2]).toEqual({
        kind: "agent",
        agentId: "Codex",
        onBehalfOf: "person-local",
      });
      // During a run an automation started, the file names the run's depth,
      // so a record it adds carries the chain on; with no name, the MCP
      // server's agent authors it.
      const woken = {
        attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 3 },
      };
      await context.documents!.create({ path: "woken.md", markdown: "Hi.", origin: woken });
      expect(write.mock.calls[2]![2]).toEqual({
        kind: "agent",
        agentId: "dohc-mcp",
        onBehalfOf: "person-local",
        depth: 3,
      });
      await context.documents!.create({
        path: "woken-named.md",
        markdown: "Hi.",
        origin: { ...woken, actorOriginId: "Codex" },
      });
      expect(write.mock.calls[3]![2]).toEqual({
        kind: "agent",
        agentId: "Codex",
        onBehalfOf: "person-local",
        depth: 3,
      });
      // A file written in a run names that run, so two runs stay two authors.
      const inRun = {
        actorOriginId: "Codex",
        attribution: { ...woken.attribution, agentRunId: "run-1" },
      };
      await context.documents!.create({ path: "in-run.md", markdown: "Hi.", origin: inRun });
      expect(write.mock.calls[4]![2]).toEqual({
        kind: "agent",
        agentId: "Codex",
        onBehalfOf: "person-local",
        depth: 3,
        agentRunId: "run-1",
      });

      await expect(
        context.documents!.create({ path: "taken.md", markdown: "x", origin }),
      ).rejects.toThrow("taken.md already exists. Edit it instead.");
      expect(await readFile(join(root, "taken.md"), "utf8")).toBe("Already here.\n");

      edit.mockRejectedValueOnce(new Error("engine busy"));
      await expect(
        context.documents!.create({ path: "later.md", markdown: "Text", origin }),
      ).rejects.toThrow(
        "dohc created later.md, but could not write its text (engine busy). Edit the document to add it.",
      );
      expect(await readFile(join(root, "later.md"), "utf8")).toBe("");
      // Five creates wrote their text, and later.md tried once.
      expect(edit).toHaveBeenCalledTimes(6);

      const race = await Promise.allSettled([
        context.documents!.create({ path: "race.md", markdown: "First.", origin }),
        context.documents!.create({ path: "race.md", markdown: "Second.", origin }),
      ]);
      expect(race.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(race.find((outcome) => outcome.status === "rejected")).toMatchObject({
        reason: expect.objectContaining({ message: "race.md already exists. Edit it instead." }),
      });

      const writes = write.mock.calls.length;
      await expect(
        context.documents!.create({ path: "front.md", markdown: "---\n{}\n---\n\nBody.", origin }),
      ).rejects.toThrow("A new document starts without frontmatter.");
      await expect(lstat(join(root, "front.md"))).rejects.toThrow();
      expect(write.mock.calls.length).toBe(writes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a collection edit whose admitted physical workspace retires while its context opens", async () => {
    const f = fixture();
    const held = deferred();
    const entered = deferred();
    const opened = vi.fn();
    f.dependencies.collectionEditContextFor = async (
      operation,
      person,
      signal,
    ): Promise<CollectionRecordEditContext> => {
      entered.release();
      await held.promise;
      operation.assertCurrent();
      return desktopRecordEditContext({
        person,
        workspaceRoot: operation.workspace.rootPath,
        capture: { openRecordSession: opened, writeAuthoredFile: vi.fn() },
        withAdapter: async () => null,
        onCaptureSettled: () => () => undefined,
        signal,
      });
    };
    const context = await f.create().openCliWorkspace(f.workspace);
    const result = context
      .collections!.writes.setFields({
        recordPath: "tasks/one.md",
        fields: { status: "done" },
        author: { kind: "user", userId: "owner" },
      })
      .catch((error: unknown) => error);
    let drained: Promise<void> | undefined;
    try {
      await entered.promise;
      drained = f.authorities.invalidate("workspace");
      f.rows.set("workspace", { ...f.workspace });
    } finally {
      held.release();
      await result;
      await drained;
    }
    expect(await result).toMatchObject({
      message: expect.stringContaining("This workspace was closed. Open it again."),
    });
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("raw fileWrite socket requests", () => {
  async function setup() {
    const root = await createTestScratch("dohc-cli-file-write-");
    const f = fixture(root);
    await f.create().startDesktopCliServer();
    const invoke = async (files: CliFileWrite[], actor = "agent", agent?: string) => {
      const line = await handleCliRequestLine(
        JSON.stringify({
          token: "a".repeat(64),
          protocolVersion: CLI_PROTOCOL_VERSION,
          verb: "fileWrite",
          args: { cwd: root, actor, agent, requestId: "raw", files },
        }),
        "a".repeat(64),
        f.options(),
      );
      const transport = cliTransportResponseSchema.parse(JSON.parse(line));
      return transport.ok
        ? parseCliResult("fileWrite", transport.result)
        : { ok: false, reason: transport.error };
    };
    return { ...f, invoke };
  }

  it("refuses excluded paths and aliases through raw requests", async () => {
    const f = await setup();
    await mkdir(join(f.workspace.rootPath, ".dohc"), { recursive: true });
    await writeFile(
      join(f.workspace.rootPath, ".dohc/files.toml"),
      '[[rule]]\npath = "hidden.txt"\ntracked = false\n',
    );
    for (const name of ["hidden.txt", ".env", "notes.md", "scene.excalidraw"]) {
      await writeFile(join(f.workspace.rootPath, name), "original");
      const alias = name.replaceAll(".", "_") + ".txt";
      await symlink(join(f.workspace.rootPath, name), join(f.workspace.rootPath, alias));
      expect(await f.invoke([{ path: alias, contentBase64: "bmV3" }])).toMatchObject({ ok: false });
      expect(await readFile(join(f.workspace.rootPath, name), "utf8")).toBe("original");
    }
    expect(await f.invoke([{ path: "hidden.txt", contentBase64: "bmV3" }])).toMatchObject({
      ok: false,
    });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it("writes for an agent in a workspace opened through a link", async () => {
    const real = await createTestScratch("dohc-cli-linked-real-");
    const opened = join(await createTestScratch("dohc-cli-linked-"), "linked");
    await symlink(real, opened, process.platform === "win32" ? "junction" : "dir");
    const registered = await createWorkspaceFolder({
      rootPath: opened,
      homeDir: await createTestScratch("dohc-cli-linked-home-"),
      stateDir: await createTestScratch("dohc-cli-linked-state-"),
      kind: "personal",
      computer: { installId: "install-here", label: "This Mac" },
    });
    // The authority resolves roots the way main does.
    const f = fixture(registered.rootPath, (root) => realpathSync.native(root));
    await f.create().startDesktopCliServer();
    const line = await handleCliRequestLine(
      JSON.stringify({
        token: "a".repeat(64),
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "fileWrite",
        args: {
          cwd: opened,
          actor: "agent",
          requestId: "linked",
          files: [{ path: "plain.txt", contentBase64: "bmV3" }],
        },
      }),
      "a".repeat(64),
      f.options(),
    );
    const transport = cliTransportResponseSchema.parse(JSON.parse(line));
    expect(transport.ok ? parseCliResult("fileWrite", transport.result) : transport.error).toEqual({
      ok: true,
      written: ["plain.txt"],
    });
    expect(await readFile(join(real, "plain.txt"), "utf8")).toBe("new");
  });
});

describe("raw fileMove and fileDelete socket requests", () => {
  async function setup(configure?: (f: ReturnType<typeof fixture>) => void) {
    const root = await createTestScratch("dohc-cli-file-move-");
    await openedLocalState({ workspaceId: "workspace", rootPath: root });
    const f = fixture(root);
    configure?.(f);
    await f.create().startDesktopCliServer();
    const invoke = async (
      verb: "fileMove" | "fileDelete",
      args: Record<string, unknown>,
      actor = "agent",
    ) => {
      const line = await handleCliRequestLine(
        JSON.stringify({
          token: "a".repeat(64),
          protocolVersion: CLI_PROTOCOL_VERSION,
          verb,
          args: { cwd: root, actor, requestId: "raw", ...args },
        }),
        "a".repeat(64),
        f.options(),
      );
      const transport = cliTransportResponseSchema.parse(JSON.parse(line));
      return transport.ok
        ? parseCliResult(verb, transport.result)
        : { ok: false, reason: transport.error };
    };
    return { ...f, root, invoke };
  }

  it("saves recovery and restores a delete retired between the trash move and markDeleted", async () => {
    const f = await setup();
    await mkdir(join(f.root, "folder"));
    await writeFile(join(f.root, "folder/tracked.txt"), "tracked original");
    const rowless = Buffer.from([0xff, 0x00, 0xfe]);
    await writeFile(join(f.root, "folder/rowless.bin"), rowless);
    let drained: Promise<void> | undefined;
    let attachmentId: symbol | undefined;
    vi.mocked(f.capture.changePathsAs).mockImplementation(async (_paths, _authored, work) =>
      work({
        policy: await readWorkspaceEnginePolicy(f.root),
        readDuplicate: async () => null,
        hasPath: async () => false,
        duplicateFile: async () => {
          throw new Error("unexpected Duplicate");
        },
        recordDisk: async () => ["folder/tracked.txt"],
        delete: async () => {
          await expect(lstat(join(f.root, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
          attachmentId = f.authorities.currentBinding(f.workspace.workspaceId).attachmentId;
          drained = f.authorities.invalidate(f.workspace.workspaceId);
          return "delete-moment";
        },
        moveFile: async () => false,
        rename: async () => undefined,
        undoDelete: async () => undefined,
      }),
    );
    const history = {
      readHistoryPage: vi.fn(async () => ({
        moments: [{ momentId: "delete-moment", operation: "delete", path: "folder/tracked.txt" }],
        protectedMoments: [],
        nextCursor: null,
      })),
      undoHistoryOperation: vi.fn(async (input: { operationId: string }) => {
        await mkdir(join(f.root, "folder"), { recursive: true });
        await writeFile(join(f.root, "folder/tracked.txt"), "tracked original");
        return {
          operationId: input.operationId,
          versionId: "main",
          momentCount: 1,
          notRestored: [],
          compensationOperationId: "dohc-operation:11111111-1111-4111-8111-111111111111",
          deduped: false,
          materialized: true,
        };
      }),
    };
    f.dependencies.withEngineAdapter = async (_workspace, work) =>
      work(history as unknown as VersionedLiveAdapter);
    try {
      const result = await f.invoke("fileDelete", { path: "folder" });
      expect(result).toMatchObject({
        ok: true,
        operationId: expect.stringMatching(/^dohc-operation:/),
        undo: { available: true },
      });
      if (!result.ok || !("operationId" in result) || typeof result.operationId !== "string")
        throw new Error("Delete returned no operation id");
      const { operationId } = result;
      await drained;
      await waitForRecovery(operationId);
      const record = await readDeleteRecovery(f.root, operationId);
      expect(record).toMatchObject({
        tracked: true,
        paths: ["folder/rowless.bin"],
        staged: expect.any(String),
      });
      expect(
        await readFile(join(f.root, ".dohc/local/trash", record!.staged!, "rowless.bin")),
      ).toEqual(rowless);
      expect(f.dependencies.markDeletedUnderPath).toHaveBeenCalledWith(attachmentId, "folder");
      expect(f.dependencies.trashItem).toHaveBeenCalledOnce();
      const reopened = await f.create().openCliWorkspace(f.workspace);
      expect(
        await reopened.historyUndo!(
          { operationId },
          { attribution: { actorKind: "agent", onBehalfOf: "person-local" } },
        ),
      ).toMatchObject({
        ok: true,
        tracked: { state: "restored", momentCount: 1 },
        restored: ["folder/rowless.bin"],
        remaining: [],
      });
      expect(history.undoHistoryOperation).toHaveBeenCalledOnce();
      expect(await readFile(join(f.root, "folder/tracked.txt"), "utf8")).toBe("tracked original");
      expect(await readFile(join(f.root, "folder/rowless.bin"))).toEqual(rowless);
    } finally {
      await drained;
      await f.authorities.close();
    }
  });

  it("refuses traversal, reserved, secret, and excluded paths, spelled or inside a folder", async () => {
    const f = await setup();
    await writeFile(
      join(f.root, ".dohc/files.toml"),
      '[[rule]]\npath = "hidden/**"\ntracked = false\n',
    );
    await mkdir(join(f.root, "hidden"));
    await writeFile(join(f.root, "hidden/a.txt"), "hidden");
    await mkdir(join(f.root, "app"));
    await writeFile(join(f.root, "app/.env"), "TOKEN=1");
    await writeFile(join(f.root, "plain.txt"), "original");
    for (const path of ["../escape.txt", ".dohc/files.toml", ".env", "hidden", "app"]) {
      expect(await f.invoke("fileDelete", { path })).toMatchObject({ ok: false });
      expect(await f.invoke("fileMove", { fromPath: path, toPath: "elsewhere" })).toMatchObject({
        ok: false,
      });
      expect(
        await f.invoke("fileMove", {
          fromPath: "plain.txt",
          toPath: path === "app" ? "app/.env" : path,
        }),
      ).toMatchObject({ ok: false });
    }
    expect(await readFile(join(f.root, "app/.env"), "utf8")).toBe("TOKEN=1");
    expect(await readFile(join(f.root, "hidden/a.txt"), "utf8")).toBe("hidden");
    expect(await readFile(join(f.root, "plain.txt"), "utf8")).toBe("original");
  });
});

// Exercise both agent doors through desktop attachment admission and the real relay copy route.
afterEach(closeTestStorages);
async function shareCopyFixture() {
  const root = await createTestScratch("dohc-cli-share-copy-");
  const f = fixture(root);
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 });
  storage.claimWorkspace({ workspaceId: "other-workspace", ownerUserId: "owner", createdAtMs: 1 });
  const share = {
    shareId: "share",
    workspaceId: "workspace",
    granterUserId: "owner",
    selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
    createdAtMs: 1,
  };
  const grant = {
    grantId: "grant",
    shareId: "share",
    principalKind: "user" as const,
    principalUserId: "friend",
    principalEmail: null,
    access: "edit",
    generation: 1,
    status: "active" as const,
    createdAtMs: 1,
    revokedAtMs: null,
    parentGrantId: null,
  };
  storage.createShare({ share, grant });
  storage.createShare({
    share: { ...share, shareId: "foreign", workspaceId: "other-workspace" },
    grant: { ...grant, shareId: "foreign", grantId: "foreign-grant" },
  });
  const handler = testHandler(storage, {
    relayExchangeKey: RELAY_EXCHANGE_KEY,
    namedBrowserSessionLimits: {
      maxSessions: 8,
      retentionMs: 30000,
      maxPendingRequests: 4,
      maxRequestBytes: 16384,
      maxResponseBytes: 16384,
      timeoutMs: 1000,
    },
  });
  let credentials: CloudCredentials = {
    serverUrl: "https://cloud.test",
    relayUrl: "https://relay.test",
    userId: "owner",
    email: "owner@test",
    token: "secret",
  };
  let generation = 1;
  const remote = vi.fn(async (workspace: RegistryEntry) => {
    if (!workspaceRemoteMatchesCredentials(workspace.remote!, credentials))
      throw Error("Sign in to the account that synced this workspace.");
    return { credentials, credentialGeneration: generation };
  });
  const relay = vi.fn(async (account: CloudCredentials, path: string) => {
    const response = await handler(relayRequest(account.userId, path));
    if (!response.ok)
      throw Error(
        response.status === 404 ? "Share not found." : "Relay failure: " + response.status,
      );
    return response.json();
  });
  f.dependencies.shareCopy = createShareCopyReader({
    remoteForWorkspace: remote,
    currentCredentialGeneration: () => generation,
    relayJson: relay,
  });
  await f.create().startDesktopCliServer();
  const transport = async (input: CliRequestWithoutToken) => {
    const line = await handleCliRequestLine(
      JSON.stringify({ ...input, token: "a".repeat(64) }),
      "a".repeat(64),
      f.options(),
    );
    const response = cliTransportResponseSchema.parse(JSON.parse(line));
    if (!response.ok) throw Error(response.error);
    return response.result;
  };
  const copy = async (door: "cli" | "mcp", shareId = "share", grantId = "grant") => {
    if (door === "mcp")
      return getShareCopyDetails({ root, home: "state", request: transport }, { shareId, grantId });
    const result = await executeCli({
      argv: ["share", "copy", shareId, grantId, "--json"],
      cwd: root,
      env: {},
      request: transport,
    });
    if (result.exitCode !== 0) return { ok: false, reason: result.stderr };
    const { schemaVersion: _schemaVersion, ...details } = JSON.parse(result.stdout);
    return details;
  };
  return {
    ...f,
    copy,
    remote,
    relay,
    storage,
    rotate: () => {
      generation++;
    },
    otherAccount: () => {
      credentials = { ...credentials, userId: "stranger" };
    },
  };
}

describe.each(["mcp"] as const)("share copy through %s", (door) => {
  it("returns the owner's exact details without credentials", async () => {
    const f = await shareCopyFixture();
    expect(await f.copy(door)).toEqual({
      status: "active",
      shareCode: "dohc-share:share:https://relay.test",
      browserInvitationUrl: SHARE_WEB_ORIGIN + "/s/edit/grant",
    });
    expect(f.relay.mock.lastCall?.[1]).toBe("/sync/workspace/shares/share/grants/grant/copy");
  });
  it("refuses another account before contacting the relay", async () => {
    const f = await shareCopyFixture();
    f.otherAccount();
    expect(await f.copy(door)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Sign in"),
    });
    expect(f.relay).not.toHaveBeenCalled();
  });
  it.each(["foreign-workspace", "foreign-grant"])("refuses an %s grant", async (kind) => {
    const f = await shareCopyFixture();
    const db = inspectDatabase(storagePath(f.storage));
    try {
      if (kind === "link")
        db.prepare(
          "UPDATE sync_relay_share_grants SET principal_kind = 'link', principal_user_id = NULL WHERE grant_id = 'grant'",
        ).run();
      if (kind === "damaged")
        db.prepare(
          "UPDATE sync_relay_shares SET selector_json = '{}' WHERE share_id = 'share'",
        ).run();
    } finally {
      db.close();
    }
    const result = await f.copy(
      door,
      kind === "foreign-workspace" ? "foreign" : "share",
      kind === "unknown" ? "unknown" : kind.startsWith("foreign") ? "foreign-grant" : "grant",
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("not found") });
  });
  it("discards a reply after the credential generation changes", async () => {
    const f = await shareCopyFixture();
    f.relay.mockImplementation(async () => {
      f.rotate();
      return { workspaceId: "workspace", shareId: "share", grantId: "grant", status: "active" };
    });
    expect(await f.copy(door)).toMatchObject({ ok: false });
  });
});

// Both agent doors reach the Share dialog's Agents list and Disconnect through
// desktop attachment admission. The relay stand-in records what main asks it.
async function linkAgentsFixture() {
  const root = await createTestScratch("dohc-cli-link-agents-");
  const f = fixture(root);
  let credentials: CloudCredentials = {
    serverUrl: "https://cloud.test",
    relayUrl: "https://relay.test",
    userId: "owner",
    email: "owner@test",
    token: "secret",
  };
  const remote = vi.fn(async (workspace: RegistryEntry) => {
    if (!workspaceRemoteMatchesCredentials(workspace.remote!, credentials))
      throw Error("Sign in to the account that synced this workspace.");
    return { credentials, credentialGeneration: 1 };
  });
  const agent = {
    connectionId: "connection",
    reportedName: "Claude",
    connectedAtMs: 1,
    lastActionAtMs: null,
  };
  const relay = vi.fn(
    async (_account: CloudCredentials, path: string, _init?: RequestInit): Promise<unknown> =>
      path.endsWith("/disconnect")
        ? { ok: true, agent: { ...agent, status: "disconnected" } }
        : { ok: true, agents: [{ ...agent, status: "active" }], nextCursor: null },
  );
  f.dependencies.shareLinkAgents = createShareLinkAgentActions<RegistryEntry>({
    remoteForWorkspace: remote,
    currentCredentialGeneration: () => 1,
    relayJson: relay,
    relayShareErrorCopy: () => "The share changed. Try again.",
  });
  await f.create().startDesktopCliServer();
  const transport = async (input: CliRequestWithoutToken) => {
    const line = await handleCliRequestLine(
      JSON.stringify({ ...input, token: "a".repeat(64) }),
      "a".repeat(64),
      f.options(),
    );
    const response = cliTransportResponseSchema.parse(JSON.parse(line));
    if (!response.ok) throw Error(response.error);
    return response.result;
  };
  const cli = async (argv: string[]) => {
    const result = await executeCli({
      argv: [...argv, "--json"],
      cwd: root,
      env: {},
      request: transport,
    });
    if (result.exitCode !== 0) return { ok: false, reason: result.stderr };
    const { schemaVersion: _schemaVersion, ...answer } = JSON.parse(result.stdout);
    return answer;
  };
  const list = (door: "cli" | "mcp", cursor?: string) =>
    door === "mcp"
      ? listLinkAgents(
          { root, home: "state", request: transport },
          { shareId: "share", grantId: "grant", ...(cursor ? { cursor } : {}) },
        )
      : cli(["share", "agents", "share", "grant", ...(cursor ? ["--cursor", cursor] : [])]);
  const disconnect = (door: "cli" | "mcp") =>
    door === "mcp"
      ? disconnectLinkAgent(
          { root, home: "state", request: transport },
          { shareId: "share", grantId: "grant", connectionId: "connection" },
        )
      : cli(["share", "disconnect", "share", "grant", "connection"]);
  return {
    ...f,
    root,
    agent,
    list,
    disconnect,
    transport,
    remote,
    relay,
    otherAccount: () => {
      credentials = { ...credentials, userId: "stranger" };
    },
  };
}

describe.each(["mcp"] as const)("link agents through %s", (door) => {
  it("refuses another account before contacting the relay", async () => {
    const f = await linkAgentsFixture();
    f.otherAccount();
    expect(await f.list(door)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Sign in"),
    });
    expect(await f.disconnect(door)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Sign in"),
    });
    expect(f.relay).not.toHaveBeenCalled();
  });
});

// Both agent doors reach the desktop engine's Save recovery copy and Try again
// through the desktop CLI server. The stand-in engine keeps refused edits per
// workspace, as main's own record does. It leaves the incident to the server.
async function keptEditsFixture(options: { engine?: boolean; caller?: string } = {}) {
  const root = await createTestScratch("dohc-cli-kept-edits-");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "plan.md"), "plan");
  await writeFile(join(root, "elsewhere.md"), "elsewhere");
  const cwd = join(root, options.caller ?? "");
  await mkdir(cwd, { recursive: true });
  const f = fixture(root);
  const row = (
    objectId: string,
    path: string,
    incident = "outbox:delivery:0",
    recovery: OwnerLiveQuarantine["recovery"] = "paused",
  ): OwnerLiveQuarantine => ({
    objectId,
    path,
    reason: "invalid-update",
    storedOn: "this-computer",
    incident,
    recovery,
  });
  const kept: Record<string, OwnerLiveQuarantine[]> = {
    workspace: [row("object-plan", "notes/plan.md")],
    other: [row("object-elsewhere", "elsewhere.md")],
  };
  const pending: Record<string, string[]> = {};
  const save = vi.fn(async (workspace: RegistryEntry, path: string, incident?: string) => {
    const found = kept[workspace.workspaceId]?.find(
      (candidate) =>
        candidate.path === path && (incident === undefined || candidate.incident === incident),
    );
    if (!found)
      throw new Error("dohc has no kept edits for this file. Open Live documents to check it.");
    // A copy of edits the server keeps is confirmed to it, as the desktop engine does.
    if (found.storedOn === "server") found.recovery = "copied";
    return {
      copyPath: path.replace(/\.md$/, " (recovered).md"),
      packagePath: path.replace(/\.md$/, " (recovered).dohc-recovery.json"),
      storedOn: found.storedOn,
      keptEdits: found.storedOn === "server" ? ("copied" as const) : ("kept" as const),
    };
  });
  const retry = vi.fn(async (workspace: RegistryEntry, objectId: string, _incident: string) => {
    const found = kept[workspace.workspaceId]?.find((candidate) => candidate.objectId === objectId);
    if (found?.recovery === "unreadable") return;
    if (
      !found ||
      (found.recovery !== "paused" && !(found.storedOn === "server" && found.recovery === "copied"))
    )
      throw new Error("This document changed. Open Live documents to check it.");
    found.recovery = "retrying";
  });
  // Stands in for the window's guarded Stop of the row's document: a not-written release writes the file and its row ends.
  const stoppedIn: string[] = [];
  const stopAgain = vi.fn(
    async (
      operation: { workspace: RegistryEntry },
      again: { path: string; objectId: string; recovery: "not-written" | "stopping" },
    ) => {
      stoppedIn.push(operation.workspace.workspaceId);
      const rows = kept[operation.workspace.workspaceId] ?? [];
      const found = rows.find(
        (candidate) =>
          candidate.objectId === again.objectId &&
          again.recovery === "not-written" &&
          candidate.recovery === "not-written",
      );
      if (found) rows.splice(rows.indexOf(found), 1);
      return { keptEdits: found ? ("recovered" as const) : ("kept" as const) };
    },
  );
  if (options.engine !== false)
    f.dependencies.ownerLiveRecovery = {
      keptEdits: (workspaceId) => kept[workspaceId] ?? [],
      pendingShare: (workspaceId) => pending[workspaceId] ?? [],
      save,
      retry,
      stopAgain,
    };
  await f.create().startDesktopCliServer();
  const transport = async (input: CliRequestWithoutToken) => {
    const line = await handleCliRequestLine(
      JSON.stringify({ ...input, token: "a".repeat(64) }),
      "a".repeat(64),
      f.options(),
    );
    const response = cliTransportResponseSchema.parse(JSON.parse(line));
    if (!response.ok) throw Error(response.error);
    return response.result;
  };
  const cli = async (...argv: string[]) => {
    const result = await executeCli({
      argv: ["document", ...argv, "--json"],
      cwd,
      env: {},
      request: transport,
    });
    if (result.exitCode !== 0) return { ok: false, reason: result.stderr };
    const { schemaVersion: _schemaVersion, ...answer } = JSON.parse(result.stdout);
    return answer;
  };
  const ctx = { root: cwd, home: join(root, "state"), request: transport };
  const doors = {
    cli: {
      list: () => cli("kept-edits"),
      save: (path: string, incident?: string) =>
        incident === undefined
          ? cli("save-recovery-copy", path)
          : cli("save-recovery-copy", path, incident),
      retry: (path: string, incident: string) => cli("retry-kept-edits", path, incident),
      stopAgain: (path: string, incident: string) => cli("stop-again", path, incident),
    },
    mcp: {
      list: async () => {
        const status = await workspaceStatus(ctx);
        return "keptEdits" in status
          ? { ok: true, keptEdits: status.keptEdits, pendingShare: status.pendingShare }
          : { ok: false, reason: "no keptEdits" };
      },
      save: (path: string, incident?: string) =>
        saveRecoveryCopy(ctx, incident === undefined ? { path } : { path, incident }),
      retry: (path: string, incident: string) => retryKeptEdits(ctx, { path, incident }),
      stopAgain: (path: string, incident: string) => stopAgainTool(ctx, { path, incident }),
    },
  };
  return {
    ...f,
    root,
    cwd,
    ctx,
    transport,
    kept,
    pending,
    row,
    save,
    retry,
    stopAgain,
    stoppedIn,
    doors,
  };
}

describe.each(["mcp"] as const)("kept edits through %s", (door) => {
  it("retries reading an unreadable save-only queue without sending its edits", async () => {
    const f = await keptEditsFixture();
    const incident = "unreadable:old-queue:incomplete";
    f.kept.workspace = [
      { ...f.row("object-plan", "notes/plan.md", incident, "unreadable"), saveOnly: true },
    ];
    expect(await f.doors[door].retry("notes/plan.md", incident)).toMatchObject({ ok: true });
    expect(f.retry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: "workspace" }),
      "object-plan",
      incident,
    );
  });
  it("lists, saves and tries again edits the server keeps, as the window does", async () => {
    const f = await keptEditsFixture();
    f.kept.workspace = [
      { ...f.row("object-plan", "notes/plan.md", "server:outbox:1"), storedOn: "server" },
    ];
    expect(await f.doors[door].list()).toEqual({
      ok: true,
      keptEdits: [
        {
          path: "notes/plan.md",
          reason: "invalid-update",
          storedOn: "server",
          incident: "server:outbox:1",
          recovery: "paused",
        },
      ],
      pendingShare: [],
    });
    expect(await f.doors[door].save("notes/plan.md")).toMatchObject({
      ok: true,
      storedOn: "server",
      folder: "notes",
      keptEdits: "copied",
    });
    expect(await f.doors[door].list()).toMatchObject({
      ok: true,
      keptEdits: [{ storedOn: "server", recovery: "copied" }],
    });
    expect(await f.doors[door].retry("notes/plan.md", "server:outbox:1")).toEqual({
      ok: true,
      path: "notes/plan.md",
    });
    expect(f.retry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: "workspace" }),
      "object-plan",
      "server:outbox:1",
    );
  });
  it("refuses another workspace's kept edits and a path outside this workspace", async () => {
    const f = await keptEditsFixture();
    expect(await f.doors[door].retry("elsewhere.md", "outbox:delivery:0")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no kept edits"),
    });
    expect(await f.doors[door].save("elsewhere.md")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no kept edits"),
    });
    expect(await f.doors[door].save("../outside.md")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("path rejected"),
    });
    expect(f.retry).not.toHaveBeenCalled();
    expect(f.save.mock.calls.map(([workspace, path]) => [workspace.workspaceId, path])).toEqual([
      ["workspace", "elsewhere.md"],
    ]);
  });
});

it("refuses kept edits on a retired desktop attachment before reaching the engine", async () => {
  const f = await keptEditsFixture();
  const context = await f.create().openCliWorkspace(f.workspace);
  await f.authorities.invalidate("workspace");
  await expect(context.keptEdits!.saveRecoveryCopy("notes/plan.md")).rejects.toThrow(
    "This workspace changed while this ran. Try again.",
  );
  await expect(context.keptEdits!.retry("notes/plan.md", "outbox:delivery:0")).rejects.toThrow(
    "This workspace changed while this ran. Try again.",
  );
  await expect(context.keptEdits!.stopAgain("notes/plan.md", "outbox:delivery:0")).rejects.toThrow(
    "This workspace changed while this ran. Try again.",
  );
  expect(f.save).not.toHaveBeenCalled();
  expect(f.retry).not.toHaveBeenCalled();
  expect(f.stopAgain).not.toHaveBeenCalled();
});

// Both agent doors reach Live documents' list, Stop and Resume through the
// desktop CLI server, wired as main wires them: the dialog's own actions,
// with a stand-in server that hosts notes/plan.md.
// A stand-in for the engine's record of who stopped or resumed each document,
// with its rules: a Stop replaces a pending Resume, any other begin over a
// pending change records nothing, and a finish for another change does nothing.
type ChangeAuthorRow =
  | { kind: "person"; personId: string }
  | { kind: "agent"; agentId: string; onBehalfOf: string; depth: number };
function liveChangeRecord() {
  const pending = new Map<
    string,
    { changeId: string; action: "stopped" | "resumed"; path: string; author: ChangeAuthorRow }
  >();
  const last = new Map<
    string,
    { action: "stopped" | "resumed"; atMs: number; author: ChangeAuthorRow }
  >();
  let next = 0;
  const record = {
    begin: vi.fn(
      async (
        _workspace: unknown,
        input: {
          objectId: string;
          path: string;
          action: "stopped" | "resumed";
          author: ChangeAuthorRow;
          before: string;
        },
      ) => {
        const earlier = pending.get(input.objectId);
        if (earlier && !(input.action === "stopped" && earlier.action === "resumed")) return null;
        const changeId = `change-${++next}`;
        pending.set(input.objectId, {
          changeId,
          action: input.action,
          path: input.path,
          author: input.author,
        });
        return { changeId };
      },
    ),
    finish: vi.fn(
      async (
        _workspace: unknown,
        input: { objectId: string; changeId: string; outcome: "applied" | "unrecorded" },
      ) => {
        const change = pending.get(input.objectId);
        if (change?.changeId !== input.changeId) return false;
        pending.delete(input.objectId);
        if (input.outcome === "applied")
          last.set(input.objectId, { action: change.action, atMs: 7, author: change.author });
        return true;
      },
    ),
    list: vi.fn(async (_workspace: unknown, objectIds: readonly string[]) =>
      [...new Set([...objectIds, ...pending.keys()])]
        .filter((objectId) => pending.has(objectId) || last.has(objectId))
        .map((objectId) => ({
          objectId,
          ...(pending.has(objectId) ? { pending: pending.get(objectId)! } : {}),
          ...(last.has(objectId) ? { last: last.get(objectId)! } : {}),
        })),
    ),
  };
  return { record, pending, last };
}

async function liveDocumentsFixture(
  options: { caller?: string; record?: ReturnType<typeof liveChangeRecord>["record"] } = {},
) {
  const f = await keptEditsFixture(options);
  const h = pendingStopHarness("workspace", "notes/plan.md", "object-plan", {
    ownerLiveQuarantines: () => f.kept.workspace ?? [],
    ...(options.record
      ? {
          liveChanges: options.record,
          person: () => ({ kind: "person" as const, personId: "person-here" }),
        }
      : {}),
  });
  // What the server's answer says about this request: absent like a server without the field.
  const answer: { changed?: boolean } = {};
  const documents: Record<string, unknown>[] = [
    { path: "notes/plan.md", objectId: "object-plan", status: "ready" },
    {
      path: "notes/held.md",
      objectId: "object-held",
      status: "unavailable",
      reason: "conflict-parent-withheld",
    },
  ];
  const retired: Record<string, unknown>[] = [
    { path: "notes/old.md", objectId: "object-old", status: "retired" },
  ];
  h.relay.mockImplementation(async (_credentials, path, init) => {
    expect(path.startsWith("/sync/workspace/live-host")).toBe(true);
    const body =
      init?.body === undefined
        ? undefined
        : (JSON.parse(String(init.body)) as { path: string; objectId?: string });
    if (init?.method === "DELETE")
      return {
        ok: true,
        objectId: body!.objectId,
        path: body!.path,
        status: "retired",
        acceptedCursor: 3,
        ...answer,
      };
    if (init?.method === "POST")
      return {
        ok: true,
        objectId: "object-plan",
        path: body!.path,
        status: "preparing",
        ...answer,
      };
    return path.includes("retired=1")
      ? { ok: true, documents: retired, nextCursor: null }
      : { ok: true, documents };
  });
  const activity = vi.fn();
  const authors: unknown[] = [];
  const operationOf = (operation: { workspace: RegistryEntry; assertCurrent(): void }) =>
    operation as unknown as { workspace: { workspaceId: string }; assertCurrent(): void };
  f.dependencies.ownerLiveDocuments = {
    list: (operation, input) => h.actions.list(input, operationOf(operation)),
    stop: (operation, input) => (
      authors.push(input.author),
      stopNamedOwnerLiveDocument(
        h.actions,
        { liveDocument: async () => h.document, sendRendererActivity: activity },
        { workspaceId: operation.workspace.workspaceId, ...input },
        operationOf(operation),
      )
    ),
    resume: (operation, input) => (
      authors.push(input.author),
      h.actions.resume(
        { workspaceId: operation.workspace.workspaceId, ...input },
        operationOf(operation),
      )
    ),
  };
  await f.create().startDesktopCliServer();
  const transport = async (input: CliRequestWithoutToken) => {
    const line = await handleCliRequestLine(
      JSON.stringify({ ...input, token: "a".repeat(64) }),
      "a".repeat(64),
      f.options(),
    );
    const response = cliTransportResponseSchema.parse(JSON.parse(line));
    if (!response.ok) throw Error(response.error);
    return response.result;
  };
  const cwd = join(f.root, options.caller ?? "");
  const cli = async (...argv: string[]) => {
    const result = await executeCli({
      argv: ["document", ...argv, "--json"],
      cwd,
      env: {},
      request: transport,
    });
    if (result.exitCode !== 0) return { ok: false, reason: result.stderr };
    const { schemaVersion: _schemaVersion, ...answer } = JSON.parse(result.stdout);
    return answer;
  };
  const ctx = { root: cwd, home: join(f.root, "state"), request: transport };
  const doors = {
    cli: {
      list: () => cli("live"),
      stop: (path: string, objectId?: string) =>
        objectId === undefined ? cli("stop", path) : cli("stop", path, "--object-id", objectId),
      resume: (path: string) => cli("resume", path),
    },
    mcp: {
      list: () => listLiveDocuments(ctx, {}),
      stop: (path: string, objectId?: string) =>
        stopLiveEditing(ctx, objectId === undefined ? { path } : { path, objectId }),
      resume: (path: string) => resumeLiveEditing(ctx, { path }),
    },
  };
  return { ...f, h, activity, authors, answer, documents, transport, doors };
}

describe.each(["cli", "mcp"] as const)("live documents through %s", (door) => {
  it("lists each live document with its state and reason, as Live documents does", async () => {
    const f = await liveDocumentsFixture();
    f.kept.workspace = [f.row("object-plan", "notes/plan.md", "outbox:delivery:0", "stopping")];
    const failure = { word: "engine-refused", since: "2026-11-13T01:00:00.000Z" };
    f.documents.push({
      path: "notes/failing.md",
      objectId: "object-failing",
      status: "unavailable",
      reason: "live-start-failing",
      failure,
    });
    expect(await f.doors[door].list()).toEqual({
      ok: true,
      nextCursor: null,
      documents: [
        { path: "notes/old.md", objectId: "object-old", status: "retired", canResume: true },
        {
          path: "notes/plan.md",
          objectId: "object-plan",
          status: "ready",
          canResume: false,
          quarantine: "stopping",
          storedOn: "this-computer",
          incident: "outbox:delivery:0",
        },
        {
          path: "notes/held.md",
          objectId: "object-held",
          status: "unavailable",
          reason: "conflict-parent-withheld",
          canResume: false,
        },
        {
          path: "notes/failing.md",
          objectId: "object-failing",
          status: "unavailable",
          reason: "live-start-failing",
          failure,
          canResume: true,
        },
      ],
    });
  });
  it("stops and resumes live editing for a page, as this computer's unnamed agent", async () => {
    const f = await liveDocumentsFixture();
    f.kept.workspace = [];
    expect(await f.doors[door].stop("notes/plan.md")).toEqual({
      ok: true,
      path: "notes/plan.md",
      keptEdits: "none",
    });
    expect(
      f.h.relay.mock.calls
        .filter((call) => call[2]?.method === "DELETE")
        .map((call) => JSON.parse(String(call[2]!.body))),
    ).toEqual([
      { path: "notes/plan.md", objectId: "object-plan", retire: true, restoreFenceGeneration: 0 },
    ]);
    expect(f.h.ownerLiveStop.mock.calls.map((call) => call[1])).toEqual(["request", "release"]);
    expect(f.activity).toHaveBeenCalledWith({
      workspaceId: "workspace",
      liveDocumentStopped: "object-plan",
    });
    expect(await f.doors[door].resume("notes/plan.md")).toEqual({
      ok: true,
      path: "notes/plan.md",
    });
    expect(
      f.h.relay.mock.calls
        .filter((call) => call[2]?.method === "POST")
        .map((call) => JSON.parse(String(call[2]!.body))),
    ).toEqual([{ path: "notes/plan.md" }]);
    expect(f.h.ownerLiveStop.mock.lastCall?.[1]).toBe("clear");
    expect(f.authors).toEqual(
      [0, 1].map(() => ({
        kind: "agent",
        agentId: expect.any(String),
        onBehalfOf: expect.any(String),
        depth: 0,
      })),
    );
  });
  it("refuses a received share, a received workspace, and a received marker before reaching the server", async () => {
    const shared = await liveDocumentsFixture({ caller: "shared-with-me/received" });
    const received = await liveDocumentsFixture();
    vi.mocked(received.dependencies.sharedViewOf).mockReturnValue({});
    const marked = await liveDocumentsFixture();
    marked.workspace.shareView = {} as RegistryEntry["shareView"];
    for (const f of [shared, received, marked]) {
      const path = f === shared ? "plan.md" : "notes/plan.md";
      for (const answer of [
        await f.doors[door].list(),
        await f.doors[door].stop(path),
        await f.doors[door].resume(path),
      ]) {
        expect(answer).toMatchObject({
          ok: false,
          reason: expect.stringContaining("original workspace"),
        });
      }
      expect(f.h.relay).not.toHaveBeenCalled();
      expect(f.h.ownerLiveStop).not.toHaveBeenCalled();
      expect(f.authors).toEqual([]);
    }
  });
});

describe.each(["mcp"] as const)("who stopped or resumed live editing, through %s", (door) => {
  const agent = {
    kind: "agent",
    agentId: expect.any(String),
    onBehalfOf: expect.any(String),
    depth: 0,
  };
  it("credits a Stop and a Resume only when the server says this request made the change", async () => {
    const changes = liveChangeRecord(),
      f = await liveDocumentsFixture({ record: changes.record });
    f.kept.workspace = [];
    f.answer.changed = true;
    expect(await f.doors[door].stop("notes/plan.md")).toEqual({
      ok: true,
      path: "notes/plan.md",
      keptEdits: "none",
    });
    expect(changes.record.begin).toHaveBeenLastCalledWith(expect.anything(), {
      objectId: "object-plan",
      path: "notes/plan.md",
      action: "stopped",
      author: agent,
      before: "ready",
    });
    expect(changes.last.get("object-plan")).toEqual({ action: "stopped", atMs: 7, author: agent });
    expect(changes.record.begin.mock.invocationCallOrder[0]).toBeLessThan(
      f.h.ownerLiveStop.mock.invocationCallOrder[0]!,
    );
    expect(await f.doors[door].resume("notes/plan.md")).toEqual({
      ok: true,
      path: "notes/plan.md",
    });
    expect(changes.last.get("object-plan")).toMatchObject({ action: "resumed", author: agent });
    expect(changes.pending.size).toBe(0);
  });
  it("never settles a change this dohc is still making, and never credits one an interrupted action left", async () => {
    const changes = liveChangeRecord(),
      f = await liveDocumentsFixture({ record: changes.record });
    f.kept.workspace = [];
    f.answer.changed = true;
    changes.pending.set("object-held", {
      changeId: "left",
      action: "resumed",
      path: "notes/held.md",
      author: { kind: "person", personId: "person-here" },
    });
    let listed: unknown;
    f.h.ownerLiveStop.mockImplementationOnce(async (workspace, action, path, binding) => {
      listed = await f.doors[door].list();
      f.h.ownerLiveStop.mockClear();
      return (await import("../testing/ownerLiveStop.test-helper"))
        .pendingStopHarness("workspace", path, "object-plan")
        .ownerLiveStop(workspace, action, path, binding);
    });
    expect(await f.doors[door].stop("notes/plan.md")).toMatchObject({ ok: true });
    expect(listed).toMatchObject({ ok: true });
    expect(changes.last.get("object-plan")).toMatchObject({ action: "stopped" });
    expect(changes.last.has("object-held")).toBe(false);
    expect(changes.pending.size).toBe(0);
  });
});

it("gives CLI and MCP the IPC link answer in a share without Chats capture", async () => {
  const f = fixture(await createTestScratch("links-share-cli-"));
  f.setCapture(null);
  f.setDaemon(null);
  f.dependencies.sharedViewOf = () =>
    ({ shareId: "share" }) as ReturnType<Dependencies["sharedViewOf"]>;
  const resolved = {
    versionId: "main",
    results: [{ path: "target.md", fragment: "heading" }],
    mountsCovered: true,
  };
  const input = {
    source: "source.md",
    literals: [{ kind: "wikilink" as const, literal: "target#heading" }],
  };
  f.dependencies.reads.linksResolve = vi.fn(async () => resolved);
  await f.create().startDesktopCliServer();
  const token = "a".repeat(64);
  const send = async (request: CliRequestWithoutToken) => {
    const response = cliTransportResponseSchema.parse(
      JSON.parse(
        await handleCliRequestLine(JSON.stringify({ ...request, token }), token, f.options()),
      ),
    );
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const cli = await executeCli({
    argv: ["links", "resolve", "source.md", JSON.stringify(input.literals), "--json"],
    cwd: f.workspace.rootPath,
    env: {},
    request: send,
  });
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout)).toMatchObject(resolved);
  const { requestDeclaredTool } = await import("@dohc/mcp/tools");
  expect(
    await requestDeclaredTool(
      { root: f.workspace.rootPath, home: "state", request: send },
      "dohc_links_resolve",
      input,
    ),
  ).toEqual(resolved);
  expect(f.dependencies.openWorkspaceActivity).not.toHaveBeenCalled();
  expect(f.dependencies.linkedChatStoreFor).not.toHaveBeenCalled();
  expect(f.dependencies.reads.linksResolve).toHaveBeenCalledTimes(2);
  const held = deferred();
  f.dependencies.reads.linksResolve = vi.fn(async () => {
    await held.promise;
    return resolved;
  });
  const pending = f.options().reads!.linksResolve!(f.workspace, input);
  await vi.waitFor(() => expect(f.dependencies.reads.linksResolve).toHaveBeenCalledOnce());
  const retired = f.authorities.invalidate(f.workspace.workspaceId);
  held.release();
  await expect(pending).resolves.toEqual(resolved);
  await retired;
});

it("refuses a held change read in a shared view instead of answering that nothing is held", async () => {
  const f = fixture(await createTestScratch("held-change-shared-"));
  const read = vi.fn(async () => null);
  f.dependencies.heldChanges.change = read;
  vi.mocked(f.dependencies.sharedViewOf).mockReturnValue({});
  await f.create().startDesktopCliServer();
  const token = "a".repeat(64);
  const send = async (request: CliRequestWithoutToken) => {
    const response = cliTransportResponseSchema.parse(
      JSON.parse(
        await handleCliRequestLine(JSON.stringify({ ...request, token }), token, f.options()),
      ),
    );
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };

  const cli = await executeCli({
    argv: ["document", "held", "a.md"],
    cwd: f.workspace.rootPath,
    env: {},
    request: send,
  });
  expect(cli.exitCode).not.toBe(0);
  expect(cli.stderr).toContain("original workspace");
  const { readHeldChange } = await import("@dohc/mcp/tools");
  expect(
    await readHeldChange(
      { root: f.workspace.rootPath, home: "state", request: send },
      { path: "a.md" },
    ),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
  expect(read).not.toHaveBeenCalled();
});
