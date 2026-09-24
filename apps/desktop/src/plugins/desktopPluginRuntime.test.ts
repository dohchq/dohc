import type { AutomationClaim } from "@dohc/workspace-engine-client";
import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { localWorkspaceSdkDatabaseEditor, localWorkspaceSdkReads } from "../testing/localWorkspaceSdkReads";
import { createTestScratch } from "../workspaces/testTemp";
import type { RegistryEntry } from "../workspaces/registryStore";
import { createWorkspaceActivity, WorkspaceActivityState } from "../workspaces/workspaceActivity";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { createDesktopPluginRuntime, type DesktopPluginRuntimeDependencies } from "./desktopPluginRuntime";
import type { PluginPipelineStatusEvent } from "./PluginPipeline";
import type { AutomationEngineAdapter } from "./pluginAutomations";
import { PLUGIN_HOST_METHODS, type PluginActivateParams } from "./pluginHostProtocol";
import { PLUGIN_MANIFEST_FILE_NAME } from "./pluginManifest";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import { invokePluginSdkHost } from "./pluginSdkHost";
import { PluginSurfaces, type PluginWebAppViewLike } from "./pluginSurfaces";
import type { PluginWorkspaceRuntimeParts } from "./pluginWorkspaceRuntimes";

interface NativeMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class NativeUtilityProcess extends EventEmitter {
  readonly pid = undefined;
  readonly stderr = null;
  readonly stdout = null;
  readonly sent: NativeMessage[] = [];
  readonly activation = deferred<PluginActivateParams>();
  readonly replies = new Map<string, ReturnType<typeof deferred<unknown>>>();
  private nextRequest = 0;

  postMessage(message: NativeMessage): void {
    this.sent.push(message);
    if (typeof message.id === "string" && !message.method) {
      const reply = this.replies.get(message.id);
      this.replies.delete(message.id);
      if (message.error) reply?.reject(new Error(message.error.message));
      else reply?.resolve(message.result);
      return;
    }
    if (message.id === undefined || !message.method) return;
    const activation = message.method === PLUGIN_HOST_METHODS.activate
      ? message.params as PluginActivateParams : undefined;
    if (activation) this.activation.resolve(activation);
    const result = activation
      ? { commands: [], drivers: (activation.manifest.drivers ?? []).map((driver) => driver.id) }
      : {};
    queueMicrotask(() => this.emit("message", { jsonrpc: "2.0", id: message.id, result }));
  }

  request(method: string, params?: unknown, automationClaimId?: string): Promise<unknown> {
    const id = `native-${++this.nextRequest}`;
    const reply = deferred<unknown>();
    this.replies.set(id, reply);
    this.emit("message", {
      jsonrpc: "2.0", id, method: PLUGIN_HOST_METHODS.sdkRequest,
      params: { method, params, ...(automationClaimId === undefined ? {} : { automationClaimId }) },
    });
    return reply.promise;
  }

  kill(): boolean { this.emit("exit", 0); return true; }
}

