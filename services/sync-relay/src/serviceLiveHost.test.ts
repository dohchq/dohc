import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as Y from "yjs";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment.js";
import { startServiceLiveHost, type ServiceWorkspace } from "./serviceLiveHost.js";
import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import {hasRelayWriteObservers, notifyRelayWrite, observeRelayWrites} from "./relayWriteChanges.js";
import {createNamedFrameChanges} from "./liveHostChanges.js";
import {ServiceActivationDriver} from "./serviceActivationDriver.js";
import {liveEditors} from "./liveEditors.js";
import { OwnerCommittedDelivery } from "./ownerCommittedDelivery.js";
import type { NativeOwnerActivation } from "@dohc/workspace-engine-client/daemon";
import { markdownToYDoc } from "../../../packages/ydoc-projection/src/import-export.js";
import { createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator } from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises",async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {...original,rm: vi.fn(original.rm)};
});
vi.mock("@dohc/workspace-engine-client/daemon", async importOriginal => ({
  ...await importOriginal<typeof import("@dohc/workspace-engine-client/daemon")>(), createEngineClient: spawn,
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {vi.mocked(rm).mockReset(); for (const close of cleanup.splice(0).reverse()) await close(); spawn.mockReset();});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "service-host-test-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const deploymentConfig = join(root, "deployment.json");
  initializeRelayDeployment({ configPath: deploymentConfig, relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity") });
  const deployment = openRelayDeployment(deploymentConfig);
  deployment.storage.provisionLiveHostControl({ mode: "service", hostId: "service", updatedAtMs: 1, guard() {} });
  const config = { version: 1, engineExecutable: process.execPath, hostId: "service", instanceId: "instance",
    workspaces: [{ root: workspace, workspaceId: "workspace", maxRegistrations: 8 }],
    ingress: { aggregateBytes: 200_000_000, applicationWorkingReserveBytes: 50_000_000, maxUploads: 2, uploadDeadlineMs: 1000 },
    client: { aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 1000, requestDeadlineMs: 1000 } };
  const configPath = join(root, "service.json");
  const save = () => writeFile(configPath, JSON.stringify(config)); await save();
  let closed = false;
  const closeStorage = () => { if (!closed) { deployment.storage.close(); closed = true; } };
  cleanup.push(async () => { closeStorage(); await rm(root, { recursive: true, force: true }); });
  return { ...deployment, root, config, configPath, save, closeStorage };
}
function clientFrom(options: { env: Record<string, string> }) {
  const nativePath = options.env.DOHC_ENGINE_LIVE_HOST_CONFIG!;
  const config = JSON.parse(readFileSync(nativePath, "utf8"));
  const client = { sendRequest: vi.fn(async () => ({ result: { relayNamespace: config.relayNamespace, host: config.host,
    workspaces: config.workspaces.map((row: { workspaceId: string }) => ({ workspaceId: row.workspaceId, workspaceHandle: "actual-open-handle" })) } })),
    close: vi.fn(), waitForExit: vi.fn(async () => {}) };
  return { client, config, nativePath };
}

function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise,resolve};}

it("wakes served document and desktop listeners when service startup completes and the host closes", async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  const changes = createNamedFrameChanges(8), documentWake = vi.fn(), desktopWake = vi.fn(), unrelated = vi.fn();
  changes.subscribe(documentWake, {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64)});
  changes.subscribe(desktopWake, {workspaceId: "workspace", objectId: "waiting-object"});
  changes.subscribe(unrelated, {workspaceId: "other-workspace", objectId: "object"});
  spawn.mockImplementation(async options => {entered.resolve(); await release.promise; return clientFrom(options).client;});
  const starting = startServiceLiveHost({...f, frameChanges: changes});
  await entered.promise;
  expect(documentWake).not.toHaveBeenCalled(); expect(desktopWake).not.toHaveBeenCalled();
  release.resolve();
  const host = await starting;
  try {
    await new Promise<void>(queueMicrotask);
    expect(documentWake).toHaveBeenCalledOnce(); expect(desktopWake).toHaveBeenCalledOnce(); expect(unrelated).not.toHaveBeenCalled();
    await host.close();
    expect(documentWake).toHaveBeenCalledTimes(2); expect(desktopWake).toHaveBeenCalledTimes(2); expect(unrelated).not.toHaveBeenCalled();
  } finally {await host.close();}
});

it("joins concurrent closes and retains the directory and reservation until process exit",async () => {
  const f = await fixture(), exited = deferred<void>(); let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async options => {
    captured = clientFrom(options);
    captured.client.waitForExit.mockImplementation(() => exited.promise);
    return captured.client;
  });
  const host = await startServiceLiveHost(f), closed = vi.fn();
  const first = host.close().then(closed), second = host.close().then(closed);
  try {
    expect(captured.client.close).toHaveBeenCalledTimes(1);
    await expect(startServiceLiveHost(f)).rejects.toThrow("unavailable");
    await vi.waitFor(() => expect(captured.client.waitForExit).toHaveBeenCalledTimes(1));
    expect(closed).not.toHaveBeenCalled();
    expect(existsSync(captured.nativePath)).toBe(true);
  } finally {exited.resolve(); await Promise.all([first,second]);}
  expect(closed).toHaveBeenCalledTimes(2);
  expect(existsSync(captured.nativePath)).toBe(false);
  spawn.mockImplementation(async options => clientFrom(options).client);
  const replacement = await startServiceLiveHost(f);
  await replacement.close();
});

it("preserves the startup error and releases its reservation when directory cleanup fails",async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async options => {
    captured = clientFrom(options);
    captured.client.sendRequest.mockResolvedValue({result: {relayNamespace: "foreign",host: captured.config.host,workspaces: []}});
    return captured.client;
  });
  const removal = vi.mocked(rm).mockRejectedValueOnce(new Error("directory locked"));
  const log = vi.spyOn(console,"error").mockImplementation(() => {});
  try {
    await expect(startServiceLiveHost(f)).rejects.toThrow("identity mismatch");
    expect(captured.client.close).toHaveBeenCalledTimes(1);
    expect(captured.client.waitForExit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("Service host startup cleanup failed.",expect.any(Error));
    spawn.mockImplementation(async options => clientFrom(options).client);
    const replacement = await startServiceLiveHost(f);
    await replacement.close();
  } finally {
    removal.mockReset(); log.mockRestore();
    if (captured) await rm(dirname(captured.nativePath),{recursive: true,force: true});
  }
});

