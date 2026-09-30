import { createHash } from "node:crypto";
import { AuthoredTextChangedError } from "../workspaces/workspaceEngineCapture";
import { parseCliResult, type CliFileWrite } from "@dohc/cli/protocol";
import { createTestScratch } from "../workspaces/testTemp";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { documentMarkdown, markdownToYDoc } from "@dohc/ydoc-projection";
import { directDocumentProjection } from "../workspaces/documentProjection";
import { CHATS_METHOD, WORKSPACE_METHOD, type VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { executeCli } from "@dohc/cli";
import { CLI_PROTOCOL_VERSION, cliTransportResponseSchema, type CliRequestWithoutToken } from "@dohc/cli/protocol";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
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

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}

type State = Record<string, never>;
type Dependencies = Parameters<typeof createDesktopCliServer<State>>[0];
type Capture = NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>;

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
    listKeptCopies: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listKeptCopies"]>(),
    saveKeptCopy: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["saveKeptCopy"]>(),
    listVersions: vi.fn<NonNullable<ReturnType<Dependencies["activity"]["engineCaptureFor"]>>["listVersions"]>(
      async () => ({ versions: [], activeVersionId: "main" })),
    // Writes the file as the capture chain does, refusing one that exists.
    writeAuthoredFile: vi.fn<Capture["writeAuthoredFile"]>(async (absolutePath, text, _author, options) => {
      await mkdir(dirname(absolutePath), { recursive: true });
      try {
        await writeFile(absolutePath, text, { flag: options?.createOnly ? "wx" : "w" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new VersionedTextStoreError("target-path-exists", "File already exists");
      }
      return { resolvedAbsolutePath: absolutePath, materializeOutcome: "applied" };
    }),
    // Runs the move or delete as the capture does, with no live documents to
    // settle: the policy is read once the change runs, History holds every
    // regular file, and the disk has no rename that refuses to replace.
    changePathsAs: vi.fn(async (_paths: readonly string[], _authored: unknown, work: (engine: AuthoredPathChanges) => Promise<unknown>) =>
      await work({ policy: await readWorkspaceEnginePolicy(rootPath), recordDisk: async (_path, files) => [...files],
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
    localReactorFallbackId: () => "local:device",
    projectChatBookmarks: vi.fn(),
    queueCloudSync: vi.fn(),
    syncSharedChannelsForChatTarget: async () => undefined,
    scanChatDispatch: async () => undefined,
    notifyRenderer: () => undefined,
  });
  const dependencies: Dependencies = {
    automations: () => ({ automationIdAt: vi.fn(), runs: vi.fn(), run: vi.fn(), retry: vi.fn() }),
    buttons: () => ({ press: vi.fn() }),
    findWorkspace: (id) => rows.get(id) ?? null,
    listWorkspaces: () => [...rows.values()],
    openWorkspaceActivity: vi.fn(async () => undefined),
    activity: { engineCaptureFor: vi.fn(() => currentCapture), queueCloudSync: vi.fn(), agentRunDepth: vi.fn(() => 0) },
    linkedChatStoreFor: vi.fn(() => store),
    currentDaemon: vi.fn(() => daemon),
    agentDispatchStoreHandleFor: vi.fn(() => ({ store: dispatchStore })),
    sharedViewOf: vi.fn(() => null),
    withPhysicalWorkspaceOperation: (id, work) => authorities.withOperation(id, work),
    collectionEditContextFor: vi.fn(async () => { throw new Error("No edit context configured"); }),
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
    const root = await mkdtemp(join(tmpdir(), "dohc-cli-history-"));
    const f = fixture(root);
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
    await context.listMoments({ limit: 4, objectId: "object-plan" });
    expect(f.capture.listMoments).toHaveBeenLastCalledWith({ limit: 4, objectId: "object-plan" });
    const detail = { id: "detail", versionId: "main", path: "notes.md", payload: { before: null, after: { path: "notes.md", text: "" } } } as unknown as NonNullable<Awaited<ReturnType<typeof context.readMoment>>>;
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
        nextBeforeMomentOrder: null, latestMomentOrder: 1, activeVersionId: "main", protectedTruncated: false,
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
      expect(await cli("history", "show", "journal")).toEqual({ exitCode: 1, stdout: "", stderr: "dohc: change not found: journal\n" });
      expect(await cli("history", "show", "moved")).toMatchObject({ exitCode: 1, stderr: "dohc: change not found: moved\n" });
      expect((await cli("history", "show", "notes")).stdout).toBe("plain");
      // A list row names only the path after the change; show also checks the path before it.
      expect((await cli("history", "list")).stdout).toBe([
        `moved · ${new Date(20).toISOString()} · rename · notes/moved.md`,
        `notes · ${new Date(20).toISOString()} · write · notes.md`,
      ].join("\n") + "\n");
      expect(await mcp("moment", { id: "journal" })).toEqual({ ok: false, reason: "change not found: journal" });
      expect(await mcp("moment", { id: "moved" })).toEqual({ ok: false, reason: "change not found: moved" });
      expect(await mcp("moments", {})).toMatchObject({ changes: [{ id: "moved" }, { id: "notes" }], count: 2 });
      // Neither door sends the rename's summary, which names the excluded path.
      expect(JSON.stringify(await mcp("moments", { includeFiles: true }))).not.toContain("private/");
      expect((await cli("history", "list", "--json")).stdout).not.toContain("private/");
      expect((await cli("history", "list")).stdout).not.toContain("private/");

      // A policy file dohc cannot read hides all history, as it blocks search.
      await writeFile(join(root, ".dohc", "files.toml"), "[[rule]\n");
      expect(await mcp("moments", {})).toMatchObject({ changes: [], count: 0 });
      expect(await mcp("moment", { id: "notes" })).toMatchObject({ ok: false });
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
    f.dependencies.collectionEditContextFor = async (operation, signal) => {
      operation.assertCurrent(); admitted.push(operation.workspace.attachmentId);
      return desktopRecordEditContext({ workspaceRoot: operation.workspace.rootPath,
        capture: { openYDocSession: opened, writeAuthoredFile: vi.fn() }, withAdapter: async () => null,
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

  it("hands a document edit to the live sessions as an update against their state", async () => {
    const f = fixture();
    const edit = vi.mocked(f.dependencies.liveDocuments.editDocument);
    const context = await f.create().openCliWorkspace(f.workspace);
    const origin = { attribution: { actorKind: "agent" as const, onBehalfOf: "person-local", depth: 0 } };
    await context.documents!.edit({ path: "notes.md", edit: { find: "Draft", replacement: "Final" }, origin });
    const [input] = edit.mock.calls[0]!;
    expect(input).toMatchObject({ workspaceId: "workspace", path: "notes.md", origin });
    const current = markdownToYDoc("Draft plan.");
    Y.applyUpdate(current, (await input.change(Y.encodeStateAsUpdate(current), { keepBlocks: true }))!);
    expect(documentMarkdown(Y.encodeStateAsUpdate(current))).toBe("Final plan.");
    // A refusal from the projection reaches the caller.
    await expect(input.change(Y.encodeStateAsUpdate(markdownToYDoc("Final plan.")), { keepBlocks: true }))
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
    f.dependencies.collectionEditContextFor = async (operation, signal): Promise<CollectionRecordEditContext> => {
      entered.release(); await held.promise; operation.assertCurrent();
      return desktopRecordEditContext({ workspaceRoot: operation.workspace.rootPath,
        capture: { openYDocSession: opened, writeAuthoredFile: vi.fn() }, withAdapter: async () => null,
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

  it("returns currentSha256 through the raw request on a stale write", async () => {
    const f = await setup();
    await writeFile(join(f.workspace.rootPath, "plain.txt"), "original");
    f.capture.writeAuthoredFile.mockRejectedValueOnce(new AuthoredTextChangedError("plain.txt"));
    expect(await f.invoke([{ path: "plain.txt", contentBase64: "bmV3", expectedSha256: "0".repeat(64) }])).toMatchObject({ ok: false, written: [], currentSha256: createHash("sha256").update("original").digest("hex") });
    expect(await readFile(join(f.workspace.rootPath, "plain.txt"), "utf8")).toBe("original");
  });

});

describe("raw fileMove and fileDelete socket requests", () => {
  async function setup() {
    const root = await createTestScratch("dohc-cli-file-move-");
    await mkdir(join(root, ".dohc"));
    const f = fixture(root);
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

  it.each(["delete", "overwrite"] as const)("a hung trash during %s holds neither file verbs nor workspace close", async change => {
    const f = await setup();
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
    try {
      expect(await f.invoke("fileMove", { fromPath: "next.txt", toPath: "after.txt" })).toMatchObject({ ok: true });
      await f.authorities.close();
    } finally {
      released.release();
      expect(await pending).toMatchObject({ ok: true });
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
      .toEqual({ ok: true, fromPath: "plain.txt", toPath: "moved.txt" });
    expect(await f.invoke("fileDelete", { path: "moved.txt", ...(agent ? { agent } : {}) })).toMatchObject({ ok: true, path: "moved.txt", trashed: false, trashPath: expect.stringMatching(/^\.dohc\/trash\//) });
    const author = { kind: "agent", agentId: agent ?? "dohc-mcp", onBehalfOf: "person-local", depth: 4 };
    expect(vi.mocked(f.capture.changePathsAs).mock.calls.map(call => call[1])).toEqual([
      { operation: "move", author, correlationId: "fileMove:raw" }, { operation: "delete", author, correlationId: "fileDelete:raw" },
    ]);
    expect(f.dependencies.markDeletedUnderPath).toHaveBeenCalledWith(expect.any(Symbol), "moved.txt");
  });
});
