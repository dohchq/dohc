import { getShareCopyDetails, moveWorkspacePath, retryKeptEdits, saveRecoveryCopy, stopAgain as stopAgainTool, workspaceStatus } from "@dohc/mcp/tools";
import type { OwnerLiveQuarantine } from "../ipc/bridgeContract";
import { createShareCopyReader } from "../ipc/shareCopyHandler";
import { workspaceRemoteMatchesCredentials } from "../workspaces/chatRelayIdentity";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { closeTestStorages, testStorage, testHandler, request as relayRequest, inspectDatabase, storagePath, SHARE_WEB_ORIGIN, RELAY_EXCHANGE_KEY } from "@dohc/sync-relay/testing";
import { historyCursor, historyPageFields } from "../testing/historyPageFixture";
import { createHash } from "node:crypto";
import { AuthoredTextChangedError } from "../workspaces/workspaceEngineCapture";
import { parseCliResult, type CliFileWrite } from "@dohc/cli/protocol";
import { createTestScratch } from "../workspaces/testTemp";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { documentEditUpdate, documentMarkdown, markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { directDocumentProjection } from "../workspaces/documentProjection";
import { CHATS_METHOD, WORKSPACE_METHOD, type VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { executeCli } from "@dohc/cli";
import { CLI_JSON_SCHEMA_VERSION, CLI_PROTOCOL_VERSION, cliTransportResponseSchema, type CliRequestWithoutToken } from "@dohc/cli/protocol";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import { accessCliQueries, createAccessOwner } from "../access/accessOwner";
import { createDesktopCliServer } from "./desktopCliServer";
import { handleCliRequestLine } from "./cliServer";
import type { CliServerOptions, CliServerHandle } from "./cliServer";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { createChatWrites } from "../workspaces/chatWrites";
import type { CollectionRecordEditContext } from "@dohc/automation-executor/collection-record-edits";
import { desktopRecordEditContext } from "../workspaces/desktopRecordEdits";
import type { AuthoredPathChanges, WorkspaceEngineMomentSummary, WorkspaceEngineYDocProviderSession } from "../workspaces/workspaceEngineCapture";
import { readWorkspaceEnginePolicy } from "../workspaces/workspaceEnginePolicyFile";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { createWorkspaceFolder } from "../workspaces/createWorkspaceFolder";
import { realpathSync } from "node:fs";
import { readDeleteRecovery, waitForRecovery } from "../workspaces/workspaceDeleteRecovery";
import * as recovery from "../workspaces/workspaceDeleteRecovery";
import { readMoveRecovery } from "../workspaces/workspaceMoveRecovery";
import * as workspaceFileMoves from "../workspaces/workspaceFileMoves";
import { openedLocalState } from "../testing/preparedLocalState";
import { readLocalStateFrom } from "../workspaces/workspaceLocalState";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}

type State = Record<string, never>;
type Dependencies = Parameters<typeof createDesktopCliServer<State>>[0];
type Capture = NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>;

function fixture(rootPath = resolve("cli-workspace"), canonicalizeRoot: (root: string) => string = resolve) {
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath, kind: "personal", mode: "local-first",
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
    listMoments: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listMoments"]>(),
    readMoment: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["readMoment"]>(),
    listKeptCopies: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listKeptCopies"]>(),
    saveKeptCopy: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["saveKeptCopy"]>(),
    listRetainedCopies: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listRetainedCopies"]>(),
    deleteRetainedCopies: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["deleteRetainedCopies"]>(),
    listVersions: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listVersions"]>(
      async () => ({ versions: [], activeVersionId: "main" })), ...historyPageFields,
    // Writes the file as the capture chain does, refusing one that exists.
    writeAuthoredFile: vi.fn<Capture["writeAuthoredFile"]>(async (absolutePath, text, _author, options) => {
      await mkdir(dirname(absolutePath), { recursive: true });
      try {
        await writeFile(absolutePath, text, { flag: options?.createOnly ? "wx" : "w" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new VersionedTextStoreError("target-path-exists", "File already exists");
      }
      return { resolvedAbsolutePath: absolutePath, materializeOutcome: "applied", objectId: "object", momentId: "moment", deduped: false };
    }),
    // Runs the move or delete as the capture does, with no live documents to
    // settle: the policy is read once the change runs, History holds every
    // regular file, and the disk has no rename that refuses to replace.
    changePathsAs: vi.fn(async (_paths: readonly string[], _authored: unknown, work: (engine: AuthoredPathChanges) => Promise<unknown>) =>
      await work({ policy: await readWorkspaceEnginePolicy(rootPath), readDuplicate: async () => null, hasPath: async () => false,
      duplicateFile: async () => { throw new Error("unexpected Duplicate"); },
      recordDisk: async (_path, files) => [...files],
        moveFile: async () => false, rename: async () => undefined, delete: async () => "moment",
        undoDelete: async () => undefined })) as Capture["changePathsAs"],
  };
  const requestWorkspace = vi.fn(async (_root: string, _id: string, method: string, _input: unknown) =>
    method === WORKSPACE_METHOD.searchQueryChatMessagesGranular
      ? { results: [{ threadId: "thread", messageId: null, text: "Title" }], saturated: false }
      : [{ threadId: "thread", messageCount: 2, lastReadSequence: 1 }]);
  let currentCapture: ReturnType<Dependencies["activity"]["engineCaptureFor"]> = capture;
  let daemon: ReturnType<Dependencies["currentDaemon"]> = { requestWorkspace };
  let options!: CliServerOptions;
  const handle: CliServerHandle = { socketPath: "socket", tokenPath: "token", close: vi.fn(async () => undefined) };
  const chatWrites = createChatWrites({
    findWorkspace: (id) => rows.get(id) ?? null,
    warmCredentials: async () => undefined,
    currentCredentialGeneration: () => 0,
    currentCredentials: () => null,
    localUserDisplayName: () => "Local name",
    agentDisplayName: async () => "Agent",
    localInstallationId: () => "local:device",
    projectChatBookmarks: vi.fn(),
    queueCloudSync: vi.fn(),
    syncSharedChannelsForChatTarget: async () => undefined,
    scanChatDispatch: async () => undefined,
    betweenDispatchScans: (_workspaceId, write) => write(),
    notifyRenderer: () => undefined,
  });
  const dependencies: Dependencies = {
    chatFileMentions: vi.fn(async () => null),
    chatLinks: vi.fn(async () => null),
    links: { edges: vi.fn(async () => ({versionId:"main",files:[],entries:[],unchecked:[],complete:true,indexBuilding:false,mountsCovered:true,nextCursor:null})), incoming: vi.fn(async () => null), resolve: vi.fn(async () => ({ versionId: "main", results: [], mountsCovered: true })) },
    automations: () => ({ automationIdAt: vi.fn(), runs: vi.fn(), run: vi.fn(), serverRuns: vi.fn(), serverRun: vi.fn(), retry: vi.fn() }),
    buttons: () => ({ inspect: vi.fn(async () => []), press: vi.fn() }),
    findWorkspace: (id) => rows.get(id) ?? null,
    listWorkspaces: () => [...rows.values()],
    openWorkspaceActivity: vi.fn(async () => undefined),
    activity: { engineCaptureFor: vi.fn(() => currentCapture), queueCloudSync: vi.fn(), agentRunDepth: vi.fn(() => 0), dispatchedAgentRun: vi.fn(() => false), agentRunWorkspace: vi.fn(() => undefined) },
    linkedChatStoreFor: vi.fn(() => store),
    currentDaemon: vi.fn(() => daemon),
    agentDispatchStoreHandleFor: vi.fn(() => ({ store: dispatchStore })),
    sharedViewOf: vi.fn(() => null),
    withPhysicalWorkspaceOperation: (id, work) => authorities.withOperation(id, work),
    collectionEditContextFor: vi.fn(async () => { throw new Error("No edit context configured"); }),
    localPerson: async () => ({ kind: "human", humanId: "local:test" }),
    withEngineAdapter: async () => null,
    liveDocuments: {
      readDocument: vi.fn<Dependencies["liveDocuments"]["readDocument"]>(async ({ path }) => ({ path, state: null })),
      editDocument: vi.fn<Dependencies["liveDocuments"]["editDocument"]>(async ({ path }) => ({ path, changed: false })),
    },
    trashItem: vi.fn(async () => { throw new Error("No system trash in tests"); }),
    markDeletedUnderPath: vi.fn(),
    documentProjection: directDocumentProjection,
    chatWrites,
    startCliServer: vi.fn(async (input) => { options = input; return handle; }),
    stateDir: () => "state",
    localUserDisplayName: () => "Local name",
    localPersonId: () => "person-local",
    notifyRenderer: vi.fn(),
    syncSharedChannelsForChatTarget: vi.fn(async () => undefined),
    chatDispatchService: { scanWorkspace: vi.fn(async () => undefined) },
    rememberPendingCliRunMessageLink: vi.fn(),
  };
  return {
    workspace, rows, authorities, capture, store, dispatchStore,
    requestWorkspace, handle, dependencies, chatWrites,
    create: () => createDesktopCliServer(dependencies),
    options: () => options,
    setCapture: (value: typeof currentCapture) => { currentCapture = value; },
    setDaemon: (value: typeof daemon) => { daemon = value; },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("desktop CLI workspace context", () => {
  it("routes Access refresh to the IPC owner for the socket workspace only", async () => {
    const scratch = await createTestScratch("cli-access-refresh-");
    const f = fixture(scratch);
    f.rows.set("other", { ...f.workspace, workspaceId: "other", rootPath: join(scratch, "other") });
    const refreshedWorkspaces: string[] = [];
    const refresh = vi.fn(async (operation: Parameters<Parameters<Dependencies["withPhysicalWorkspaceOperation"]>[1]>[0]) => {
      operation.assertCurrent();
      refreshedWorkspaces.push(operation.workspace.workspaceId);
      return { status: "requested" as const };
    });
    const owner = createAccessOwner({
      resolve: async (_operation, ref) => ({ ref, visibility: "visible" }),
      roster: () => ({ listing: null, checkedAtMs: null, freshness: "unknown" }),
      received: () => ({ inventory: null, checkedAtMs: null, freshness: "unknown" }),
      account: () => null, scope: () => "scope", assertCurrent: operation => operation.assertCurrent(),
      permissions: async () => { throw new Error("unused"); }, refresh,
    });
    f.dependencies.access = id => accessCliQueries(owner, work => f.dependencies.withPhysicalWorkspaceOperation(id, work));
    const server = f.create();
    await server.startDesktopCliServer();
    const token = "a".repeat(64);
    const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "accessRefresh", args: { cwd: scratch, actor: "agent" } };
    try {
      const answer = JSON.parse(await handleCliRequestLine(JSON.stringify(request), token, f.options()));
      expect(answer).toMatchObject({ ok: true, result: { status: "requested" } });
      expect(refresh).toHaveBeenCalledOnce();
      expect(refreshedWorkspaces).toEqual(["workspace"]);
      const forged = { ...request, args: { ...request.args, workspaceId: "other" } };
      expect(JSON.parse(await handleCliRequestLine(JSON.stringify(forged), token, f.options()))).toMatchObject({ ok: false });
      expect(refresh).toHaveBeenCalledOnce();
      // IPC calls this same owner directly with its captured operation.
      await f.dependencies.withPhysicalWorkspaceOperation("workspace", operation => owner.refresh(operation));
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally { await f.handle.close(); }
  });

  it("binds sync stop to the registered workspace and fences a retired attachment", async () => {
    const f = fixture();
    f.dependencies.stopWorkspaceSync = vi.fn(async (operation, author) => {
      operation.assertCurrent();
      expect(operation.workspace.workspaceId).toBe(f.workspace.workspaceId);
      expect(author).toBeUndefined();
      return { ok: true as const, workspaceId: operation.workspace.workspaceId, workspaceSynced: false as const };
    });
    const server = f.create();
    const context = await server.openCliWorkspace(f.workspace);
    await expect(context.stopSync!()).resolves.toMatchObject({ ok: true, workspaceId: "workspace" });
    const retired = f.authorities.invalidate("workspace");
    await retired;
    await expect(context.stopSync!()).rejects.toThrow("This workspace changed while this ran. Try again.");
    expect(f.dependencies.stopWorkspaceSync).toHaveBeenCalledOnce();
  });

  it("keeps owner app actions bound to the CLI's original physical attachment", async () => {
    const f = fixture();
    const publish = vi.fn<NonNullable<Dependencies["ownerAppPublication"]>>(async () => ({ kind: "cancelled" }));
    f.dependencies.ownerAppPublication = publish;
    const context = await f.create().openCliWorkspace(f.workspace);
    const request = { action: "cancel" as const, workspaceId: f.workspace.workspaceId, approvalId: "00000000-0000-4000-8000-000000000001" };
    expect(await context.appPublication!(request)).toEqual({ kind: "cancelled" });
    expect(publish).toHaveBeenCalledWith(request, null);
    await f.authorities.invalidate(f.workspace.workspaceId);
    await expect(context.appPublication!(request)).rejects.toThrow("This workspace changed while this ran. Try again.");
    expect(publish).toHaveBeenCalledOnce();
  });
  it.each(["missing", "different root"])("rejects a %s registry request before activity admission", async (reason) => {
    const f = fixture();
    const request = reason === "missing" ? { ...f.workspace, workspaceId: "missing" }
      : { ...f.workspace, rootPath: resolve("other") };
    await expect(f.create().openCliWorkspace(request)).rejects.toThrow("not inside a dohc workspace");
    expect(f.dependencies.openWorkspaceActivity).not.toHaveBeenCalled();
  });

  it("waits for activity and then captures the engine and daemon once", async () => {
    const f = fixture();
    const held = deferred();
    f.setCapture(null); f.setDaemon(null);
    f.dependencies.openWorkspaceActivity = vi.fn(() => held.promise);
    const pending = f.create().openCliWorkspace({ ...f.workspace, rootPath: resolve(f.workspace.rootPath, ".") });
    try {
      expect(f.dependencies.activity.engineCaptureFor).not.toHaveBeenCalled();
      f.setCapture(f.capture); f.setDaemon({ requestWorkspace: f.requestWorkspace });
    } finally { held.release(); await pending; }
    const context = await pending;
    f.setCapture(null); f.setDaemon(null);
    expect(context.store).toBe(f.store);
    expect(context.dispatchStore).toBe(f.dispatchStore);
    expect(await context.fileObjectIdForPath("notes.md")).toBe("object");
    expect(await context.filePathForObjectId("object")).toBe("notes.md");
    expect(await context.daemonReads.queryChatMessagesGranular({ query: "Title", limit: 5 }))
      .toEqual({ results: [{ threadId: "thread", messageId: null, text: "Title" }], saturated: false });
    expect(await context.daemonReads.listUnreadFileThreads({ pageLimit: 3, afterThreadId: "before" }))
      .toEqual([{ threadId: "thread", messageCount: 2, lastReadSequence: 1 }]);
    expect(f.requestWorkspace.mock.calls).toEqual([
      [f.workspace.rootPath, "workspace", WORKSPACE_METHOD.searchQueryChatMessagesGranular, { query: "Title", limit: 5 }],
      [f.workspace.rootPath, "workspace", CHATS_METHOD.readStateListUnreadFileThreads, { pageLimit: 3, afterThreadId: "before" }],
    ]);
    expect(f.dependencies.currentDaemon).toHaveBeenCalledOnce();
  });

  it.each(["capture", "daemon"])("refuses an unavailable %s after activity admission", async (missing) => {
    const f = fixture();
    if (missing === "capture") f.setCapture(null); else f.setDaemon(null);
    await expect(f.create().openCliWorkspace(f.workspace)).rejects.toThrow(
      missing === "capture" ? "could not start Chats" : "engine is not running");
    expect(f.dependencies.openWorkspaceActivity).toHaveBeenCalledWith(f.workspace);
  });

  it("keeps daemon response validation at both read callbacks", async () => {
    const f = fixture();
    f.requestWorkspace.mockResolvedValue({ invalid: true } as never);
    const context = await f.create().openCliWorkspace(f.workspace);
    await expect(context.daemonReads.queryChatMessagesGranular({ query: "q", limit: 1 })).rejects.toThrow();
    await expect(context.daemonReads.listUnreadFileThreads({ pageLimit: 1 })).rejects.toThrow();
  });

  it("filters protected and objectless moments and preserves optional metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-history-"));
    const f = fixture(root);
    const moment: WorkspaceEngineMomentSummary = {
      id: "moment", versionId: "version", objectId: "object", path: "notes.md",
      recordedAtMs: 20, operation: "write", metadata: { origin: "api" },
      momentOrder: 3, protected: false, byteLength: 0, contentKind: "text",
      authors: [{ kind: "agent", agentId: "agent", onBehalfOf: "owner" }],
    };
    const { byteLength: _bytes, contentKind: _kind, authors: _authors, ...plain } = moment;
    f.capture.listMoments.mockResolvedValue({ moments: [moment, { ...plain, id: "plain" },
      { ...moment, id: "protected", protected: true }, { ...moment, id: "objectless", objectId: "" }],
      nextCursor: null, latestMomentOrder: 3, activeVersionId: "version", ...historyPageFields,  });
    const context = await f.create().openCliWorkspace(f.workspace);
    const { protected: _protected, ...expected } = moment;
    const { protected: _plainProtected, ...plainExpected } = plain;
    expect(await context.listMoments({ limit: 4 })).toEqual([
      { ...expected, workspaceId: "workspace" }, { ...plainExpected, id: "plain", workspaceId: "workspace" },
    ]);
    expect(f.capture.listMoments).toHaveBeenCalledWith({ limit: 4 });
    await context.listMoments({ limit: 4, objectId: "object-plan" });
    expect(f.capture.listMoments).toHaveBeenLastCalledWith({ limit: 4, objectId: "object-plan" });
    const detail = { id: "detail", versionId: "main", path: "notes.md", payload: { before: null, after: { path: "notes.md", text: "" } } } as unknown as VersionedTextMoment;
    f.capture.readMoment.mockResolvedValueOnce({ protected: false, moment: detail })
      .mockResolvedValueOnce({ protected: true, moment: { id: "secret" } } as never).mockResolvedValueOnce(null);
    expect(await context.readMoment("visible")).toBe(detail);
    expect(await context.readMoment("protected")).toBeNull();
    expect(await context.readMoment("absent")).toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  it("stops showing history the workspace's current policy no longer tracks, to the CLI and the MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-history-"));
    try {
      await mkdir(join(root, ".dohc"));
      const f = fixture(root);
      const summary = (id: string, path: string): WorkspaceEngineMomentSummary => ({
        id, versionId: "main", objectId: `object-${id}`, path, recordedAtMs: 20, operation: "write",
        metadata: { origin: "local-file" }, momentOrder: 1, protected: false, contentKind: "text", byteLength: 4,
      });
      // The summary desktop capture records for a rename (workspaceEngineCapture.ts, beginFileRename).
      const renamed = "Renamed private/moved.md to notes/moved.md";
      const snapshot = (path: string, text: string) => ({ path, contentKind: "text" as const, sha256: "sha", byteLength: text.length, text });
      const detail = (id: string, operation: VersionedTextMoment["operation"], payload: VersionedTextMoment["payload"]): VersionedTextMoment => ({
        id, workspaceId: "workspace", versionId: "main", objectId: `object-${id}`, path: payload.after.path,
        recordedAtMs: 20, operation, payload, metadata: { origin: "local-file" },
      });
      const details: Record<string, VersionedTextMoment> = {
        journal: detail("journal", "write", { before: null, after: snapshot("private/journal.md", "dear diary") }),
        moved: { ...detail("moved", "rename", { before: snapshot("private/moved.md", "was private"), after: snapshot("notes/moved.md", "was private") }),
          metadata: { origin: "local-file", summary: renamed } },
        notes: detail("notes", "write", { before: null, after: snapshot("notes.md", "plain") }),
      };
      f.capture.listMoments.mockResolvedValue({
        moments: [summary("notes", "notes.md"), summary("journal", "private/journal.md"),
          { ...summary("moved", "notes/moved.md"), operation: "rename", metadata: { origin: "local-file", summary: renamed } }],
        nextCursor: null, latestMomentOrder: 1, activeVersionId: "main", ...historyPageFields,
      });
      f.capture.readMoment.mockImplementation(async (id) => ({ protected: false, moment: details[id]! }));
      await f.create().startDesktopCliServer();
      const token = "a".repeat(64);
      const send = async (request: CliRequestWithoutToken) => {
        const response = cliTransportResponseSchema.parse(JSON.parse(
          await handleCliRequestLine(JSON.stringify({ ...request, token }), token, f.options())) as unknown);
        if (!response.ok) throw new Error(response.error);
        return response.result;
      };
      const cli = (...argv: string[]) => executeCli({ argv, cwd: root, env: {}, request: send });
      // The MCP's dohc_list_changes and dohc_read_change send these as the agent.
      const mcp = <Verb extends "moments" | "moment">(verb: Verb, args: Record<string, unknown>) =>
        send({ protocolVersion: CLI_PROTOCOL_VERSION, verb, args: { cwd: root, actor: "agent", ...args } } as CliRequestWithoutToken);

      expect((await cli("history", "show", "journal")).stdout).toBe("dear diary");
      // A change from a version that is not active reads as not found.
      f.capture.listVersions.mockResolvedValueOnce({ versions: [], activeVersionId: "draft" });
      expect(await cli("history", "show", "journal")).toEqual({ exitCode: 1, stdout: "", stderr: "dohc: change not found: journal\n" });
      expect(await mcp("moment", { id: "journal" })).toMatchObject({ ok: true });

      await writeFile(join(root, ".dohc", "files.toml"), '[[rule]]\npath = "private/**"\ntracked = false\n');
      // An untracked change says so, as the desktop's diff does, and names no path.
      expect(await cli("history", "show", "journal")).toEqual({ exitCode: 1, stdout: "",
        stderr: "dohc: change journal is hidden because History no longer tracks its file\n" });
      expect(await cli("history", "show", "moved")).toMatchObject({ exitCode: 1,
        stderr: "dohc: change moved is hidden because History no longer tracks its file\n" });
      expect((await cli("history", "show", "notes")).stdout).toBe("plain");
      // A list row names only the path after the change; show also checks the path before it.
      expect((await cli("history", "list")).stdout).toBe([
        `moved · ${new Date(20).toISOString()} · rename · notes/moved.md`,
        `notes · ${new Date(20).toISOString()} · write · notes.md`,
      ].join("\n") + "\n");
      expect(await mcp("moment", { id: "journal" })).toEqual({
        ok: false, status: "untracked", reason: "change journal is hidden because History no longer tracks its file" });
      expect(await mcp("moment", { id: "moved" })).toEqual({
        ok: false, status: "untracked", reason: "change moved is hidden because History no longer tracks its file" });
      expect(await mcp("moments", {})).toMatchObject({ changes: [{ id: "moved" }, { id: "notes" }], count: 2 });
      // Neither door sends the rename's summary, which names the excluded path.
      expect(JSON.stringify(await mcp("moments", { includeFiles: true }))).not.toContain("private/");
      expect((await cli("history", "list", "--json")).stdout).not.toContain("private/");
      expect((await cli("history", "list")).stdout).not.toContain("private/");

      // A policy file dohc cannot read hides all history, as it blocks search.
      await writeFile(join(root, ".dohc", "files.toml"), "[[rule]\n");
      // Unreadable rules hide every change, so the answer names the rules
      // file and no change. An empty list would say there is no History.
      const unreadable = { ok: false, status: "policy-unreadable", unreadable: [".dohc/files.toml"],
        reason: "History is hidden because dohc can't read .dohc/files.toml" };
      expect(await mcp("moments", {})).toEqual(unreadable);
      expect(await mcp("moments", { includeFiles: true })).toEqual(unreadable);
      expect(await cli("history", "list")).toEqual({ exitCode: 1, stdout: "",
        stderr: "dohc: History is hidden because dohc can't read .dohc/files.toml\n" });
      expect(await mcp("moment", { id: "notes" })).toEqual(unreadable);
      expect(await mcp("moment", { id: "no-such-change" })).toEqual(unreadable);
      expect(await cli("history", "show", "notes")).toEqual({ exitCode: 1, stdout: "",
        stderr: "dohc: History is hidden because dohc can't read .dohc/files.toml\n" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the registered workspace for collection reads and forwards history cursors exactly", async () => {
    const f = fixture();
    const query = { records: [], nextCursor: null };
    const record = { record: null };
    const queryCollectionRecords = vi.fn(async () => query);
    const getCollectionRecord = vi.fn(async () => record);
    const seen: unknown[] = [];
    f.dependencies.withEngineAdapter = async (workspace, work) => {
      seen.push(workspace);
      return work({ queryCollectionRecords, getCollectionRecord } as unknown as VersionedLiveAdapter);
    };
    const context = await f.create().openCliWorkspace(f.workspace);
    expect(await context.collections!.query({ collectionPath: "tasks", limit: 2 })).toBe(query);
    expect(await context.collections!.getRecord({ collectionPath: "tasks", recordId: "record", historyLimit: 2 })).toBe(record);
    await context.collections!.getRecord({ collectionPath: "tasks", recordId: "record", beforeHistoryId: 0, historyLimit: 0 });
    expect(seen).toEqual([f.workspace, f.workspace, f.workspace]);
    expect(queryCollectionRecords).toHaveBeenCalledWith({ collectionPath: "tasks", limit: 2 });
    expect(getCollectionRecord.mock.calls).toEqual([
      [{ collectionPath: "tasks", recordId: "record", historyLimit: 2 }],
      [{ collectionPath: "tasks", recordId: "record", historyLimit: 0, beforeHistoryId: 0 }],
    ]);
  });

  it("reads whether Collection updates wait from the registered workspace's engine", async () => {
    const f = fixture();
    const unavailable = await f.create().openCliWorkspace(f.workspace);
    await expect(unavailable.daemonReads.collectionsWaiting()).rejects.toThrow("engine is not running");
    const collectionsWaiting = vi.fn(async () => true);
    const seen: unknown[] = [];
    f.dependencies.withEngineAdapter = async (workspace, work) => {
      seen.push(workspace);
      return work({ collectionsWaiting } as unknown as VersionedLiveAdapter);
    };
    const context = await f.create().openCliWorkspace(f.workspace);
    expect(await context.daemonReads.collectionsWaiting()).toBe(true);
    collectionsWaiting.mockResolvedValueOnce(false);
    expect(await context.daemonReads.collectionsWaiting()).toBe(false);
    expect(seen).toEqual([f.workspace, f.workspace]);
  });

  it("refuses both collection reads when the engine adapter is unavailable", async () => {
    const f = fixture();
    const context = await f.create().openCliWorkspace(f.workspace);
    await expect(context.collections!.query({ collectionPath: "tasks" })).rejects.toThrow("engine is not running");
    await expect(context.collections!.getRecord({ collectionPath: "tasks", recordId: "record", historyLimit: 2 })).rejects.toThrow("engine is not running");
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
      doc, initialUpdate: Y.encodeStateAsUpdate(doc),
      applyDecidedLocalUpdate: async (decide: (doc: Y.Doc) => Uint8Array | null, armed?: () => void) => {
        const update = decide(doc);
        if (update === null) return false;
        Y.applyUpdate(doc, update); events.push("apply"); armed?.(); return true;
      },
      settleNow: async () => { events.push("settle"); return { materialized: true }; },
      close: async () => { events.push("close"); },
    } as unknown as WorkspaceEngineYDocProviderSession;
    const admitted: symbol[] = [];
    const opened = vi.fn(async () => session);
    f.dependencies.collectionEditContextFor = async (operation, person, signal) => {
      operation.assertCurrent(); admitted.push(operation.workspace.attachmentId);
      return desktopRecordEditContext({
        person, workspaceRoot: operation.workspace.rootPath,
        capture: { openRecordSession: opened, writeAuthoredFile: vi.fn() }, withAdapter: async () => null,
        onCaptureSettled: () => () => undefined, signal });
    };
    const context = await f.create().openCliWorkspace(f.workspace);
    try {
      expect(await context.collections!.writes.setFields({ recordPath: "tasks/one.md", fields: { status: "done" },
        author: { kind: "user", userId: "owner" } })).toEqual({ path: "tasks/one.md", replaced: { status: null }, kept: {} });
      expect(doc.getMap("frontmatter").get("status")).toBe("done");
      expect(events).toEqual(["apply", "settle", "close"]);
      await expect(context.collections!.writes.createRecord({ collectionPath: "tasks", name: "../bad",
        author: { kind: "user", userId: "owner" } })).rejects.toThrow("plain file name");
      expect(admitted).toHaveLength(2);
      expect(admitted[0]).toBe(admitted[1]);
      expect(opened).toHaveBeenCalledOnce();
    } finally { doc.destroy(); await f.authorities.close(); }
  });

  it("reads a document from the editor that holds it, and otherwise from its file", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-documents-"));
    try {
      await writeFile(join(root, "notes.md"), "# Notes\n\n* settled item\n");
      const f = fixture(root);
      const held = Y.encodeStateAsUpdate(markdownToYDoc("# Notes\n\nLive text."));
      const read = vi.mocked(f.dependencies.liveDocuments.readDocument);
      read.mockResolvedValueOnce({ path: "notes.md", state: held });
      const context = await f.create().openCliWorkspace(f.workspace);
      expect(await context.documents!.read("notes.md"))
        .toEqual({ path: "notes.md", markdown: "# Notes\n\nLive text." });
      // The file answers in the form an edit matches against.
      expect(await context.documents!.read("notes.md"))
        .toEqual({ path: "notes.md", markdown: "# Notes\n\n- settled item" });
      expect(read.mock.calls).toEqual([
        [{ workspaceId: "workspace", path: "notes.md" }],
        [{ workspaceId: "workspace", path: "notes.md" }],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a lossy note as its file, and refuses to edit it before any session opens", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-lossy-"));
    const lossy = "# Readme\n\n<details>\n<summary>More</summary>\n\nHidden.\n</details>\n\nSee [the docs][docs].\n\n[docs]: https://example.com/docs\n";
    try {
      await writeFile(join(root, "readme.md"), lossy);
      await writeFile(join(root, "plan.md"), "# Plan\n\nText.\n");
      const f = fixture(root);
      const context = await f.create().openCliWorkspace(f.workspace);
      // Even with an editor holding it, the agent reads what is on disk.
      vi.mocked(f.dependencies.liveDocuments.readDocument)
        .mockResolvedValueOnce({ path: "readme.md", state: Y.encodeStateAsUpdate(markdownToYDoc(lossy)) });
      expect(await context.documents!.read("readme.md")).toEqual({ path: "readme.md", markdown: lossy });
      // A document an editor holds before its file exists still reads from the editor.
      vi.mocked(f.dependencies.liveDocuments.readDocument)
        .mockResolvedValueOnce({ path: "draft.md", state: Y.encodeStateAsUpdate(markdownToYDoc("# Draft")) });
      expect(await context.documents!.read("draft.md")).toEqual({ path: "draft.md", markdown: "# Draft" });

      const origin = { attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 0 } };
      await context.documents!.edit({ path: "readme.md", edit: { find: "Hidden.", replacement: "Shown." }, origin });
      const [input] = vi.mocked(f.dependencies.liveDocuments.editDocument).mock.calls[0]!;
      await expect(input.assertEditable("readme.md")).rejects.toThrow(
        "dohc can't change readme.md without also changing parts it can't show, such as raw HTML or reference links. Edit the file directly instead.",
      );
      await expect(input.assertEditable("plan.md")).resolves.toBeUndefined();
      // A read that fails, other than for a missing file, refuses too.
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
      session.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(session)));
      await expect(input.change(Y.encodeStateAsUpdate(session), { keepBlocks: true })).rejects.toThrow(
        "dohc can't change readme.md without also changing parts it can't show",
      );
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
    Y.applyUpdate(doc, documentEditUpdate(Y.encodeStateAsUpdate(doc), { replacement: "Unsettled tail." }, { keepBlocks: true })!);
    try {
      await writeFile(join(root, "readme.md"), source);
      const f = fixture(root);
      const context = await f.create().openCliWorkspace(f.workspace);
      const origin = { attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 0 } };
      const edit = { path: "readme.md", edit: { find: "Editable.", replacement: "Changed." }, origin };
      await context.documents!.edit(edit);
      const [guarded] = vi.mocked(f.dependencies.liveDocuments.editDocument).mock.calls[0]!;
      const state = Y.encodeStateAsUpdate(doc);
      for (const headSha256 of [null, sha(source)]) {
        await expect(guarded.change(state, { keepBlocks: true, headSha256 })).rejects.toThrow("parts it can't show");
      }
      const converted = await guarded.change(state, { keepBlocks: true, headSha256: sha("converted head") });
      expect(converted).toBeInstanceOf(Uint8Array);

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
    const origin = { attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 0 } };
    await context.documents!.edit({ path: "notes.md", edit: { find: "Draft", replacement: "Final" }, origin });
    const [input] = edit.mock.calls[0]!;
    expect(input).toMatchObject({ workspaceId: "workspace", path: "notes.md", origin });
    const current = markdownToYDoc("Draft plan.");
    Y.applyUpdate(current, (await input.change(Y.encodeStateAsUpdate(current), { keepBlocks: true, headSha256: null }))!);
    expect(documentMarkdown(Y.encodeStateAsUpdate(current))).toBe("Final plan.");
    // A refusal from the projection reaches the caller.
    await expect(input.change(Y.encodeStateAsUpdate(markdownToYDoc("Final plan.")), { keepBlocks: true, headSha256: null }))
      .rejects.toThrow("not in the document");
  });

  it("creates a document as an empty file, then writes its text through the live session", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-create-"));
    try {
      await writeFile(join(root, "taken.md"), "Already here.\n");
      const f = fixture(root);
      const edit = vi.mocked(f.dependencies.liveDocuments.editDocument);
      const created = new Map<string, Y.Doc>();
      edit.mockImplementation(async (input) => {
        // The file is on disk, empty, before the text goes to its session.
        expect(await readFile(join(root, input.path), "utf8")).toBe("");
        const doc = new Y.Doc();
        const update = await input.change(Y.encodeStateAsUpdate(doc), { keepBlocks: false });
        if (update) Y.applyUpdate(doc, update);
        created.set(input.path, doc);
        return { path: input.path, changed: update !== null };
      });
      const context = await f.create().openCliWorkspace(f.workspace);
      const origin = { attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 0 } };

      await expect(context.documents!.create({ path: "notes/new.md", markdown: "# New\n\nFirst line.", origin }))
        .resolves.toEqual({ path: "notes/new.md" });
      expect(documentMarkdown(Y.encodeStateAsUpdate(created.get("notes/new.md")!))).toBe("# New\n\nFirst line.");
      expect(edit.mock.calls[0]![0]).toMatchObject({ workspaceId: "workspace", path: "notes/new.md", origin });
      // Unnamed agents still get agent attribution.
      const write = vi.mocked(f.capture.writeAuthoredFile);
      expect(write.mock.calls[0]).toEqual([join(root, "notes/new.md"), "", { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local" }, { createOnly: true }]);
      await context.documents!.create({ path: "named.md", markdown: "Hi.", origin: { ...origin, actorOriginId: "Codex" } });
      expect(write.mock.calls[1]![2]).toEqual({ kind: "agent", agentId: "Codex", onBehalfOf: "person-local" });
      // During a run an automation started, the file names the run's depth,
      // so a record it adds carries the chain on; with no name, the MCP
      // server's agent authors it.
      const woken = { attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 3 } };
      await context.documents!.create({ path: "woken.md", markdown: "Hi.", origin: woken });
      expect(write.mock.calls[2]![2]).toEqual({ kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local", depth: 3 });
      await context.documents!.create({ path: "woken-named.md", markdown: "Hi.", origin: { ...woken, actorOriginId: "Codex" } });
      expect(write.mock.calls[3]![2]).toEqual({ kind: "agent", agentId: "Codex", onBehalfOf: "person-local", depth: 3 });

      await expect(context.documents!.create({ path: "taken.md", markdown: "x", origin }))
        .rejects.toThrow("taken.md already exists. Edit it instead.");
      expect(await readFile(join(root, "taken.md"), "utf8")).toBe("Already here.\n");

      // The file stays, and the refusal names it, so the caller edits it
      // instead of creating a second one.
      edit.mockRejectedValueOnce(new Error("engine busy"));
      await expect(context.documents!.create({ path: "later.md", markdown: "Text", origin }))
        .rejects.toThrow("dohc created later.md, but could not write its text (engine busy). Edit the document to add it.");
      expect(await readFile(join(root, "later.md"), "utf8")).toBe("");
      expect(edit).toHaveBeenCalledTimes(5);

      // Two creates of one path: one creates it, the other is told it exists.
      const race = await Promise.allSettled([
        context.documents!.create({ path: "race.md", markdown: "First.", origin }),
        context.documents!.create({ path: "race.md", markdown: "Second.", origin }),
      ]);
      expect(race.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(race.find((outcome) => outcome.status === "rejected")).toMatchObject({
        reason: expect.objectContaining({ message: "race.md already exists. Edit it instead." }),
      });

      // Frontmatter, even an empty envelope, is refused before a file exists.
      const writes = write.mock.calls.length;
      await expect(context.documents!.create({ path: "front.md", markdown: "---\n{}\n---\n\nBody.", origin }))
        .rejects.toThrow("A new document starts without frontmatter.");
      await expect(lstat(join(root, "front.md"))).rejects.toThrow();
      expect(write.mock.calls.length).toBe(writes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a collection edit whose admitted physical workspace retires while its context opens", async () => {
    const f = fixture();
    const held = deferred(); const entered = deferred();
    const opened = vi.fn();
    f.dependencies.collectionEditContextFor = async (operation, person, signal): Promise<CollectionRecordEditContext> => {
      entered.release(); await held.promise; operation.assertCurrent();
      return desktopRecordEditContext({
        person, workspaceRoot: operation.workspace.rootPath,
        capture: { openRecordSession: opened, writeAuthoredFile: vi.fn() }, withAdapter: async () => null,
        onCaptureSettled: () => () => undefined, signal });
    };
    const context = await f.create().openCliWorkspace(f.workspace);
    const result = context.collections!.writes.setFields({ recordPath: "tasks/one.md", fields: { status: "done" },
      author: { kind: "user", userId: "owner" } }).catch((error: unknown) => error);
    let drained: Promise<void> | undefined;
    try {
      await entered.promise;
      drained = f.authorities.invalidate("workspace");
      f.rows.set("workspace", { ...f.workspace });
    } finally { held.release(); await result; await drained; }
    expect(await result).toMatchObject({ message: expect.stringContaining("This workspace was closed. Open it again.") });
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("desktop CLI server callbacks", () => {
  it("starts the CLI server and returns its close handle", async () => {
    const f = fixture();
    const pending = f.create().startDesktopCliServer();
    expect(await pending).toBe(f.handle);
    expect(f.options().stateDir).toBe("state");
    await (await pending).close();
    expect(f.handle.close).toHaveBeenCalledOnce();
  });

  it("lists current registry rows and shared views at callback time", async () => {
    const f = fixture();
    let shared = false;
    f.dependencies.sharedViewOf = () => shared ? {} : null;
    await f.create().startDesktopCliServer();
    expect(f.options().listWorkspaces()).toEqual([{ workspaceId: "workspace", rootPath: f.workspace.rootPath, readOnly: false }]);
    shared = true;
    f.rows.set("workspace", { ...f.workspace, rootPath: resolve("moved") });
    expect(f.options().listWorkspaces()).toEqual([{ workspaceId: "workspace", rootPath: resolve("moved"), readOnly: true }]);
    const context = await f.options().openWorkspace(f.rows.get("workspace")!);
    expect(context.readOnly).toBe(true);
  });

  it("hands chat writes to the shared module and notifies and cloud-syncs every write", async () => {
    const f = fixture();
    await f.create().startDesktopCliServer();
    const options = f.options(); const context = await options.openWorkspace(f.workspace);
    expect(options.chatWrites).toBe(f.chatWrites);
    expect(options.localUserDisplayName()).toBe("Local name");
    // Covers writes outside chatWrites, such as provisioning General.
    await options.onWrite!(context);
    expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({ workspaceId: "workspace" });
    expect(f.dependencies.activity.queueCloudSync).toHaveBeenCalledWith("workspace");
    expect(f.dependencies.syncSharedChannelsForChatTarget).not.toHaveBeenCalled();
    expect(f.dependencies.chatDispatchService.scanWorkspace).not.toHaveBeenCalled();
  });

  it("awaits target read sync and updates pending message links", async () => {
    const f = fixture(); const held = deferred();
    const readEntered = deferred();
    f.dependencies.syncSharedChannelsForChatTarget = vi.fn(async () => {
      readEntered.release();
      await held.promise;
    });
    await f.create().startDesktopCliServer();
    const options = f.options(); const context = await options.openWorkspace(f.workspace);
    const target = { channelId: "channel" };
    let finished = false;
    const read = Promise.resolve(options.onRead!(context, target)).then(() => { finished = true; });
    try {
      await readEntered.promise;
      expect(finished).toBe(false);
    } finally { held.release(); await read; }
    expect(finished).toBe(true);
    expect(f.dependencies.syncSharedChannelsForChatTarget).toHaveBeenCalledWith("workspace", target);
    const link = { workspaceId: "workspace", runId: "run", messageId: "message" };
    options.onRunMessageLinkPending!(link); options.onRunMessageLinkSettled!(link); options.onRunMessageLinkAbandoned!(link);
    expect(f.dependencies.rememberPendingCliRunMessageLink).toHaveBeenNthCalledWith(1, link, true);
    expect(f.dependencies.rememberPendingCliRunMessageLink).toHaveBeenNthCalledWith(2, link, false);
    expect(f.dependencies.rememberPendingCliRunMessageLink).toHaveBeenNthCalledWith(3, link, false);
    expect(f.dependencies.chatDispatchService.scanWorkspace).toHaveBeenCalledOnce();
  });

  it("reports rejected background work and exposes server error and debug callbacks", async () => {
    const f = fixture(); const error = new Error("offline");
    const recoveryLogged = deferred();
    const errorLog = vi.spyOn(console, "error").mockImplementation((message) => {
      if (message === "[desktop] CLI provenance recovery scan:") recoveryLogged.release();
    });
    const debugLog = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    f.dependencies.chatDispatchService.scanWorkspace = async () => { throw error; };
    await f.create().startDesktopCliServer();
    const options = f.options();
    options.onRunMessageLinkSettled!({ workspaceId: "workspace", runId: "run", messageId: "message" });
    await recoveryLogged.promise;
    options.onError!(error); options.onDebug!("listening");
    expect(errorLog.mock.calls).toEqual([
      ["[desktop] CLI provenance recovery scan:", error], ["[desktop] CLI server:", error],
    ]);
    expect(debugLog).toHaveBeenCalledWith("[desktop] CLI server: listening");
  });
});


describe("raw fileWrite socket requests", () => {
  async function setup() {
    const root = await createTestScratch("dohc-cli-file-write-");
    const f = fixture(root);
    await f.create().startDesktopCliServer();
    const invoke = async (files: CliFileWrite[], actor = "agent", agent?: string) => {
      const line = await handleCliRequestLine(JSON.stringify({
        token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileWrite",
        args: { cwd: root, actor, agent, requestId: "raw", files },
      }), "a".repeat(64), f.options());
      const transport = cliTransportResponseSchema.parse(JSON.parse(line));
      return transport.ok ? parseCliResult("fileWrite", transport.result) : { ok: false, reason: transport.error };
    };
    return { ...f, invoke };
  }

  it("refuses a human actor and a shared view before capture", async () => {
    const f = await setup();
    const files = [{ path: "plain.txt", contentBase64: "bmV3" }];
    expect(await f.invoke(files, "human")).toMatchObject({ ok: false, reason: expect.stringContaining('actor "agent"') });
    f.options().listWorkspaces = () => [{ ...f.workspace, readOnly: true }];
    expect(await f.invoke(files)).toMatchObject({ ok: false, reason: expect.stringContaining("read-only") });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });
  it.each(["../escape.txt", ".env", "plain.md", "plain.markdown", "scene.excalidraw"])("refuses %s without MCP checks", async path => {
    const f = await setup();
    expect(await f.invoke([{ path, contentBase64: "bmV3" }])).toMatchObject({ ok: false });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });
  it.each([undefined, "Client name"])("records the %s handshake name at the run depth", async agent => {
    const f = await setup();
    vi.mocked(f.dependencies.activity.agentRunDepth).mockReturnValue(4);
    expect(await f.invoke([{ path: "plain.txt", contentBase64: "bmV3" }], "agent", agent)).toEqual({ ok: true, written: ["plain.txt"] });
    expect(f.capture.writeAuthoredFile.mock.calls[0]?.[2]).toEqual({ kind: "agent", agentId: agent ?? "dohc-mcp", onBehalfOf: "person-local", depth: 4 });
  });
  it("enforces byte limits and base64 validation without MCP", async () => {
    const f = await setup();
    expect(await f.invoke([{ path: "large.txt", contentBase64: Buffer.alloc(10 * 1024 * 1024, 97).toString("base64") }])).toMatchObject({ ok: true });
    f.capture.writeAuthoredFile.mockClear();
    expect(await f.invoke([{ path: "large.txt", contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") }])).toMatchObject({ ok: false, reason: expect.stringContaining("10 MiB") });
    expect(await f.invoke([{ path: "large.txt", contentBase64: "!!!" }])).toMatchObject({ ok: false, reason: expect.stringContaining("base64") });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });
  it("refuses excluded paths and aliases through raw requests", async () => {
    const f = await setup();
    await mkdir(join(f.workspace.rootPath, ".dohc"), { recursive: true });
    await writeFile(join(f.workspace.rootPath, ".dohc/files.toml"), '[[rule]]\npath = "hidden.txt"\ntracked = false\n');
    for (const name of ["hidden.txt", ".env", "notes.md", "scene.excalidraw"]) {
      await writeFile(join(f.workspace.rootPath, name), "original");
      const alias = name.replaceAll(".", "_") + ".txt";
      await symlink(join(f.workspace.rootPath, name), join(f.workspace.rootPath, alias));
      expect(await f.invoke([{ path: alias, contentBase64: "bmV3" }])).toMatchObject({ ok: false });
      expect(await readFile(join(f.workspace.rootPath, name), "utf8")).toBe("original");
    }
    expect(await f.invoke([{ path: "hidden.txt", contentBase64: "bmV3" }])).toMatchObject({ ok: false });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "win32")("refuses trailing dots and spaces through raw fileWrite requests", async () => {
    const f = await setup();
    for (const path of ["file.", "file ", "folder./file.txt", "folder /file.txt"]) {
      expect(await f.invoke([{ path, contentBase64: "bmV3" }]))
        .toMatchObject({ ok: false, written: [], reason: expect.stringContaining("Windows removes trailing dots and spaces") });
    }
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it("writes for an agent in a workspace opened through a link", async () => {
    const real = await createTestScratch("dohc-cli-linked-real-");
    const opened = join(await createTestScratch("dohc-cli-linked-"), "linked");
    await symlink(real, opened, process.platform === "win32" ? "junction" : "dir");
    const registered = await createWorkspaceFolder({
      rootPath: opened, homeDir: await createTestScratch("dohc-cli-linked-home-"), kind: "personal", computer: { installId: "install-here", label: "This Mac" },
    });
    // The authority resolves roots the way main does.
    const f = fixture(registered.rootPath, (root) => realpathSync.native(root));
    await f.create().startDesktopCliServer();
    const line = await handleCliRequestLine(JSON.stringify({
      token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileWrite",
      args: { cwd: opened, actor: "agent", requestId: "linked", files: [{ path: "plain.txt", contentBase64: "bmV3" }] },
    }), "a".repeat(64), f.options());
    const transport = cliTransportResponseSchema.parse(JSON.parse(line));
    expect(transport.ok ? parseCliResult("fileWrite", transport.result) : transport.error).toEqual({ ok: true, written: ["plain.txt"] });
    expect(await readFile(join(real, "plain.txt"), "utf8")).toBe("new");
  });

  it("returns currentSha256 through the raw request on a stale write", async () => {
    const f = await setup();
    await writeFile(join(f.workspace.rootPath, "plain.txt"), "original");
    f.capture.writeAuthoredFile.mockRejectedValueOnce(new AuthoredTextChangedError("plain.txt"));
    expect(await f.invoke([{ path: "plain.txt", contentBase64: "bmV3", expectedSha256: "0".repeat(64) }])).toMatchObject({ ok: false, written: [], currentSha256: createHash("sha256").update("original").digest("hex") });
    expect(await readFile(join(f.workspace.rootPath, "plain.txt"), "utf8")).toBe("original");
  });

});

describe("completed CLI writes during workspace close", () => {
  it.each(["fileWrite", "collectionSetFields"] as const)("returns a completed %s after its workspace closes", async verb => {
    const root = await createTestScratch("dohc-cli-completed-write-");
    await mkdir(join(root, ".dohc"));
    const f = fixture(root);
    const doc = new Y.Doc();
    let committed = false;
    let drained: Promise<void> | undefined;
    f.dependencies.withPhysicalWorkspaceOperation = (id, work) => f.authorities.withOperation(id, async operation => {
      const result = await work(operation);
      if (committed && !drained) drained = f.authorities.invalidate(id);
      return result;
    });
    const write = f.capture.writeAuthoredFile.getMockImplementation()!;
    f.capture.writeAuthoredFile.mockImplementation(async (...args) => {
      const result = await write(...args);
      committed = true;
      return result;
    });
    const session = {
      doc, initialUpdate: Y.encodeStateAsUpdate(doc),
      applyDecidedLocalUpdate: async (decide: (doc: Y.Doc) => Uint8Array | null, armed?: () => void) => {
        const update = decide(doc);
        if (update === null) return false;
        Y.applyUpdate(doc, update); armed?.(); return true;
      },
      settleNow: async () => {
        await mkdir(join(root, "tasks"), { recursive: true });
        await writeFile(join(root, "tasks/one.md"), `---\nstatus: ${doc.getMap("frontmatter").get("status")}\n---\n`);
        committed = true;
        return { materialized: true };
      },
      close: vi.fn(async () => undefined),
    } as unknown as WorkspaceEngineYDocProviderSession;
    f.dependencies.collectionEditContextFor = async (operation, person, signal) => desktopRecordEditContext({
      person, workspaceRoot: operation.workspace.rootPath,
      capture: { openRecordSession: async () => session, writeAuthoredFile: vi.fn() },
      withAdapter: async () => null, onCaptureSettled: () => () => undefined, signal,
    });
    await f.create().startDesktopCliServer();
    try {
      const args = verb === "fileWrite"
        ? { files: [{ path: "plain.txt", contentBase64: Buffer.from("finished").toString("base64"), createOnly: true }], requestId: "completed" }
        : { recordPath: "tasks/one.md", fields: { status: "done" } };
      const line = await handleCliRequestLine(JSON.stringify({
        token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, verb, args: { cwd: root, actor: "agent", ...args },
      }), "a".repeat(64), f.options());
      const transport = cliTransportResponseSchema.parse(JSON.parse(line));
      expect(committed).toBe(true);
      expect(drained).toBeDefined();
      expect(await readFile(join(root, verb === "fileWrite" ? "plain.txt" : "tasks/one.md"), "utf8"))
        .toBe(verb === "fileWrite" ? "finished" : "---\nstatus: done\n---\n");
      expect(transport.ok ? parseCliResult(verb, transport.result) : transport.error)
        .toEqual(verb === "fileWrite" ? { ok: true, written: ["plain.txt"] } : { ok: true, recordPath: "tasks/one.md" });
      if (verb === "collectionSetFields") expect(session.close).toHaveBeenCalledOnce();
    } finally {
      await drained;
      await f.authorities.close();
      doc.destroy();
    }
  });
});
describe("raw fileMove and fileDelete socket requests", () => {
  async function setup(configure?: (f: ReturnType<typeof fixture>) => void) {
    const root = await createTestScratch("dohc-cli-file-move-");
    await openedLocalState({ workspaceId: "workspace", rootPath: root });
    const f = fixture(root);
    configure?.(f);
    await f.create().startDesktopCliServer();
    const invoke = async (verb: "fileMove" | "fileDelete", args: Record<string, unknown>, actor = "agent") => {
      const line = await handleCliRequestLine(JSON.stringify({
        token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, verb, args: { cwd: root, actor, requestId: "raw", ...args },
      }), "a".repeat(64), f.options());
      const transport = cliTransportResponseSchema.parse(JSON.parse(line));
      return transport.ok ? parseCliResult(verb, transport.result) : { ok: false, reason: transport.error };
    };
    return { ...f, root, invoke };
  }

  it("tells an MCP mover that links were not updated when local state is not ready", async () => {
    const f = await setup();
    const engine = vi.spyOn(f.dependencies, "withEngineAdapter");
    await writeFile(join(f.root, "old.md"), "original");
    const save = recovery.saveRecoveryRecord;
    const saving = vi.spyOn(recovery, "saveRecoveryRecord").mockImplementationOnce(async (...args) => {
      readLocalStateFrom({currentBinding: () => ({localStateReady: false}), localStateOpenAt: async () => ({current: () => true})});
      return save(...args);
    });
    try {
      const result = await moveWorkspacePath({root: f.root, home: "state", request: async input => {
        const line = await handleCliRequestLine(JSON.stringify({...input, token: "a".repeat(64)}), "a".repeat(64), f.options());
        const response = cliTransportResponseSchema.parse(JSON.parse(line));
        if (!response.ok) throw new Error(response.error);
        return response.result;
      }}, {fromPath: "old.md", toPath: "new.md"}, "Client");
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(saving).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ok: true, fromPath: "old.md", toPath: "new.md", undo: {available: false, paths: [],
        reason: "Rename finished. dohc could not save Undo information or update links to this file. Rename it back yourself."}});
      const authored = vi.mocked(f.capture.changePathsAs).mock.calls[0]![1];
      expect(authored).toMatchObject({author: {kind: "agent", agentId: "Client"}});
      expect(await readMoveRecovery(f.root, authored.operationId)).toBeUndefined();
      expect(await readFile(join(f.root, "new.md"), "utf8")).toBe("original");
      expect(engine).not.toHaveBeenCalled();
    } finally { await f.authorities.close(); }
  });

  it.each(["fileDelete", "fileMove"] as const)("returns a completed %s with Undo after its workspace closes", async verb => {
    let drained: Promise<void> | undefined;
    const f = await setup(f => {
      f.dependencies.withPhysicalWorkspaceOperation = (id, work) => f.authorities.withOperation(id, async operation => {
        const result = await work(operation);
        // Retire after preparation returns, before completion runs.
        if (vi.mocked(f.capture.changePathsAs).mock.calls.length) drained = f.authorities.invalidate(id);
        return result;
      });
    });
    await writeFile(join(f.root, "plain.txt"), "original");
    try {
      const result = await f.invoke(verb, verb === "fileDelete"
        ? { path: "plain.txt" } : { fromPath: "plain.txt", toPath: "moved.txt" });
      const { operationId } = vi.mocked(f.capture.changePathsAs).mock.calls[0]![1];
      expect(result).toMatchObject({ ok: true, operationId, undo: { available: true } });
      await expect(lstat(join(f.root, "plain.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await waitForRecovery(operationId);
      if (verb === "fileDelete") {
        expect(f.dependencies.trashItem).toHaveBeenCalledOnce();
        const record = await readDeleteRecovery(f.root, operationId);
        expect(record).toMatchObject({ operationId, tracked: true, staged: expect.any(String) });
        expect(await readFile(join(f.root, ".dohc/local/trash", record!.staged!), "utf8")).toBe("original");
      } else {
        expect(await readMoveRecovery(f.root, operationId)).toMatchObject({ operationId, tracked: true, from: "plain.txt", to: "moved.txt" });
        expect(await readFile(join(f.root, "moved.txt"), "utf8")).toBe("original");
      }
    } finally {
      await drained;
      await f.authorities.close();
    }
  });

  it.each(["fileDelete", "fileMove"] as const)("keeps a failed %s failed when the workspace closes after preparation", async verb => {
    let drained: Promise<void> | undefined;
    const f = await setup(f => {
      f.dependencies.withPhysicalWorkspaceOperation = (id, work) => f.authorities.withOperation(id, async operation => {
        const result = await work(operation);
        if (vi.mocked(f.capture.changePathsAs).mock.calls.length) drained = f.authorities.invalidate(id);
        return result;
      });
    });
    await writeFile(join(f.root, "plain.txt"), "original");
    vi.mocked(f.capture.changePathsAs).mockRejectedValueOnce(new Error("History could not record this change."));
    try {
      expect(await f.invoke(verb, verb === "fileDelete"
        ? { path: "plain.txt" } : { fromPath: "plain.txt", toPath: "moved.txt" }))
        .toMatchObject({ ok: false, reason: "History could not record this change." });
      expect(await readFile(join(f.root, "plain.txt"), "utf8")).toBe("original");
      expect(f.dependencies.trashItem).not.toHaveBeenCalled();
    } finally {
      await drained;
      await f.authorities.close();
    }
  });

  it.each(["fileDelete", "fileMove"] as const)("reports a rejecting %s completion after the workspace closes", async verb => {
    const finish = vi.fn(async () => { throw new Error("Completion failed."); });
    vi.spyOn(workspaceFileMoves, verb === "fileDelete" ? "prepareDeleteWorkspacePathAs" : "prepareMoveWorkspacePathAs")
      .mockResolvedValueOnce(finish);
    let drained: Promise<void> | undefined;
    const f = await setup(f => {
      let calls = 0;
      f.dependencies.withPhysicalWorkspaceOperation = (id, work) => f.authorities.withOperation(id, async operation => {
        const result = await work(operation);
        // The first operation opens the CLI context; the next prepares the change.
        if (++calls === 2) drained = f.authorities.invalidate(id);
        return result;
      });
    });
    try {
      expect(await f.invoke(verb, verb === "fileDelete"
        ? { path: "plain.txt" } : { fromPath: "plain.txt", toPath: "moved.txt" }))
        .toMatchObject({ ok: false, reason: "Completion failed." });
      expect(finish).toHaveBeenCalledOnce();
      expect(drained).toBeDefined();
    } finally {
      await drained;
      await f.authorities.close();
    }
  });

  it("returns the final recovery record when system trash takes a delete after close", async () => {
    let drained: Promise<void> | undefined;
    const f = await setup(f => {
      f.dependencies.withPhysicalWorkspaceOperation = (id, work) => f.authorities.withOperation(id, async operation => {
        const result = await work(operation);
        if (vi.mocked(f.capture.changePathsAs).mock.calls.length) drained = f.authorities.invalidate(id);
        return result;
      });
      f.dependencies.trashItem = vi.fn(async path => {
        expect(drained).toBeDefined();
        await drained;
        await rm(path);
      });
    });
    await writeFile(join(f.root, "plain.txt"), "original");
    try {
      const result = await f.invoke("fileDelete", { path: "plain.txt" });
      const { operationId } = vi.mocked(f.capture.changePathsAs).mock.calls[0]![1];
      expect(result).toMatchObject({ ok: true, trashed: true, operationId, undo: { available: true } });
      expect(f.dependencies.trashItem).toHaveBeenCalledOnce();
      await waitForRecovery(operationId);
      const record = await readDeleteRecovery(f.root, operationId);
      expect(record).toMatchObject({ operationId, tracked: true, paths: [] });
      expect(record).not.toHaveProperty("staged");
      expect(record).not.toHaveProperty("noUndo");
      await expect(lstat(join(f.root, "plain.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await drained;
      await f.authorities.close();
    }
  });

  it("saves recovery and restores a delete retired between the trash move and markDeleted", async () => {
    const f = await setup();
    await mkdir(join(f.root, "folder"));
    await writeFile(join(f.root, "folder/tracked.txt"), "tracked original");
    const rowless = Buffer.from([0xff, 0x00, 0xfe]);
    await writeFile(join(f.root, "folder/rowless.bin"), rowless);
    let drained: Promise<void> | undefined;
    let attachmentId: symbol | undefined;
    vi.mocked(f.capture.changePathsAs).mockImplementation(async (_paths, _authored, work) => work({
      policy: await readWorkspaceEnginePolicy(f.root),
      readDuplicate: async () => null, hasPath: async () => false,
      duplicateFile: async () => { throw new Error("unexpected Duplicate"); },
      recordDisk: async () => ["folder/tracked.txt"],
      delete: async () => {
        // History records the delete after the folder has moved into the trash.
        await expect(lstat(join(f.root, "folder"))).rejects.toMatchObject({ code: "ENOENT" });
        attachmentId = f.authorities.currentBinding(f.workspace.workspaceId).attachmentId;
        drained = f.authorities.invalidate(f.workspace.workspaceId);
        return "delete-moment";
      },
      moveFile: async () => false, rename: async () => undefined, undoDelete: async () => undefined,
    }));
    const history = {
      readHistoryPage: vi.fn(async () => ({ moments: [
        { momentId: "delete-moment", operation: "delete", path: "folder/tracked.txt" },
      ], protectedMoments: [], nextCursor: null })),
      undoHistoryOperation: vi.fn(async (input: { operationId: string }) => {
        await mkdir(join(f.root, "folder"), { recursive: true });
        await writeFile(join(f.root, "folder/tracked.txt"), "tracked original");
        return { operationId: input.operationId, versionId: "main", momentCount: 1,
          notRestored: [], compensationOperationId: "dohc-operation:11111111-1111-4111-8111-111111111111",
          deduped: false, materialized: true };
      }),
    };
    f.dependencies.withEngineAdapter = async (_workspace, work) => work(history as unknown as VersionedLiveAdapter);
    try {
      const result = await f.invoke("fileDelete", { path: "folder" });
      expect(result).toMatchObject({ ok: true, operationId: expect.stringMatching(/^dohc-operation:/), undo: { available: true } });
      if (!result.ok || !("operationId" in result) || typeof result.operationId !== "string") throw new Error("Delete returned no operation id");
      const { operationId } = result;
      await drained;
      await waitForRecovery(operationId);
      const record = await readDeleteRecovery(f.root, operationId);
      expect(record).toMatchObject({ tracked: true, paths: ["folder/rowless.bin"], staged: expect.any(String) });
      expect(await readFile(join(f.root, ".dohc/local/trash", record!.staged!, "rowless.bin"))).toEqual(rowless);
      expect(f.dependencies.markDeletedUnderPath).toHaveBeenCalledWith(attachmentId, "folder");
      expect(f.dependencies.trashItem).toHaveBeenCalledOnce();
      const reopened = await f.create().openCliWorkspace(f.workspace);
      expect(await reopened.historyUndo!({ operationId }, { attribution: { actorKind: "agent", onBehalfOf: "person-local" } }))
        .toMatchObject({ ok: true, tracked: { state: "restored", momentCount: 1 }, restored: ["folder/rowless.bin"], remaining: [] });
      expect(history.undoHistoryOperation).toHaveBeenCalledOnce();
      expect(await readFile(join(f.root, "folder/tracked.txt"), "utf8")).toBe("tracked original");
      expect(await readFile(join(f.root, "folder/rowless.bin"))).toEqual(rowless);
    } finally {
      await drained;
      await f.authorities.close();
    }
  });

  it.each(["delete", "overwrite"] as const)("a hung trash during %s holds neither file verbs nor workspace close", async change => {
    const f = await setup();
    const context = await f.create().openCliWorkspace(f.workspace);
    await writeFile(join(f.root, "first.txt"), "first");
    await writeFile(join(f.root, "source.txt"), "source");
    await writeFile(join(f.root, "next.txt"), "next");
    const entered = deferred(), released = deferred();
    vi.mocked(f.dependencies.trashItem).mockImplementationOnce(async () => {
      entered.release();
      await released.promise;
    });
    const pending = change === "delete" ? f.invoke("fileDelete", { path: "first.txt" })
      : f.invoke("fileMove", { fromPath: "source.txt", toPath: "first.txt", overwrite: true });
    await entered.promise;
    let undo: Promise<unknown> | undefined;
    try {
      if (change === "delete") {
        const { operationId } = vi.mocked(f.capture.changePathsAs).mock.calls[0]![1];
        undo = context.historyUndo!({ operationId }, { attribution: { actorKind: "agent", onBehalfOf: "person-local", depth: 0 } })
          .catch(error => ({ ok: false, reason: error.message }));
      }
      expect(await f.invoke("fileMove", { fromPath: "next.txt", toPath: "after.txt" })).toMatchObject({ ok: true });
      await f.authorities.close();
      if (undo) expect(await undo).toEqual({ ok: false, reason: "This workspace was closed. Open it again." });
    } finally {
      released.release();
      expect(await pending).toMatchObject({ ok: true });
      await undo;
    }
  });

  it("refuses a human actor and a shared view before capture", async () => {
    const f = await setup();
    await writeFile(join(f.root, "plain.txt"), "original");
    expect(await f.invoke("fileMove", { fromPath: "plain.txt", toPath: "moved.txt" }, "human")).toMatchObject({ ok: false, reason: expect.stringContaining('actor "agent"') });
    expect(await f.invoke("fileDelete", { path: "plain.txt" }, "human")).toMatchObject({ ok: false, reason: expect.stringContaining('actor "agent"') });
    f.options().listWorkspaces = () => [{ ...f.workspace, readOnly: true }];
    expect(await f.invoke("fileDelete", { path: "plain.txt" })).toMatchObject({ ok: false, reason: expect.stringContaining("read-only") });
    expect(f.capture.changePathsAs).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, "plain.txt"), "utf8")).toBe("original");
  });

  it("refuses traversal, reserved, secret, and excluded paths, spelled or inside a folder", async () => {
    const f = await setup();
    await writeFile(join(f.root, ".dohc/files.toml"), '[[rule]]\npath = "hidden/**"\ntracked = false\n');
    await mkdir(join(f.root, "hidden"));
    await writeFile(join(f.root, "hidden/a.txt"), "hidden");
    await mkdir(join(f.root, "app"));
    await writeFile(join(f.root, "app/.env"), "TOKEN=1");
    await writeFile(join(f.root, "plain.txt"), "original");
    for (const path of ["../escape.txt", ".dohc/files.toml", ".env", "hidden", "app"]) {
      expect(await f.invoke("fileDelete", { path })).toMatchObject({ ok: false });
      expect(await f.invoke("fileMove", { fromPath: path, toPath: "elsewhere" })).toMatchObject({ ok: false });
      expect(await f.invoke("fileMove", { fromPath: "plain.txt", toPath: path === "app" ? "app/.env" : path })).toMatchObject({ ok: false });
    }
    // Every refusal leaves the disk as it was.
    expect(await readFile(join(f.root, "app/.env"), "utf8")).toBe("TOKEN=1");
    expect(await readFile(join(f.root, "hidden/a.txt"), "utf8")).toBe("hidden");
    expect(await readFile(join(f.root, "plain.txt"), "utf8")).toBe("original");
  });

  it.each([undefined, "Client name"])("records the %s handshake name at the run depth", async agent => {
    const f = await setup();
    vi.mocked(f.dependencies.activity.agentRunDepth).mockReturnValue(4);
    await writeFile(join(f.root, "plain.txt"), "original");
    expect(await f.invoke("fileMove", { fromPath: "plain.txt", toPath: "moved.txt", ...(agent ? { agent } : {}) }))
      .toEqual({ ok: true, operationId: expect.stringMatching(/^dohc-operation:[0-9a-f-]{36}$/), fromPath: "plain.txt", toPath: "moved.txt", undo: { available: true } });
    expect(await f.invoke("fileDelete", { path: "moved.txt", ...(agent ? { agent } : {}) })).toMatchObject({ ok: true, path: "moved.txt", trashed: false, trashPath: expect.stringMatching(/^\.dohc\/local\/trash\//) });
    const author = { kind: "agent", agentId: agent ?? "dohc-mcp", onBehalfOf: "person-local", depth: 4 };
    expect(vi.mocked(f.capture.changePathsAs).mock.calls.map(call => call[1])).toEqual([
      { operation: "move", author, operationId: expect.stringMatching(/^dohc-operation:/) }, { operation: "delete", author, operationId: expect.stringMatching(/^dohc-operation:/) },
    ]);
    expect(f.dependencies.markDeletedUnderPath).toHaveBeenCalledWith(expect.any(Symbol), "moved.txt");
  });
});

it("keeps the saved pause result when the physical attachment retires before the socket reply", async () => {
  const f = fixture();
  let drained: Promise<void> | undefined;
  f.dependencies.stopWorkspaceSync = vi.fn<NonNullable<Dependencies["stopWorkspaceSync"]>>(async operation => {
    const workspaceId = operation.workspace.workspaceId;
    drained = f.authorities.invalidate(workspaceId);
    return { ok: true, workspaceId, workspaceSynced: false };
  });
  const context = await f.create().openCliWorkspace(f.workspace);
  const author = { kind: "agent" as const, agentId: "Claude", onBehalfOf: "person-local", depth: 0 };
  await expect(context.stopSync!(author)).resolves.toMatchObject({ ok: true, workspaceId: "workspace", workspaceSynced: false });
  await drained;
});

// Exercise both agent doors through desktop attachment admission and the real relay copy route.
afterEach(closeTestStorages);
async function shareCopyFixture() {
  const root = await createTestScratch("dohc-cli-share-copy-");
  const f = fixture(root);
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 });
  storage.claimWorkspace({ workspaceId: "other-workspace", ownerUserId: "owner", createdAtMs: 1 });
  const share = { shareId: "share", workspaceId: "workspace", granterUserId: "owner",
    selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 1 };
  const grant = { grantId: "grant", shareId: "share", principalKind: "user" as const, principalUserId: "friend",
    principalEmail: null, access: "edit", generation: 1, status: "active" as const, createdAtMs: 1, revokedAtMs: null, parentGrantId: null };
  storage.createShare({ share, grant });
  storage.createShare({ share: { ...share, shareId: "foreign", workspaceId: "other-workspace" },
    grant: { ...grant, shareId: "foreign", grantId: "foreign-grant" } });
  const handler = testHandler(storage, { relayExchangeKey: RELAY_EXCHANGE_KEY, namedBrowserSessionLimits: {
    maxSessions: 8, retentionMs: 30000, maxPendingRequests: 4, maxRequestBytes: 16384, maxResponseBytes: 16384, timeoutMs: 1000,
  } });
  let credentials: CloudCredentials = { serverUrl: "https://cloud.test", relayUrl: "https://relay.test",
    userId: "owner", email: "owner@test", token: "secret" };
  let generation = 1;
  const remote = vi.fn(async (workspace: RegistryEntry) => {
    if (!workspaceRemoteMatchesCredentials(workspace.remote!, credentials)) throw Error("Sign in to the account that synced this workspace.");
    return { credentials, credentialGeneration: generation };
  });
  const relay = vi.fn(async (account: CloudCredentials, path: string) => {
    const response = await handler(relayRequest(account.userId, path));
    if (!response.ok) throw Error(response.status === 404 ? "Share not found." : "Relay failure: " + response.status);
    return response.json();
  });
  f.dependencies.shareCopy = createShareCopyReader({ remoteForWorkspace: remote, currentCredentialGeneration: () => generation, relayJson: relay });
  await f.create().startDesktopCliServer();
  const transport = async (input: CliRequestWithoutToken) => {
    const line = await handleCliRequestLine(JSON.stringify({ ...input, token: "a".repeat(64) }), "a".repeat(64), f.options());
    const response = cliTransportResponseSchema.parse(JSON.parse(line));
    if (!response.ok) throw Error(response.error);
    return response.result;
  };
  const copy = async (door: "cli" | "mcp", shareId = "share", grantId = "grant") => {
    if (door === "mcp") return getShareCopyDetails({ root, home: "state", request: transport }, { shareId, grantId });
    const result = await executeCli({ argv: ["share", "copy", shareId, grantId, "--json"], cwd: root, env: {}, request: transport });
    if (result.exitCode !== 0) return { ok: false, reason: result.stderr };
    const { schemaVersion: _schemaVersion, ...details } = JSON.parse(result.stdout);
    return details;
  };
  return { ...f, copy, remote, relay, storage, rotate: () => { generation++; },
    otherAccount: () => { credentials = { ...credentials, userId: "stranger" }; } };
}

describe.each(["cli", "mcp"] as const)("share copy through %s", door => {
  it("returns the owner's exact details without credentials", async () => {
    const f = await shareCopyFixture();
    expect(await f.copy(door)).toEqual({ status: "active", shareCode: "dohc-share:share:https://relay.test",
      browserInvitationUrl: SHARE_WEB_ORIGIN + "/s/edit/grant" });
    expect(f.relay.mock.lastCall?.[1]).toBe("/sync/workspace/shares/share/grants/grant/copy");
  });
  it("refuses another account before contacting the relay", async () => {
    const f = await shareCopyFixture(); f.otherAccount();
    expect(await f.copy(door)).toMatchObject({ ok: false, reason: expect.stringContaining("Sign in") });
    expect(f.relay).not.toHaveBeenCalled();
  });
  it("refuses when the relay workspace belongs to another account", async () => {
    const f = await shareCopyFixture();
    const db = inspectDatabase(storagePath(f.storage));
    try {
      db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'stranger' WHERE workspace_id = 'workspace'").run();
    } finally { db.close(); }
    expect(await f.copy(door)).toMatchObject({ ok: false, reason: expect.stringContaining("not found") });
    expect(f.remote).toHaveBeenCalledOnce();
    expect(f.relay).toHaveBeenCalledOnce();
  });
  it("refuses a received workspace at socket per-verb admission", async () => {
    const f = await shareCopyFixture(); vi.mocked(f.dependencies.sharedViewOf).mockReturnValue({});
    expect(await f.copy(door)).toMatchObject({ ok: false, reason: expect.stringContaining("owning workspace") });
    expect(f.remote).not.toHaveBeenCalled();
  });
  it("refuses a received marker before reading credentials", async () => {
    const f = await shareCopyFixture(); f.workspace.shareView = {} as RegistryEntry["shareView"];
    expect(await f.copy(door)).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    expect(f.remote).not.toHaveBeenCalled();
  });
  it.each(["unknown", "link", "damaged", "foreign-workspace", "foreign-grant"])("refuses an %s grant", async kind => {
    const f = await shareCopyFixture();
    const db = inspectDatabase(storagePath(f.storage));
    try {
      if (kind === "link") db.prepare("UPDATE sync_relay_share_grants SET principal_kind = 'link', principal_user_id = NULL WHERE grant_id = 'grant'").run();
      if (kind === "damaged") db.prepare("UPDATE sync_relay_shares SET selector_json = '{}' WHERE share_id = 'share'").run();
    } finally { db.close(); }
    const result = await f.copy(door, kind === "foreign-workspace" ? "foreign" : "share",
      kind === "unknown" ? "unknown" : kind.startsWith("foreign") ? "foreign-grant" : "grant");
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("not found") });
  });
  it("returns only ended after revocation", async () => {
    const f = await shareCopyFixture(); f.storage.revokeShare("share", 2);
    expect(await f.copy(door)).toEqual({ status: "ended" });
  });
  it.each(["workspaceId", "shareId", "grantId"])("refuses mismatched %s in the relay reply", async key => {
    const f = await shareCopyFixture();
    f.relay.mockResolvedValue({ workspaceId: "workspace", shareId: "share", grantId: "grant", status: "active", [key]: "other" });
    expect(await f.copy(door)).toMatchObject({ ok: false, reason: expect.stringContaining("share changed") });
  });
  it("discards a reply after the credential generation changes", async () => {
    const f = await shareCopyFixture();
    f.relay.mockImplementation(async () => { f.rotate(); return { workspaceId: "workspace", shareId: "share", grantId: "grant", status: "active" }; });
    expect(await f.copy(door)).toMatchObject({ ok: false });
  });
  it("refuses a retired desktop attachment before reading credentials", async () => {
    const f = await shareCopyFixture(); const context = await f.create().openCliWorkspace(f.workspace);
    await f.authorities.invalidate("workspace");
    await expect(context.shareCopy!({ shareId: "share", grantId: "grant" })).rejects.toThrow("This workspace changed while this ran. Try again.");
    expect(f.remote).not.toHaveBeenCalled();
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
  const row = (objectId: string, path: string, incident = "outbox:delivery:0", recovery: OwnerLiveQuarantine["recovery"] = "paused"): OwnerLiveQuarantine =>
    ({ objectId, path, reason: "invalid-update", storedOn: "this-computer", incident, recovery });
  const kept: Record<string, OwnerLiveQuarantine[]> = { workspace: [row("object-plan", "notes/plan.md")], other: [row("object-elsewhere", "elsewhere.md")] };
  const save = vi.fn(async (workspace: RegistryEntry, path: string, incident?: string) => {
    const found = kept[workspace.workspaceId]?.find(candidate => candidate.path === path && (incident === undefined || candidate.incident === incident));
    if (!found) throw new Error("dohc has no kept edits for this file. Open Live documents to check it.");
    // A copy of edits the server keeps is confirmed to it, as the desktop engine does.
    if (found.storedOn === "server") found.recovery = "copied";
    return { copyPath: path.replace(/\.md$/, " (recovered).md"), packagePath: path.replace(/\.md$/, " (recovered).dohc-recovery.json"), storedOn: found.storedOn,
      keptEdits: found.storedOn === "server" ? "copied" as const : "kept" as const };
  });
  const retry = vi.fn(async (workspace: RegistryEntry, objectId: string, _incident: string) => {
    const found = kept[workspace.workspaceId]?.find(candidate => candidate.objectId === objectId);
    if (!found || (found.recovery !== "paused" && !(found.storedOn === "server" && found.recovery === "copied"))) throw new Error("This document changed. Open Live documents to check it.");
    found.recovery = "retrying";
  });
  // Stands in for the window's guarded Stop of the row's document: a not-written release writes the file and its row ends.
  const stoppedIn: string[] = [];
  const stopAgain = vi.fn(async (operation: { workspace: RegistryEntry }, again: { path: string; objectId: string; recovery: "not-written" | "stopping" }) => {
    stoppedIn.push(operation.workspace.workspaceId);
    const rows = kept[operation.workspace.workspaceId] ?? [];
    const found = rows.find(candidate => candidate.objectId === again.objectId && again.recovery === "not-written" && candidate.recovery === "not-written");
    if (found) rows.splice(rows.indexOf(found), 1);
    return { keptEdits: found ? "recovered" as const : "kept" as const };
  });
  if (options.engine !== false) f.dependencies.ownerLiveRecovery = { keptEdits: workspaceId => kept[workspaceId] ?? [], save, retry, stopAgain };
  await f.create().startDesktopCliServer();
  const transport = async (input: CliRequestWithoutToken) => {
    const line = await handleCliRequestLine(JSON.stringify({ ...input, token: "a".repeat(64) }), "a".repeat(64), f.options());
    const response = cliTransportResponseSchema.parse(JSON.parse(line));
    if (!response.ok) throw Error(response.error);
    return response.result;
  };
  const cli = async (...argv: string[]) => {
    const result = await executeCli({ argv: ["document", ...argv, "--json"], cwd, env: {}, request: transport });
    if (result.exitCode !== 0) return { ok: false, reason: result.stderr };
    const { schemaVersion: _schemaVersion, ...answer } = JSON.parse(result.stdout);
    return answer;
  };
  const ctx = { root: cwd, home: join(root, "state"), request: transport };
  const doors = {
    cli: {
      list: () => cli("kept-edits"),
      save: (path: string, incident?: string) => incident === undefined ? cli("save-recovery-copy", path) : cli("save-recovery-copy", path, incident),
      retry: (path: string, incident: string) => cli("retry-kept-edits", path, incident),
      stopAgain: (path: string, incident: string) => cli("stop-again", path, incident),
    },
    mcp: {
      list: async () => {
        const status = await workspaceStatus(ctx);
        return "keptEdits" in status ? { ok: true, keptEdits: status.keptEdits } : { ok: false, reason: "no keptEdits" };
      },
      save: (path: string, incident?: string) => saveRecoveryCopy(ctx, incident === undefined ? { path } : { path, incident }),
      retry: (path: string, incident: string) => retryKeptEdits(ctx, { path, incident }),
      stopAgain: (path: string, incident: string) => stopAgainTool(ctx, { path, incident }),
    },
  };
  return { ...f, root, kept, row, save, retry, stopAgain, stoppedIn, doors };
}

describe.each(["cli", "mcp"] as const)("kept edits through %s", door => {
  it("lists only this workspace's kept edits, without the engine's object ids", async () => {
    const f = await keptEditsFixture();
    expect(await f.doors[door].list()).toEqual({ ok: true, keptEdits: [
      { path: "notes/plan.md", reason: "invalid-update", storedOn: "this-computer", incident: "outbox:delivery:0", recovery: "paused" },
    ] });
  });
  it("saves a recovery copy next to the document and names both files and their folder", async () => {
    const f = await keptEditsFixture();
    expect(await f.doors[door].save("notes/plan.md")).toEqual({ ok: true,
      copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", folder: "notes", storedOn: "this-computer", keptEdits: "kept" });
    expect(f.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: "workspace" }), "notes/plan.md", undefined);
    expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({ workspaceId: "workspace" });
  });
  // With two rows at one path, the incident the caller read names which kept edits it saves.
  it("saves the row the incident names when two rows share a path", async () => {
    const f = await keptEditsFixture();
    f.kept.workspace = [f.row("object-released", "notes/plan.md", "release:a:0", "not-written"), f.row("object-plan", "notes/plan.md")];
    expect(await f.doors[door].save("notes/plan.md", "outbox:delivery:0")).toMatchObject({ ok: true, keptEdits: "kept" });
    expect(f.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: "workspace" }), "notes/plan.md", "outbox:delivery:0");
  });
  it("lists, saves and tries again edits the server keeps, as the window does", async () => {
    const f = await keptEditsFixture();
    f.kept.workspace = [{ ...f.row("object-plan", "notes/plan.md", "server:outbox:1"), storedOn: "server" }];
    expect(await f.doors[door].list()).toEqual({ ok: true, keptEdits: [
      { path: "notes/plan.md", reason: "invalid-update", storedOn: "server", incident: "server:outbox:1", recovery: "paused" },
    ] });
    expect(await f.doors[door].save("notes/plan.md")).toMatchObject({ ok: true, storedOn: "server", folder: "notes", keptEdits: "copied" });
    expect(await f.doors[door].list()).toMatchObject({ ok: true, keptEdits: [{ storedOn: "server", recovery: "copied" }] });
    expect(await f.doors[door].retry("notes/plan.md", "server:outbox:1")).toEqual({ ok: true, path: "notes/plan.md" });
    expect(f.retry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: "workspace" }), "object-plan", "server:outbox:1");
  });
  it("tries again the refusal the caller read, by the engine's own object id", async () => {
    const f = await keptEditsFixture();
    expect(await f.doors[door].retry("notes/plan.md", "outbox:delivery:0")).toEqual({ ok: true, path: "notes/plan.md" });
    expect(f.retry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: "workspace" }), "object-plan", "outbox:delivery:0");
    expect(await f.doors[door].list()).toMatchObject({ ok: true, keptEdits: [{ path: "notes/plan.md", recovery: "retrying" }] });
    expect(await f.doors[door].retry("notes/plan.md", "outbox:delivery:0")).toMatchObject({ ok: false, reason: expect.stringContaining("This document changed") });
  });
  it("tries again the row the incident names when two rows share a path", async () => {
    const f = await keptEditsFixture();
    f.kept.workspace = [f.row("object-released", "notes/plan.md", "release:a:0", "not-written"), f.row("object-plan", "notes/plan.md")];
    expect(await f.doors[door].retry("notes/plan.md", "outbox:delivery:0")).toEqual({ ok: true, path: "notes/plan.md" });
    expect(f.retry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: "workspace" }), "object-plan", "outbox:delivery:0");
  });
  // The Stop the window's Notices row runs again, for the row the caller read, under main's own admission.
  it("stops again a Stop that kept the edits, and only one", async () => {
    const f = await keptEditsFixture();
    f.kept.workspace = [f.row("object-plan", "notes/plan.md", "release:a:0", "not-written")];
    expect(await f.doors[door].stopAgain("notes/plan.md", "release:a:0")).toEqual({ ok: true, path: "notes/plan.md", keptEdits: "recovered" });
    expect(f.stoppedIn).toEqual(["workspace"]);
    expect(f.stopAgain.mock.calls.map(call => call[1])).toEqual([{ path: "notes/plan.md", objectId: "object-plan", recovery: "not-written" }]);
    expect(f.dependencies.notifyRenderer).toHaveBeenCalledWith({ workspaceId: "workspace" });
    expect(await f.doors[door].list()).toEqual({ ok: true, keptEdits: [] });
    // A waiting Stop runs again too; edits that wait for the owner are Try again's, not a Stop's.
    // With a record row beside it at the same path, the incident names the waiting Stop's document.
    f.kept.workspace = [f.row("object-released", "notes/plan.md", "release:a:0", "not-written"), f.row("object-plan", "notes/plan.md", "outbox:delivery:0", "stopping")];
    expect(await f.doors[door].stopAgain("notes/plan.md", "outbox:delivery:0")).toEqual({ ok: true, path: "notes/plan.md", keptEdits: "kept" });
    expect(f.stopAgain.mock.lastCall?.[1]).toEqual({ path: "notes/plan.md", objectId: "object-plan", recovery: "stopping" });
    for (const recovery of ["paused", "cannot-write", "retrying"] as const) {
      f.kept.workspace = [f.row("object-plan", "notes/plan.md", "outbox:delivery:1", recovery)];
      expect(await f.doors[door].stopAgain("notes/plan.md", "outbox:delivery:1")).toMatchObject({ ok: false, reason: expect.stringContaining("No Stop of notes/plan.md is waiting") });
    }
    expect(await f.doors[door].stopAgain("notes/plan.md", "outbox:delivery:9")).toMatchObject({ ok: false, reason: expect.stringContaining("no kept edits") });
    expect(await f.doors[door].stopAgain("../outside.md", "outbox:delivery:1")).toMatchObject({ ok: false });
    expect(f.stopAgain).toHaveBeenCalledTimes(2);
  });
  it("refuses Stop again from a received share or a received workspace", async () => {
    const shared = await keptEditsFixture({ caller: "shared-with-me/received" });
    shared.kept.workspace = [shared.row("object-plan", "notes/plan.md", "release:a:0", "not-written")];
    expect(await shared.doors[door].stopAgain("plan.md", "release:a:0")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    const received = await keptEditsFixture(); vi.mocked(received.dependencies.sharedViewOf).mockReturnValue({});
    received.kept.workspace = [received.row("object-plan", "notes/plan.md", "release:a:0", "not-written")];
    expect(await received.doors[door].stopAgain("notes/plan.md", "release:a:0")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    const marked = await keptEditsFixture(); marked.workspace.shareView = {} as RegistryEntry["shareView"];
    marked.kept.workspace = [marked.row("object-plan", "notes/plan.md", "release:a:0", "not-written")];
    expect(await marked.doors[door].stopAgain("notes/plan.md", "release:a:0")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    for (const f of [shared, received, marked]) expect(f.stopAgain).not.toHaveBeenCalled();
  });
  it("refuses an incident the caller has not read", async () => {
    const f = await keptEditsFixture();
    expect(await f.doors[door].retry("notes/plan.md", "outbox:delivery:9")).toMatchObject({ ok: false, reason: expect.stringContaining("no kept edits") });
    expect(f.retry).not.toHaveBeenCalled();
  });
  it("refuses a caller inside a received share's folder, which resolves to this workspace", async () => {
    const f = await keptEditsFixture({ caller: "shared-with-me/received" });
    expect(await f.doors[door].list()).toMatchObject({ ok: false });
    // A path inside the received folder passes the path rules, so only the guard refuses it.
    expect(await f.doors[door].save("plan.md")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    expect(await f.doors[door].retry("plan.md", "outbox:delivery:0")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    expect(await f.doors[door].save("../../notes/plan.md")).toMatchObject({ ok: false });
    expect(f.save).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled();
  });
  it("refuses a document with no kept edits", async () => {
    const f = await keptEditsFixture();
    await writeFile(join(f.root, "notes", "other.md"), "other");
    expect(await f.doors[door].save("notes/other.md")).toMatchObject({ ok: false, reason: expect.stringContaining("no kept edits") });
    expect(await f.doors[door].retry("notes/other.md", "outbox:delivery:0")).toMatchObject({ ok: false, reason: expect.stringContaining("no kept edits") });
    expect(f.retry).not.toHaveBeenCalled();
  });
  it("refuses another workspace's kept edits and a path outside this workspace", async () => {
    const f = await keptEditsFixture();
    expect(await f.doors[door].retry("elsewhere.md", "outbox:delivery:0")).toMatchObject({ ok: false, reason: expect.stringContaining("no kept edits") });
    expect(await f.doors[door].save("elsewhere.md")).toMatchObject({ ok: false, reason: expect.stringContaining("no kept edits") });
    expect(await f.doors[door].save("../outside.md")).toMatchObject({ ok: false, reason: expect.stringContaining("path rejected") });
    expect(f.retry).not.toHaveBeenCalled();
    expect(f.save.mock.calls.map(([workspace, path]) => [workspace.workspaceId, path])).toEqual([["workspace", "elsewhere.md"]]);
  });
  it("refuses a received workspace at socket per-verb admission", async () => {
    const f = await keptEditsFixture(); vi.mocked(f.dependencies.sharedViewOf).mockReturnValue({});
    expect(await f.doors[door].save("notes/plan.md")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    expect(await f.doors[door].retry("notes/plan.md", "outbox:delivery:0")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    expect(await f.doors[door].list()).toMatchObject({ ok: false });
    expect(f.save).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled();
  });
  it("refuses a received marker before reaching the engine", async () => {
    const f = await keptEditsFixture(); f.workspace.shareView = {} as RegistryEntry["shareView"];
    expect(await f.doors[door].save("notes/plan.md")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    expect(await f.doors[door].retry("notes/plan.md", "outbox:delivery:0")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    expect(await f.doors[door].list()).toMatchObject({ ok: false });
    expect(f.save).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled();
  });
  it("refuses when the desktop offers no recovery for this workspace", async () => {
    const f = await keptEditsFixture({ engine: false });
    expect(await f.doors[door].save("notes/plan.md")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
    expect(await f.doors[door].retry("notes/plan.md", "outbox:delivery:0")).toMatchObject({ ok: false, reason: expect.stringContaining("original workspace") });
  });
});

it("refuses kept edits on a retired desktop attachment before reaching the engine", async () => {
  const f = await keptEditsFixture(); const context = await f.create().openCliWorkspace(f.workspace);
  await f.authorities.invalidate("workspace");
  await expect(context.keptEdits!.saveRecoveryCopy("notes/plan.md")).rejects.toThrow("This workspace changed while this ran. Try again.");
  await expect(context.keptEdits!.retry("notes/plan.md", "outbox:delivery:0")).rejects.toThrow("This workspace changed while this ran. Try again.");
  await expect(context.keptEdits!.stopAgain("notes/plan.md", "outbox:delivery:0")).rejects.toThrow("This workspace changed while this ran. Try again.");
  expect(f.save).not.toHaveBeenCalled();
  expect(f.retry).not.toHaveBeenCalled();
  expect(f.stopAgain).not.toHaveBeenCalled();
});

it("gives CLI and MCP the IPC link answer in a share without Chats capture", async () => {
  const f = fixture(await createTestScratch("links-share-cli-"));
  f.setCapture(null); f.setDaemon(null);
  f.dependencies.sharedViewOf = () => ({ shareId: "share" }) as ReturnType<Dependencies["sharedViewOf"]>;
  const resolved = { versionId: "main", results: [{ path: "target.md", fragment: "heading" }], mountsCovered: true };
  const input = { source: "source.md", literals: [{ kind: "wikilink" as const, literal: "target#heading" }] };
  f.dependencies.links.resolve = vi.fn(async () => resolved);
  await f.create().startDesktopCliServer();
  const token = "a".repeat(64);
  const send = async (request: CliRequestWithoutToken) => {
    const response = cliTransportResponseSchema.parse(JSON.parse(await handleCliRequestLine(JSON.stringify({ ...request, token }), token, f.options())));
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const cli = await executeCli({ argv: ["links", "resolve", "source.md", JSON.stringify(input.literals), "--json"], cwd: f.workspace.rootPath, env: {}, request: send });
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout)).toMatchObject(resolved);
  const { linksResolve } = await import("@dohc/mcp/tools");
  expect(await linksResolve({ root: f.workspace.rootPath, home: "state", request: send }, input)).toEqual(resolved);
  expect(f.dependencies.openWorkspaceActivity).not.toHaveBeenCalled();
  expect(f.dependencies.linkedChatStoreFor).not.toHaveBeenCalled();
  expect(f.dependencies.links.resolve).toHaveBeenCalledTimes(2);
  const held = deferred();
  f.dependencies.links.resolve = vi.fn(async () => { await held.promise; return resolved; });
  const pending = f.options().links!.resolve(f.workspace, input);
  await vi.waitFor(() => expect(f.dependencies.links.resolve).toHaveBeenCalledOnce());
  const retired = f.authorities.invalidate(f.workspace.workspaceId);
  held.release();
  // Finished work reports as finished when the workspace closes during it.
  await expect(pending).resolves.toEqual(resolved);
  await retired;
});

it("returns an incoming page directly through CLI and MCP", async () => {
  const f = fixture(await createTestScratch("links-in-cli-"));
  const page = { versionId: "main", subject: { path: "a.md", objectId: "a" }, entries: [], unchecked: [], complete: true, indexBuilding: false, mountsCovered: true, nextCursor: null };
  f.dependencies.links.incoming = vi.fn(async () => page);
  await f.create().startDesktopCliServer();
  const token = "a".repeat(64);
  const send = async (request: CliRequestWithoutToken) => {
    const response = cliTransportResponseSchema.parse(JSON.parse(await handleCliRequestLine(JSON.stringify({ ...request, token }), token, f.options())));
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const subject = { path: "a.md" };
  const cli = await executeCli({ argv: ["links", "in", JSON.stringify(subject), "--json"], cwd: f.workspace.rootPath, env: {}, request: send });
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual({ schemaVersion: CLI_JSON_SCHEMA_VERSION, ...page });
  const { linksIn } = await import("@dohc/mcp/tools");
  expect(await linksIn({ root: f.workspace.rootPath, home: "state", request: send }, { subject })).toEqual(page);
});

it("returns an edge page directly through CLI and MCP", async () => {
  const f = fixture(await createTestScratch("links-edges-cli-"));
  const page = { versionId: "main", files: [], entries: [], unchecked: [], complete: true, indexBuilding: false, mountsCovered: true, nextCursor: null };
  f.dependencies.links.edges = vi.fn(async () => page);
  await f.create().startDesktopCliServer();
  const token = "a".repeat(64);
  const send = async (request: CliRequestWithoutToken) => {
    const response = cliTransportResponseSchema.parse(JSON.parse(await handleCliRequestLine(JSON.stringify({ ...request, token }), token, f.options())));
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };

  const cli = await executeCli({ argv: ["links", "edges", "--json"], cwd: f.workspace.rootPath, env: {}, request: send });
  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual({ schemaVersion: CLI_JSON_SCHEMA_VERSION, ...page });
  const { linksEdges } = await import("@dohc/mcp/tools");
  expect(await linksEdges({ root: f.workspace.rootPath, home: "state", request: send }, {})).toEqual(page);
});
