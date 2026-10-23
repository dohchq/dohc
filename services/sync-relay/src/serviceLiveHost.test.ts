import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as Y from "yjs";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment.js";
import { startServiceLiveHost, deleteConfiguredServiceWorkspaceRoots, type ServiceWorkspace } from "./serviceLiveHost.js";
import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import {hasRelayWriteObservers, notifyRelayWrite, observeRelayWrites} from "./relayWriteChanges.js";
import {createNamedFrameChanges} from "./liveHostChanges.js";
import {captureOwnerLiveFrameHost} from "./namedLiveFrameHost.js";
import type {LiveHostConnectionCoordinate} from "./storage.js";
import {ServiceActivationDriver} from "./serviceActivationDriver.js";
import {liveEditors} from "./liveEditors.js";
import { OwnerCommittedDelivery } from "./ownerCommittedDelivery.js";
import type { NativeOwnerActivation } from "@dohc/workspace-engine-client/daemon";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { markdownToYDoc } from "../../../packages/ydoc-projection/src/import-export.js";
import { createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator } from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import { validateOrdinaryActivation } from "./storage/ordinaryActivationSource.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises",async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {...original,rm: vi.fn(original.rm)};
});
vi.mock("@dohc/workspace-engine-client/daemon", async importOriginal => ({
  ...await importOriginal<typeof import("@dohc/workspace-engine-client/daemon")>(), createEngineClient: spawn,
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {vi.unstubAllEnvs(); vi.mocked(rm).mockReset(); for (const close of cleanup.splice(0).reverse()) await close(); spawn.mockReset();});

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
  return { trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), ...deployment, root, config, configPath, save, closeStorage };
}
function clientFrom(options: { env: Record<string, string> }) {
  const nativePath = options.env.DOHC_ENGINE_LIVE_HOST_CONFIG!;
  const config = JSON.parse(readFileSync(nativePath, "utf8"));
  // It creates each hosted replica it is asked to, and answers anything else with its discovery.
  const client = { sendRequest: vi.fn(async (request?: {method: string}) => request?.method === "sync.createHostedReplica" ? {result: {hosted: true}} : ({
    result: { relayNamespace: config.relayNamespace, host: config.host,
      workspaces: config.workspaces.map((row: { workspaceId: string }) => ({ workspaceId: row.workspaceId, workspaceHandle: "actual-open-handle" })) } })),
    close: vi.fn(), waitForExit: vi.fn(async () => {}) };
  return { client, config, nativePath };
}

function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise,resolve};}

it("wakes served document and desktop listeners when service startup completes and the host closes", async () => {
  vi.stubEnv("DOHC_ENGINE_READER_CONFIG", "operator-reader");
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
    expect(spawn.mock.calls[0]![0].env.DOHC_ENGINE_READER_CONFIG).toBe("operator-reader");
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

// The engine's hosted replica replies, with fields a test can override.
const hostedPass = (overrides: Record<string, unknown> = {}) => ({fetched: 0, applied: 0, refused: 0, skipped: 0, conflictsOpened: 0, hasMore: false,
  pendingCursor: {kind: "hosted", token: "pending"}, changedPaths: [], refusals: [], sharingDeclined: [], held: [], departed: [], ...overrides});
const hostedCommit = (overrides: Record<string, unknown> = {}) => ({committed: true, hasMore: false, retirement: null, departed: [], sharingDeclined: [], ...overrides});
const pushReply = {status: "complete", hasMore: false, pushed: 0, sharingDeclined: [], ownerAdmissionPending: []};

it("gives the engine a configured hosted replica's relay without registering a partly activated live host", async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  const attachment = {relay: {baseUrl: "https://relay.example", bearerToken: "actual-service-credential"},
    identity: {replicationEpoch: "actual-epoch", streamIdentity: "actual-stream"}, maxPagesPerPull: 1};
  const adoption = {maxBytes: 1_000_000, maxEvents: 10, ownerOutbox: {maxPendingBytes: 1_000_000, maxPendingAgeMs: 60_000}};
  Object.assign(f.config, {adoption});
  Object.assign(f.config.workspaces[0]!, {hostedReplication: attachment}); await f.save();
  spawn.mockImplementation(async options => {captured = clientFrom(options); return captured.client;});
  const before = f.storage.getLiveHostControl();
  const host = await startServiceLiveHost(f);
  try {
    expect(captured.config.workspaces[0]).toEqual({root: f.config.workspaces[0]!.root, workspaceId: "workspace", maxRegistrations: 8, relay: attachment.relay});
    expect(captured.config.workspaces[0]).not.toHaveProperty("hostedReplication");
    expect(captured.config.adoption).toEqual(adoption);
    expect(f.storage.getLiveHostControl()).toEqual(before);
    expect(f.storage.getLiveHostControl()?.registeredConnectionId).toBeNull();
    await expect(host.drain({workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64)})).rejects.toThrow("retired");
    expect(captured.client.sendRequest).toHaveBeenCalledTimes(1);
  } finally { await host.close(); }
  expect(f.storage.getLiveHostControl()).toEqual(before);
});

