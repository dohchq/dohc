import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { createDesktopPluginSdk } from "./desktopPluginSdk";
import { PluginAutomations, type AutomationEngineAdapter, type PluginAutomationsOptions } from "./pluginAutomations";
import { PluginWorkspaceEvents } from "./pluginWorkspaceEvents";
import { PluginWorkspaceRuntimes, type PluginWorkspaceRuntimeParts } from "./pluginWorkspaceRuntimes";
import { createPluginPanelSdkAuthorityRegistry } from "./pluginPanelSdkAuthority";
import type { PluginPanelSdkAuthorization } from "./pluginSurfaces";
import type { RegisteredPlugin } from "./pluginPanelRegistration";
import { createWorkspaceAuthorityOwner, type WorkspaceAuthorityOperation } from "../workspaces/workspaceAuthorityOwner";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";
import type { WorkspaceEngineCapture, WorkspaceEngineYDocProviderSession } from "../workspaces/workspaceEngineCapture";
import { derivedRecordId, type CollectionRecordEditContext } from "../workspaces/collectionRecordEdits";
import type { OwnedWorkspaceDatabaseReader } from "../workspaces/ownedWorkspaceFileReader";
import { localWorkspaceSdkReads } from "../testing/localWorkspaceSdkReads";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";

type State = { pluginRuntimes: PluginWorkspaceRuntimes<CreatedWorkspace> };
type Operation = WorkspaceAuthorityOperation<CreatedWorkspace, State>;
type Dependencies = Parameters<typeof createDesktopPluginSdk<Operation>>[0];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(close => close()));
  vi.restoreAllMocks();
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason));
});