function surfaces() {
  return new PluginSurfaces<PluginWebAppViewLike>({
    ViewClass: class {
      constructor() { throw new Error("This runtime fixture does not create native guest views"); }
    } as unknown as new () => PluginWebAppViewLike,
    bindWebAppZoom: () => undefined,
    allowPanelOrigin: () => () => undefined,
    clearPanelStorage: async () => undefined,
    clearGuestPartition: async () => undefined,
    notifyWebAppFailed: () => undefined,
    notifyPanelInvalidated: () => undefined,
    onError: () => undefined,
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (failures.length) throw new AggregateError(failures, "Runtime fixture cleanup failed");
});

async function fixture() {
  const scratch = await createTestScratch("desktop-plugin-runtime-");
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath: join(scratch, "workspace"),
    kind: "personal", mode: "local-first",
  };
  const stateDir = join(scratch, "state");
  const pluginRoot = join(workspace.rootPath, "plugins", "plugin-source");
  const resources = join(scratch, "resources");
  await Promise.all([mkdir(pluginRoot, { recursive: true }), mkdir(stateDir), mkdir(resources)]);
  const manifest: DohcPluginManifest = {
    version: 1, name: "plugin", entry: "index.js",
    drivers: [{ id: "test-driver", displayName: "Test driver" }],
    settings: [{ key: "greeting", type: "string", label: "Greeting", default: "Hello" }],
  };
  await Promise.all([
    writeFile(join(pluginRoot, PLUGIN_MANIFEST_FILE_NAME), JSON.stringify(manifest)),
    writeFile(join(pluginRoot, "index.js"), "export function activate() {}\n"),
    writeFile(join(workspace.rootPath, "note.md"), "local note"),
  ]);
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => id === workspace.workspaceId ? workspace : null,
    canonicalizeRoot: (root) => root,
    createState: () => ({ activity: new WorkspaceActivityState(), pluginSurfaces: surfaces() }),
    disposeState: (state) => state.pluginSurfaces.close(),
  });
  cleanups.push(() => authorities.close());
  const first = authorities.acquire(workspace.workspaceId);
  const binding = first.binding;
  const state = first.state;
  first.release();
  const activity = createWorkspaceActivity(() => undefined);
  const forks: Array<{ path: string; args: string[]; options: Parameters<DesktopPluginRuntimeDependencies["utilityProcess"]["fork"]>[2]; child: NativeUtilityProcess }> = [];
  const sdkRequests: Array<Parameters<DesktopPluginRuntimeDependencies["invokeWorkspacePluginSdk"]>[0]> = [];
  const engineWorkspaces: EngineWorkspace[] = [];
  const claims: AutomationClaim[] = [];
  const settlements: Array<{ claimId: string; state: "done" | "failed"; error?: string }> = [];
  const claimFailed = deferred<string>();
  const engineDrained = deferred<void>();
  const adapter: AutomationEngineAdapter = {
    subscribeAutomation: async () => ({}),
    unsubscribeAutomation: async () => ({}),
    claimNextAutomation: async () => {
      const next = claims.shift();
      if (!next) engineDrained.resolve();
      return next ?? null;
    },
    settleAutomationClaim: async (input) => { settlements.push(input); return {}; },
  };
  let authorityReads = 0;
  let activityReads = 0;
  let sdkRouteReads = 0;
  let shared = false;
  const statuses: PluginPipelineStatusEvent[] = [];
  let sdkRoute: DesktopPluginRuntimeDependencies["invokeWorkspacePluginSdk"] = async (input) => {
    sdkRequests.push(input);
    return invokePluginSdkHost({
      ...input,
      workspaceRoot: workspace.rootPath,
      writeAvailable: async () => false,
      reads: localWorkspaceSdkReads(workspace.rootPath),
      editDatabase: localWorkspaceSdkDatabaseEditor(workspace.rootPath),
      writeAuthoredText: async () => { throw new Error("The fixture has no writable engine capture"); },
    }, input.method, input.params);
  };
  const dependencies: DesktopPluginRuntimeDependencies = {
    utilityProcess: {
      fork: (path, args = [], options) => {
        const child = new NativeUtilityProcess();
        forks.push({ path, args, options, child });
        return child as unknown as UtilityProcess;
      },
    },
    pluginHostEntry: join(scratch, "original-main", "plugin-host.js"),
    pnpmRunnerEntry: join(scratch, "original-main", "pnpm-runner.js"),
    stateDir: () => stateDir,
    pluginResourcesBasePath: () => resources,
    requireWorkspaceAuthority: (id) => authorities.acquire(id),
    get workspaceAuthorities() { authorityReads += 1; return authorities; },
    get workspaceActivity() { activityReads += 1; return activity; },
    withWorkspaceAttachment: (target, work) => {
      const current = authorities.acquire(target.workspaceId);
      try {
        if (target.attachmentId !== undefined && target.attachmentId !== current.binding.attachmentId) return undefined;
        return work(current);
      } finally { current.release(); }
    },
    withEngineAdapter: async (target, work) => { engineWorkspaces.push(target); return work(adapter); },
    findWorkspace: (id) => id === workspace.workspaceId ? workspace : null,
    ownedWorkspaceReadsFor: (target) => localWorkspaceSdkReads(target.rootPath),
    get invokeWorkspacePluginSdk() { sdkRouteReads += 1; return sdkRoute; },
    sharedViewOf: () => shared ? {} : null,
    notifyAutomationFailuresChanged: (id) => { claimFailed.resolve(id); },
  };
  const create = createDesktopPluginRuntime(dependencies);
  function createParts(target = workspace) {
    const parts = create(target, { onPipelineStatus: (event) => { statuses.push(event); } });
    cleanups.push(async () => {
      await state.pluginSurfaces.close();
      try { await parts.pipeline.dispose(); }
      finally { await parts.automations.dispose(); parts.workspaceEvents.dispose(); }
    });
    return parts;
  }
  return {
    workspace, stateDir, pluginRoot, manifest, resources, authorities, state, binding,
    dependencies, createParts, forks, sdkRequests, engineWorkspaces, claims, settlements,
    claimFailed, engineDrained, statuses,
    lateReads: () => ({ authorityReads, activityReads }),
    setShared: (value: boolean) => { shared = value; },
    sdkRoute: () => sdkRoute,
    sdkRouteReads: () => sdkRouteReads,
    setSdkRoute: (route: DesktopPluginRuntimeDependencies["invokeWorkspacePluginSdk"]) => { sdkRoute = route; },
  };
}