it("retains an observer registered while the native process is closing",async () => {
  const f = await fixture(), exited = deferred<void>(); let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async options => {
    captured = clientFrom(options);
    captured.client.waitForExit.mockImplementation(() => exited.promise);
    return captured.client;
  });
  const host = await startServiceLiveHost({...f,frameChanges: {maxListeners: 16,notify() {},notifyHost() {},subscribe: () => () => {}}});
  const closing = host.close();
  expect(hasRelayWriteObservers(f.storage)).toBe(false);
  const changed = vi.fn(), stop = observeRelayWrites(f.storage,changed);
  try {
    await vi.waitFor(() => expect(captured.client.waitForExit).toHaveBeenCalledTimes(1));
    exited.resolve(); await closing;
    changed.mockClear();
    notifyRelayWrite(f.storage);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  } finally {exited.resolve(); await closing; stop();}
});

it("returns an explicit close failure without also logging it",async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async options => {captured = clientFrom(options); return captured.client;});
  const host = await startServiceLiveHost(f), failure = new Error("directory locked");
  const removal = vi.mocked(rm).mockRejectedValueOnce(failure);
  const log = vi.spyOn(console,"error").mockImplementation(() => {});
  try {
    await expect(host.close()).rejects.toBe(failure);
    expect(log).not.toHaveBeenCalled();
  } finally {removal.mockReset(); log.mockRestore(); await rm(dirname(captured.nativePath),{recursive: true,force: true});}
});

it("registers only the discovered engine identity and releases its incarnation on close", async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async options => { captured = clientFrom(options); return captured.client; });
  const host = await startServiceLiveHost(f);
  try {
    expect(captured.config.workspaces).toEqual(f.config.workspaces);
    expect(f.storage.getLiveHostControl()).toMatchObject({ admissionState: "open", registeredConnectionId: host.coordinate.connectionId });
    await expect(host.drain({ workspaceId: "other", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64) })).rejects.toThrow("not configured");
    await expect(startServiceLiveHost(f)).rejects.toThrow("unavailable");
  } finally { await host.close(); }
  expect(host.invalidated.aborted).toBe(true);
  expect(captured.client.close).toHaveBeenCalledTimes(1);
  expect(captured.client.waitForExit).toHaveBeenCalledTimes(1);
  expect(existsSync(captured.nativePath)).toBe(false);
  expect(f.storage.getLiveHostControl()?.admissionState).toBe("closed");
});

it("prepares attached ordinary replication without registering a partly activated live host", async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  const attachment = {relay: {baseUrl: "https://relay.example", bearerToken: "actual-owner-credential"},
    identity: {kind: "join", replicationEpoch: "actual-epoch", streamIdentity: "actual-stream"}, maxPagesPerPull: 1};
  const adoption = {maxBytes: 1_000_000, maxEvents: 10, ownerOutbox: {maxPendingBytes: 1_000_000, maxPendingAgeMs: 60_000}};
  Object.assign(f.config, {adoption});
  Object.assign(f.config.workspaces[0]!, {ordinaryReplication: attachment}); await f.save();
  spawn.mockImplementation(async options => {
    captured = clientFrom(options);
    const discovery = captured.client.sendRequest.getMockImplementation()!;
    captured.client.sendRequest.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as {method: string};
      if (request.method === "liveApplication.hosts") return discovery();
      if (request.method === "sync.adoptJoinIdentity") return {result: {adopted: true}} as never;
      if (request.method === "sync.materializePendingCursor") return {result: {materialized: true}} as never;
      if (request.method === "sync.commitCursor") return {result: {committed: true, sharingDeclined: []}} as never;
      return {result: {status: "complete", nextCursor: 7, pendingCursor: {kind: "relay", token: "native-issued-token"},
        hasMore: false, fetched: 1, applied: 1, refused: 0, skipped: 0, conflictsOpened: 0, refusals: [], sharingDeclined: [],
        changedPaths: [{versionId: "main", path: "work.md", operation: "write", contentKind: "text"}]}} as never;
    });
    return captured.client;
  });
  const before = f.storage.getLiveHostControl();
  const host = await startServiceLiveHost(f);
  try {
    expect(captured.config.workspaces[0]).toEqual({root: f.config.workspaces[0]!.root, workspaceId: "workspace", maxRegistrations: 8, relay: attachment.relay});
    expect(captured.config.workspaces[0]).not.toHaveProperty("ordinaryReplication");
    expect(captured.config.adoption).toEqual(adoption);
    expect(f.storage.getLiveHostControl()).toEqual(before);
    expect(f.storage.getLiveHostControl()?.registeredConnectionId).toBeNull();
    await expect(host.drain({workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64)})).rejects.toThrow("retired");
    expect(await host.prepareOrdinary("workspace")).toMatchObject({nextCursor: 7, hasMore: false});
    expect(captured.client.sendRequest).toHaveBeenCalledWith(expect.objectContaining({method: "sync.materializePendingCursor",
      workspace: "actual-open-handle", params: {workspaceId: "workspace", pendingCursor: {kind: "relay", token: "native-issued-token"}}}), expect.any(AbortSignal));
    expect(f.storage.getLiveHostControl()).toEqual(before);
  } finally { await host.close(); }
  expect(f.storage.getLiveHostControl()).toEqual(before);
});

it("rejects an unconfigured ordinary workspace before starting a pull", async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  Object.assign(f.config.workspaces[0]!, {ordinaryReplication: {relay: {baseUrl: "https://relay.example", bearerToken: "owner"},
    identity: {kind: "claim"}, maxPagesPerPull: 1}}); await f.save();
  spawn.mockImplementation(async options => {captured = clientFrom(options); return captured.client;});
  const host = await startServiceLiveHost(f);
  try {
    await expect(host.prepareOrdinary("other")).rejects.toThrow("attachment");
    expect(captured.client.sendRequest).toHaveBeenCalledTimes(1);
  } finally {await host.close();}
});

it("refuses forged engine discovery before opening relay admission", async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async options => {
    captured = clientFrom(options);
    captured.client.sendRequest.mockImplementation(async () => ({ result: { relayNamespace: "foreign", host: captured.config.host, workspaces: [] } }));
    return captured.client;
  });
  await expect(startServiceLiveHost(f)).rejects.toThrow("identity mismatch");
  expect(captured.client.close).toHaveBeenCalledTimes(1);
  expect(existsSync(captured.nativePath)).toBe(false);
  expect(f.storage.getLiveHostControl()?.admissionState).toBe("closed");
});

it("waits for in-flight startup cleanup after cancellation", async () => {
  const f = await fixture(), abort = new AbortController();
  let entered!: () => void, release!: () => void, captured!: ReturnType<typeof clientFrom>;
  const launched = new Promise<void>(resolve => { entered = resolve; });
  const continueLaunch = new Promise<void>(resolve => { release = resolve; });
  spawn.mockImplementation(async options => { captured = clientFrom(options); entered(); await continueLaunch; return captured.client; });
  const pending = startServiceLiveHost({ ...f, signal: abort.signal });
  const refused = expect(pending).rejects.toThrow("cancelled");
  await launched; abort.abort(); release(); await refused;
  expect(captured.client.close).toHaveBeenCalledTimes(1);
  expect(captured.client.waitForExit).toHaveBeenCalledTimes(1);
  expect(existsSync(captured.nativePath)).toBe(false);
  expect(f.storage.getLiveHostControl()?.admissionState).toBe("closed");
});