async function fixture() {
  const rootPath = realpathSync(await createTestScratch("desktop-plugin-sdk-"));
  const workspace: CreatedWorkspace = { workspaceId: "workspace", rootPath, kind: "personal", mode: "local-first" };
  let shared = false;
  let captureAvailable = true;
  const failures: unknown[] = [];
  const parts: ReturnType<typeof createParts>[] = [];
  const documents: Y.Doc[] = [];
  const journal: Array<Parameters<WorkspaceEngineYDocProviderSession["applyLocalUpdate"]>[2]> = [];
  const operations: Operation[] = [];
  const physicalWorkspaces: Operation["workspace"][] = [];
  const pendingClaims: AutomationClaim[] = [];
  let runOnPlugin: PluginAutomationsOptions["runOnPlugin"] = async () => "completed";
  const settled = vi.fn<AutomationEngineAdapter["settleAutomationClaim"]>(async () => claim());
  const adapter: AutomationEngineAdapter = {
    subscribeAutomation: async () => ({ subscribed: true }),
    unsubscribeAutomation: async () => ({ unsubscribed: true }),
    claimNextAutomation: async () => pendingClaims.shift() ?? null,
    settleAutomationClaim: settled,
  };
  function createParts() {
    const pipeline = {
      start: vi.fn(async () => undefined), cancelStart: vi.fn(), dispose: vi.fn(async () => undefined),
      handleWatcherEvents: vi.fn(async () => undefined), pluginRegistration: vi.fn(() => null),
      hasUnrecoverableFailedReplacement: vi.fn(() => false),
      pluginIdForPath: vi.fn<() => string | null>(() => null),
      handleDoorWrittenSourceChange: vi.fn(), rekeyDoorWrittenSourceChange: vi.fn(),
    };
    const automations = new PluginAutomations({
      withAdapter: work => work(adapter),
      declaredAutomations: () => [{ id: "triage", collection: "tasks", handler: "triage" }],
      proveReadable: async () => undefined,
      runOnPlugin: (pluginId, params) => runOnPlugin(pluginId, params),
      onError: (_context, error) => failures.push(error),
    });
    return { pipeline, automations, workspaceEvents: new PluginWorkspaceEvents(), agentDrivers: { list: () => [] } };
  }
  const authorities = createWorkspaceAuthorityOwner<CreatedWorkspace, State>({
    findWorkspace: id => id === workspace.workspaceId ? workspace : null,
    canonicalizeRoot: realpathSync,
    createState: () => ({ pluginRuntimes: new PluginWorkspaceRuntimes<CreatedWorkspace>({
      assertWritable: () => undefined, isOpen: id => id === workspace.workspaceId,
      create: () => {
        const created = createParts(); parts.push(created);
        return created as unknown as PluginWorkspaceRuntimeParts;
      },
      onPipelineStatus: () => undefined, onCleanupError: (_id, error) => failures.push(error),
    }) }),
    disposeState: state => state.pluginRuntimes.close(),
  });
  cleanups.push(async () => {
    try { await authorities.close(); }
    finally { for (const doc of documents) doc.destroy(); }
    if (failures.length) throw new AggregateError(failures);
  });
  const current = () => {
    const lease = authorities.acquire(workspace.workspaceId);
    try { return lease.state.pluginRuntimes; } finally { lease.release(); }
  };
  await current().ensure(workspace);
  const registration = (id: string): RegisteredPlugin => ({
    pluginRoot: join(rootPath, "plugins", "plugin"), directoryName: "plugin",
    manifest: { version: 1, name: "plugin", entry: "plugin.mjs", webApps: [{ id, title: id, instanced: true }] },
  });
  current().current(workspace.workspaceId)!.rememberPlugin(registration("first"));
  const writeCapture = vi.fn<WorkspaceEngineCapture["writeAuthoredTextFile"]>(async (path, text) => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
    return { resolvedAbsolutePath: path };
  });
  const openSession = vi.fn<CollectionRecordEditContext["capture"]["openYDocSession"]>(async ({ path }) => {
    const doc = new Y.Doc(); documents.push(doc);
    return {
      doc, initialUpdate: Y.encodeStateAsUpdate(doc), path, contentKind: "richdoc",
      applyLocalUpdate(update, armed, options) { Y.applyUpdate(doc, update); journal.push(options); armed?.(); },
      settleNow: async () => ({ momentId: "moment", path, content: null, sha256: "fixture", materialized: true,
        projection: { contentKind: "richdoc", sourceStateVectorSha256: "fixture", destructive: false } }),
      close: async () => undefined,
      readArtifactAsset: async () => { throw new Error("Unexpected artifact read"); },
    };
  });
  const capture = { writeAuthoredTextFile: writeCapture, openYDocSession: openSession } as unknown as WorkspaceEngineCapture;
  const unavailable = async (): Promise<never> => { throw new Error("Unexpected database reader call"); };
  const databaseReader: OwnedWorkspaceDatabaseReader = {
    readPrepared: unavailable, readBytes: unavailable, readPagePrepared: unavailable, readPageBytes: unavailable,
  };
  const reads = localWorkspaceSdkReads(rootPath);
  const activityStatus: Awaited<ReturnType<Dependencies["ensureWorkspaceActivityOpen"]>> = {
    state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null,
    historyRecordingUnavailable: false, historyShareView: false, liveSessionsGeneration: 0,
  };
  const dependencies: Dependencies = {
    withPhysicalWorkspaceOperation: (id, work) => authorities.withOperation(id, operation => {
      operations.push(operation); physicalWorkspaces.push(operation.workspace); return work(operation);
    }),
    ownedWorkspaceReadsFor: vi.fn(() => reads),
    workerDatabaseReader: vi.fn(() => databaseReader),
    editWorkspaceDatabaseInWorker: vi.fn(async () => { throw new Error("Unexpected database edit"); }),
    openWorkspaceActivityForOperation: vi.fn<Dependencies["openWorkspaceActivityForOperation"]>(async (_operation, _options, ensureOpen) => ensureOpen(workspace, {})),
    ensureWorkspaceActivityOpen: vi.fn(async () => activityStatus),
    activity: { engineCaptureFor: () => captureAvailable ? capture : null },
    collectionEditContextFor: vi.fn<Dependencies["collectionEditContextFor"]>(async (operation, signal) => ({
      workspaceRoot: operation.workspace.rootPath, capture, signal: signal ?? operation.signal,
      // The engine has adopted tasks/new.md, under the id its file carries, once the file exists.
      withAdapter: async work => work({ getCollectionRecord: async ({ recordId }) => {
        const text = await readFile(join(operation.workspace.rootPath, "tasks", "new.md"), "utf8").catch(() => "");
        if (!text.includes(`id: ${recordId}`)) throw new Error("collection-record-not-found");
        return { collection: { path: "tasks", status: "valid", reasons: [] },
          record: { id: recordId, path: "tasks/new.md", conflicted: false, values: [] }, history: [], nextBeforeHistoryId: null };
      } }),
      onCaptureSettled: () => () => undefined,
    })),
    requirePluginEngineCaptureForOperation: vi.fn<Dependencies["requirePluginEngineCaptureForOperation"]>(async operation => {
      operation.assertCurrent();
      if (!captureAvailable) throw new Error("No engine capture");
      return { workspace: operation.workspace, capture };
    }),
    assertWritableWorkspace: vi.fn(() => { if (shared) throw new Error("Shared workspace is read-only"); }),
    workspaceAuthorities: authorities,
    pluginWorkspaceRuntimes: { current: id => id === workspace.workspaceId ? current().current(id) : undefined },
    sharedViewOf: () => shared,
    notifyPluginPanelSdkEvent: vi.fn(),
  };
  const sdk = createDesktopPluginSdk(dependencies);
  const controller = new AbortController();
  const invoke = (method: string, params?: unknown, extra: Partial<Parameters<typeof sdk.invokeWorkspacePluginSdk>[0]> = {}) =>
    sdk.invokeWorkspacePluginSdk({ workspaceId: workspace.workspaceId, pluginId: "plugin", spawnId: "spawn",
      requestPath: "plugin-process", isWritable: () => !shared, signal: controller.signal, method, params, ...extra });
  const grants = createPluginPanelSdkAuthorityRegistry();
  grants.register({ senderId: 1, generation: 1, workspaceId: workspace.workspaceId, pluginId: "plugin", panelId: "main" });
  let pushLive = true;
  const authorization: PluginPanelSdkAuthorization = {
    authority: grants.authorize({ senderId: 1, generation: 1, activeWorkspaceId: workspace.workspaceId,
      workspaceId: workspace.workspaceId, pluginId: "plugin", panelId: "main", panelRunning: true, liveSpawnId: "panel-spawn" }),
    surfaceId: 7, isPushLive: () => pushLive,
  };
  cleanups.push(async () => { grants.revokeAll(); });
  const panel = (method: string, params?: unknown, patch: Partial<PluginPanelSdkAuthorization> = {}) =>
    sdk.routePluginPanelSdk({ authorization: { ...authorization, ...patch }, method, params });
  return { workspace, sdk, dependencies, reads, databaseReader, current, parts, operations, physicalWorkspaces, capture, writeCapture, openSession,
    documents, journal, authorities, controller, invoke, panel, authorization, registration, pendingClaims, settled,
    revokePanel: () => grants.revokePanel(workspace.workspaceId, "plugin", "main"),
    setRun: (run: typeof runOnPlugin) => { runOnPlugin = run; }, setShared: (value: boolean) => { shared = value; },
    setCapture: (value: boolean) => { captureAvailable = value; }, setPushLive: (value: boolean) => { pushLive = value; } };
}

