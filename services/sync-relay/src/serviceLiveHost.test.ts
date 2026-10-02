import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment.js";
import { startServiceLiveHost } from "./serviceLiveHost.js";
import {hasRelayWriteObservers, notifyRelayWrite, observeRelayWrites} from "./relayWriteChanges.js";
import {ServiceActivationDriver} from "./serviceActivationDriver.js";

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
  const host = await startServiceLiveHost({...f,frameChanges: {maxListeners: 16,notify() {},subscribe: () => () => {}}});
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
  const host = await startServiceLiveHost({...f, frameChanges: {maxListeners: 16, notify, subscribe: () => () => {}}});
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