it("refuses an unconfigured workspace path and a different configured host before spawning", async () => {
  const f = await fixture(); f.config.workspaces[0]!.root = "relative"; await f.save();
  await expect(startServiceLiveHost(f)).rejects.toThrow("absolute");
  f.config.workspaces[0]!.root = join(f.root, "workspace"); f.config.hostId = "different"; await f.save();
  await expect(startServiceLiveHost(f)).rejects.toThrow("provisioned control");
  expect(spawn).not.toHaveBeenCalled();
});

it("closes the daemon immediately when storage loses continuity standing", async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async options => { captured = clientFrom(options); return captured.client; });
  const host = await startServiceLiveHost(f);
  f.closeStorage();
  expect(host.invalidated.aborted).toBe(true);
  expect(captured.client.close).toHaveBeenCalledTimes(1);
  await host.close();
  expect(existsSync(captured.nativePath)).toBe(false);
});

it("preserves a replacement connection when an older host closes", async () => {
  const f = await fixture();
  spawn.mockImplementation(async options => clientFrom(options).client);
  const host = await startServiceLiveHost(f);
  expect(f.storage.registerLiveHost({ ...host.coordinate, connectionId: "replacement", updatedAtMs: Date.now(), guard: f.storage.captureStanding() }).ok).toBe(true);
  await expect(host.drain({ workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64) })).rejects.toThrow("retired");
  await host.close();
  expect(f.storage.getLiveHostControl()).toMatchObject({ registeredConnectionId: "replacement", admissionState: "open" });
});

it("wakes captures after stored authority changes and releases its observer on close", async () => {
  const f = await fixture(), notify = vi.fn();
  spawn.mockImplementation(async options => clientFrom(options).client);
  const host = await startServiceLiveHost({...f, frameChanges: {maxListeners: 16, notify, notifyHost() {}, subscribe: () => () => {}}});
  await new Promise<void>(queueMicrotask);
  notify.mockClear();
  const stopReading = observeRelayWrites(f.storage, () => {
    f.storage.resolveCurrentLiveDocumentBinding({document: {workspaceId: "workspace", mainVersionId: "main", objectId: "missing", lineageClaimId: "a".repeat(64)}, actor: {kind: "named", userId: "alice", grantId: "missing"}});
  });
  const stop = observeRelayWrites(f.storage, () => {});
  f.storage.registerLiveHost({...host.coordinate, connectionId: "replacement", updatedAtMs: Date.now(), guard: f.storage.captureStanding()});
  expect(notify).not.toHaveBeenCalled();
  await new Promise<void>(queueMicrotask);
  expect(notify).toHaveBeenCalledTimes(1);
  await new Promise<void>(queueMicrotask);
  expect(notify).toHaveBeenCalledTimes(1);
  stopReading();
  await host.close();
  await new Promise<void>(queueMicrotask);
  notify.mockClear();
  f.storage.registerLiveHost({...host.coordinate, connectionId: "another", updatedAtMs: Date.now(), guard: f.storage.captureStanding()});
  await new Promise<void>(queueMicrotask);
  expect(notify).not.toHaveBeenCalled();
  stop();
});

it("forwards explicitly provisioned native sync bounds without enabling frame capture implicitly", async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async options => {captured = clientFrom(options); return captured.client;});
  const sync = {policy: {maxClientVectorBytes: 1000, maxHostVectorBytes: 1000, maxOutputBytes: 10000,
    maxReadBytes: 10000}, workingReserveBytes: 10000};
  await writeFile(f.configPath, JSON.stringify({...f.config, sync}));
  const host = await startServiceLiveHost(f);
  try {
    expect(captured.config.sync).toEqual(sync);
    await expect(host.captureNative({workspaceId: "workspace", mainVersionId: "main", objectId: "object",
      lineageClaimId: "a".repeat(64), currentPath: "docs/note.md", selectorPaths: ["docs"], restoreFenceGeneration: 0})).rejects.toThrow("not configured");
  } finally {await host.close();}
});

it("rejects zero application reserve before spawning with or without settlement", async () => {
  const f = await fixture();
  f.config.ingress.applicationWorkingReserveBytes = 0;
  const settlement = { maxApplicationsPerSettlement: 8 };
  await writeFile(f.configPath, JSON.stringify({ ...f.config, settlement }));
  await expect(startServiceLiveHost(f)).rejects.toThrow("Live application requires a positive applicationWorkingReserveBytes limit.");
  expect(spawn).not.toHaveBeenCalled();
  spawn.mockImplementation(async options => clientFrom(options).client);
  await f.save();
  await expect(startServiceLiveHost(f)).rejects.toThrow("Live application requires a positive applicationWorkingReserveBytes limit.");
  f.config.ingress.applicationWorkingReserveBytes = 1;
  await writeFile(f.configPath, JSON.stringify({ ...f.config, settlement }));
  const withSettlement = await startServiceLiveHost(f);
  await withSettlement.close();
});

it("requires a restore working reserve and passes only native restore bounds to the engine", async () => {
  const f = await fixture();
  const validation = {maxStructVisits: 1000, maxValueNodeVisits: 1000, maxDecodedPayloadByteVisits: 1000,
    maxStructClientGroupVisits: 1000, maxDeleteClientGroupVisits: 1000, maxDeleteIntervalVisits: 1000, maxIndexOperations: 1000};
  const restore = {maxBytes: 1_000_000, maxEvents: 10, aggregateBytes: 17_000_000, workingReserveBytes: 1_000_000,
    maxOperations: 1, validation};
  f.config.ingress.applicationWorkingReserveBytes = 0;
  await writeFile(f.configPath, JSON.stringify({...f.config, restore}));
  await expect(startServiceLiveHost(f)).rejects.toThrow("Live application requires a positive applicationWorkingReserveBytes limit.");
  expect(spawn).not.toHaveBeenCalled();
  f.config.ingress.applicationWorkingReserveBytes = 50_000_000;
  await writeFile(f.configPath, JSON.stringify({...f.config, restore}));
  let captured!: ReturnType<typeof clientFrom>;
  spawn.mockImplementation(async options => {captured = clientFrom(options); return captured.client;});
  const host = await startServiceLiveHost(f);
  try {
    expect(captured.config.restore).toEqual({maxBytes: restore.maxBytes, maxEvents: restore.maxEvents});
    await expect(host.prepareRestore({operationId: "restore", workspaceId: "other", ownerUserId: "owner"})).rejects.toThrow("not configured");
  } finally {await host.close();}
});