function claim(): AutomationClaim {
  return { claimId: "claim", automationId: "plugin/triage", trigger: { originId: "origin", originSeq: 4 },
    recordId: "record", collectionPath: "tasks", depth: 2, state: "running", attempts: 1, createdAtMs: 1, updatedAtMs: 1 };
}

describe("desktop plugin SDK authority", () => {
  it("uses the physical workspace for owner reads and refuses an unregistered workspace before reaching them", async () => {
    const f = await fixture(); await writeFile(join(f.workspace.rootPath, "note.txt"), "owned bytes");
    await expect(f.invoke("files.read", { path: "note.txt", workspaceRoot: "forged-root" })).resolves.toMatchObject({ text: "owned bytes" });
    expect(f.dependencies.ownedWorkspaceReadsFor).toHaveBeenCalledWith(f.physicalWorkspaces[0], f.databaseReader);
    expect(f.physicalWorkspaces[0]).toMatchObject({ rootPath: f.workspace.rootPath, attachmentId: expect.any(Symbol) });
    await expect(f.invoke("files.read", { path: "note.txt" }, { workspaceId: "unknown" })).rejects.toThrow();
    expect(f.dependencies.ownedWorkspaceReadsFor).toHaveBeenCalledTimes(1);
  });

  it.each(["request", "workspace", "panel"] as const)("aborts an in-flight owner read when its %s authority retires", async (source) => {
    const f = await fixture(); const entered = deferred(); const release = deferred();
    const read = vi.spyOn(f.reads, "readText").mockImplementation(async () => { entered.resolve(); await release.promise; return { text: "late", truncated: false, contentHash: "held" }; });
    const pending = source === "panel"
      ? f.panel("files.read", { path: "note.txt" })
      : f.invoke("files.read", { path: "note.txt" }, source === "workspace" ? { signal: undefined } : {});
    const rejected = expect(pending).rejects.toMatchObject({ code: "DOHC_ABORTED" });
    let retired: Promise<void> | undefined;
    try {
      await Promise.race([entered.promise, pending]);
      const signal = vi.mocked(f.dependencies.workerDatabaseReader).mock.calls[0]![0]!;
      expect(signal.aborted).toBe(false);
      if (source === "workspace") {
        expect(signal).toBe(f.operations[0]!.signal);
        retired = f.authorities.invalidate(f.workspace.workspaceId);
      } else if (source === "panel") f.revokePanel(); else f.controller.abort();
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(f.operations[0]!.signal.aborted).toBe(source === "workspace");
    } finally { release.resolve(); await Promise.allSettled([pending, rejected, read.mock.results[0]?.value]); await retired; }
  });

  it("forwards the combined signal and main-derived author to a held database worker edit", async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred();
    vi.spyOn(f.reads, "readDatabase").mockResolvedValue({ path: "data.sqlite", tables: [] });
    const worker = vi.mocked(f.dependencies.editWorkspaceDatabaseInWorker).mockImplementation(async () => { entered.resolve(); await release.promise; throw new Error("worker cancelled"); });
    const edit = { table: "items", op: "update", pkColumn: "id", rowId: "one", payload: { title: "changed" } };
    const pending = f.invoke("databases.edit", { path: "data.sqlite", edit, author: { kind: "user", userId: "forged" } });
    const rejected = expect(pending).rejects.toMatchObject({ code: "DOHC_ABORTED" });
    try {
      await Promise.race([entered.promise, pending]);
      const input = worker.mock.calls[0]![0];
      expect(input).toMatchObject({ rootPath: f.workspace.rootPath, relativePath: "data.sqlite", edit,
        author: { kind: "agent", agentId: "plugin:plugin", onBehalfOf: "local" }, nowMs: expect.any(Number) });
      expect(input.signal).toBe(vi.mocked(f.dependencies.workerDatabaseReader).mock.calls[0]![0]);
      f.controller.abort(); await rejected; expect(input.signal!.aborted).toBe(true);
    } finally { release.resolve(); await Promise.allSettled([pending, rejected, worker.mock.results[0]?.value]); }
  });

  it.each(["capture", "writability"] as const)("rechecks %s when the authored write obtains its capture", async (refusal) => {
    const f = await fixture(); const original = vi.mocked(f.dependencies.requirePluginEngineCaptureForOperation).getMockImplementation()!;
    vi.mocked(f.dependencies.requirePluginEngineCaptureForOperation).mockImplementation(async operation => {
      if (refusal === "capture") f.setCapture(false); else f.setShared(true);
      return original(operation);
    });
    await expect(f.invoke("files.write", { path: "note.txt", text: "blocked" })).rejects.toThrow(refusal === "capture" ? "No engine capture" : "read-only");
    expect(f.dependencies.openWorkspaceActivityForOperation).toHaveBeenCalledOnce();
    expect(f.writeCapture).not.toHaveBeenCalled();
  });

  it("does not advertise capture writes after the physical operation becomes stale during activity startup", async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred();
    vi.mocked(f.dependencies.openWorkspaceActivityForOperation).mockImplementation(async (_operation, options, ensureOpen) => { entered.resolve(); await release.promise; return ensureOpen(f.workspace, options); });
    const pending = f.invoke("capabilities"); const rejected = expect(pending).rejects.toThrow();
    let retired: Promise<void> | undefined;
    try { await Promise.race([entered.promise, pending]); retired = f.authorities.invalidate(f.workspace.workspaceId); release.resolve(); await rejected; expect(f.writeCapture).not.toHaveBeenCalled(); }
    finally { release.resolve(); await Promise.allSettled([pending, rejected]); await retired; }
  });

  it("stamps the spawn author and notifies the current pipeline after a held write", async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred(); const original = f.writeCapture.getMockImplementation()!;
    f.writeCapture.mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
    const old = f.parts[0]!;
    const pending = f.invoke("files.write", { path: "plugins/plugin/source.txt", text: "changed", overwrite: false,
      author: { agentId: "forged", agentRunId: "forged" } });
    try {
      await Promise.race([entered.promise, pending]);
      await f.current().stop(f.workspace.workspaceId); await f.current().ensure(f.workspace);
      const current = f.parts.at(-1)!; current.pipeline.pluginIdForPath.mockReturnValue("plugin");
      release.resolve(); await expect(pending).resolves.toEqual({ path: "plugins/plugin/source.txt" });
      expect(f.writeCapture).toHaveBeenCalledWith(join(f.workspace.rootPath, "plugins/plugin/source.txt"), "changed",
        { kind: "agent", agentId: "plugin:plugin", onBehalfOf: "local", agentRunId: "spawn" },
        { createOnly: true, signal: vi.mocked(f.dependencies.workerDatabaseReader).mock.calls[0]![0] });
      expect(old.pipeline.handleDoorWrittenSourceChange).not.toHaveBeenCalled();
      expect(current.pipeline.handleDoorWrittenSourceChange).toHaveBeenCalledWith("plugin", { absolutePath: join(f.workspace.rootPath, "plugins/plugin/source.txt"), text: "changed" });
      expect(await readFile(join(f.workspace.rootPath, "plugins/plugin/source.txt"), "utf8")).toBe("changed");
    } finally { release.resolve(); await pending; }
  });
});