async function start(f: Awaited<ReturnType<typeof fixture>>, parts: PluginWorkspaceRuntimeParts) {
  await parts.pipeline.start();
  await parts.pipeline.host.start(f.pluginRoot, "plugin-source", f.manifest);
  await parts.pipeline.host.activationOf("plugin");
  return f.forks.at(-1)!.child;
}

describe("desktop plugin runtime composition", () => {
  it("rejects a stale physical root and releases its authority lease", async () => {
    const f = await fixture();
    expect(() => f.createParts({ ...f.workspace, rootPath: join(f.workspace.rootPath, "stale") }))
      .toThrow("Plugin runtime creation received a stale workspace root.");
    await f.authorities.invalidate(f.workspace.workspaceId);
    expect(f.forks).toEqual([]);
  });

  it("keeps late owners lazy and forks a native host with the app's own env on each start", async () => {
    const f = await fixture();
    const parts = f.createParts();
    expect(f.lateReads()).toEqual({ authorityReads: 0, activityReads: 0 });
    const first = await start(f, parts);
    expect(f.forks[0]).toMatchObject({ path: f.dependencies.pluginHostEntry, args: [] });
    expect(f.forks[0]!.options).toEqual({
      cwd: f.pluginRoot, serviceName: "dohc-plugin-host", stdio: ["ignore", "ignore", "pipe"],
    });
    expect((await first.activation.promise).settings).toEqual({ greeting: "Hello" });
    await parts.pipeline.host.stop("plugin");
    await parts.pipeline.host.start(f.pluginRoot, "plugin-source", f.manifest);
    await parts.pipeline.host.activationOf("plugin");
    expect(f.forks.map((fork) => fork.path)).toEqual([f.dependencies.pluginHostEntry, f.dependencies.pluginHostEntry]);
  });

  it("reads the current SDK router only when the native host sends a request", async () => {
    const f = await fixture();
    expect(f.sdkRouteReads()).toBe(0);
    const parts = f.createParts();
    const child = await start(f, parts);
    expect(f.sdkRouteReads()).toBe(0);
    const route = f.sdkRoute();
    const calls: string[] = [];
    f.setSdkRoute((input) => { calls.push("first"); return route(input); });
    await expect(child.request("files.read", { path: "note.md" })).resolves.toMatchObject({ text: "local note" });
    f.setSdkRoute((input) => { calls.push("replacement"); return route(input); });
    await expect(child.request("capabilities")).resolves.toMatchObject({ files: { read: true, watch: true }, ui: { open: false } });
    expect(calls).toEqual(["first", "replacement"]);
    expect(f.sdkRouteReads()).toBe(2);
  });

  it("routes process SDK requests through real read, watch, and child-process authority", async () => {
    const f = await fixture();
    const parts = f.createParts();
    const child = await start(f, parts);
    await expect(child.request("capabilities", undefined, "declared-claim")).resolves.toMatchObject({
      files: { read: true, watch: true, write: false }, ui: { open: false },
      childProcesses: { spawn: true, output: true, send: true, terminate: true },
    });
    expect(f.sdkRequests[0]).toMatchObject({
      workspaceId: "workspace", pluginId: "plugin", requestPath: "plugin-process", automationClaimId: "declared-claim",
    });
    expect(f.sdkRequests[0]!.spawnId).toBe(parts.pipeline.host.getSpawnId("plugin"));
    await expect(child.request("files.read", { path: "note.md" })).resolves.toMatchObject({ text: "local note" });
    const watch = await child.request("files.watch", { path: "." }) as { subscriptionId: string };
    parts.workspaceEvents.handleWatcherEvents([{ path: "note.md", operation: "update" }]);
    expect(child.sent).toContainEqual({
      jsonrpc: "2.0", method: PLUGIN_HOST_METHODS.sdkEvent,
      params: { subscriptionId: watch.subscriptionId, event: "change", data: { path: "note.md", operation: "update" } },
    });
    await expect(child.request("subscriptions.unsubscribe", watch)).resolves.toEqual({});
    await expect(child.request("childProcesses.logs", { childId: "forged-child" })).rejects.toThrow();
    f.setShared(true);
    expect(f.sdkRequests[0]!.isWritable()).toBe(false);
    await expect(child.request("files.write", { path: "note.md", text: "forged write" })).rejects.toThrow();
  });

  it("rejects SDK work through a retired attachment even when its workspace id and root are reused", async () => {
    const f = await fixture();
    const parts = f.createParts();
    const child = await start(f, parts);
    await child.request("capabilities");
    await f.authorities.invalidate(f.workspace.workspaceId);
    const successor = f.authorities.acquire(f.workspace.workspaceId);
    expect(successor.binding.attachmentId).not.toBe(f.binding.attachmentId);
    successor.release();
    await expect(child.request("files.read", { path: "note.md" })).rejects.toThrow();
    expect(f.sdkRequests).toHaveLength(1);
  });

  it("ends surfaces, drivers, and process watches in order when the real host stops", async () => {
    const f = await fixture();
    const parts = f.createParts();
    const child = await start(f, parts);
    await child.request("files.watch", { path: "." });
    const identity = { pluginId: "plugin", spawnId: parts.pipeline.host.getSpawnId("plugin")! };
    const signal = f.sdkRequests.at(-1)!.signal!;
    const stopSurface = vi.spyOn(f.state.pluginSurfaces, "hostChanged");
    const stopDrivers = vi.spyOn(parts.agentDrivers, "endSpawn");
    const stopEvents = vi.spyOn(parts.workspaceEvents, "disposeSpawn");
    expect(parts.agentDrivers.list().map((driver) => driver.id)).toEqual(["test-driver"]);
    const survivorEvents: unknown[] = [];
    parts.workspaceEvents.subscribe({
      owner: { kind: "process", pluginId: "other-plugin", spawnId: "other-spawn" },
      emitEvent: (_id, _event, data) => { survivorEvents.push(data); },
    }, { path: "." });
    await parts.pipeline.host.stop("plugin");
    expect(stopSurface).toHaveBeenCalledWith({ kind: "terminal", workspaceId: "workspace", pluginId: "plugin" });
    expect(stopDrivers).toHaveBeenCalledWith(identity.pluginId, identity.spawnId);
    expect(stopEvents).toHaveBeenCalledWith(identity.pluginId, identity.spawnId);
    expect(stopSurface.mock.invocationCallOrder[0]).toBeLessThan(stopDrivers.mock.invocationCallOrder[0]!);
    expect(stopDrivers.mock.invocationCallOrder[0]).toBeLessThan(stopEvents.mock.invocationCallOrder[0]!);
    expect(signal.aborted).toBe(true);
    expect(parts.agentDrivers.list()).toEqual([]);
    const sentBefore = child.sent.length;
    parts.workspaceEvents.handleWatcherEvents([{ path: "after-stop.md", operation: "update" }]);
    expect(child.sent).toHaveLength(sentBefore);
    expect(survivorEvents).toEqual([{ path: "after-stop.md", operation: "update" }]);
  });

  it("pins automation engine access to the creating attachment and reports failed claims", async () => {
    const f = await fixture();
    const parts = f.createParts();
    await parts.pipeline.start();
    f.claims.push({
      claimId: "orphan-claim", automationId: "plugin/undeclared", trigger: { originId: "origin", originSeq: 1 },
      recordId: "record", collectionPath: "tasks", depth: 0,
      change: { kind: "changed", actor: { kind: "human", id: null }, fields: [], fieldsOmitted: 0 },
      state: "running", attempts: 1,
      createdAtMs: 1, updatedAtMs: 1,
    });
    parts.automations.notifyClaimed();
    expect(await f.claimFailed.promise).toBe(f.workspace.workspaceId);
    await f.engineDrained.promise;
    expect(f.engineWorkspaces.length).toBeGreaterThan(0);
    expect(f.engineWorkspaces.every((target) => target.workspaceId === f.workspace.workspaceId && target.rootPath === f.workspace.rootPath && target.attachmentId === f.binding.attachmentId)).toBe(true);
    expect(f.settlements).toEqual([{ claimId: "orphan-claim", state: "failed", error: expect.any(String) }]);
  });
});