async function configureActivation(f: Awaited<ReturnType<typeof fixture>>,limits = {}) {
  Object.assign(f.config.workspaces[0]!,{ordinaryReplication:{relay:{baseUrl:"https://relay.example",bearerToken:"owner-token"},
    identity:{kind:"join",replicationEpoch:"epoch",streamIdentity:"stream"},maxPagesPerPull:1}});
  Object.assign(f.config,{adoption:{maxBytes:1_000_000,maxEvents:10,ownerOutbox:{maxPendingBytes:1_000_000,maxPendingAgeMs:60_000}},
    sync:{policy:{maxReadBytes:1_000_000,maxOutputBytes:1_000_000,maxClientVectorBytes:1000,maxHostVectorBytes:1000},workingReserveBytes:1_000_000},
    activation:{targets:[{workspaceId:"workspace",path:"file.md",shareId:"share"}],maxCaptureBytes:1_000_000,
      maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000,maxDocumentsPerPass:1,pollIntervalMs:60_000,passDeadlineMs:1000,
      idleUnloadMs:600_000,idleRetryMs:30_000,
      validation:{maxStructVisits:1000,maxValueNodeVisits:1000,maxDecodedPayloadByteVisits:1000,maxStructClientGroupVisits:1000,
        maxDeleteClientGroupVisits:1000,maxDeleteIntervalVisits:1000,maxIndexOperations:1000},...limits}});
  await f.save();
}

it("runs bounded ordinary preparation in the configured activation lifecycle and closes its pass",async()=>{
  const f=await fixture();let captured!:ReturnType<typeof clientFrom>;
  await configureActivation(f);
  spawn.mockImplementation(async options=>{
    captured=clientFrom(options);const discovery=captured.client.sendRequest.getMockImplementation()!;
    captured.client.sendRequest.mockImplementation(async(...args:unknown[])=>{
      const request=args[0] as {method:string};
      if(request.method==="liveApplication.hosts")return discovery();
      if(request.method==="sync.adoptJoinIdentity")return {result:{adopted:true}} as never;
      if(request.method==="sync.materializePendingCursor")return {result:{materialized:true}} as never;
      if(request.method==="sync.commitCursor")return {result:{committed:true,sharingDeclined:[]}} as never;
      return {result:{status:"complete",nextCursor:1,pendingCursor:{kind:"relay",token:"pending"},hasMore:true,
        fetched:1,applied:1,refused:0,skipped:0,conflictsOpened:0,refusals:[],sharingDeclined:[],changedPaths:[]}} as never;
    });return captured.client;
  });
  const host=await startServiceLiveHost(f);
  await vi.waitFor(()=>expect(captured.client.sendRequest).toHaveBeenCalledWith(expect.objectContaining({method:"sync.commitCursor"}),expect.any(AbortSignal)));
  await expect(host.prepareOrdinary("workspace")).rejects.toThrow("activation driver owns");
  expect(f.storage.getLiveHostControl()!.registeredConnectionId).toBeNull();
  await host.close();
  expect(captured.client.close).toHaveBeenCalledTimes(1);
  expect(captured.client.waitForExit).toHaveBeenCalledTimes(1);
});

it("joins deadline-expired activation work before removing the native directory",async () => {
  const f = await fixture(), entered = deferred<AbortSignal>();
  const settled = deferred<Awaited<ReturnType<ServiceActivationDriver["activate"]>>>();
  await configureActivation(f,{passDeadlineMs: 10});
  let captured!: ReturnType<typeof clientFrom>; const order: string[] = [];
  spawn.mockImplementation(async options => {
    captured = clientFrom(options);
    captured.client.waitForExit.mockImplementation(async () => {order.push("exit");});
    return captured.client;
  });
  const activate = vi.spyOn(ServiceActivationDriver.prototype,"activate").mockImplementation((_target,signal) => {
    entered.resolve(signal); return settled.promise.then(result => {order.push("settled"); return result;});
  });
  const host = await startServiceLiveHost(f), signal = await entered.promise;
  await new Promise<void>(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener("abort",() => resolve(),{once: true});
  });
  const closed = vi.fn(), closes = [host.close().then(closed),host.close().then(closed)];
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(signal.aborted).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(captured.client.close).toHaveBeenCalledTimes(1);
    expect(captured.client.waitForExit).not.toHaveBeenCalled();
    expect(existsSync(captured.nativePath)).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
  } finally {settled.resolve({kind: "pending",reason: "finished"}); await Promise.all(closes); activate.mockRestore();}
  expect(closed).toHaveBeenCalledTimes(2);
  expect(captured.client.waitForExit).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["settled","exit"]);
  expect(existsSync(captured.nativePath)).toBe(false);
});

it("keeps activation polling when logging throws and resets repeated errors after success",async () => {
  const f = await fixture(); await configureActivation(f,{pollIntervalMs: 100});
  spawn.mockImplementation(async options => clientFrom(options).client);
  const activate = vi.spyOn(ServiceActivationDriver.prototype,"activate").mockRejectedValue(new Error("offline"));
  const log = vi.spyOn(console,"error").mockImplementation(() => {throw new Error("logger failed");});
  vi.useFakeTimers();
  const host = await startServiceLiveHost(f);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(activate).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(activate).toHaveBeenCalledTimes(2); expect(log).toHaveBeenCalledTimes(1);
    activate.mockResolvedValueOnce({kind: "pending",reason: "completed pass"});
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(activate).toHaveBeenCalledTimes(4); expect(log).toHaveBeenCalledTimes(2);
  } finally {await host.close(); vi.useRealTimers(); log.mockRestore(); activate.mockRestore();}
});