it("refuses a configured replica of any other kind before spawning", async () => {
  const f = await fixture();
  Object.assign(f.config.workspaces[0]!, {ordinaryReplication: {relay: {baseUrl: "https://relay.example", bearerToken: "owner"},
    identity: {kind: "join", replicationEpoch: "epoch", streamIdentity: "stream"}, maxPagesPerPull: 1}}); await f.save();
  await expect(startServiceLiveHost(f)).rejects.toThrow("Invalid service host configuration.");
  expect(spawn).not.toHaveBeenCalled();
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
  Object.assign(f.config.workspaces[0]!,{hostedReplication:{relay:{baseUrl:"https://relay.example",bearerToken:"service-token"},
    identity:{replicationEpoch:"epoch",streamIdentity:"stream"},maxPagesPerPull:1}});
  Object.assign(f.config,{adoption:{maxBytes:1_000_000,maxEvents:10,ownerOutbox:{maxPendingBytes:1_000_000,maxPendingAgeMs:60_000}},
    sync:{policy:{maxReadBytes:1_000_000,maxOutputBytes:1_000_000,maxClientVectorBytes:1000,maxHostVectorBytes:1000},workingReserveBytes:1_000_000},
    activation:{targets:[{workspaceId:"workspace",path:"file.md",shareId:"share"}],maxCaptureBytes:1_000_000,
      maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000,maxDocumentsPerPass:1,pollIntervalMs:60_000,passDeadlineMs:1000,
      idleUnloadMs:600_000,idleRetryMs:30_000,
      validation:{maxStructVisits:1000,maxValueNodeVisits:1000,maxDecodedPayloadByteVisits:1000,maxStructClientGroupVisits:1000,
        maxDeleteClientGroupVisits:1000,maxDeleteIntervalVisits:1000,maxIndexOperations:1000},...limits}});
  await f.save();
}

it("runs a bounded hosted pull in the configured activation lifecycle and closes its pass",async()=>{
  const f=await fixture();let captured!:ReturnType<typeof clientFrom>;
  await configureActivation(f);
  spawn.mockImplementation(async options=>{
    captured=clientFrom(options);const discovery=captured.client.sendRequest.getMockImplementation()!;
    captured.client.sendRequest.mockImplementation(async(...args:unknown[])=>{
      const request=args[0] as {method:string};
      if(request.method==="liveApplication.hosts")return discovery();
      if(request.method==="sync.createHostedReplica")return {result:{hosted:true}} as never;
      if(request.method==="sync.materializePendingCursor")return {result:{materialized:true}} as never;
      if(request.method==="sync.commitCursor")return {result:hostedCommit({hasMore:true})} as never;
      return {result:hostedPass({hasMore:true,fetched:1,applied:1})} as never;
    });return captured.client;
  });
  const host=await startServiceLiveHost(f);
  await vi.waitFor(()=>expect(captured.client.sendRequest).toHaveBeenCalledWith(expect.objectContaining({method:"sync.commitCursor"}),expect.any(AbortSignal)));
  // One page per pull: the pass stops at the page boundary and does not capture.
  expect(captured.client.sendRequest.mock.calls.filter(call=>((call as unknown[])[0] as {method:string}).method==="sync.pullHosted")).toHaveLength(1);
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
async function completedServiceOwner(options: {empty?: boolean; frameChanges?: boolean; polling?: boolean} = {}) {
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
  await store.prepare({capture, host: earlier, shareId: "share", registeredAtMs: 3, guard() {}, validate: async work => validateOrdinaryActivation(work, policy),
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
  // An empty host activates documents it gains on its next pass. It and a polling host pass every 20 ms.
  await configureActivation(f, {targets: options.empty ? [] : [target], passDeadlineMs: 10_000, validation: policy,
    ...(options.empty || options.polling ? {pollIntervalMs: 20} : {})});
  // An empty host receives this workspace and document through `update`.
  const workspace = f.config.workspaces[0]! as ServiceWorkspace;
  if (options.empty) {f.config.workspaces = []; await f.save();}

  let parked: {method: string; entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>>} | undefined;
  // Queued unload replies, or errors that lose them. `replies` overrides every hosted pass, commit and push until a test changes it.
  const pushed = deferred<void>(), unloads: unknown[] = [];
  // `diverge` refuses each pull as diverged. `create` fails each create, as diverged when a relay is ahead at the replica's origin.
  const replies: {pass: Record<string, unknown>; commit: Record<string, unknown>; push: Record<string, unknown>; diverge?: boolean;
    create?: "diverged" | Error} = {pass: {}, commit: {}, push: {}};
  const divergence = (id: number) => new EngineRequestError(id, {code: "INVALID_PARAMS", message: "relay-origin-diverged", retry: "no"} as never);
  // What the engine applied of each accepted row, by delivery ID. `lost` loses each application's
  // reply and every ACK read after it, as when the engine applied a row the relay never recorded.
  // While `pending` is set, the engine answers each application pending and applies nothing.
  const applied = new Map<string, Record<string, unknown>>(), lost = {replies: false, pending: false};
  // Once set, each registration gets a new ID and retires the one before it, as the engine does.
  let registrations: {next: number; live: number} | undefined, registrationRefusal: Error | undefined;
  const retired = (id: unknown) => registrations !== undefined && id !== registrations.live;
  const unavailable = (id: number) => new EngineRequestError(id, {code: "INVALID_PARAMS", message: "live-registration-unavailable", retry: "no"} as never);
  // Whether the engine's settlement reaches the file. Until it does, the same terminal settles again.
  const settlement = {materialized: true};
  const membership: {method: string; workspace?: string; params: unknown}[] = [];
  let ownerRequests = 0, client!: ReturnType<typeof clientFrom>["client"] & {captureOwnerActivation: ReturnType<typeof vi.fn>;
    sendLiveApplication: ReturnType<typeof vi.fn>; readLiveApplicationAck: ReturnType<typeof vi.fn>};
  // The engine's reason for refusing native capture, as for a document with an open sync conflict.
  let refusal: Error | undefined, detachFailure: Error | undefined;
  spawn.mockImplementation(async options => {
    const captured = clientFrom(options), discovery = captured.client.sendRequest.getMockImplementation()!;
    client = Object.assign(captured.client, {captureOwnerActivation: vi.fn(async () => {if (refusal) throw refusal; return capture;}),
      sendLiveApplication: vi.fn(async (input: {id: number; registrationId: number}, event: {metadata: {accepted: {receipt: {deliveryId: string; journalCursor: number}}}}) => {
        if (retired(input.registrationId)) throw unavailable(input.id);
        const receipt = event.metadata.accepted.receipt;
        if (lost.pending) return {id: input.id, result: {status: "pending", reason: "application-pending"}};
        applied.set(receipt.deliveryId, {...receipt, localYDocSequence: receipt.journalCursor + 1});
        if (lost.replies) throw new Error("Application reply lost.");
        return {id: input.id, result: {status: "applied", ack: {...applied.get(receipt.deliveryId), applicationReplayed: false}}};
      }),
      readLiveApplicationAck: vi.fn(async (input: {id: number; registrationId: number}, identity: {deliveryId: string}) => {
        if (retired(input.registrationId)) throw unavailable(input.id);
        if (lost.replies) throw new Error("ACK read lost.");
        const ack = applied.get(identity.deliveryId);
        return ack ? {...ack, applicationReplayed: true} : null;
      })});
    client.sendRequest.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as {id: number; method: string; workspace?: string; params: Record<string, unknown>}, held = parked;
      if (request.method.startsWith("liveApplication.")) ownerRequests++;
      if (held?.method === request.method) { parked = undefined; held.entered.resolve(); await held.release.promise; }
      const reply = (result: unknown) => ({id: request.id, result}) as never;
      if (request.method !== "liveApplication.register" && retired(request.params?.registrationId ?? registrations?.live)) throw unavailable(request.id);
      if (/^liveApplication\.(attach|detach|unload)/.test(request.method)) membership.push({method: request.method, workspace: request.workspace, params: request.params});
      switch (request.method) {
        case "liveApplication.hosts": return discovery();
        case "liveApplication.attachWorkspace": return reply({workspaceId: request.params.workspaceId,
          workspaceHandle: request.params.workspaceId === "workspace" ? "attached-handle" : `attached-${request.params.workspaceId}`});
        case "liveApplication.detachWorkspace": if (detachFailure) throw detachFailure; return reply({detached: true});
        case "liveApplication.unloadDocument": {
          const next = unloads.shift() ?? {status: "unloaded"};
          if (next instanceof Error) throw next;
          return reply(next);
        }
        // Native registration accepts exactly the binding.
        case "liveApplication.register":
          if (Object.keys(request.params).join() !== "binding") throw new Error("INVALID_PARAMS: invalid-live-registration");
          if (registrationRefusal) throw registrationRefusal;
          if (!registrations) return reply({registrationId: 7});
          registrations.live = ++registrations.next;
          return reply({registrationId: registrations.live});
        case "liveApplication.ownerState": return reply({adoptionId: capture.activationId, expectedLocalSequence: 2, throughCursor: 0,
          outboxId: null, pendingBytes: 0, outboxState: "active"});
        case "liveApplication.settle": {
          const terminal = request.params.terminalReceipt as {journalCursor: number} | null;
          return reply({status: "settled", settlement: {settlementId: "settlement", previousCursor: 0, terminalCursor: terminal?.journalCursor ?? 0,
            applicationCount: 0, localYDocSequence: 2, momentId: "settled-moment", markdownDigest: "c".repeat(64), materialized: settlement.materialized,
            collectionReconcileRequired: false}});
        }
        case "liveApplication.fenceRestore": return reply({status: "pending", reason: "native-fence-pending"});
        case "sync.createHostedReplica":
          if (replies.create) throw replies.create === "diverged" ? divergence(request.id) : replies.create;
          return reply({hosted: true});
        case "sync.push": pushed.resolve(); return reply({...pushReply, ...replies.push});
        case "sync.pullHosted":
          if (replies.diverge) throw divergence(request.id);
          return reply(hostedPass(replies.pass));
        case "sync.materializePendingCursor": return reply({materialized: true});
        case "sync.commitCursor": return reply(hostedCommit(replies.commit));
      }
      throw new Error(`Unexpected engine request ${request.method}.`);
    });
    return client;
  });
  // An owner live edit, prepared under the current binding. Calling the result commits it as the host's submit does.
  const prepareEdit = (value: string, coordinate: LiveHostConnectionCoordinate) => {
    const live = f.storage.resolveCurrentLiveDocumentBinding({document, actor}), read = f.storage.readLiveUpdateJournalCut({document});
    if (live.kind !== "current" || read.kind !== "cut") throw new Error("Missing live authority.");
    const doc = new Y.Doc(), suffix = read.cut.suffix.map(row => row.bytes);
    for (const bytes of [read.cut.checkpoint.bytes, ...suffix]) Y.applyUpdate(doc, bytes);
    const vector = Y.encodeStateVector(doc); doc.getMap("frontmatter").set("edit", value);
    const updateBytes = Buffer.from(Y.encodeStateAsUpdate(doc, vector)); doc.destroy();
    const validation = validateJournal({document, currentPath: live.binding.currentPath, checkpoint: read.cut.checkpoint.bytes, suffix, candidate: updateBytes});
    return () => f.storage.commitLiveUpdateJournal({host: coordinate, actor, expectedAuthority: live.authority,
      metadata: {deliveryId: `edit-${value}`, updateDigest: sha256(updateBytes), binding: live.binding}, cutToken: read.cut, validation, updateBytes, receivedAtMs: 5});
  };
  const host = await startServiceLiveHost({...f, ...(options.frameChanges ? {frameChanges: createNamedFrameChanges(16)} : {})});
  cleanup.push(() => host.close());
  // The activation pass publishes readiness before it pushes the hosted replica.
  if (!options.empty) await pushed.promise;
  return {f, raw, host, document, workspace, target, pushed, unloads, replies, settlement, membership, spawned: () => spawn.mock.calls.length, client: () => client,
    ownerRequests: () => ownerRequests,
    ownerCalls: () => client.sendRequest.mock.calls.map(call => (call as unknown[])[0] as {method: string; params: unknown})
      .filter(request => request.method.startsWith("liveApplication.")).map(request => [request.method, request.params]),
    refuseCapture(error: Error | undefined) {refusal = error;},
    refuseRegistration(error: Error | undefined) {registrationRefusal = error;},
    failDetach(error: Error | undefined) {detachFailure = error;},
    applied, lost,
    freshRegistrations() {registrations = {next: 100, live: 0};},
    liveRegistration: () => registrations?.live,
    validateJournal,
    prepareEdit: (value: string) => prepareEdit(value, host.coordinate),
    // An owner live edit the relay accepts under the running host, as the host's submit commits it.
    acceptEdit(value: string, coordinate = host.coordinate) {
      const committed = prepareEdit(value, coordinate)();
      if (committed.result.kind !== "accepted") throw new Error(`Live edit was not accepted: ${JSON.stringify(committed.result)}`);
      return committed.result.receipt;
    },
    // The relay's owner delivery tip for the document.
    tip: () => JSON.parse(String(raw.prepare("SELECT tip_receipt_json FROM sync_relay_live_delivery_owners WHERE object_id='object'").get()!.tip_receipt_json)),
    // Starts a new host on the same relay. Its first pass captures and, while capture is refused, leaves no owner.
    async restart() {
      await host.close();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      cleanup.push(async () => log.mockRestore());
      const restarted = await startServiceLiveHost(f);
      cleanup.push(() => restarted.close());
      await vi.waitFor(() => expect(client.captureOwnerActivation).toHaveBeenCalled());
      return restarted;
    },
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

const stopLookup = {operationId: "restore", workspaceId: "workspace", ownerUserId: "owner"};
const conflictOpen = () => new EngineRequestError(1, {code: "INVALID_PARAMS", message: "ydoc-conflict-open", retry: "no"} as never);
// The engine's refusals of a capture: a hosted document that is not ready, and a retained activation that diverged or its store never held.
const unready = () => new EngineRequestError(1, {code: "CONFLICT", message: "hosted-document-unready", retry: "no"} as never);
const diverged = () => new EngineRequestError(1, {code: "CONFLICT", message: "live-application-conflict", retry: "no"} as never);
// A first capture of a document with no Y.Doc lineage.
const withoutLineage = () => new EngineRequestError(1, {code: "CONFLICT", message: "live-document-without-lineage", retry: "no"} as never);
// Appends a relay row naming the document, as another device's push does.
const appendDocumentRow = (raw: InstanceType<typeof DatabaseSync>, opKind: "moment.append" | "ydoc.update", objectId: string) => {
  raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms)
    SELECT 'workspace','device',COUNT(*)+1,?,?,0 FROM sync_relay_log WHERE origin_id='device'`).run(opKind, JSON.stringify({versionId: "main", objectId,
    path: "docs/a.md", contentKind: "richdoc", isBaseState: true, lineageClaimId: "d".repeat(64), updateBlobSha256: "d".repeat(64)}));
};

// Proves: after a restart, restore steps that send no registration never load
// the native session, so an open sync conflict cannot block them.
it("continues an applied stop cut and reviews its proposal after a restart while the document has an open sync conflict", async () => {
  const o = await completedServiceOwner();
  o.restore();
  // The activated owner registers and applies the old cut; this engine leaves the native fence pending.
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  o.refuseCapture(conflictOpen());
  const host = await o.restart(), captures = o.client().captureOwnerActivation.mock.calls.length, sent = o.ownerCalls().length;
  await expect(host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  expect(o.ownerCalls().slice(sent).map(([method]) => method)).toEqual(["liveApplication.fenceRestore", "liveApplication.fenceRestore"]);
  const review = {review: "retained proposal"} as never;
  const reviewed = vi.spyOn(OwnerCommittedDelivery.prototype, "reviewRestore").mockResolvedValue(review);
  try {
    await expect(host.reviewRestore(stopLookup)).resolves.toBe(review);
    expect(reviewed).toHaveBeenCalledOnce();
  } finally {reviewed.mockRestore();}
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures);
});

// Proves: after a restart, a stop that registers its old cut reloads the
// retained activation first, fails with the engine's reason when capture is
// refused, and otherwise registers native with the stop's binding alone.
it("reloads the retained activation after a restart only for a stop that registers", async () => {
  const o = await completedServiceOwner();
  const current = o.f.storage.resolveCurrentLiveDocumentBinding({document: o.document, actor: {kind: "owner", userId: "owner", shareId: "share"}});
  if (current.kind !== "current") throw new Error("Missing live binding.");
  o.refuseCapture(conflictOpen());
  const host = await o.restart(), captures = o.client().captureOwnerActivation.mock.calls.length, sent = o.ownerCalls().length;
  o.restore();
  await expect(host.stopRestore(stopLookup)).rejects.toThrow("ydoc-conflict-open");
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  expect(o.ownerCalls().slice(sent)).toEqual([]);
  o.refuseCapture(undefined);
  await expect(host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  expect(o.client().captureOwnerActivation).toHaveBeenCalledTimes(captures + 2);
  expect(o.client().captureOwnerActivation).toHaveBeenLastCalledWith(expect.anything(), "docs/a.md", 1_000_000, expect.any(AbortSignal), `ordinary-activation-${"a".repeat(64)}`);
  expect(o.ownerCalls().slice(sent)).toEqual([
    ["liveApplication.register", {binding: current.binding}],
    ["liveApplication.ownerState", {registrationId: 7, sessionId: "native-session"}],
    ["liveApplication.fenceRestore", expect.anything()],
    ["liveApplication.fenceRestore", expect.anything()],
  ]);
});

const engineMethods = (client: {sendRequest: {mock: {calls: unknown[][]}}}) => client.sendRequest.mock.calls.map(call => (call[0] as {method: string}).method);

// Proves: a configured host that restarts checks its replica's origin before a
// restore reaches its store. While the check fails, startup and each pass
// retry it, and a restore is refused with no capture, application or
// settlement. Once a pass's check succeeds, the restore proceeds.
it("refuses a restore after a configured restart until its replica checked its origin", async () => {
  const o = await completedServiceOwner({polling: true});
  await o.host.close();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(async () => log.mockRestore());
  o.replies.create = new Error("Relay unreachable.");
  const restarted = await startServiceLiveHost(o.f);
  cleanup.push(() => restarted.close());
  const creates = () => engineMethods(o.client()).filter(method => method === "sync.createHostedReplica").length;
  await vi.waitFor(() => expect(creates()).toBeGreaterThan(2));
  o.restore();
  await expect(restarted.stopRestore(stopLookup)).rejects.toThrow("Service restore source is unavailable.");
  expect(new Set(engineMethods(o.client()))).toEqual(new Set(["liveApplication.hosts", "sync.createHostedReplica"]));
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(o.client().sendLiveApplication).not.toHaveBeenCalled();
  o.replies.create = undefined;
  await vi.waitFor(() => expect(o.client().captureOwnerActivation).toHaveBeenCalled());
  const methods = engineMethods(o.client()), checked = methods.lastIndexOf("sync.createHostedReplica");
  expect(methods.slice(0, checked).every(method => method === "liveApplication.hosts" || method === "sync.createHostedReplica")).toBe(true);
  expect(o.client().sendRequest.mock.invocationCallOrder[checked]).toBeLessThan(o.client().captureOwnerActivation.mock.invocationCallOrder[0]!);
  await expect(restarted.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
});

// Proves: a configured host that restarts against a relay ahead at its
// replica's origin detaches the workspace as diverged before startup returns,
// so a restore finds no workspace and nothing reaches its store.
it("detaches a configured workspace as diverged at restart before a restore reaches its store", async () => {
  const o = await completedServiceOwner();
  await o.host.close();
  o.replies.create = "diverged";
  const restarted = await startServiceLiveHost(o.f);
  cleanup.push(() => restarted.close());
  const sent = ["liveApplication.hosts", "sync.createHostedReplica", "liveApplication.detachWorkspace"];
  expect(restarted.diverged()).toEqual([{workspaceId: "workspace", root: o.workspace.root}]);
  expect(engineMethods(o.client())).toEqual(sent);
  o.restore();
  await expect(restarted.stopRestore(stopLookup)).rejects.toThrow("Workspace is not configured on this service host.");
  expect(engineMethods(o.client())).toEqual(sent);
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(o.client().sendLiveApplication).not.toHaveBeenCalled();
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
    maxRegistrations: 8, relay: {baseUrl: "https://relay.example", bearerToken: "service-token"}}};
  const detach = {method: "liveApplication.detachWorkspace", workspace: "attached-handle", params: {}};
  // The workspace's pulls so far, for waiting on the next one.
  const pullCount = () => o.client().sendRequest.mock.calls.filter(call => ((call as unknown[])[0] as {method: string}).method === "sync.pullHosted").length;
  return {...o, sibling, other, attach, detach, pullCount, unload: {method: "liveApplication.unloadDocument", workspace: "attached-handle", params: {objectId: other.objectId}},
    async nextPull() {const seen = pullCount(); await vi.waitFor(() => expect(pullCount()).toBeGreaterThan(seen + 1));}};
}
const stay = {departing: []};

it("adds documents on one daemon and unloads one that left while the sibling document stays ready", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await o.pushed.promise;
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(o.host.settled(o.sibling)).toBe(true);
  expect(o.membership).toEqual([o.attach]);
  await o.host.update({workspaces, documents: [o.sibling, o.other], ...stay});
  expect(o.host.retains(o.other)).toBe(true); expect(o.host.settled(o.other)).toBe(false);
  // The engine still holds unsettled work for the document that left, so passes retry its unload.
  o.unloads.push({status: "pending", reason: "settlement-pending"});
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.update({workspaces, documents: [o.sibling], departing: [o.other]});
  await vi.waitFor(() => expect(o.membership).toEqual([o.attach, o.unload, o.unload]));
  expect(log).toHaveBeenCalledWith("Service activation pass failed.", "Departing live document is waiting: settlement-pending");
  // A pull that started after it departed confirms it gone.
  await vi.waitFor(() => expect(o.host.retains(o.other)).toBe(false));
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
  expect(o.spawned()).toBe(1); expect(o.client().close).not.toHaveBeenCalled();
  expect(o.f.storage.getLiveHostControl()?.registeredConnectionId).toBe(o.host.coordinate.connectionId);
});

it("detaches a workspace that is no longer wanted at once and attaches it again on the same daemon", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  await o.host.update({workspaces: [], documents: [], ...stay});
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  expect(o.membership).toEqual([o.attach, o.detach]);
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(o.membership).toEqual([o.attach, o.detach, o.attach]);
  expect(o.spawned()).toBe(1); expect(o.client().close).not.toHaveBeenCalled();
});

// Proves: a workspace whose last document left stays attached until the
// document unloaded and a later pull found nothing departed. Only then may it
// detach, and its document is retained until that pull.
it("keeps a workspace with no documents attached until its replica drains, then detaches it on request", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  o.unloads.push({status: "pending", reason: "settlement-pending"});
  o.replies.commit = {departed: [o.sibling.objectId]};
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.update({workspaces, documents: [], departing: [o.sibling]});
  await vi.waitFor(() => expect(o.membership.filter(row => row.method === "liveApplication.unloadDocument")).toHaveLength(2));
  // Its settled output was published right before each unload.
  const methods = o.client().sendRequest.mock.calls.map(call => ((call as unknown[])[0] as {method: string}).method);
  for (const [index, method] of methods.entries()) if (method === "liveApplication.unloadDocument") expect(methods[index - 1]).toBe("sync.push");
  await o.nextPull();
  // Its replica still lists it, so nothing lets go.
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.drained("workspace")).toBe(false);
  await expect(o.host.detachDrained("workspace")).resolves.toBe(false);
  expect(o.host.automationLedger("workspace")).not.toBeNull();
  o.replies.commit = {};
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.host.retains(o.sibling)).toBe(false);
  await expect(o.host.detachDrained("workspace")).resolves.toBe(true);
  expect(o.membership.at(-1)).toEqual(o.detach);
  expect(o.host.automationLedger("workspace")).toBeNull();
  expect(o.spawned()).toBe(1); expect(o.client().close).not.toHaveBeenCalled();
});

// An empty host with the document shared with Edit, enrolled and ready.
async function enrolledServiceHost({freshRegistrations = false, frameChanges = false} = {}) {
  const o = await emptyServiceHost({frameChanges});
  if (freshRegistrations) o.freshRegistrations();
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 10, guard() {}});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const binding = o.f.storage.resolveCurrentLiveDocumentBinding({document: o.document, actor: {kind: "owner", userId: "owner", shareId: "share"}});
  if (binding.kind !== "current") throw new Error("Missing live binding.");
  const calls = (from: number) => o.ownerCalls().slice(from).map(([method]) => method as string);
  return {...o, binding: binding.binding, calls,
    // The owner's Stop, which fences the document at once.
    stop() {
      expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path,
        enabled: false, retire: true, nowMs: 20, guard() {}})).toMatchObject({enabled: false, retired: true});
    },
    depart: (host = o.host) => host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]})};
}

// Proves: Stop ends editing authority, not the host's duty to settle what it
// already applied. A stopped document registers its adoption's binding alone,
// settles through the tip the relay recorded, with no delivery or admission,
// then publishes and unloads. It stays while its unload answers pending, and
// settles again before it unloads again, so its workspace drains only once the
// engine unloads it. Its accepted cut stays.
it.each(["settlement-pending", "delivery-pending"])("settles a stopped last document and keeps it while its unload answers %s", async reason => {
  const o = await emptyServiceHost();
  // Passes apply the document's work, but none of their settlements reaches the file.
  o.settlement.materialized = false;
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 10, guard() {}});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const cut = o.f.storage.readLiveUpdateJournalCut({document: o.document});
  const current = o.f.storage.resolveCurrentLiveDocumentBinding({document: o.document, actor: {kind: "owner", userId: "owner", shareId: "share"}});
  if (current.kind !== "current") throw new Error("Missing live binding.");
  const generation = o.raw.prepare("SELECT restore_fence_generation FROM sync_relay_live_documents WHERE workspace_id='workspace' AND object_id='object' AND lineage_state='current'").get()!.restore_fence_generation as number;
  const stopped = o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path,
    enabled: false, retire: true, restoreFenceGeneration: generation, nowMs: 20, guard() {}});
  expect(stopped).toMatchObject({enabled: false, retired: true});
  // An unchanged update waits for the pass that was running at Stop.
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  const tip = o.tip();
  o.settlement.materialized = true;
  o.unloads.push({status: "pending", reason});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const sent = o.ownerCalls().length, first = o.park("liveApplication.unloadDocument");
  await o.host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]});
  await first.entered.promise;
  // It settled what the host applied and published that right before the unload.
  const methods = o.client().sendRequest.mock.calls.map(call => ((call as unknown[])[0] as {method: string}).method);
  expect(methods.slice(methods.lastIndexOf("liveApplication.settle"))).toEqual(["liveApplication.settle", "sync.push", "liveApplication.unloadDocument"]);
  const departure = [["liveApplication.register", {binding: current.binding}], ["liveApplication.settle", {registrationId: 7, terminalReceipt: tip}],
    ["liveApplication.unloadDocument", {objectId: "object"}]];
  expect(o.ownerCalls().slice(sent)).toEqual(departure);
  // The engine answers pending, so the document stays, and the next pass settles and unloads it again.
  const second = o.park("liveApplication.unloadDocument");
  let again = false;
  void second.entered.promise.then(() => {again = true;});
  first.release.resolve();
  await vi.waitFor(() => expect(again).toBe(true));
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.drained("workspace")).toBe(false);
  expect(o.ownerCalls().slice(sent)).toEqual([...departure, ...departure]);
  expect(o.client().sendLiveApplication).not.toHaveBeenCalled();
  second.release.resolve();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  await expect(o.host.detachDrained("workspace")).resolves.toBe(true);
  expect(o.host.automationLedger("workspace")).toBeNull();
  expect(o.membership.at(-1)).toEqual(o.detach);
  expect(o.f.storage.readLiveUpdateJournalCut({document: o.document})).toEqual(cut);
  expect(o.client().close).not.toHaveBeenCalled();
});

const departure = ["liveApplication.register", "liveApplication.settle", "liveApplication.unloadDocument"];
// The engine requests of a departure, without the membership a restarted daemon starts with.
const departed = (methods: string[]) => methods.filter(method => !["liveApplication.hosts", "liveApplication.attachWorkspace"].includes(method));

// Proves: an edit the engine applied but whose reply, and every ACK read after
// it, the relay lost before Stop settles. The departure reads the engine's
// ACK on its own registration, records it as the relay's tip and settles
// through it. It sends no application and reads no owner outbox.
it("records an edit whose application reply was lost before Stop, and settles through it", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.lost.replies = true;
  const edit = o.acceptEdit("lost");
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true));
  o.stop();
  o.lost.replies = false;
  // The update waits for any pass that was running, and the departure runs in the next.
  await o.depart();
  const applications = o.client().sendLiveApplication.mock.calls.length, sent = o.ownerCalls().length;
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.tip()).toEqual(edit);
  expect(o.calls(sent)).toEqual(departure);
  expect(o.ownerCalls()[sent + 1]).toEqual(["liveApplication.settle", {registrationId: 7, terminalReceipt: edit}]);
  expect(o.client().readLiveApplicationAck).toHaveBeenLastCalledWith(expect.objectContaining({registrationId: 7}), edit, expect.any(AbortSignal));
  expect(o.client().sendLiveApplication).toHaveBeenCalledTimes(applications);
});

// Proves: a row the relay accepted before Stop that the engine never applied
// stays unapplied: the departure finds no ACK for it, records nothing, and
// settles through the tip the relay already had.
it("leaves an accepted edit the engine never applied unapplied, and settles through the earlier tip", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const seed = o.tip();
  o.lost.pending = true;
  const edit = o.acceptEdit("unapplied");
  await vi.waitFor(() => expect(o.client().sendLiveApplication).toHaveBeenCalled());
  o.stop();
  await o.depart();
  const sent = o.ownerCalls().length;
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.applied.has(edit.deliveryId)).toBe(false);
  expect(o.client().readLiveApplicationAck).toHaveBeenLastCalledWith(expect.objectContaining({registrationId: 7}), edit, expect.any(AbortSignal));
  expect(o.tip()).toEqual(seed);
  expect(o.ownerCalls().slice(sent)).toEqual([["liveApplication.register", {binding: o.binding}],
    ["liveApplication.settle", {registrationId: 7, terminalReceipt: seed}], ["liveApplication.unloadDocument", {objectId: "object"}]]);
});

// Proves: a departed delivery needs neither live authority nor the connection
// that adopted it, only one with standing now. It records only the host's ACK
// of the next row the journal accepted, whole, under the same adoption and
// binding, and an ACK of the tip again changes nothing.
it("records a departed application only as the next accepted row, for its adoption, on a connection with standing", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const seed = o.tip();
  o.lost.replies = true;
  const edit = o.acceptEdit("stored");
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true));
  await o.host.close();
  o.stop();
  const register = (connectionId: string) => {
    const host = {...o.host.coordinate, connectionId};
    expect(o.f.storage.registerLiveHost({...host, updatedAtMs: Date.now(), guard: o.f.storage.captureStanding()}).ok).toBe(true);
    return host;
  };
  const host = register("departure"), store = o.f.storage.createLiveCommittedDeliveryStore(o.f.history);
  const input = {host, document: o.document, adoptionId: `ordinary-activation-${"a".repeat(64)}`};
  expect(store.departedOwnerDelivery(input)).toEqual({binding: o.binding, tip: seed, next: edit});
  const ack = {...edit, localYDocSequence: 3, applicationReplayed: true};
  const record = (value: unknown, overrides: Partial<typeof input & {binding: typeof o.binding}> = {}) =>
    () => store.recordDepartedApplication({...input, binding: o.binding, ...overrides}, value);
  const damaged = "Committed delivery evidence is damaged or conflicts.";
  for (const wrong of [{journalCursor: edit.journalCursor + 1}, {acceptingHostEpoch: edit.acceptingHostEpoch + 1}, {updateDigest: "f".repeat(64)}, {deliveryId: "another"}]) {
    expect(record({...ack, ...wrong})).toThrow(damaged);
  }
  expect(record(ack, {adoptionId: `ordinary-activation-${"b".repeat(64)}`})).toThrow(damaged);
  expect(record(ack, {binding: {...o.binding, restoreFenceGeneration: o.binding.restoreFenceGeneration + 1}})).toThrow(damaged);
  expect(record(ack, {host: {...host, connectionId: "another"}})).toThrow("Committed delivery stale-session.");
  expect(o.tip()).toEqual(seed);
  expect(record(ack)()).toEqual({binding: o.binding, tip: edit, next: null});
  expect(record(ack)()).toEqual({binding: o.binding, tip: edit, next: null});
  expect(record({...ack, localYDocSequence: 4})).toThrow(damaged);
  // The engine reports a receipt the journal never accepted.
  expect(record({...ack, deliveryId: "unaccepted", journalCursor: edit.journalCursor + 1})).toThrow(damaged);
  expect(o.tip()).toEqual(edit);
  // A replacement connection with standing continues the same adoption; the earlier one has none.
  const replacement = register("replacement");
  expect(store.departedOwnerDelivery({...input, host: replacement})).toEqual({binding: o.binding, tip: edit, next: null});
  expect(() => store.departedOwnerDelivery(input)).toThrow("Committed delivery stale-session.");
});

// Proves: a daemon that starts after Stop settles a stopped document it never
// loaded, from the relay's journal and the engine's record of what it applied,
// before it publishes and unloads it. It captures no session.
it("settles a document stopped while no daemon ran, which the daemon after it never loaded", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.lost.replies = true;
  const edit = o.acceptEdit("restart");
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true));
  await o.host.close();
  o.stop();
  o.lost.replies = false;
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  await o.depart(restarted);
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true));
  expect(o.tip()).toEqual(edit);
  expect(departed(o.calls(0))).toEqual(departure);
  expect(o.ownerCalls().find(([method]) => method === "liveApplication.settle")).toEqual(["liveApplication.settle", {registrationId: 7, terminalReceipt: edit}]);
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(o.client().sendLiveApplication).not.toHaveBeenCalled();
});

// Proves: deleting the share ends live authority as Stop does, though the
// enrollment stays enabled until its release. The document settles from
// durable state, on this daemon and on one started after it.
it.each([false, true])("settles a document whose share was deleted, after a restart: %s", async restart => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.lost.replies = true;
  const edit = o.acceptEdit("deleted");
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true));
  if (restart) await o.host.close();
  expect(o.f.storage.revokeShare("share", 30)).toBe(true);
  expect(o.f.storage.readServiceHostEnrollment("workspace", o.sibling.path)).toMatchObject({enabled: true, retired: false});
  expect(o.f.storage.serviceHostDocumentEnabled(o.sibling)).toBe(false);
  o.lost.replies = false;
  let host = o.host;
  if (restart) {
    host = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
    cleanup.push(() => host.close());
  }
  await o.depart(host);
  const applications = o.client().sendLiveApplication.mock.calls.length, sent = restart ? 0 : o.ownerCalls().length;
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true));
  expect(o.tip()).toEqual(edit);
  expect(departed(o.calls(sent))).toEqual(departure);
  expect(o.client().sendLiveApplication).toHaveBeenCalledTimes(applications);
});

// Proves: deleting the last Edit share cuts off admission at once, as Stop
// does, while the owner's frame session is open and a drain waits in the
// engine. The session's next frame, an owner edit prepared before the
// deletion, and the drain all admit nothing. The edit the host applied before
// it settles, the document leaves and its workspace drains.
it("admits nothing after the last Edit share is deleted while a drain waits, and settles what the host applied before", async () => {
  const o = await enrolledServiceHost({frameChanges: true});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const session = captureOwnerLiveFrameHost({authenticatedUserId: "owner", shareId: "share", storage: o.f.storage,
    native: await o.host.captureNative(o.binding), validate: o.validateJournal,
    bounds: {maxClientVectorBytes: 1_000, maxSyncOutputBytes: 10_000, maxAppliedUpdateBytes: 10_000, maxSubmissionBytes: 10_000, maxAdmissionBytes: 100_000}});
  const edit = o.acceptEdit("before");
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
  expect(o.tip()).toEqual(edit);
  const late = o.prepareEdit("after"), parked = o.park("liveApplication.ownerState"), held = o.host.drain(o.document);
  await parked.entered.promise;
  expect(o.f.storage.revokeShare("share", 30)).toBe(true);
  expect(late().result).toEqual({kind: "refused", reason: "authority-refused"});
  const frame = Buffer.from("frame");
  await expect(session.submit({deliveryId: "frame-after", updateDigest: sha256(frame), updateBytes: frame}, new AbortController().signal))
    .rejects.toThrow("Named host standing changed.");
  expect(session.invalidated.aborted).toBe(true);
  parked.release.resolve();
  await expect(held).rejects.toThrow("Service document activation is incomplete.");
  const cut = o.f.storage.readLiveUpdateJournalCut({document: o.document}), applications = o.client().sendLiveApplication.mock.calls.length;
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.tip()).toEqual(edit);
  expect(o.ownerCalls().filter(([method]) => method === "liveApplication.settle").at(-1)).toEqual(["liveApplication.settle", {registrationId: 7, terminalReceipt: edit}]);
  expect(o.f.storage.readLiveUpdateJournalCut({document: o.document})).toEqual(cut);
  expect(o.client().sendLiveApplication).toHaveBeenCalledTimes(applications);
});

// Proves: a departure that registered retires the owner's registration. When
// its owner resumes before the departure finishes, the owner registers again
// before it delivers, and the document becomes ready again.
it("registers the owner again when a stopped document resumes before its departure finished", async () => {
  const o = await enrolledServiceHost({freshRegistrations: true});
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.stop();
  // Its publication does not finish, so the departure waits after it settled.
  o.replies.push = {hasMore: true};
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(o.calls(sent).slice(0, 2)).toEqual(["liveApplication.register", "liveApplication.settle"]));
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  o.replies.push = {};
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 40, guard() {}});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
  // A departure reads no owner state, so the first read after Stop is the owner's, right after it registered again.
  const calls = o.ownerCalls(), resumed = calls.findIndex(([method], index) => index >= sent && method === "liveApplication.ownerState");
  expect(calls.slice(resumed - 1, resumed + 1)).toEqual([["liveApplication.register", {binding: o.binding}],
    ["liveApplication.ownerState", {registrationId: o.liveRegistration(), sessionId: "native-session"}]]);
  expect(o.membership.filter(row => row.method === "liveApplication.unloadDocument")).toEqual([]);
});

// Proves: the engine refuses to register a stopped document that already
// parked. Nothing settles or unloads, and the refusal alone releases nothing:
// the document is forgotten only once a pull that started after it no longer
// lists it departed. One its replica still lists departed tries again.
it("forgets a stopped document whose registration the engine refuses only once its replica confirms it parked", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.close();
  o.stop();
  o.refuseRegistration(unready());
  o.replies.commit = {departed: [o.sibling.objectId]};
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  const registered = () => o.calls(0).filter(method => method === "liveApplication.register").length;
  await o.depart(restarted);
  // Its replica still lists it departed, so it tries again, each time after a pull that started after its last try, and stays retained.
  await vi.waitFor(() => expect(registered()).toBeGreaterThan(1));
  expect(registered()).toBeLessThanOrEqual(o.pullCount() + 1);
  expect(restarted.retains(o.sibling)).toBe(true);
  expect(restarted.drained("workspace")).toBe(false);
  o.replies.commit = {};
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true));
  expect(restarted.retains(o.sibling)).toBe(false);
  const tries = registered();
  await o.nextPull();
  expect(registered()).toBe(tries);
  expect(departed(o.calls(0)).filter(method => method !== "liveApplication.register")).toEqual([]);
});

// Proves: a departing document fails closed when its binding no longer holds:
// a restore generation no resumed restore accounts for, or an engine that
// refuses the binding. It never settles or unloads, stays retained, and its
// workspace does not drain. The failure is reported.
it.each(["generation", "engine"] as const)("keeps a stopped document whose binding is refused by the %s", async refusal => {
  const o = await enrolledServiceHost();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  o.stop();
  if (refusal === "generation") o.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1 WHERE object_id='object'");
  else o.refuseRegistration(diverged());
  const sent = o.ownerCalls().length, failures = () => log.mock.calls.filter(([message]) => message === "Service activation pass failed.").length;
  await o.depart();
  // Each pass tries it again.
  if (refusal === "engine") await vi.waitFor(() => expect(o.calls(sent).length).toBeGreaterThan(2));
  else {await vi.waitFor(() => expect(failures()).toBeGreaterThan(0)); await o.nextPull();}
  expect(o.calls(sent).filter(method => method !== "liveApplication.register")).toEqual([]);
  if (refusal === "generation") expect(o.calls(sent)).toEqual([]);
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.drained("workspace")).toBe(false);
  expect(failures()).toBeGreaterThan(0);
});

// Proves: release waits for retirement, which includes removing the file. A
// retirement that fails keeps the document listed, a restarted daemon learns
// that only from its own pull, and the document is released only once a
// retry removes it.
it("retains a departed document through a failed file removal and a restart until its retirement succeeds", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], left = {workspaceId: "workspace", objectId: "object-left", path: "docs/left.md", shareId: "share"};
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  await o.nextPull();
  await o.host.update({workspaces, documents: [o.sibling], departing: [left]});
  // Earlier pulls found nothing departed, but none started after it departed.
  expect(o.host.retains(left)).toBe(true);
  o.replies.commit = {departed: [left.objectId], retirement: {code: "IO", message: "retired file could not be removed", retry: "afterBackoff"}};
  await o.nextPull();
  expect(o.host.retains(left)).toBe(true);
  await o.host.close();
  // A restarted daemon has read nothing yet.
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  await restarted.update({workspaces, documents: [o.sibling], departing: [left]});
  expect(restarted.retains(left)).toBe(true);
  await o.nextPull();
  expect(restarted.retains(left)).toBe(true);
  o.replies.commit = {};
  await vi.waitFor(() => expect(restarted.retains(left)).toBe(false));
  expect(restarted.retains(o.sibling)).toBe(true);
});

// Proves: a page that leaves a document held clears its readiness at once,
// without holding back the workspace's pulls, until a later capture succeeds.
it("clears a held document's readiness until its next capture succeeds", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  o.refuseCapture(unready());
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.replies.pass = {held: [{objectId: o.sibling.objectId, reason: "hosted-backfill-work-waiting"}]};
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(false));
  // Pulls go on, and the document waits: every pass captures it again while the engine holds it.
  await vi.waitFor(() => expect(o.client().captureOwnerActivation.mock.calls.length).toBeGreaterThan(captures + 2));
  await o.nextPull();
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  o.replies.pass = {};
  o.refuseCapture(undefined);
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
});

// A host on the same relay and engine as the empty host, started after it closed.
async function restartEmpty(o: Awaited<ReturnType<typeof emptyServiceHost>>) {
  await o.host.close();
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  const requests = () => o.client().sendRequest.mock.calls.map(call => (call as unknown[])[0] as {method: string});
  const count = (method: string) => requests().filter(request => request.method === method).length;
  return {restarted, requests, count};
}

// Proves: after a restart while the engine holds a document, its catch-up pull
// marks it held before it has an owner, so its workspace keeps pushing and
// pulling, which bring what it waits for, until its capture succeeds.
it("keeps pushing and pulling after a restart while the engine holds a document, until its capture succeeds", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  o.replies.pass = {held: [{objectId: o.sibling.objectId, reason: "hosted-backfill-work-waiting"}]};
  const {restarted, count} = await restartEmpty(o);
  await restarted.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => {expect(count("sync.push")).toBeGreaterThan(2); expect(count("sync.pullHosted")).toBeGreaterThan(2);});
  expect(o.client().captureOwnerActivation).toHaveBeenCalled();
  expect(restarted.isDocumentReady(o.document)).toBe(false);
  o.replies.pass = {};
  o.refuseCapture(undefined);
  await vi.waitFor(() => expect(restarted.isDocumentReady(o.document)).toBe(true));
  await expect(restarted.drain(o.document)).resolves.toMatchObject({kind: "done"});
});

// Proves: a fresh daemon resumes a departing document an earlier one left,
// before any pull adopts the scope it left, even one a sibling's activation
// would make, then settles, publishes and unloads it. Its replica then drains.
it("resumes a departing document after a restart before any pull, then settles, publishes and unloads it", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  // The sibling has no owner after the restart, so its activation pulls first.
  const activate = vi.mocked(ServiceActivationDriver.prototype.activate), through = activate.getMockImplementation()!;
  activate.mockImplementation(function (this: ServiceActivationDriver, ...args) {
    if (args[0].path !== o.other.path) return through.apply(this, args);
    return this.options.workspace("workspace")!.replica.pull(args[1]).then(() => ({kind: "pending" as const, reason: "held"}));
  });
  const {restarted, requests} = await restartEmpty(o);
  await restarted.update({workspaces, documents: [o.other], departing: [o.sibling]});
  await vi.waitFor(() => expect(o.membership.filter(row => row.method === "liveApplication.unloadDocument")).toHaveLength(1));
  const capture = o.client().captureOwnerActivation;
  expect(capture).toHaveBeenCalledWith(expect.anything(), "docs/a.md", 1_000_000, expect.any(AbortSignal), `ordinary-activation-${"a".repeat(64)}`);
  const methods = requests().map(request => request.method), at = (index: number) => o.client().sendRequest.mock.invocationCallOrder[index]!;
  const pulled = methods.indexOf("sync.pullHosted"), settled = methods.indexOf("liveApplication.settle");
  expect(pulled === -1 || at(pulled) > capture.mock.invocationCallOrder[0]!).toBe(true);
  expect(settled).toBeGreaterThan(-1);
  expect(methods.indexOf("sync.push", settled)).toBeGreaterThan(settled);
  expect(methods.indexOf("liveApplication.unloadDocument")).toBeGreaterThan(methods.indexOf("sync.push", settled));
  await vi.waitFor(() => expect(restarted.retains(o.sibling)).toBe(false));
});

// Proves: a restarted daemon checks its replica's origin before any work on
// its store. A relay ahead there detaches the workspace for good before a
// departing document, stopped or retained, registers, captures, applies or
// settles, and before any pull.
it.each([
  ["stopped", async () => {const o = await enrolledServiceHost(); await o.host.close(); o.stop(); return o;}],
  ["retained", async () => {
    const o = await emptyServiceHost();
    await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
    await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
    await o.host.close();
    return o;
  }],
] as const)("checks a restarted replica's origin before a %s departing document resumes", async (_kind, setup) => {
  const o = await setup();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const settles = vi.spyOn(ServiceActivationDriver.prototype, "settleDeparted");
  o.replies.create = "diverged";
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  const update = () => restarted.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]});
  const methods = () => o.client().sendRequest.mock.calls.map(call => ((call as unknown[])[0] as {method: string}).method);
  const sent = ["liveApplication.hosts", "liveApplication.attachWorkspace", "sync.createHostedReplica", "liveApplication.detachWorkspace"];
  await update();
  await vi.waitFor(() => expect(restarted.diverged()).toEqual([{workspaceId: "workspace", root: o.workspace.root}]));
  expect(methods()).toEqual(sent);
  // A later update, and any pass before it, leave the store alone.
  await update();
  expect(methods()).toEqual(sent);
  expect(settles).not.toHaveBeenCalled();
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(o.client().sendLiveApplication).not.toHaveBeenCalled();
  expect(restarted.retains(o.sibling)).toBe(true);
});

// Proves: a replica that could not check its origin detaches its workspace
// before any work on its store, and the next update attaches it and checks again.
it("detaches a workspace whose replica could not check its origin, and attaches it again on the next update", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  o.replies.create = new Error("Relay unreachable.");
  await expect(o.host.update({workspaces, documents: [o.sibling], ...stay})).rejects.toThrow("Relay unreachable.");
  expect(o.membership).toEqual([o.attach, o.detach]);
  expect(o.host.diverged()).toEqual([]);
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  o.replies.create = undefined;
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(o.membership).toEqual([o.attach, o.detach, o.attach]);
});

// Proves: a departing document whose retained activation diverged keeps its
// unsettled work in the store. It resumes once, then no more: it stays
// retained and its workspace does not drain.
it("keeps a departing document retained, resuming it once, when its retained activation diverged after a restart", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(diverged());
  const {restarted} = await restartEmpty(o);
  await restarted.update({workspaces, documents: [], departing: [o.sibling]});
  await o.nextPull(); await o.nextPull();
  expect(o.client().captureOwnerActivation).toHaveBeenCalledTimes(1);
  expect(restarted.retains(o.sibling)).toBe(true);
  expect(restarted.drained("workspace")).toBe(false);
  expect(o.membership.filter(row => row.method === "liveApplication.unloadDocument")).toEqual([]);
});

// Proves: after a restart, a departing document the engine already parked is
// not ready to resume and has nothing here to settle or unload. It is
// forgotten, never captured again, and released once a pull no longer lists it.
it("releases a departing document that already parked after a restart, capturing it only once", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const {restarted} = await restartEmpty(o);
  await restarted.update({workspaces, documents: [], departing: [o.sibling]});
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true));
  expect(restarted.retains(o.sibling)).toBe(false);
  await o.nextPull(); await o.nextPull();
  expect(o.client().captureOwnerActivation).toHaveBeenCalledTimes(1);
  expect(o.membership.filter(row => row.method === "liveApplication.unloadDocument")).toEqual([]);
  await expect(restarted.detachDrained("workspace")).resolves.toBe(true);
});

// Proves: a document held for a live edit its session never admitted cannot
// become ready, so it gets one capture and then none. Its workspace keeps
// pushing and pulling, and a sibling keeps its passes. Unblocking allows
// exactly one more capture, which makes it ready once the hold clears.
it("captures a document held for an unadmitted live edit once, then not again until it is unblocked", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const captures = () => o.client().captureOwnerActivation.mock.calls.length, before = captures();
  const pushes = () => o.client().sendRequest.mock.calls.filter(call => ((call as unknown[])[0] as {method: string}).method === "sync.push").length;
  const visits = () => vi.mocked(ServiceActivationDriver.prototype.activate).mock.calls.filter(call => call[0].path === o.other.path).length;
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  o.replies.pass = {held: [{objectId: o.sibling.objectId, reason: "hosted-live-edit-unadmitted"}]};
  await vi.waitFor(() => expect(captures()).toBe(before + 1));
  const pushed = pushes();
  // A Y.Doc update for it does not lift a refusal.
  appendDocumentRow(o.raw, "ydoc.update", o.sibling.objectId);
  await o.nextPull(); await o.nextPull();
  expect(pushes()).toBeGreaterThan(pushed);
  expect(captures()).toBe(before + 1);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  expect(o.host.blocked(o.sibling)).toBe("live-edit-unadmitted");
  await o.host.update({workspaces, documents: [o.sibling, o.other], ...stay});
  const visited = visits();
  await vi.waitFor(() => expect(visits()).toBeGreaterThan(visited + 2));
  expect(captures()).toBe(before + 1);
  expect(o.host.blocked(o.other)).toBeUndefined();
  expect(o.host.unblock(o.sibling)).toBe(true);
  expect(o.host.blocked(o.sibling)).toBeUndefined();
  await vi.waitFor(() => expect(captures()).toBe(before + 2));
  const retried = visits();
  await vi.waitFor(() => expect(visits()).toBeGreaterThan(retried + 2));
  expect(captures()).toBe(before + 2);
  o.replies.pass = {};
  o.refuseCapture(undefined);
  expect(o.host.unblock(o.sibling)).toBe(true);
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(captures()).toBe(before + 3);
  expect(o.host.unblock(o.sibling)).toBe(false);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
});

// Proves: a retained activation the engine refuses as diverged resumes once
// after a restart and then no more, while its workspace keeps pushing and
// pulling. Unblocking resumes it exactly once more.
it("resumes a document whose retained activation diverged once, then not again until it is unblocked", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(diverged());
  const {restarted, count} = await restartEmpty(o), captures = () => o.client().captureOwnerActivation.mock.calls.length;
  await restarted.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(captures()).toBe(1));
  expect(o.client().captureOwnerActivation).toHaveBeenLastCalledWith(expect.anything(), "docs/a.md", 1_000_000, expect.any(AbortSignal), `ordinary-activation-${"a".repeat(64)}`);
  const pushed = count("sync.push");
  await o.nextPull(); await o.nextPull();
  expect(count("sync.push")).toBeGreaterThan(pushed);
  expect(captures()).toBe(1);
  expect(restarted.isDocumentReady(o.document)).toBe(false);
  expect(restarted.blocked(o.sibling)).toBe("refused");
  expect(restarted.unblock(o.sibling)).toBe(true);
  await vi.waitFor(() => expect(captures()).toBe(2));
  await vi.waitFor(() => expect(restarted.blocked(o.sibling)).toBe("refused"));
  await o.nextPull(); await o.nextPull();
  expect(captures()).toBe(2);
  expect(restarted.retains(o.sibling)).toBe(true);
});

// Proves: a document with no Y.Doc lineage has nothing to activate, so its
// first capture blocks it and no pass captures it again, while its workspace
// keeps pulling. Unblocking allows exactly one more capture. Any other conflict
// on a first capture keeps it waiting, captured again on every pass.
it.each([
  ["blocks", "live-document-without-lineage", withoutLineage, "without-lineage"],
  ["keeps retrying", "live-application-conflict", diverged, undefined],
] as const)("%s a document whose first capture the engine refuses as %s", async (_verb, _reason, refusal, block) => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  const plain = {workspaceId: "workspace", objectId: "object-plain", path: "docs/plain.md", shareId: "share"};
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const captures = () => o.client().captureOwnerActivation.mock.calls.filter(call => call[1] === plain.path).length;
  const visits = () => vi.mocked(ServiceActivationDriver.prototype.activate).mock.calls.filter(call => call[0].path === plain.path).length;
  o.refuseCapture(refusal());
  await o.host.update({workspaces, documents: [o.sibling, plain], ...stay});
  await vi.waitFor(() => expect(captures()).toBe(1));
  const visited = visits(), pulls = o.pullCount();
  await vi.waitFor(() => {expect(visits()).toBeGreaterThan(visited + 2); expect(o.pullCount()).toBeGreaterThan(pulls + 2);});
  expect(o.host.blocked(plain)).toBe(block);
  if (block === undefined) {
    expect(captures()).toBeGreaterThan(2);
    return;
  }
  expect(captures()).toBe(1);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  expect(o.host.unblock(plain)).toBe(true);
  await vi.waitFor(() => expect(captures()).toBe(2));
  await vi.waitFor(() => expect(o.host.blocked(plain)).toBe(block));
  const retried = visits();
  await vi.waitFor(() => expect(visits()).toBeGreaterThan(retried + 2));
  expect(captures()).toBe(2);
});

// Proves: a document whose capture found no Y.Doc lineage captures once more,
// with no Resume, only once the relay holds a Y.Doc update for it newer than
// any that capture saw. A moment, or another document's update, does not lift
// it. It then activates and stops reporting the block.
it("activates a document without lineage once a Y.Doc update for it reaches the relay", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], captures = () => o.client().captureOwnerActivation.mock.calls.length;
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(withoutLineage());
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.blocked(o.sibling)).toBe("without-lineage"));
  o.refuseCapture(undefined);
  appendDocumentRow(o.raw, "moment.append", o.sibling.objectId);
  appendDocumentRow(o.raw, "ydoc.update", o.other.objectId);
  await o.nextPull(); await o.nextPull();
  expect(captures()).toBe(1);
  expect(o.host.blocked(o.sibling)).toBe("without-lineage");
  appendDocumentRow(o.raw, "ydoc.update", o.sibling.objectId);
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(captures()).toBe(2);
  expect(o.host.blocked(o.sibling)).toBeUndefined();
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
});

// Proves: a document still without lineage after the update that lifted its
// block blocks again, at that update, so it captures once per new update. One
// whose retry meets another conflict is no longer blocked and waits.
it("blocks a document again when the update that lifted it carried no lineage", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], captures = () => o.client().captureOwnerActivation.mock.calls.length;
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(withoutLineage());
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(captures()).toBe(1));
  appendDocumentRow(o.raw, "ydoc.update", o.sibling.objectId);
  await vi.waitFor(() => expect(captures()).toBe(2));
  await o.nextPull(); await o.nextPull();
  expect(captures()).toBe(2);
  expect(o.host.blocked(o.sibling)).toBe("without-lineage");
  o.refuseCapture(unready());
  appendDocumentRow(o.raw, "ydoc.update", o.sibling.objectId);
  await vi.waitFor(() => expect(captures()).toBeGreaterThan(4));
  expect(o.host.blocked(o.sibling)).toBeUndefined();
});

// Proves: an update that reached the relay while the capture's pull ran may
// have missed that pull, so it lifts the block that capture left.
it("captures a document without lineage once more for an update that arrived during its pull", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], captures = () => o.client().captureOwnerActivation.mock.calls.length;
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(withoutLineage());
  const pulling = o.park("sync.pullHosted");
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await pulling.entered.promise;
  appendDocumentRow(o.raw, "ydoc.update", o.sibling.objectId);
  pulling.release.resolve();
  await vi.waitFor(() => expect(captures()).toBe(2));
  await o.nextPull(); await o.nextPull();
  expect(captures()).toBe(2);
});

// Proves: a diverged replica stops and detaches, its documents stay retained,
// and no later update attaches its store again on this daemon. A new
// identity's store is another store, so it attaches.
it("detaches a diverged workspace for good and retains its documents", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.replies.diverge = true;
  await vi.waitFor(() => expect(o.host.diverged()).toEqual([{workspaceId: "workspace", root: o.workspace.root}]));
  expect(o.membership).toEqual([o.attach, o.detach]);
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  o.replies.diverge = false;
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  expect(o.membership).toEqual([o.attach, o.detach]);
  expect(o.host.diverged()).toEqual([{workspaceId: "workspace", root: o.workspace.root}]);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  const rotatedRoot = join(o.f.root, "workspace-rotated"); await mkdir(rotatedRoot);
  expect(o.f.storage.rotateWorkspaceIdentity({workspaceId: "workspace", ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 10})).toBe("rotated");
  await o.host.update({workspaces: [{...o.workspace, root: rotatedRoot,
    hostedReplication: {...o.workspace.hostedReplication!, identity: {replicationEpoch: "epoch-2", streamIdentity: "stream-2"}}}], documents: [], ...stay});
  expect(o.membership).toEqual([o.attach, o.detach, {...o.attach, params: {...o.attach.params, root: rotatedRoot}}]);
  // A second divergence, under the new identity, keeps the first store's.
  o.replies.diverge = true;
  await vi.waitFor(() => expect(o.host.diverged()).toEqual([{workspaceId: "workspace", root: o.workspace.root}, {workspaceId: "workspace", root: rotatedRoot}]));
});

// Proves: a fresh daemon, with no marker to say a store diverged, pulls
// before the first activation captures anything. A divergence that pull finds
// detaches the workspace before any document is ready for anyone to edit.
it("finds a divergence on a fresh daemon before any document is ready", async () => {
  const o = await emptyServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.replies.diverge = true;
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.diverged()).toEqual([{workspaceId: "workspace", root: o.workspace.root}]));
  // A document is ready only once captured.
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  expect(o.membership).toEqual([o.attach, o.detach]);
});

// Proves: a divergence counts before its detach, so a detach the exiting
// engine fails still leaves the workspace in `diverged` for its replacement.
it("records a divergence whose detach fails as the engine exits", async () => {
  const o = await emptyServiceHost();
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.failDetach(new EngineRequestError(1, {code: "SESSION_EXPIRED", message: "engine exited", retry: "no"} as never));
  o.replies.diverge = true;
  await vi.waitFor(() => expect(o.host.invalidated.aborted).toBe(true));
  expect(o.membership).toEqual([o.attach, o.detach]);
  expect(o.host.diverged()).toEqual([{workspaceId: "workspace", root: o.workspace.root}]);
});

// Proves: deleting an account's workspace detaches it at once, unloading
// nothing of its hosted document, and removes its store with the live state
// parked there. Another workspace stays attached with its store.
it("detaches a deleted workspace at once and removes its store", async () => {
  const o = await emptyServiceHost(), otherRoot = join(o.f.root, "workspace-2");
  await mkdir(otherRoot);
  await o.host.update({workspaces: [o.workspace, {...o.workspace, root: otherRoot, workspaceId: "workspace-2"}], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  await writeFile(join(o.workspace.root, "replica.sqlite"), "parked live state");
  await o.host.deleteWorkspaces(["workspace"]);
  expect(o.membership.filter(row => row.method !== "liveApplication.attachWorkspace")).toEqual([o.detach]);
  expect(existsSync(o.workspace.root)).toBe(false); expect(existsSync(otherRoot)).toBe(true);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  expect(o.host.automationLedger("workspace")).toBeNull();
  expect(o.host.automationLedger("workspace-2")).not.toBeNull();
});

// Proves: deleting an account's workspace whose replica diverged removes the
// store the daemon kept detached, and the daemon no longer reports it.
it("removes a deleted workspace's diverged store and forgets the divergence", async () => {
  const o = await emptyServiceHost();
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.replies.diverge = true;
  await vi.waitFor(() => expect(o.host.diverged()).toEqual([{workspaceId: "workspace", root: o.workspace.root}]));
  await o.host.deleteWorkspaces(["workspace"]);
  expect(existsSync(o.workspace.root)).toBe(false);
  expect(o.host.diverged()).toEqual([]);
  expect(o.membership).toEqual([o.attach, o.detach]);
});

it.each([false, true])("detaches a workspace at once when its identity changes, leaving its pending document unsettled (new documents at once: %s)", async newAtOnce => {
  const o = await emptyServiceHost();
  const siblingRoot = join(o.f.root, "workspace-2"), rotatedRoot = join(o.f.root, "workspace-rotated");
  await mkdir(siblingRoot); await mkdir(rotatedRoot);
  const sibling = {...o.workspace, root: siblingRoot, workspaceId: "workspace-2"}, siblingDocument = {...o.other, workspaceId: "workspace-2"};
  const rotated = {...o.workspace, root: rotatedRoot,
    hostedReplication: {...o.workspace.hostedReplication!, identity: {replicationEpoch: "epoch-2", streamIdentity: "stream-2"}}};
  await o.host.update({workspaces: [o.workspace, sibling], documents: [o.other, siblingDocument], ...stay});
  expect(o.host.retains(o.other)).toBe(true);
  o.membership.splice(0);
  // Settlement under the old identity is refused, so an unload would stay pending forever.
  o.unloads.push({status: "pending", reason: "settlement-pending"});
  expect(o.f.storage.rotateWorkspaceIdentity({workspaceId: "workspace", ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 10})).toBe("rotated");
  const attach = {...o.attach, params: {...o.attach.params, root: rotatedRoot}};
  const rotatedSet = {workspaces: [rotated, sibling], documents: [o.other, siblingDocument], ...stay};
  if (!newAtOnce) {
    await o.host.update({workspaces: [sibling], documents: [siblingDocument], ...stay});
    expect(o.membership).toEqual([o.detach]);
    expect(o.host.settled(o.other)).toBe(false);
    expect(o.host.automationLedger("workspace")).toBeNull();
    // Nothing is left to retry.
    await o.host.update({workspaces: [sibling], documents: [siblingDocument], ...stay});
    expect(o.membership).toEqual([o.detach]);
  }
  await o.host.update(rotatedSet);
  expect(o.membership).toEqual([o.detach, attach]);
  expect(o.host.retains(o.other)).toBe(true);
  // The sibling workspace keeps its attachment and document throughout.
  expect(o.host.retains(siblingDocument)).toBe(true);
  expect(o.host.automationLedger("workspace-2")).not.toBeNull();
  expect(o.membership.every(row => row.workspace !== "attached-workspace-2")).toBe(true);
  expect(o.spawned()).toBe(1); expect(o.client().close).not.toHaveBeenCalled();
});

// Proves: after an identity change, an activated document re-enrolled into
// the new store resumes its retained activation once. That store never held
// it, so the engine refuses it as a conflict and the document blocks. Its
// workspace keeps pushing and pulling, and a sibling document keeps its passes.
it("blocks a document re-enrolled into a new store after an identity change while its workspace keeps syncing", async () => {
  const o = await emptyServiceHost(), rotatedRoot = join(o.f.root, "workspace-rotated");
  await mkdir(rotatedRoot);
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(o.f.storage.rotateWorkspaceIdentity({workspaceId: "workspace", ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 10})).toBe("rotated");
  const rotated = {...o.workspace, root: rotatedRoot,
    hostedReplication: {...o.workspace.hostedReplication!, identity: {replicationEpoch: "epoch-2", streamIdentity: "stream-2"}}};
  const captures = () => o.client().captureOwnerActivation.mock.calls.length, before = captures();
  const pushes = () => o.client().sendRequest.mock.calls.filter(call => ((call as unknown[])[0] as {method: string}).method === "sync.push").length;
  const visits = () => vi.mocked(ServiceActivationDriver.prototype.activate).mock.calls.filter(call => call[0].path === o.other.path).length;
  o.refuseCapture(diverged());
  await o.host.update({workspaces: [rotated], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(captures()).toBe(before + 1));
  expect(o.client().captureOwnerActivation).toHaveBeenLastCalledWith(expect.anything(), "docs/a.md", 1_000_000, expect.any(AbortSignal), `ordinary-activation-${"a".repeat(64)}`);
  const pushed = pushes();
  await o.nextPull(); await o.nextPull();
  expect(pushes()).toBeGreaterThan(pushed);
  expect(captures()).toBe(before + 1);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  await o.host.update({workspaces: [rotated], documents: [o.sibling, o.other], ...stay});
  const visited = visits();
  await vi.waitFor(() => expect(visits()).toBeGreaterThan(visited + 2));
  expect(captures()).toBe(before + 1);
  expect(o.host.retains(o.sibling)).toBe(true);
});

it("keeps the daemon after a refused attach and retires it when the engine expires its connection", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], send = o.client().sendRequest;
  const refuse = (code: string) => {
    const reply = send.getMockImplementation()! as (...args: unknown[]) => Promise<never>;
    send.mockImplementationOnce(async (...args: unknown[]) => (args[0] as {method: string}).method === "liveApplication.attachWorkspace"
      ? Promise.reject(new EngineRequestError(1, {code, message: code, retry: "no"} as never)) : reply(...args));
  };
  refuse("INVALID_PARAMS");
  await expect(o.host.update({workspaces, documents: [o.sibling], ...stay})).rejects.toThrow("INVALID_PARAMS");
  expect(o.host.invalidated.aborted).toBe(false);
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await o.host.update({workspaces: [], documents: [], ...stay});
  refuse("SESSION_EXPIRED");
  await expect(o.host.update({workspaces, documents: [o.sibling], ...stay})).rejects.toThrow("SESSION_EXPIRED");
  expect(o.host.invalidated.aborted).toBe(true);
});

it("removes a detached configured root after restart and keeps unrelated roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-configured-root-deletion-"));
  cleanup.push(() => rm(root,{recursive:true,force:true}));
  const deleted = join(root,"deleted"), kept = join(root,"kept");
  await mkdir(deleted);await mkdir(kept);await writeFile(join(deleted,"account"),"deleted-person");
  const configPath = join(root,"host.json");
  const hostedReplication = {relay:{baseUrl:"https://relay.example",bearerToken:"service-token"},identity:{replicationEpoch:"epoch",streamIdentity:"stream"},maxPagesPerPull:8};
  await writeFile(configPath,JSON.stringify({workspaces:[{root:deleted,workspaceId:"deleted",maxRegistrations:1,hostedReplication},{root:kept,workspaceId:"kept",maxRegistrations:1}]}));
  await deleteConfiguredServiceWorkspaceRoots(configPath,["deleted"]);
  await deleteConfiguredServiceWorkspaceRoots(configPath,["deleted"]);
  expect(existsSync(deleted)).toBe(false);expect(existsSync(kept)).toBe(true);
  await writeFile(configPath,JSON.stringify({workspaces:[{root,workspaceId:"deleted",maxRegistrations:1},{root:kept,workspaceId:"kept",maxRegistrations:1}]}));
  await expect(deleteConfiguredServiceWorkspaceRoots(configPath,["deleted"])).rejects.toThrow("overlap");
  expect(existsSync(kept)).toBe(true);
});

// An empty host holding the real document and a held one, on a manual clock.
// Only Date.now is fake: passes run on real timers, and visits to the held
// document count them. `hold` keeps passes from activating the real document.
// `alone` moves the held document to a second workspace, so the real one is alone in its workspace.
async function idleHost(options: {alone?: boolean} = {}) {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const o = await emptyServiceHost({frameChanges: true}), workspaces = [o.workspace];
  let other = o.other;
  if (options.alone) {
    const root = join(o.f.root, "workspace-2"); await mkdir(root);
    workspaces.push({...o.workspace, root, workspaceId: "workspace-2"}); other = {...o.other, workspaceId: "workspace-2"};
  }
  const activate = vi.mocked(ServiceActivationDriver.prototype.activate), through = activate.getMockImplementation()!;
  let held = false;
  activate.mockImplementation(function (this: ServiceActivationDriver, ...args) {
    return held && args[0].path === o.sibling.path ? Promise.resolve({kind: "pending" as const, reason: "held"}) : through.apply(this, args);
  });
  await o.host.update({workspaces, documents: [o.sibling, other], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const visits = (path: string) => activate.mock.calls.filter(([target]) => target.path === path).length;
  const requests = () => o.client().sendRequest.mock.calls.map(call => (call as unknown[])[0] as {method: string; params: Record<string, unknown>});
  const methods = () => requests().map(request => request.method);
  return {...o, workspaces, editors: liveEditors(o.f.storage), requests, methods, visits,
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
  expect(o.host.retains(o.sibling)).toBe(true); expect(o.host.settled(o.sibling)).toBe(true);
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
  await o.host.update({workspaces: o.workspaces, documents: [o.other], departing: [o.sibling]});
  await vi.waitFor(() => expect(o.host.settled(o.sibling)).toBe(false));
  expect(o.unloaded()).toBe(1);
});

it("brings a dormant document back into passes for stop-access work that reloads it, which settle it before it unloads again", async () => {
  const o = await idleHost();
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  expect(o.host.settled(o.sibling)).toBe(true);
  o.restore();
  o.hold(true);
  // Work that never registers leaves the document dormant.
  const stopped = vi.spyOn(OwnerCommittedDelivery.prototype, "stopRestore").mockResolvedValueOnce({kind: "pending", reason: "stopping"});
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "stopping"});
  let visits = o.visits(o.sibling.path);
  await o.passes();
  expect(o.visits(o.sibling.path)).toBe(visits);
  // The stop that registers its old cut reloads it.
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  expect(stopped).toHaveBeenCalledTimes(2);
  // Passes visit it again, and until one settles it a revoke cannot be released over its restore work.
  visits = o.visits(o.sibling.path);
  await o.passes();
  expect(o.visits(o.sibling.path)).toBeGreaterThan(visits);
  expect(o.host.settled(o.sibling)).toBe(false);
  const settles = o.settles().length;
  // The fence lifts on the same binding, so passes settle the reloaded owner.
  o.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open',restore_fence_generation=restore_fence_generation-1");
  o.hold(false);
  await vi.waitFor(() => expect(o.host.settled(o.sibling)).toBe(true));
  expect(o.settles().length).toBeGreaterThan(settles);
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(2));
});

it("brings a dormant document back into passes when its restore capture loads it but the stop is cancelled, which settle and unload it again", async () => {
  const o = await idleHost();
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  o.restore();
  o.hold(true);
  // The engine loads the session, then the caller cancels before the reply is used.
  const abort = new AbortController(), reason = new Error("Caller cancelled."), captureOwnerActivation = o.client().captureOwnerActivation;
  const loads = captureOwnerActivation.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
  captureOwnerActivation.mockImplementationOnce(async (...args: unknown[]) => {const loaded = await loads(...args); abort.abort(reason); return loaded;});
  await expect(o.host.stopRestore(stopLookup, abort.signal)).rejects.toBe(reason);
  expect(o.host.settled(o.sibling)).toBe(false);
  const visits = o.visits(o.sibling.path);
  await o.passes();
  expect(o.visits(o.sibling.path)).toBeGreaterThan(visits);
  // Passes resume the loaded session and settle it once the fence lifts on the same binding.
  o.raw.exec("UPDATE sync_relay_live_documents SET admission_state='open',restore_fence_generation=restore_fence_generation-1");
  o.hold(false);
  await vi.waitFor(() => expect(o.host.settled(o.sibling)).toBe(true));
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(2));
  const native = await o.host.captureNative(o.binding());
  expect(native.invalidated.aborted).toBe(false);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
});

it("keeps a dormant document dormant when the engine refuses its restore capture", async () => {
  const o = await idleHost();
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  o.restore();
  o.refuseCapture(conflictOpen());
  await expect(o.host.stopRestore(stopLookup)).rejects.toThrow("ydoc-conflict-open");
  expect(o.host.settled(o.sibling)).toBe(true);
  const captures = o.client().captureOwnerActivation.mock.calls.length, visits = o.visits(o.sibling.path);
  await o.passes();
  expect(o.visits(o.sibling.path)).toBe(visits);
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures);
});

// Stops access to the dormant document and expects its reloaded native adoption
// to register the stop's binding alone, then reach the native fence.
async function stopDormant(o: Awaited<ReturnType<typeof idleHost>>) {
  const binding = o.binding(), captures = o.client().captureOwnerActivation.mock.calls.length, sent = o.requests().length;
  // Stopping access fences the binding, so the dormant document cannot activate again before the stop.
  o.restore();
  // The stop registers its old cut and reaches the native fence, which this engine leaves pending.
  await expect(o.host.stopRestore({operationId: "restore", workspaceId: "workspace", ownerUserId: "owner"}))
    .resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  const stopping = o.requests().slice(sent).filter(request => request.method.startsWith("liveApplication."));
  expect(stopping.map(request => [request.method, request.params])).toEqual([
    ["liveApplication.register", {binding}],
    ["liveApplication.ownerState", {registrationId: 7, sessionId: "native-session"}],
    ["liveApplication.fenceRestore", expect.anything()],
    ["liveApplication.fenceRestore", expect.anything()],
  ]);
}

it("stops access to a dormant document through its reloaded native adoption, sending native registration only the binding", async () => {
  const o = await idleHost();
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  await stopDormant(o);
});

it("stops access to a dormant document whose owner was gone when it unloaded, through its durable activation", async () => {
  const o = await idleHost(), parked = o.park("liveApplication.unloadDocument");
  o.advance(600_000);
  await parked.entered.promise;
  // A binding change seen while the unload waits drops the owner; the binding then returns.
  o.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1");
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  o.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation-1");
  parked.release.resolve();
  // The document is now dormant with no owner retained.
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  await stopDormant(o);
});

it("stops access to a dormant document under the binding its stop recorded after the binding changed while dormant", async () => {
  const o = await idleHost();
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  // The binding moves on while dormant, and the retained adoption's evidence moves with it.
  const before = o.binding();
  o.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1");
  const after = o.binding(), origin = JSON.parse(String(o.raw.prepare("SELECT origin_json FROM sync_relay_live_delivery_owners").get()!.origin_json));
  expect(after).not.toEqual(before);
  o.raw.prepare("UPDATE sync_relay_live_delivery_owners SET origin_json=?").run(JSON.stringify({...origin, originalBinding: after,
    bindingDigest: createHash("sha256").update(JSON.stringify(parseLiveObjectBinding(after))).digest("hex")}));
  await stopDormant(o);
});

it("records an idle unload whose reply arrives after the sweep deadline and reloads the document on reconnect", async () => {
  const o = await idleHost(), deadlines: AbortController[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {const deadline = new AbortController(); deadlines.push(deadline); return deadline.signal;});
  o.hold(true);
  const parked = o.park("liveApplication.unloadDocument"), captures = o.client().captureOwnerActivation.mock.calls.length;
  o.advance(600_000);
  await parked.entered.promise;
  for (const deadline of deadlines) deadline.abort(new Error("Sweep deadline exceeded."));
  parked.release.resolve();
  // The document is dormant, so passes no longer visit it.
  await o.passes();
  const visits = o.visits(o.sibling.path);
  await o.passes();
  expect(o.visits(o.sibling.path)).toBe(visits);
  o.hold(false);
  const native = await o.host.captureNative(o.binding());
  expect(native.invalidated.aborted).toBe(false);
  // The reconnect reloads it without sending the unload again.
  expect(o.unloaded()).toBe(1);
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
});

it("sends an unanswered idle unload again before settling it or reloading it on reconnect", async () => {
  const o = await idleHost(), log = vi.spyOn(console, "error").mockImplementation(() => {});
  o.unloads.push(new Error("Engine connection reset."), new Error("Engine connection reset."));
  o.advance(600_000);
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Idle live document unload is waiting.", "Engine connection reset."));
  // Passes leave it alone: the engine may have ended its registration.
  const settles = o.settles().length, visits = o.visits(o.sibling.path);
  await o.passes();
  expect(o.visits(o.sibling.path)).toBe(visits);
  // The retry sends the unload again without settling first.
  o.advance(30_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(2));
  await o.passes();
  expect(o.settles().length).toBe(settles);
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  const native = await o.host.captureNative(o.binding());
  expect(o.unloaded()).toBe(3);
  expect(native.invalidated.aborted).toBe(false);
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
});

it("keeps an idle unload the engine stopped waiting for unanswered and sends it again before reloading the document", async () => {
  const o = await idleHost(), log = vi.spyOn(console, "error").mockImplementation(() => {});
  // The engine's spawned unload runs on after its request deadline.
  o.unloads.push(new EngineRequestError(1, {code: "DEADLINE_EXCEEDED", message: "unload-deadline", retry: "afterBackoff"} as never));
  o.advance(600_000);
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Idle live document unload is waiting.", "unload-deadline"));
  // Passes leave it alone: the engine may have ended its registration.
  const visits = o.visits(o.sibling.path);
  await o.passes();
  expect(o.visits(o.sibling.path)).toBe(visits);
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  const native = await o.host.captureNative(o.binding());
  // The reconnect sends the unload again without settling, then reloads the document.
  expect(o.unloaded()).toBe(2);
  const methods = o.methods();
  expect(methods.slice(methods.indexOf("liveApplication.unloadDocument"), methods.lastIndexOf("liveApplication.unloadDocument")))
    .not.toContain("liveApplication.settle");
  expect(native.invalidated.aborted).toBe(false);
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
});

it("keeps pulling a fully dormant workspace and pulls again before a reopened document's first sync", async () => {
  const o = await idleHost({alone: true}), send = o.client().sendRequest, capture = o.client().captureOwnerActivation;
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  // Passes still pull it, so its replica keeps retiring what left.
  const sent = o.methods().length;
  await o.passes(4);
  expect(o.methods().slice(sent)).toContain("sync.pullHosted");
  // An owner update reached the relay. A catch-up that stops at a page boundary keeps the document dormant.
  const captures = capture.mock.calls.length;
  o.replies.pass = {hasMore: true, fetched: 1, applied: 1};
  await expect(o.host.captureNative(o.binding())).rejects.toThrow("Hosted replication has more pages.");
  expect(capture.mock.calls.length).toBe(captures);
  o.replies.pass = {fetched: 1, applied: 1};
  const native = await o.host.captureNative(o.binding());
  expect(native.invalidated.aborted).toBe(false);
  // The open's pull committed before the document reloaded and its owner delivery registered.
  const captured = capture.mock.invocationCallOrder.at(-1)!;
  const before = (method: string) => send.mock.invocationCallOrder.filter((at, index) => o.methods()[index] === method && at < captured).at(-1)!;
  expect(before("sync.pullHosted")).toBeLessThan(before("sync.commitCursor"));
  const order = (method: string) => send.mock.invocationCallOrder.filter((_, index) => o.methods()[index] === method).at(-1)!;
  expect(captured).toBeLessThan(order("liveApplication.register"));
});