describe("desktop plugin SDK runtime ownership", () => {
  it("reads declarations from the current runtime instead of a caller's claimed web apps", async () => {
    const f = await fixture();
    await expect(f.panel("ui.openWebApp", { webAppId: "first", instanceKey: "one" })).resolves.toEqual({ webAppId: "first", instanceKey: "one" });
    await f.current().stop(f.workspace.workspaceId); const runtime = await f.current().ensure(f.workspace);
    runtime.rememberPlugin(f.registration("second"));
    await expect(f.panel("ui.openWebApp", { webAppId: "first", instanceKey: "one", declaredWebApps: [{ id: "first", instanced: true }] })).rejects.toThrow();
    await expect(f.panel("ui.openWebApp", { webAppId: "second", instanceKey: "two" })).resolves.toEqual({ webAppId: "second", instanceKey: "two" });
  });

  it("takes automation attribution and successive write keys from the real active run", async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred(); const settled = deferred();
    f.setRun(async () => { entered.resolve(); await release.promise; return "completed"; });
    const originalSettle = f.settled.getMockImplementation()!;
    f.settled.mockImplementation(async (...args) => { const result = await originalSettle(...args); settled.resolve(); return result; });
    vi.spyOn(f.reads, "getCollection").mockResolvedValue({ path: "tasks", status: "valid", reasons: [], recordCount: 1,
      schema: { name: "Tasks", description: null, fields: [], views: [] } });
    f.pendingClaims.push(claim());
    const automations = f.parts[0]!.automations;
    automations.handlePipelineStatus({ kind: "changed", plugin: { id: "plugin", valid: true, status: "ready" } } as Parameters<typeof automations.handlePipelineStatus>[0]);
    try {
      await entered.promise;
      await expect(f.invoke("collections.setFields", { path: "tasks/one.md", fields: { status: "foreign" } },
        { automationClaimId: "claim", pluginId: "other-plugin" })).rejects.toThrow("no longer active");
      expect(f.dependencies.collectionEditContextFor).not.toHaveBeenCalled();
      await f.invoke("collections.setFields", { path: "tasks/one.md", fields: { status: "done" }, author: { depth: 99 }, idempotencyKey: "forged" }, { automationClaimId: "claim" });
      await mkdir(join(f.workspace.rootPath, "tasks"));
      await expect(f.invoke("collections.createRecord", { path: "tasks", name: "new", fields: { title: "Created" } }, { automationClaimId: "claim" })).resolves.toEqual({ path: "tasks/new.md", recordId: derivedRecordId("claim/1") });
      expect(f.journal).toEqual([0, 1].map(ordinal => ({ actorOriginId: "plugin/triage",
        attribution: { actorKind: "automation", onBehalfOf: "local", depth: 3 }, idempotencyKey: `claim/1/${ordinal}` })));
      expect(f.documents.map(doc => doc.getMap("frontmatter").toJSON())).toEqual([{ status: "done" }, { title: "Created" }]);
      expect(vi.mocked(f.dependencies.collectionEditContextFor).mock.calls.map(call => call[1])).toEqual(
        vi.mocked(f.dependencies.workerDatabaseReader).mock.calls.slice(1).map(call => call[0]));
      release.resolve(); await settled.promise;
      await expect(f.invoke("collections.setFields", { path: "tasks/one.md", fields: { status: "late" } }, { automationClaimId: "claim" })).rejects.toThrow("no longer active");
      expect(f.openSession).toHaveBeenCalledTimes(2);
    } finally { release.resolve(); await settled.promise; }
  });

  it("refuses a foreign automation claim instead of downgrading it to plugin attribution", async () => {
    const f = await fixture();
    await expect(f.invoke("collections.setFields", { path: "tasks/one.md", fields: { status: "forged" } }, { automationClaimId: "foreign" })).rejects.toThrow("no longer active");
    expect(f.dependencies.collectionEditContextFor).not.toHaveBeenCalled(); expect(f.openSession).not.toHaveBeenCalled();
  });

  it("binds panel subscriptions to the surface owner and checks live push status on each event", async () => {
    const f = await fixture(); const events = f.parts[0]!.workspaceEvents;
    const { subscriptionId } = await f.panel("files.watch", { path: "notes" }) as { subscriptionId: string };
    events.handleWatcherEvents([{ path: "notes/a.txt", operation: "update" }]);
    expect(f.dependencies.notifyPluginPanelSdkEvent).toHaveBeenCalledWith({ workspaceId: "workspace", pluginId: "plugin", panelId: "main", subscriptionId,
      event: "change", data: { path: "notes/a.txt", operation: "update" } });
    f.setPushLive(false); events.handleWatcherEvents([{ path: "notes/b.txt", operation: "update" }]);
    expect(f.dependencies.notifyPluginPanelSdkEvent).toHaveBeenCalledTimes(1);
    await expect(f.panel("subscriptions.unsubscribe", { subscriptionId }, { surfaceId: 8 })).rejects.toThrow("another owner");
    await expect(f.panel("subscriptions.unsubscribe", { subscriptionId })).resolves.toEqual({});
    f.setPushLive(true); events.handleWatcherEvents([{ path: "notes/c.txt", operation: "update" }]);
    expect(f.dependencies.notifyPluginPanelSdkEvent).toHaveBeenCalledTimes(1);
  });

  it("uses the replacement event owner and forwards a collection watch's readable scope", async () => {
    const f = await fixture(); const old = f.parts[0]!.workspaceEvents;
    await f.current().stop(f.workspace.workspaceId); await f.current().ensure(f.workspace);
    vi.spyOn(f.reads, "listCollections").mockResolvedValue({ collections: [{ path: "tasks", status: "valid", reasons: [] }] });
    const { subscriptionId } = await f.panel("collections.watch", { path: "." }) as { subscriptionId: string };
    const data = { collectionPath: "tasks", recordId: "record", author: null, timestamp: 1, actorKind: "human" as const, onBehalfOf: null, depth: 0, source: { originId: "origin", originSeq: 1 } };
    old.handleRecordEvent({ name: "record.updated", data });
    f.parts.at(-1)!.workspaceEvents.handleRecordEvent({ name: "record.updated", data: { ...data, collectionPath: "private" } });
    expect(f.dependencies.notifyPluginPanelSdkEvent).not.toHaveBeenCalled();
    f.parts.at(-1)!.workspaceEvents.handleRecordEvent({ name: "record.updated", data });
    expect(f.dependencies.notifyPluginPanelSdkEvent).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId, event: "record.updated", data }));
  });

  it("keeps child-process capabilities on the process route and evaluates panel writability live", async () => {
    const f = await fixture(); const broker = vi.fn(async () => ({ childId: "child" }));
    await expect(f.invoke("childProcesses.spawn", { command: "node", args: ["worker.js"] }, { invokeChildProcess: broker })).resolves.toEqual({ childId: "child" });
    expect(broker).toHaveBeenCalledWith("childProcesses.spawn", { command: "node", args: ["worker.js"] });
    await expect(f.panel("capabilities")).resolves.toMatchObject({ files: { watch: true, write: true }, childProcesses: { spawn: false, output: false, send: false, terminate: false } });
    await f.panel("files.write", { path: "panel.txt", text: "panel write" });
    expect(f.writeCapture).toHaveBeenCalledWith(join(f.workspace.rootPath, "panel.txt"), "panel write",
      { kind: "agent", agentId: "plugin:plugin", onBehalfOf: "local", agentRunId: "panel-spawn" },
      { createOnly: false, signal: vi.mocked(f.dependencies.workerDatabaseReader).mock.calls.at(-1)![0] });
    f.setShared(true);
    await expect(f.panel("capabilities")).resolves.toMatchObject({ files: { write: false }, databases: { edit: false }, collections: { edit: false } });
    await expect(f.panel("childProcesses.spawn", { command: "node" })).rejects.toThrow("unavailable for this request path");
    expect(broker).toHaveBeenCalledTimes(1);
  });
});