const {DatabaseSync} = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// A service owner whose activation completed under an earlier connection, as
// after a restart. The started host resumes it from real relay storage; only
// the engine is mocked. `park` holds the next engine request for one method.
async function completedServiceOwner(options: {empty?: boolean; frameChanges?: boolean} = {}) {
  const f = await fixture(), raw = new DatabaseSync(join(f.root, "relay", "relay.sqlite"));
  cleanup.push(async () => raw.close());
  const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
    maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
  const validateBaseline = createLiveMarkdownRegistrationValidator(policy), validateJournal = createLiveMarkdownJournalValidator(policy);
  const doc = markdownToYDoc("Original"), baselineBytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.getMap("frontmatter").set("title", "Edited");
  const fullState = Buffer.from(Y.encodeStateAsUpdate(doc)); doc.destroy();
  const document = {workspaceId: "workspace", mainVersionId: "main" as const, objectId: "object", lineageClaimId: sha256(baselineBytes)};
  const validated = validateJournal({document, currentPath: "docs/a.md", checkpoint: baselineBytes, suffix: [], candidate: fullState});
  const base = validateBaseline({document, currentPath: "docs/a.md", checkpoint: baselineBytes});
  if (validated.kind !== "accepted" || base.kind !== "accepted") throw new Error("Invalid owner fixture.");
  const capture: NativeOwnerActivation = {activationId: `ordinary-activation-${"a".repeat(64)}`, sessionId: "native-session", baselineBytes, fullState,
    source: {version: 1, relayDatabaseNamespace: f.history.namespace, ...document, currentPath: "docs/a.md", replicationEpoch: "epoch",
      streamIdentity: "stream", committedCursor: 3, baseOriginId: "origin", baseOriginSeq: 1, baseRelaySeq: 2,
      sourceMomentId: `moment-ydoc-apply-${sha256(Buffer.from(["workspace", "main", "object", "docs/a.md", "origin", "2"].join("\0")))}`,
      sourceDigest: validated.evidence.projectedMarkdownSha256, sourceByteLength: validated.evidence.projectedMarkdownByteLength,
      nativeHeadSequence: 2, fullStateDigest: sha256(fullState), fullStateByteLength: fullState.length}};
  raw.exec("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES ('workspace','owner',0,'epoch','stream')");
  const log = raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',?,?,?,?)");
  log.run(0, "moment.append", JSON.stringify({versionId: "main", objectId: "object", momentId: "original-moment", path: "docs/a.md", operation: "write",
    payloadAfterPath: "docs/a.md", payloadAfterContentKind: "text", payloadAfterBlobSha256: base.evidence.projectedMarkdownSha256,
    payloadAfterByteLength: base.evidence.projectedMarkdownByteLength}), 0);
  log.run(1, "ydoc.update", JSON.stringify({versionId: "main", objectId: "object", path: "docs/a.md", contentKind: "richdoc", isBaseState: true,
    lineageClaimId: document.lineageClaimId, updateBlobSha256: document.lineageClaimId}), 1);
  log.run(2, "ydoc.update", JSON.stringify({versionId: "main", objectId: "object", path: "docs/a.md", contentKind: "richdoc", isBaseState: false,
    lineageClaimId: document.lineageClaimId, updateBlobSha256: sha256(fullState)}), 2);
  const blob = raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)");
  blob.run(document.lineageClaimId, baselineBytes.length, baselineBytes); blob.run(sha256(fullState), fullState.length, fullState);
  raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace','object',1,'original-moment','main','docs/a.md',?,'text',?,0)")
    .run(base.evidence.projectedMarkdownSha256, base.evidence.projectedMarkdownByteLength);
  raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share','workspace','owner',?,0)")
    .run(JSON.stringify({paths: ["docs"], versionId: null}));
  raw.exec("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('grant','share','user','reader',NULL,'edit',1,'active',0,NULL,NULL)");

  // Complete the activation under the earlier connection: adoption, seed, native application.
  const earlier = {mode: "service" as const, hostId: "service", hostEpoch: f.storage.getLiveHostControl()!.hostEpoch, instanceId: "instance", connectionId: "earlier"};
  const actor = {kind: "owner" as const, userId: "owner", shareId: "share"}, store = f.storage.createServiceActivationStore(f.history);
  store.prepare({capture, host: earlier, shareId: "share", registeredAtMs: 3, guard() {}, validateBaseline, validateJournal,
    bounds: {maxCaptureBytes: 1_000_000, maxEntriesPerDrain: 10, maxBytesPerDrain: 1_000_000}});
  const access = store.pending(document, earlier), delivery = f.storage.createLiveCommittedDeliveryStore(f.history, access);
  const adoption = delivery.captureOwnerCut({host: earlier, document, actor, adoptionId: capture.activationId,
    expectedLocalSequence: 2, maxBytes: 1_000_000, maxEvents: 100, throughCursor: 0});
  delivery.acknowledgeOwnerAdoption(adoption, {adoptionId: capture.activationId, localYDocSequence: 2, terminalCursor: 0, adoptionReplayed: false});
  const current = f.storage.resolveCurrentLiveDocumentBinding({document, actor}, access), cut = f.storage.readLiveUpdateJournalCut({document});
  if (current.kind !== "current" || cut.kind !== "cut") throw new Error("Missing activation authority.");
  const seed = validateJournal({document, currentPath: current.binding.currentPath, checkpoint: cut.cut.checkpoint.bytes,
    suffix: cut.cut.suffix.map(row => row.bytes), candidate: fullState});
  f.storage.commitLiveUpdateJournal({host: earlier, actor, expectedAuthority: current.authority,
    metadata: {deliveryId: "seed", updateDigest: sha256(fullState), binding: current.binding}, cutToken: cut.cut, validation: seed,
    updateBytes: fullState, receivedAtMs: 4}, access);
  const owner = delivery.openOwnerDelivery({host: earlier, document, actor}), event = delivery.nextOwnerApplication(owner)!;
  delivery.acknowledgeOwnerDeliveryApplication(owner, {...event.metadata.accepted.receipt, localYDocSequence: 2, applicationReplayed: false});
  store.complete({document, host: earlier, access, nativeState: {adoptionId: capture.activationId, pendingBytes: 0}, guard() {}});

  Object.assign(f.config, {settlement: {maxApplicationsPerSettlement: 8}});
  const target = {workspaceId: "workspace", path: "docs/a.md", shareId: "share"};
  // An empty host activates documents it gains on its next pass.
  await configureActivation(f, {targets: options.empty ? [] : [target], passDeadlineMs: 10_000, validation: policy, ...(options.empty ? {pollIntervalMs: 20} : {})});
  // An empty host receives this workspace and document through `update`.
  const workspace = f.config.workspaces[0]! as ServiceWorkspace;
  if (options.empty) {f.config.workspaces = []; await f.save();}

  let parked: {method: string; entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>>} | undefined;
  const pushed = deferred<void>(), unloads: unknown[] = [];
  const membership: {method: string; workspace?: string; params: unknown}[] = [];
  let ownerRequests = 0, client!: ReturnType<typeof clientFrom>["client"] & {captureOwnerActivation: ReturnType<typeof vi.fn>};
  spawn.mockImplementation(async options => {
    const captured = clientFrom(options), discovery = captured.client.sendRequest.getMockImplementation()!;
    client = Object.assign(captured.client, {captureOwnerActivation: vi.fn(async () => capture)});
    client.sendRequest.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as {id: number; method: string; workspace?: string; params: Record<string, unknown>}, held = parked;
      if (request.method.startsWith("liveApplication.")) ownerRequests++;
      if (held?.method === request.method) { parked = undefined; held.entered.resolve(); await held.release.promise; }
      const reply = (result: unknown) => ({id: request.id, result}) as never;
      if (/^liveApplication\.(attach|detach|unload)/.test(request.method)) membership.push({method: request.method, workspace: request.workspace, params: request.params});
      switch (request.method) {
        case "liveApplication.hosts": return discovery();
        case "liveApplication.attachWorkspace": return reply({workspaceId: request.params.workspaceId,
          workspaceHandle: request.params.workspaceId === "workspace" ? "attached-handle" : `attached-${request.params.workspaceId}`});
        case "liveApplication.detachWorkspace": return reply({detached: true});
        case "liveApplication.unloadDocument": return reply(unloads.shift() ?? {status: "unloaded"});
        case "liveApplication.register": return reply({registrationId: 7});
        case "liveApplication.ownerState": return reply({adoptionId: capture.activationId, expectedLocalSequence: 2, throughCursor: 0,
          outboxId: null, pendingBytes: 0, outboxState: "active"});
        case "liveApplication.settle": {
          const terminal = request.params.terminalReceipt as {journalCursor: number} | null;
          return reply({status: "settled", settlement: {settlementId: "settlement", previousCursor: 0, terminalCursor: terminal?.journalCursor ?? 0,
            applicationCount: 0, localYDocSequence: 2, momentId: "settled-moment", markdownDigest: "c".repeat(64), materialized: true,
            collectionReconcileRequired: false}});
        }
        case "sync.adoptJoinIdentity": return reply({adopted: true});
        case "sync.push": pushed.resolve();
          return reply({status: "complete", hasMore: false, pushed: 0, sharingDeclined: [], ownerAdmissionPending: []});
        case "sync.pull": return reply({status: "complete", nextCursor: 3, pendingCursor: {kind: "relay", token: "pending"}, hasMore: false,
          fetched: 0, applied: 0, refused: 0, skipped: 0, conflictsOpened: 0, refusals: [], sharingDeclined: [], changedPaths: []});
        case "sync.materializePendingCursor": return reply({materialized: true});
        case "sync.commitCursor": return reply({committed: true, sharingDeclined: []});
      }
      throw new Error(`Unexpected engine request ${request.method}.`);
    });
    return client;
  });
  const host = await startServiceLiveHost({...f, ...(options.frameChanges ? {frameChanges: createNamedFrameChanges(16)} : {})});
  cleanup.push(() => host.close());
  // The activation pass publishes readiness before it pushes ordinary changes.
  if (!options.empty) await pushed.promise;
  return {f, raw, host, document, workspace, target, pushed, unloads, membership, spawned: () => spawn.mock.calls.length, client: () => client,
    ownerRequests: () => ownerRequests,
    park(method: string) { parked = {method, entered: deferred<void>(), release: deferred<void>()}; return parked; },
    restore() {
      const plan = f.storage.readStopRestorePlan({document, ownerUserId: "owner", operationId: "restore", shareId: "share", grantId: "grant",
        restorePointCursor: 0, restorePointReceiptDigest: document.lineageClaimId, maxOutputBytes: 1_000_000});
      f.storage.beginStopRestore(plan.intent, 40);
      f.storage.advanceStopRestoreFence({operationId: "restore", workspaceId: "workspace", ownerUserId: "owner"}, 50);
    }};
}

