import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CHATS_METHOD, WORKSPACE_METHOD, type VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { createDesktopCliServer } from "./desktopCliServer";
import type { CliServerOptions, CliServerHandle } from "./cliServer";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { createChatWrites } from "../workspaces/chatWrites";
import type { CollectionRecordEditContext } from "../workspaces/collectionRecordEdits";
import type { WorkspaceEngineMomentSummary, WorkspaceEngineYDocProviderSession } from "../workspaces/workspaceEngineCapture";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}

type State = Record<string, never>;
type Dependencies = Parameters<typeof createDesktopCliServer<State>>[0];

function fixture(rootPath = resolve("cli-workspace")) {
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath, kind: "personal", mode: "local-first",
    remote: { serverUrl: "https://cloud.test", ownerUserId: "owner" },
  };
  const rows = new Map([[workspace.workspaceId, workspace]]);
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => rows.get(id) ?? null,
    canonicalizeRoot: resolve,
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
    localReactorFallbackId: () => "local:device",
    projectChatBookmarks: vi.fn(),
    queueCloudSync: vi.fn(),
    syncSharedChannelsForChatTarget: async () => undefined,
    scanChatDispatch: async () => undefined,
  });
  const dependencies: Dependencies = {
    findWorkspace: (id) => rows.get(id) ?? null,
    listWorkspaces: () => [...rows.values()],
    openWorkspaceActivity: vi.fn(async () => undefined),
    activity: { engineCaptureFor: vi.fn(() => currentCapture), queueCloudSync: vi.fn() },
    linkedChatStoreFor: vi.fn(() => store),
    currentDaemon: vi.fn(() => daemon),
    agentDispatchStoreHandleFor: vi.fn(() => ({ store: dispatchStore })),
    sharedViewOf: vi.fn(() => null),
    withPhysicalWorkspaceOperation: (id, work) => authorities.withOperation(id, work),
    collectionEditContextFor: vi.fn(async () => { throw new Error("No edit context configured"); }),
    withEngineAdapter: async () => null,
    chatWrites,
    startCliServer: vi.fn(async (input) => { options = input; return handle; }),
    stateDir: () => "state",
    localUserDisplayName: () => "Local name",
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
  it("keeps owner app actions bound to the CLI's original physical attachment", async () => {
    const f = fixture();
    const publish = vi.fn<NonNullable<Dependencies["ownerAppPublication"]>>(async () => ({ kind: "cancelled" }));
    f.dependencies.ownerAppPublication = publish;
    const context = await f.create().openCliWorkspace(f.workspace);
    const request = { action: "cancel" as const, workspaceId: f.workspace.workspaceId, approvalId: "00000000-0000-4000-8000-000000000001" };
    expect(await context.appPublication!(request)).toEqual({ kind: "cancelled" });
    await f.authorities.invalidate(f.workspace.workspaceId);
    await expect(context.appPublication!(request)).rejects.toThrow("attachment changed");
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
    const f = fixture();
    const moment: WorkspaceEngineMomentSummary = {
      id: "moment", versionId: "version", objectId: "object", path: "notes.md",
      recordedAtMs: 20, operation: "write", metadata: { origin: "api" },
      momentOrder: 3, protected: false, byteLength: 0, contentKind: "text",
      author: { kind: "agent", agentId: "agent", onBehalfOf: "owner" },
    };
    const { byteLength: _bytes, contentKind: _kind, author: _author, ...plain } = moment;
    f.capture.listMoments.mockResolvedValue({ moments: [moment, { ...plain, id: "plain" },
      { ...moment, id: "protected", protected: true }, { ...moment, id: "objectless", objectId: "" }],
      nextBeforeMomentOrder: null, latestMomentOrder: 3, activeVersionId: "version", protectedTruncated: false });
    const context = await f.create().openCliWorkspace(f.workspace);
    const { protected: _protected, ...expected } = moment;
    const { protected: _plainProtected, ...plainExpected } = plain;
    expect(await context.listMoments({ limit: 4 })).toEqual([
      { ...expected, workspaceId: "workspace" }, { ...plainExpected, id: "plain", workspaceId: "workspace" },
    ]);
    expect(f.capture.listMoments).toHaveBeenCalledWith({ limit: 4 });
    const detail = { id: "detail" } as NonNullable<Awaited<ReturnType<typeof context.readMoment>>>;
    f.capture.readMoment.mockResolvedValueOnce({ protected: false, moment: detail })
      .mockResolvedValueOnce({ protected: true, moment: { id: "secret" } } as never).mockResolvedValueOnce(null);
    expect(await context.readMoment("visible")).toBe(detail);
    expect(await context.readMoment("protected")).toBeNull();
    expect(await context.readMoment("absent")).toBeNull();
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

  it("refuses both collection reads when the engine adapter is unavailable", async () => {
    const f = fixture();
    const context = await f.create().openCliWorkspace(f.workspace);
    await expect(context.collections!.query({ collectionPath: "tasks" })).rejects.toThrow("engine is not running");
    await expect(context.collections!.getRecord({ collectionPath: "tasks", recordId: "record", historyLimit: 2 })).rejects.toThrow("engine is not running");
  });

  it("runs collection fields through physical admission and the existing Y.Doc edit", async () => {
    const f = fixture();
    const doc = new Y.Doc();
    const events: string[] = [];
    const session = {
      doc, initialUpdate: Y.encodeStateAsUpdate(doc),
      applyLocalUpdate: (update: Uint8Array, armed?: () => void) => { Y.applyUpdate(doc, update); events.push("apply"); armed?.(); },
      settleNow: async () => { events.push("settle"); return { materialized: true }; },
      close: async () => { events.push("close"); },
    } as unknown as WorkspaceEngineYDocProviderSession;
    const admitted: symbol[] = [];
    const opened = vi.fn(async () => session);
    f.dependencies.collectionEditContextFor = async (operation) => {
      operation.assertCurrent(); admitted.push(operation.workspace.attachmentId);
      return { workspaceRoot: operation.workspace.rootPath, capture: { openYDocSession: opened }, withAdapter: async () => null };
    };
    const context = await f.create().openCliWorkspace(f.workspace);
    try {
      expect(await context.collections!.writes.setFields({ recordPath: "tasks/one.md", fields: { status: "done" },
        author: { kind: "user", userId: "owner" } })).toEqual({ path: "tasks/one.md" });
      expect(doc.getMap("frontmatter").get("status")).toBe("done");
      expect(events).toEqual(["apply", "settle", "close"]);
      await expect(context.collections!.writes.createRecord({ collectionPath: "tasks", name: "../bad",
        author: { kind: "user", userId: "owner" } })).rejects.toThrow("plain file name");
      expect(admitted).toHaveLength(2);
      expect(admitted[0]).toBe(admitted[1]);
      expect(opened).toHaveBeenCalledOnce();
    } finally { doc.destroy(); await f.authorities.close(); }
  });

  it("refuses a collection edit whose admitted physical workspace retires while its context opens", async () => {
    const f = fixture();
    const held = deferred(); const entered = deferred();
    const opened = vi.fn();
    f.dependencies.collectionEditContextFor = async (operation): Promise<CollectionRecordEditContext> => {
      entered.release(); await held.promise; operation.assertCurrent();
      return { workspaceRoot: operation.workspace.rootPath, capture: { openYDocSession: opened }, withAdapter: async () => null };
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
    expect(await result).toMatchObject({ message: expect.stringContaining("retired workspace authority") });
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