// Proves: a real restore fence while a public call is in the engine fails that
// call and the public calls queued behind it as incomplete. The queued calls
// resolve their owner inside the document work and make no engine request.
it.each(["drain", "settle"] as const)("fails an in-flight public %s and queued public calls as incomplete after a restore fence", async method => {
  const o = await completedServiceOwner();
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  const parked = o.park("liveApplication.ownerState"), inflight = o.host[method](o.document);
  await parked.entered.promise;
  const drains = vi.spyOn(OwnerCommittedDelivery.prototype, "drain"), settles = vi.spyOn(OwnerCommittedDelivery.prototype, "settle");
  try {
    const queuedDrain = o.host.drain(o.document), queuedSettle = o.host.settle(o.document), requests = o.ownerRequests();
    o.restore();
    expect(o.raw.prepare("SELECT admission_state FROM sync_relay_live_documents").get()).toEqual({admission_state: "closed"});
    expect(o.host.isDocumentReady(o.document)).toBe(false);
    parked.release.resolve();
    await expect(inflight).rejects.toThrow("Service document activation is incomplete.");
    await expect(queuedDrain).rejects.toThrow("Service document activation is incomplete.");
    await expect(queuedSettle).rejects.toThrow("Service document activation is incomplete.");
    expect(o.ownerRequests()).toBe(requests);
    // The queued calls never reached owner delivery.
    expect(drains).not.toHaveBeenCalled();
    expect(settles).not.toHaveBeenCalled();
  } finally { drains.mockRestore(); settles.mockRestore(); }
});

// Proves: damaged owner evidence on an unchanged open binding, and caller
// cancellation during a fence, are not reported as an expected fence.
it("keeps damaged evidence and caller cancellation visible for public delivery", async () => {
  const o = await completedServiceOwner();
  let parked = o.park("liveApplication.ownerState");
  const inflight = o.host.drain(o.document);
  await parked.entered.promise;
  const queued = o.host.settle(o.document);
  const origin = o.raw.prepare("SELECT origin_json FROM sync_relay_live_delivery_owners").get()!.origin_json;
  o.raw.exec("UPDATE sync_relay_live_delivery_owners SET origin_json=json_set(origin_json,'$.sourceMomentId','unrelated-source')");
  parked.release.resolve();
  await expect(inflight).rejects.toThrow("Committed delivery evidence is damaged or conflicts.");
  await expect(queued).rejects.toThrow("Committed delivery evidence is damaged or conflicts.");

  o.raw.prepare("UPDATE sync_relay_live_delivery_owners SET origin_json=?").run(origin);
  const abort = new AbortController(), reason = new Error("Caller cancelled.");
  parked = o.park("liveApplication.ownerState");
  const cancelled = o.host.drain(o.document, abort.signal);
  await parked.entered.promise;
  o.restore(); abort.abort(reason);
  parked.release.resolve();
  await expect(cancelled).rejects.toBe(reason);
});

// An empty host whose sibling document activates for real. The other document
// counts as loaded but never activates, so only its unload reaches the engine.
async function emptyServiceHost(options: {frameChanges?: boolean} = {}) {
  const o = await completedServiceOwner({empty: true, ...options});
  const sibling = {workspaceId: "workspace", objectId: "object", path: "docs/a.md", shareId: "share"};
  const other = {workspaceId: "workspace", objectId: "object-b", path: "docs/b.md", shareId: "share"};
  const activate = ServiceActivationDriver.prototype.activate, loaded = ServiceActivationDriver.prototype.loaded;
  vi.spyOn(ServiceActivationDriver.prototype, "activate").mockImplementation(function (this: ServiceActivationDriver, ...args) {
    return args[0].path === other.path ? Promise.resolve({kind: "pending" as const, reason: "held"}) : activate.apply(this, args);
  });
  vi.spyOn(ServiceActivationDriver.prototype, "loaded").mockImplementation(function (this: ServiceActivationDriver, target) {
    return target.path === other.path || loaded.call(this, target);
  });
  cleanup.push(async () => {vi.restoreAllMocks();});
  const attach = {method: "liveApplication.attachWorkspace", workspace: undefined, params: {root: o.workspace.root, workspaceId: "workspace",
    maxRegistrations: 8, relay: {baseUrl: "https://relay.example", bearerToken: "owner-token"}}};
  return {...o, sibling, other, attach, unload: {method: "liveApplication.unloadDocument", workspace: "attached-handle", params: {objectId: other.objectId}}};
}

it("adds and unloads documents on one daemon while the sibling document stays ready", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  expect(await o.host.update({workspaces, documents: [o.sibling]})).toEqual([]);
  await o.pushed.promise;
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(o.host.settled(o.sibling)).toBe(true);
  expect(o.membership).toEqual([o.attach]);
  expect(await o.host.update({workspaces, documents: [o.sibling, o.other]})).toEqual([]);
  expect(o.host.holds(o.other)).toBe(true); expect(o.host.settled(o.other)).toBe(false);
  // The engine still holds unsettled work for the removed document, so it waits for a later update.
  o.unloads.push({status: "pending", reason: "settlement-pending"});
  expect(await o.host.update({workspaces, documents: [o.sibling]})).toEqual([{workspaceId: "workspace", objectId: o.other.objectId}]);
  expect(o.host.holds(o.other)).toBe(true);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  expect(await o.host.update({workspaces, documents: [o.sibling]})).toEqual([]);
  expect(o.host.holds(o.other)).toBe(false); expect(o.host.holds(o.sibling)).toBe(true);
  expect(o.membership).toEqual([o.attach, o.unload, o.unload]);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  expect(o.spawned()).toBe(1); expect(o.client().close).not.toHaveBeenCalled();
  expect(o.f.storage.getLiveHostControl()?.registeredConnectionId).toBe(o.host.coordinate.connectionId);
});

it("detaches a workspace after its last document and attaches it again on the same daemon", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling]});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(await o.host.update({workspaces: [], documents: []})).toEqual([]);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  expect(o.membership.at(-1)).toEqual({method: "liveApplication.detachWorkspace", workspace: "attached-handle", params: {}});
  await o.host.update({workspaces, documents: [o.sibling]});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(o.membership.map(row => row.method)).toEqual(["liveApplication.attachWorkspace", "liveApplication.unloadDocument",
    "liveApplication.detachWorkspace", "liveApplication.attachWorkspace"]);
  expect(o.spawned()).toBe(1); expect(o.client().close).not.toHaveBeenCalled();
});

it("keeps a workspace attached while its last document's unload is pending and detaches it once the unload succeeds", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.other]});
  o.unloads.push({status: "pending", reason: "settlement-pending"});
  expect(await o.host.update({workspaces: [], documents: []})).toEqual([{workspaceId: "workspace", objectId: o.other.objectId}]);
  // Still attached, so activation passes keep settling the document.
  expect(o.membership).toEqual([o.attach, o.unload]);
  expect(o.host.automationLedger("workspace")).not.toBeNull();
  expect(await o.host.update({workspaces: [], documents: []})).toEqual([]);
  expect(o.membership).toEqual([o.attach, o.unload, o.unload, {method: "liveApplication.detachWorkspace", workspace: "attached-handle", params: {}}]);
  expect(o.host.automationLedger("workspace")).toBeNull();
  expect(o.spawned()).toBe(1); expect(o.client().close).not.toHaveBeenCalled();
});

it.each([false, true])("detaches a workspace at once when its identity changes, leaving its pending document unsettled (new documents at once: %s)", async newAtOnce => {
  const o = await emptyServiceHost();
  const siblingRoot = join(o.f.root, "workspace-2"), rotatedRoot = join(o.f.root, "workspace-rotated");
  await mkdir(siblingRoot); await mkdir(rotatedRoot);
  const sibling = {...o.workspace, root: siblingRoot, workspaceId: "workspace-2"}, siblingDocument = {...o.other, workspaceId: "workspace-2"};
  const rotated = {...o.workspace, root: rotatedRoot,
    ordinaryReplication: {...o.workspace.ordinaryReplication!, identity: {kind: "join" as const, replicationEpoch: "epoch-2", streamIdentity: "stream-2"}}};
  await o.host.update({workspaces: [o.workspace, sibling], documents: [o.other, siblingDocument]});
  expect(o.host.holds(o.other)).toBe(true);
  o.membership.splice(0);
  // Settlement under the old identity is refused, so an unload would stay pending forever.
  o.unloads.push({status: "pending", reason: "settlement-pending"});
  expect(o.f.storage.rotateWorkspaceIdentity({workspaceId: "workspace", ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 10})).toBe("rotated");
  const detach = {method: "liveApplication.detachWorkspace", workspace: "attached-handle", params: {}};
  const attach = {...o.attach, params: {...o.attach.params, root: rotatedRoot}};
  const rotatedSet = {workspaces: [rotated, sibling], documents: [o.other, siblingDocument]};
  if (!newAtOnce) {
    expect(await o.host.update({workspaces: [sibling], documents: [siblingDocument]})).toEqual([]);
    expect(o.membership).toEqual([detach]);
    expect(o.host.holds(o.other)).toBe(false);
    expect(o.host.automationLedger("workspace")).toBeNull();
    // Nothing is left to retry.
    expect(await o.host.update({workspaces: [sibling], documents: [siblingDocument]})).toEqual([]);
    expect(o.membership).toEqual([detach]);
  }
  expect(await o.host.update(rotatedSet)).toEqual([]);
  expect(o.membership).toEqual([detach, attach]);
  expect(o.host.holds(o.other)).toBe(true);
  // The sibling workspace keeps its attachment and document throughout.
  expect(o.host.holds(siblingDocument)).toBe(true);
  expect(o.host.automationLedger("workspace-2")).not.toBeNull();
  expect(o.membership.every(row => row.workspace !== "attached-workspace-2")).toBe(true);
  expect(o.spawned()).toBe(1); expect(o.client().close).not.toHaveBeenCalled();
});

it("keeps the daemon after a refused attach and retires it when the engine expires its connection", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], send = o.client().sendRequest;
  const refuse = (code: string) => {
    const reply = send.getMockImplementation()! as (...args: unknown[]) => Promise<never>;
    send.mockImplementationOnce(async (...args: unknown[]) => (args[0] as {method: string}).method === "liveApplication.attachWorkspace"
      ? Promise.reject(new EngineRequestError(1, {code, message: code, retry: "no"} as never)) : reply(...args));
  };
  refuse("INVALID_PARAMS");
  await expect(o.host.update({workspaces, documents: [o.sibling]})).rejects.toThrow("INVALID_PARAMS");
  expect(o.host.invalidated.aborted).toBe(false);
  await o.host.update({workspaces, documents: [o.sibling]});
  await o.host.update({workspaces: [], documents: []});
  refuse("SESSION_EXPIRED");
  await expect(o.host.update({workspaces, documents: [o.sibling]})).rejects.toThrow("SESSION_EXPIRED");
  expect(o.host.invalidated.aborted).toBe(true);
});

// An empty host holding the real document and a held one, on a manual clock.
// Only Date.now is fake: passes run on real timers, and visits to the held
// document count them. `hold` keeps passes from activating the real document.
async function idleHost() {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const o = await emptyServiceHost({frameChanges: true}), workspaces = [o.workspace];
  const activate = vi.mocked(ServiceActivationDriver.prototype.activate), through = activate.getMockImplementation()!;
  let held = false;
  activate.mockImplementation(function (this: ServiceActivationDriver, ...args) {
    return held && args[0].path === o.sibling.path ? Promise.resolve({kind: "pending" as const, reason: "held"}) : through.apply(this, args);
  });
  await o.host.update({workspaces, documents: [o.sibling, o.other]});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const visits = (path: string) => activate.mock.calls.filter(([target]) => target.path === path).length;
  const requests = () => o.client().sendRequest.mock.calls.map(call => (call as unknown[])[0] as {method: string; params: Record<string, unknown>});
  const methods = () => requests().map(request => request.method);
  return {...o, workspaces, editors: liveEditors(o.f.storage), methods, visits,
    hold(value: boolean) {held = value;},
    advance(ms: number) {now += ms;},
    async passes(count = 2) {
      const start = visits(o.other.path);
      await vi.waitFor(() => expect(visits(o.other.path)).toBeGreaterThanOrEqual(start + count));
    },
    unloaded: () => o.membership.filter(row => row.method === "liveApplication.unloadDocument" && (row.params as {objectId: string}).objectId === "object").length,
    settles: () => requests().filter(request => request.method === "liveApplication.settle").map(request => request.params.terminalReceipt),
    binding() {
      const current = o.f.storage.resolveCurrentLiveDocumentBinding({document: o.document, actor: {kind: "owner", userId: "owner", shareId: "share"}});
      if (current.kind !== "current") throw new Error("Missing live binding.");
      return current.binding;
    }};
}

it("unloads a hosted document after ten minutes with no live connection, not before, and keeps it hosted", async () => {
  const o = await idleHost();
  o.advance(600_000 - 1); await o.passes();
  expect(o.unloaded()).toBe(0);
  o.advance(1);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  // The settled output was published right before the engine unloaded the document.
  const methods = o.methods();
  expect(methods[methods.lastIndexOf("liveApplication.unloadDocument") - 1]).toBe("sync.push");
  expect(o.host.holds(o.sibling)).toBe(true); expect(o.host.settled(o.sibling)).toBe(true);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  expect(o.spawned()).toBe(1); expect(o.client().close).not.toHaveBeenCalled();
});

it("keeps a document loaded while any live connection is open and restarts the idle period when the last one closes", async () => {
  const o = await idleHost(), first = o.editors.acquire(o.sibling), second = o.editors.acquire(o.sibling);
  o.advance(1_200_000); await o.passes();
  first();
  o.advance(600_000); await o.passes();
  expect(o.unloaded()).toBe(0);
  second();
  o.advance(600_000 - 1); await o.passes();
  expect(o.unloaded()).toBe(0);
  o.advance(1);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
});

it("cancels an idle unload when a connection opens before the unload reaches the engine", async () => {
  const o = await idleHost();
  // Held passes publish nothing, so the next push is the idle unload's own publication.
  o.hold(true);
  const parked = o.park("sync.push");
  o.advance(600_000);
  await parked.entered.promise;
  const release = o.editors.acquire(o.sibling);
  parked.release.resolve();
  await o.passes();
  expect(o.unloaded()).toBe(0);
  o.hold(false);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
  release();
});

it("reloads a document opened while its unload is in the engine, once that unload finishes", async () => {
  const o = await idleHost(), captures = o.client().captureOwnerActivation.mock.calls.length;
  o.hold(true);
  const parked = o.park("liveApplication.unloadDocument");
  o.advance(600_000);
  await parked.entered.promise;
  o.hold(false);
  const release = o.editors.acquire(o.sibling), opening = o.host.captureNative(o.binding());
  parked.release.resolve();
  const native = await opening;
  expect(o.unloaded()).toBe(1);
  expect(native.invalidated.aborted).toBe(false);
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
  release();
});

it("reopens a dormant document from its retained activation through the same accepted edits and unloads it again when idle", async () => {
  const o = await idleHost(), earlier = await o.host.captureNative(o.binding());
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  // The unload ended the earlier registration.
  await vi.waitFor(() => expect(earlier.invalidated.aborted).toBe(true));
  const before = o.settles().at(-1), sent = o.methods().length;
  const native = await o.host.captureNative(o.binding());
  expect(native.invalidated.aborted).toBe(false);
  // The engine resumes the retained activation, and its owner state proves the
  // retained adoption, so the document is not adopted again.
  expect(o.client().captureOwnerActivation).toHaveBeenLastCalledWith(expect.anything(), "docs/a.md", 1_000_000, expect.any(AbortSignal), `ordinary-activation-${"a".repeat(64)}`);
  expect(o.methods().slice(sent)).toEqual(expect.arrayContaining(["liveApplication.register", "liveApplication.ownerState"]));
  expect(o.settles().at(-1)).toEqual(before);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
  o.advance(600_000 - 1); await o.passes();
  expect(o.unloaded()).toBe(1);
  o.advance(1);
  await vi.waitFor(() => expect(o.unloaded()).toBe(2));
});

it("keeps a document loaded while the engine reports unfinished work and retries its unload", async () => {
  const o = await idleHost(), log = vi.spyOn(console, "error").mockImplementation(() => {});
  o.unloads.push({status: "pending", reason: "settlement-pending"});
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  expect(log).toHaveBeenCalledWith("Idle live document unload is waiting.", "settlement-pending");
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
  o.advance(30_000 - 1); await o.passes();
  expect(o.unloaded()).toBe(1);
  o.advance(1);
  await vi.waitFor(() => expect(o.unloaded()).toBe(2));
  await vi.waitFor(() => expect(o.host.drain(o.document)).rejects.toThrow("Service document activation is incomplete."));
});

it("keeps background activation from reloading a dormant document, which leaves hosting without another unload", async () => {
  const o = await idleHost();
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  const captures = o.client().captureOwnerActivation.mock.calls.length, visits = o.visits(o.sibling.path);
  await o.passes(4);
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures);
  expect(o.visits(o.sibling.path)).toBe(visits);
  expect(await o.host.update({workspaces: o.workspaces, documents: [o.other]})).toEqual([]);
  expect(o.unloaded()).toBe(1); expect(o.host.holds(o.sibling)).toBe(false);
});
