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
import { EngineClientError, EngineRequestDeadlineError, EngineRequestError, InvalidFirstOpenCandidateCheck, firstOpenCandidateBinding,
  type FirstOpenCandidateInput } from "@dohc/workspace-engine-client/daemon";
import {createFirstOpenPublisher, type FirstOpenBuild, type FirstOpenCheckHost, type FirstOpenNativeCheck} from "./firstOpenPublication.js";
import {buildFirstOpenBase} from "./firstOpenBase.js";
import {readFirstOpenHistoryFile} from "./storage/firstOpenHistory.js";
import {createServiceHostReplication} from "./serviceHostReplication.js";
import {authorizeServiceHostReplication, deriveServiceHostBearer} from "./serviceHostCredential.js";
import { firstOpenOutcome } from "@dohc/workspace-contracts/first-open";
import {errorResponse} from "./errors.js";
import {parseLogOp} from "./relayLogInputs.js";
import {hasRelayWriteObservers, notifyRelayWrite, observeRelayWrites} from "./relayWriteChanges.js";
import {createNamedFrameChanges} from "./liveHostChanges.js";
import {HeldReadBusyError, HeldReadTooLargeError, NativeRequestQueueError} from "./liveHostRequests.js";
import {captureOwnerLiveFrameHost} from "./namedLiveFrameHost.js";
import type {LiveHostConnectionCoordinate} from "./storage.js";
import type {StorageContext} from "./storage/context.js";
import {readServiceActivationRetirement} from "./storage/serviceActivationRetirement.js";
import {SyncRelayQuotaExceededError} from "./storage/errors.js";
import {ServiceHostRetirementConflict, type ServiceHostRetirementPreparation} from "./storage/serviceHostEnrollment.js";
import {preparedStop} from "./liveTickets.test-helper.js";
import {ServiceActivationStore} from "./storage/serviceActivation.js";
import {LiveCommittedDeliveryStore} from "./storage/liveCommittedDelivery.js";
import {initialAcceptedHistoryDigest} from "./liveAcceptedHistory.js";
import {nativeRestoreFence} from "./storage/liveRestoreOperation.js";
import {ServiceActivationDriver} from "./serviceActivationDriver.js";
import {liveValidation} from "./liveValidation.js";
import {createServiceHostEnrollmentRoutes} from "./serviceHostEnrollmentRoutes.js";
import {startSelfHostedLiveHost} from "./selfHostedLiveHost.js";
import {ServiceHostedReplication} from "./serviceHostedReplication.js";
import {SERVICE_KEPT_EDITS_PAGE, type ServiceKeptEdits} from "./storage/serviceKeptEdits.js";
import {liveEditors} from "./liveEditors.js";
import {createHeldDocumentRoutes} from "./heldDocumentRoutes.js";
import { OwnerCommittedDelivery } from "./ownerCommittedDelivery.js";
import type { NativeOwnerActivation } from "@dohc/workspace-engine-client/daemon";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { markdownToYDoc, yDocToMarkdown } from "../../../packages/ydoc-projection/src/import-export.js";
import { createLiveMarkdownHistoryValidator, createLiveMarkdownJournalValidator, createLiveMarkdownRegistrationValidator } from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import { hostedWindowCovers, releasedLineageBindingDigest, type HostedWindow, type ReleasedLineageBinding } from "@dohc/workspace-engine-client/relay-wire";
import bindingVectors from "../../../packages/workspace-engine-client/src/relay/releasedLineageBindingVectors.json" with { type: "json" };
import { validateOrdinaryActivation } from "./storage/ordinaryActivationValidation.js";
import { readOrdinaryActivationHistory, verifyOrdinaryActivationCut } from "./storage/ordinaryActivationSource.js";
import { nativeSettlementId, prepareHostedSettlements, settlementRecordDigest } from "./storage/hostedSettlement.js";
import { stableJsonStringify } from "./canonicalJson.js";
import { encodeNativeRestoreProposal } from "./liveRestoreProposal.js";
import { resolveLiveRestorePoint } from "../../../packages/ydoc-projection/src/liveRestorePoint.js";
import { policy as restorePolicy, restore as restoreValidation } from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";

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

// `selfHosted` provisions the host ID the self-host supervisor provisions, so the supervisor can run this host.
async function fixture({selfHosted = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), "service-host-test-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const deploymentConfig = join(root, "deployment.json");
  initializeRelayDeployment({ configPath: deploymentConfig, relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity") });
  // First-open history reads in this process, as firstOpenPublication.test.ts reads it.
  const deployment = openRelayDeployment(deploymentConfig, {firstOpenHistory: async read => readFirstOpenHistoryFile(read)});
  const hostId = selfHosted ? `self-host-${deployment.history.namespace}` : "service";
  deployment.storage.provisionLiveHostControl({ mode: "service", hostId, updatedAtMs: 1, guard() {} });
  const config = { version: 1, engineExecutable: process.execPath, hostId, instanceId: "instance",
    workspaces: [{ root: workspace, workspaceId: "workspace", maxRegistrations: 8 }],
    ingress: { aggregateBytes: 200_000_000, applicationWorkingReserveBytes: 50_000_000, maxUploads: 2, uploadDeadlineMs: 1000 },
    client: { aggregateBytes: 200_000_000, maxUploads: 2, connectTimeoutMs: 1000, requestDeadlineMs: 1000 } };
  const configPath = join(root, "service.json");
  const save = () => writeFile(configPath, JSON.stringify(config)); await save();
  let closed = false;
  const closeStorage = () => { if (!closed) { deployment.storage.close(); closed = true; } };
  cleanup.push(async () => { closeStorage(); await rm(root, { recursive: true, force: true }); });
  // Every host started from the fixture calls these as each of its activation passes ends.
  const passEnds = new Set<() => void>();
  return { trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), ...deployment, root, config, configPath, save, closeStorage,
    passEnds, onPass: () => {for (const listener of [...passEnds]) listener();} };
}
// Resolves once `count` activation passes that began after the call have ended.
function afterPasses(f: {passEnds: Set<() => void>}, count = 1) {
  let ended = 0;
  return new Promise<void>(resolve => {
    // The first pass to end may have begun before the call.
    const listener = () => {if (++ended > count) {f.passEnds.delete(listener); resolve();}};
    f.passEnds.add(listener);
  });
}
function clientFrom(options: { env: Record<string, string> }) {
  const nativePath = options.env.DOHC_ENGINE_LIVE_HOST_CONFIG!;
  const config = JSON.parse(readFileSync(nativePath, "utf8"));
  // It creates each hosted replica it is asked to, and answers anything else with its discovery.
  const client = { sendRequest: vi.fn(async (request?: {method: string}) => request?.method === "sync.createHostedReplica" ? {result: {hosted: true}} : ({
    result: { relayNamespace: config.relayNamespace, host: config.host,
      workspaces: config.workspaces.map((row: { workspaceId: string }) => ({ workspaceId: row.workspaceId, workspaceHandle: "actual-open-handle" })) } })),
    close: vi.fn(), waitForExit: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) };
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
  pendingCursor: {kind: "hosted", token: "pending"}, changedPaths: [], changedPathsOmitted: 0, refusals: [], refusalsOmitted: 0, sharingDeclined: [],
  sharingDeclinedOmitted: 0, held: [], heldThrough: null, newlyHeld: [], newlyHeldOmitted: 0, departed: [], departedThrough: null, ...overrides});
const hostedCommit = (overrides: Record<string, unknown> = {}) => ({committed: true, hasMore: false, retirement: null, departed: [], departedThrough: null,
  sharingDeclined: [], ...overrides});
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

it("asks the engine to check a first-open candidate outside any turn, and says why it gave no verdict", async () => {
  const f = await fixture(); let captured!: ReturnType<typeof clientFrom>;
  const check = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  spawn.mockImplementation(async options => {captured = clientFrom(options); return {...captured.client, checkFirstOpenCandidate: check};});
  f.config.client.aggregateBytes = 8 * 1024 * 1024; await f.save();
  const host = await startServiceLiveHost(f), log = vi.spyOn(console, "error").mockImplementation(() => {});
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const source = new TextEncoder().encode("# Notes\n"), candidate = Uint8Array.of(0, 0);
  const input = {objectId: "object", path: "docs/a.md", sourceMomentId: "moment", replicationEpoch: "epoch", streamIdentity: "stream",
    source, sourceSha256: digest(source), candidate, candidateSha256: digest(candidate), maxFullStateBytes: 4096};
  const wire = (code: ConstructorParameters<typeof EngineRequestError>[1]["code"]) => new EngineRequestError(7, {code, message: "refused", retry: "no"});
  try {
    const verdict = {status: "refused", cause: "settlement-mismatch"};
    check.mockResolvedValueOnce(verdict);
    const answered = await host.checkFirstOpenCandidate("workspace", input, new AbortController().signal);
    expect(answered).toMatchObject({kind: "answered", check: verdict});
    expect(check.mock.calls[0]![0]).toMatchObject({workspace: "actual-open-handle", deadlineMs: f.config.client.requestDeadlineMs});
    expect(check.mock.calls[0]![1]).toBe(input);
    for (const [error, reason] of [
      [wire("OVERLOADED"), "busy"], [new NativeRequestQueueError("capacity", "full"), "busy"],
      [wire("DEADLINE_EXCEEDED"), "check-deadline"], [new NativeRequestQueueError("deadline", "late"), "check-deadline"],
      [new EngineRequestDeadlineError(7, "liveApplication.checkFirstOpenCandidate", 10), "check-deadline"],
      [wire("WORKSPACE_UNAVAILABLE"), "host-absent"], [wire("SESSION_EXPIRED"), "host-absent"],
      [wire("INTERNAL"), "check-failed"], [new EngineClientError("closed", "closed"), "host-unreachable"],
      [new EngineClientError("protocol-error", "Engine frame decoding failed."), "host-unreachable"],
    ] as const) {
      check.mockRejectedValueOnce(error);
      expect(await host.checkFirstOpenCandidate("workspace", input, new AbortController().signal), String(error)).toEqual({kind: "unavailable", reason});
    }
    // A check an idle engine could never admit is this host's configuration, logged with the sizes the engine names.
    const capacity = new EngineRequestError(7, {code: "LIMIT_EXCEEDED", retry: "no", message:
      "first-open-check-exceeds-host-capacity: reservation 1 bytes, foreground allowance 2 bytes, aggregate 3 bytes, 2 upload slots"});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    check.mockRejectedValueOnce(capacity);
    expect(await host.checkFirstOpenCandidate("workspace", input, new AbortController().signal)).toEqual({kind: "host-capacity"});
    expect(logged).toHaveBeenLastCalledWith("[service-live-host] first-open check exceeds this host's capacity", capacity);
    expect(capacity.message).toContain("foreground allowance 2 bytes");
    logged.mockRestore();
    for (const error of [wire("BLOB_INVALID"), wire("INVALID_PARAMS"), new InvalidFirstOpenCandidateCheck()]) {
      check.mockRejectedValueOnce(error);
      expect(await host.checkFirstOpenCandidate("workspace", input, new AbortController().signal)).toEqual({kind: "integrity"});
    }
    // A relay fault stays one, and a cancelled caller keeps its cancellation.
    check.mockRejectedValueOnce(new TypeError("a relay bug"));
    await expect(host.checkFirstOpenCandidate("workspace", input, new AbortController().signal)).rejects.toThrow("a relay bug");
    const abort = new AbortController();
    check.mockImplementationOnce(async () => { abort.abort(new Error("cancelled")); throw wire("CANCELLED"); });
    await expect(host.checkFirstOpenCandidate("workspace", input, abort.signal)).rejects.toThrow("cancelled");
    // Neither another workspace nor an upload the client can never hold reaches the engine.
    let calls = check.mock.calls.length;
    expect(await host.checkFirstOpenCandidate("other", input, new AbortController().signal)).toEqual({kind: "unavailable", reason: "host-absent"});
    // 5 MiB plus the 3 MiB request allowance passes 8 MiB.
    const large = new Uint8Array(5 * 1024 * 1024);
    expect(await host.checkFirstOpenCandidate("workspace", {...input, candidate: large, candidateSha256: digest(large)}, new AbortController().signal))
      .toEqual({kind: "host-capacity"});
    expect(check.mock.calls.length).toBe(calls);
    // One check at a time: another is busy until the first answers or fails.
    type Release = {resolve(value: unknown): void; reject(error: unknown): void};
    for (const settle of [(release: Release) => release.resolve(verdict), (release: Release) => release.reject(wire("INTERNAL"))]) {
      let release!: Release;
      check.mockImplementationOnce(() => new Promise((resolve, reject) => { release = {resolve, reject}; }));
      const first = host.checkFirstOpenCandidate("workspace", input, new AbortController().signal);
      await vi.waitFor(() => expect(check.mock.calls.length).toBe(calls + 1));
      expect(await host.checkFirstOpenCandidate("workspace", input, new AbortController().signal)).toEqual({kind: "unavailable", reason: "busy"});
      expect(check.mock.calls.length).toBe(calls + 1);
      settle(release);
      await first;
      check.mockResolvedValueOnce(verdict);
      expect(await host.checkFirstOpenCandidate("workspace", input, new AbortController().signal)).toMatchObject({kind: "answered"});
      calls += 2;
    }
    // The answer holds only while its host stands.
    expect(answered.kind === "answered" && answered.current()).toBe(true);
    await host.close();
    expect(answered.kind === "answered" && answered.current()).toBe(false);
    expect(await host.checkFirstOpenCandidate("workspace", input, new AbortController().signal)).toEqual({kind: "unavailable", reason: "host-absent"});
  } finally {await host.close(); log.mockRestore();}
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
    settlement:{maxApplicationsPerSettlement:8},sync:{policy:{maxReadBytes:1_000_000,maxOutputBytes:1_000_000,maxClientVectorBytes:1000,maxHostVectorBytes:1000},workingReserveBytes:1_000_000},
    activation:{targets:[{workspaceId:"workspace",path:"file.md",shareId:"share"}],maxCaptureBytes:1_000_000,
      maxEntriesPerDrain:10,maxBytesPerDrain:1_000_000,maxDocumentsPerPass:1,pollIntervalMs:60_000,passDeadlineMs:1000,
      idleUnloadMs:600_000,idleRetryMs:30_000,
      validation:{maxStructVisits:1000,maxValueNodeVisits:1000,maxDecodedPayloadByteVisits:1000,maxStructClientGroupVisits:1000,
        maxDeleteClientGroupVisits:1000,maxDeleteIntervalVisits:1000,maxIndexOperations:1000},...limits}});
  await f.save();
}

// Proves: an activation host needs every bound its retirement uses, settlement
// included, so a configuration that could never retire refuses to start
// before it spawns or prepares anything.
it.each(["adoption","sync","settlement"] as const)("refuses activation without %s before spawning",async missing=>{
  const f=await fixture();
  await configureActivation(f);
  delete (f.config as Record<string,unknown>)[missing]; await f.save();
  await expect(startServiceLiveHost(f)).rejects.toThrow("Service activation requires bounded native adoption, sync and settlement.");
  expect(spawn).not.toHaveBeenCalled();
  expect(f.storage.getLiveHostControl()?.registeredConnectionId).toBeNull();
});

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
  // Its workspace is never ready, so each pass pulls it too; those pulls succeed.
  const pull = vi.spyOn(ServiceHostedReplication.prototype,"pull").mockResolvedValue({hasMore: false,pages: []});
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
    expect(pull).toHaveBeenCalledTimes(4);
  } finally {await host.close(); vi.useRealTimers(); log.mockRestore(); activate.mockRestore(); pull.mockRestore();}
});

// Sol's review: each target with no owner pulled its workspace itself, so
// several whose pulls had more pages pulled it as many times a pass, while
// it stayed unready. Proves: they share one catch-up pull a pass, and the
// workspace pulls no more than that.
it("gives several unfinished targets in one workspace one catch-up pull a pass", async () => {
  const f = await fixture();
  await configureActivation(f, {maxDocumentsPerPass: 3, pollIntervalMs: 20,
    targets: ["a", "b", "c"].map(name => ({workspaceId: "workspace", path: `${name}.md`, shareId: "share"}))});
  const events: string[] = [];
  spawn.mockImplementation(async options => {
    const captured = clientFrom(options), discovery = captured.client.sendRequest.getMockImplementation()!;
    captured.client.sendRequest.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as {method: string};
      if (request.method === "liveApplication.hosts") return discovery();
      if (request.method === "sync.createHostedReplica") return {result: {hosted: true}} as never;
      if (request.method === "sync.materializePendingCursor") return {result: {materialized: true}} as never;
      if (request.method === "sync.commitCursor") return {result: hostedCommit({hasMore: true})} as never;
      events.push("pull");
      return {result: hostedPass({hasMore: true, fetched: 1, applied: 1})} as never;
    });
    return captured.client;
  });
  // Each pass asks whether the workspace is ready once, after its activations.
  const workspaceReady = ServiceActivationDriver.prototype.workspaceReady;
  const ready = vi.spyOn(ServiceActivationDriver.prototype, "workspaceReady").mockImplementation(function (this: ServiceActivationDriver, workspaceId) {
    events.push("pass"); return workspaceReady.call(this, workspaceId);
  });
  const host = await startServiceLiveHost(f);
  try {
    await vi.waitFor(() => expect(events.filter(event => event === "pass").length).toBeGreaterThanOrEqual(3));
    expect(events.slice(0, 6)).toEqual(["pull", "pass", "pull", "pass", "pull", "pass"]);
  } finally {await host.close(); ready.mockRestore();}
});

const {DatabaseSync} = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DrainLimits = {maxEntriesPerDrain?: number; maxBytesPerDrain?: number};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// How the host reaches the relay's first open, and the clock, jitter and timer its retries use.
type FirstOpenOptions = {fetch: typeof fetch; nowMs?: () => number; random?: () => number; schedule?: (atMs: number, fire: () => void) => () => void};

// A service owner whose activation completed under an earlier connection, as
// after a restart. The started host resumes it from real relay storage; only
// the engine is mocked. `park` holds the next engine request for one method.
// `maxApplications` is the settlement bound, which pages a retirement's applications. `limits` are the drain budgets.
// With `firstOpen`, the host asks the relay to start documents with no lineage through its `fetch`.
// `pollIntervalMs` replaces the pause between passes.
async function completedServiceOwner(options: {empty?: boolean; frameChanges?: boolean; maxDocumentsPerPass?: number; polling?: boolean; adopted?: boolean;
  maxApplications?: number; limits?: DrainLimits; passDeadlineMs?: number; pollIntervalMs?: number; firstOpen?: FirstOpenOptions; selfHosted?: boolean;
  restore?: boolean} = {}) {
  const adopted = options.adopted ?? true;
  const f = await fixture({selfHosted: options.selfHosted}), raw = new DatabaseSync(join(f.root, "relay", "relay.sqlite"));
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

  // Complete the activation under the earlier connection: adoption, seed, native application. Without `adopted` it is only prepared.
  const earlier = {mode: "service" as const, hostId: f.config.hostId, hostEpoch: f.storage.getLiveHostControl()!.hostEpoch, instanceId: "instance", connectionId: "earlier"};
  const actor = {kind: "owner" as const, userId: "owner", shareId: "share"}, store = f.storage.createServiceActivationStore(f.history);
  await store.prepare({capture, host: earlier, shareId: "share", registeredAtMs: 3, guard() {}, validate: async work => validateOrdinaryActivation(work, policy),
    bounds: {maxCaptureBytes: 1_000_000, maxEntriesPerDrain: 10, maxBytesPerDrain: 1_000_000}});
  const access = store.pending(document, earlier), delivery = f.storage.createLiveCommittedDeliveryStore(f.history, access);
  if (adopted) {
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
  }

  const target ={workspaceId: "workspace", path: "docs/a.md", shareId: "share"};
  // An empty host activates documents it gains on its next pass. It and a polling host pass every 20 ms.
  await configureActivation(f, {targets: options.empty ? [] : [target], passDeadlineMs: options.passDeadlineMs ?? 10_000, validation: policy,
    ...(options.pollIntervalMs ? {pollIntervalMs: options.pollIntervalMs} : options.empty || options.polling ? {pollIntervalMs: 20} : {}),
    ...(options.maxDocumentsPerPass ? {maxDocumentsPerPass: options.maxDocumentsPerPass} : {}), ...options.limits});
  // An empty host receives this workspace and document through `update`.
  const workspace = f.config.workspaces[0]! as ServiceWorkspace;
  if (options.maxApplications) Object.assign(f.config, {settlement: {maxApplicationsPerSettlement: options.maxApplications}});
  if (options.restore) Object.assign(f.config, {restore: RESTORE});
  if (options.empty) f.config.workspaces = [];
  await f.save();

  let parked: {method: string; entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>>} | undefined;
  // Each is told the method of every engine request any daemon sends, as it is sent.
  const requestListeners = new Set<(method: string) => void>();
  // Queued unload replies, or errors that lose them. `replies` overrides every hosted pass, commit and push until a test changes it.
  // With `heldPerPass` and `departedPerPass`, a pass and its commit list at most that many, as when the rest do not fit.
  // `loseCommit` loses the next commit's reply after the commit stood.
  const pushed = deferred<void>(), unloads: unknown[] = [];
  // `diverge` refuses each pull as diverged. `create` fails each create, as diverged when a relay is ahead at the replica's origin.
  const replies: {pass: Record<string, unknown>; commit: Record<string, unknown>; push: Record<string, unknown>; diverge?: boolean;
    heldPerPass?: number; departedPerPass?: number; loseCommit?: boolean; create?: "diverged" | Error} = {pass: {}, commit: {}, push: {}};
  const divergence = (id: number) => new EngineRequestError(id, {code: "INVALID_PARAMS", message: "relay-origin-diverged", retry: "no"} as never);
  // As the engine does, a list names the documents after where the pull asked, and says where it stops if cut.
  let departedAfter: string | undefined;
  const page = (ids: readonly string[], after: string | undefined, limit: number | undefined) => {
    const rest = ids.filter(id => after === undefined || id > after), listed = rest.slice(0, limit ?? rest.length);
    return {listed, through: listed.length < rest.length ? listed.at(-1)! : null};
  };
  // What the engine applied of each accepted row, by delivery ID. `lost` loses each application's
  // reply and every ACK read after it, as when the engine applied a row the relay never recorded.
  // While `pending` is set, the engine answers each application pending and applies nothing.
  const applied = new Map<string, Record<string, unknown>>(), lost = {replies: false, pending: false};
  // Applied rows no settlement reached the file with yet. They keep the document's unload pending.
  const unsettled = new Set<string>();
  // Once set, each registration gets a new ID and retires the one before it, as the engine does.
  let registrations: {next: number; live: number} | undefined, registrationRefusal: Error | undefined;
  let registrationsByObject: Map<string, number> | undefined;
  const retired = (id: unknown) => registrations !== undefined && id !== registrations.live;
  const unavailable = (id: number) => new EngineRequestError(id, {code: "INVALID_PARAMS", message: "live-registration-unavailable", retry: "no"} as never);
  // Whether the engine's settlement reaches the file. Until it does, the same terminal settles again.
  const settlement = {materialized: true};
  // The engine's side of a retirement. Reconciliation first asks the journal for each delivery in `unproven`, and
  // records each answer in `journals`. It then reports the adoption, if the activation adopted, and a page of what
  // it applied after the relay's tip, in journal order, and asks to settle until a retirement settled through all
  // of it. `refusal` refuses it. Release keeps its first boundary. An adopted activation releases only once its
  // document parked, which a commit listing it departed or settled output still `unpushed` prevents, and then only
  // once it settled through what it applied, unless `releasePending` names another reason. Native capture returns
  // `capture`, as a test sets for a successor, which adopts at its predecessor's boundary; `adoption` is what the
  // engine last adopted. `generation` is the restore generation the document's application binding has, once a
  // restore moved it past its queues'. `prepared` is the activation whose local appends a Stop's preparation blocks,
  // until its release, its retirement's reconciliation, or the end of the connection; `releaseFailure` fails each release.
  const engine: {refusal?: Error; boundary?: unknown; settledThrough?: number; reconciledThrough?: number; unproven: string[]; journals: unknown[];
    unpushed: number; releasePending?: string; capture: NativeOwnerActivation; adoption: {activationId: string; throughCursor: number | null};
    generation?: number; fenceCommitted?: boolean; abandonableSeed?: boolean; prepared?: Record<string, unknown>; prepareFailure?: Error; releaseFailure?: Error} =
    {capture, unproven: [], journals: [], unpushed: 0, adoption: {activationId: capture.activationId, throughCursor: adopted ? 0 : null}};
  // The activation's own native queue, which delivery reads through its owner state once `outboxId` names it. Its entries
  // wait in order. A refused head quarantines it until a Try again names that head in `retryDeliveryId`, and acknowledging
  // that head resumes it. The engine never receives an acknowledgement of an entry `loseAcks` names, so the entry stays
  // queued, as when the relay accepted it and its receipt never reached the engine.
  type NativeEntry = {sequence: number; deliveryId: string; update: Buffer};
  const NATIVE = "native-outbox";
  const native: {outboxId: string | null; binding?: unknown; entries: NativeEntry[]; nextSequence: number; state: "active" | "quarantined";
    retryDeliveryId: string | null; loseAcks: Set<string>} = {outboxId: null, entries: [], nextSequence: 1, state: "active", retryDeliveryId: null, loseAcks: new Set()};
  const nativeBytes = () => native.entries.reduce((sum, entry) => sum + entry.update.length, 0);
  // One page of the native queue's snapshot, as the engine reads it: each part whole, entries in order after the header.
  const nativePage = (params: Record<string, unknown>) => {
    const header = {outboxId: NATIVE, binding: native.binding, baseUpdateDigest: document.lineageClaimId, baseByteLength: 1, state: native.state,
      pendingBytes: nativeBytes(), pendingEntryCount: native.entries.length, nextSequence: native.nextSequence, oldestEntryAtMs: native.entries.length ? 1 : null,
      quarantineReason: native.state === "quarantined" ? "invalid-update" : null, observedBinding: null, retryDeliveryId: native.retryDeliveryId};
    const snapshot = sha256(Buffer.from(JSON.stringify(header))), cursor = (part: string, sequence = 0) => ({snapshot, part, sequence, offset: 0});
    const requested = (params.cursor as ReturnType<typeof cursor> | undefined) ?? cursor("header");
    if (requested.snapshot !== snapshot) return {kind: "readChanged"};
    const first = native.entries[0], at = native.entries.findIndex(entry => entry.sequence === requested.sequence);
    const entry = native.entries[at], following = native.entries[at + 1];
    const live = {firstEntryCursor: first ? cursor("entryHeader", first.sequence) : null, frozenAtRefusedSeed: false, checkpointDigest: null, recoveryCheckpointDigest: null};
    if (requested.part !== "header" && requested.part !== "base" && !entry) return {kind: "readChanged"};
    const [bytes, nextCursor] = requested.part === "header" ? [Buffer.from(JSON.stringify({...header, ...live})), cursor("base")] as const
      : requested.part === "base" ? [Buffer.from([1]), live.firstEntryCursor] as const
      : requested.part === "entryHeader" ? [Buffer.from(JSON.stringify({sequence: entry!.sequence, appendKey: `append-${entry!.deliveryId}`, deliveryId: entry!.deliveryId,
        updateDigest: sha256(entry!.update), byteLength: entry!.update.length, createdAtMs: 1})), cursor("update", entry!.sequence)] as const
      : [entry!.update, following ? cursor("entryHeader", following.sequence) : null] as const;
    return {kind: "page", ...requested, totalBytes: bytes.length, digest: sha256(bytes), bytesBase64: bytes.toString("base64"), nextCursor};
  };
  // The bytes delivery reads for the queue's head now: its header, entry header and update pages.
  const nativeHeadBytes = () => {
    let read = 0, cursor: unknown;
    for (let page = 0; page < 3; page++) {
      const answer = nativePage(cursor === undefined ? {} : {cursor}) as {bytesBase64: string; nextCursor: {part: string} | null};
      read += answer.bytesBase64.length;
      // Delivery skips the base part.
      cursor = page === 0 ? {...answer.nextCursor, part: "entryHeader", sequence: native.entries[0]!.sequence} : answer.nextCursor;
    }
    return read;
  };
  const ownerBoundary = () => {
    const tip = JSON.parse(String(raw.prepare("SELECT tip_receipt_json FROM sync_relay_live_delivery_owners WHERE object_id='object'").get()!.tip_receipt_json));
    if (!tip) return {terminalReceipt: null, eventCount: 0, historyEvidenceDigest: initialAcceptedHistoryDigest(f.history.namespace, document)};
    const endpoint = raw.prepare("SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE object_id='object' AND journal_cursor=?")
      .get(tip.journalCursor)!;
    return {terminalReceipt: tip, eventCount: endpoint.accepted_event_count, historyEvidenceDigest: endpoint.accepted_evidence_digest};
  };
  const membership: {method: string; workspace?: string; params: unknown}[] = [];
  // A refused queue the engine keeps, with one entry, as the host's own connection reads it.
  // A granted Try again keeps the document's unload pending, as the engine does.
  // Its head's append key tells an adoption seed from later work. Other queues the test adds keep their own state; the engine
  // answers one it no longer holds as not found. `checkpoint` is the accepted state a recovery copy reads.
  // A drained one holds no pending entry, as once the engine abandoned its seed.
  type KeptOutbox = {binding: unknown; state: string; retryDeliveryId: string | null; appendKey: string; checkpoint?: Buffer; drained?: boolean};
  const keptOutbox: KeptOutbox = {binding: undefined, state: "quarantined", retryDeliveryId: null, appendKey: "append-1"};
  const keptOutboxes = new Map<string, KeptOutbox | null>();
  const outboxOf = (request: {id: number; params: Record<string, unknown>}) => {
    const found = keptOutboxes.get(String(request.params.outboxId));
    if (found === null) throw new EngineRequestError(request.id, {code: "INVALID_PARAMS", message: "owner-outbox-not-found", retry: "no"} as never);
    return found ?? keptOutbox;
  };
  // A queue holding its owner's refused adoption seed at the document's current restore generation, which no settlement passes.
  const seeded = (queue: KeptOutbox | null | undefined): queue is KeptOutbox => queue?.binding !== undefined && queue.state === "quarantined" &&
    queue.appendKey.startsWith("owner-adoption:") &&
    (engine.generation === undefined || engine.generation === (queue.binding as {restoreFenceGeneration: number}).restoreFenceGeneration);
  // Earlier stores open read-only for recovery, by workspace, at most one each as the engine allows.
  // Each serves its own queue, whose head's append key names its root.
  // A closing store reads nothing and keeps its workspace from opening another, as the engine's.
  const recoveryStores = new Map<string, {root: string; handle: string; closing?: boolean}>();
  let recoveryOpens = 0;
  // `loseOpen` loses the next open's answer after the engine opened the store; `failOpen` fails the next open before it opens;
  // `failClose` fails the next close before it closes; `preparing` answers that many recovery reads with `preparing`;
  // `failRead` fails the next recovery read, and `failCurrentRead` the next read of an attached store; while `worker`
  // is pending, the first close of a store times out and leaves it closing, and a later one waits for it.
  const recoveryFaults: {loseOpen?: boolean; failOpen?: Error; failClose?: Error; preparing?: number; failRead?: Error; failCurrentRead?: Error;
    worker?: Promise<void>} = {};
  const keptPage = (request: {id: number; params: Record<string, unknown>}, queue = outboxOf(request)) => {
    const {params} = request;
    const header = {outboxId: params.outboxId, binding: queue.binding, baseUpdateDigest: (queue.binding as {lineageClaimId: string}).lineageClaimId,
      baseByteLength: 1, state: queue.state, pendingBytes: queue.drained ? 0 : 1, pendingEntryCount: queue.drained ? 0 : 1, nextSequence: 2, oldestEntryAtMs: 1, quarantineReason: "invalid-update",
      observedBinding: null, retryDeliveryId: queue.retryDeliveryId}, update = Buffer.from([7]);
    const snapshot = sha256(Buffer.from(JSON.stringify(header))), cursor = (part: string, sequence = 0) => ({snapshot, part, sequence, offset: 0});
    const requested = (params.cursor as ReturnType<typeof cursor> | undefined) ?? cursor("header");
    if (requested.snapshot !== snapshot) return {kind: "readChanged"};
    // Outside the snapshot, as the engine's: the frozen answer and the checkpoint a copy reads now, which
    // a copy of a queue holding a refused seed, at any restore generation, must hold.
    const checkpointDigest = queue.checkpoint ? sha256(queue.checkpoint) : null;
    const refusedSeed = queue.state === "quarantined" && queue.appendKey.startsWith("owner-adoption:") && queue.retryDeliveryId === null;
    const live = {firstEntryCursor: queue.drained ? null : cursor("entryHeader", 1), frozenAtRefusedSeed: seeded(queue) && queue.retryDeliveryId === null,
      checkpointDigest, recoveryCheckpointDigest: refusedSeed ? checkpointDigest : null};
    if (requested.part === "checkpoint" && !queue.checkpoint) return {kind: "readChanged"};
    const [bytes, nextCursor] = requested.part === "header" ? [Buffer.from(JSON.stringify({...header, ...live})), cursor("base")] as const
      : requested.part === "checkpoint" ? [queue.checkpoint!, null] as const
      : requested.part === "entryHeader" ? [Buffer.from(JSON.stringify({sequence: 1, appendKey: queue.appendKey, deliveryId: "refused", updateDigest: sha256(update),
        byteLength: 1, createdAtMs: 1})), cursor("update", 1)] as const : [update, null] as const;
    return {kind: "page", ...requested, totalBytes: bytes.length, digest: sha256(bytes), bytesBase64: bytes.toString("base64"), nextCursor};
  };
  // As the engine refuses to settle past a seed frozen at the current generation.
  const seedFrozen = () => [keptOutbox, ...keptOutboxes.values()].some(seeded);
  let ownerRequests = 0, client!: ReturnType<typeof clientFrom>["client"] & {captureOwnerActivation: ReturnType<typeof vi.fn>;
    sendLiveApplication: ReturnType<typeof vi.fn>; readLiveApplicationAck: ReturnType<typeof vi.fn>; sendLiveOwnerAdoption: ReturnType<typeof vi.fn>};
  // The engine's reason for refusing native capture, as for a document with an open sync conflict, and its reasons for single paths.
  let refusal: Error | undefined, detachFailure: Error | undefined;
  const refusals = new Map<string, Error>();
  // Completed activations of other documents, by activation ID. Capture resumes one when named, and the owner
  // state of a registration for one reports its own adoption, with no native queue.
  const otherActivations = new Map<string, NativeOwnerActivation>();
  const registeredActivations = new Map<number, unknown>();
  spawn.mockImplementation(async options => {
    const captured = clientFrom(options), discovery = captured.client.sendRequest.getMockImplementation()!;
    client = Object.assign(captured.client, {captureOwnerActivation: vi.fn(async (_request: unknown, path: string, _maxBytes?: number,
      _signal?: AbortSignal, activationId?: string) => {
      const refused = refusals.get(path) ?? refusal;
      if (refused) throw refused;
      const captured = (activationId === undefined ? undefined : otherActivations.get(activationId)) ?? engine.capture;
      // A fresh capture has imported the current relay head; a resumed one keeps its saved source.
      if (activationId !== undefined) return captured;
      const committedCursor = Number(raw.prepare("SELECT COALESCE(MAX(relay_seq),0) AS cursor FROM sync_relay_log WHERE workspace_id=?")
        .get(captured.source.workspaceId)!.cursor);
      return {...captured, source: {...captured.source, committedCursor}};
    }),
      sendLiveOwnerAdoption: vi.fn(async (input: {id: number}, cut: {adoptionId: string; terminalReceipt: {journalCursor: number} | null}) => {
        const terminalCursor = cut.terminalReceipt?.journalCursor ?? 0;
        engine.adoption = {activationId: cut.adoptionId, throughCursor: terminalCursor};
        return {id: input.id, result: {status: "adopted", adoption: {adoptionId: cut.adoptionId, localYDocSequence: 2, terminalCursor, adoptionReplayed: false}}};
      }),
      sendLiveApplication: vi.fn(async (input: {id: number; registrationId: number}, event: {metadata: {accepted: {receipt: {deliveryId: string; journalCursor: number}}}}) => {
        if (retired(input.registrationId)) throw unavailable(input.id);
        const receipt = event.metadata.accepted.receipt;
        if (lost.pending) return {id: input.id, result: {status: "pending", reason: "application-pending"}};
        applied.set(receipt.deliveryId, {...receipt, localYDocSequence: receipt.journalCursor + 1});
        unsettled.add(receipt.deliveryId);
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
      for (const listener of [...requestListeners]) listener(request.method);
      if (request.method.startsWith("liveApplication.")) ownerRequests++;
      if (held?.method === request.method) { parked = undefined; held.entered.resolve(); await held.release.promise; }
      const reply = (result: unknown) => ({id: request.id, result}) as never;
      if (request.method !== "liveApplication.register" && retired(request.params?.registrationId ?? registrations?.live)) throw unavailable(request.id);
      if (/^liveApplication\.(attach|detach|unload)/.test(request.method)) membership.push({method: request.method, workspace: request.workspace, params: request.params});
      switch (request.method) {
        case "liveApplication.hosts": return discovery();
        case "liveApplication.releaseOwnerActivation": return reply({released: true});
        case "liveApplication.attachWorkspace": return reply({workspaceId: request.params.workspaceId,
          workspaceHandle: request.params.workspaceId === "workspace" ? "attached-handle" : `attached-${request.params.workspaceId}`});
        case "liveApplication.detachWorkspace": if (detachFailure) throw detachFailure; return reply({detached: true});
        case "liveApplication.unloadDocument": {
          if ([keptOutbox, ...keptOutboxes.values()].some(queue => queue && queue.retryDeliveryId !== null)) return reply({status: "pending", reason: "delivery-pending"});
          // As the engine's settlement clause, which a queue frozen at its owner's adoption seed excuses.
          if (unsettled.size && !seedFrozen()) return reply({status: "pending", reason: "settlement-pending"});
          const next = unloads.shift() ?? {status: "unloaded"};
          if (next instanceof Error) throw next;
          return reply(next);
        }
        // Native registration accepts exactly the binding and the activation it serves.
        case "liveApplication.register": {
          if (Object.keys(request.params).join() !== "binding,activationId") throw new Error("INVALID_PARAMS: invalid-live-registration");
          if (registrationRefusal) throw registrationRefusal;
          let registrationId: number;
          if (!registrations) {
            if (!registrationsByObject) registrationId = 7;
            else {
              const objectId = (request.params.binding as {objectId: string}).objectId;
              if (!registrationsByObject.has(objectId)) registrationsByObject.set(objectId, 7 + registrationsByObject.size);
              registrationId = registrationsByObject.get(objectId)!;
            }
          } else registrationId = registrations.live = ++registrations.next;
          registeredActivations.set(registrationId, request.params.activationId);
          return reply({registrationId});
        }
        case "liveApplication.ownerState": {
          const registeredActivation = registeredActivations.get(request.params.registrationId as number);
          if (otherActivations.has(String(registeredActivation))) return reply({adoptionId: registeredActivation, expectedLocalSequence: 2,
            throughCursor: 0, outboxId: null, pendingBytes: 0, outboxState: "active", retryDeliveryId: null});
          return reply({adoptionId: engine.adoption.activationId, expectedLocalSequence: 2,
          throughCursor: engine.adoption.throughCursor, outboxId: native.outboxId, pendingBytes: native.outboxId ? nativeBytes() : 0,
          outboxState: native.state, retryDeliveryId: native.retryDeliveryId});
        }
        // As the engine's, a preparation needs every queue of the activation to hold nothing deliverable and no Try again.
        case "liveApplication.prepareRetirement": {
          if (engine.prepareFailure) throw engine.prepareFailure;
          validatePreparationParams(request.params);
          const deliverable = native.entries.length > 0 && (native.state === "active" || native.retryDeliveryId !== null);
          const granted = native.retryDeliveryId !== null || [keptOutbox, ...keptOutboxes.values()].some(queue => queue && queue.retryDeliveryId !== null);
          if (deliverable || granted) return reply(granted ? preparationWire.retryOutstanding : preparationWire.nativePending);
          engine.prepared = {...request.params};
          return reply(preparationWire.prepared);
        }
        case "liveApplication.releaseRetirementPreparation": {
          if (engine.releaseFailure) throw engine.releaseFailure;
          validatePreparationParams(request.params);
          const released = JSON.stringify(engine.prepared) === JSON.stringify(request.params);
          if (released) engine.prepared = undefined;
          return reply(released ? preparationWire.released : preparationWire.notReleased);
        }
        case "liveApplication.reconcileActivation": {
          // Its retirement began, which ends the block.
          engine.prepared = undefined;
          if (engine.refusal) throw engine.refusal;
          if (request.params.journal) {engine.journals.push(request.params.journal); engine.unproven = [];}
          if (engine.unproven.length) return reply({status: "pending", reason: "delivery", deliveries: engine.unproven});
          // A refused seed holds the retirement until the journal proves it absent, and the engine abandons it
          // only when nothing applied it: its queue keeps its quarantine and refusal for the owner's copy.
          if (seedFrozen()) {
            if (!request.params.journal || !engine.abandonableSeed) return reply({status: "pending", reason: "seed-quarantined", deliveries: ["refused"]});
            for (const queue of [keptOutbox, ...keptOutboxes.values()]) if (seeded(queue)) Object.assign(queue, {appendKey: "append-1", drained: true});
          }
          const after = (request.params.afterReceipt as {journalCursor: number} | null)?.journalCursor ?? 0;
          const cursor = (ack: Record<string, unknown>) => ack.journalCursor as number;
          const all = [...applied.values()].filter(ack => cursor(ack) > after && cursor(ack) <= (request.params.acceptedThrough as number))
            .sort((a, b) => cursor(a) - cursor(b)).map(ack => ({...ack, applicationReplayed: true}));
          const adoption = engine.adoption.throughCursor === null || engine.adoption.activationId !== request.params.activationId ? null
            : {adoptionId: engine.adoption.activationId, localYDocSequence: 2, terminalCursor: engine.adoption.throughCursor, adoptionReplayed: true};
          const max = request.params.maxApplications as number;
          engine.reconciledThrough = all.length ? cursor(all.at(-1)!) : after;
          return reply({status: "reconciled", adoption, applications: all.slice(0, max), hasMoreApplications: all.length > max,
            settle: adoption !== null && engine.settledThrough !== engine.reconciledThrough});
        }
        case "liveApplication.releaseActivation": {
          const adoptedHere = engine.adoption.throughCursor !== null, replayed = engine.boundary !== undefined;
          if (adoptedHere && !replayed) {
            if (engine.unpushed || ((replies.commit.departed ?? []) as string[]).includes(document.objectId)) return reply({status: "pending", reason: "parking"});
            if (engine.releasePending) return reply({status: "pending", reason: engine.releasePending});
            if (engine.unproven.length || engine.settledThrough !== engine.reconciledThrough) return reply({status: "pending", reason: "reconciliation"});
          }
          engine.boundary ??= adoptedHere ? ownerBoundary() : null;
          return reply({status: "released", replayed, boundary: engine.boundary});
        }
        case "liveApplication.settle": {
          if (seedFrozen()) throw new EngineRequestError(request.id, {code: "INVALID_PARAMS", message: "live-application-invalid-input", retry: "no"} as never);
          const terminal = request.params.terminalReceipt as {journalCursor: number} | null;
          // A retirement's settlement that reached the file leaves output its replica must push before the document parks.
          if (request.params.retirement && settlement.materialized) {engine.settledThrough = terminal?.journalCursor ?? 0; engine.unpushed++;}
          if (settlement.materialized) unsettled.clear();
          return reply({status: "settled", settlement: {settlementId: "settlement", previousCursor: 0, terminalCursor: terminal?.journalCursor ?? 0,
            applicationCount: 0, localYDocSequence: 2, momentId: "settled-moment", markdownDigest: "c".repeat(64), materialized: settlement.materialized,
            collectionReconcileRequired: false}});
        }
        case "liveApplication.fenceRestore": return reply({status: "pending", reason: "native-fence-pending"});
        // Unless `fenceCommitted` says the native fence committed, a Decline ends the restore at its old generation,
        // under the binding it began with. After a committed fence, it keeps the fenced generation.
        case "liveApplication.cancelRestoreFence": {
          const basis = JSON.parse(String(raw.prepare("SELECT basis_json FROM sync_relay_live_restore_operations WHERE operation_id=?").get(request.params.operationId as string)!.basis_json));
          const newFence = request.params.newFence as number;
          if (!engine.fenceCommitted) return reply({status: "cancelled", hostId: request.params.hostId, generation: newFence - 1, binding: basis.ownerBinding});
          const saved = f.storage.readStopRestore(stopLookup)!, fence = nativeRestoreFence(saved.applied!, newFence, saved.intent);
          const binding = {...fence.oldBinding, restoreFenceGeneration: newFence}, endpoint = fence.terminal === null
            ? {terminalReceipt: null, eventCount: 0, historyEvidenceDigest: initialAcceptedHistoryDigest(f.history.namespace, document)}
            : (row => ({terminalReceipt: fence.terminal, eventCount: row.accepted_event_count, historyEvidenceDigest: row.accepted_evidence_digest}))(
              raw.prepare("SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE object_id='object' AND journal_cursor=?")
                .get(fence.terminal.journalCursor)!);
          engine.generation = newFence;
          return reply({status: "fenceCancelled", hostId: request.params.hostId, generation: newFence, binding,
            receipt: {fence: {operation: fence, localHeadSequence: fence.appliedSequence, recordedAtMs: 55}, binding, endpoint, recordedAtMs: 55}});
        }
        case "ydoc.ownerOutbox.retry":
          if (request.params.outboxId === NATIVE) {native.retryDeliveryId = native.entries[0]!.deliveryId; return reply({retryDeliveryId: native.retryDeliveryId});}
          outboxOf(request).retryDeliveryId = "refused"; return reply({retryDeliveryId: "refused"});
        case "ydoc.ownerOutbox.quarantine": {
          if (request.params.outboxId === NATIVE) {native.state = "quarantined"; native.retryDeliveryId = null; return reply({});}
          const queue = outboxOf(request); queue.state = "quarantined"; queue.retryDeliveryId = null; return reply({});
        }
        case "ydoc.ownerOutbox.acknowledge": {
          const head = native.entries[0], receipts = request.params.receipts as {deliveryId: string}[];
          if (request.params.outboxId !== NATIVE || !head || receipts.length !== 1 || receipts[0]!.deliveryId !== head.deliveryId ||
            (native.state === "quarantined" && native.retryDeliveryId !== head.deliveryId)) {
            throw new EngineRequestError(request.id, {code: "INVALID_PARAMS", message: "owner-outbox-receipt-mismatch", retry: "no"} as never);
          }
          if (native.loseAcks.has(head.deliveryId)) throw new Error("Acknowledgement lost.");
          native.entries.shift();
          if (native.state === "quarantined") {native.state = "active"; native.retryDeliveryId = null;}
          return reply({acknowledged: 1, pendingBytes: nativeBytes(), oldestEntryAtMs: native.entries.length ? 1 : null});
        }
        case "ydoc.ownerOutbox.readPending": {
          if (request.params.outboxId === NATIVE) return reply(nativePage(request.params));
          if (!request.workspace?.startsWith("recovery-")) {
            const currentFailure = recoveryFaults.failCurrentRead;
            if (currentFailure) {recoveryFaults.failCurrentRead = undefined; throw currentFailure;}
            return reply(keptPage(request));
          }
          const open = [...recoveryStores.values()].find(store => store.handle === request.workspace);
          if (!open || open.closing) throw new EngineRequestError(request.id, {code: "WORKSPACE_UNAVAILABLE", message: "workspace handle is unavailable", retry: "no"} as never);
          if (recoveryFaults.preparing) {recoveryFaults.preparing--; return reply({kind: "preparing"});}
          const readFailure = recoveryFaults.failRead;
          if (readFailure) {recoveryFaults.failRead = undefined; throw readFailure;}
          return reply(keptPage(request, {binding: keptOutbox.binding, state: "quarantined", retryDeliveryId: null, appendKey: open.root}));
        }
        case "liveApplication.openRecoveryStore": {
          const openFailure = recoveryFaults.failOpen;
          if (openFailure) {recoveryFaults.failOpen = undefined; throw openFailure;}
          const {root, workspaceId} = request.params as {root: string; workspaceId: string}, open = recoveryStores.get(workspaceId);
          if (open && (open.root !== root || open.closing)) throw new EngineRequestError(request.id, {code: "CONFLICT", message: "a recovery store is already open for this workspace", retry: "no"} as never);
          recoveryStores.set(workspaceId, open ?? {root, handle: `recovery-${++recoveryOpens}`});
          if (recoveryFaults.loseOpen) {recoveryFaults.loseOpen = false; throw new Error("Open reply lost.");}
          return reply({workspaceHandle: recoveryStores.get(workspaceId)!.handle});
        }
        case "liveApplication.closeRecoveryStore": {
          const open = [...recoveryStores].find(([, store]) => store.handle === request.workspace), failure = recoveryFaults.failClose;
          if (failure) {recoveryFaults.failClose = undefined; throw failure;}
          if (!open) throw new EngineRequestError(request.id, {code: "WORKSPACE_UNAVAILABLE", message: "workspace handle is unavailable", retry: "no"} as never);
          const worker = recoveryFaults.worker;
          if (worker && !open[1].closing) {
            open[1].closing = true;
            throw new EngineRequestError(request.id, {code: "DEADLINE_EXCEEDED", message: "request deadline exceeded", retry: "afterBackoff"} as never);
          }
          await worker;
          recoveryStores.delete(open[0]);
          return reply({closed: true});
        }
        case "sync.createHostedReplica":
          if (replies.create) throw replies.create === "diverged" ? divergence(request.id) : replies.create;
          return reply({hosted: true});
        // A push waiting for owner admission pushes nothing.
        case "sync.push": {
          pushed.resolve();
          if (!((replies.push.ownerAdmissionPending ?? []) as unknown[]).length) engine.unpushed = 0;
          return reply({...pushReply, ...replies.push});
        }
        case "sync.pullHosted": {
          if (replies.diverge) throw divergence(request.id);
          const pass = hostedPass(replies.pass), holds = pass.held as {objectId: string}[];
          const held = page(holds.map(hold => hold.objectId), request.params.heldAfter as string | undefined, replies.heldPerPass);
          departedAfter = request.params.departedAfter as string | undefined;
          const departed = page(pass.departed as string[], departedAfter, replies.departedPerPass);
          return reply({...pass, held: holds.filter(hold => held.listed.includes(hold.objectId)), heldThrough: held.through,
            departed: departed.listed, departedThrough: departed.through});
        }
        case "sync.materializePendingCursor": return reply({materialized: true});
        case "sync.commitCursor": {
          if (replies.loseCommit) {replies.loseCommit = false; throw new Error("Commit reply lost.");}
          const commit = hostedCommit(replies.commit);
          if (!commit.departed) return reply(commit);
          // A document with output still unpushed cannot park, so its replica lists it departed.
          const listed = commit.departed as string[];
          const departed = page(engine.unpushed && !listed.includes(document.objectId) ? [...listed, document.objectId].sort() : listed,
            departedAfter, replies.departedPerPass);
          return reply({...commit, departed: departed.listed, departedThrough: departed.through});
        }
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
  // The owner's restore begins and revokes the share's only Edit grant. `restore` also fences it.
  const beginRestore = () => {
    const plan = f.storage.readStopRestorePlan({document, ownerUserId: "owner", operationId: "restore", shareId: "share", grantId: "grant",
      restorePointCursor: 0, restorePointReceiptDigest: document.lineageClaimId, maxOutputBytes: 1_000_000});
    f.storage.beginStopRestore(plan.intent, 40);
  };
  // Owner edits the native session appended to its queue in order, each on the state before it.
  const nativeEdits = (...values: string[]) => {
    const read = f.storage.readLiveUpdateJournalCut({document});
    if (read.kind !== "cut") throw new Error("Missing live journal.");
    const doc = new Y.Doc();
    for (const bytes of [read.cut.checkpoint.bytes, ...read.cut.suffix.map(row => row.bytes)]) Y.applyUpdate(doc, bytes);
    for (const value of values) {
      const vector = Y.encodeStateVector(doc); doc.getMap("frontmatter").set("edit", value);
      native.entries.push({sequence: native.nextSequence++, deliveryId: `edit-${value}`, update: Buffer.from(Y.encodeStateAsUpdate(doc, vector))});
    }
    doc.destroy();
    native.outboxId = NATIVE;
  };
  const host = await startServiceLiveHost({...f, ...(options.frameChanges ? {frameChanges: createNamedFrameChanges(16)} : {}),
    ...(options.firstOpen ? {firstOpen: options.firstOpen} : {})});
  cleanup.push(() => host.close());
  // The activation pass publishes readiness before it pushes the hosted replica.
  if (!options.empty) await pushed.promise;
  return {f, raw, host, document, workspace, target, pushed, unloads, replies, settlement, engine, membership, keptOutbox, keptOutboxes, recoveryStores, recoveryFaults,
    native, nativeEdits, nativeHeadBytes, requestListeners,
    spawned: () => spawn.mock.calls.length, client: () => client,
    ownerRequests: () => ownerRequests,
    ownerCalls: () => client.sendRequest.mock.calls.map(call => (call as unknown[])[0] as {method: string; params: unknown})
      .filter(request => request.method.startsWith("liveApplication.")).map(request => [request.method, request.params]),
    refuseCapture(error: Error | undefined) {refusal = error;},
    refuseCaptureAt(path: string, error: Error | undefined) {if (error) refusals.set(path, error); else refusals.delete(path);},
    otherActivations,
    refuseRegistration(error: Error | undefined) {registrationRefusal = error;},
    failDetach(error: Error | undefined) {detachFailure = error;},
    applied, lost,
    freshRegistrations() {registrations = {next: 100, live: 0};},
    distinctRegistrations() {return registrationsByObject = new Map([[document.objectId, 7]]);},
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
    retiredTip: () => JSON.parse(String(raw.prepare("SELECT tip_receipt_json FROM sync_relay_live_delivery_owner_history WHERE object_id='object'").get()!.tip_receipt_json)),
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
    beginRestore,
    restore() {
      beginRestore();
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
    ["liveApplication.register", {binding: current.binding, activationId: `ordinary-activation-${"a".repeat(64)}`}],
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
// Once `passes.deliver` is false, passes leave the sibling's delivery to the test.
async function emptyServiceHost(options: {frameChanges?: boolean; maxDocumentsPerPass?: number; adopted?: boolean; maxApplications?: number;
  limits?: DrainLimits; passDeadlineMs?: number; pollIntervalMs?: number; firstOpen?: FirstOpenOptions; selfHosted?: boolean; restore?: boolean} = {}) {
  const o = await completedServiceOwner({empty: true, ...options});
  const sibling = {workspaceId: "workspace", objectId: "object", path: "docs/a.md", shareId: "share"};
  const other = {workspaceId: "workspace", objectId: "object-b", path: "docs/b.md", shareId: "share"};
  const activate = ServiceActivationDriver.prototype.activate, loaded = ServiceActivationDriver.prototype.loaded, passes = {deliver: true};
  vi.spyOn(ServiceActivationDriver.prototype, "activate").mockImplementation(function (this: ServiceActivationDriver, ...args) {
    if (!passes.deliver && args[0].path === sibling.path) return Promise.resolve({kind: "pending" as const, reason: "paused"});
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
  return {...o, sibling, other, attach, detach, pullCount, passes, unload: {method: "liveApplication.unloadDocument", workspace: "attached-handle", params: {objectId: other.objectId}},
    // Resolves once a pull that began after the current one has been sent, on the second new pull. A ready
    // workspace whose replica waits on nothing pulls only for a relay change; wait on `nextPass` for it.
    nextPull() {
      let seen = 0;
      return new Promise<void>(resolve => {
        const listener = (method: string) => {if (method === "sync.pullHosted" && ++seen === 2) {o.requestListeners.delete(listener); resolve();}};
        o.requestListeners.add(listener);
      });
    },
    nextPass: () => afterPasses(o.f)};
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

// Proves: a held-document read the engine is still answering when its
// workspace detaches, or this host's registration retires, comes back as that
// invalidation, never as a failure, and the owner route answers it as a missing
// document. A read the engine fails while both stand stays a failure.
it("answers a held-document read its detach or retired registration overtook as nothing there", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const send = o.client().sendRequest, through = send.getMockImplementation()! as (...args: unknown[]) => ReturnType<typeof send>;
  let engine: () => Promise<unknown> = async () => null;
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as {id: number; method: string};
    return request.method === "sync.heldDocument" ? {id: request.id, result: await engine()} as never : through(...args);
  });
  // The engine's next held-document answers wait for `release`, once one is asked, then `answer`.
  const holding = (answer: () => unknown) => {
    const asked = deferred<void>(), release = deferred<void>();
    engine = async () => {asked.resolve(); await release.promise; return answer();};
    return {asked: asked.promise, release: () => release.resolve()};
  };
  const routes = createHeldDocumentRoutes({storage: o.f.storage, host: () => o.host});
  const read = () => routes(new Request("http://relay.test/sync/workspace/held-documents/object"),
    {route: "held-documents", workspaceId: "workspace", objectId: "object"}, "owner");

  engine = async () => {throw new Error("engine connection closed");};
  await expect(o.host.heldDocument("workspace", "object", {markdown: false})).rejects.toThrow("engine connection closed");
  await expect(read()).rejects.toThrow("engine connection closed");

  // The engine's connection to the workspace ends with it: the read fails, and the recheck finds why.
  const detaching = holding(() => {throw new Error("engine connection closed");}), detached = read();
  await detaching.asked;
  await o.host.update({workspaces: [], documents: [], ...stay});
  detaching.release();
  await expect(detached).rejects.toMatchObject({code: "not_found"});

  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(async () => log.mockRestore());
  // The engine answers, but the host that asked no longer stands.
  const retiring = holding(() => null), retired = o.host.heldDocument("workspace", "object", {markdown: false});
  await retiring.asked;
  o.raw.exec("UPDATE sync_relay_session_host_control SET admission_state='closed', registered_connection_id=NULL");
  retiring.release();
  await expect(retired).resolves.toEqual({invalidated: "registration"});
  await expect(read()).rejects.toMatchObject({code: "not_found"});
});

// Proves: held reads run in their own lane on the native client, so a held
// read neither waits behind an ordinary engine request nor holds one back, and
// its caller's signal cancels the engine request it waits on. The cancelled read
// keeps its workspace until the engine answers.
it("answers held reads beside ordinary engine requests, and cancels one on its caller's signal", async () => {
  const o = await emptyServiceHost({frameChanges: true}), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const send = o.client().sendRequest, through = send.getMockImplementation()! as (...args: unknown[]) => ReturnType<typeof send>;
  let engine: (args: unknown[]) => Promise<unknown> = async () => null;
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as {id: number; method: string};
    return request.method === "sync.heldDocument" ? {id: request.id, result: await engine(args)} as never : through(...args);
  });

  // An ordinary pull holds the only ordinary slot while a held read completes.
  const pull = o.park("sync.pullHosted");
  await pull.entered.promise;
  let answered = false;
  const beside = o.host.heldDocument("workspace", "object", {markdown: false}).then(value => {answered = true; return value;});
  await vi.waitFor(() => expect(answered).toBe(true));
  await expect(beside).resolves.toBeNull();
  pull.release.resolve();

  // A held read the engine is still answering leaves ordinary pulls running.
  const asked = deferred<void>(), answer = deferred<void>();
  engine = async () => {asked.resolve(); await answer.promise; return null;};
  const reading = o.host.heldDocument("workspace", "object", {markdown: false});
  await asked.promise;
  await o.nextPull();
  answer.resolve();
  await expect(reading).resolves.toBeNull();

  const entered = deferred<unknown[]>(), stopped = deferred<void>(), caller = new AbortController();
  engine = async args => {entered.resolve(args); await stopped.promise; throw new Error("cancelled by the engine");};
  const cancelled = o.host.heldDocument("workspace", "object", {markdown: false}, caller.signal);
  const [, engineSignal, , cancelSignal] = await entered.promise as [{id: number}, AbortSignal | undefined, unknown, AbortSignal];
  expect(engineSignal).toBeUndefined();
  expect(cancelSignal.aborted).toBe(false);
  const refused = expect(cancelled).rejects.toThrow("caller left");
  caller.abort(new Error("caller left")); await refused;
  expect(cancelSignal.aborted).toBe(true);
  await expect(o.host.heldDocument("workspace", "object", {markdown: false})).rejects.toBeInstanceOf(HeldReadBusyError);
  engine = async () => null;
  stopped.resolve();
  await vi.waitFor(() => expect(o.host.heldDocument("workspace", "object", {markdown: false})).resolves.toBeNull());
});

// Proves: the engine's cancellation, sent in place of an answer it already had,
// frees a cancelled held read's lane slot well before the request deadline. The
// engine refusing a second proof for the workspace reaches the owner as 429, and
// a caller who lost ownership meanwhile as nothing there.
it("frees a cancelled held read's slot on the engine's answer, and answers the engine's busy refusal 429 to the owner alone", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const send = o.client().sendRequest, through = send.getMockImplementation()! as (...args: unknown[]) => ReturnType<typeof send>;
  let engine: (request: {id: number}, cancel?: AbortSignal) => Promise<unknown> = async () => null;
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as {id: number; method: string};
    return request.method === "sync.heldDocument" ? {id: request.id, result: await engine(request, args[3] as AbortSignal | undefined)} as never : through(...args);
  });

  // The read answered, then its caller left: the engine answers the cancel with CANCELLED.
  const entered = deferred<void>();
  engine = (request, cancel) => new Promise((_resolve, reject) => {
    cancel?.addEventListener("abort", () => reject(new EngineRequestError(request.id, {code: "CANCELLED", message: "held document answer cancelled", retry: "no"})), {once: true});
    entered.resolve();
  });
  const caller = new AbortController();
  const cancelled = o.host.heldDocument("workspace", "object", {markdown: false}, caller.signal);
  await entered.promise;
  const refused = expect(cancelled).rejects.toThrow("caller left");
  caller.abort(new Error("caller left")); await refused;
  engine = async () => null;
  // Far inside the 1 s request deadline, which would free it otherwise.
  await vi.waitFor(() => expect(o.host.heldDocument("workspace", "object", {markdown: false})).resolves.toBeNull(), {timeout: 250});

  const busy = () => new EngineRequestError(0, {code: "OVERLOADED", message: "held-read-busy", retry: "afterBackoff"});
  engine = async () => {throw busy();};
  await expect(o.host.heldDocument("workspace", "object", {markdown: false})).rejects.toBeInstanceOf(HeldReadBusyError);
  const routes = createHeldDocumentRoutes({storage: o.f.storage, host: () => o.host});
  const read = () => routes(new Request("http://relay.test/sync/workspace/held-documents/object"),
    {route: "held-documents", workspaceId: "workspace", objectId: "object"}, "owner");
  await expect(read()).rejects.toMatchObject({code: "held_read_busy"});
  const asked = deferred<void>(), release = deferred<void>();
  engine = async () => {asked.resolve(); await release.promise; throw busy();};
  const lost = read();
  await asked.promise;
  o.raw.exec("UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id='workspace'");
  release.resolve();
  await expect(lost).rejects.toMatchObject({code: "not_found"});
});

// Proves: the engine refusing a held answer larger than it keeps for one
// reaches the owner as 413, a refusal asking again cannot change, never as a
// generic engine failure; a caller who lost ownership meanwhile learns nothing.
it("answers the engine's too-large refusal of a held read 413 to the owner alone", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const send = o.client().sendRequest, through = send.getMockImplementation()! as (...args: unknown[]) => ReturnType<typeof send>;
  const tooLarge = () => new EngineRequestError(0, {code: "PAYLOAD_TOO_LARGE", message: "held-read-too-large", retry: "no"});
  let engine: () => Promise<unknown> = async () => {throw tooLarge();};
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as {id: number; method: string};
    return request.method === "sync.heldDocument" ? {id: request.id, result: await engine()} as never : through(...args);
  });

  await expect(o.host.heldDocument("workspace", "object", {markdown: false})).rejects.toBeInstanceOf(HeldReadTooLargeError);
  const routes = createHeldDocumentRoutes({storage: o.f.storage, host: () => o.host});
  const read = () => routes(new Request("http://relay.test/sync/workspace/held-documents/object"),
    {route: "held-documents", workspaceId: "workspace", objectId: "object"}, "owner");
  await expect(read()).rejects.toMatchObject({code: "payload_too_large", statusCode: 413});
  const asked = deferred<void>(), release = deferred<void>();
  engine = async () => {asked.resolve(); await release.promise; throw tooLarge();};
  const lost = read();
  await asked.promise;
  o.raw.exec("UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id='workspace'");
  release.resolve();
  await expect(lost).rejects.toMatchObject({code: "not_found"});
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
// With `supervised`, the self-host supervisor runs the host as its daemon,
// configured for restore, and sends it every membership update.
async function enrolledServiceHost({freshRegistrations = false, frameChanges = false, maxApplications = 8, limits = {} as DrainLimits, supervised = false} = {}) {
  const o = await emptyServiceHost({frameChanges, maxApplications, limits, selfHosted: supervised, restore: supervised});
  if (freshRegistrations) o.freshRegistrations();
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 10, guard() {}});
  const errors: unknown[] = [];
  let supervisor: Awaited<ReturnType<typeof startSelfHostedLiveHost>> | undefined;
  if (supervised) {
    const data = join(o.f.root, "self-host"); await mkdir(data);
    supervisor = await startSelfHostedLiveHost({trustedAccount: o.f.trustedAccount, storage: o.f.storage, history: o.f.history, root: data,
      engineExecutable: process.execPath, relayOrigin: "https://relay.test", key: new Uint8Array(32).fill(9), frameChanges: createNamedFrameChanges(16),
      startHost: async () => o.host, onError: error => errors.push(error)});
    cleanup.push(() => supervisor!.close());
  } else await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true), {timeout: 10_000});
  const binding = o.f.storage.resolveCurrentLiveDocumentBinding({document: o.document, actor: {kind: "owner", userId: "owner", shareId: "share"}});
  if (binding.kind !== "current") throw new Error("Missing live binding.");
  const calls = (from: number) => o.ownerCalls().slice(from).map(([method]) => method as string);
  return {...o, binding: binding.binding, calls, supervisor, errors,
    // The owner's Stop, which fences the document at once.
    stop() {
      expect(preparedStop(o.f.storage, {workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path,
        enabled: false, retire: true, nowMs: 20, guard() {}})).toMatchObject({enabled: false, retired: true});
    },
    depart: (host = o.host) => host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]})};
}

const preparationWire = JSON.parse(readFileSync(new URL("../../../crates/dohc-workspace-engine/tests/retirement-preparation.json", import.meta.url), "utf8")) as {
  params: Record<string, string | number>; prepared: {status: "prepared"}; nativePending: {status: "pending"; reason: "native-pending"};
  retryOutstanding: {status: "pending"; reason: "retry-outstanding"}; released: {released: true}; notReleased: {released: false};
  errors: Record<string, NonNullable<EngineRequestError["wireError"]>>;
};
function validatePreparationParams(params: Record<string, unknown>): void {
  if (Object.keys(params).sort().join() !== Object.keys(preparationWire.params).sort().join() ||
    Object.entries(preparationWire.params).some(([key, value]) => typeof params[key] !== typeof value)) {
    throw new Error("INVALID_PARAMS: invalid-retirement-preparation");
  }
}
const ACTIVATION = `ordinary-activation-${"a".repeat(64)}`, SUCCESSOR = `ordinary-activation-${"b".repeat(64)}`;
// The engine requests of a retirement, without a restarted daemon's membership requests.
const retirement = ["liveApplication.reconcileActivation", "liveApplication.settle", "liveApplication.releaseActivation"];
const departed = (methods: string[]) => methods.filter(method => !["liveApplication.hosts", "liveApplication.attachWorkspace"].includes(method));
// The retired activation's row, and the boundary its release kept.
const retiredRow = (o: Awaited<ReturnType<typeof enrolledServiceHost>>) => {
  const row = o.raw.prepare("SELECT retired_at_ms,retired_boundary_json FROM sync_relay_service_activations WHERE activation_id=?").get(ACTIVATION)!;
  return {retired: row.retired_at_ms !== null, boundary: row.retired_boundary_json === null ? undefined : JSON.parse(String(row.retired_boundary_json))};
};
// The retirement form of each settlement sent since `from`.
const retiringSettles = (o: Awaited<ReturnType<typeof enrolledServiceHost>>, from: number) =>
  o.ownerCalls().slice(from).filter(([method, params]) => method === "liveApplication.settle" && Object.hasOwn(params as object, "retirement"));

// Proves: Stop ends editing authority, not the host's duty to settle what it
// already applied. The stopped activation's retirement reconciles it with the
// engine, settles through the tip the relay recorded and publishes, with no
// delivery, admission or ordinary unload. Its release waits for a pull that
// confirms the document left its hosted scope, then for a settlement that
// reached the file; the relay then retires it at the boundary the engine
// kept, and its workspace drains. Its accepted cut stays.
it("retires a stopped last document once it settled and published and a pull confirmed it left, without an unload", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const cut = o.f.storage.readLiveUpdateJournalCut({document: o.document}), tip = o.tip();
  o.settlement.materialized = false;
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(retiringSettles(o, sent).length).toBeGreaterThan(0));
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  // A pull confirms it left, but nothing settled into the file, so it is not released. Its workspace keeps pushing and pulling.
  const pushes = () => o.client().sendRequest.mock.calls.filter(call => ((call as unknown[])[0] as {method: string}).method === "sync.push").length;
  const pushed = pushes();
  await o.nextPull();
  expect(pushes()).toBeGreaterThan(pushed);
  expect(o.calls(sent)).not.toContain("liveApplication.releaseActivation");
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.drained("workspace")).toBe(false);
  o.settlement.materialized = true;
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  const key = {objectId: "object", lineageClaimId: o.document.lineageClaimId, activationId: ACTIVATION,
    restoreFenceGeneration: o.binding.restoreFenceGeneration, acceptedThrough: tip.journalCursor};
  const calls = o.ownerCalls().slice(sent);
  expect(new Set(calls.map(([method]) => method))).toEqual(new Set(retirement));
  expect(calls).toContainEqual(["liveApplication.reconcileActivation", {...key, afterReceipt: tip, maxApplications: 8}]);
  expect(retiringSettles(o, sent).at(-1)).toEqual(["liveApplication.settle", {retirement: key, terminalReceipt: tip}]);
  expect(calls.at(-1)).toEqual(["liveApplication.releaseActivation", key]);
  // It published after its last settlement and before its release.
  const methods = o.client().sendRequest.mock.calls.map(call => ((call as unknown[])[0] as {method: string}).method);
  const released = methods.lastIndexOf("liveApplication.releaseActivation");
  expect(methods.lastIndexOf("sync.push", released)).toBeGreaterThan(methods.lastIndexOf("liveApplication.settle", released));
  expect(o.membership.filter(row => row.method === "liveApplication.unloadDocument")).toEqual([]);
  expect(o.client().sendLiveApplication).not.toHaveBeenCalled();
  expect(retiredRow(o)).toEqual({retired: true, boundary: o.engine.boundary});
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull();
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  await expect(o.host.detachDrained("workspace")).resolves.toBe(true);
  expect(o.membership.at(-1)).toEqual(o.detach);
  expect(o.f.storage.readLiveUpdateJournalCut({document: o.document})).toEqual(cut);
  expect(o.client().close).not.toHaveBeenCalled();
});

// A refused queue the server keeps for the enrolled document, with its engine requests.
function keptEdits(o: Awaited<ReturnType<typeof enrolledServiceHost>>) {
  o.keptOutbox.binding = o.binding;
  let refusals = 0;
  const identity = o.workspace.hostedReplication!.identity;
  const refuse = () => o.f.storage.recordServiceKeptEdits({identity, outboxId: "kept-outbox", binding: o.binding, reason: "invalid-update", headDeliveryId: "refused",
    refusalKey: `refusal-${++refusals}`, nowMs: 1});
  refuse();
  const engine = (method: string) => o.client().sendRequest.mock.calls.map(call => (call as unknown[])[0] as {method: string; workspace?: string; params: unknown})
    .filter(request => request.method === method);
  // Another refused queue of the document, recorded before `kept-outbox` refuses again, with its own engine state.
  const other = (outboxId: string, copied = true) => {
    o.keptOutboxes.set(outboxId, {binding: o.binding, state: "quarantined", retryDeliveryId: null, appendKey: "append-1"});
    o.f.storage.recordServiceKeptEdits({identity, outboxId, binding: o.binding, reason: "invalid-update", headDeliveryId: "refused", refusalKey: `${outboxId}-refusal`, nowMs: 1});
    if (copied) o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId, generation: o.f.storage.readServiceKeptEdits(queue(outboxId))!.generation,
      checkpointDigest: null});
  };
  // A queue of the attached store.
  const queue = (outboxId: string) => ({workspaceId: "workspace", identity, outboxId});
  return {refuse, other, engine, identity, queue, row: () => o.f.storage.readServiceKeptEdits(queue("kept-outbox"))};
}

// Proves: a stopped document whose owner has no recovery copy of edits the
// server kept departs as an ordinary unload, then stays, with its workspace
// attached, through later passes. A Try again granted before Stop ends,
// keeping the queue. Once the owner confirms a copy, its retirement proves the
// refused edit absent from the journal and completes, its workspace drains and
// its rows go. Try again needs the live authority Stop ended; on a hosted
// document it grants the refused head through the host's own connection.
it("ends a Try again Stop left outstanding, and keeps the stopped document until its owner confirms a recovery copy", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(o.host.retryKeptEdits(k.row()!, () => {})).resolves.toBe("granted");
  expect(k.engine("ydoc.ownerOutbox.retry")).toEqual([expect.objectContaining({workspace: "attached-handle", params: {outboxId: "kept-outbox", binding: o.binding}})]);
  expect(k.row()).toMatchObject({retrying: true});
  o.stop();
  await expect(o.host.retryKeptEdits(k.row()!, () => {})).resolves.toBe("unavailable");
  expect(k.engine("ydoc.ownerOutbox.retry")).toHaveLength(1);
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")));
  // The grant ended, and the queue stays quarantined with its bytes.
  expect(o.keptOutbox).toMatchObject({state: "quarantined", retryDeliveryId: null});
  expect(k.engine("ydoc.ownerOutbox.quarantine")).toEqual([expect.objectContaining({workspace: "attached-handle", params: {outboxId: "kept-outbox", reason: "invalid-update"}})]);
  expect(k.row()).toMatchObject({retrying: false, copied: false});
  const pulls = () => o.client().sendRequest.mock.calls.filter(call => ((call as unknown[])[0] as {method: string}).method === "sync.pullHosted").length;
  const seen = pulls();
  await vi.waitFor(() => expect(pulls()).toBeGreaterThan(seen + 1));
  // Retiring would keep the refused edit out of the queue a copy reads, so nothing retires before the copy.
  expect(o.calls(sent)).not.toContain("liveApplication.reconcileActivation");
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toMatchObject({activationId: ACTIVATION});
  expect(o.host.drained("workspace")).toBe(false);
  o.engine.unproven = ["refused"];
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.engine.journals).toContainEqual({receipts: [], absent: ["refused"]});
  expect(o.calls(sent)).toContain("liveApplication.releaseActivation");
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull();
  expect(o.host.retains(o.sibling)).toBe(false);
  expect(k.row()).toBeNull();
  expect(k.engine("ydoc.ownerOutbox.quarantine")).toHaveLength(1);
});

// Proves: a refusal the server kept whose quarantine never reached the
// engine, its queue still active, is recorded at Stop as the refusal of its
// head, so once its owner confirms a copy the retirement keeps the edit and
// releases.
it("records a refusal the engine never heard at Stop, and releases after the recovery copy", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.state = "active";
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")));
  expect(k.engine("ydoc.ownerOutbox.quarantine")).toEqual([expect.objectContaining({workspace: "attached-handle", params: {outboxId: "kept-outbox",
    reason: "invalid-update", refusal: {deliveryId: "refused", key: "quarantined:refused"}}})]);
  expect(o.keptOutbox).toMatchObject({state: "quarantined", retryDeliveryId: null});
  expect(o.calls(sent)).not.toContain("liveApplication.reconcileActivation");
  o.engine.unproven = ["refused"];
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.engine.journals).toContainEqual({receipts: [], absent: ["refused"]});
  expect(o.calls(sent)).toContain("liveApplication.releaseActivation");
  expect(k.row()).toBeNull();
  expect(k.engine("ydoc.ownerOutbox.quarantine")).toHaveLength(1);
});

// Proves: once a stopped document's departure ended every Try again, later
// passes that only wait for its owner's recovery copy read none of its queues
// again. Its return, then a second Stop, scans them once more.
it("scans a stopped document's queues once while it waits for a recovery copy", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const reads = () => k.engine("ydoc.ownerOutbox.readPending").length;
  const pulls = () => o.client().sendRequest.mock.calls.filter(call => ((call as unknown[])[0] as {method: string}).method === "sync.pullHosted").length;
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")));
  const scanned = reads(), seen = pulls();
  expect(scanned).toBeGreaterThan(0);
  await vi.waitFor(() => expect(pulls()).toBeGreaterThan(seen + 2));
  expect(reads()).toBe(scanned);
  // Back in the hosted set, then stopped and departing again.
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path, enabled: true, nowMs: 30, guard() {}}))
    .toMatchObject({enabled: true});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], departing: []});
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(reads()).toBeGreaterThan(scanned));
});

// Proves: Try again rechecks its caller, its owner's live authority and the
// refusal in the document's work, right before the grant. A Stop, a new
// refusal or a caller who lost standing while it waited grants nothing, and a
// grant the relay cannot record ends at once.
it("rechecks a Try again inside the document's work before granting it", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const waiting = async (change: () => void, guard: () => void = () => {}) => {
    const parked = o.park("liveApplication.ownerState"), drain = o.host.drain(o.document);
    await parked.entered.promise;
    const retry = o.host.retryKeptEdits(k.row()!, guard);
    change();
    parked.release.resolve();
    await drain.catch(() => {});
    return retry;
  };
  await expect(waiting(() => k.refuse())).resolves.toBe("changed");
  const lost = new Error("Not found.");
  await expect(waiting(() => {}, () => {throw lost;})).rejects.toBe(lost);
  // The relay cannot record the grant, so it ends.
  const marking = vi.spyOn(o.f.storage, "markServiceKeptEditsRetrying").mockReturnValueOnce(false);
  await expect(o.host.retryKeptEdits(k.row()!, () => {})).resolves.toBe("changed");
  marking.mockRestore();
  expect(k.engine("ydoc.ownerOutbox.retry")).toHaveLength(1);
  expect(o.keptOutbox.retryDeliveryId).toBeNull();
  expect(k.row()).toMatchObject({retrying: false});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(waiting(() => o.stop())).resolves.toBe("unavailable");
  expect(k.engine("ydoc.ownerOutbox.retry")).toHaveLength(1);
});

// Proves: a document whose queue the relay refused at its owner's adoption
// seed can still depart, although the host since applied another edit the
// relay accepted, which no settlement can pass the seed to reach the file.
// The Try again granted before Stop ends before anything else, the document
// unloads without settling or publishing, with the queue's bytes and the
// unsettled edit kept, and once its owner confirms a copy it leaves.
it("lets a document refused at its adoption seed depart with later accepted work after Try again, Stop and a recovery copy", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.acceptEdit("accepted-after-adoption");
  await o.host.drain(o.document);
  expect(o.applied.has("edit-accepted-after-adoption")).toBe(true);
  await expect(o.host.retryKeptEdits(k.row()!, () => {})).resolves.toBe("granted");
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")));
  expect(o.keptOutbox).toMatchObject({state: "quarantined", retryDeliveryId: null});
  expect(k.row()).toMatchObject({retrying: false, copied: false});
  // Its retirement asks the journal about the seed, which holds it: no registration or settlement, so nothing
  // to publish, and the one unload is all the departure asked of the engine besides.
  expect(o.engine.journals).toContainEqual({receipts: [], absent: ["refused"]});
  const departure = () => o.calls(sent).filter(method => method !== "liveApplication.reconcileActivation");
  expect(departure()).toEqual(["liveApplication.unloadDocument"]);
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(k.row()).toBeNull();
  expect(departure().every(method => method === "liveApplication.unloadDocument")).toBe(true);
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toMatchObject({activationId: ACTIVATION});
});

// Proves: Sol's F3. The relay refused the owner's adoption seed and nothing applied it. Stop's retirement asks
// the journal, which proves the seed absent; the engine abandons it, and the retirement completes without
// waiting for a recovery copy, which stays asked for. The first Resume activates the successor.
it("retires a document refused at a seed nothing applied before its copy, and activates the successor on the first Resume", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.engine.abandonableSeed = true;
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull(), {timeout: 10_000});
  expect(o.engine.journals).toContainEqual({receipts: [], absent: ["refused"]});
  expect(k.row()).toMatchObject({copied: false});
  expect(o.host.drained("workspace")).toBe(false);
  o.engine.capture = {...o.engine.capture, activationId: SUCCESSOR, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 40, guard() {}});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true), {timeout: 10_000});
  expect(k.row()).toMatchObject({copied: false});
});

// Proves: Opus's F2. Resume while a stopped document's retirement waits, on a queue frozen at a seed nothing
// applied, leaves the retirement running on every pass, which proves the seed absent and abandons it. As for
// any Resume before a retirement finished, the obligation stays until the document departs again; then it
// completes without waiting for a recovery copy, and the next Resume activates the successor.
it("keeps retiring a document resumed while its retirement on a refused seed waited, and activates the successor after it departs", async () => {
  const o = await enrolledServiceHost({freshRegistrations: true}), k = keptEdits(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.engine.abandonableSeed = true;
  o.stop();
  // Its publication does not finish, so the retirement waits after it settled.
  o.replies.push = {hasMore: true};
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(retiringSettles(o, sent).length).toBeGreaterThan(0));
  expect(o.engine.journals).toContainEqual({receipts: [], absent: ["refused"]});
  const resume = async () => {
    o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 40, guard() {}});
    await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  };
  o.replies.push = {};
  await resume();
  const reconciled = o.calls(sent).filter(method => method === "liveApplication.reconcileActivation").length;
  await o.nextPull();
  await vi.waitFor(() => expect(o.calls(sent).filter(method => method === "liveApplication.reconcileActivation").length).toBeGreaterThan(reconciled));
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toMatchObject({activationId: ACTIVATION});
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  // Stop again: the document departs, and the retirement completes with the copy still asked for.
  preparedStop(o.f.storage, {workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path, enabled: false, retire: true, nowMs: 50, guard() {}});
  await o.depart();
  await vi.waitFor(() => expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull());
  expect(k.row()).toMatchObject({copied: false});
  o.engine.capture = {...o.engine.capture, activationId: SUCCESSOR, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  await resume();
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
});

// Proves: a refused seed of an earlier generation whose final accepted state
// was never kept reaches its owner as the recovery copy refusal, as an
// earlier store's refusal does, rather than as a server failure.
it("turns an attached store's missing recovery checkpoint into the recovery copy refusal", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  o.recoveryFaults.failCurrentRead = new EngineRequestError(0, {code: "INVALID_PARAMS", message: "owner-outbox-recovery-checkpoint-unavailable", retry: "no"} as never);
  await expect(o.host.readKeptEditsPage(k.row()!, undefined, o.workspace.root)).rejects.toMatchObject({reason: "server"});
  await expect(o.host.readKeptEditsPage(k.row()!, undefined, o.workspace.root)).resolves.toMatchObject({kind: "page", part: "header"});
});

// The accepted state a recovery copy reads, as the engine pages it through the host.
async function keptCheckpoint(host: Awaited<ReturnType<typeof enrolledServiceHost>>["host"], kept: ServiceKeptEdits, store: string) {
  type Page = {kind: string; snapshot: string; bytesBase64: string};
  const header = await host.readKeptEditsPage(kept, undefined, store) as Page;
  const named = JSON.parse(Buffer.from(header.bytesBase64, "base64").toString("utf8")) as {checkpointDigest: string | null};
  const page = await host.readKeptEditsPage(kept, {snapshot: header.snapshot, part: "checkpoint", sequence: 0, offset: 0}, store) as Page;
  const bytes = Buffer.from(page.bytesBase64, "base64");
  expect(sha256(bytes)).toBe(named.checkpointDigest);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const text = yDocToMarkdown(doc);
  doc.destroy();
  return {digest: named.checkpointDigest!, text};
}
const acceptedState = (text: string) => {
  const doc = markdownToYDoc(text), bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return bytes;
};

// Proves: a document whose queue stays frozen at its owner's adoption seed
// leaves only with a copy of the accepted state its departure sees. A copy
// confirmed before a recipient's later accepted edit holds the document after
// Stop. A copy read after the edit rebuilds it from its checkpoint, and its
// confirmation lets the document go.
it("keeps a frozen seed's stopped document until its owner copies the accepted state with the later edit", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.keptOutbox.checkpoint = acceptedState("Original");
  const early = await keptCheckpoint(o.host, k.row()!, o.workspace.root);
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: early.digest})).toBe(true);
  // A recipient's edit the relay accepts after that copy: the engine's recovery checkpoint now holds it.
  o.acceptEdit("recipient");
  await o.host.drain(o.document);
  o.keptOutbox.checkpoint = acceptedState("Original\n\nRecipient text");
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")));
  expect(k.row()).toMatchObject({copied: false});
  await o.nextPull();
  expect(o.host.drained("workspace")).toBe(false);
  // Read after the edit, the copy holds it.
  const late = await keptCheckpoint(o.host, k.row()!, o.workspace.root);
  expect(late.text).toContain("Recipient text");
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: late.digest})).toBe(true);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(k.row()).toBeNull();
});

// Proves: a seed refused at an earlier restore generation freezes nothing of
// a later one. Once the document's binding moved to the next generation, as
// after a restore, the retirement settles that generation's accepted work,
// publishes it and releases, and the copied earlier queue lets the document go.
it("settles a later restore generation's accepted work although an earlier generation's seed stays refused", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.engine.generation = o.binding.restoreFenceGeneration + 1;
  o.acceptEdit("next-generation");
  await o.host.drain(o.document);
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(new Set(o.calls(sent))).toEqual(new Set(retirement));
  expect(k.row()).toBeNull();
});

// Proves: a restore keeps an earlier generation's recovery checkpoint. A copy
// confirmed before another accepted edit of that generation no longer counts
// once its restore moved the document on, although the earlier seed freezes
// nothing of the next generation, until a copy of the checkpoint the restore kept.
it("holds a restored document until its owner copies the earlier generation's final accepted state", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.keptOutbox.checkpoint = acceptedState("Original");
  const early = await keptCheckpoint(o.host, k.row()!, o.workspace.root);
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: early.digest})).toBe(true);
  o.acceptEdit("recipient");
  await o.host.drain(o.document);
  // The restore fence kept the earlier generation's final accepted state, then moved the binding on.
  o.keptOutbox.checkpoint = acceptedState("Original\n\nRecipient text");
  o.engine.generation = o.binding.restoreFenceGeneration + 1;
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")), {timeout: 10_000});
  expect(k.row()).toMatchObject({copied: false});
  const late = await keptCheckpoint(o.host, k.row()!, o.workspace.root);
  expect(late.text).toContain("Recipient text");
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: late.digest})).toBe(true);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(k.row()).toBeNull();
});

// Proves: a departure that keeps its owner's live authority records the
// checkpoint a copy reads at that departure. A digest an earlier departure
// recorded holds nothing once the owner copied the current one.
it("lets a document go when its copy holds the current checkpoint, whatever an earlier departure recorded", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.keptOutbox.checkpoint = acceptedState("Original");
  const current = await keptCheckpoint(o.host, k.row()!, o.workspace.root);
  o.f.storage.observeServiceKeptEditsCheckpoint(k.row()!, "e".repeat(64));
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: current.digest})).toBe(true);
  expect(k.row()).toMatchObject({copied: false});
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(k.row()).toBeNull();
});

// Proves: a row no departure recorded a checkpoint on never lets a copy
// that misses a later accepted edit count. The departure records the
// checkpoint holding that edit, and only a copy of it lets the document go.
it("holds a departing document whose unrecorded copy misses a later accepted edit", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.keptOutbox.checkpoint = acceptedState("Original");
  const early = await keptCheckpoint(o.host, k.row()!, o.workspace.root);
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: early.digest})).toBe(true);
  expect(k.row()).toMatchObject({copied: true});
  // A recipient's edit the host applied after that copy: the engine's recovery checkpoint now holds it.
  o.keptOutbox.checkpoint = acceptedState("Original\n\nRecipient text");
  await o.depart();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")));
  expect(k.row()).toMatchObject({copied: false});
  const late = await keptCheckpoint(o.host, k.row()!, o.workspace.root);
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: late.digest})).toBe(true);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(k.row()).toBeNull();
});

// Proves: the departure reaches every queue of the document, not only the
// first page of them, so a Try again granted on a queue past that page ends
// too. A queue the engine no longer holds loses its row instead of failing
// every departure. Each departure reads all 258 queue headers again, which
// took 43 s under load.
it("ends a Try again past the first page of a stopped document's queues, and forgets a queue the engine no longer holds", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  o.f.storage.forgetServiceKeptEdits(k.queue("kept-outbox"));
  for (let index = 0; index < SERVICE_KEPT_EDITS_PAGE; index++) k.other(`filler-${index}`);
  k.other("released-queue", false); o.keptOutboxes.set("released-queue", null);
  k.refuse();
  await expect(o.host.retryKeptEdits(k.row()!, () => {})).resolves.toBe("granted");
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")), {timeout: 60_000});
  expect(o.keptOutbox).toMatchObject({state: "quarantined", retryDeliveryId: null});
  expect(o.f.storage.readServiceKeptEdits(k.queue("released-queue"))).toBeNull();
  expect(k.row()).toMatchObject({retrying: false, copied: false});
}, 120_000);

// Proves: a row of the store an identity rotation left behind holds nothing.
// A fresh daemon under the new identity lets the stopped document go, reaches
// no queue of the old store, and leaves the old row listed for its owner.
it("lets a stopped document go under a rotated identity although its old store's edits have no copy", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.close();
  o.stop();
  const rotatedRoot = join(o.f.root, "workspace-rotated"); await mkdir(rotatedRoot);
  expect(o.f.storage.rotateWorkspaceIdentity({workspaceId: "workspace", ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 10})).toBe("rotated");
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  const queues = k.engine("ydoc.ownerOutbox.readPending").length;
  await restarted.update({workspaces: [{...o.workspace, root: rotatedRoot,
    hostedReplication: {...o.workspace.hostedReplication!, identity: {replicationEpoch: "epoch-2", streamIdentity: "stream-2"}}}], documents: [], departing: [o.sibling]});
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true));
  expect(restarted.retains(o.sibling)).toBe(false);
  expect(k.engine("ydoc.ownerOutbox.readPending")).toHaveLength(queues);
  expect(k.row()).toMatchObject({identity: k.identity, copied: false});
});

// Proves: after an identity change, refusals kept in the earlier store are
// read there, through one read-only recovery handle, never through an
// attachment. The handle stays while a refusal in its store has no copy and
// closes after the last copy. Since the engine opens one per workspace, a read
// of another earlier store closes the open handle first, and a read its
// caller abandons closes its handle too.
it("reads an earlier store's kept edits through one recovery handle, and closes it after the last copy", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.close();
  o.stop();
  k.other("second-outbox", false);
  const older = {replicationEpoch: "epoch-0", streamIdentity: "stream-0"};
  o.f.storage.recordServiceKeptEdits({identity: older, outboxId: "kept-outbox", binding: o.binding, reason: "invalid-update", headDeliveryId: "refused", refusalKey: "older", nowMs: 1});
  expect(o.f.storage.rotateWorkspaceIdentity({workspaceId: "workspace", ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 10})).toBe("rotated");
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  // The workspace is attached under its new identity, in its new store, and the stopped document leaves it.
  const rotatedRoot = join(o.f.root, "workspace-rotated"); await mkdir(rotatedRoot);
  await restarted.update({workspaces: [{...o.workspace, root: rotatedRoot,
    hostedReplication: {...o.workspace.hostedReplication!, identity: {replicationEpoch: "epoch-2", streamIdentity: "stream-2"}}}], documents: [], departing: [o.sibling]});
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true));
  const [earlierRoot, olderRoot] = [join(o.f.root, "earlier-store"), join(o.f.root, "older-store")];
  const row = (outboxId: string, identity = k.identity) => o.f.storage.readServiceKeptEdits({workspaceId: "workspace", identity, outboxId})!;
  // The entry header of a queue, which names the store that served it.
  const store = async (kept: ReturnType<typeof row>, root: string, signal?: AbortSignal) => {
    const header = await restarted.readKeptEditsPage(kept, undefined, root, signal) as {kind: string; snapshot: string};
    expect(header).toMatchObject({kind: "page", part: "header"});
    const entry = await restarted.readKeptEditsPage(kept, {snapshot: header.snapshot, part: "entryHeader", sequence: 1, offset: 0}, root, signal) as {bytesBase64: string};
    return (JSON.parse(Buffer.from(entry.bytesBase64, "base64").toString("utf8")) as {appendKey: string}).appendKey;
  };
  const reads = k.engine("ydoc.ownerOutbox.readPending").length;
  expect(await store(row("kept-outbox"), earlierRoot)).toBe(earlierRoot);
  expect(await store(row("second-outbox"), earlierRoot)).toBe(earlierRoot);
  expect(k.engine("liveApplication.openRecoveryStore").map(request => request.params)).toEqual([{root: earlierRoot, workspaceId: "workspace", ...k.identity}]);
  expect(k.engine("ydoc.ownerOutbox.readPending").slice(reads).map(request => request.workspace)).toEqual(["recovery-1", "recovery-1", "recovery-1", "recovery-1"]);
  // A copy of one refusal keeps the handle while another in its store waits; the last closes it.
  for (const outboxId of ["kept-outbox", "second-outbox"]) {
    expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId, generation: row(outboxId).generation, checkpointDigest: null})).toBe(true);
    await restarted.releaseKeptEditsStore(row(outboxId));
    expect(k.engine("liveApplication.closeRecoveryStore").map(request => request.workspace)).toEqual(outboxId === "kept-outbox" ? [] : ["recovery-1"]);
  }
  expect(o.recoveryStores.size).toBe(0);
  // Another earlier store opens its own handle once the first closed.
  expect(await store(row("kept-outbox"), earlierRoot)).toBe(earlierRoot);
  expect(await store(row("kept-outbox", older), olderRoot)).toBe(olderRoot);
  expect(k.engine("liveApplication.closeRecoveryStore").map(request => request.workspace)).toEqual(["recovery-1", "recovery-2"]);
  expect([...o.recoveryStores.values()]).toEqual([{root: olderRoot, handle: "recovery-3"}]);
  // An abandoned read closes its handle.
  const abandoned = new AbortController(), parked = o.park("ydoc.ownerOutbox.readPending");
  const reading = restarted.readKeptEditsPage(row("kept-outbox", older), undefined, olderRoot, abandoned.signal).catch(() => undefined);
  await parked.entered.promise;
  abandoned.abort(); parked.release.resolve();
  await reading;
  expect(k.engine("liveApplication.closeRecoveryStore").map(request => request.workspace)).toEqual(["recovery-1", "recovery-2", "recovery-3"]);
  expect(o.recoveryStores.size).toBe(0);
  // Nothing went through the attached store.
  expect(k.engine("ydoc.ownerOutbox.readPending").slice(reads).some(request => request.workspace === "attached-handle")).toBe(false);
});

// A host restarted after an identity change with no live document, so nothing
// registers it, and the refusal kept in the earlier store. Passes run once a minute.
async function rotatedServiceHost() {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.close();
  o.stop();
  expect(o.f.storage.rotateWorkspaceIdentity({workspaceId: "workspace", ownerUserId: "owner", replicationEpoch: "epoch-2", streamIdentity: "stream-2", rotatedAtMs: 10})).toBe("rotated");
  (o.f.config as unknown as {activation: {pollIntervalMs: number}}).activation.pollIntervalMs = 60_000;
  await o.f.save();
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  const earlier = k.row()!, root = join(o.f.root, "earlier-store");
  const closes = () => k.engine("liveApplication.closeRecoveryStore").map(request => request.workspace);
  return {...o, k, restarted, earlier, root, closes,
    /** The header page of a kept queue, read from the store at `store`. */
    read: (kept = earlier, store = root) => restarted.readKeptEditsPage(kept, undefined, store)};
}

// Proves: after an identity change, with no live document left and the relay
// restarted, its owner still reads the refusal kept in the earlier store,
// although no live registration exists. A host whose control changed, as
// when it is retired, reads nothing.
it("reads an earlier store's kept edits on a restarted host with no live documents", async () => {
  const r = await rotatedServiceHost();
  expect(r.f.storage.getLiveHostControl()?.registeredConnectionId).not.toBe(r.restarted.coordinate.connectionId);
  await expect(r.read()).resolves.toMatchObject({kind: "page", part: "header"});
  expect(r.k.engine("liveApplication.openRecoveryStore").map(request => request.params)).toEqual([{root: r.root, workspaceId: "workspace", ...r.k.identity}]);
  const control = r.f.storage.getLiveHostControl()!;
  vi.spyOn(r.f.storage, "getLiveHostControl").mockReturnValue({...control, configuredHostId: "another-host"});
  await expect(r.read()).rejects.toThrow("Hosted service preparation was retired.");
});

// Proves: an open whose answer was lost leaves no handle stranded. Before
// another earlier store of the workspace opens, the relay opens the first
// store again, which answers with the handle the lost open made, and closes it.
it("closes the handle of a recovery open whose answer was lost before another store opens", async () => {
  const r = await rotatedServiceHost(), older = {replicationEpoch: "epoch-0", streamIdentity: "stream-0"}, olderRoot = join(r.f.root, "older-store");
  r.f.storage.recordServiceKeptEdits({identity: older, outboxId: "kept-outbox", binding: r.binding, reason: "invalid-update", headDeliveryId: "refused", refusalKey: "older", nowMs: 1});
  r.recoveryFaults.loseOpen = true;
  await expect(r.read()).rejects.toThrow("Open reply lost.");
  expect([...r.recoveryStores.values()]).toEqual([{root: r.root, handle: "recovery-1"}]);
  await expect(r.read(r.f.storage.readServiceKeptEdits({workspaceId: "workspace", identity: older, outboxId: "kept-outbox"})!, olderRoot))
    .resolves.toMatchObject({kind: "page", part: "header"});
  expect(r.closes()).toEqual(["recovery-1"]);
  expect([...r.recoveryStores.values()]).toEqual([{root: olderRoot, handle: "recovery-2"}]);
});

// Proves: an open whose lookup failed without the engine refusing it stays
// tracked. After a lost open, an idle close whose lookup the engine answers
// overloaded keeps the record, and the next idle close finds the handle and closes it.
it("keeps an uncertain recovery open tracked until a later lookup closes its handle", async () => {
  const r = await rotatedServiceHost();
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
  cleanup.push(async () => {vi.useRealTimers();});
  r.recoveryFaults.loseOpen = true;
  await expect(r.read()).rejects.toThrow("Open reply lost.");
  r.recoveryFaults.failOpen = new EngineRequestError(0, {code: "OVERLOADED", message: "request queue is full", retry: "afterBackoff"} as never);
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(r.recoveryFaults.failOpen).toBeUndefined());
  expect(r.closes()).toEqual([]);
  expect([...r.recoveryStores.values()]).toEqual([{root: r.root, handle: "recovery-1"}]);
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(r.closes()).toEqual(["recovery-1"]));
  expect(r.recoveryStores.size).toBe(0);
});

// Proves: a read that waited its turn behind a change to the refusal it names
// opens no earlier store.
it("opens no earlier store for a read whose refusal changed while it waited", async () => {
  const r = await rotatedServiceHost();
  await expect(r.read({...r.earlier, generation: r.earlier.generation + 1_000})).resolves.toEqual({kind: "readChanged"});
  expect(r.k.engine("liveApplication.openRecoveryStore")).toEqual([]);
});

// Proves: a recovery handle the engine no longer holds, as after a close whose
// answer timed out, is dropped, and its store opens once more for the read.
it("opens an earlier store again when the engine no longer holds its recovery handle", async () => {
  const r = await rotatedServiceHost();
  await r.read();
  r.recoveryStores.clear();
  await expect(r.read()).resolves.toMatchObject({kind: "page", part: "header"});
  expect(r.k.engine("liveApplication.openRecoveryStore")).toHaveLength(2);
  expect([...r.recoveryStores.values()]).toEqual([{root: r.root, handle: "recovery-2"}]);
});

// Proves: a recovery handle whose close timed out while the engine's worker
// still runs stays recorded. A read through it, which the engine refuses as
// closing, closes it again and waits for that close before its store opens
// once more, so an account deletion queued behind it waits for the worker too.
it("keeps a closing recovery handle until its close ends, so a deletion waits for its worker", async () => {
  const r = await rotatedServiceHost();
  await r.read();
  const worker = deferred<void>();
  r.recoveryFaults.worker = worker.promise;
  // An abandoned read's close times out while the worker runs.
  const abandoned = new AbortController(), parked = r.park("ydoc.ownerOutbox.readPending");
  const reading = r.restarted.readKeptEditsPage(r.earlier, undefined, r.root, abandoned.signal).catch(() => undefined);
  await parked.entered.promise;
  abandoned.abort(); parked.release.resolve();
  await reading;
  expect(r.closes()).toEqual(["recovery-1"]);
  expect([...r.recoveryStores.values()]).toEqual([{root: r.root, handle: "recovery-1", closing: true}]);
  const read = r.read();
  await vi.waitFor(() => expect(r.closes()).toEqual(["recovery-1", "recovery-1"]));
  const deleting = r.restarted.deleteWorkspaces(["workspace"]);
  r.recoveryFaults.worker = undefined;
  worker.resolve();
  await expect(read).resolves.toMatchObject({kind: "page", part: "header"});
  await deleting;
  expect(r.k.engine("liveApplication.openRecoveryStore")).toHaveLength(2);
  expect(r.closes()).toEqual(["recovery-1", "recovery-1", "recovery-2"]);
  expect(r.recoveryStores.size).toBe(0);
});

// Proves: a read answers `preparing` while the engine prepares the earlier
// store. A store the engine refused is the owner's recovery copy refusal, with
// its reason, and its handle closes, so the next read prepares it again.
it("passes preparing through and turns a refused earlier store into a recovery copy refusal", async () => {
  const r = await rotatedServiceHost();
  r.recoveryFaults.preparing = 1;
  await expect(r.read()).resolves.toEqual({kind: "preparing"});
  for (const [message, reason] of [["recovery-store-disk-full", "disk-space"], ["recovery-store-needs-update", "newer-schema"],
    ["recovery-store-busy", "busy"], ["recovery store unavailable", "server"]]) {
    r.recoveryFaults.failRead = new EngineRequestError(0, {code: "INVALID_PARAMS", message, retry: "no"} as never);
    await expect(r.read()).rejects.toMatchObject({reason});
    expect(r.recoveryStores.size).toBe(0);
  }
  await expect(r.read()).resolves.toMatchObject({kind: "page", part: "header"});
});

// Proves: a handle closes after 60 s without a page read. A close that fails,
// on release or once idle, keeps the handle and closes it after the next idle period.
it("closes an idle recovery handle after 60 s, and keeps one whose close failed until a later close", async () => {
  const r = await rotatedServiceHost();
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
  cleanup.push(async () => {vi.useRealTimers();});
  await r.read();
  await vi.advanceTimersByTimeAsync(59_999);
  // A page read starts the idle period again.
  await r.read();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(r.closes()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(r.recoveryStores.size).toBe(0));
  expect(r.closes()).toEqual(["recovery-1"]);
  // The last copy's release fails, and so does the idle close after it.
  await r.read();
  expect(r.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: r.earlier.generation, checkpointDigest: null})).toBe(true);
  r.recoveryFaults.failClose = new Error("Close reply lost.");
  await expect(r.restarted.releaseKeptEditsStore(r.earlier)).rejects.toThrow("Close reply lost.");
  expect([...r.recoveryStores.values()]).toEqual([{root: r.root, handle: "recovery-2"}]);
  r.recoveryFaults.failClose = new Error("Close reply lost.");
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(r.closes()).toHaveLength(3));
  expect(r.recoveryStores.size).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(r.recoveryStores.size).toBe(0));
  expect(r.closes()).toEqual(["recovery-1", "recovery-2", "recovery-2", "recovery-2"]);
});

// Proves: deleting a workspace closes its recovery handle before anything
// removes its stores, and a close that fails fails the deletion, so the store stays.
it("closes a deleted workspace's recovery handle first, and fails the deletion while that close fails", async () => {
  const r = await rotatedServiceHost();
  await r.read();
  r.recoveryFaults.failClose = new Error("Close reply lost.");
  await expect(r.restarted.deleteWorkspaces(["workspace"])).rejects.toThrow("Close reply lost.");
  expect(r.recoveryStores.size).toBe(1);
  await r.restarted.deleteWorkspaces(["workspace"]);
  expect(r.recoveryStores.size).toBe(0);
  expect(r.closes()).toEqual(["recovery-1", "recovery-1"]);
});

// Proves: an edit the engine applied but whose reply, and every ACK read after
// it, the relay lost before Stop settles. The engine's reconciliation reports
// its application, the relay records it as its tip, and the retirement settles
// and releases through it. It sends no application and reads no ACK.
it("records an edit whose application reply was lost before Stop, and retires through it", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.lost.replies = true;
  const edit = o.acceptEdit("lost");
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true));
  o.stop();
  o.lost.replies = false;
  const applications = o.client().sendLiveApplication.mock.calls.length, reads = o.client().readLiveApplicationAck.mock.calls.length, sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(retiredRow(o).boundary.terminalReceipt).toEqual(edit);
  expect(retiringSettles(o, sent).at(-1)).toEqual(["liveApplication.settle", {retirement: expect.objectContaining({acceptedThrough: edit.journalCursor}), terminalReceipt: edit}]);
  expect(o.client().readLiveApplicationAck).toHaveBeenCalledTimes(reads);
  expect(o.client().sendLiveApplication).toHaveBeenCalledTimes(applications);
});

// Proves: a stopped document whose departure has not reached the host yet
// still records the edit the engine applied before anything publishes, so the
// relay's owner tip covers its output, and settles it. Nothing releases before
// the departure: the document stays retained and is never ready.
it("records and settles what the engine applied of a stopped document before its departure reaches the host, and releases nothing", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.lost.replies = true;
  const edit = o.acceptEdit("before departure");
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true));
  o.stop();
  const applications = o.client().sendLiveApplication.mock.calls.length, sent = o.ownerCalls().length;
  o.lost.replies = false;
  await vi.waitFor(() => expect(o.tip()).toEqual(edit));
  await vi.waitFor(() => expect(retiringSettles(o, sent).at(-1)?.[1]).toMatchObject({terminalReceipt: edit}));
  await o.nextPull();
  expect(o.calls(sent)).not.toContain("liveApplication.releaseActivation");
  expect(o.calls(sent)).not.toContain("liveApplication.register");
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  expect(o.client().sendLiveApplication).toHaveBeenCalledTimes(applications);
});

// Proves: a row the relay accepted before Stop that the engine never applied
// stays unapplied: reconciliation reports no application of it, the relay
// records nothing, and the retirement settles and releases through the tip it
// already had, inside the fence that includes the unapplied row.
it("leaves an accepted edit the engine never applied unapplied, and retires through the earlier tip", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const seed = o.tip();
  o.lost.pending = true;
  const edit = o.acceptEdit("unapplied");
  await vi.waitFor(() => expect(o.client().sendLiveApplication).toHaveBeenCalled());
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(o.applied.has(edit.deliveryId)).toBe(false);
  expect(retiredRow(o).boundary.terminalReceipt).toEqual(seed);
  expect(retiringSettles(o, sent).at(-1)).toEqual(["liveApplication.settle", {retirement: expect.objectContaining({acceptedThrough: edit.journalCursor}), terminalReceipt: seed}]);
  expect(o.ownerCalls().slice(sent).at(-1)).toEqual(["liveApplication.releaseActivation", expect.objectContaining({acceptedThrough: edit.journalCursor})]);
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

// Proves: whether a pending activation holds an admitted seed comes from relay
// rows alone, so a store rebuilt on a later connection reads the same answer.
// It counts only while the activation is pending.
it("finds a pending activation's admitted seed from relay rows alone, on any store", async () => {
  const o = await enrolledServiceHost(), actor = {kind: "owner" as const, userId: "owner", shareId: "share"};
  await o.host.close();
  const host = {...o.host.coordinate, connectionId: "rebuilt"};
  expect(o.f.storage.registerLiveHost({...host, updatedAtMs: Date.now(), guard: o.f.storage.captureStanding()}).ok).toBe(true);
  const hasSeed = (pending: boolean) => {
    const access = pending ? o.f.storage.createServiceActivationStore(o.f.history).pending(o.document, host) : undefined;
    const store = o.f.storage.createLiveCommittedDeliveryStore(o.f.history, access);
    return store.hasPendingActivationSeed(store.openOwnerDelivery({host, document: o.document, actor}));
  };
  expect(hasSeed(false)).toBe(false);
  // As before the host applied it: the activation has not completed.
  o.raw.prepare("UPDATE sync_relay_service_activations SET completion_json=NULL WHERE activation_id=?").run(ACTIVATION);
  expect(hasSeed(true)).toBe(true);
  expect(hasSeed(true)).toBe(true);
});

// Proves: a daemon that starts after Stop retires a stopped document it never
// loaded, from its durable obligation, the relay's journal and the engine's
// record of what it applied. It captures no session and registers nothing.
it("retires a document stopped while no daemon ran, which the daemon after it never loaded", async () => {
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
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(retiredRow(o).boundary.terminalReceipt).toEqual(edit);
  expect(new Set(departed(o.calls(0)))).toEqual(new Set(retirement));
  expect(retiringSettles(o, 0)).toEqual([["liveApplication.settle", {retirement: expect.objectContaining({activationId: ACTIVATION}), terminalReceipt: edit}]]);
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(o.client().sendLiveApplication).not.toHaveBeenCalled();
});

// Proves: a retirement resumes after its daemon stops at any point, from its
// durable obligation alone: before the engine reconciled it, after it settled,
// after the engine released it, or after the relay retired it. A released
// activation's release replays its boundary, and a retired one needs nothing more.
it.each(["liveApplication.reconcileActivation", "liveApplication.settle", "liveApplication.releaseActivation", "retired"] as const)(
  "resumes a retirement on a restarted daemon after it stopped at %s", async at => {
    const o = await enrolledServiceHost();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tip = o.tip();
    o.stop();
    if (at === "retired") {
      await o.depart();
      await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true));
    } else {
      // The engine handles this request, but the daemon stops before its answer arrives.
      const reached = deferred<void>(), send = o.client().sendRequest, through = send.getMockImplementation()! as (...values: unknown[]) => Promise<unknown>;
      send.mockImplementation(async (...args: unknown[]) => {
        const result = await through(...args), request = args[0] as {method: string; params: object}, signal = args[1] as AbortSignal;
        if (request.method !== at || (at === "liveApplication.settle" && !Object.hasOwn(request.params, "retirement"))) return result as never;
        reached.resolve();
        return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
      });
      await o.depart();
      await reached.promise;
    }
    await o.host.close();
    expect(retiredRow(o).retired).toBe(at === "retired");
    const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
    cleanup.push(() => restarted.close());
    await o.depart(restarted);
    await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true), {timeout: 10_000});
    expect(retiredRow(o)).toEqual({retired: true, boundary: {terminalReceipt: tip, eventCount: 1, historyEvidenceDigest: expect.any(String)}});
    expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
    if (at === "retired") expect(departed(o.calls(0))).toEqual([]);
    else expect(departed(o.calls(0)).at(-1)).toBe("liveApplication.releaseActivation");
  });

// Proves: an activation that never adopted retires with no boundary. Its
// release may answer before its document parked, so the relay retires it
// only once a pull confirms the document parked, on this daemon or one started
// after it stopped.
it.each([false, true])("retires a never-adopted activation only once its document parked, though the engine released it first, after a restart: %s", async restart => {
  const o = await emptyServiceHost({adopted: false});
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 10, guard() {}});
  expect(preparedStop(o.f.storage, {workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path,
    enabled: false, retire: true, nowMs: 20, guard() {}})).toMatchObject({enabled: false, retired: true});
  // Its replica lists it departed, so it has not parked.
  o.replies.commit = {departed: [o.sibling.objectId]};
  await o.host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]});
  const released = () => o.ownerCalls().filter(([method]) => method === "liveApplication.releaseActivation");
  await vi.waitFor(() => expect(released().length).toBeGreaterThan(0), {timeout: 10_000});
  await o.nextPull();
  expect(o.raw.prepare("SELECT retired_at_ms FROM sync_relay_service_activations").get()).toEqual({retired_at_ms: null});
  expect(o.host.retains(o.sibling)).toBe(true);
  let host = o.host;
  if (restart) {
    await o.host.close();
    host = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
    cleanup.push(() => host.close());
    await host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]});
    await vi.waitFor(() => expect(o.ownerCalls()).toContainEqual(["liveApplication.releaseActivation", expect.anything()]), {timeout: 10_000});
    await o.nextPull();
    expect(o.raw.prepare("SELECT retired_at_ms FROM sync_relay_service_activations").get()).toEqual({retired_at_ms: null});
  }
  o.replies.commit = {};
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(o.raw.prepare("SELECT retired_at_ms IS NOT NULL AS retired,retired_boundary_json FROM sync_relay_service_activations").get())
    .toEqual({retired: 1, retired_boundary_json: "null"});
  expect(o.ownerCalls().filter(([method]) => method === "liveApplication.settle")).toEqual([]);
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
});

// Proves: a daemon that starts after its stopped document moved away from its
// enrolled path does not settle it there, but keeps it, with its workspace
// attached, while its owner has no recovery copy of edits the server kept.
// Nothing retires before the copy. Once a copy exists, its retirement
// completes without an ordinary unload, and its rows go.
it("keeps a document that moved while no daemon ran until its owner copies the edits the server kept, then retires it", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.close();
  o.stop();
  const at = o.f.storage.objectIdAtPathInVersion.bind(o.f.storage);
  vi.spyOn(o.f.storage, "objectIdAtPathInVersion").mockImplementation(input => input.path === o.sibling.path ? "another-object" : at(input));
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  const sent = o.ownerCalls().length;
  await o.depart(restarted);
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")));
  expect(restarted.retains(o.sibling)).toBe(true);
  expect(restarted.drained("workspace")).toBe(false);
  expect(o.calls(sent)).not.toContain("liveApplication.reconcileActivation");
  o.engine.unproven = ["refused"];
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true));
  expect(restarted.retains(o.sibling)).toBe(false);
  expect(k.row()).toBeNull();
  expect(retiredRow(o).retired).toBe(true);
  expect(o.calls(sent)).toContain("liveApplication.releaseActivation");
  expect(o.calls(sent)).not.toContain("liveApplication.unloadDocument");
});

// Proves: retention for a recovery copy follows the moved document, not its
// old path. With another document hosted at that path, and after that one
// leaves too, the moved document's queue stays readable, and its workspace
// attached, until its owner confirms a copy. Its retirement then completes.
// The fake engine captures only the fixture document, so the replacement's
// capture is refused: it is attempted at the old path, and never prepares or
// releases an owner activation.
it("keeps a moved document's queue readable while a replacement holds its old path, and after the replacement leaves", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.close();
  o.stop();
  const at = o.f.storage.objectIdAtPathInVersion.bind(o.f.storage);
  vi.spyOn(o.f.storage, "objectIdAtPathInVersion").mockImplementation(input => input.path === o.sibling.path ? "another-object" : at(input));
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  const replacement = {...o.sibling, objectId: "another-object"};
  const readable = async () => expect(await restarted.readKeptEditsPage(k.row()!, undefined, o.workspace.root)).toMatchObject({kind: "page", part: "header"});
  o.refuseCaptureAt(o.sibling.path, new Error("Replacement capture refused."));
  await restarted.update({workspaces: [o.workspace], documents: [replacement], departing: [o.sibling]});
  await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("Service activation pass failed.", expect.stringContaining("recovery copy")), {timeout: 10_000});
  await vi.waitFor(() => expect(o.client().captureOwnerActivation.mock.calls.map(call => (call as unknown[])[1])).toContain(o.sibling.path), {timeout: 10_000});
  expect(restarted.retains(o.sibling)).toBe(true);
  await readable();
  // The replacement leaves; the moved document still waits for its copy.
  await restarted.update({workspaces: [o.workspace], documents: [], departing: [o.sibling, replacement]});
  await vi.waitFor(() => expect(restarted.retains(replacement)).toBe(false), {timeout: 10_000});
  expect(restarted.retains(o.sibling)).toBe(true);
  expect(restarted.drained("workspace")).toBe(false);
  await readable();
  o.engine.unproven = ["refused"];
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(restarted.retains(o.sibling)).toBe(false));
  expect(k.row()).toBeNull();
  expect(retiredRow(o).retired).toBe(true);
  expect(o.ownerCalls().map(([method]) => method)).not.toContain("liveApplication.releaseOwnerActivation");
  const reported = errors.mock.calls.map(call => String((call as unknown[])[1]));
  expect(reported.filter(message => message.includes("Unexpected engine request") || message.includes("Service activation is retiring."))).toEqual([]);
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
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(o.retiredTip()).toEqual(edit);
  expect([...new Set(departed(o.calls(sent)))]).toEqual(retirement);
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
  expect(o.retiredTip()).toEqual(edit);
  expect(o.ownerCalls().filter(([method]) => method === "liveApplication.settle").at(-1)).toEqual(["liveApplication.settle", {retirement: expect.objectContaining({activationId: ACTIVATION, acceptedThrough: edit.journalCursor}), terminalReceipt: edit}]);
  expect(o.f.storage.readLiveUpdateJournalCut({document: o.document})).toEqual(cut);
  expect(o.client().sendLiveApplication).toHaveBeenCalledTimes(applications);
});

// Proves: Stop's retirement ends the owner's registration and readiness at
// once. A Resume before the retirement finishes enables the enrollment, but
// the obligation stays: activation passes leave the retiring activation alone,
// so it never registers, delivers or becomes ready again, and the relay admits
// nothing for it.
it("keeps a stopped activation retiring, and out of activation, when its owner resumes before its retirement finished", async () => {
  const o = await enrolledServiceHost({freshRegistrations: true});
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.stop();
  // Its publication does not finish, so the retirement waits after it settled.
  o.replies.push = {hasMore: true};
  const sent = o.ownerCalls().length, captures = o.client().captureOwnerActivation.mock.calls.length;
  await o.depart();
  await vi.waitFor(() => expect(retiringSettles(o, sent).length).toBeGreaterThan(0));
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  o.replies.push = {};
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 40, guard() {}});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await o.nextPull();
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toMatchObject({activationId: ACTIVATION, requestedAtMs: 20});
  expect(o.f.storage.resolveCurrentLiveDocumentBinding({document: o.document, actor: {kind: "owner", userId: "owner", shareId: "share"}}))
    .toEqual({kind: "refused", reason: "host-unavailable"});
  await expect(o.host.drain(o.document)).rejects.toThrow("incomplete");
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  expect(o.calls(sent)).not.toContain("liveApplication.ownerState");
  expect(o.calls(sent)).not.toContain("liveApplication.register");
  expect(o.client().captureOwnerActivation).toHaveBeenCalledTimes(captures);
});

// Proves: Stop, its retirement, then Resume. The retired activation's
// successor activates once its document is hosted again: native capture names
// the retired predecessor, the relay prepares it, and it adopts at the
// predecessor's released boundary. The relay admits nothing and the document
// is not ready until the successor completed; then edits reach it.
it("activates a retired activation's successor after Resume, which admits edits only once it completed", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const tip = o.tip(), actor = {kind: "owner" as const, userId: "owner", shareId: "share"};
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  o.engine.capture = {...o.engine.capture, activationId: SUCCESSOR, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  // At completion, the document is not ready and the relay admits nothing.
  const complete = ServiceActivationStore.prototype.complete, seen: unknown[] = [];
  vi.spyOn(ServiceActivationStore.prototype, "complete").mockImplementation(function (this: ServiceActivationStore, input) {
    seen.push([o.host.isDocumentReady(o.document), o.f.storage.resolveCurrentLiveDocumentBinding({document: o.document, actor}).kind]);
    return complete.call(this, input);
  });
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 40, guard() {}});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(seen).toEqual([[false, "refused"]]);
  expect(o.client().captureOwnerActivation).toHaveBeenLastCalledWith(expect.anything(), "docs/a.md", 1_000_000, expect.any(AbortSignal), undefined);
  expect(o.raw.prepare("SELECT activation_id,predecessor_activation_id,completion_json IS NOT NULL AS completed FROM sync_relay_service_activations ORDER BY rowid").all())
    .toEqual([{activation_id: ACTIVATION, predecessor_activation_id: null, completed: 1}, {activation_id: SUCCESSOR, predecessor_activation_id: ACTIVATION, completed: 1}]);
  expect(o.client().sendLiveOwnerAdoption).toHaveBeenLastCalledWith(expect.anything(),
    expect.objectContaining({adoptionId: SUCCESSOR, terminalReceipt: tip, events: []}), expect.anything(), expect.any(AbortSignal));
  expect(o.acceptEdit("after")).toMatchObject({journalCursor: tip.journalCursor + 1});
});

// Proves: a session host may still hold the copy it had at Stop, ready but
// missing what the owner wrote while live editing was off. After Resume, the
// successor's pass pulls the hosted feed before it captures, so the successor
// starts from the feed, never from that copy. The two-daemon e2e can't hold
// the host's copy ready across Stop since #2103, so it relies on this test.
it("captures a retired activation's successor only after a hosted pull that started after Resume", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  o.engine.capture = {...o.engine.capture, activationId: SUCCESSOR, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  const methods = () => o.client().sendRequest.mock.calls.map(call => ((call as unknown[])[0] as {method: string}).method);
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  // Resume waits behind a pass that is pulling, so the next pull is one that started after Resume.
  // A drained workspace pulls for a relay change, so another device's write starts that pull.
  const before = o.park("sync.pullHosted");
  o.f.storage.appendLogBatch({workspaceId: "workspace", originId: "another-device",
    ops: [parseLogOp({originSeq: 0, opKind: "workspace.init", recordedAtMs: 1, payload: {}})]});
  await before.entered.promise;
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 40, guard() {}});
  const resumed = o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  const after = o.park("sync.pullHosted");
  before.release.resolve();
  await resumed;
  const sent = methods().length;
  await after.entered.promise;
  expect(o.client().captureOwnerActivation).toHaveBeenCalledTimes(captures);
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  after.release.resolve();
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const pulled = methods().indexOf("sync.pullHosted", sent);
  expect(o.client().sendRequest.mock.invocationCallOrder[pulled]).toBeLessThan(o.client().captureOwnerActivation.mock.invocationCallOrder[captures]!);
});

// Proves: the engine refuses to release a stopped document until it parked.
// The refusal alone retires nothing: the release is tried again on each pass
// while a pull that started after it still lists the document departed, and
// the relay retires it once the engine releases it.
it("retires a stopped document only once the engine released it after its replica parked it", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.close();
  o.stop();
  o.replies.commit = {departed: [o.sibling.objectId]};
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  const releases = () => o.calls(0).filter(method => method === "liveApplication.releaseActivation").length;
  await o.depart(restarted);
  await vi.waitFor(() => expect(releases()).toBeGreaterThan(1));
  expect(restarted.retains(o.sibling)).toBe(true);
  expect(restarted.drained("workspace")).toBe(false);
  expect(retiredRow(o).retired).toBe(false);
  o.replies.commit = {};
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(restarted.retains(o.sibling)).toBe(false);
  expect(retiredRow(o).retired).toBe(true);
  const tries = releases();
  await o.nextPass();
  expect(releases()).toBe(tries);
});

// Proves: a retirement the relay defers for a restore it carries stays open
// after the engine released the document. The host keeps the document, and a
// later pass replays the release and retires it once the relay completes it.
it("keeps a released document hosted while its retirement waits for a restore", async () => {
  const o = await enrolledServiceHost();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const complete = vi.spyOn(ServiceActivationStore.prototype, "completeRetirement").mockReturnValue({status: "pending", reason: "restore"});
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(complete.mock.calls.length).toBeGreaterThan(1));
  expect(log).toHaveBeenCalledWith(...waiting("Waiting for its restore to finish."));
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.drained("workspace")).toBe(false);
  expect(retiredRow(o).retired).toBe(false);
  complete.mockRestore();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(o.host.retains(o.sibling)).toBe(false);
  expect(retiredRow(o).retired).toBe(true);
});

// Proves: a retirement the owner's Pause opens during their restore keeps the
// restore's route through the host until the restore ends. While
// it is unfinished, retirement passes send the engine nothing and keep the
// document's activation target, which a restarted host rebuilds, so the
// restore fences and is declined through the host. The engine then releases
// the activation at the generation the Decline restored, and it retires. A
// document whose queue is frozen at its owner's adoption seed, which departs as
// an ordinary unload instead, waits for the restore the same way. A Decline
// after the native fence committed keeps the fenced generation, which that
// seed no longer freezes, so the document then retires.
it.each([
  {restart: false, seeded: false, fenceCommitted: false}, {restart: true, seeded: false, fenceCommitted: false},
  {restart: false, seeded: true, fenceCommitted: false}, {restart: true, seeded: true, fenceCommitted: false},
  {restart: false, seeded: true, fenceCommitted: true}, {restart: true, seeded: true, fenceCommitted: true},
])("holds a retirement opened during a restore until the restore ends, keeping the restore's route, after a restart: $restart, frozen seed: $seeded, fence committed: $fenceCommitted", async ({restart, seeded, fenceCommitted}) => {
  const o = await enrolledServiceHost();
  o.engine.fenceCommitted = fenceCommitted;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  // The current daemon's engine requests that reconcile, release or unload a leaving document.
  const retiring = () => o.calls(0).filter(method => method === "liveApplication.reconcileActivation" || method === "liveApplication.releaseActivation" ||
    method === "liveApplication.unloadDocument");
  const passed = () => vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Waiting for its restore to finish.")));
  if (seeded) {keptEdits(o); o.keptOutbox.appendKey = "owner-adoption:seed";}
  o.beginRestore();
  o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner", enabled: false, nowMs: 60, guard() {}});
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toMatchObject({activationId: ACTIVATION, requestedAtMs: 60});
  await o.depart();
  await passed();
  expect(retiring()).toEqual([]);
  let host = o.host;
  if (restart) {
    await o.host.close(); log.mockClear();
    host = await restartedHost(o);
    await passed();
    expect(retiring()).toEqual([]);
  }
  // The owner prepares the restore, which fences it, then declines it.
  o.f.storage.advanceStopRestoreFence(stopLookup, 50);
  await expect(host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  expect(retiring()).toEqual([]);
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  if (seeded && !fenceCommitted) {
    // Its ordinary departure goes ahead once the restore ended.
    await vi.waitFor(() => expect(retiring()).toContain("liveApplication.unloadDocument"), {timeout: 10_000});
    return;
  }
  if (seeded) {
    await vi.waitFor(() => expect(retiring()).toContain("liveApplication.releaseActivation"), {timeout: 10_000});
    expect(retiredRow(o).retired).toBe(true);
    expect(retiring()).not.toContain("liveApplication.unloadDocument");
    return;
  }
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(retiredRow(o).retired).toBe(true);
  expect(retiring()).toContain("liveApplication.releaseActivation");
});
type Enrolled = Awaited<ReturnType<typeof enrolledServiceHost>>;
// Each engine request for `method` after the first `count` is never answered, as when its daemon stops first.
const unansweredAfter = (o: Enrolled, method: string, count: number) => {
  const reached = deferred<void>(), send = o.client().sendRequest, through = send.getMockImplementation()! as (...values: unknown[]) => Promise<unknown>;
  let seen = 0;
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as {method: string}, signal = args[1] as AbortSignal;
    if (request.method !== method || ++seen <= count) return through(...args) as never;
    reached.resolve();
    return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
  });
  return reached.promise;
};
const restartedHost = async (o: Enrolled) => {
  const host = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => host.close());
  await o.depart(host);
  return host;
};
const waiting = (reason: string) => ["Service activation pass failed.", `Departing live document is waiting: ${reason}`];

// The document moves away from its enrolled path, so another object holds it.
const moveAway = (o: Enrolled) => {
  const at = o.f.storage.objectIdAtPathInVersion.bind(o.f.storage);
  vi.spyOn(o.f.storage, "objectIdAtPathInVersion").mockImplementation(input => input.path === o.sibling.path ? "another-object" : at(input));
};
// The current daemon's engine requests that reconcile, release or unload a leaving document. Each daemon has its own client, so these start at its spawn.
const leaving = (o: Enrolled) => o.calls(0).filter(method => method === "liveApplication.reconcileActivation" || method === "liveApplication.releaseActivation" ||
  method === "liveApplication.unloadDocument");
// The engine key of the document's open retirement, as it is now.
const retirementKey = (o: Enrolled) => {
  const open = readServiceActivationRetirement(o.f.storage as StorageContext, o.document)!;
  return {objectId: open.objectId, lineageClaimId: open.lineageClaimId, activationId: open.activationId,
    restoreFenceGeneration: open.restoreFenceGeneration, acceptedThrough: open.acceptedThrough};
};

// Another Edit grant on the share, which keeps the document covered once the restore revokes the fixture's grant.
const anotherEditGrant = (o: Enrolled) => o.raw.exec(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,
  created_at_ms,revoked_at_ms,parent_grant_id) VALUES ('editor-grant','share','user','editor',NULL,'edit',1,'active',0,NULL,NULL)`);
// The owner's restore fences the document. The document then moves from its
// enrolled path, and the host restarts, with `replacement` hosted at the old
// path when it is given. Unless `covered` leaves the document covered by
// another Edit grant, or `live` leaves the owner's live session the restore
// kept, each with no retirement open, the owner's Pause after the restore
// began opens its retirement. `paused` has another Edit grant cover it too,
// so the restore's revocation keeps nothing.
// `kept` first records an edit the server refused. Unless `stopped` is false,
// the restore's first step runs before the restart. `pending` has the relay
// accept an edit after the adoption cut that no activation pass delivers.
// `admitted` has the relay admit the restore before the document moves, and
// configures restore preparation on the restarted host.
const movedDuringRestore = async ({replacement = false, paused = false, covered = false, live = false, kept = false, stopped = true, pending = false,
  admitted = false} = {}) => {
  const o = await enrolledServiceHost(), k = kept ? keptEdits(o) : undefined;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const passed = () => vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Waiting for its restore to finish.")));
  if (paused || covered) anotherEditGrant(o);
  if (pending) {o.passes.deliver = false; o.acceptEdit("pending");}
  o.beginRestore();
  // A covered or kept document opens no retirement, so it stays hosted until the restart.
  if (!covered && !live) {
    o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner", enabled: false, nowMs: 60, guard() {}});
    await o.depart();
    await passed();
  } else expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  o.f.storage.advanceStopRestoreFence(stopLookup, 50);
  if (stopped) await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  const admission = admitted ? await admitMovedRestore(o) : undefined;
  await o.host.close(); log.mockClear(); o.passes.deliver = true;
  if (admitted) {Object.assign(o.f.config, {restore: RESTORE}); await o.f.save();}
  moveAway(o);
  const other = {...o.sibling, objectId: "another-object"};
  let driver: ServiceActivationDriver | undefined;
  const addTarget = ServiceActivationDriver.prototype.addTarget;
  vi.spyOn(ServiceActivationDriver.prototype, "addTarget").mockImplementation(function (this: ServiceActivationDriver, ...args) {driver = this; return addTarget.apply(this, args);});
  if (replacement) o.refuseCaptureAt(o.sibling.path, new Error("Replacement capture refused."));
  const host = replacement ? await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)}) : await restartedHost(o);
  if (replacement) {
    cleanup.push(() => host.close());
    await host.update({workspaces: [o.workspace], documents: [other], departing: [o.sibling]});
  }
  await passed();
  expect(leaving(o)).toEqual([]);
  expect(host.retains(o.sibling)).toBe(true);
  expect(host.drained("workspace")).toBe(false);
  return {o, host, other, log, k, admission, driver: () => driver};
};
// Restore preparation as liveRestoreDrain.test.ts configures it.
const RESTORE = {maxBytes: 1_000_000, maxEvents: 10, aggregateBytes: 17_000_000, workingReserveBytes: 1_000_000, maxOperations: 1, validation: restorePolicy};
const jsonHash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));
// The relay admits the restore on the host that fenced it, while the document
// is still at its path, as liveRestoreDrain.test.ts builds an admitted restore.
// The engine commits the native fence, and the owner's host proposes a
// content-valid candidate that restores the selected point, which the relay
// records and admits. Admission moves the open retirement's accepted-through
// to the restore's own cursor; `before` is the retirement's key before it.
const admitMovedRestore = async (o: Enrolled) => {
  const before = retirementKey(o);
  return {proposalDigest: await admitRestore(o), before};
};
// The relay admits the owner's restore as `admitMovedRestore` does, and returns its proposal's digest.
const admitRestore = async (o: Enrolled) => {
  const store = o.f.storage.createLiveCommittedDeliveryStore(o.f.history);
  const input = {...stopLookup, host: o.host.coordinate, maxBytes: RESTORE.maxBytes, maxEvents: RESTORE.maxEvents};
  const fence = {operation: store.pendingStopRestoreFence(input).operation, localHeadSequence: 11, recordedAtMs: 100};
  store.acknowledgeStopRestoreFence(input, fence);
  const selected = store.captureStopRestorePoint(input), accepted = store.captureStopRestoreAcceptedCut(input);
  const point = new Y.Doc({gc: false}), head = new Y.Doc({gc: false});
  let encoded: Uint8Array;
  try {
    Y.applyUpdate(point, selected.checkpoint.bytes); for (const e of selected.events) Y.applyUpdate(point, e.updateBytes);
    Y.applyUpdate(head, accepted.checkpoint.bytes); for (const e of accepted.events) Y.applyUpdate(head, e.updateBytes);
    const frozen = Y.encodeStateAsUpdate(head), pointBytes = Y.encodeStateAsUpdate(point), vector = Y.encodeStateVector(head);
    const used = Y.decodeStateVector(vector); let client = 1; while (used.has(client)) client++; head.clientID = client;
    head.transact(() => {
      const body = head.getXmlFragment("body"); body.delete(0, body.length);
      body.insert(0, point.getXmlFragment("body").toArray().map(node => {
        if (!(node instanceof Y.XmlElement || node instanceof Y.XmlText)) throw new Error("Unexpected fixture body.");
        return node.clone();
      }));
      const fields = head.getMap("frontmatter"); for (const key of fields.keys()) fields.delete(key);
      for (const [key, value] of point.getMap("frontmatter").entries()) fields.set(key, structuredClone(value));
    });
    const candidate = Y.encodeStateAsUpdate(head, vector);
    const validated = createLiveMarkdownJournalValidator(restorePolicy)({document: o.document, currentPath: selected.binding.currentPath,
      checkpoint: frozen, suffix: [], candidate});
    if (validated.kind !== "accepted") throw new Error(validated.reason);
    const receipt = {fence, point: resolveLiveRestorePoint(selected, restorePolicy), candidateDigest: sha256(candidate), frozenStateDigest: sha256(frozen),
      pointStateDigest: sha256(pointBytes), finalContentDigest: "d".repeat(64), beforeStateVector: [...vector], afterStateVector: [...Y.encodeStateVector(head)],
      replacementRanges: [...validated.evidence.candidate.ranges], originEvidenceDigest: store.captureStopRestoreOwnerOrigin(input).evidenceDigest,
      selectedHistory: selected.proof, acceptedHistory: accepted.proof, nativeSources: [], nativeSourceManifestDigest: jsonHash([fence, []])};
    encoded = encodeNativeRestoreProposal(JSON.stringify(receipt), {candidateBytes: candidate, frozenStateBytes: frozen, pointStateBytes: pointBytes, nativeSourceBytes: []}, input);
  } finally {point.destroy(); head.destroy();}
  const {proposalDigest} = await store.recordStopRestoreProposal(input, encoded, restoreValidation, 200);
  await store.admitStopRestoreProposal(input, proposalDigest, restoreValidation, 201);
  return proposalDigest;
};
// The engine's side of the admitted restore's end, on `host`, after the
// document moved. It answers apply, settle and resume from the admission the
// relay holds. `publish` appends the restore's settlement, as the retiring
// host's push does, which the retirement waits for.
const restoreEngine = (o: Enrolled, host: Awaited<ReturnType<typeof startServiceLiveHost>>) => {
  const store = o.f.storage.createLiveCommittedDeliveryStore(o.f.history), coordinate = host.coordinate;
  const input = {...stopLookup, host: coordinate, maxBytes: RESTORE.maxBytes, maxEvents: RESTORE.maxEvents};
  const hostCoordinate = {hostId: coordinate.hostId, hostEpoch: coordinate.hostEpoch, instanceId: coordinate.instanceId, connectionId: coordinate.connectionId};
  const admission = () => {
    const lifecycle = store.readStopRestoreLifecycle(input);
    if (!lifecycle) throw new Error("Missing restore admission.");
    return lifecycle;
  };
  // The engine's receipts, as admitRestore in liveRestoreDrain.test.ts builds them. The settlement
  // counts only the restore's own application: this journal holds fewer rows than that test's three.
  const answer = (operation: string) => {
    const {preparation, candidateDigest, nativeSourceManifestDigest, admitted} = admission(), localHeadSequence = preparation.fence.localHeadSequence + 1;
    const settlementId = "restore-settlement", momentId = "restore-moment", markdownDigest = preparation.point.markdownDigest;
    if (operation === "apply") return {fence: preparation.fence, candidateDigest, nativeSourceManifestDigest, admitted, localHeadSequence, hostCoordinate, recordedAtMs: 202};
    if (operation === "settle") return {settlementId, previousCursor: 0, terminalCursor: admitted.accepted.receipt.journalCursor, applicationCount: 1,
      localYDocSequence: localHeadSequence, momentId, markdownDigest, materialized: true, collectionReconcileRequired: false};
    return {relayDatabaseNamespace: preparation.fence.operation.relayDatabaseNamespace, operationId: stopLookup.operationId, binding: admitted.accepted.binding,
      applicationReceipt: admitted.accepted.receipt, settlementId, momentId, markdownDigest, localHeadSequence, recordedAtMs: 204};
  };
  const sendLiveRestore = vi.fn(async (_request: unknown, operation: string) => ({bytes: Buffer.from(JSON.stringify(answer(operation)))}));
  Object.assign(o.client(), {sendLiveRestore});
  // Proves and appends the restore's settlement moment, as publishRestore in liveRestoreDrain.test.ts does.
  const publish = async () => {
    const {admitted} = admission(), document = o.document, terminal = admitted.accepted.receipt.journalCursor, binding = {...admitted.accepted.binding};
    const row = o.raw.prepare("SELECT * FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(terminal)!;
    const bytes = row.validation_checkpoint_bytes as Uint8Array;
    const normalized = createLiveMarkdownRegistrationValidator(restorePolicy)({document, currentPath: binding.currentPath, checkpoint: bytes});
    if (normalized.kind !== "accepted") throw new Error(normalized.reason);
    const markdown = Buffer.from(normalized.evidence.projectedMarkdown), markdownDigest = sha256(markdown), stateDigest = sha256(bytes);
    for (const [digest, content] of [[stateDigest, bytes], [markdownDigest, markdown]] as const)
      o.f.storage.putBlob({workspaceId: document.workspaceId, sha256: digest, content, createdAtMs: 1});
    const before = String(o.raw.prepare("SELECT baseline_projected_sha256 FROM sync_relay_live_documents WHERE object_id=?").get(document.objectId)!.baseline_projected_sha256);
    const namespace = String(row.relay_database_namespace), key = [namespace, document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId];
    const acceptedEventCount = Number(row.accepted_event_count);
    const record = {settlementId: "", relayDatabaseNamespace: namespace, binding, hostCoordinate, previousCursor: 0, terminalCursor: terminal,
      previousYdocSequence: 0, localYdocSequence: 1, applicationCount: acceptedEventCount, nativeIntervalDigest: sha256(Buffer.from("native-interval-restore")), acceptedEventCount,
      acceptedIntervalDigest: jsonHash(["live-settlement-accepted-interval-v1", key, [0, 0, initialAcceptedHistoryDigest(namespace, document)],
        [acceptedEventCount, terminal, row.accepted_evidence_digest]]),
      momentId: "restore-publication", markdownDigest, sourceStateVectorDigest: sha256(Buffer.from("state-vector-restore")), acceptedStateBlobSha256: stateDigest,
      recordedAtMs: 1, restoreOperationId: null};
    record.settlementId = nativeSettlementId(record);
    const payload = {momentId: record.momentId, objectId: document.objectId, versionId: "main", path: binding.currentPath, operation: "write",
      payloadBeforePath: binding.currentPath, payloadAfterPath: binding.currentPath, payloadBeforeContentKind: "text", payloadAfterContentKind: "text",
      payloadBeforeBlobSha256: before, payloadAfterBlobSha256: markdownDigest, payloadAfterByteLength: markdown.byteLength, recordedAtMs: 1,
      settlementReference: {formatVersion: 1, recordDigest: settlementRecordDigest(record), record}};
    const op = {originSeq: 0, opKind: "moment.append", payloadJson: stableJsonStringify(payload), recordedAtMs: 1};
    await prepareHostedSettlements(o.f.storage as StorageContext, {workspaceId: "workspace", originId: "proof", ops: [op]});
    expect(op).toMatchObject({settlementAdmission: {status: "accepted"}});
    expect(o.f.storage.appendLogBatch({workspaceId: "workspace", originId: "proof", ops: [op]})).toMatchObject({inserted: 1});
  };
  return {sendLiveRestore, publish};
};

// Proves: a restarted host keeps the route of a moved document's unfinished
// restore, by its object, though the document left its enrolled path. Its
// retirement waits for the restore, and nothing activates it at the old path.
// The owner's Decline then reaches the engine through that route, and the
// retirement at the generation it restored settles the document under its
// retirement key, as a running host does for a document that moved while
// hosted, then retires it. The same holds when another Edit grant left the
// document covered and the owner's Pause opened the retirement after the
// restore began.
it.each([false, true])("keeps a moved document's restore route after a restart until the owner declines it, then retires it, paused: %s", async paused => {
  const {o, host} = await movedDuringRestore({paused});
  const complete = vi.spyOn(ServiceActivationStore.prototype, "completeRetirement");
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  const key = retirementKey(o);
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(retiredRow(o).retired).toBe(true);
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({key}));
  expect(leaving(o)).toContain("liveApplication.releaseActivation");
  expect(leaving(o)).not.toContain("liveApplication.unloadDocument");
  expect(retiringSettles(o, 0)).toEqual([["liveApplication.settle", expect.objectContaining({retirement: key})]]);
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(host.retains(o.sibling)).toBe(false);
});

// Proves: a moved document's restore that the relay admitted, which no Decline
// can end, completes through the restarted host's route: the relay admitted it
// before the move, and the restarted host records each engine step through
// resume. Once the restore's settlement
// is published, its retirement runs at the key the admission left, not the one
// before it, and completes, and the route ends.
it("completes a moved document's admitted restore through a restarted host, then retires it", async () => {
  const {o, host, admission} = await movedDuringRestore({admitted: true});
  const {proposalDigest, before} = admission!, {sendLiveRestore, publish} = restoreEngine(o, host);
  const complete = vi.spyOn(ServiceActivationStore.prototype, "completeRetirement");
  await expect(host.completeRestore(stopLookup, proposalDigest)).resolves.toMatchObject({kind: "resumed", proposalDigest});
  expect(sendLiveRestore.mock.calls.map(call => call[1])).toEqual(["apply", "settle", "resume"]);
  expect(o.f.storage.readStopRestore(stopLookup)?.phase).toBe("resumed");
  const moved = retirementKey(o);
  expect(moved.acceptedThrough).toBeGreaterThan(before.acceptedThrough);
  expect(retiredRow(o).retired).toBe(false);
  await publish();
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(retiredRow(o).retired).toBe(true);
  expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({key: moved}));
  expect(complete).not.toHaveBeenCalledWith(expect.objectContaining({key: before}));
  // The retirement may settle again on each pass that waited for the settlement.
  const settles = retiringSettles(o, 0).map(([, params]) => (params as {retirement: unknown}).retirement);
  expect(settles.length).toBeGreaterThan(0);
  expect(settles).toEqual(settles.map(() => moved));
  expect(leaving(o)).toContain("liveApplication.releaseActivation");
  expect(leaving(o)).not.toContain("liveApplication.unloadDocument");
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
  expect(host.retains(o.sibling)).toBe(false);
  await expect(host.completeRestore(stopLookup, proposalDigest)).rejects.toThrow("Service restore source is unavailable.");
});

// Proves: once a moved document's restore ended, a restart before its
// retirement completed still completes it. After a Decline the retirement
// stops at its reconciliation, or at a release the engine never answered, and
// the restarted host finds the retirement from the restore the relay recorded
// and completes it at the retirement's current key, also when the owner's
// Pause opened that retirement after the restore began.
it.each([["liveApplication.reconcileActivation", false], ["liveApplication.releaseActivation", false], ["liveApplication.reconcileActivation", true]] as const)(
  "completes a moved document's retirement after a restart that follows its Decline, stopped at %s, paused: %s", async (method, paused) => {
    const {o, host} = await movedDuringRestore({paused});
    const reached = unansweredAfter(o, method, 0);
    expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
    await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
    await reached;
    await host.close();
    const key = retirementKey(o), complete = vi.spyOn(ServiceActivationStore.prototype, "completeRetirement");
    const restarted = await restartedHost(o);
    await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true), {timeout: 10_000});
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({key}));
    expect(leaving(o)).toContain("liveApplication.releaseActivation");
    expect(leaving(o)).not.toContain("liveApplication.unloadDocument");
    expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true), {timeout: 10_000});
  });

// Proves: a restart after a moved document's admitted restore completed, but
// before its retirement completed, still completes the retirement, at the key
// the admission left.
it("completes a moved document's retirement after a restart that follows its admitted restore", async () => {
  const {o, host, admission} = await movedDuringRestore({admitted: true});
  const {proposalDigest, before} = admission!, {publish} = restoreEngine(o, host);
  const complete = vi.spyOn(ServiceActivationStore.prototype, "completeRetirement");
  const reached = unansweredAfter(o, "liveApplication.reconcileActivation", 0);
  await expect(host.completeRestore(stopLookup, proposalDigest)).resolves.toMatchObject({kind: "resumed", proposalDigest});
  const moved = retirementKey(o);
  expect(moved.acceptedThrough).toBeGreaterThan(before.acceptedThrough);
  await publish();
  await reached;
  await host.close();
  expect(complete).not.toHaveBeenCalled();
  expect(retiredRow(o).retired).toBe(false);
  const restarted = await restartedHost(o);
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(retiredRow(o).retired).toBe(true);
  expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({key: moved}));
  expect(complete).not.toHaveBeenCalledWith(expect.objectContaining({key: before}));
  expect(leaving(o)).toContain("liveApplication.releaseActivation");
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
});

// The enrolled document's owner, as the relay checks whether it stays live for them.
const ownerCovers = (o: Enrolled) => o.f.storage.serviceHostEnrollmentCovered({workspaceId: "workspace", objectId: "object", ownerUserId: "owner",
  shareId: "share", path: o.sibling.path});
const activations = (o: Enrolled) => o.raw.prepare("SELECT activation_id FROM sync_relay_service_activations ORDER BY rowid").all().map(row => row.activation_id);
const ownerBinding = (o: Enrolled) => o.f.storage.resolveCurrentLiveDocumentBinding({document: o.document, actor: {kind: "owner", userId: "owner", shareId: "share"}});
// The owner's restore request, as `beginRestore` sends it.
const restoreRequest = (o: Enrolled) => o.f.storage.readStopRestorePlan({document: o.document, ownerUserId: "owner", operationId: "restore", shareId: "share",
  grantId: "grant", restorePointCursor: 0, restorePointReceiptDigest: o.document.lineageClaimId, maxOutputBytes: 1_000_000}).intent;
// The workspace's stored bytes, as the relay charges them against its quota.
const usage = (o: Enrolled) => Number(o.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes);
// The note's text in the relay's accepted journal, applied in order. The mocked engine applies no text, so this is not the native file's.
const journalText = (o: Enrolled) => {
  const read = o.f.storage.readLiveUpdateJournalCut({document: o.document});
  if (read.kind !== "cut") throw new Error("Missing live journal.");
  const doc = new Y.Doc();
  for (const bytes of [read.cut.checkpoint.bytes, ...read.cut.suffix.map(row => row.bytes)]) Y.applyUpdate(doc, bytes);
  const text = yDocToMarkdown(doc); doc.destroy();
  return text;
};
// The note restored to its first version, with the owner's later `edit`.
const restoredText = (edit?: string) => {
  const doc = markdownToYDoc("Original");
  if (edit !== undefined) doc.getMap("frontmatter").set("edit", edit);
  const text = yDocToMarkdown(doc); doc.destroy();
  return text;
};
// Closes the relay database and opens the same file again, as a relay restart does. The fixture's closures read `o.f`, so they use the reopened store.
const reopenRelay = (o: Enrolled) => {
  o.f.closeStorage();
  const reopened = openRelayDeployment(join(o.f.root, "deployment.json"));
  let closed = false;
  const closeStorage = () => { if (!closed) { reopened.storage.close(); closed = true; } };
  cleanup.push(async () => closeStorage());
  Object.assign(o.f, {...reopened, closeStorage});
};
// Closes `previous` and the relay database, reopens the database, and starts a host on it, configured for restore, that hosts the note.
const hostingAgain = async (o: Enrolled, previous: Awaited<ReturnType<typeof startServiceLiveHost>>) => {
  await previous.close();
  reopenRelay(o);
  Object.assign(o.f.config, {restore: RESTORE}); await o.f.save();
  const host = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => host.close());
  await host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  return host;
};
// The owner edits the note live again: the kept activation, with no retirement or successor, at the restored fence, for the owner alone.
const ownerEditsAgain = async (o: Enrolled, host: Awaited<ReturnType<typeof startServiceLiveHost>>, fence: number) => {
  await vi.waitFor(() => expect(host.isDocumentReady(o.document)).toBe(true), {timeout: 10_000});
  expect(activations(o)).toEqual([ACTIVATION]);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(ownerBinding(o)).toMatchObject({kind: "current", binding: {restoreFenceGeneration: fence}});
  expect(o.f.storage.resolveCurrentLiveDocumentBinding({document: o.document, actor: {kind: "named", userId: "reader", grantId: "grant"}}).kind).toBe("refused");
  expect(o.f.storage.getShareGrant("grant")).toMatchObject({status: "revoked"});
};
// The delivery IDs the current daemon was sent, in order.
const delivered = (o: Enrolled) => o.client().sendLiveApplication.mock.calls
  .map(([, event]) => (event as {metadata: {accepted: {receipt: {deliveryId: string}}}}).metadata.accepted.receipt.deliveryId);
// The owner's live edit: the relay admits it once, the kept session is sent it once, and a settlement then ends at it.
const editOnce = async (o: Enrolled, host: Awaited<ReturnType<typeof startServiceLiveHost>>, value: string) => {
  const edit = o.acceptEdit(value, host.coordinate);
  await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true), {timeout: 10_000});
  expect(await host.settle(o.document)).toMatchObject({terminalCursor: edit.journalCursor, materialized: true});
  expect(o.ownerCalls().filter(([method]) => method === "liveApplication.settle").at(-1)?.[1])
    .toMatchObject({terminalReceipt: {deliveryId: edit.deliveryId, journalCursor: edit.journalCursor}});
  expect(delivered(o).filter(id => id === edit.deliveryId)).toHaveLength(1);
  expect(o.raw.prepare("SELECT count(*) AS count FROM sync_relay_live_update_journal WHERE delivery_id=?").get(edit.deliveryId)!.count).toBe(1);
  expect(journalText(o)).toBe(restoredText(value));
};

// Proves: the owner keeps editing a note after restoring it, when the restore
// ended its last Edit grant. The restore keeps the owner's live session: its
// activation never retires and no successor starts. Once the restore resumed,
// that session registers at the restored fence, the relay's journal holds the
// restored text, and the owner's next edit is sent once and settled. A relay
// restart that reopens its database while the restore is unfinished, and
// another after it resumed, change none of this. A begin or a completion
// retried after a lost reply records and charges nothing more.
it("keeps the owner editing a note after restoring it, when the restore ended its last Edit grant", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fence = o.binding.restoreFenceGeneration + 1;
  const intent = () => String(o.raw.prepare("SELECT intent_json FROM sync_relay_live_restore_operations WHERE operation_id='restore'").get()!.intent_json);
  const request = restoreRequest(o), begun = o.f.storage.beginStopRestore(request, 40), charged = usage(o), marked = intent();
  // The same request again, after its reply was lost, writes nothing.
  expect(o.f.storage.beginStopRestore(request, 40)).toEqual(begun);
  expect(usage(o)).toBe(charged);
  expect(intent()).toBe(marked);
  expect(o.raw.prepare("SELECT count(*) AS count FROM sync_relay_live_restore_operations").get()!.count).toBe(1);
  expect(marked.split('"keptRun"')).toHaveLength(2);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(JSON.parse(marked)).toMatchObject({keptRun: {runToken: 10, ownerUserId: "owner", shareId: "share", activationId: ACTIVATION}});
  expect(ownerCovers(o)).toBe(true);
  expect(ownerBinding(o).kind).toBe("refused");
  o.f.storage.advanceStopRestoreFence(stopLookup, 50);
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  const proposalDigest = await admitRestore(o);
  // A restart while the restore is unfinished keeps the note with its host, and the restore finishes there.
  let host = await hostingAgain(o, o.host);
  expect(ownerCovers(o)).toBe(true);
  expect(activations(o)).toEqual([ACTIVATION]);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(true);
  const {publish} = restoreEngine(o, host);
  const resumed = await host.completeRestore(stopLookup, proposalDigest);
  expect(resumed).toMatchObject({kind: "resumed", proposalDigest});
  const completed = usage(o), recorded = intent();
  expect(await host.completeRestore(stopLookup, proposalDigest)).toEqual(resumed);
  expect(usage(o)).toBe(completed);
  expect(intent()).toBe(recorded);
  expect(recorded.split('"keptRun"')).toHaveLength(2);
  await publish();
  await ownerEditsAgain(o, host, fence);
  const registered = o.ownerCalls().filter(([method]) => method === "liveApplication.register").map(([, params]) => params);
  expect(registered.at(-1)).toMatchObject({activationId: ACTIVATION, binding: {restoreFenceGeneration: fence}});
  expect(journalText(o)).toBe(restoredText());
  await editOnce(o, host, "after");
  // A restart after the restore resumed continues the same session.
  host = await hostingAgain(o, host);
  await ownerEditsAgain(o, host, fence);
  expect(delivered(o)).not.toContain("edit-after");
  expect(journalText(o)).toBe(restoredText("after"));
  await editOnce(o, host, "again");
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
});

// Proves: a restore the owner declines, or cancels, ends the live session it
// kept. Ending it opens the retirement the restore's revocation skipped, at
// the fence the note is left at, and the relay refuses the owner's live
// editing. Once the host lets the note go, the activation retires.
it.each([
  {when: "before its fence", fenced: false, fenceCommitted: false},
  {when: "after its fence", fenced: true, fenceCommitted: false},
  {when: "after its native fence committed", fenced: true, fenceCommitted: true},
])("ends live editing a restore kept when the owner declines it $when", async ({fenced, fenceCommitted}) => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.engine.fenceCommitted = fenceCommitted;
  o.beginRestore();
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  if (fenced) {
    o.f.storage.advanceStopRestoreFence(stopLookup, 50);
    await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
    expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
    await expect(o.host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  } else expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("declined");
  expect(o.f.storage.serviceActivationRetirement(o.document))
    .toMatchObject({activationId: ACTIVATION, restoreFenceGeneration: o.binding.restoreFenceGeneration + (fenceCommitted ? 1 : 0)});
  expect(ownerCovers(o)).toBe(false);
  expect(ownerBinding(o).kind).toBe("refused");
  if (fenceCommitted) return;
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(retiredRow(o).retired).toBe(true);
  expect(ownerCovers(o)).toBe(false);
  expect(ownerBinding(o).kind).toBe("refused");
});

// The owner moves the note to `path`: its object's newest moment names that path.
const moveNote = (o: Enrolled, path: string, relaySeq: number) => o.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,
  moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) SELECT workspace_id,object_id,?,?,version_id,?,blob_sha256,content_kind,byte_length,?
  FROM sync_relay_object_moments WHERE object_id='object' ORDER BY relay_seq DESC LIMIT 1`).run(relaySeq, `moved-${relaySeq}`, path, relaySeq);
// The retiring host's push of the restored note, which puts the restore in the relay's ordinary history, and the
// successor's native capture after it: the restored state, sourced from the restore's settlement moment.
const pushRestoredNote = (o: Enrolled): NativeOwnerActivation => {
  const ordinary = new Y.Doc({gc: false}), restored = new Y.Doc({gc: false});
  for (const bytes of [o.engine.capture.baselineBytes, o.engine.capture.fullState]) Y.applyUpdate(ordinary, bytes);
  // The state at the journal's last cursor, as the restore's settlement settled it.
  Y.applyUpdate(restored, o.raw.prepare("SELECT validation_checkpoint_bytes FROM sync_relay_live_update_journal ORDER BY journal_cursor DESC LIMIT 1")
    .get()!.validation_checkpoint_bytes as Uint8Array);
  const update = Buffer.from(Y.encodeStateAsUpdate(restored, Y.encodeStateVector(ordinary))), fullState = Buffer.from(Y.encodeStateAsUpdate(restored));
  ordinary.destroy(); restored.destroy();
  o.raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)").run(sha256(update), update.length, update);
  o.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','origin',3,'ydoc.update',?,3)")
    .run(JSON.stringify({versionId: "main", objectId: "object", path: o.sibling.path, contentKind: "richdoc", isBaseState: false,
      lineageClaimId: o.document.lineageClaimId, updateBlobSha256: sha256(update)}));
  const moment = o.raw.prepare("SELECT moment_id,blob_sha256,byte_length FROM sync_relay_object_moments WHERE moment_id='restore-publication'").get()!;
  const head = Number(o.raw.prepare("SELECT max(relay_seq) AS head FROM sync_relay_log").get()!.head);
  return {...o.engine.capture, activationId: SUCCESSOR, fullState, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION,
    committedCursor: head, sourceMomentId: String(moment.moment_id), sourceDigest: String(moment.blob_sha256), sourceByteLength: Number(moment.byte_length),
    fullStateDigest: sha256(fullState), fullStateByteLength: fullState.length}};
};

// Proves: when the owner renames a note after a restore kept their live
// session and resumed, the self-host supervisor retires that session through
// its host. The host reconciles, settles and releases the activation, and
// never unloads the note as an ordinary departure. When the owner moves the
// note back and shares it again with Edit, the same daemon starts a successor
// activation, and the note is ready again.
it("retires a restored note's kept session through its host once the note is renamed, and starts a successor when it is shared again", async () => {
  const o = await enrolledServiceHost({supervised: true});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fence = o.binding.restoreFenceGeneration + 1;
  o.beginRestore();
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  o.f.storage.advanceStopRestoreFence(stopLookup, 50);
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  const proposalDigest = await admitRestore(o), {publish} = restoreEngine(o, o.host);
  await expect(o.host.completeRestore(stopLookup, proposalDigest)).resolves.toMatchObject({kind: "resumed", proposalDigest});
  await publish();
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true), {timeout: 10_000});
  expect(ownerBinding(o)).toMatchObject({kind: "current", binding: {restoreFenceGeneration: fence}});
  expect(ownerCovers(o)).toBe(true);
  // The owner renames the note, so the restore no longer keeps its session.
  const sent = o.ownerCalls().length, membership = o.membership.length;
  const complete = vi.spyOn(ServiceActivationStore.prototype, "completeRetirement");
  moveNote(o, "docs/renamed.md", 1_000_000);
  o.supervisor!.reconcile();
  // The supervisor releases the enrollment once the host let the note go.
  await vi.waitFor(() => expect(o.raw.prepare("SELECT retired,host_drained_at_ms IS NOT NULL AS drained FROM sync_relay_service_host_enrollments").get())
    .toEqual({retired: 1, drained: 1}), {timeout: 10_000});
  expect(o.membership.slice(membership).filter(row => row.method === "liveApplication.unloadDocument")).toEqual([]);
  expect(o.calls(sent)).toEqual(expect.arrayContaining(retirement));
  expect(retiredRow(o).retired).toBe(true);
  expect(complete.mock.results.at(-1)?.value).toMatchObject({status: "retired"});
  expect(ownerBinding(o).kind).toBe("refused");
  // The owner moves the note back and shares it again with Edit, on the same daemon.
  o.engine.capture = pushRestoredNote(o);
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  moveNote(o, o.sibling.path, 1_000_001);
  anotherEditGrant(o);
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 400, guard() {}});
  o.supervisor!.reconcile();
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true), {timeout: 10_000});
  expect(o.raw.prepare("SELECT activation_id,predecessor_activation_id,completion_json IS NOT NULL AS completed FROM sync_relay_service_activations ORDER BY rowid").all())
    .toEqual([{activation_id: ACTIVATION, predecessor_activation_id: null, completed: 1}, {activation_id: SUCCESSOR, predecessor_activation_id: ACTIVATION, completed: 1}]);
  expect(o.spawned()).toBe(1);
  expect(o.errors).toEqual([]);
});

// Proves: a restore request cannot name a live session for the relay to keep.
// The relay records only the session its revocation kept, under the current
// run, owner and share, and none when another Edit grant still covers the note.
it.each([false, true])("records only the live session the restore kept, never one its request names, another Edit grant: %s", async covered => {
  const o = await enrolledServiceHost();
  if (covered) anotherEditGrant(o);
  const request = restoreRequest(o), named = {runToken: 99, ownerUserId: "owner", shareId: "named-share", activationId: "named-activation"};
  o.f.storage.beginStopRestore({...request, keptRun: named} as typeof request, 40);
  const stored: {keptRun?: unknown} = JSON.parse(String(o.raw.prepare("SELECT intent_json FROM sync_relay_live_restore_operations").get()!.intent_json));
  expect(stored.keptRun).toEqual(covered ? undefined : {runToken: 10, ownerUserId: "owner", shareId: "share", activationId: ACTIVATION});
  expect(o.f.storage.readStopRestore(stopLookup)?.intent).toEqual(request);
});

// Proves: the owner's restore is charged for the record it stores, and no
// more. A restore that keeps nothing fits in exactly the room it needs, and one
// byte less refuses it. Keeping the owner's live session adds only the bytes of
// its marker. A refused restore records nothing and leaves the Edit grant active.
it("charges the owner's restore for the record it stores, and no more", async () => {
  const o = await enrolledServiceHost(), storage = o.f.storage as StorageContext;
  // The bytes a restore would add, read from its refusal with no room left.
  const charge = () => {
    storage.options.workspaceQuotaBytes = usage(o);
    const refused = (() => { try { o.beginRestore(); } catch (error) { return error; } })();
    expect(refused).toBeInstanceOf(SyncRelayQuotaExceededError);
    const measured = /: (\d+) bytes would exceed/.exec((refused as Error).message);
    expect(measured).not.toBeNull();
    return Number(measured![1]) - usage(o);
  };
  anotherEditGrant(o);
  const plain = charge();
  o.raw.exec("DELETE FROM sync_relay_share_grants WHERE grant_id='editor-grant'");
  const kept = charge();
  expect(o.raw.prepare("SELECT count(*) AS count FROM sync_relay_live_restore_operations").get()!.count).toBe(0);
  expect(o.f.storage.getShareGrant("grant")).toMatchObject({status: "active"});
  anotherEditGrant(o);
  storage.options.workspaceQuotaBytes = usage(o) + plain - 1;
  expect(() => o.beginRestore()).toThrow(SyncRelayQuotaExceededError);
  storage.options.workspaceQuotaBytes = usage(o) + plain;
  o.beginRestore();
  expect(usage(o)).toBe(storage.options.workspaceQuotaBytes);
  const row = o.raw.prepare("SELECT intent_json,accounted_bytes FROM sync_relay_live_restore_operations").get()!, stored = String(row.intent_json);
  expect(row.accounted_bytes).toBe(plain);
  expect(JSON.parse(stored)).not.toHaveProperty("keptRun");
  const marked = JSON.stringify({...JSON.parse(stored), keptRun: {runToken: 10, ownerUserId: "owner", shareId: "share", activationId: ACTIVATION}});
  expect(kept - plain).toBe(Buffer.byteLength(JSON.stringify(marked)) - Buffer.byteLength(JSON.stringify(stored)));
});

// Each way an owner ends a document's live editing: deleting its share, Pause, or Stop.
const endLiveEditing = {
  unshare: (o: Enrolled) => expect(o.f.storage.revokeShare("share", 30)).toBe(true),
  pause: (o: Enrolled) => o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner", enabled: false, nowMs: 30, guard() {}}),
  stop: (o: Enrolled) => o.stop(),
};
// The document moves while hosted, and `end` ends its live editing. Its daemon
// stops while the engine holds the retirement's reconciliation, and a fresh
// host starts with the retirement open, hosting `other` at the old path when
// `replacement` is set. Resolves once that host completed the retirement at
// the key it had when the first daemon stopped.
const movedRetirementAfterRestart = async (o: Enrolled, end: keyof typeof endLiveEditing, {replacement = false} = {}) => {
  moveAway(o);
  const reached = unansweredAfter(o, "liveApplication.reconcileActivation", 0);
  endLiveEditing[end](o);
  await o.depart();
  await reached;
  const key = retirementKey(o);
  await o.host.close();
  expect(retiredRow(o).retired).toBe(false);
  const complete = vi.spyOn(ServiceActivationStore.prototype, "completeRetirement");
  const other = {...o.sibling, objectId: "another-object"};
  let driver: ServiceActivationDriver | undefined;
  const addTarget = ServiceActivationDriver.prototype.addTarget;
  vi.spyOn(ServiceActivationDriver.prototype, "addTarget").mockImplementation(function (this: ServiceActivationDriver, ...args) {driver = this; return addTarget.apply(this, args);});
  let host;
  if (replacement) {
    o.refuseCaptureAt(o.sibling.path, new Error("Replacement capture refused."));
    const started = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
    cleanup.push(() => started.close());
    await started.update({workspaces: [o.workspace], documents: [other], departing: [o.sibling]});
    host = started;
  } else host = await restartedHost(o);
  await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true), {timeout: 10_000});
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({key}));
  return {host, key, other, driver: () => driver};
};
// The retirement form of each settlement, and each release, the current daemon sent.
const retirementRequests = (o: Enrolled) => ({
  settles: retiringSettles(o, 0).map(([, params]) => (params as {retirement: unknown}).retirement),
  releases: o.ownerCalls().filter(([method]) => method === "liveApplication.releaseActivation").map(([, params]) => params)});

// Proves: a restart while a moved document's retirement is open completes
// that retirement, though its activation had no restore and no edit waits for
// a recovery copy. The restarted host settles and releases the document at the
// retirement's object, activation and generation, without an ordinary unload,
// and its workspace drains. An edit the relay accepted before the move is in
// the retirement's key and the retired owner's tip.
it.each((Object.keys(endLiveEditing) as (keyof typeof endLiveEditing)[]).flatMap(end => [[end, false], [end, true]] as const))(
  "completes a moved document's retirement after a restart with no restore, ended by %s, with an accepted edit: %s", async (end, accepted) => {
    const o = await enrolledServiceHost();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const edit = accepted ? o.acceptEdit("before") : undefined;
    if (edit) await vi.waitFor(() => expect(o.applied.has(edit.deliveryId)).toBe(true));
    const {host, key} = await movedRetirementAfterRestart(o, end);
    if (edit) {
      expect(key.acceptedThrough).toBe(edit.journalCursor);
      expect(o.retiredTip()).toEqual(edit);
    }
    const {settles, releases} = retirementRequests(o);
    expect(settles.length).toBeGreaterThan(0);
    expect(settles).toEqual(settles.map(() => key));
    expect(releases.length).toBeGreaterThan(0);
    expect(releases).toEqual(releases.map(() => expect.objectContaining(key)));
    expect(leaving(o)).not.toContain("liveApplication.unloadDocument");
    expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
    expect(host.retains(o.sibling)).toBe(false);
  });

// Proves: with another document created at the old path while a moved
// document's retirement is open, the restarted host still retires the moved
// document by its own object. The other document keeps its own state: its
// target at the old path stays, its capture continues there, and the relay
// gives it no activation. The fake engine captures only the fixture document,
// so that capture is refused.
it("completes a moved document's retirement after a restart by its own object while another document holds its old path", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const {host, key, other, driver} = await movedRetirementAfterRestart(o, "stop", {replacement: true});
  expect(key.objectId).toBe(o.document.objectId);
  const {settles, releases} = retirementRequests(o);
  expect(settles.length).toBeGreaterThan(0);
  expect(settles).toEqual(settles.map(() => key));
  expect(releases.length).toBeGreaterThan(0);
  expect(releases).toEqual(releases.map(() => expect.objectContaining(key)));
  await vi.waitFor(() => expect(host.retains(o.sibling)).toBe(false), {timeout: 10_000});
  expect(driver()!.targets.filter(target => target.path === o.sibling.path)).toEqual([expect.objectContaining({path: o.sibling.path, shareId: other.shareId})]);
  const captures = () => o.client().captureOwnerActivation.mock.calls.filter(call => (call as unknown[])[1] === o.sibling.path).length, seen = captures();
  await vi.waitFor(() => expect(captures()).toBeGreaterThan(seen), {timeout: 10_000});
  expect(o.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_service_activations WHERE object_id=?").get(other.objectId)).toEqual({count: 0});
  expect(host.drained("workspace")).toBe(false);
});

// Proves: once that retirement completed, the document can move back to its
// old path and be shared again. Its successor activates there for the same
// object, under its one enrollment, and edits reach it.
it("brings live editing back at a moved document's old path once its retirement completed after a restart", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const tip = o.tip(), {host} = await movedRetirementAfterRestart(o, "stop");
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  vi.mocked(o.f.storage.objectIdAtPathInVersion).mockRestore();
  o.engine.capture = {...o.engine.capture, activationId: SUCCESSOR, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 40, guard() {}});
  await host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(host.isDocumentReady(o.document)).toBe(true), {timeout: 10_000});
  expect(o.client().captureOwnerActivation).toHaveBeenLastCalledWith(expect.anything(), o.sibling.path, 1_000_000, expect.any(AbortSignal), undefined);
  expect(o.raw.prepare("SELECT path,enabled FROM sync_relay_service_host_enrollments WHERE object_id=?").all(o.document.objectId))
    .toEqual([{path: o.sibling.path, enabled: 1}]);
  expect(o.raw.prepare("SELECT activation_id,predecessor_activation_id,completion_json IS NOT NULL AS completed FROM sync_relay_service_activations ORDER BY rowid").all())
    .toEqual([{activation_id: ACTIVATION, predecessor_activation_id: null, completed: 1}, {activation_id: SUCCESSOR, predecessor_activation_id: ACTIVATION, completed: 1}]);
  expect(o.acceptEdit("back", host.coordinate)).toMatchObject({journalCursor: tip.journalCursor + 1});
});

// Proves: a moved document whose retirement waits for a recovery copy of an
// edit the server refused keeps its restore route after the restore ends. Once
// the owner saves the copy, its retirement runs through that route and
// completes, and the kept rows go. Without the route the retirement would
// never run.
it("keeps a moved document's restore route while a refused edit waits for its recovery copy, then retires it", async () => {
  const {o, host, log, k} = await movedDuringRestore({kept: true});
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Waiting for its owner to save a recovery copy of the edits the server kept.")), {timeout: 10_000});
  expect(host.retains(o.sibling)).toBe(true);
  expect(retiredRow(o).retired).toBe(false);
  expect(leaving(o)).not.toContain("liveApplication.releaseActivation");
  o.engine.unproven = ["refused"];
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k!.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true), {timeout: 10_000});
  expect(leaving(o)).toContain("liveApplication.releaseActivation");
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(host.retains(o.sibling)).toBe(false);
  expect(k!.row()).toBeNull();
});

// Proves: a restore that began while another Edit grant still covered the
// document opens no retirement. A restarted host still keeps the moved
// document's route while that restore is unfinished, so the owner's Decline
// reaches the engine through it, and the route ends with the restore, once the
// engine unloaded what the route loaded. Nothing retires the activation, and
// the workspace drains.
it("keeps a moved document's route for a restore that opened no retirement until the owner declines it", async () => {
  const {o, host} = await movedDuringRestore({covered: true});
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  expect(o.ownerCalls().map(([method]) => method)).toContain("liveApplication.cancelRestoreFence");
  await vi.waitFor(() => expect(host.retains(o.sibling)).toBe(false), {timeout: 10_000});
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(false);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(retiredRow(o).retired).toBe(false);
  expect(leaving(o)).not.toContain("liveApplication.releaseActivation");
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(leaving(o)).toContain("liveApplication.unloadDocument");
});

// Proves: a moved note whose restore kept the owner's live session, with no
// Pause and no other Edit grant, takes its route from the unfinished restore,
// not from a retirement: none is open. The owner's Decline reaches the engine
// through that route, and ending the kept session then opens the retirement.
it("keeps a moved note's route through the unfinished restore that kept the owner's live session", async () => {
  const {o, host} = await movedDuringRestore({live: true});
  expect(JSON.parse(String(o.raw.prepare("SELECT intent_json FROM sync_relay_live_restore_operations").get()!.intent_json)))
    .toMatchObject({keptRun: {runToken: 10, ownerUserId: "owner", shareId: "share", activationId: ACTIVATION}});
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(true);
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  expect(o.ownerCalls().map(([method]) => method)).toContain("liveApplication.cancelRestoreFence");
  expect(o.f.storage.serviceActivationRetirement(o.document))
    .toMatchObject({activationId: ACTIVATION, restoreFenceGeneration: o.binding.restoreFenceGeneration});
});

// Proves: when the restarted host's first restore step captures the moved
// document through its route, so the route has an owner, the route still ends
// with the restore after the owner's Decline. The engine unloads what the route
// loaded, and nothing settles through the route's owner, which never completed.
// What the route settles comes from durable state; the next test covers it.
it("unloads a no-retirement restore route that captured its document once the owner declines it", async () => {
  const {o, host} = await movedDuringRestore({covered: true, stopped: false});
  const captures = () => o.client().captureOwnerActivation.mock.calls.length;
  // A restore step checks the document's current moment at its path.
  vi.mocked(o.f.storage.objectIdAtPathInVersion).mockRestore();
  await expect(host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  // Nothing is hosted, so the route made this capture.
  expect(captures()).toBeGreaterThan(0);
  moveAway(o);
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  await vi.waitFor(() => expect(host.retains(o.sibling)).toBe(false), {timeout: 10_000});
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(leaving(o)).toContain("liveApplication.unloadDocument");
  expect(leaving(o)).not.toContain("liveApplication.releaseActivation");
});

// Proves: a restore step through a moved document's route can apply an edit the
// relay accepted after the activation's adoption cut, which the owner's Decline
// does not settle, before or after the native fence committed. Once the restore
// ended, the route settles that edit from durable state and publishes it before
// the engine unloads the document, and the workspace drains.
it.each([false, true])("settles what a no-retirement restore route applied before unloading it once the owner declines it, fence committed: %s", async fenceCommitted => {
  const {o, host} = await movedDuringRestore({covered: true, stopped: false, pending: true});
  o.engine.fenceCommitted = fenceCommitted;
  // A restore step checks the document's current moment at its path.
  vi.mocked(o.f.storage.objectIdAtPathInVersion).mockRestore();
  expect(o.applied.has("edit-pending")).toBe(false);
  await expect(host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  expect(o.applied.has("edit-pending")).toBe(true);
  moveAway(o);
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  const methods = engineMethods(o.client()), settled = methods.indexOf("liveApplication.settle"), pushed = methods.indexOf("sync.push", settled);
  expect(settled).toBeGreaterThan(-1);
  expect(pushed).toBeGreaterThan(settled);
  const unloaded = methods.indexOf("liveApplication.unloadDocument", settled);
  expect(unloaded).toBeGreaterThan(pushed);
  // The settle covered the edit the route applied, not an older tip.
  const requests = o.client().sendRequest.mock.calls.map(call => (call as unknown[])[0] as {method: string; params: {terminalReceipt?: unknown}});
  expect(requests.slice(0, unloaded).filter(request => request.method === "liveApplication.settle").at(-1)!.params.terminalReceipt)
    .toMatchObject({deliveryId: "edit-pending"});
  expect(host.retains(o.sibling)).toBe(false);
});

// Proves: a moved document whose restore opened no retirement, and that moves
// back to its enrolled path while the restore is unfinished, keeps its route
// until the restore ends, though its hosted target activates beside it. The
// route then ends without an unload, which would end the hosted target's
// session, and the hosted target still serves the document.
it("ends a no-retirement restore route without an unload once the moved document is hosted at its path again", async () => {
  const {o, host, driver} = await movedDuringRestore({covered: true});
  const forgetMoved = vi.spyOn(ServiceActivationDriver.prototype, "forgetMoved");
  const captures = () => o.client().captureOwnerActivation.mock.calls.length;
  vi.mocked(o.f.storage.objectIdAtPathInVersion).mockRestore();
  await host.update({workspaces: [o.workspace], documents: [o.sibling], departing: []});
  await vi.waitFor(() => expect(captures()).toBeGreaterThan(0), {timeout: 10_000});
  const pulls = () => engineMethods(o.client()).filter(method => method === "sync.pullHosted").length, seen = pulls();
  await vi.waitFor(() => expect(pulls()).toBeGreaterThan(seen + 1), {timeout: 10_000});
  expect(forgetMoved).not.toHaveBeenCalled();
  await expect(host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  await vi.waitFor(() => expect(forgetMoved).toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path}), o.sibling.objectId), {timeout: 10_000});
  expect(forgetMoved).toHaveBeenCalledTimes(1);
  expect(leaving(o)).not.toContain("liveApplication.unloadDocument");
  expect(host.retains(o.sibling)).toBe(true);
  expect(driver()!.targets.filter(target => target.path === o.sibling.path)).toEqual([expect.objectContaining({path: o.sibling.path, shareId: o.sibling.shareId})]);
});

// Proves: a moved document whose restore opened no retirement keeps its route
// when it moves back to its enrolled path and then away again before its hosted
// target activated, so the departure removes that target. The restore's next
// step still reaches the engine through the route, and the route ends with the
// restore once the engine unloaded what it loaded.
it("keeps a no-retirement restore route for a document that moves back and away again before it activates", async () => {
  const {o, host, driver} = await movedDuringRestore({covered: true});
  const activate = ServiceActivationDriver.prototype.activate, held: string[] = [];
  // Holds every activation of the returning document's target, so none loads it.
  vi.spyOn(ServiceActivationDriver.prototype, "activate").mockImplementation(async function (this: ServiceActivationDriver, ...args) {
    if (args[0].path !== o.sibling.path) return activate.apply(this, args);
    held.push(args[0].path);
    return {kind: "pending" as const, reason: "The test holds this activation."};
  });
  const hostedTargets = () => driver()!.targets.filter(target => target.path === o.sibling.path);
  // A restore step checks the document's current moment at its path, so storage keeps it there.
  vi.mocked(o.f.storage.objectIdAtPathInVersion).mockRestore();
  await host.update({workspaces: [o.workspace], documents: [o.sibling], departing: []});
  await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), {timeout: 10_000});
  expect(hostedTargets()).toHaveLength(1);
  await host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]});
  await vi.waitFor(() => expect(hostedTargets()).toEqual([]), {timeout: 10_000});
  await expect(host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  await vi.waitFor(() => expect(host.retains(o.sibling)).toBe(false), {timeout: 10_000});
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(leaving(o)).toContain("liveApplication.unloadDocument");
});

// Proves (#2965): a running host gives a restore a route when the document moves
// and departs before its hosted target loaded. That departure removes the target,
// which a later restore step would otherwise need. Declining the restore still
// reaches the engine without a restart, and the route ends with the restore once
// the engine unloaded what it loaded.
it("keeps a restore route for a document that moves and departs before its hosted target loaded", async () => {
  const o = await enrolledServiceHost();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  // Another Edit grant keeps the document covered, so no retirement opens and only the restore keeps the route.
  anotherEditGrant(o);
  o.beginRestore();
  o.f.storage.advanceStopRestoreFence(stopLookup, 50);
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  await o.host.close(); log.mockClear();
  // The next daemon hosts the document, but its target never loads.
  const activate = ServiceActivationDriver.prototype.activate, held: string[] = [];
  let driver: ServiceActivationDriver | undefined;
  vi.spyOn(ServiceActivationDriver.prototype, "activate").mockImplementation(async function (this: ServiceActivationDriver, ...args) {
    driver = this;
    if (args[0].path !== o.sibling.path) return activate.apply(this, args);
    held.push(args[0].path);
    return {kind: "pending" as const, reason: "The test holds this activation."};
  });
  const host = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => host.close());
  await host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), {timeout: 10_000});
  const hostedTargets = () => driver!.targets.filter(target => target.path === o.sibling.path);
  expect(hostedTargets()).toHaveLength(1);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(true);
  moveAway(o);
  await host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]});
  await vi.waitFor(() => expect(hostedTargets()).toEqual([]), {timeout: 10_000});
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  expect(o.ownerCalls().map(([method]) => method)).toContain("liveApplication.cancelRestoreFence");
  await vi.waitFor(() => expect(host.retains(o.sibling)).toBe(false), {timeout: 10_000});
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(false);
  expect(leaving(o)).toContain("liveApplication.unloadDocument");
  expect(leaving(o)).not.toContain("liveApplication.releaseActivation");
});

// Proves (#3005): a moved document's restore route comes back when the running
// host detaches and attaches its workspace again, as a change to the workspace's
// settings does. The detach ends the route. After the next pass, declining the
// restore still reaches the engine without a restart, and the route ends with
// the restore once the engine unloaded what it loaded.
it("keeps a moved document's restore route after a running host detaches and attaches its workspace again", async () => {
  const {o, host} = await movedDuringRestore({covered: true});
  const forgetMoved = vi.spyOn(ServiceActivationDriver.prototype, "forgetMoved");
  await host.update({workspaces: [{...o.workspace, maxRegistrations: 7}], documents: [], departing: [o.sibling]});
  expect(forgetMoved).toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path}), o.sibling.objectId);
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(true);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  // A pass that starts after the attach checks the workspace's origin, which restore steps need.
  await o.nextPull();
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  expect(o.ownerCalls().map(([method]) => method)).toContain("liveApplication.cancelRestoreFence");
  await vi.waitFor(() => expect(host.retains(o.sibling)).toBe(false), {timeout: 10_000});
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(false);
  expect(leaving(o)).toContain("liveApplication.unloadDocument");
  expect(leaving(o)).not.toContain("liveApplication.releaseActivation");
});

// Proves (#3005): the route also comes back when membership drops the workspace
// and a later update lists it again. The drop forgets the moved document, so
// only the update that lists it again can find it.
it("keeps a moved document's restore route after a running host drops its workspace and lists it again", async () => {
  const {o, host} = await movedDuringRestore({covered: true});
  const forgetMoved = vi.spyOn(ServiceActivationDriver.prototype, "forgetMoved");
  await host.update({workspaces: [], documents: [], departing: []});
  expect(forgetMoved).toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path}), o.sibling.objectId);
  await host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]});
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(true);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  await o.nextPull();
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  expect(o.ownerCalls().map(([method]) => method)).toContain("liveApplication.cancelRestoreFence");
  await vi.waitFor(() => expect(host.retains(o.sibling)).toBe(false), {timeout: 10_000});
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(false);
  expect(leaving(o)).toContain("liveApplication.unloadDocument");
  expect(leaving(o)).not.toContain("liveApplication.releaseActivation");
});

// Proves: activation reads that name an object, as departure recovery's do for
// a document it holds without a target, find that object's activation and not
// another's at the same path.
it("reads a recovered departure's retained activation by its object at a shared path", async () => {
  const {o, other, driver} = await movedDuringRestore({replacement: true});
  driver()!.removeTarget(other);
  expect(driver()!.retained(other)).toBe(true);
  expect(driver()!.retained(other, other.objectId)).toBe(false);
  expect(driver()!.retained(other, o.document.objectId)).toBe(true);
  driver()!.addTarget(other, other.objectId);
});

// Proves: a replacement document hosted at a moved document's old path reads
// only its own activation while the moved document's retirement is open. It
// captures without naming the moved document's activation, which it would
// otherwise take, and wait behind its retirement. The moved document's Decline
// and retirement use that document's activation, and its retirement leaves the
// replacement's target in place. Once a parking retry removed the
// replacement's target, reads that name it, as the host's departure and unload
// reads do, still find none of the moved document's activation at the path.
// The replacement's capture is refused here, since the fake engine captures
// only the fixture document.
it("keeps a replacement at a moved document's old path apart from the moved document's restore and retirement", async () => {
  const {o, host, other, driver} = await movedDuringRestore({replacement: true});
  const captures = () => o.client().captureOwnerActivation.mock.calls.map(call => (call as unknown[])[4]);
  await vi.waitFor(() => expect(captures().length).toBeGreaterThan(0));
  expect(captures()).not.toContain(ACTIVATION);
  driver()!.removeTarget(other);
  expect(driver()!.activationId(other)).toBe(ACTIVATION);
  expect(driver()!.activationId(other, other.objectId)).toBeUndefined();
  expect(driver()!.departing(other, AbortSignal.timeout(1_000), other.objectId)).toBeUndefined();
  driver()!.addTarget(other, other.objectId);
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  const key = retirementKey(o);
  await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true), {timeout: 10_000});
  expect(key.activationId).toBe(ACTIVATION);
  expect(o.ownerCalls()).toContainEqual(["liveApplication.releaseActivation", key]);
  await vi.waitFor(() => expect(host.retains(o.sibling)).toBe(false), {timeout: 10_000});
  expect(host.retains(other)).toBe(true);
  expect(driver()!.targets.filter(target => target.path === other.path)).toEqual([expect.objectContaining({path: other.path, shareId: other.shareId})]);
  expect(captures()).not.toContain(ACTIVATION);
});

const REPLACEMENT_ACTIVATION = `ordinary-activation-${"c".repeat(64)}`;
// A new document at the fixture document's path, with its own lineage and an
// activation the running host completed: adoption, seed and native application,
// as for the fixture document. The fake engine resumes it by its activation ID.
// Its object and activation IDs sort after the fixture document's. `name`,
// `path` and `activationId` give another such document at another path.
const replacementActivation = async (o: Enrolled, {name = "replacement", path = o.sibling.path, activationId = REPLACEMENT_ACTIVATION} = {}) => {
  const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
    maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
  const origin = `${name}-origin`, doc = markdownToYDoc(name === "replacement" ? "Replacement" : `Document ${name}`), baselineBytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.getMap("frontmatter").set("title", "Replaced");
  const fullState = Buffer.from(Y.encodeStateAsUpdate(doc)); doc.destroy();
  const document = {workspaceId: "workspace", mainVersionId: "main" as const, objectId: `${name}-object`, lineageClaimId: sha256(baselineBytes)};
  const validated = o.validateJournal({document, currentPath: path, checkpoint: baselineBytes, suffix: [], candidate: fullState});
  const base = createLiveMarkdownRegistrationValidator(policy)({document, currentPath: path, checkpoint: baselineBytes});
  if (validated.kind !== "accepted" || base.kind !== "accepted") throw new Error("Invalid replacement fixture.");
  const log = o.raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','${origin}',?,?,?,?)`);
  const relaySeq = (originSeq: number) => Number(o.raw.prepare(`SELECT relay_seq FROM sync_relay_log WHERE origin_id='${origin}' AND origin_seq=?`).get(originSeq)!.relay_seq);
  log.run(0, "moment.append", JSON.stringify({versionId: "main", objectId: document.objectId, momentId: `${name}-moment`, path, operation: "write",
    payloadAfterPath: path, payloadAfterContentKind: "text", payloadAfterBlobSha256: base.evidence.projectedMarkdownSha256,
    payloadAfterByteLength: base.evidence.projectedMarkdownByteLength}), 30);
  log.run(1, "ydoc.update", JSON.stringify({versionId: "main", objectId: document.objectId, path, contentKind: "richdoc", isBaseState: true,
    lineageClaimId: document.lineageClaimId, updateBlobSha256: document.lineageClaimId}), 31);
  log.run(2, "ydoc.update", JSON.stringify({versionId: "main", objectId: document.objectId, path, contentKind: "richdoc", isBaseState: false,
    lineageClaimId: document.lineageClaimId, updateBlobSha256: sha256(fullState)}), 32);
  const blob = o.raw.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content) VALUES ('workspace',?,?,?)");
  blob.run(document.lineageClaimId, baselineBytes.length, baselineBytes); blob.run(sha256(fullState), fullState.length, fullState);
  o.raw.prepare("INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES ('workspace',?,?,?,'main',?,?,'text',?,30)")
    .run(document.objectId, relaySeq(0), `${name}-moment`, path, base.evidence.projectedMarkdownSha256, base.evidence.projectedMarkdownByteLength);
  const capture: NativeOwnerActivation = {activationId, sessionId: `${name}-session`, baselineBytes, fullState,
    source: {version: 1, relayDatabaseNamespace: o.f.history.namespace, ...document, currentPath: path, replicationEpoch: "epoch",
      streamIdentity: "stream", committedCursor: relaySeq(2), baseOriginId: origin, baseOriginSeq: 1, baseRelaySeq: relaySeq(1),
      sourceMomentId: `moment-ydoc-apply-${sha256(Buffer.from(["workspace", "main", document.objectId, path, origin, "2"].join("\0")))}`,
      sourceDigest: validated.evidence.projectedMarkdownSha256, sourceByteLength: validated.evidence.projectedMarkdownByteLength,
      nativeHeadSequence: 2, fullStateDigest: sha256(fullState), fullStateByteLength: fullState.length}};
  const host = o.host.coordinate, actor = {kind: "owner" as const, userId: "owner", shareId: "share"};
  const store = o.f.storage.createServiceActivationStore(o.f.history);
  await store.prepare({capture, host, shareId: "share", registeredAtMs: 33, guard() {}, validate: async work => validateOrdinaryActivation(work, policy),
    bounds: {maxCaptureBytes: 1_000_000, maxEntriesPerDrain: 10, maxBytesPerDrain: 1_000_000}});
  const access = store.pending(document, host), delivery = o.f.storage.createLiveCommittedDeliveryStore(o.f.history, access);
  const adoption = delivery.captureOwnerCut({host, document, actor, adoptionId: activationId,
    expectedLocalSequence: 2, maxBytes: 1_000_000, maxEvents: 100, throughCursor: 0});
  delivery.acknowledgeOwnerAdoption(adoption, {adoptionId: activationId, localYDocSequence: 2, terminalCursor: 0, adoptionReplayed: false});
  const current = o.f.storage.resolveCurrentLiveDocumentBinding({document, actor}, access), cut = o.f.storage.readLiveUpdateJournalCut({document});
  if (current.kind !== "current" || cut.kind !== "cut") throw new Error("Missing replacement activation authority.");
  const seed = o.validateJournal({document, currentPath: current.binding.currentPath, checkpoint: cut.cut.checkpoint.bytes,
    suffix: cut.cut.suffix.map(row => row.bytes), candidate: fullState});
  o.f.storage.commitLiveUpdateJournal({host, actor, expectedAuthority: current.authority,
    metadata: {deliveryId: `${name}-seed`, updateDigest: sha256(fullState), binding: current.binding}, cutToken: cut.cut, validation: seed,
    updateBytes: fullState, receivedAtMs: 34}, access);
  const owner = delivery.openOwnerDelivery({host, document, actor}), event = delivery.nextOwnerApplication(owner)!;
  delivery.acknowledgeOwnerDeliveryApplication(owner, {...event.metadata.accepted.receipt, localYDocSequence: 2, applicationReplayed: false});
  store.complete({document, host, access, nativeState: {adoptionId: activationId, pendingBytes: 0}, guard() {}});
  o.otherActivations.set(activationId, capture);
  return {...o.sibling, path, objectId: document.objectId};
};

// Appends real path changes from another device, with unchanged text unless supplied.
const documentMoves = (o: Enrolled) => {
  let sequence = 0;
  return (row: typeof o.sibling, path: string, text?: string) => {
    const before = o.f.storage.objectMoment({workspaceId: row.workspaceId, objectId: row.objectId, versionId: "main"});
    if (!before || !before.path || before.contentKind !== "text" || before.blobSha256 === null || before.byteLength === null) throw new Error("Missing document before move.");
    if (!o.f.storage.getBlob(row.workspaceId, before.blobSha256)) {
      const capture = [o.engine.capture, ...o.otherActivations.values()].find(value => value.source.objectId === row.objectId)!;
      const document = {workspaceId: row.workspaceId, mainVersionId: "main" as const, objectId: row.objectId, lineageClaimId: capture.source.lineageClaimId};
      const normalized = createLiveMarkdownRegistrationValidator(restorePolicy)({document, currentPath: before.path, checkpoint: capture.baselineBytes});
      if (normalized.kind !== "accepted") throw new Error(normalized.reason);
      expect(normalized.evidence.projectedMarkdownSha256).toBe(before.blobSha256);
      o.f.storage.putBlob({workspaceId: row.workspaceId, sha256: before.blobSha256, content: Buffer.from(normalized.evidence.projectedMarkdown), createdAtMs: 1});
    }
    const after = text === undefined ? {sha256: before.blobSha256, byteLength: before.byteLength} :
      {sha256: sha256(Buffer.from(text)), byteLength: Buffer.byteLength(text)};
    if (text !== undefined) o.f.storage.putBlob({workspaceId: row.workspaceId, sha256: after.sha256, content: Buffer.from(text), createdAtMs: 40});
    const payload = {momentId: `move-${sequence}`, objectId: row.objectId, versionId: "main", operation: "rename", path,
      beforePath: before.path, payloadBeforePath: before.path, payloadAfterPath: path, payloadBeforeContentKind: "text", payloadAfterContentKind: "text",
      payloadBeforeBlobSha256: before.blobSha256, payloadAfterBlobSha256: after.sha256, payloadAfterByteLength: after.byteLength, recordedAtMs: 40};
    expect(o.f.storage.appendLogBatch({workspaceId: row.workspaceId, originId: "moving-device", ops: [
      {originSeq: sequence++, opKind: "moment.append", payloadJson: JSON.stringify(payload), recordedAtMs: 40},
    ]})).toMatchObject({inserted: 1});
  };
};

for (const c of [
  {moves: 1, name: "publishes a settled sibling after an enrolled document moves without losing its Edit grant"},
  {moves: 2, name: "publishes a settled sibling after two enrolled documents move in sequence"},
]) it(c.name, async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o), workspaces = [o.workspace];
  const log = vi.spyOn(console, "error").mockImplementation(() => {}), registrationIds = o.distinctRegistrations();
  const sibling = await replacementActivation(o, {name: "sibling", path: "docs/c.md"});
  const documents = [o.sibling, sibling];
  if (c.moves === 2) documents.push(await replacementActivation(o, {name: "ordinary", path: "docs/d.md", activationId: `ordinary-activation-${"d".repeat(64)}`}));
  for (const row of documents.slice(1)) o.f.storage.enrollServiceHostDocument({workspaceId: row.workspaceId, ownerUserId: "owner",
    shareId: row.shareId, path: row.path, nowMs: 35, guard() {}});
  const documentFor = (row: typeof o.sibling) => {
    const capture = [o.engine.capture, ...o.otherActivations.values()].find(value => value.source.objectId === row.objectId)!;
    return {workspaceId: row.workspaceId, mainVersionId: "main" as const, objectId: row.objectId, lineageClaimId: capture.source.lineageClaimId};
  };
  await o.host.update({workspaces, documents, ...stay});
  await vi.waitFor(() => {
    for (const row of documents) {
      expect(o.host.settled(row)).toBe(true);
      expect(o.host.isDocumentReady(documentFor(row))).toBe(true);
    }
  });
  const move = documentMoves(o);
  const settlements = vi.spyOn(OwnerCommittedDelivery.prototype, "settle"), departedAt = new Map<string, {settlement: number; request: number}>();
  const requests = () => o.client().sendRequest.mock.calls.map(call => (call as unknown[])[0] as
    {method: string; params: {registrationId?: number; retirement?: {objectId: string}; terminalReceipt?: {deliveryId: string}}});
  // The native queue holds an edit the host has not delivered when the other device moves the document.
  o.native.binding = o.binding;
  o.nativeEdits("before-move");
  const queued = o.native.entries.map(entry => ({...entry, update: Buffer.from(entry.update)}));
  for (let index = 0; index < c.moves; index++) {
    const row = documents[index]!;
    departedAt.set(row.objectId, {settlement: settlements.mock.calls.length, request: requests().length});
    move(row, `elsewhere/${row.objectId}.md`);
    expect(o.f.storage.serviceHostDocumentEnabled(row)).toBe(true);
    expect(o.f.storage.serviceHostEnrollmentCovered({workspaceId: row.workspaceId, objectId: row.objectId, ownerUserId: "owner", shareId: row.shareId, path: row.path})).toBe(true);
    expect(o.f.storage.serviceActivationRetirement(row)).toBeNull();
    await o.host.update({workspaces, documents: documents.slice(index + 1), departing: documents.slice(0, index + 1)});
    await vi.waitFor(() => expect(o.host.isDocumentReady(documentFor(row))).toBe(false));
    await o.nextPull();
  }
  const remaining = documents.at(-1)!, document = documentFor(remaining), actor = {kind: "owner" as const, userId: "owner", shareId: "share"};
  const current = o.f.storage.resolveCurrentLiveDocumentBinding({document, actor}), read = o.f.storage.readLiveUpdateJournalCut({document});
  if (current.kind !== "current" || read.kind !== "cut") throw new Error("Missing sibling authority.");
  const doc = new Y.Doc(), suffix = read.cut.suffix.map(row => row.bytes);
  for (const bytes of [read.cut.checkpoint.bytes, ...suffix]) Y.applyUpdate(doc, bytes);
  const vector = Y.encodeStateVector(doc); doc.getMap("frontmatter").set("edit", "after-moves");
  const updateBytes = Buffer.from(Y.encodeStateAsUpdate(doc, vector)); doc.destroy();
  const validation = o.validateJournal({document, currentPath: remaining.path, checkpoint: read.cut.checkpoint.bytes, suffix, candidate: updateBytes});
  const accepted = o.f.storage.commitLiveUpdateJournal({host: o.host.coordinate, actor, expectedAuthority: current.authority,
    metadata: {deliveryId: "sibling-after-moves", updateDigest: sha256(updateBytes), binding: current.binding}, cutToken: read.cut, validation, updateBytes, receivedAtMs: 50});
  expect(accepted.result.kind).toBe("accepted");
  const settledAt = () => requests().findIndex(request => request.method === "liveApplication.settle" && request.params.terminalReceipt?.deliveryId === "sibling-after-moves");
  await vi.waitFor(() => expect(settledAt()).toBeGreaterThan(-1));
  await vi.waitFor(() => expect(requests().slice(settledAt() + 1).some(request => request.method === "sync.push"),
    "The workspace must publish the settled sibling after another document moves.").toBe(true));
  expect(o.client().sendLiveApplication).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({metadata: expect.objectContaining({
    accepted: expect.objectContaining({receipt: expect.objectContaining({deliveryId: "sibling-after-moves"})}),
  })}), expect.anything());
  expect(o.native.entries).toEqual(queued);
  for (const [objectId, from] of departedAt) {
    expect(settlements.mock.calls.slice(from.settlement).map(([value]) => value.objectId)).not.toContain(objectId);
    expect(registrationIds.has(objectId)).toBe(true);
    expect(requests().slice(from.request).filter(request => request.method === "liveApplication.settle" &&
      (request.params.registrationId === registrationIds.get(objectId) || request.params.retirement?.objectId === objectId))).toEqual([]);
  }
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Waiting for its owner to save a recovery copy of the edits the server kept.")));
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(k.row()).toMatchObject({copied: false});
  const header = await o.host.readKeptEditsPage(k.row()!, undefined, o.workspace.root) as {kind: string; snapshot: string};
  expect(header).toMatchObject({kind: "page", part: "header"});
  await expect(o.host.readKeptEditsPage(k.row()!, {snapshot: header.snapshot, part: "update", sequence: 1, offset: 0}, o.workspace.root))
    .resolves.toMatchObject({kind: "page", part: "update", bytesBase64: Buffer.from([7]).toString("base64")});
  // Returning to the enrolled path must capture and activate again.
  expect(retiredRow(o).retired).toBe(false);
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  move(o.sibling, o.sibling.path);
  await o.host.update({workspaces, documents: [o.sibling, remaining], departing: documents.slice(1, c.moves)});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document), "The document must be ready after returning without a pause.").toBe(true));
  expect(o.client().captureOwnerActivation.mock.calls.slice(captures).map(call => (call as unknown[])[1])).toContain(o.sibling.path);
  expect(o.client().captureOwnerActivation.mock.calls.slice(captures).map(call => (call as unknown[])[4])).toContain(ACTIVATION);
  expect(o.native.entries).toEqual([]);
});

const readAcceptedEdits = (o: Enrolled) => {
  const {workspaceId, mainVersionId, objectId, lineageClaimId} = o.document;
  const params = [workspaceId, mainVersionId, objectId, lineageClaimId];
  const baseline = o.raw.prepare(`SELECT baseline_bytes FROM sync_relay_live_documents
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`).get(...params);
  const updates = o.raw.prepare(`SELECT journal_cursor FROM sync_relay_live_update_journal
    WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? ORDER BY journal_cursor`).all(...params)
    .map(row => o.f.storage.readCommittedLiveUpdate({host: o.host.coordinate, document: o.document, journalCursor: Number(row.journal_cursor)}));
  return {baseline: baseline ? Buffer.from(baseline.baseline_bytes as Uint8Array) : null, updates};
};
const rebuildEdits = (saved: ReturnType<typeof readAcceptedEdits>, queued: Enrolled["native"]["entries"]) => {
  if (!saved.baseline) throw new Error("Missing accepted edits.");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, saved.baseline);
    for (const update of saved.updates) {
      if (update.kind !== "committed") throw new Error("Missing accepted edits.");
      Y.applyUpdate(doc, update.admitted.updateBytes);
    }
    const acceptedText = yDocToMarkdown(doc), acceptedEdit = doc.getMap("frontmatter").get("edit");
    for (const entry of queued) Y.applyUpdate(doc, entry.update);
    return {acceptedText, acceptedEdit, queuedText: yDocToMarkdown(doc), queuedEdit: doc.getMap("frontmatter").get("edit")};
  } finally {doc.destroy();}
};

it("keeps accepted edits and queued edits when another device removes an enrolled document", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.lost.pending = true;
  const receipt = o.acceptEdit("before-removal");
  const accepted = o.f.storage.readLiveUpdateJournalCut({document: o.document});
  expect(accepted.kind).toBe("cut");
  const storedAccepted = readAcceptedEdits(o);
  o.native.binding = o.binding;
  o.nativeEdits("queued-before-removal");
  const queued = o.native.entries.map(entry => ({...entry, update: Buffer.from(entry.update)}));
  expect(queued).toHaveLength(1);
  expect(o.applied.has(receipt.deliveryId)).toBe(false);
  const before = o.f.storage.objectMoment({workspaceId: "workspace", objectId: o.sibling.objectId, versionId: "main"})!;
  const normalized = createLiveMarkdownRegistrationValidator(restorePolicy)({document: o.document, currentPath: o.sibling.path, checkpoint: o.engine.capture.baselineBytes});
  if (normalized.kind !== "accepted") throw new Error(normalized.reason);
  expect(normalized.evidence.projectedMarkdownSha256).toBe(before.blobSha256);
  o.f.storage.putBlob({workspaceId: "workspace", sha256: before.blobSha256!, content: Buffer.from(normalized.evidence.projectedMarkdown), createdAtMs: 40});
  o.raw.prepare(`INSERT INTO sync_relay_current_files(workspace_id,version_id,path,blob_sha256,content_kind,state_relay_seq)
    SELECT workspace_id,version_id,path,blob_sha256,content_kind,relay_seq FROM sync_relay_object_moments
    WHERE workspace_id=? AND object_id=? AND version_id=? ORDER BY relay_seq DESC LIMIT 1`)
    .run("workspace", o.sibling.objectId, "main");
  const currentFile = () => o.raw.prepare("SELECT path,blob_sha256 FROM sync_relay_current_files WHERE workspace_id=? AND version_id=? AND path=?")
    .get("workspace", "main", before.path);
  expect(currentFile(), "The saved file must be available before the document is removed.").toMatchObject({path: before.path, blob_sha256: before.blobSha256});
  expect(o.f.storage.appendLogBatch({workspaceId: "workspace", originId: "removing-device", ops: [
    {originSeq: 0, opKind: "moment.append", payloadJson: JSON.stringify({versionId: "main", objectId: o.sibling.objectId,
      momentId: "removed-document", operation: "delete", path: before.path, payloadBeforePath: before.path,
      payloadBeforeBlobSha256: before.blobSha256, recordedAtMs: 40}), recordedAtMs: 40},
  ]})).toMatchObject({inserted: 1});
  expect(currentFile(), "The removed document must no longer be available as a saved file.").toBeUndefined();
  expect(o.f.storage.objectMoment({workspaceId: "workspace", objectId: o.sibling.objectId, versionId: "main"})).toMatchObject({path: null});
  expect(o.f.storage.serviceHostDocumentEnabled(o.sibling)).toBe(true);
  expect(o.f.storage.serviceHostEnrollmentCovered({workspaceId: "workspace", objectId: o.sibling.objectId, ownerUserId: "owner", shareId: o.sibling.shareId,
    path: o.sibling.path})).toBe(true);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  await o.depart();
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(false));
  await o.nextPass();
  const saved = readAcceptedEdits(o);
  expect(saved, "The accepted edits must stay available after the document is removed.").toEqual(storedAccepted);
  expect(o.native.entries, "The queued edits must stay available after the document is removed.").toEqual(queued);
  expect(o.f.storage.readLiveUpdateJournalCut({document: o.document}), "The removed document must stay unavailable at its former path.")
    .toEqual({kind: "refused", reason: "stale-binding"});
  const rebuilt = rebuildEdits(saved, o.native.entries);
  expect(rebuilt.acceptedEdit, "The saved document must still contain the accepted edit.").toBe("before-removal");
  expect(rebuilt.queuedEdit, "The saved document and queued edits must still contain the latest edit.").toBe("queued-before-removal");
});
const activationFailures = (log: {mock: {calls: unknown[][]}}, from: number) => log.mock.calls.slice(from).filter(([message]) => message === "Service activation pass failed.").map(([, error]) => error instanceof Error ? error.message : String(error)).join(" | ");
for (const c of [
  {replicaGone: false, backAtPath: false, name: "retires a document paused after it moves and activates it again on return"},
  {replicaGone: true, backAtPath: false, name: "retires a document paused after its replica lets it go and activates it again on return"},
  {replicaGone: true, backAtPath: true, name: "retires a document paused at its enrolled path after its replica lets it go and activates it again on Resume"},
]) it(c.name, async () => {
  const o = await enrolledServiceHost(), move = documentMoves(o);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await vi.waitFor(() => expect(o.host.settled(o.sibling)).toBe(true));
  const removed = vi.spyOn(ServiceActivationDriver.prototype, "removeTarget");
  // The replica initially holds the moved document; two rows let it go before Pause.
  o.replies.pass = {departed: [o.sibling.objectId]}; o.replies.commit = {departed: [o.sibling.objectId]};
  expect(o.f.storage.serviceKeptEditsOf(o.document).keptEdits).toEqual([]);
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(false);
  move(o.sibling, "elsewhere/a.md");
  await o.depart();
  await vi.waitFor(() => expect(removed, "The moved document must leave activation.").toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path})));
  await o.nextPass();
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  if (c.replicaGone) {
    o.replies.pass = {}; o.replies.commit = {};
    await vi.waitFor(() => expect(o.host.retains(o.sibling)).toBe(false));
    await o.nextPass();
    // The service stops listing a moved document once its replica lets it go.
    expect(o.f.storage.releaseServiceHostEnrollment({workspaceId: "workspace", objectId: o.sibling.objectId, nowMs: 45})).toBeNull();
    await o.host.update({workspaces: [o.workspace], documents: [], departing: []});
  }
  let returnedAt = log.mock.calls.length;
  if (c.backAtPath) move(o.sibling, o.sibling.path);
  const sent = o.ownerCalls().length;
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner", enabled: false, nowMs: 50, guard() {}}))
    .toMatchObject({ownerStop: "pause"});
  const key = retirementKey(o);
  // A document the service let go is listed again after Pause changes the selection.
  // Otherwise no membership update follows Pause: a pass must find the new obligation.
  if (c.replicaGone) {
    o.replies.pass = {departed: [o.sibling.objectId]}; o.replies.commit = {departed: [o.sibling.objectId]};
    await o.depart();
  }
  await vi.waitFor(() => expect(o.ownerCalls().slice(sent), "A retirement opened after the move must reach the engine.")
    .toContainEqual(["liveApplication.reconcileActivation", expect.objectContaining(key)]));
  await vi.waitFor(() => expect(retiringSettles(o, sent)).toContainEqual(["liveApplication.settle", expect.objectContaining({retirement: key})]));
  expect(retiredRow(o).retired).toBe(false);
  o.replies.pass = {}; o.replies.commit = {};
  await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true));
  expect(o.ownerCalls().slice(sent)).toContainEqual(["liveApplication.releaseActivation", key]);
  expect(o.membership.filter(row => row.method === "liveApplication.unloadDocument")).toEqual([]);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  if (!c.backAtPath) {returnedAt = log.mock.calls.length; move(o.sibling, o.sibling.path);}
  o.engine.capture = {...o.engine.capture, activationId: SUCCESSOR, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner", enabled: true, nowMs: 60, guard() {}}))
    .toMatchObject({enabled: true});
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document), `The resumed document must activate after returning. ${activationFailures(log, returnedAt)}`).toBe(true));
  expect(o.client().captureOwnerActivation.mock.calls.length).toBeGreaterThan(captures);
  expect(o.host.settled(o.sibling)).toBe(true);
});

it("retires a document paused after its moved restore ends and activates it again on return", async () => {
  const o = await enrolledServiceHost(), move = documentMoves(o);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  anotherEditGrant(o);
  const removed = vi.spyOn(ServiceActivationDriver.prototype, "removeTarget");
  const forgotten = vi.spyOn(ServiceActivationDriver.prototype, "forgetMoved");
  o.replies.pass = {departed: [o.sibling.objectId]}; o.replies.commit = {departed: [o.sibling.objectId]};
  move(o.sibling, "elsewhere/a.md");
  await o.depart();
  await vi.waitFor(() => expect(removed, "The moved document must leave activation.").toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path})));
  await o.nextPull();
  // A restore can begin only at its binding's path. No membership update hosts this return.
  move(o.sibling, o.sibling.path);
  o.beginRestore();
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Waiting for its restore to finish.")));
  move(o.sibling, "elsewhere/a.md");
  // Decline before the fence keeps admission open for the later Resume.
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("declined");
  await vi.waitFor(() => expect(forgotten).toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path}), o.sibling.objectId));
  const sent = o.ownerCalls().length;
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner", enabled: false, nowMs: 70, guard() {}}))
    .toMatchObject({ownerStop: "pause"});
  const key = retirementKey(o);
  // The document is still departing, so Pause does not change membership.
  await vi.waitFor(() => expect(o.ownerCalls().slice(sent), "A retirement opened after a moved restore ended must reach the engine.")
    .toContainEqual(["liveApplication.reconcileActivation", expect.objectContaining(key)]));
  await vi.waitFor(() => expect(retiringSettles(o, sent)).toContainEqual(["liveApplication.settle", expect.objectContaining({retirement: key})]));
  o.replies.pass = {}; o.replies.commit = {};
  await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true));
  expect(o.ownerCalls().slice(sent)).toContainEqual(["liveApplication.releaseActivation", key]);
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  const returnedAt = log.mock.calls.length;
  move(o.sibling, o.sibling.path);
  o.engine.capture = {...o.engine.capture, activationId: SUCCESSOR, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner", enabled: true, nowMs: 80, guard() {}}))
    .toMatchObject({enabled: true});
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document), `The resumed document must activate after its moved restore and return. ${activationFailures(log, returnedAt)}`).toBe(true));
  expect(o.client().captureOwnerActivation.mock.calls.length).toBeGreaterThan(captures);
  expect(o.host.settled(o.sibling)).toBe(true);
});

for (const c of [
  {changedText: true, name: "keeps a document inactive when its saved text needs attention"},
  {changedText: false, name: "resumes a document with only its own text"},
]) it(c.name, async () => {
  const o = await enrolledServiceHost(), move = documentMoves(o);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  o.distinctRegistrations();
  const sibling = await replacementActivation(o, {name: "sibling", path: "docs/c.md"});
  const siblingCapture = o.otherActivations.get(REPLACEMENT_ACTIVATION)!;
  const siblingDocument = {workspaceId: sibling.workspaceId, mainVersionId: "main" as const, objectId: sibling.objectId,
    lineageClaimId: siblingCapture.source.lineageClaimId};
  o.f.storage.enrollServiceHostDocument({workspaceId: sibling.workspaceId, ownerUserId: "owner", shareId: sibling.shareId,
    path: sibling.path, nowMs: 35, guard() {}});
  const visitor = c.changedText ? undefined : await replacementActivation(o, {name: "visitor", path: "docs/visitor.md",
    activationId: `ordinary-activation-${"d".repeat(64)}`});
  if (visitor) move(visitor, "elsewhere/visitor.md");
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling, sibling], ...stay});
  await vi.waitFor(() => {
    expect(o.host.settled(o.sibling)).toBe(true);
    expect(o.host.isDocumentReady(siblingDocument)).toBe(true);
  });
  const removed = vi.spyOn(ServiceActivationDriver.prototype, "removeTarget");
  o.replies.pass = {departed: [o.sibling.objectId]}; o.replies.commit = {departed: [o.sibling.objectId]};
  move(o.sibling, "elsewhere/a.md");
  await o.host.update({workspaces: [o.workspace], documents: [sibling], departing: [o.sibling]});
  await vi.waitFor(() => expect(removed, "The moved document must leave activation.")
    .toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path})));
  await o.nextPull();
  if (visitor) {
    move(visitor, o.sibling.path);
    expect(o.f.storage.objectIdAtPathInVersion({workspaceId: "workspace", versionId: "main", path: o.sibling.path})).toBe(visitor.objectId);
  }
  const sent = o.ownerCalls().length;
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
    enabled: false, nowMs: 50, guard() {}})).toMatchObject({ownerStop: "pause"});
  const key = retirementKey(o);
  await vi.waitFor(() => expect(retiringSettles(o, sent)).toContainEqual(["liveApplication.settle", expect.objectContaining({retirement: key})]));
  o.replies.pass = {}; o.replies.commit = {};
  await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true));
  if (visitor) move(visitor, "elsewhere/visitor.md");
  const returnedAt = log.mock.calls.length;
  move(o.sibling, o.sibling.path, c.changedText ? "Different text on return\n" : undefined);
  o.engine.capture = {...o.engine.capture, activationId: SUCCESSOR, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  const capture = o.engine.capture;
  const source = {...capture.source, committedCursor: Number(o.raw.prepare("SELECT MAX(relay_seq) AS cursor FROM sync_relay_log WHERE workspace_id=?")
    .get("workspace")!.cursor)};
  const read = () => readOrdinaryActivationHistory(o.f.storage as StorageContext, {source, document: o.document,
    baselineBytes: capture.baselineBytes, fullState: capture.fullState,
    bounds: {maxCaptureBytes: 1_000_000, maxEntriesPerDrain: 100, maxBytesPerDrain: 1_000_000}});
  if (c.changedText) {
    expect(read, "The returned document must refuse a move that changed its text.")
      .toThrow("Ordinary activation history replaced the live document.");
  } else {
    expect(read, "The returned document must rebuild its own edits.").not.toThrow();
    const history = read();
    expect(read(), "Reading the returned document again must give the same edits.").toEqual(history);
    expect(history.rows.map(row => row.origin_id), "The returned document must use only its own edits.").toEqual(["origin", "origin"]);
    const doc = new Y.Doc();
    try {
      for (const bytes of history.updates) Y.applyUpdate(doc, bytes);
      expect(yDocToMarkdown(doc), "The other document's text must stay out of the returned document.").not.toContain("Document visitor");
      const rebuilt = createLiveMarkdownRegistrationValidator(restorePolicy)({document: o.document, currentPath: o.sibling.path,
        checkpoint: Y.encodeStateAsUpdate(doc)});
      expect(rebuilt).toMatchObject({kind: "accepted", evidence: {projectedMarkdownSha256: capture.source.sourceDigest}});
    } finally {doc.destroy();}
  }
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
    enabled: true, nowMs: 60, guard() {}})).toMatchObject({enabled: true});
  const pushes = () => o.client().sendRequest.mock.calls.filter(call => ((call as unknown[])[0] as {method: string}).method === "sync.push").length;
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling, sibling], ...stay});
  if (c.changedText) {
    await vi.waitFor(() => expect(log.mock.calls.slice(returnedAt)).toContainEqual([
      "Service activation pass failed.", "Ordinary activation history replaced the live document.",
    ]));
    for (let pass = 0; pass < 3; pass++) {
      await o.nextPull();
      expect(o.host.isDocumentReady(o.document), "The returned document must stay inactive after its text changed.").toBe(false);
      expect(o.host.isDocumentReady(siblingDocument)).toBe(true);
    }
  } else {
    await vi.waitFor(() => expect(o.host.isDocumentReady(o.document), "The returned document must activate with its own text.").toBe(true));
    const pushed = pushes();
    await vi.waitFor(() => expect(pushes(), "The workspace must publish after the returned document activates.").toBeGreaterThan(pushed));
  }
});

for (const c of [
  {kind: "different", name: "keeps a document inactive when the saved file has different text"},
  {kind: "departed", name: "keeps a document inactive while preserving a newer saved file"},
  {kind: "saved", name: "keeps a document inactive with its saved text intact"},
  {kind: "saved-matching", name: "keeps a document inactive while its saved file needs attention"},
  {kind: "departed-matching", name: "keeps a document inactive without replacing its newer saved text"},
  {kind: "saved-move", name: "keeps a document inactive when its saved text differs from its current edits"},
  {kind: "saved-move-no-write", name: "keeps a document inactive with its different saved text preserved"},
  {kind: "saved-move-unindexed", name: "keeps a document inactive while its different saved text stays available"},
  {kind: "saved-file-different", name: "keeps a document inactive while its saved file has other text"},
  {kind: "saved-move-departed", name: "keeps a document inactive without changing its different saved text"},
  {kind: "saved-file-current", name: "keeps a document inactive with its saved file's different text available"},
  {kind: "saved-move-selected-write", name: "keeps a document inactive while its saved file keeps another device's text"},
  {kind: "saved-file-unindexed-moves", name: "keeps a document inactive with all its different saved text available"},
  {kind: "saved-file-later-moves", name: "keeps a document inactive while preserving all its different saved text"},
  {kind: "saved-after-return", name: "keeps a document inactive with its latest saved text available"},
  {kind: "saved-after-unindexed-return", name: "keeps a document inactive while its saved text remains available"},
  {kind: "saved-after-indexed-return", name: "keeps a document inactive without changing its available saved text"},
  {kind: "saved-after-stale-write", name: "keeps a document inactive with its current saved edits intact"},
  {kind: "returned-saved", name: "resumes a document with its latest saved edits"},
  {kind: "returned-current", name: "resumes a document with its current edits and matching saved text"},
  {kind: "current", name: "resumes a document with its current edits"},
] as const) it(c.name, async () => {
  const o = await enrolledServiceHost(), move = documentMoves(o);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const capture = o.engine.capture;
  const base = createLiveMarkdownRegistrationValidator(restorePolicy)({document: o.document, currentPath: o.sibling.path,
    checkpoint: capture.baselineBytes});
  if (base.kind !== "accepted") throw new Error(base.reason);
  const resumes = c.kind === "current" || c.kind === "returned-current" || c.kind === "returned-saved";
  const writesAfterReturn = c.kind === "saved-after-return" || c.kind === "saved-after-stale-write" || c.kind === "returned-saved";
  const repeatsCurrentWrite = c.kind === "saved-after-unindexed-return" || c.kind === "saved-after-indexed-return";
  const unindexedMoves = c.kind === "saved-file-unindexed-moves" || c.kind === "saved-after-unindexed-return";
  if (!resumes) {
    o.native.binding = o.binding;
    o.nativeEdits("queued-while-inactive");
  }
  const appendWrite = (originId: string, originSeq: number, text: string, native = false, departed = false, payloadRecordedAtMs: number | null = 40,
    beforeBlobSha256?: string) => {
    const bytes = Buffer.from(text), digest = sha256(bytes);
    o.f.storage.putBlob({workspaceId: "workspace", sha256: digest, content: bytes, createdAtMs: 40});
    const payload = {versionId: "main", objectId: o.sibling.objectId, path: o.sibling.path, operation: "write",
      momentId: native ? `moment-ydoc-${sha256(Buffer.from(`${originId}\0${originSeq}`))}` : "external-write",
      payloadAfterPath: o.sibling.path, payloadAfterContentKind: "text", payloadAfterBlobSha256: digest,
      payloadAfterByteLength: bytes.length, metadata: {}, beforePresent: beforeBlobSha256 !== undefined, recordedAtMs: payloadRecordedAtMs,
      ...(beforeBlobSha256 === undefined ? {} : {beforePath: o.sibling.path, payloadBeforePath: o.sibling.path,
        payloadBeforeContentKind: "text", payloadBeforeBlobSha256: beforeBlobSha256})};
    expect(o.f.storage.appendLogBatch({workspaceId: "workspace", originId, ops: [
      {originSeq, opKind: "moment.append", payloadJson: JSON.stringify(payload), recordedAtMs: 40,
        ...(departed ? {relayAdmission: "departed" as const} : {})},
    ]})).toMatchObject({inserted: 1});
  };
  const unindexedMove = (beforePath: string, path: string, originSeq: number) => {
    const payload = {momentId: `unindexed-move-${originSeq}`, objectId: o.sibling.objectId, versionId: "main", operation: "rename", path,
      beforePath, payloadBeforePath: beforePath, payloadAfterPath: path, payloadBeforeContentKind: "text", payloadAfterContentKind: "text",
      payloadBeforeBlobSha256: capture.source.sourceDigest, payloadAfterBlobSha256: capture.source.sourceDigest,
      payloadAfterByteLength: capture.source.sourceByteLength, ...(unindexedMoves ? {} : {recordedAtMs: null})};
    expect(o.f.storage.appendLogBatch({workspaceId: "workspace", originId: "unindexed-moving-device", ops: [
      {originSeq, opKind: "moment.append", payloadJson: JSON.stringify(payload), recordedAtMs: 40},
    ]})).toMatchObject({inserted: 1});
  };
  if (c.kind === "current") {
    move(o.sibling, "elsewhere/a.md");
    move(o.sibling, o.sibling.path);
    appendWrite("origin", 3, base.evidence.projectedMarkdown, true);
  } else if (c.kind === "saved-move") {
    appendWrite("origin", 3, base.evidence.projectedMarkdown, true);
  } else if (c.kind === "saved-file-current" || c.kind === "saved-file-unindexed-moves" || c.kind === "saved-file-later-moves" || c.kind === "returned-current" || repeatsCurrentWrite) {
    const current = createLiveMarkdownRegistrationValidator(restorePolicy)({document: o.document, currentPath: o.sibling.path,
      checkpoint: capture.fullState});
    if (current.kind !== "accepted") throw new Error(current.reason);
    expect(current.evidence.projectedMarkdownSha256).toBe(capture.source.sourceDigest);
    appendWrite("origin", 3, current.evidence.projectedMarkdown, true);
    if (c.kind !== "returned-current") appendWrite("writing-device", 0, "Different saved text\n", false, false, null, capture.source.sourceDigest);
  } else if (c.kind === "saved-move-unindexed" || c.kind === "saved-move-departed" || c.kind === "saved-file-different") {
    appendWrite("writing-device", 0, "Different saved text\n", false, c.kind === "saved-move-departed", null);
  } else if (c.kind !== "saved-move-no-write" && !writesAfterReturn) {
    appendWrite("writing-device", 0, "Different saved text\n", false, false, c.kind === "saved-move-selected-write" ? null : 40);
    if (c.kind === "departed" || c.kind === "saved" || c.kind === "departed-matching" || c.kind === "saved-matching" || c.kind === "saved-move-selected-write") {
      expect(o.f.storage.appendLogBatch({workspaceId: "workspace", originId: "origin", ops: [
        {originSeq: 3, opKind: "ydoc.update", payloadJson: JSON.stringify({versionId: "main", objectId: o.sibling.objectId,
          path: o.sibling.path, contentKind: "richdoc", lineageClaimId: o.document.lineageClaimId, isBaseState: false,
          updateBlobSha256: sha256(capture.fullState)}), recordedAtMs: 40},
      ]})).toMatchObject({inserted: 1});
      appendWrite("origin", 4, c.kind === "saved-matching" || c.kind === "departed-matching" ? "Different saved text\n" : base.evidence.projectedMarkdown,
        true, c.kind === "departed" || c.kind === "departed-matching", c.kind === "saved" || c.kind === "saved-matching" ? null : 40);
    }
  }
  const removed = vi.spyOn(ServiceActivationDriver.prototype, "removeTarget");
  o.replies.pass = {departed: [o.sibling.objectId]}; o.replies.commit = {departed: [o.sibling.objectId]};
  if (c.kind.startsWith("saved-move")) {
    const bytes = Buffer.from("Different saved text\n"), digest = sha256(bytes);
    o.f.storage.putBlob({workspaceId: "workspace", sha256: digest, content: bytes, createdAtMs: 40});
    expect(o.f.storage.appendLogBatch({workspaceId: "workspace", originId: "saving-device", ops: [
      {originSeq: 0, opKind: "moment.append", payloadJson: JSON.stringify({versionId: "main", objectId: o.sibling.objectId,
        momentId: "saved-move", operation: "rename", path: "elsewhere/a.md", beforePath: o.sibling.path,
        payloadBeforePath: o.sibling.path, payloadAfterPath: "elsewhere/a.md", payloadBeforeContentKind: "text", payloadAfterContentKind: "text",
        payloadBeforeBlobSha256: digest, payloadAfterBlobSha256: digest, payloadAfterByteLength: bytes.length, recordedAtMs: 40}), recordedAtMs: 40},
    ]})).toMatchObject({inserted: 1});
  } else if (unindexedMoves) unindexedMove(o.sibling.path, "elsewhere/a.md", 0);
  else move(o.sibling, "elsewhere/a.md");
  const pause = () => {
    expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
      enabled: false, nowMs: 50, guard() {}})).toMatchObject({ownerStop: "pause"});
    return retirementKey(o);
  };
  let sent = o.ownerCalls().length;
  const paused = unindexedMoves ? pause() : undefined;
  await o.depart();
  if (!paused) await vi.waitFor(() => expect(removed, "The document must leave activation.")
    .toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path})));
  await o.nextPull();
  if (!paused) sent = o.ownerCalls().length;
  const key = paused ?? pause();
  await vi.waitFor(() => expect(retiringSettles(o, sent)).toContainEqual(["liveApplication.settle", expect.objectContaining({retirement: key})]));
  o.replies.pass = {}; o.replies.commit = {};
  await vi.waitFor(() => expect(retiredRow(o).retired).toBe(true));
  if (paused) expect(removed, "The document must leave activation.").toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path}));
  const returnedAt = log.mock.calls.length;
  if (unindexedMoves) unindexedMove("elsewhere/a.md", o.sibling.path, 1);
  else move(o.sibling, o.sibling.path);
  if (c.kind === "saved-file-later-moves") {
    unindexedMove(o.sibling.path, "elsewhere/a.md", 0);
    unindexedMove("elsewhere/a.md", o.sibling.path, 1);
  }
  if (writesAfterReturn || repeatsCurrentWrite) {
    const current = createLiveMarkdownRegistrationValidator(restorePolicy)({document: o.document, currentPath: o.sibling.path,
      checkpoint: capture.fullState});
    if (current.kind !== "accepted") throw new Error(current.reason);
    expect(current.evidence.projectedMarkdownSha256).toBe(capture.source.sourceDigest);
    if (repeatsCurrentWrite) appendWrite("origin", 4, current.evidence.projectedMarkdown, true);
    else {
      const before = sha256(Buffer.from(base.evidence.projectedMarkdown));
      appendWrite("origin", 3, current.evidence.projectedMarkdown, true, false, 40, before);
      if (c.kind === "saved-after-return") appendWrite("writing-device", 0, "Different saved text\n", false, false, null, capture.source.sourceDigest);
      if (c.kind === "saved-after-stale-write") appendWrite("origin", 4, base.evidence.projectedMarkdown, true, false, 40, before);
    }
  }
  o.engine.capture = {...capture, activationId: SUCCESSOR, source: {...capture.source, predecessorActivationId: ACTIVATION,
    ...(c.kind === "returned-saved" ? {sourceMomentId: `moment-ydoc-${sha256(Buffer.from(["origin", 3].join("\0")))}`} : {}),
    ...(c.kind === "saved-file-current" || c.kind === "saved-file-later-moves" || c.kind === "returned-current" ? {sourceMomentId: "move-1"} : {})}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  const source = {...o.engine.capture.source, committedCursor: Number(o.raw.prepare("SELECT MAX(relay_seq) AS cursor FROM sync_relay_log WHERE workspace_id=?")
    .get("workspace")!.cursor)};
  const bounds = {maxCaptureBytes: 1_000_000, maxEntriesPerDrain: 100, maxBytesPerDrain: 1_000_000};
  const check = () => {
    const input = {source, document: o.document, baselineBytes: capture.baselineBytes, fullState: capture.fullState, bounds};
    const history = readOrdinaryActivationHistory(o.f.storage as StorageContext, input);
    const validation = validateOrdinaryActivation({document: o.document, currentPath: source.currentPath,
      baselineBytes: capture.baselineBytes, cut: {source, fullState: capture.fullState, history, maxBytesPerDrain: bounds.maxBytesPerDrain}}, restorePolicy);
    if (validation.kind !== "accepted") throw new Error(validation.message);
    return verifyOrdinaryActivationCut(o.f.storage as StorageContext, {...input, history, baseline: validation.baseline, proof: validation.proof});
  };
  const refusal = "Ordinary activation found a later ordinary file moment with a divergent projection.";
  const currentFile = () => o.raw.prepare("SELECT path,blob_sha256 FROM sync_relay_current_files WHERE workspace_id=? AND version_id=? AND path=?")
    .get(o.document.workspaceId, o.document.mainVersionId, o.sibling.path);
  const storedFile = currentFile(), storedAccepted = readAcceptedEdits(o);
  expect(storedFile, "The saved file must be available before the document resumes.")
    .toMatchObject({path: o.sibling.path, blob_sha256: c.kind === "returned-current" || c.kind === "returned-saved" || c.kind === "saved-after-stale-write" ? capture.source.sourceDigest :
      sha256(Buffer.from(c.kind === "saved-move" || c.kind === "current" ? base.evidence.projectedMarkdown : "Different saved text\n"))});
  const queued = o.native.entries.map(entry => ({...entry, update: Buffer.from(entry.update)}));
  const storedText = rebuildEdits(storedAccepted, queued);
  if (!resumes) expect(queued, "The document must have queued edits before it resumes.").toHaveLength(1);
  if (resumes) {
    let failure: unknown;
    try {check();} catch (error) {failure = error;}
    expect(failure, `The document must resume with its current edits. ${failure instanceof Error ? failure.message : String(failure)}`).toBeUndefined();
  } else expect(check, "The saved file must be checked before the document resumes.").toThrow(refusal);
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
    enabled: true, nowMs: 60, guard() {}})).toMatchObject({enabled: true});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  if (resumes) {
    await vi.waitFor(() => expect(o.host.isDocumentReady(o.document), "The document must become ready with its current edits.").toBe(true));
  } else {
    await vi.waitFor(() => expect(log.mock.calls.slice(returnedAt), "The document must explain why it cannot resume.")
      .toContainEqual(["Service activation pass failed.", refusal]));
    for (let pass = 0; pass < 3; pass++) {
      await o.nextPull();
      expect(o.host.isDocumentReady(o.document), "The document must stay inactive while its saved text needs attention.").toBe(false);
    }
    expect(o.f.storage.objectMoment({workspaceId: "workspace", objectId: o.sibling.objectId, versionId: "main"}), "The saved file must keep its text.")
      .toMatchObject({path: o.sibling.path, blobSha256: c.kind === "saved-file-current" || c.kind === "saved-file-unindexed-moves" || c.kind === "saved-file-later-moves" || c.kind === "saved-after-return" || repeatsCurrentWrite ? capture.source.sourceDigest :
        sha256(Buffer.from(c.kind === "saved-file-different" || c.kind === "saved-after-stale-write" ? base.evidence.projectedMarkdown : "Different saved text\n"))});
    expect(currentFile(), "The saved file must keep its available text.").toEqual(storedFile);
    const saved = readAcceptedEdits(o);
    expect(saved, "The accepted edits must stay available while the document is inactive.").toEqual(storedAccepted);
    expect(o.native.entries, "The queued edits must stay available while the document is inactive.").toEqual(queued);
    const rebuilt = rebuildEdits(saved, o.native.entries);
    expect(rebuilt.acceptedText, "The inactive document must still contain the accepted text.").toBe(storedText.acceptedText);
    expect(rebuilt.queuedText, "The inactive document and queued edits must still contain the latest text.").toBe(storedText.queuedText);
  }
});

for (const c of [
  {restore: false, name: "does not repeat a moved document's held retirement after its edits are copied"},
  {restore: true, name: "does not repeat a moved document's held retirement opened during a restore after its edits are copied"},
]) it(c.name, async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o), move = documentMoves(o);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  if (c.restore) anotherEditGrant(o);
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.acceptEdit("accepted-after-adoption");
  await o.host.drain(o.document);
  expect(o.applied.has("edit-accepted-after-adoption")).toBe(true);
  await expect(o.host.retryKeptEdits(k.row()!, () => {})).resolves.toBe("granted");
  const removed = vi.spyOn(ServiceActivationDriver.prototype, "removeTarget");
  o.replies.pass = {departed: [o.sibling.objectId]}; o.replies.commit = {departed: [o.sibling.objectId]};
  move(o.sibling, "elsewhere/a.md");
  await o.depart();
  await vi.waitFor(() => expect(removed, "The moved document must leave activation.").toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path})));
  await o.nextPull();
  if (c.restore) {
    // Open and fence the restore during a return that membership has not hosted.
    move(o.sibling, o.sibling.path);
    o.beginRestore();
    expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Waiting for its restore to finish.")));
    o.f.storage.advanceStopRestoreFence(stopLookup, 50);
    await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
    move(o.sibling, "elsewhere/a.md");
  }
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner", enabled: false, nowMs: 50, guard() {}}))
    .toMatchObject({ownerStop: "pause"});
  if (c.restore) {
    const fenced = retirementKey(o);
    expect(fenced.restoreFenceGeneration).toBe(o.binding.restoreFenceGeneration + 1);
    expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
    await expect(o.host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
    expect(retirementKey(o)).toEqual({...fenced, restoreFenceGeneration: o.binding.restoreFenceGeneration});
  }
  const key = retirementKey(o);
  const reconciliations = () => o.ownerCalls().filter(([method, params]) => method === "liveApplication.reconcileActivation" &&
    Object.entries(key).every(([field, value]) => (params as Record<string, unknown>)[field] === value)).length;
  let copiedAt: number | undefined;
  const forgetMoved = ServiceActivationDriver.prototype.forgetMoved;
  const forgotten = vi.spyOn(ServiceActivationDriver.prototype, "forgetMoved").mockImplementation(function (this: ServiceActivationDriver, ...args) {
    const result = forgetMoved.apply(this, args);
    if (args[0].path === o.sibling.path && args[1] === o.sibling.objectId) copiedAt ??= reconciliations();
    return result;
  });
  await vi.waitFor(() => expect(o.engine.journals).toContainEqual({receipts: [], absent: ["refused"]}));
  expect(k.row()).toMatchObject({retrying: false, copied: false});
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox", generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(forgotten).toHaveBeenCalledWith(expect.objectContaining({path: o.sibling.path}), o.sibling.objectId));
  expect(o.f.storage.serviceActivationRetirement(o.document)).toMatchObject(key);
  expect(copiedAt).toBeGreaterThan(0);
  for (let pass = 0; pass < 3; pass++) {
    await o.nextPull();
    expect(reconciliations(), "The copied held retirement must not be sent again.").toBe(copiedAt);
  }
});

it("does not repeat an at-path document's copied held retirement across later membership updates", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o), workspaces = [o.workspace], move = documentMoves(o);
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.distinctRegistrations();
  const sibling = await replacementActivation(o, {name: "sibling", path: "docs/c.md"});
  o.f.storage.enrollServiceHostDocument({workspaceId: sibling.workspaceId, ownerUserId: "owner", shareId: sibling.shareId,
    path: sibling.path, nowMs: 35, guard() {}});
  await o.host.update({workspaces, documents: [o.sibling, sibling], ...stay});
  await vi.waitFor(() => expect(o.host.settled(sibling)).toBe(true));
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.acceptEdit("accepted-after-adoption");
  await o.host.drain(o.document);
  expect(o.applied.has("edit-accepted-after-adoption")).toBe(true);
  await expect(o.host.retryKeptEdits(k.row()!, () => {})).resolves.toBe("granted");
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
    enabled: false, nowMs: 50, guard() {}})).toMatchObject({ownerStop: "pause"});
  const key = retirementKey(o);
  const reconciliations = () => o.ownerCalls().filter(([method, params]) => method === "liveApplication.reconcileActivation" &&
    Object.entries(key).every(([field, value]) => (params as Record<string, unknown>)[field] === value)).length;
  await o.host.update({workspaces, documents: [sibling], departing: [o.sibling]});
  await vi.waitFor(() => expect(o.engine.journals).toContainEqual({receipts: [], absent: ["refused"]}));
  expect(k.row()).toMatchObject({retrying: false, copied: false});
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox",
    generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(k.row()).toBeNull());
  await vi.waitFor(() => expect(o.host.retains(o.sibling)).toBe(false));
  expect(o.f.storage.releaseServiceHostEnrollment({workspaceId: "workspace", objectId: o.sibling.objectId, nowMs: 55}))
    .toMatchObject({enabled: false, hostDrainedAtMs: 55});
  const copiedAt = reconciliations();
  expect(copiedAt).toBeGreaterThan(0);
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
    enabled: true, nowMs: 60, guard() {}})).toMatchObject({enabled: true, hostDrainedAtMs: null});
  expect(o.f.storage.serviceActivationRetirement(o.document)).toMatchObject(key);
  expect(o.f.storage.releaseServiceHostEnrollment({workspaceId: "workspace", objectId: o.sibling.objectId, nowMs: 65})).toBeNull();
  // Only the sibling moves. The held document stays at its path and in every departing list.
  for (const away of [true, false]) {
    move(sibling, away ? "elsewhere/c.md" : sibling.path);
    await o.host.update({workspaces, documents: away ? [] : [sibling], departing: away ? [o.sibling, sibling] : [o.sibling]});
    for (let pass = 0; pass < 3; pass++) {
      await o.nextPull();
      expect(reconciliations(), "The copied at-path held retirement must not be sent again after a membership update.").toBe(copiedAt);
    }
  }
  expect(o.f.storage.serviceActivationRetirement(o.document)).toMatchObject(key);
});

it("does not repeat an at-path document's copied held retirement across workspace detachments", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o), workspaces = [o.workspace];
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.acceptEdit("accepted-after-adoption");
  await o.host.drain(o.document);
  expect(o.applied.has("edit-accepted-after-adoption")).toBe(true);
  await expect(o.host.retryKeptEdits(k.row()!, () => {})).resolves.toBe("granted");
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
    enabled: false, nowMs: 50, guard() {}})).toMatchObject({ownerStop: "pause"});
  const key = retirementKey(o);
  const reconciliations = () => o.ownerCalls().filter(([method, params]) => method === "liveApplication.reconcileActivation" &&
    Object.entries(key).every(([field, value]) => (params as Record<string, unknown>)[field] === value)).length;
  await o.host.update({workspaces, documents: [], departing: [o.sibling]});
  await vi.waitFor(() => expect(o.engine.journals).toContainEqual({receipts: [], absent: ["refused"]}));
  expect(k.row()).toMatchObject({retrying: false, copied: false});
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox",
    generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(k.row()).toBeNull());
  await vi.waitFor(() => expect(o.host.retains(o.sibling)).toBe(false));
  expect(o.f.storage.releaseServiceHostEnrollment({workspaceId: "workspace", objectId: o.sibling.objectId, nowMs: 55}))
    .toMatchObject({enabled: false, hostDrainedAtMs: 55});
  const copiedAt = reconciliations();
  expect(copiedAt).toBeGreaterThan(0);
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
    enabled: true, nowMs: 60, guard() {}})).toMatchObject({enabled: true, hostDrainedAtMs: null});
  expect(o.f.storage.serviceActivationRetirement(o.document)).toMatchObject(key);
  for (let cycle = 0; cycle < 2; cycle++) {
    await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
    await expect(o.host.detachDrained("workspace")).resolves.toBe(true);
    expect(o.f.storage.releaseServiceHostEnrollment({workspaceId: "workspace", objectId: o.sibling.objectId, nowMs: 65 + cycle})).toBeNull();
    await o.host.update({workspaces, documents: [], departing: [o.sibling]});
    for (let pass = 0; pass < 3; pass++) {
      await o.nextPull();
      expect(reconciliations(), "The copied at-path held retirement must not be sent again after a workspace reattachment.").toBe(copiedAt);
    }
  }
  expect(o.f.storage.serviceActivationRetirement(o.document)).toMatchObject(key);
});

it("does not repeat a moved document's copied held retirement across workspace detachments", async () => {
  const o = await enrolledServiceHost(), k = keptEdits(o), workspaces = [o.workspace];
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.keptOutbox.appendKey = "owner-adoption:seed";
  o.acceptEdit("accepted-after-adoption");
  await o.host.drain(o.document);
  expect(o.applied.has("edit-accepted-after-adoption")).toBe(true);
  await expect(o.host.retryKeptEdits(k.row()!, () => {})).resolves.toBe("granted");
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
    enabled: false, nowMs: 50, guard() {}})).toMatchObject({ownerStop: "pause"});
  const key = retirementKey(o);
  const reconciliations = () => o.ownerCalls().filter(([method, params]) => method === "liveApplication.reconcileActivation" &&
    Object.entries(key).every(([field, value]) => (params as Record<string, unknown>)[field] === value)).length;
  await o.host.update({workspaces, documents: [], departing: [o.sibling]});
  await vi.waitFor(() => expect(o.engine.journals).toContainEqual({receipts: [], absent: ["refused"]}));
  expect(k.row()).toMatchObject({retrying: false, copied: false});
  expect(o.f.storage.confirmServiceKeptEditsCopy({workspaceId: "workspace", outboxId: "kept-outbox",
    generation: k.row()!.generation, checkpointDigest: null})).toBe(true);
  await vi.waitFor(() => expect(k.row()).toBeNull());
  await vi.waitFor(() => expect(o.host.retains(o.sibling)).toBe(false));
  expect(o.f.storage.releaseServiceHostEnrollment({workspaceId: "workspace", objectId: o.sibling.objectId, nowMs: 55}))
    .toMatchObject({enabled: false, hostDrainedAtMs: 55});
  expect(o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: o.sibling.path, ownerUserId: "owner",
    enabled: true, nowMs: 60, guard() {}})).toMatchObject({enabled: true, hostDrainedAtMs: null});
  expect(o.f.storage.serviceActivationRetirement(o.document)).toMatchObject(key);
  documentMoves(o)(o.sibling, "elsewhere/a.md");
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  await expect(o.host.detachDrained("workspace")).resolves.toBe(true);
  expect(o.f.storage.releaseServiceHostEnrollment({workspaceId: "workspace", objectId: o.sibling.objectId, nowMs: 65})).toBeNull();
  await o.host.update({workspaces, documents: [], departing: [o.sibling]});
  for (let pass = 0; pass < 3; pass++) await o.nextPull();
  const movedAt = reconciliations();
  expect(movedAt).toBeGreaterThan(0);
  for (let cycle = 0; cycle < 2; cycle++) {
    await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
    await expect(o.host.detachDrained("workspace")).resolves.toBe(true);
    expect(o.f.storage.releaseServiceHostEnrollment({workspaceId: "workspace", objectId: o.sibling.objectId, nowMs: 66 + cycle})).toBeNull();
    await o.host.update({workspaces, documents: [], departing: [o.sibling]});
    for (let pass = 0; pass < 3; pass++) {
      await o.nextPull();
      expect(reconciliations(), "The copied moved held retirement must not be sent again after a workspace reattachment.").toBe(movedAt);
    }
  }
  expect(o.f.storage.serviceActivationRetirement(o.document)).toMatchObject(key);
});

it("keeps an omitted moved document out of restore routes after a later workspace attach fails", async () => {
  const {o, host} = await movedDuringRestore({covered: true});
  const second = {...o.workspace, root: join(o.f.root, "workspace-2"), workspaceId: "workspace-2"};
  await mkdir(second.root);
  await host.update({workspaces: [o.workspace, second], documents: [], departing: [o.sibling]});
  expect(o.f.storage.serviceRestoreInProgress(o.document)).toBe(true);
  const sent = o.ownerCalls().length;
  let creates = 0;
  // The existing create failure applies only after the first workspace has attached and checked its origin.
  const failSecondCreate = (method: string) => {
    if (method === "sync.createHostedReplica" && ++creates === 2) o.replies.create = new Error("Relay unreachable.");
  };
  o.requestListeners.add(failSecondCreate);
  try {
    await expect(host.update({workspaces: [{...o.workspace, maxRegistrations: 7}, {...second, maxRegistrations: 7}],
      documents: [], ...stay})).rejects.toThrow("Relay unreachable.");
  } finally {
    o.requestListeners.delete(failSecondCreate);
    o.replies.create = undefined;
  }
  expect(creates).toBe(2);
  expect(host.automationLedger("workspace")).not.toBeNull();
  expect(host.automationLedger("workspace-2")).toBeNull();
  await afterPasses(o.f, 3);
  await vi.waitFor(() => expect({drained: host.drained("workspace"), steps: o.calls(sent).filter(method =>
    ["liveApplication.reconcileActivation", "liveApplication.releaseActivation", "liveApplication.unloadDocument"].includes(method))},
  "An omitted moved document must open no restore route or departure steps after a failed membership update.")
    .toEqual({drained: true, steps: []}));
});

// Proves: a restarted host's ordinary recovery of a departing document reads
// only that document's activation, though a moved document's restore keeps its
// own activation at the same path. The replacement's first resume is refused as
// not ready, so it parks; the next pull still lists it departed, and it resumes
// again. Every activation read and engine request of that departure names the
// replacement's object and activation, never the moved document's, whose
// restore and activation stay as they were. The departure then settles,
// publishes and unloads the replacement, as ordinary recovery does.
it("recovers a departing replacement at a moved document's old path through its own activation across a parking retry", async () => {
  const o = await enrolledServiceHost();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  anotherEditGrant(o);
  o.beginRestore();
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  o.f.storage.advanceStopRestoreFence(stopLookup, 50);
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  const replacement = await replacementActivation(o);
  await o.host.close();
  const at = o.f.storage.objectIdAtPathInVersion.bind(o.f.storage);
  vi.spyOn(o.f.storage, "objectIdAtPathInVersion").mockImplementation(input => input.path === o.sibling.path ? replacement.objectId : at(input));
  const movedRow = () => o.raw.prepare(`SELECT completion_json,state_digest,retire_requested_at_ms,retired_at_ms FROM sync_relay_service_activations
    WHERE activation_id=?`).get(ACTIVATION);
  const before = {row: movedRow(), restore: o.f.storage.readStopRestore(stopLookup)};
  // The activation each read at the shared path names, from the restart on.
  const read = ServiceActivationStore.prototype.read, reads: (string | undefined)[] = [];
  vi.spyOn(ServiceActivationStore.prototype, "read").mockImplementation(function (this: ServiceActivationStore, ...args) {
    if (args[1] === o.sibling.path) reads.push(args[3]);
    return read.apply(this, args);
  });
  // The replacement's replica lists it departed on every pull, so parking never finds it gone.
  o.replies.pass = {departed: [replacement.objectId]}; o.replies.commit = {departed: [replacement.objectId]};
  const host = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => host.close());
  const capture = o.client().captureOwnerActivation, captures = () => capture.mock.calls.map(call => (call as unknown[])[4]);
  capture.mockRejectedValueOnce(unready());
  await host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling, replacement]});
  await vi.waitFor(() => expect(captures().length).toBeGreaterThan(0));
  expect([...new Set(reads)]).toEqual([replacement.objectId]);
  expect(new Set(captures())).toEqual(new Set([REPLACEMENT_ACTIVATION]));
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Waiting for its hosted replica to confirm the document parked.")));
  const requests = () => o.client().sendRequest.mock.calls.map(call => (call as unknown[])[0] as {method: string; params: Record<string, unknown>});
  const unloads = () => requests().filter(request => request.method === "liveApplication.unloadDocument").map(request => request.params);
  await vi.waitFor(() => expect(unloads()).toEqual([{objectId: replacement.objectId, activationId: REPLACEMENT_ACTIVATION}]), {timeout: 10_000});
  // Once a pull finds it gone, the host lets it go.
  o.replies.pass = {}; o.replies.commit = {};
  await vi.waitFor(() => expect(host.retains(replacement)).toBe(false), {timeout: 10_000});
  expect([...new Set(reads)]).toEqual([replacement.objectId]);
  expect(captures()).toEqual([REPLACEMENT_ACTIVATION, REPLACEMENT_ACTIVATION]);
  expect(capture.mock.calls.every(call => (call as unknown[])[1] === o.sibling.path)).toBe(true);
  expect([...new Set(requests().filter(request => request.method === "liveApplication.register").map(request => request.params.activationId))])
    .toEqual([REPLACEMENT_ACTIVATION]);
  expect(unloads()).toEqual([{objectId: replacement.objectId, activationId: REPLACEMENT_ACTIVATION}]);
  const methods = requests().map(request => request.method), settled = methods.indexOf("liveApplication.settle");
  expect(settled).toBeGreaterThan(-1);
  expect(methods.indexOf("sync.push", settled)).toBeGreaterThan(settled);
  expect(methods.indexOf("liveApplication.unloadDocument")).toBeGreaterThan(methods.indexOf("sync.push", settled));
  expect(methods.filter(method => ["liveApplication.reconcileActivation", "liveApplication.releaseActivation", "liveApplication.releaseOwnerActivation",
    "liveApplication.fenceRestore", "liveApplication.cancelRestoreFence"].includes(method))).toEqual([]);
  // The moved document keeps its restore route, unfinished restore and untouched activation.
  expect(host.retains(o.sibling)).toBe(true);
  expect(o.f.storage.serviceActivationRetirement(o.document)).toBeNull();
  expect({row: movedRow(), restore: o.f.storage.readStopRestore(stopLookup)}).toEqual(before);
});

// Proves: settling a moved document's finished restore route leaves the
// readiness of a replacement now hosted at its old path alone. The route waits
// on an unload the engine holds pending, and a pass activates one document, so
// the replacement and an ordinary document take turns. On every pass the
// replacement stays ready and the workspace pushes before it pulls.
it("keeps a replacement at a moved document's old path ready while the moved document's restore route waits", async () => {
  const o = await enrolledServiceHost();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  anotherEditGrant(o);
  o.beginRestore();
  o.f.storage.advanceStopRestoreFence(stopLookup, 50);
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  const replacement = await replacementActivation(o);
  const ordinary = await replacementActivation(o, {name: "ordinary", path: "docs/c.md", activationId: `ordinary-activation-${"d".repeat(64)}`});
  await o.host.close();
  const at = o.f.storage.objectIdAtPathInVersion.bind(o.f.storage);
  vi.spyOn(o.f.storage, "objectIdAtPathInVersion").mockImplementation(input => input.path === o.sibling.path ? replacement.objectId : at(input));
  let driver: ServiceActivationDriver | undefined;
  const addTarget = ServiceActivationDriver.prototype.addTarget;
  vi.spyOn(ServiceActivationDriver.prototype, "addTarget").mockImplementation(function (this: ServiceActivationDriver, ...args) {driver = this; return addTarget.apply(this, args);});
  const host = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => host.close());
  await host.update({workspaces: [o.workspace], documents: [replacement, ordinary], departing: [o.sibling]});
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Waiting for its restore to finish.")));
  await vi.waitFor(() => {expect(driver!.completed(replacement)).toBe(true); expect(driver!.completed(ordinary)).toBe(true);});
  // The route's unload stays pending, so it settles and publishes again on every pass.
  vi.spyOn(o.unloads, "shift").mockReturnValue({status: "pending", reason: "The test holds the unload."});
  expect(o.f.storage.declineStopRestore(stopLookup, 60).phase).toBe("old-cut-applied");
  await expect(host.declineRestore(stopLookup)).resolves.toEqual({kind: "declined"});
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("The test holds the unload.")));
  // At the end of each pass that sent the route's unload: whether the replacement is ready, and whether the
  // workspace pushed after that unload. The route publishes before its unload, so only the workspace's own push counts.
  const ready: boolean[] = [], pushed: boolean[] = [];
  let unloaded = false, pushing = false;
  const listener = (method: string) => {
    if (method === "liveApplication.unloadDocument") {unloaded = true; pushing = false;}
    if (method === "sync.push") pushing = true;
  };
  const sample = () => {
    if (unloaded) {ready.push(driver!.completed(replacement)); pushed.push(pushing);}
    unloaded = false; pushing = false;
  };
  o.requestListeners.add(listener); o.f.passEnds.add(sample);
  await afterPasses(o.f, 4);
  o.requestListeners.delete(listener); o.f.passEnds.delete(sample);
  expect(ready.length).toBeGreaterThanOrEqual(4);
  expect(ready.filter(value => !value)).toEqual([]);
  expect(pushed.filter(value => !value)).toEqual([]);
  expect(host.retains(o.sibling)).toBe(true);
});

// Proves: reconciliation that names deliveries the engine cannot prove gets the
// journal's answer for each in its next request: the receipt of one the relay
// accepted, and absence for one it never did. The retirement then completes.
it("answers the engine's unproven deliveries from the journal during a retirement's reconciliation", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const tip = o.tip();
  o.engine.unproven = [tip.deliveryId, "never-accepted"];
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  const evidence = {receipts: [tip], absent: ["never-accepted"]};
  expect(o.engine.journals).toEqual([evidence]);
  const reconciles = o.ownerCalls().slice(sent).filter(([method]) => method === "liveApplication.reconcileActivation").map(([, params]) => params);
  expect(reconciles[0]).not.toHaveProperty("journal");
  expect(reconciles[1]).toMatchObject({journal: evidence});
  expect(retiredRow(o)).toEqual({retired: true, boundary: {terminalReceipt: tip, eventCount: 1, historyEvidenceDigest: expect.any(String)}});
});

// Proves: an activation the engine adopted, but whose adoption reply the relay
// lost before Stop, has no owner at the relay. Its retirement learns the
// adoption from the engine's reconciliation, captures the owner's cut and
// records the adoption, without adopting again, and retires at its boundary.
// A daemon that stops between the capture and the record captures again.
it.each([false, true])("records an adoption whose reply was lost before Stop during its retirement, after a restart: %s", async restart => {
  const o = await emptyServiceHost({adopted: false});
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 10, guard() {}});
  const adopt = o.client().sendLiveOwnerAdoption, adopted = adopt.getMockImplementation()! as (...values: unknown[]) => Promise<unknown>;
  let ownersWhenLost: unknown, cutsWhenLost = 0;
  adopt.mockImplementationOnce(async (...args: unknown[]) => {
    await adopted(...args);
    expect(preparedStop(o.f.storage, {workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path,
      enabled: false, retire: true, nowMs: 20, guard() {}})).toMatchObject({retired: true});
    ownersWhenLost = o.raw.prepare("SELECT COUNT(*) AS owners FROM sync_relay_live_delivery_owners").get();
    cutsWhenLost = cuts.mock.calls.length;
    throw new Error("Adoption reply lost.");
  });
  // Any pass after the lost reply may recover the adoption through the open retirement, so these watch from the start.
  const cuts = vi.spyOn(LiveCommittedDeliveryStore.prototype, "captureOwnerCut");
  const acknowledge = LiveCommittedDeliveryStore.prototype.acknowledgeOwnerAdoption;
  let stopped = restart;
  const acks = vi.spyOn(LiveCommittedDeliveryStore.prototype, "acknowledgeOwnerAdoption").mockImplementation(function (this: LiveCommittedDeliveryStore, ...args) {
    if (stopped) throw new Error("Daemon stopped before the adoption was recorded.");
    return acknowledge.apply(this, args);
  });
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(adopt.mock.settledResults).toEqual([{type: "rejected", value: new Error("Adoption reply lost.")}]));
  expect(ownersWhenLost).toEqual({owners: 0});
  await o.host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]});
  let host = o.host, captured = cutsWhenLost;
  if (restart) {
    await vi.waitFor(() => expect(acks).toHaveBeenCalled());
    await o.host.close();
    captured = cuts.mock.calls.length;
    expect(o.raw.prepare("SELECT COUNT(*) AS owners FROM sync_relay_live_delivery_owners").get()).toEqual({owners: 0});
    stopped = false;
    host = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
    cleanup.push(() => host.close());
    await host.update({workspaces: [o.workspace], documents: [], departing: [o.sibling]});
  }
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true));
  expect(o.raw.prepare("SELECT retired_at_ms IS NOT NULL AS retired,retired_boundary_json FROM sync_relay_service_activations").get()).toEqual({retired: 1,
    retired_boundary_json: JSON.stringify({terminalReceipt: null, eventCount: 0, historyEvidenceDigest: initialAcceptedHistoryDigest(o.f.history.namespace, o.document)})});
  expect(acks.mock.results.filter(result => result.type === "return")).toHaveLength(1);
  expect(cuts).toHaveBeenCalledTimes(captured + 1);
  expect(adopt).toHaveBeenCalledTimes(1);
  if (restart) expect(o.client().sendLiveOwnerAdoption).not.toHaveBeenCalled();
});

// Proves: the same for a successor that adopted at its predecessor's released
// boundary. The recovered adoption keeps that boundary's cursor and event
// count, the host holds no reservation through it, and the successor retires
// there without adopting again.
it("records a successor's adoption at its predecessor's boundary whose reply was lost before Stop, and retires there", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const edit = o.acceptEdit("before");
  await expect(o.host.drain(o.document)).resolves.toMatchObject({kind: "done"});
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  const boundary = retiredRow(o).boundary, terminal = edit.journalCursor;
  expect(boundary).toMatchObject({terminalReceipt: edit, eventCount: 2});
  o.engine.capture = {...o.engine.capture, activationId: SUCCESSOR, source: {...o.engine.capture.source, predecessorActivationId: ACTIVATION}};
  o.engine.adoption = {activationId: SUCCESSOR, throughCursor: null};
  o.engine.boundary = undefined;
  const adopt = o.client().sendLiveOwnerAdoption, adopted = adopt.getMockImplementation()! as (...values: unknown[]) => Promise<unknown>;
  // A pass after the lost reply may recover the adoption through the open retirement, so the count is taken when the reply is lost.
  let ownersWhenLost: unknown;
  adopt.mockImplementationOnce(async (...args: unknown[]) => {
    await adopted(...args);
    expect(preparedStop(o.f.storage, {workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path,
      enabled: false, retire: true, nowMs: 50, guard() {}})).toMatchObject({retired: true});
    ownersWhenLost = o.raw.prepare("SELECT COUNT(*) AS owners FROM sync_relay_live_delivery_owners").get();
    throw new Error("Adoption reply lost.");
  });
  const cuts = vi.spyOn(LiveCommittedDeliveryStore.prototype, "captureOwnerCut");
  const acks = vi.spyOn(LiveCommittedDeliveryStore.prototype, "acknowledgeOwnerAdoption");
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 40, guard() {}});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(adopt.mock.settledResults).toEqual([{type: "rejected", value: new Error("Adoption reply lost.")}]));
  expect(ownersWhenLost).toEqual({owners: 0});
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(cuts).toHaveBeenCalledWith(expect.objectContaining({adoptionId: SUCCESSOR, throughCursor: terminal}));
  expect(acks.mock.calls.map(([, ack]) => ack)).toEqual([{adoptionId: SUCCESSOR, localYDocSequence: 2, terminalCursor: terminal, adoptionReplayed: true}]);
  expect(acks.mock.results.map(result => result.type)).toEqual(["return"]);
  const archived = o.raw.prepare("SELECT tip_cursor,origin_json FROM sync_relay_live_delivery_owner_history WHERE activation_id=?").get(SUCCESSOR)!;
  expect([archived.tip_cursor, JSON.parse(String(archived.origin_json)).originEventCount]).toEqual([terminal, 2]);
  expect(o.raw.prepare("SELECT journal_cursor FROM sync_relay_live_delivery_reservations WHERE journal_cursor<=?").all(terminal)).toEqual([]);
  expect(JSON.parse(String(o.raw.prepare("SELECT retired_boundary_json FROM sync_relay_service_activations WHERE activation_id=?").get(SUCCESSOR)!.retired_boundary_json)))
    .toEqual(boundary);
  expect(adopt).toHaveBeenCalledTimes(1);
});

// Proves: a retirement records what the engine applied a page at a time, at
// most four pages a pass, and the next pass continues from the tip the last
// one recorded, on this daemon or one started after it stopped. It settles
// once, through the last page, and retires there.
it.each([false, true])("records a retirement's applications a page at a time across passes and settles once through the last, after a restart: %s", async restart => {
  const o = await enrolledServiceHost({maxApplications: 2});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const seed = o.tip();
  o.lost.pending = true;
  const edits = Array.from({length: 9}, (_, index) => o.acceptEdit(`page-${index}`));
  // The engine applied each, though the relay recorded none.
  for (const edit of edits) o.applied.set(edit.deliveryId, {...edit, localYDocSequence: edit.journalCursor + 1});
  o.stop();
  const sent = o.ownerCalls().length, from = o.client().sendRequest.mock.calls.length;
  // A pass reconciles four pages; this daemon stops before the next pass's reconciliation is answered.
  const stopped = restart ? unansweredAfter(o, "liveApplication.reconcileActivation", 4) : undefined;
  await o.depart();
  let host = o.host;
  if (stopped) {
    await stopped;
    await o.host.close();
    expect(o.tip()).toEqual(edits[7]);
    expect(retiringSettles(o, sent)).toEqual([]);
    host = await restartedHost(o);
  }
  // Five pages take several passes, each of which pulls first.
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true), {timeout: 10_000});
  const requests = o.client().sendRequest.mock.calls.slice(restart ? 0 : from).map(call => (call as unknown[])[0] as {method: string; params: {afterReceipt?: unknown}});
  const reconciles = requests.filter(request => request.method === "liveApplication.reconcileActivation");
  const pages = restart ? [edits[7]] : [seed, edits[1], edits[3], edits[5], edits[7]];
  expect(reconciles.slice(0, pages.length).map(request => request.params.afterReceipt)).toEqual(pages);
  expect(reconciles.slice(pages.length).every(request => JSON.stringify(request.params.afterReceipt) === JSON.stringify(edits[8]))).toBe(true);
  expect(reconciles[0]!.params).toMatchObject({maxApplications: 2});
  if (!restart) {
    // The fifth page waits for the next pass, which pulls first.
    const methods = o.client().sendRequest.mock.calls.map(call => ((call as unknown[])[0] as {method: string}).method);
    const rounds = methods.flatMap((method, index) => method === "liveApplication.reconcileActivation" ? [index] : []);
    expect(methods.slice(rounds[3]! + 1, rounds[4])).toContain("sync.pullHosted");
  }
  expect(retiringSettles(o, restart ? 0 : sent)).toEqual([["liveApplication.settle", {retirement: expect.objectContaining({acceptedThrough: edits[8]!.journalCursor}), terminalReceipt: edits[8]}]]);
  expect(retiredRow(o).boundary.terminalReceipt).toEqual(edits[8]);
});

// Proves: a retirement waiting at any step resumes on a daemon started after
// its own stopped, from its durable obligation, once what it waited for holds.
// One whose departure had not reached the daemon waits for its hosted replica
// to confirm the document left.
const waits: Record<string, {hold(o: Enrolled): void; clear(o: Enrolled): void}> = {
  "Settlement has not reached the file.": {hold: o => {o.settlement.materialized = false;}, clear: o => {o.settlement.materialized = true;}},
  "Hosted publication has more pages.": {hold: o => {o.replies.push = {hasMore: true};}, clear: o => {o.replies.push = {};}},
  "Waiting for its hosted replica to confirm the document left.": {hold() {}, clear() {}},
  "Waiting for its hosted replica to confirm the document parked.": {hold: o => {o.replies.commit = {departed: [o.sibling.objectId]};}, clear: o => {o.replies.commit = {};}},
  "Retirement reconciliation is unfinished.": {hold: o => {o.engine.releasePending = "reconciliation";}, clear: o => {o.engine.releasePending = undefined;}},
};
it.each(Object.keys(waits))("resumes a retirement waiting at %j on a restarted daemon", async reason => {
  const o = await enrolledServiceHost();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const tip = o.tip(), wait = waits[reason]!;
  wait.hold(o);
  o.stop();
  const sent = o.ownerCalls().length;
  if (reason.endsWith("left.")) {
    await vi.waitFor(() => expect(retiringSettles(o, sent).length).toBeGreaterThan(0));
    await o.nextPull();
  } else {
    await o.depart();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting(reason)));
  }
  await o.host.close();
  expect(o.calls(sent).includes("liveApplication.releaseActivation")).toBe(/parked|unfinished/.test(reason));
  expect(retiredRow(o).retired).toBe(false);
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toMatchObject({activationId: ACTIVATION});
  wait.clear(o);
  const host = await restartedHost(o);
  await vi.waitFor(() => expect(host.drained("workspace")).toBe(true));
  expect(retiredRow(o)).toEqual({retired: true, boundary: {terminalReceipt: tip, eventCount: 1, historyEvidenceDigest: expect.any(String)}});
  expect(departed(o.calls(0)).at(-1)).toBe("liveApplication.releaseActivation");
  expect(o.client().captureOwnerActivation).not.toHaveBeenCalled();
});

// Proves: a retirement's settled output that publication cannot push, while
// the relay has not admitted its owner, answers as no more pages. The document
// cannot park with it unpushed, so though a pull confirmed it left, the engine
// refuses the release and nothing retires until a later push takes it.
it("retires a stopped document only once its settled output pushed, though its blocked publication reported no more pages", async () => {
  const o = await enrolledServiceHost();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const tip = o.tip();
  // A pull confirms it left while nothing it settled has reached the file.
  o.settlement.materialized = false;
  o.stop();
  const sent = o.ownerCalls().length;
  await o.depart();
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Settlement has not reached the file.")));
  await o.nextPull();
  o.replies.push = {ownerAdmissionPending: [{workspaceId: "workspace", originId: "origin", originSeq: 3, versionId: "main", objectId: "object", path: "docs/a.md"}]};
  o.settlement.materialized = true;
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(...waiting("Waiting for its hosted replica to confirm the document parked.")));
  expect(log).not.toHaveBeenCalledWith(...waiting("Hosted publication has more pages."));
  expect(o.ownerCalls().slice(sent)).toContainEqual(["liveApplication.releaseActivation", expect.anything()]);
  expect(o.engine.unpushed).toBeGreaterThan(0);
  expect(o.engine.boundary).toBeUndefined();
  expect(retiredRow(o).retired).toBe(false);
  expect(o.host.retains(o.sibling)).toBe(true);
  o.replies.push = {};
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  expect(retiredRow(o)).toEqual({retired: true, boundary: {terminalReceipt: tip, eventCount: 1, historyEvidenceDigest: expect.any(String)}});
});

// Proves: once an owner adoption retired on a host, ordinary committed
// delivery there never starts a bootstrap for its lineage: the retired
// adoption already consumed the lineage's adoption reservation.
it("refuses ordinary committed delivery on a host where the lineage's owner adoption retired", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.stop();
  await o.depart();
  await vi.waitFor(() => expect(o.host.drained("workspace")).toBe(true));
  const store = o.f.storage.createLiveCommittedDeliveryStore(o.f.history);
  expect(() => store.open({host: o.host.coordinate, document: o.document})).toThrow("Committed delivery follows a retired owner adoption.");
  expect(o.raw.prepare("SELECT COUNT(*) AS bootstraps FROM sync_relay_live_delivery_bootstraps").get()).toEqual({bootstraps: 0});
});

// Proves: a retiring document fails closed when its binding no longer holds:
// a restore generation no resumed restore accounts for, or an engine that
// refuses the activation. It never settles or releases, stays retained, and
// its workspace does not drain. The failure is reported.
it.each(["generation", "engine"] as const)("keeps a stopped document whose retirement is refused by the %s", async refusal => {
  const o = await enrolledServiceHost();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  if (refusal === "engine") o.engine.refusal = diverged();
  o.stop();
  if (refusal === "generation") o.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1 WHERE object_id='object'");
  const sent = o.ownerCalls().length, failures = () => log.mock.calls.filter(([message]) => message === "Service activation pass failed.").length;
  await o.depart();
  // Each pass tries it again.
  if (refusal === "engine") await vi.waitFor(() => expect(o.calls(sent).length).toBeGreaterThan(2));
  else {await vi.waitFor(() => expect(failures()).toBeGreaterThan(0)); await o.nextPull();}
  expect(o.calls(sent).filter(method => method !== "liveApplication.reconcileActivation")).toEqual([]);
  if (refusal === "generation") expect(o.calls(sent)).toEqual([]);
  expect(o.host.retains(o.sibling)).toBe(true);
  expect(o.host.drained("workspace")).toBe(false);
  expect(retiredRow(o).retired).toBe(false);
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
it.each(["hosted-backfill-work-waiting", "hosted-conflict-parent-withheld"] as const)("clears a held document's readiness and %s reason when its next capture succeeds", async reason => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  o.refuseCapture(unready());
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.replies.pass = {held: [{objectId: o.sibling.objectId, reason,
    ...(reason === "hosted-conflict-parent-withheld" ? {conflictId: "conflict"} : {})}]};
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(false));
  expect(o.host.holdReason(o.sibling)).toBe(reason);
  expect(o.host.blocked(o.sibling)).toBeUndefined();
  expect(o.host.holdReason({...o.sibling, objectId: "unknown"})).toBeUndefined();
  // Pulls go on, and the document waits: every pass captures it again while the engine holds it.
  await vi.waitFor(() => expect(o.client().captureOwnerActivation.mock.calls.length).toBeGreaterThan(captures + 2));
  await o.nextPull();
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  o.replies.pass = {};
  o.refuseCapture(undefined);
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(o.host.holdReason(o.sibling)).toBeUndefined();
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
  await vi.waitFor(() => expect(restarted.drained("workspace")).toBe(true), {timeout: 10_000});
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

// Proves: a hosted document's first-open refusal reads through the host while
// it holds. A Y.Doc update for the document does not lift a deletion, as it
// lifts a block for missing lineage, nor does a later source. Resume asks
// until an answer that holds arrives, and the document leaving the host
// forgets its answer.
it("holds a first-open refusal past later Y.Doc updates until its owner tries again", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], activations = vi.mocked(ServiceActivationDriver.prototype.activate).mock.contexts;
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const driver = activations.at(-1) as ServiceActivationDriver;
  const source = {workspaceId: o.sibling.workspaceId, objectId: o.sibling.objectId, path: o.sibling.path, sourceMomentId: "moment-1", sourceDigest: "a".repeat(64)};
  const later = {...source, sourceMomentId: "moment-2", sourceDigest: "b".repeat(64)};
  const refusal = (current: typeof source) => o.host.firstOpenStatus(current, () => current);
  driver.firstOpenAnswered(firstOpenOutcome(source, {kind: "refused", reason: "deletion"}));
  expect(refusal(source)).toMatchObject({reason: "deletion", recovery: "none"});
  appendDocumentRow(o.raw, "ydoc.update", o.sibling.objectId);
  await o.nextPull(); await o.nextPull();
  expect(refusal(later)).toMatchObject({reason: "deletion", source});
  expect(driver.firstOpenStanding(later)).toMatchObject({reason: "deletion"});
  expect(refusal({...source, objectId: "object-unhosted"})).toBeUndefined();
  expect(o.host.unblock(o.sibling)).toBe(true);
  expect(refusal(later)).toBeUndefined();
  expect(driver.firstOpenStanding(later)).toBeUndefined();
  driver.firstOpenAnswered(firstOpenOutcome(later, {kind: "unavailable", reason: "busy"}));
  expect(driver.firstOpenStanding(later)).toBeUndefined();
  driver.firstOpenAnswered(firstOpenOutcome(later, {kind: "refused", reason: "deletion"}));
  expect(driver.firstOpenStanding(later)).toMatchObject({reason: "deletion"});
  expect(o.host.unblock(o.other)).toBe(false);
  driver.removeTarget(o.target);
  expect(driver.firstOpenStanding(later)).toBeUndefined();
  expect(driver.firstOpenStatus(later, () => later)).toBeUndefined();
});

// Proves: owner status never reads a ready document as refused. A refusal the
// relay gave before the document's capture is forgotten once that capture
// succeeds, and status reads the document's head only while an answer stands.
it("never reports a ready document's first open as refused", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], activations = vi.mocked(ServiceActivationDriver.prototype.activate).mock.contexts;
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 10, guard() {}});
  o.refuseCapture(withoutLineage());
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.blocked(o.sibling)).toBe("without-lineage"));
  const driver = activations.at(-1) as ServiceActivationDriver, head = o.f.storage.readFirstOpenMoment("workspace", "object")!;
  driver.firstOpenAnswered(firstOpenOutcome({workspaceId: "workspace", objectId: "object", path: head.path!, sourceMomentId: head.sourceMomentId,
    sourceDigest: head.sourceDigest!}, {kind: "refused", reason: "deletion"}));
  const handle = createServiceHostEnrollmentRoutes({storage: o.f.storage, history: o.f.history, resolveActor: async () => ({workspaceId: "workspace", userId: "owner"}),
    host: {ready: document => o.host.isDocumentReady(document), reconcile() {}, unavailable: false, blocked: document => o.host.blocked(document),
      unblock: document => o.host.unblock(document), diverged: () => false, holdReason: document => o.host.holdReason(document),
      keptEdits: {page: async () => null, retry: async () => "unavailable" as const, copied: async () => {}}, firstOpenStatus: (document, source) => o.host.firstOpenStatus(document, source),
      stop: async <T>(_document: unknown, fence: () => T) => fence()}});
  const status = async () => (await (await handle(new Request("https://relay.test/sync/workspace/live-host",
    {headers: {authorization: "Bearer owner-token"}}))).json()).documents;
  expect(await status()).toEqual([{path: "docs/a.md", objectId: "object", status: "unavailable", reason: "live-first-open-refused", firstOpen: expect.objectContaining({reason: "deletion"})}]);
  o.refuseCapture(undefined);
  appendDocumentRow(o.raw, "ydoc.update", o.sibling.objectId);
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const reads = vi.spyOn(o.f.storage, "readFirstOpenMoment");
  expect(await status()).toEqual([expect.objectContaining({path: "docs/a.md", status: "ready"})]);
  expect(reads).not.toHaveBeenCalled();
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

// Opus's r2c-3e4 review: nothing proved that a target sharing another's
// catch-up pull blocks at that pull's head. Proves: a second ownerless target
// whose document took an update after the first target's pull started, and
// before its own activation read the latest, blocks at the head that pull
// started at, so it captures once more on a later pass, and only once.
it("captures a second target without lineage once more for an update during the pull it shared", async () => {
  const o = await emptyServiceHost({maxDocumentsPerPass: 2}), workspaces = [o.workspace];
  // The other document activates for real here, at a path the relay names it at.
  vi.mocked(ServiceActivationDriver.prototype.activate).mockRestore();
  vi.mocked(ServiceActivationDriver.prototype.loaded).mockRestore();
  o.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,
    content_kind,byte_length,recorded_at_ms) SELECT 'workspace',?,MAX(relay_seq),'other-moment','main',?,?,'text',0,0
    FROM sync_relay_log WHERE workspace_id='workspace'`).run(o.other.objectId, o.other.path, "e".repeat(64));
  const captures = () => o.client().captureOwnerActivation.mock.calls.filter(call => call[1] === o.other.path).length;
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCaptureAt(o.other.path, withoutLineage());
  const pulling = o.park("sync.pullHosted");
  await o.host.update({workspaces, documents: [o.sibling, o.other], ...stay});
  await pulling.entered.promise;
  appendDocumentRow(o.raw, "ydoc.update", o.other.objectId);
  pulling.release.resolve();
  await vi.waitFor(() => expect(o.host.blocked(o.other)).toBe("without-lineage"));
  await vi.waitFor(() => expect(captures()).toBe(2));
  await o.nextPull(); await o.nextPull();
  expect(captures()).toBe(2);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
});

// A note an agent wrote as a file, which no device ever opened.
const neverOpened = {workspaceId: "workspace", objectId: "object-plain", path: "docs/plain.md", shareId: "share"};
const serviceKey = new Uint8Array(32).fill(5);
// The engine's verdict, standing in for the native check firstOpenPublication.native.test.ts drives.
const checkedCandidate = (input: FirstOpenCandidateInput): FirstOpenNativeCheck => ({kind: "answered", current: () => true,
  check: {status: "checked", contractVersion: 1, binding: firstOpenCandidateBinding(input), settledSourceSha256: input.sourceSha256,
    settledSourceByteLength: input.source.byteLength, fullStateSha256: "f".repeat(64), fullStateByteLength: input.candidate.byteLength + 7}});

// An empty host given the sibling and the never-opened note, whose captures
// find no lineage. Its first-open requests reach the relay's real route,
// publisher and storage, with the engine's check standing in. `answer` sees
// each request before the relay does; `onCheck` runs once the engine checked a
// base, before the relay writes it. The workspace's credential is its
// service-host credential, or with `credential: "other"`, a well-formed one
// the relay never derived. `rewrite` writes the note again under a new source id.
async function neverOpenedHost(options: {passDeadlineMs?: number; pollIntervalMs?: number; maxDocumentsPerPass?: number; nowMs?: () => number;
  random?: () => number; schedule?: FirstOpenOptions["schedule"]; credential?: "service-host" | "other"; onCheck?: () => void;
  answer?: (request: Request, relay: (request: Request) => Promise<Response>) => Promise<Response>} = {}) {
  let relay!: (request: Request) => Promise<Response>;
  // Each request, its signal, and the signal of the pass whose capture started it.
  const requests: {request: Request; signal: AbortSignal; pass: AbortSignal | undefined}[] = [], statuses: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const request = new Request(url, init);
    const pass = vi.mocked(ServiceActivationDriver.prototype.activate).mock.calls.filter(call => call[0].path === neverOpened.path).at(-1)?.[1];
    requests.push({request, signal: init!.signal!, pass});
    const response = await (options.answer ?? (next => relay(next)))(request, relay);
    statuses.push(response.status);
    return response;
  });
  const o = await emptyServiceHost({passDeadlineMs: options.passDeadlineMs, pollIntervalMs: options.pollIntervalMs, maxDocumentsPerPass: options.maxDocumentsPerPass,
    firstOpen: {fetch: fetcher, nowMs: options.nowMs, random: options.random, schedule: options.schedule}});
  let writes = 0;
  const rewrite = (id: string, markdown: string) => {
    const text = new TextEncoder().encode(markdown), digest = sha256(text);
    o.f.storage.putBlob({workspaceId: "workspace", sha256: digest, content: text, createdAtMs: 1});
    o.f.storage.appendLogBatch({workspaceId: "workspace", originId: "agent", ops: [{originSeq: writes++, opKind: "moment.append", recordedAtMs: 1,
      payloadJson: JSON.stringify({momentId: id, objectId: neverOpened.objectId, versionId: "main", operation: "write", path: neverOpened.path,
        payloadAfterPath: neverOpened.path, payloadAfterBlobSha256: digest, payloadAfterByteLength: text.byteLength, payloadAfterContentKind: "text", recordedAtMs: 1_001})}]});
  };
  rewrite("plain-moment", "# Plan\n\nBring snacks.\n");
  const enrollment = o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: neverOpened.path,
    nowMs: 10, guard() {}});
  const namespace = o.f.history.namespace;
  const builds = vi.fn<FirstOpenBuild>(async (policy, input) => buildFirstOpenBase(policy, input));
  const checks = vi.fn<FirstOpenCheckHost["checkFirstOpenCandidate"]>(async (_workspaceId, input) => {options.onCheck?.(); return checkedCandidate(input);});
  const publisher = createFirstOpenPublisher({storage: o.f.storage, namespace, activation: () => o.host.activationConfig(),
    host: () => ({checkFirstOpenCandidate: checks}), build: builds});
  relay = createServiceHostReplication({storage: o.f.storage, prefix: "dohc-service-v1.", hostedFeed: true, firstOpen: publisher,
    authorize: input => authorizeServiceHostReplication(o.f.storage, {key: serviceKey, namespace, ...input})});
  const bearer = options.credential === "other" ? `dohc-service-v1.${"A".repeat(43)}` : deriveServiceHostBearer(enrollment, {key: serviceKey, namespace});
  const hostedReplication = o.workspace.hostedReplication!;
  const workspace = {...o.workspace, hostedReplication: {...hostedReplication, relay: {...hostedReplication.relay, bearerToken: bearer}}};
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCaptureAt(neverOpened.path, withoutLineage());
  await o.host.update({workspaces: [workspace], documents: [o.sibling, neverOpened], ...stay});
  return {...o, workspace, bearer, requests, statuses, fetcher, builds, checks, rewrite,
    captures: () => o.client().captureOwnerActivation.mock.calls.filter(call => call[1] === neverOpened.path).length,
    bases: () => o.raw.prepare("SELECT payload_json FROM sync_relay_log WHERE origin_id LIKE 'service-host:first-open:%'").all()};
}

// Proves: a hosted note no device ever opened starts through its first open.
// Its fresh capture finds no lineage, the host asks the relay's real route with
// the workspace's service-host credential, the relay publishes a base, and
// the next pass pulls and captures the note again with no Resume. The receipt
// alone does not make it ready: this engine's capture still finds no lineage,
// so the note waits for a device like any other without lineage.
it("starts a never-opened note through its first open, and only a later capture can make it ready", async () => {
  const o = await neverOpenedHost();
  await vi.waitFor(() => expect(o.bases()).toHaveLength(1));
  await vi.waitFor(() => expect(o.captures()).toBe(2));
  expect(o.statuses).toEqual([200]);
  expect(o.requests[0]!.request.headers.get("authorization")).toBe(`Bearer ${o.bearer}`);
  expect(o.builds).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(o.host.blocked(neverOpened)).toBe("without-lineage"));
  const base = JSON.parse(String(o.bases()[0]!.payload_json)) as {lineageClaimId: string};
  expect(o.host.isDocumentReady({workspaceId: "workspace", mainVersionId: "main", objectId: neverOpened.objectId, lineageClaimId: base.lineageClaimId})).toBe(false);
  await afterPasses(o.f, 2);
  expect(o.fetcher).toHaveBeenCalledOnce();
  expect(o.captures()).toBe(2);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
});

// Proves: a first-open request runs outside the pass whose capture started it.
// It outlives that pass's deadline unaborted, as a build longer than a pass
// must. No later pass asks again while it runs, the note reads as preparing,
// not blocked, the other document stays ready, and the answer still counts.
it("keeps a first-open request running past the deadline of the pass that started it", async () => {
  const answer = deferred<void>();
  const o = await neverOpenedHost({passDeadlineMs: 1_000, answer: async (request, relay) => {await answer.promise; return relay(request);}});
  await vi.waitFor(() => expect(o.requests).toHaveLength(1));
  const {signal, pass} = o.requests[0]!;
  await vi.waitFor(() => expect(pass?.aborted).toBe(true), {timeout: 5_000});
  await afterPasses(o.f, 2);
  expect(signal.aborted).toBe(false);
  expect(o.requests).toHaveLength(1);
  expect(o.host.blocked(neverOpened)).toBeUndefined();
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  answer.resolve();
  await vi.waitFor(() => expect(o.bases()).toHaveLength(1));
  await vi.waitFor(() => expect(o.captures()).toBe(2));
});

// Proves: a first-open request ends with the note's place on the host. The
// note leaving the host, as after Stop, or the host closing,
// aborts it before the relay builds anything, and nothing asks again.
it.each(["the note leaves the host", "the host closes"] as const)("cancels a first-open request when %s", async ending => {
  const o = await neverOpenedHost({answer: request => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), {once: true});
  })});
  await vi.waitFor(() => expect(o.requests).toHaveLength(1));
  const {signal} = o.requests[0]!;
  expect(signal.aborted).toBe(false);
  if (ending === "the host closes") await o.host.close();
  else await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  expect(signal.aborted).toBe(true);
  if (ending === "the note leaves the host") {
    await afterPasses(o.f, 2);
    expect(o.host.isDocumentReady(o.document)).toBe(true);
  }
  expect(o.requests).toHaveLength(1);
  expect(o.builds).not.toHaveBeenCalled();
  expect(o.bases()).toHaveLength(0);
});

// Proves: Pause or Stop landing after the engine checked the base,
// before the relay writes it, publishes nothing through the wired route. The
// host takes the answer as a failed request, the note's departure ends its
// first open, and the other document keeps delivering edits throughout.
it.each([["Pause", false], ["Stop", true]] as const)("publishes nothing when %s lands after the engine checked, and the other note keeps moving", async (_name, retire) => {
  let o!: Awaited<ReturnType<typeof neverOpenedHost>>;
  o = await neverOpenedHost({onCheck: () => {
    o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", path: neverOpened.path, ownerUserId: "owner", enabled: false, retire, nowMs: 20, guard() {}});
  }});
  await vi.waitFor(() => expect(o.statuses).toEqual([404]));
  expect(o.checks).toHaveBeenCalledOnce();
  expect(o.bases()).toHaveLength(0);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  // The lost request is neither a refusal nor a stop, so Live documents shows the pause alone.
  const plain = {workspaceId: "workspace", objectId: neverOpened.objectId};
  const source = () => ({...plain, path: neverOpened.path, sourceMomentId: "plain-moment", sourceDigest: "a".repeat(64)});
  expect(o.host.firstOpenStatus(plain, source)).toBeUndefined();
  // The self-host supervisor's next membership leaves the note out.
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  expect(o.host.firstOpenStatus(plain, source)).toBeUndefined();
  // Live documents shows the note, while it lists it, as paused alone, with no refusal or stop.
  const handle = createServiceHostEnrollmentRoutes({storage: o.f.storage, history: o.f.history, resolveActor: async () => ({workspaceId: "workspace", userId: "owner"}),
    host: {ready: document => o.host.isDocumentReady(document), reconcile() {}, unavailable: false, blocked: document => o.host.blocked(document),
      unblock: document => o.host.unblock(document), diverged: () => false, holdReason: document => o.host.holdReason(document),
      keptEdits: {page: async () => null, retry: async () => "unavailable" as const, copied: async () => {}}, firstOpenStatus: (document, current) => o.host.firstOpenStatus(document, current),
      stop: async <T>(_document: unknown, fence: () => T) => fence()}});
  const listed = (await (await handle(new Request("https://relay.test/sync/workspace/live-host",
    {headers: {authorization: "Bearer owner-token"}}))).json()).documents as {objectId: string}[];
  const note = listed.filter(row => row.objectId === neverOpened.objectId);
  if (!retire) expect(note).toHaveLength(1);
  for (const row of note) expect(row).toEqual({path: neverOpened.path, objectId: neverOpened.objectId, status: "paused"});
  o.acceptEdit("moving");
  await o.host.drain(o.document);
  expect(o.applied.has("edit-moving")).toBe(true);
  await afterPasses(o.f, 2);
  expect(o.requests).toHaveLength(1);
  expect(o.bases()).toHaveLength(0);
});

// The engine refusing a capture past its byte budget, which it answers the same way on every pass. The engine
// names the budget for a live application's own check, and says only "workspace operation failed" for one a
// Y.Doc read inside the capture meets.
const limitExceeded = (message: string) => new EngineRequestError(1, {code: "LIMIT_EXCEEDED", message, retry: "no"} as never);

// Proves: a note whose first open published a base, and whose capture the
// engine then refuses past its byte budget, reports that refusal with the
// engine's code in its stable form. No later pass captures it again or asks
// the relay again until Try again, which allows exactly one more capture, and
// the same refusal coming back shows again.
it.each([
  ["live-application-byte-budget-exceeded", "live-application-byte-budget-exceeded"],
  ["workspace operation failed", "limit-exceeded"],
] as const)("reports a capture refused with %s after a first open published its base, and captures again only after Try again", async (message, code) => {
  let o!: Awaited<ReturnType<typeof neverOpenedHost>>;
  o = await neverOpenedHost({onCheck: () => o.refuseCaptureAt(neverOpened.path, limitExceeded(message))});
  const plain = {workspaceId: "workspace", objectId: neverOpened.objectId};
  const status = () => o.host.firstOpenStatus(plain, () => ({...plain, path: neverOpened.path, sourceMomentId: "later", sourceDigest: "b".repeat(64)}));
  const refused = {reason: "ordinary-activation-refused", code, recovery: "report",
    source: expect.objectContaining({...plain, path: neverOpened.path, sourceMomentId: "plain-moment"})};
  await vi.waitFor(() => expect(o.bases()).toHaveLength(1));
  await vi.waitFor(() => expect(o.captures()).toBe(2));
  await vi.waitFor(() => expect(o.host.blocked(plain)).toBe("refused"));
  expect(status()).toEqual(refused);
  await afterPasses(o.f, 2);
  expect(o.captures()).toBe(2);
  expect(o.fetcher).toHaveBeenCalledOnce();
  expect(o.host.isDocumentReady(o.document)).toBe(true);
  expect(o.host.unblock(plain)).toBe(true);
  expect(status()).toBeUndefined();
  await vi.waitFor(() => expect(o.captures()).toBe(3));
  await vi.waitFor(() => expect(status()).toEqual(refused));
  await afterPasses(o.f, 2);
  expect(o.captures()).toBe(3);
  expect(o.fetcher).toHaveBeenCalledOnce();
});

// The engine's generic answer for a failure it does not name, which says nothing about the next pass.
const internalFailure = () => new EngineRequestError(1, {code: "INTERNAL", message: "workspace operation failed", retry: "no"} as never);

// Proves: a note whose first open published a base, and whose fresh capture
// then meets a conflict that a later pull or an applied conflict resolution
// clears, or a failure the engine does not name, waits as preparing rather
// than for Try again. Live documents shows no refusal, every later pass
// captures it again, and once the conflict clears the next capture goes
// through, all with no Try again and no new first-open request.
it.each([
  ["live-application-conflict", diverged],
  ["ydoc-conflict-open", conflictOpen],
  ["a generic engine failure", internalFailure],
] as const)("captures a first-opened note again after %s, with no Try again", async (_name, failure) => {
  let o!: Awaited<ReturnType<typeof neverOpenedHost>>;
  o = await neverOpenedHost({onCheck: () => o.refuseCaptureAt(neverOpened.path, failure())});
  const plain = {workspaceId: "workspace", objectId: neverOpened.objectId};
  const status = () => o.host.firstOpenStatus(plain, () => ({...plain, path: neverOpened.path, sourceMomentId: "later", sourceDigest: "b".repeat(64)}));
  const capture = o.client().captureOwnerActivation;
  const through = () => capture.mock.calls.filter((call, index) => call[1] === neverOpened.path && capture.mock.settledResults[index]?.type === "fulfilled").length;
  await vi.waitFor(() => expect(o.bases()).toHaveLength(1));
  await vi.waitFor(() => expect(o.captures()).toBe(2));
  await vi.waitFor(() => expect(o.captures()).toBeGreaterThan(3));
  expect(o.host.blocked(plain)).toBeUndefined();
  expect(status()).toBeUndefined();
  expect(through()).toBe(0);
  o.refuseCaptureAt(neverOpened.path, undefined);
  await vi.waitFor(() => expect(through()).toBe(1));
  expect(o.fetcher).toHaveBeenCalledOnce();
  expect(o.host.isDocumentReady(o.document)).toBe(true);
});

// Proves: a note whose first open published a base, and whose capture the
// relay's own activation validation then refuses, reports that refusal with
// one stable code, releases the capture's native lease at once, and no later
// pass captures it again.
it("reports a refused activation validation after a first open published its base, and releases its lease", async () => {
  const ordinaryActivation = liveValidation.ordinaryActivation;
  let refuse = false;
  const validations = vi.spyOn(liveValidation, "ordinaryActivation").mockImplementation(policy => {
    const validate = ordinaryActivation(policy);
    return async (work, signal) => refuse ? {kind: "refused", message: "Activation history is invalid."} : validate(work, signal);
  });
  cleanup.push(async () => validations.mockRestore());
  let o!: Awaited<ReturnType<typeof neverOpenedHost>>;
  o = await neverOpenedHost({onCheck: () => {refuse = true; o.refuseCaptureAt(neverOpened.path, undefined);}});
  const plain = {workspaceId: "workspace", objectId: neverOpened.objectId};
  const releases = () => o.ownerCalls().filter(([method]) => method === "liveApplication.releaseOwnerActivation").length;
  await vi.waitFor(() => expect(o.captures()).toBe(2));
  await vi.waitFor(() => expect(o.host.blocked(plain)).toBe("refused"));
  expect(o.host.firstOpenStatus(plain, () => ({...plain, path: neverOpened.path, sourceMomentId: "later", sourceDigest: "b".repeat(64)}))).toEqual({
    reason: "ordinary-activation-refused", code: "activation-validation", recovery: "report", source: expect.objectContaining({...plain, path: neverOpened.path})});
  expect(releases()).toBe(1);
  await afterPasses(o.f, 2);
  expect(o.captures()).toBe(2);
  expect(releases()).toBe(1);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
});

// Proves: only the workspace's service-host credential reaches first open. A
// request with a credential the relay never derived is not found before
// anything is read or built, and the host asks again only after backing off.
it("builds nothing for a first-open request with another credential, and asks again only after backing off", async () => {
  let clock = 0;
  const o = await neverOpenedHost({credential: "other", nowMs: () => clock});
  await vi.waitFor(() => expect(o.statuses).toEqual([404]));
  await afterPasses(o.f, 2);
  expect(o.requests).toHaveLength(1);
  // The first failure waits at most 1.5 s, with jitter.
  clock += 1_500;
  await vi.waitFor(() => expect(o.statuses).toEqual([404, 404]));
  expect(o.builds).not.toHaveBeenCalled();
  expect(o.checks).not.toHaveBeenCalled();
  expect(o.bases()).toHaveLength(0);
  expect(o.host.isDocumentReady(o.document)).toBe(true);
});

// Review round 2 of 3b, finding 1: detach ended first-open work only after the
// engine answered, and not at all when the detach failed. A publication whose
// check had answered could pass the writer's guard meanwhile.
// Proves: a detach aborts the workspace's first-open request and ends the
// checks the engine answered before it, while the engine has not answered the
// detach, and those checks stay ended when the detach fails.
it.each(["answers", "fails"] as const)("ends a workspace's first-open work before its detach, which then %s", async outcome => {
  // The retry clock stands still, so the aborted request is never asked again here.
  const o = await neverOpenedHost({nowMs: () => 0, answer: request => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), {once: true});
  })});
  await vi.waitFor(() => expect(o.requests).toHaveLength(1));
  Object.assign(o.client(), {checkFirstOpenCandidate: vi.fn(async () => ({status: "refused", cause: "settlement-mismatch"}))});
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const source = new TextEncoder().encode("# Plan\n"), candidate = Uint8Array.of(0, 0);
  const input = {objectId: neverOpened.objectId, path: neverOpened.path, sourceMomentId: "plain-moment", replicationEpoch: "epoch", streamIdentity: "stream",
    source, sourceSha256: digest(source), candidate, candidateSha256: digest(candidate), maxFullStateBytes: 4096};
  const answered = await o.host.checkFirstOpenCandidate("workspace", input, new AbortController().signal);
  expect(answered.kind === "answered" && answered.current()).toBe(true);
  if (outcome === "fails") o.failDetach(new EngineRequestError(1, {code: "INTERNAL", message: "detach refused", retry: "no"} as never));
  const parked = o.park("liveApplication.detachWorkspace"), detaching = o.host.deleteWorkspaces(["workspace"]);
  await parked.entered.promise;
  expect(o.requests[0]!.signal.aborted).toBe(true);
  expect(answered.kind === "answered" && answered.current()).toBe(false);
  expect(await o.host.checkFirstOpenCandidate("workspace", input, new AbortController().signal)).toEqual({kind: "unavailable", reason: "host-absent"});
  parked.release.resolve();
  if (outcome === "fails") await expect(detaching).rejects.toThrow();
  else await detaching;
  expect(answered.kind === "answered" && answered.current()).toBe(false);
  expect(o.requests).toHaveLength(1);
  expect(o.bases()).toHaveLength(0);
});

// Review round 2 of 3b, finding 2: a stale-source answer left its source never
// asked about again, so a source the relay's history came back to stayed
// without a first open.
// Proves: after a stale answer, the next pass that finds the same source asks
// again, and the relay publishes its base.
it("asks again about a source whose first-open answer said it was stale", async () => {
  let answered = 0;
  const o = await neverOpenedHost({answer: async (request, relay) => {
    if (answered++ > 0) return relay(request);
    const body = await request.clone().json() as {objectId: string; path: string; sourceMomentId: string; sourceDigest: string};
    return Response.json({ok: true, outcome: firstOpenOutcome({workspaceId: "workspace", objectId: body.objectId, path: body.path,
      sourceMomentId: body.sourceMomentId, sourceDigest: body.sourceDigest}, {kind: "refused", reason: "stale-source"})});
  }});
  await vi.waitFor(() => expect(o.bases()).toHaveLength(1), {timeout: 10_000});
  expect(o.statuses).toEqual([200, 200]);
  expect(o.builds).toHaveBeenCalledOnce();
});

// The pause a host given this interval takes between passes, which only a wake, or `run` below, ends in a test.
const HELD_POLL_MS = 3_600_000;
// Watches the activation loop's pauses; start it before the host. `run` ends the pause the loop waits in and
// resolves once the pass after it ends. `until` runs passes so, at most five, until `done` holds. `paused` says
// whether the loop waits in a pause now, and `early` counts pauses the host ended itself, as a wake does.
function heldPolls() {
  const timers = vi.spyOn(globalThis, "setTimeout"), cleared = vi.spyOn(globalThis, "clearTimeout"), ended = new Set<unknown>();
  cleanup.push(async () => {timers.mockRestore(); cleared.mockRestore();});
  const waiting = () => {
    for (let index = timers.mock.calls.length - 1; index >= 0; index--) {
      if (timers.mock.calls[index]![1] !== HELD_POLL_MS) continue;
      const timer: unknown = timers.mock.results[index]?.value;
      if (ended.has(timer) || cleared.mock.calls.some(call => call[0] === timer)) return undefined;
      return {timer, end: timers.mock.calls[index]![0] as () => void};
    }
    return undefined;
  };
  // A wake may end the pause first, and the pass it runs counts: the loop waited in the pause when `passed` began.
  const run = async (f: {passEnds: Set<() => void>}) => {
    let passed: Promise<void> | undefined;
    const pause = await vi.waitFor(() => {const pause = waiting(); expect(pause).toBeDefined(); passed = afterPasses(f, 0); return pause!;});
    ended.add(pause.timer);
    pause.end();
    await passed;
  };
  return {run, async until(f: {passEnds: Set<() => void>}, done: () => boolean) {for (let pass = 0; pass < 5 && !done(); pass++) await run(f);},
    paused: () => waiting() !== undefined,
    early: () => timers.mock.calls.filter((call, index) => {
      const timer: unknown = timers.mock.results[index]?.value;
      return call[1] === HELD_POLL_MS && !ended.has(timer) && cleared.mock.calls.some(clear => clear[0] === timer);
    }).length};
}

// A first-open retry clock with no jitter, which moves only when the test advances it, and the timers the host sets on it.
function retryClock() {
  let now = 0;
  const timers: {atMs: number; fire: () => void; over: boolean}[] = [];
  return {nowMs: () => now, random: () => 0,
    schedule(atMs: number, fire: () => void) {const timer = {atMs, fire, over: false}; timers.push(timer); return () => {timer.over = true;};},
    // The deadlines the host's timers wait for now.
    armed: () => timers.filter(timer => !timer.over).map(timer => timer.atMs),
    // Moves the clock to `atMs` and fires each timer that fell due.
    advance(atMs: number) {
      now = atMs;
      for (const timer of timers) if (!timer.over && timer.atMs <= atMs) {timer.over = true; timer.fire();}
    }};
}

// The source a first-open request asks about.
const sourceOf = async (request: Request) => {
  const body = await request.clone().json() as {objectId: string; path: string; sourceMomentId: string; sourceDigest: string};
  return {workspaceId: "workspace", objectId: body.objectId, path: body.path, sourceMomentId: body.sourceMomentId, sourceDigest: body.sourceDigest};
};
// The relay's answer to a first-open request, for the source it asked about.
const answerWith = async (request: Request, answer: Parameters<typeof firstOpenOutcome>[1]) =>
  Response.json({ok: true, outcome: firstOpenOutcome(await sourceOf(request), answer)});
const plainNote = {workspaceId: "workspace", objectId: neverOpened.objectId};

// Issue #1967: a first open's answer waited for the next 250 ms pass to pull and capture the note.
// Proves: with periodic passes held, the base a first open published wakes a pass that pulls the relay,
// then captures the note again.
it("pulls and captures a note again once its first open publishes, with no periodic pass", async () => {
  const polls = heldPolls(), relayed = deferred<void>();
  // The relay takes the request only once the passes that start it have ended.
  const o = await neverOpenedHost({pollIntervalMs: HELD_POLL_MS, maxDocumentsPerPass: 2, answer: async (request, relay) => {await relayed.promise; return relay(request);}});
  // Whether the base was written yet at each pull, and how often the note was captured by then.
  const pulls: {bases: number; captures: number}[] = [];
  o.requestListeners.add(method => {if (method === "sync.pullHosted") pulls.push({bases: o.bases().length, captures: o.captures()});});
  await polls.until(o.f, () => o.captures() > 0);
  await vi.waitFor(() => expect(o.requests).toHaveLength(1));
  await vi.waitFor(() => expect(polls.paused()).toBe(true));
  let passes = 0;
  o.f.passEnds.add(() => {passes++;});
  relayed.resolve();
  await vi.waitFor(() => expect(o.bases()).toHaveLength(1), {timeout: 10_000});
  await vi.waitFor(() => expect(o.captures()).toBe(2), {timeout: 5_000});
  expect(passes).toBeGreaterThan(0);
  expect(polls.early()).toBeGreaterThan(0);
  expect(pulls).toContainEqual({bases: 1, captures: 1});
  expect(o.fetcher).toHaveBeenCalledOnce();
});

// Issue #1967: a capture whose validation found no free slot was captured again on every pass until one was free.
// Proves: with periodic passes held, the note is captured once while validation stays busy, however many passes
// run, and the slot coming free wakes the pass that captures it again.
it("captures a note whose validation was busy again only once a slot may be free", async () => {
  const free = deferred<void>(), validations: string[] = [], waits: (AbortSignal | undefined)[] = [];
  let busy = true;
  const validation = vi.spyOn(liveValidation, "ordinaryActivation").mockImplementation(() => async () => {
    validations.push(busy ? "retry" : "refused");
    return busy ? {kind: "retry", reason: "admission-unavailable", waitForCapacity: async (signal?: AbortSignal) => {waits.push(signal); await free.promise;}}
      : {kind: "refused", message: "Activation history is invalid."};
  });
  cleanup.push(async () => validation.mockRestore());
  const polls = heldPolls();
  let o!: Awaited<ReturnType<typeof neverOpenedHost>>;
  o = await neverOpenedHost({pollIntervalMs: HELD_POLL_MS, maxDocumentsPerPass: 2, onCheck: () => o.refuseCaptureAt(neverOpened.path, undefined)});
  await polls.until(o.f, () => o.captures() > 0);
  await vi.waitFor(() => expect(o.bases()).toHaveLength(1), {timeout: 10_000});
  // The capture after the base meets busy validation, whether the base's wake or a held pass runs it.
  await polls.until(o.f, () => validations.length > 0);
  expect(validations).toEqual(["retry"]);
  const captured = o.captures();
  for (let pass = 0; pass < 20; pass++) await polls.run(o.f);
  console.info(`Captures while validation stayed busy, over 20 passes: ${o.captures() - captured}`);
  expect(o.captures()).toBe(captured);
  expect(validations).toEqual(["retry"]);
  expect(waits.map(signal => signal?.aborted)).toEqual([false]);
  busy = false;
  free.resolve();
  // This fixture's engine captures the sibling's source for the note, so the refusal names no base and only fails the pass.
  await vi.waitFor(() => expect(validations).toEqual(["retry", "refused"]), {timeout: 5_000});
  expect(o.captures()).toBe(captured + 1);
});

// Issue #1967: a first open asked again at its deadline only if a 250 ms pass happened to run after it.
// Proves: with periodic passes held, a note the relay answered with build deadlines is asked about again at each
// retry time the host set, from that time's timer, and no pass asks before one. The third deadline answer stops
// it with no timer left. Try again then waits for the relay's own wait, and asks once that ends.
it("asks again at each build deadline's retry time with no periodic pass, and stops at the third", async () => {
  const clock = retryClock(), polls = heldPolls();
  const o = await neverOpenedHost({pollIntervalMs: HELD_POLL_MS, maxDocumentsPerPass: 2, nowMs: clock.nowMs, random: clock.random, schedule: clock.schedule,
    answer: request => answerWith(request, {kind: "unavailable", reason: "build-deadline", retryAfterMs: 1_000})});
  await polls.until(o.f, () => o.captures() > 0);
  await vi.waitFor(() => expect(clock.armed()).toEqual([60_000]));
  expect(o.requests).toHaveLength(1);
  clock.advance(59_999);
  for (let pass = 0; pass < 20; pass++) await polls.run(o.f);
  console.info(`First-open requests before their deadline, over 20 passes: ${o.requests.length - 1}`);
  expect(o.requests).toHaveLength(1);
  clock.advance(60_000);
  await vi.waitFor(() => expect(o.requests).toHaveLength(2));
  await vi.waitFor(() => expect(clock.armed()).toEqual([180_000]));
  clock.advance(179_999);
  await polls.run(o.f);
  expect(o.requests).toHaveLength(2);
  clock.advance(180_000);
  await vi.waitFor(() => expect(o.requests).toHaveLength(3));
  const source = await sourceOf(o.requests[0]!.request);
  await vi.waitFor(() => expect(o.host.firstOpenStatus(plainNote, () => source)).toMatchObject({reason: "retry-stopped", deadlineAnswers: 3}));
  expect(clock.armed()).toEqual([]);
  await polls.run(o.f);
  expect(o.requests).toHaveLength(3);
  // The relay's wait after the third deadline ends at 181 s.
  expect(o.host.unblock(plainNote)).toBe(true);
  expect(clock.armed()).toEqual([181_000]);
  await polls.run(o.f);
  expect(o.requests).toHaveLength(3);
  clock.advance(181_000);
  await vi.waitFor(() => expect(o.requests).toHaveLength(4));
});

// Proves: Try again during a first-open request that does not end at its abort asks nothing more while that
// request runs. Its late answer counts for nothing, and its end wakes the pass that asks again, with no
// periodic pass.
it("asks again once the request Try again replaced ends, and discards its late answer", async () => {
  const late = deferred<void>(), polls = heldPolls();
  let answered = 0;
  const o = await neverOpenedHost({pollIntervalMs: HELD_POLL_MS, maxDocumentsPerPass: 2, nowMs: () => 0, answer: async (request, relay) => {
    if (answered++ > 0) return relay(request);
    await late.promise;
    return answerWith(request, {kind: "refused", reason: "deletion"});
  }});
  await polls.until(o.f, () => o.captures() > 0);
  await vi.waitFor(() => expect(o.requests).toHaveLength(1));
  const source = await sourceOf(o.requests[0]!.request);
  expect(o.host.unblock(plainNote)).toBe(true);
  expect(o.requests[0]!.signal.aborted).toBe(true);
  // The pass Try again wakes captures the note again, and no pass asks while the replaced request runs.
  await vi.waitFor(() => expect(o.captures()).toBe(2), {timeout: 5_000});
  await polls.run(o.f);
  expect(o.requests).toHaveLength(1);
  late.resolve();
  await vi.waitFor(() => expect(o.requests).toHaveLength(2), {timeout: 5_000});
  await vi.waitFor(() => expect(o.bases()).toHaveLength(1), {timeout: 10_000});
  expect(o.host.firstOpenStatus(plainNote, () => source)).toBeUndefined();
});

// Proves: a first-open request that ends because its note left the host wakes a pass, which asks nothing, and
// nothing asks about the note again once its retry falls due.
it("asks nothing more after a note's departure ends its first-open request", async () => {
  const clock = retryClock(), polls = heldPolls();
  const o = await neverOpenedHost({pollIntervalMs: HELD_POLL_MS, maxDocumentsPerPass: 2, nowMs: clock.nowMs, random: clock.random, schedule: clock.schedule,
    answer: request => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), {once: true});
    })});
  await polls.until(o.f, () => o.captures() > 0);
  await vi.waitFor(() => expect(o.requests).toHaveLength(1));
  let passes = 0;
  o.f.passEnds.add(() => {passes++;});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  expect(o.requests[0]!.signal.aborted).toBe(true);
  await vi.waitFor(() => expect(passes).toBeGreaterThan(0), {timeout: 5_000});
  clock.advance(10_000);
  await polls.run(o.f);
  expect(clock.armed()).toEqual([]);
  expect(o.requests).toHaveLength(1);
});

// Proves: a note written again while its first-open request ran is asked about under its new source as soon as
// the request for the old one answers, with no periodic pass.
it("asks about a note's new source once the request for its old source answers", async () => {
  const old = deferred<void>(), polls = heldPolls(), sources: string[] = [];
  const o = await neverOpenedHost({pollIntervalMs: HELD_POLL_MS, maxDocumentsPerPass: 2, nowMs: () => 0, answer: async (request, relay) => {
    sources.push((await sourceOf(request)).sourceMomentId);
    if (sources.length > 1) return relay(request);
    await old.promise;
    return answerWith(request, {kind: "unavailable", reason: "busy"});
  }});
  await polls.until(o.f, () => o.captures() > 0);
  await vi.waitFor(() => expect(sources).toEqual(["plain-moment"]));
  o.rewrite("plain-rewritten", "# Plan\n\nBring snacks and water.\n");
  await polls.run(o.f);
  expect(sources).toEqual(["plain-moment"]);
  old.resolve();
  await vi.waitFor(() => expect(sources).toEqual(["plain-moment", "plain-rewritten"]), {timeout: 5_000});
  await vi.waitFor(() => expect(o.bases()).toHaveLength(1), {timeout: 10_000});
});

// Proves: a host nothing wakes runs a pass only once its pause ends, as before wakes existed. Each pause is set
// for the whole interval, none ends early, and ten pauses run ten passes.
it("runs passes only at its interval while nothing wakes it", async () => {
  const polls = heldPolls();
  const o = await emptyServiceHost({pollIntervalMs: HELD_POLL_MS});
  await o.host.update({workspaces: [o.workspace], documents: [o.sibling], ...stay});
  await polls.until(o.f, () => o.host.isDocumentReady(o.document));
  let passes = 0;
  o.f.passEnds.add(() => {passes++;});
  for (let pass = 0; pass < 10; pass++) await polls.run(o.f);
  await vi.waitFor(() => expect(polls.paused()).toBe(true));
  expect(passes).toBe(10);
  expect(polls.early()).toBe(0);
});

// Proves: wakes coalesce rather than loop. Fifty Try agains at once run the pass the first one wakes, at most one
// more for the rest, and one for the single request they allow. The host then waits out its interval again, and
// a pass that finds nothing to do wakes none.
it("runs a bounded number of passes for a burst of wakes, then waits for its interval", async () => {
  const clock = retryClock(), polls = heldPolls();
  const o = await neverOpenedHost({pollIntervalMs: HELD_POLL_MS, maxDocumentsPerPass: 2, nowMs: clock.nowMs, random: clock.random, schedule: clock.schedule,
    answer: request => answerWith(request, {kind: "refused", reason: "deletion"})});
  await polls.until(o.f, () => o.captures() > 0);
  await vi.waitFor(() => expect(o.requests).toHaveLength(1));
  const source = await sourceOf(o.requests[0]!.request), refused = () => o.host.firstOpenStatus(plainNote, () => source);
  await vi.waitFor(() => expect(refused()).toMatchObject({reason: "deletion"}));
  await polls.run(o.f);
  await vi.waitFor(() => expect(polls.paused()).toBe(true));
  let passes = 0;
  o.f.passEnds.add(() => {passes++;});
  for (let wake = 0; wake < 50; wake++) expect(o.host.unblock(plainNote)).toBe(true);
  await vi.waitFor(() => expect(o.requests).toHaveLength(2), {timeout: 5_000});
  await vi.waitFor(() => expect(refused()).toMatchObject({reason: "deletion"}));
  await vi.waitFor(() => expect(polls.paused()).toBe(true), {timeout: 5_000});
  const woken = passes;
  console.info(`Passes for a burst of 50 wakes: ${woken}`);
  expect(woken).toBeGreaterThan(0);
  expect(woken).toBeLessThanOrEqual(3);
  await polls.run(o.f);
  await vi.waitFor(() => expect(polls.paused()).toBe(true));
  expect(passes).toBe(woken + 1);
  expect(o.requests).toHaveLength(2);
  expect(clock.armed()).toEqual([]);
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

// A hold of the sibling document for released retained work, as a pass names
// it, bound as the engine's first shared vector is, with `incoming` changed.
const releasedHold = (incoming: Partial<ReleasedLineageBinding["incoming"]> = {}) => {
  const binding = JSON.parse(bindingVectors.valid[0]!.canonical) as ReleasedLineageBinding;
  return {objectId: "object", reason: "released-lineage-unsettled", path: binding.currentPath!,
    bindingDigest: releasedLineageBindingDigest({...binding, incoming: {...binding.incoming, ...incoming}}), continuation: "frozen", bindingStale: false};
};
const digest = (hold: ReturnType<typeof releasedHold>) => hold.bindingDigest;
// The driver a host activates through, once a pass held one of its documents. `heard` hears it after each pass.
const heldDriver = (heard?: (driver: ServiceActivationDriver, window: HostedWindow) => void) => {
  let driver: ServiceActivationDriver | undefined;
  const hold = ServiceActivationDriver.prototype.hold;
  vi.spyOn(ServiceActivationDriver.prototype, "hold").mockImplementation(function (this: ServiceActivationDriver, ...args) {
    driver = this; const dropped = hold.apply(this, args); heard?.(this, args[2]);
    return dropped;
  });
  return () => driver;
};

// Proves: a document held for released retained work blocks only its own
// activation, keyed by its binding's digest. It never captures, its workspace
// keeps pushing and pulling, and passes still visit the other document. A
// fresh binding replaces the digest. Resume, and the resolution of another
// binding, one bound to the feed's namespace where this one names none among
// them, leave it held. Only its own binding's resolution lets it capture again.
it("holds a document for released retained work by its binding's digest until that binding is resolved", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], driver = heldDriver();
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const captures = () => o.client().captureOwnerActivation.mock.calls.length;
  const pushes = () => o.client().sendRequest.mock.calls.filter(call => ((call as unknown[])[0] as {method: string}).method === "sync.push").length;
  const visits = () => vi.mocked(ServiceActivationDriver.prototype.activate).mock.calls.filter(call => call[0].path === o.other.path).length;
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const unbound = releasedHold({relayNamespace: null}), bound = releasedHold(), refreshed = releasedHold({relayNamespace: null, originSeq: 1});
  o.replies.pass = {held: [unbound]};
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(unbound)));
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(false));
  const held = captures(), pushed = pushes();
  await o.nextPull(); await o.nextPull();
  expect(captures()).toBe(held);
  expect(pushes()).toBeGreaterThan(pushed);
  // Resume does not resolve it, and it is no block Resume could lift.
  expect(o.host.blocked(o.sibling)).toBeUndefined();
  expect(o.host.unblock(o.sibling)).toBe(false);
  expect(driver()!.clearResolvedHold(o.sibling, digest(bound))).toBe(false);
  o.replies.pass = {held: [refreshed]};
  await vi.waitFor(() => expect(driver()!.releasedHold(o.sibling)).toBe(digest(refreshed)));
  expect(driver()!.clearResolvedHold(o.sibling, digest(unbound))).toBe(false);
  await o.nextPull();
  expect(captures()).toBe(held);
  await o.host.update({workspaces, documents: [o.sibling, o.other], ...stay});
  const visited = visits();
  await vi.waitFor(() => expect(visits()).toBeGreaterThan(visited + 2));
  expect(captures()).toBe(held);
  o.replies.pass = {};
  o.refuseCapture(undefined);
  expect(driver()!.clearResolvedHold(o.sibling, digest(refreshed))).toBe(true);
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  expect(captures()).toBeGreaterThan(held);
  expect(driver()!.releasedHold(o.sibling)).toBeUndefined();
});

// Proves: a document a later pass no longer holds for released retained work
// is free of that hold, though the pass that held it committed nothing: the
// engine's fresh gate admitted the work it held. A fresh binding replaces the
// digest instead, and a pass that adopted a scope says nothing of it.
it("frees a document once a pass no longer holds it for released retained work", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace], driver = heldDriver();
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const hold = releasedHold(), refreshed = releasedHold({originSeq: 1});
  // The pass that holds it goes stale before its commit.
  o.replies.pass = {held: [hold]}; o.replies.commit = {committed: false};
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(hold)));
  o.replies.pass = {held: [refreshed]}; o.replies.commit = {};
  await vi.waitFor(() => expect(driver()!.releasedHold(o.sibling)).toBe(digest(refreshed)));
  o.replies.pass = {pendingCursor: null};
  await o.nextPull(); await o.nextPull();
  expect(driver()!.releasedHold(o.sibling)).toBe(digest(refreshed));
  o.replies.pass = {};
  o.refuseCapture(undefined);
  await vi.waitFor(() => expect(driver()!.releasedHold(o.sibling)).toBeUndefined());
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
});

// Proves: a pass whose held list was cut says nothing past where it stops.
// A list that names the document refreshes its hold; one that stops before
// it, or starts after it, leaves the hold as it was, cut or not. Only a list
// whose window reaches it frees it, once the engine no longer holds it.
it("keeps a released-lineage hold a cut held list leaves out, until a list that reaches it", async () => {
  const seen: {covers: boolean; digest: string | undefined}[] = [];
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  const driver = heldDriver((held, window) => seen.push({covers: hostedWindowCovers(window, "object"), digest: held.releasedHold(o.sibling)}));
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const hold = releasedHold(), refreshed = releasedHold({originSeq: 1});
  const waiting = (objectId: string) => ({objectId, reason: "hosted-backfill-work-waiting"});
  o.replies.pass = {held: [hold]};
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(hold)));
  // Two holds a pass: the first lists "another" and the sibling, the next "zebra" alone.
  o.replies.heldPerPass = 2;
  o.replies.pass = {held: [waiting("another"), refreshed, waiting("zebra")]};
  await vi.waitFor(() => expect(driver()!.releasedHold(o.sibling)).toBe(digest(refreshed)));
  const refreshing = seen.length;
  await o.nextPull(); await o.nextPull();
  expect(seen.slice(refreshing).some(row => !row.covers)).toBe(true);
  expect(seen.slice(refreshing).every(row => row.digest === digest(refreshed))).toBe(true);
  // The engine holds the sibling no more. One hold a pass: lists stop before it until one reaches it.
  const releasing = seen.length;
  o.replies.heldPerPass = 1;
  o.replies.pass = {held: [waiting("another"), waiting("apple")]};
  await vi.waitFor(() => expect(driver()!.releasedHold(o.sibling)).toBeUndefined());
  const freed = seen.findIndex((row, index) => index >= releasing && row.digest === undefined);
  expect(seen.slice(releasing, freed).some(row => !row.covers)).toBe(true);
  expect(seen.slice(releasing, freed).every(row => row.digest === digest(refreshed))).toBe(true);
  expect(seen[freed]!.covers).toBe(true);
  o.replies.pass = {};
  o.refuseCapture(undefined);
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
});

// Sol's review: an owner whose activation never finishes keeps its workspace
// from being ready and reuses its owner, so nothing pulls. When the pull
// before its capture held its document past where its held list stopped, no
// later list reached it: the owner stayed, and ended holds stayed blocked.
// Proves: passes go on paging a cut held list while the workspace is not
// ready, so the next pull names the hold and drops the owner, after which
// the workspace pulls again and an ended hold is freed.
it("pages a cut held list while an unfinished owner holds its workspace back, until it names the hold past it", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  let pulls = () => 0, reached: number | undefined;
  const driver = heldDriver(held => {if (reached === undefined && held.releasedHold(o.sibling) !== undefined) reached = pulls();});
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  await o.host.close();
  vi.spyOn(console, "error").mockImplementation(() => {});
  // One hold a pass, so the first list stops at "another", before the sibling's "object".
  const hold = releasedHold(), waiting = {objectId: "another", reason: "hosted-backfill-work-waiting"};
  o.replies.heldPerPass = 1;
  o.replies.pass = {held: [waiting, hold]};
  // The engine retired the session its owner captured, so its activation never finishes.
  vi.spyOn(OwnerCommittedDelivery.prototype, "drain").mockRejectedValue(new Error("live-registration-unavailable"));
  const restarted = await startServiceLiveHost({...o.f, frameChanges: createNamedFrameChanges(16)});
  cleanup.push(() => restarted.close());
  pulls = o.pullCount;
  await restarted.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(hold)));
  // Its capture's pull, then the one that pages on.
  expect(reached).toBe(2);
  expect(driver()!.ownerDocument(o.sibling)).toBeUndefined();
  o.replies.pass = {held: [waiting]};
  await vi.waitFor(() => expect(driver()!.releasedHold(o.sibling)).toBeUndefined());
});

// Opus's review: a document held while it was edited live, past where its
// pass's held list stopped, kept its owner, so the relay kept it open until a
// later list reached it. Proves: the pass names what it moved from ready to
// held, and that page drops its owner. That list only adds: one that leaves a
// held document out frees nothing.
it("drops the owner of a document held mid-edit on the page that holds it, however its held list was cut", async () => {
  const seen: {covers: boolean; owned: boolean}[] = [];
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  const driver = heldDriver((held, window) => seen.push({covers: hostedWindowCovers(window, "object"), owned: held.ownerDocument(o.sibling) !== undefined}));
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const hold = releasedHold(), waiting = {objectId: "another", reason: "hosted-backfill-work-waiting" as const};
  const holding = seen.length;
  o.replies.heldPerPass = 1;
  o.replies.pass = {held: [waiting, hold], newlyHeld: [{objectId: hold.objectId, reason: hold.reason, bindingDigest: hold.bindingDigest}]};
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(hold)));
  const dropped = seen.findIndex((row, index) => index >= holding && !row.owned);
  expect(seen[dropped]).toEqual({covers: false, owned: false});
  expect(o.host.isDocumentReady(o.document)).toBe(false);
  driver()!.hold("workspace", [], {after: undefined, through: "another"}, {listed: [waiting], complete: true});
  expect(driver()!.releasedHold(o.sibling)).toBe(digest(hold));
});

// Sol's review: a pass that moved more documents from ready to held than its
// answer fits cut `newlyHeld` silently, and a pass whose commit's reply was
// lost never reached activation. Either way a live document past its page's
// held window could be in neither list, and its owner stayed. Proves: such a
// page drops every owner past its window, though it names none of them; the
// document activates again, where the engine refuses it until a list names
// its hold.
it.each(["cut", "lost"] as const)("drops every owner past the window of a page whose newly held list may leave some out: %s", async how => {
  const seen: {covers: boolean; owned: boolean; held: boolean}[] = [];
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  const driver = heldDriver((held, window) => seen.push({covers: hostedWindowCovers(window, "object"), owned: held.ownerDocument(o.sibling) !== undefined,
    held: held.releasedHold(o.sibling) !== undefined}));
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const hold = releasedHold(), waiting = {objectId: "another", reason: "hosted-backfill-work-waiting" as const};
  const holding = seen.length;
  // One hold a pass, so each first list stops at "another", before the sibling's "object", and no newly held list names it.
  o.replies.heldPerPass = 1;
  o.replies.pass = {held: [waiting, hold], ...how === "cut" ? {newlyHeldOmitted: 1} : {}};
  if (how === "lost") o.replies.loseCommit = true;
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(hold)));
  const dropped = seen.findIndex((row, index) => index >= holding && !row.owned);
  expect(seen[dropped]).toEqual({covers: false, owned: false, held: false});
  expect(o.host.isDocumentReady(o.document)).toBe(false);
});

// Sol's review: once a held sweep completed in a workspace another document
// kept from being ready, nothing pulled, so a hold the engine ended stayed.
// Proves: a workspace that is not ready pulls once a pass all the same, so
// the ended hold is freed within a pull or two, and none of those passes
// pushes.
it("frees an ended hold while another document keeps its workspace from being ready, without pushing", async () => {
  // The pulls when the hold ended, and when a pass freed it, counted as that pass frees it.
  let ended: number | undefined, freed: number | undefined;
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  const driver = heldDriver(held => {if (ended !== undefined && freed === undefined && held.releasedHold(o.sibling) === undefined) freed = o.pullCount();});
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.refuseCapture(unready());
  const hold = releasedHold();
  o.replies.pass = {held: [hold]};
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(hold)));
  // The other document never finishes activating, so its workspace is not ready from here on.
  await o.host.update({workspaces, documents: [o.sibling, o.other], ...stay});
  const pushes = () => o.client().sendRequest.mock.calls.filter(call => ((call as unknown[])[0] as {method: string}).method === "sync.push").length;
  const pushed = pushes();
  ended = o.pullCount();
  o.replies.pass = {};
  await vi.waitFor(() => expect(freed).toBeDefined());
  expect(driver()!.releasedHold(o.sibling)).toBeUndefined();
  expect(freed! - ended).toBeLessThanOrEqual(2);
  await o.nextPull();
  expect(pushes()).toBe(pushed);
});

// Sol's review: departed documents the engine cannot park, more than an
// answer fits, filled every departed list from the first, so a document
// after them was never named once the engine parked it, and the host kept
// it forever. Proves: the host retains it while any list names it, and
// once the engine parks it, a list reaches it within a sweep of pulls and
// the host lets it go.
it("lets a parked document after a stuck departed prefix go within a sweep of pulls, and never while a list names it", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  const left = {workspaceId: "workspace", objectId: "object-z", path: "docs/left.md", shareId: "share"};
  const stuck = ["object-a1", "object-a2", "object-a3", "object-a4", "object-a5"];
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  // Two departed documents an answer: a sweep is three pulls, the last naming the document while it stays.
  o.replies.departedPerPass = 2;
  o.replies.pass = {departed: [...stuck, left.objectId]};
  o.replies.commit = {departed: [...stuck, left.objectId]};
  await o.host.update({workspaces, documents: [o.sibling], departing: [left]});
  for (let pull = 0; pull < 4; pull++) {await o.nextPull(); expect(o.host.retains(left)).toBe(true);}
  expect(o.host.pulledAfterDeparture(left)).toBe(true);
  o.replies.pass = {departed: stuck};
  o.replies.commit = {departed: stuck};
  const parked = o.pullCount();
  await vi.waitFor(() => expect(o.host.retains(left)).toBe(false));
  expect(o.pullCount() - parked).toBeLessThanOrEqual(5);
});

// Sol's review: a pull after a departure counted as its replica's chance to
// retire it even when its departed list stopped short of it, so the relay
// moved on to its next page of retired enrollments, and the document came
// back only on pulls whose lists stopped short of it again: it was never
// confirmed gone. Proves: while the relay rotates its pages, as the
// self-hosted relay does with a sibling keeping the workspace attached, a
// page keeps its turn until a departed list reaches each of its documents,
// so a parked document is confirmed gone within a few pulls, and never while
// a list names it.
it("confirms a parked document gone while its retired enrollment pages rotate, and never while a list names it", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  const left = {workspaceId: "workspace", objectId: "object-z", path: "docs/left.md", shareId: "share"};
  const stuck = {workspaceId: "workspace", objectId: "object-a1", path: "docs/stuck.md", shareId: "share"};
  vi.spyOn(console, "error").mockImplementation(() => {});
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const list = (ids: string[]) => {o.replies.pass = {departed: ids}; o.replies.commit = {departed: ids};};
  // Each page is one retired enrollment. As on the self-hosted relay, the next page gets its turn once the host says each
  // document on this one had its replica's pull after it departed.
  const pages = [[stuck], [left]];
  let turn = 0;
  const select = () => o.host.update({workspaces, documents: [o.sibling], departing: pages[turn]!});
  // One pull at a time, then the next selection before the next pass.
  const pull = async () => {
    const parked = o.park("sync.pullHosted");
    await parked.entered.promise;
    const finished = select();
    parked.release.resolve();
    await finished;
  };
  const rotate = async () => {
    if (pages[turn]!.every(row => o.host.pulledAfterDeparture(row))) turn = (turn + 1) % pages.length;
    await select();
  };
  // Two departed documents an answer, so lists alternate between "object-a1".."object-a2" and those after.
  o.replies.departedPerPass = 2;
  const first = o.park("sync.pullHosted");
  await first.entered.promise;
  list(["object-a1", "object-a2", "object-a3", left.objectId]);
  const selected = select();
  first.release.resolve();
  await selected;
  for (let pulls = 0; pulls < 8; pulls++) {
    await pull();
    expect(o.host.retains(left)).toBe(true);
    await rotate();
  }
  // The engine parks it.
  list(["object-a1", "object-a2", "object-a3"]);
  for (let pulls = 1; ; pulls++) {
    await pull();
    if (!o.host.retains(left)) break;
    expect(pulls).toBeLessThan(4);
    await rotate();
  }
});

// Opus's review: a page whose departed list reached thousands of documents
// this host waits on looked each one up in that list, quadratic work on the
// event loop. Proves: a page listing 40,000 departing documents is heard in
// time linear in them.
it("hears a departed list reaching thousands of waiting documents in linear time", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const pull = ServiceHostedReplication.prototype.pull, heard: number[] = [];
  vi.spyOn(ServiceHostedReplication.prototype, "pull").mockImplementation(function (this: ServiceHostedReplication, signal, onPage) {
    return pull.call(this, signal, page => {const started = performance.now(); onPage?.(page); heard.push(performance.now() - started);});
  });
  const departing = Array.from({length: 40_000}, (_, index) => ({workspaceId: "workspace", objectId: `object-d${String(index).padStart(5, "0")}`,
    path: `docs/d${index}.md`, shareId: "share"}));
  const ids = departing.map(row => row.objectId);
  o.replies.pass = {departed: ids}; o.replies.commit = {departed: ids};
  await o.host.update({workspaces, documents: [o.sibling], departing});
  const seen = heard.length;
  await o.nextPull();
  expect(o.host.pulledAfterDeparture(departing.at(-1)!)).toBe(true);
  expect(o.host.retains(departing[0]!)).toBe(true);
  // A lookup in the list for each would compare hundreds of millions of IDs: over 20 s on a fast desktop CPU. The
  // page takes about 20 ms there and has taken over 500 ms on a busy runner.
  expect(Math.max(...heard.slice(seen))).toBeLessThan(2500);
});

// Opus's review: a page whose newly held list may leave some out drops every
// owner past its held window, and nothing said so, though each drop forces a
// capture again. Proves: the count of owners dropped is reported once per
// change, however many pages drop them again, and again once a complete
// list cleared it.
it("reports owners dropped for a newly held list that may leave some out once per change in their count", async () => {
  const o = await emptyServiceHost(), workspaces = [o.workspace];
  await o.host.update({workspaces, documents: [o.sibling], ...stay});
  await vi.waitFor(() => expect(o.host.isDocumentReady(o.document)).toBe(true));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const reports = () => log.mock.calls.filter(([message]) => message === "Hosted pull dropped live document owners its held list may leave out.");
  const captures = () => o.client().captureOwnerActivation.mock.calls.length;
  const waiting = (objectId: string) => ({objectId, reason: "hosted-backfill-work-waiting"});
  const incomplete = {held: [waiting("another"), waiting("zebra")], newlyHeldOmitted: 1};
  // One hold a pass, so every other list stops at "another", before the sibling's "object", and drops its owner.
  o.replies.heldPerPass = 1;
  o.replies.pass = incomplete;
  const captured = captures();
  await vi.waitFor(() => expect(captures()).toBeGreaterThan(captured + 2), {timeout: 10_000});
  expect(reports()).toEqual([[expect.any(String), "workspace", 1]]);
  o.replies.pass = {};
  await o.nextPull();
  expect(reports()).toHaveLength(1);
  o.replies.pass = incomplete;
  await vi.waitFor(() => expect(reports()).toHaveLength(2));
  expect(reports()[1]).toEqual([expect.any(String), "workspace", 1]);
});

// Proves: a restore's capture of a document held for released retained work
// clears what its pass held it for, never its binding's digest, so later
// passes still never capture it. Alone in its workspace, the dormant document
// leaves the workspace ready, so its passes pull and bring the hold.
it("keeps a released-lineage hold's digest through a restore capture", async () => {
  const driver = heldDriver(), o = await idleHost({alone: true});
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  const hold = releasedHold();
  o.replies.pass = {held: [hold]};
  await vi.waitFor(() => expect(driver()?.releasedHold(o.sibling)).toBe(digest(hold)));
  o.restore();
  const captures = o.client().captureOwnerActivation.mock.calls.length;
  await expect(o.host.stopRestore(stopLookup)).resolves.toEqual({kind: "pending", reason: "native-fence-pending"});
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  expect(driver()!.releasedHold(o.sibling)).toBe(digest(hold));
  await o.passes();
  expect(o.client().captureOwnerActivation.mock.calls.length).toBe(captures + 1);
  expect(driver()!.releasedHold(o.sibling)).toBe(digest(hold));
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
    ["liveApplication.register", {binding, activationId: `ordinary-activation-${"a".repeat(64)}`}],
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

// Proves: a document whose activation retires leaves through its retirement
// alone. One whose idle unload went unanswered is not unloaded again first:
// it retires with no other unload, while its sibling stays ready.
it("retires a stopped document whose idle unload went unanswered without sending that unload again", async () => {
  const o = await idleHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.f.storage.enrollServiceHostDocument({workspaceId: "workspace", ownerUserId: "owner", shareId: "share", path: o.sibling.path, nowMs: 10, guard() {}});
  o.unloads.push(new Error("Engine connection reset."), new Error("Engine connection reset."));
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  expect(preparedStop(o.f.storage, {workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path,
    enabled: false, retire: true, nowMs: 20, guard() {}})).toMatchObject({enabled: false, retired: true});
  await o.host.update({workspaces: o.workspaces, documents: [o.other], departing: [o.sibling]});
  await vi.waitFor(() => expect(o.host.retains(o.sibling)).toBe(false));
  expect(o.raw.prepare("SELECT retired_at_ms IS NOT NULL AS retired FROM sync_relay_service_activations").get()).toEqual({retired: 1});
  expect(o.unloaded()).toBe(1);
  expect(o.host.retains(o.other)).toBe(true);
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

// The owner's Stop through the running host, as the route asks it: the host
// delivers and prepares the document, then `fence` runs the relay's Stop.
const hostStop = (o: Awaited<ReturnType<typeof enrolledServiceHost>>, signal?: AbortSignal,
  fence = (prepared?: ServiceHostRetirementPreparation) => o.f.storage.setServiceHostEnrollmentEnabled({workspaceId: "workspace", ownerUserId: "owner",
    path: o.sibling.path, enabled: false, retire: true, nowMs: 20, guard() {}, ...(prepared ? {prepared} : {})})) =>
  o.host.stop({workspaceId: "workspace", objectId: "object"}, fence, signal);
// The document's own native queue holding `d`, which the relay refused, and
// `e` behind it, with the refusal the server keeps for its owner. Passes
// leave its delivery to the test.
function refusedNative(o: Awaited<ReturnType<typeof enrolledServiceHost>>) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const identity = o.workspace.hostedReplication!.identity, queue = {workspaceId: "workspace", identity, outboxId: "native-outbox"};
  Object.assign(o.native, {binding: o.binding, state: "quarantined"});
  o.f.storage.recordServiceKeptEdits({identity, outboxId: "native-outbox", binding: o.binding, reason: "invalid-update", headDeliveryId: "edit-d",
    refusalKey: "refusal-d", nowMs: 1});
  o.nativeEdits("d", "e");
  return {
    row: () => o.f.storage.readServiceKeptEdits(queue),
    async grant() {await expect(o.host.retryKeptEdits(o.f.storage.readServiceKeptEdits(queue)!, () => {})).resolves.toBe("granted");},
  };
}
// The live journal's cursors for a delivery.
const journaled = (o: Awaited<ReturnType<typeof enrolledServiceHost>>, deliveryId: string) =>
  o.raw.prepare("SELECT journal_cursor FROM sync_relay_live_update_journal WHERE delivery_id=? ORDER BY journal_cursor").all(deliveryId).map(row => Number(row.journal_cursor));
const engineParams = (o: Awaited<ReturnType<typeof enrolledServiceHost>>, method: string) =>
  o.ownerCalls().filter(([called]) => called === method).map(([, params]) => params);
const prepared = (o: Awaited<ReturnType<typeof enrolledServiceHost>>) =>
  ({objectId: "object", activationId: ACTIVATION, lineageClaimId: o.document.lineageClaimId, restoreFenceGeneration: o.binding.restoreFenceGeneration});
// Nothing fenced: no retirement opened and the document's admission stays open.
const stillLive = (o: Awaited<ReturnType<typeof enrolledServiceHost>>) => {
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull();
  expect(o.f.storage.serviceHostDocumentEnabled(o.sibling)).toBe(true);
  expect(o.f.storage.readServiceHostEnrollment("workspace", o.sibling.path)).toMatchObject({enabled: true, retired: false, ownerStop: null});
};

// Proves: Stop waits while the engine still holds an edit for the relay, even
// one the relay accepted whose acknowledgement was lost, and keeps the
// owner's Try again. It fences and blocks nothing. Once a drain replays that
// edit and delivers the one behind it, the next Stop prepares the activation
// and retires through both. Stopping again replays that retirement.
it("waits to stop while a granted edit's acknowledgement is lost, then retires through it and the edit behind it", async () => {
  const o = await enrolledServiceHost(), n = refusedNative(o);
  await n.grant();
  o.native.loseAcks.add("edit-d");
  await expect(o.host.drain(o.document)).rejects.toThrow("Acknowledgement lost.");
  expect(journaled(o, "edit-d")).toHaveLength(1);
  const preparationRequest = {id: 900, workspace: "attached-handle", method: "liveApplication.prepareRetirement", params: prepared(o)};
  expect((await o.client().sendRequest(preparationRequest)).result).toEqual(preparationWire.retryOutstanding);
  await expect(hostStop(o)).resolves.toBe("waiting");
  expect(o.native.entries.map(entry => entry.deliveryId)).toEqual(["edit-d", "edit-e"]);
  expect(engineParams(o, "liveApplication.prepareRetirement")).toEqual([prepared(o), prepared(o)]);
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([]);
  expect(o.engine.prepared).toBeUndefined();
  stillLive(o);
  expect(n.row()).toMatchObject({retrying: true});
  expect(o.native).toMatchObject({state: "quarantined", retryDeliveryId: "edit-d"});
  // The replay acknowledges `d` with the receipt the relay kept, then delivers `e`.
  o.native.loseAcks.clear();
  await o.host.drain(o.document);
  expect(o.native.entries).toEqual([]);
  const [d] = journaled(o, "edit-d"), [e] = journaled(o, "edit-e");
  expect(journaled(o, "edit-d")).toEqual([d]);
  expect(e).toBeGreaterThan(d!);
  await expect(hostStop(o)).resolves.toMatchObject({enabled: false, retired: true, acceptedCursor: e});
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toMatchObject({activationId: ACTIVATION, acceptedThrough: e});
  expect(engineParams(o, "liveApplication.prepareRetirement")).toEqual([prepared(o), prepared(o), prepared(o)]);
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([]);
  await expect(hostStop(o)).resolves.toMatchObject({retired: true, acceptedCursor: e});
  expect(engineParams(o, "liveApplication.prepareRetirement")).toHaveLength(3);
});

// Proves: a drain budget that ends between a granted edit and the edit behind
// it leaves Stop waiting, and Stop still waits once the next drain forgot the
// kept row because the queue delivers again but lost the later edit's
// acknowledgement. Stop retires through both once that edit is delivered.
it.each([
  ["one entry", {maxEntriesPerDrain: 1}],
  ["bytes for one entry", {maxBytesPerDrain: 1600}],
] as [string, DrainLimits][])("waits to stop while a drain budget of %s leaves the edit behind a granted one", async (_budget, limits) => {
  const o = await enrolledServiceHost({limits}), n = refusedNative(o);
  await n.grant();
  if (limits.maxBytesPerDrain) expect(o.nativeHeadBytes()).toBeLessThanOrEqual(limits.maxBytesPerDrain);
  // Stop's own drain delivers `d` and leaves `e`.
  await expect(hostStop(o)).resolves.toBe("waiting");
  expect(journaled(o, "edit-d")).toHaveLength(1);
  expect(journaled(o, "edit-e")).toEqual([]);
  expect(o.native).toMatchObject({state: "active", retryDeliveryId: null});
  expect(o.native.entries.map(entry => entry.deliveryId)).toEqual(["edit-e"]);
  stillLive(o);
  expect(n.row()).toMatchObject({retrying: true});
  o.native.loseAcks.add("edit-e");
  await expect(o.host.drain(o.document)).rejects.toThrow("Acknowledgement lost.");
  expect(n.row()).toBeNull();
  await expect(hostStop(o)).resolves.toBe("waiting");
  stillLive(o);
  expect(o.engine.prepared).toBeUndefined();
  o.native.loseAcks.clear();
  const [e] = journaled(o, "edit-e");
  await expect(hostStop(o)).resolves.toMatchObject({retired: true, acceptedCursor: e});
  expect(journaled(o, "edit-e")).toEqual([e]);
  expect(o.native.entries).toEqual([]);
});

// Proves: a kept row that still says retrying does not hold Stop back once
// the engine's queue holds nothing and no Try again.
it("stops a document whose kept row still says retrying once its native queue is empty", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const identity = o.workspace.hostedReplication!.identity, queue = {workspaceId: "workspace", identity, outboxId: "native-outbox"};
  Object.assign(o.native, {binding: o.binding, outboxId: "native-outbox"});
  o.f.storage.recordServiceKeptEdits({identity, outboxId: "native-outbox", binding: o.binding, reason: "invalid-update", headDeliveryId: "edit-d",
    refusalKey: "refusal-d", nowMs: 1});
  expect(o.f.storage.markServiceKeptEditsRetrying(o.f.storage.readServiceKeptEdits(queue)!)).toBe(true);
  await expect(hostStop(o)).resolves.toMatchObject({retired: true});
  expect(engineParams(o, "liveApplication.prepareRetirement")).toEqual([prepared(o)]);
  expect(o.engine.prepared).toEqual(prepared(o));
});

// Proves: a preparation belongs to the connection that made it. A connection
// replaced while the engine prepares fails the fence inside its transaction,
// the block ends, and the old host prepares nothing again.
it("fails the fence and ends the block when the host connection is replaced during preparation", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const parked = o.park("liveApplication.prepareRetirement"), stopping = hostStop(o);
  await parked.entered.promise;
  expect(o.f.storage.registerLiveHost({...o.host.coordinate, connectionId: "replacement", updatedAtMs: Date.now(), guard: o.f.storage.captureStanding()}).ok).toBe(true);
  parked.release.resolve();
  await expect(stopping).rejects.toThrow("retired");
  expect(o.engine.prepared).toBeUndefined();
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
  stillLive(o);
  await expect(hostStop(o)).rejects.toThrow("retired");
  expect(engineParams(o, "liveApplication.prepareRetirement")).toHaveLength(1);
});

// Proves: a host that closes while the engine prepares fences nothing, and
// ends the block before it stops. Stop waits, as while edits remain.
it("fences nothing and ends the block when the host closes during preparation", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const parked = o.park("liveApplication.prepareRetirement"), stopping = hostStop(o);
  await parked.entered.promise;
  const closing = o.host.close();
  parked.release.resolve();
  await expect(stopping).resolves.toBe("waiting");
  await closing;
  expect(o.engine.prepared).toBeUndefined();
  stillLive(o);
});

// Proves: a Stop whose host request passes its deadline waits, and does not
// fail with the connection's abort. The deadline retires the connection,
// which fences nothing and ends the block, so the document stays live.
it.each([
  ["its drain", "liveApplication.ownerState"],
  ["its preparation", "liveApplication.prepareRetirement"],
])("waits to stop when %s passes its deadline and retires the host connection", async (_step, method) => {
  const o = await enrolledServiceHost({frameChanges: true});
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const send = o.client().sendRequest, answer = send.getMockImplementation()!;
  let late = true;
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as {id: number; method: string};
    if (late && request.method === method) {late = false; throw new EngineRequestDeadlineError(request.id, request.method, 1_000);}
    return answer(request);
  });
  await expect(hostStop(o)).resolves.toBe("waiting");
  expect(late).toBe(false);
  expect(o.host.invalidated.aborted).toBe(true);
  expect(o.engine.prepared).toBeUndefined();
  stillLive(o);
});

// Proves: a Stop that wakes a dormant document waits when the wake's pull
// passes its deadline and retires the host connection. It does not fail as an
// unavailable host, and nothing is prepared or fenced.
it("waits to stop a dormant document when its wake passes its deadline and retires the host connection", async () => {
  const o = await idleHost({alone: true});
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.advance(600_000);
  await vi.waitFor(() => expect(o.unloaded()).toBe(1));
  const send = o.client().sendRequest, answer = send.getMockImplementation()!;
  let late = 0;
  // Every pull from here passes its deadline, whether the wake's or a pass's.
  send.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as {id: number; method: string};
    if (request.method === "sync.pullHosted") {late++; throw new EngineRequestDeadlineError(request.id, request.method, 1_000);}
    return answer(request);
  });
  const fence = vi.fn();
  await expect(o.host.stop({workspaceId: "workspace", objectId: "object"}, fence)).resolves.toBe("waiting");
  expect(late).toBeGreaterThan(0);
  expect(o.host.invalidated.aborted).toBe(true);
  expect(fence).not.toHaveBeenCalled();
  expect(o.methods()).not.toContain("liveApplication.prepareRetirement");
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull();
});

// Proves: a cancelled Stop releases the block and leaves admission open, and
// a later Stop prepares again and retires.
it("releases the block and keeps the document live when Stop is cancelled during preparation", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const cancel = new AbortController(), parked = o.park("liveApplication.prepareRetirement"), stopping = hostStop(o, cancel.signal);
  await parked.entered.promise;
  cancel.abort();
  parked.release.resolve();
  await expect(stopping).rejects.toThrow();
  expect(o.engine.prepared).toBeUndefined();
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
  stillLive(o);
  expect(o.host.invalidated.aborted).toBe(false);
  await expect(hostStop(o)).resolves.toMatchObject({retired: true});
  expect(engineParams(o, "liveApplication.prepareRetirement")).toHaveLength(2);
});

// Proves: a relay failure after the engine prepared releases the block, and
// a release that fails ends the host's connection, which ends the block.
it("releases the block when the fence fails after preparation, and closes the host when the release fails", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const failing = (): never => {throw new Error("Relay storage failed.");};
  await expect(hostStop(o, undefined, failing)).rejects.toThrow("Relay storage failed.");
  expect(o.engine.prepared).toBeUndefined();
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
  stillLive(o);
  expect(o.host.invalidated.aborted).toBe(false);
  o.engine.releaseFailure = new Error("Release reply lost.");
  await expect(hostStop(o, undefined, failing)).rejects.toThrow("Relay storage failed.");
  await vi.waitFor(() => expect(o.host.invalidated.aborted).toBe(true));
  stillLive(o);
});

// Proves: a restore that moved the document's generation while the engine
// prepared fails the fence as a restore conflict and ends the block.
it("fails the fence and ends the block when the restore generation changes during preparation", async () => {
  const o = await enrolledServiceHost();
  vi.spyOn(console, "error").mockImplementation(() => {});
  o.passes.deliver = false;
  const parked = o.park("liveApplication.prepareRetirement"), stopping = hostStop(o);
  await parked.entered.promise;
  o.raw.prepare("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1 WHERE object_id='object'").run();
  parked.release.resolve();
  await expect(stopping).rejects.toBeInstanceOf(ServiceHostRetirementConflict);
  expect(o.engine.prepared).toBeUndefined();
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
  stillLive(o);
});

// A known preparation refusal cannot fence or strand editing. Its release
// also finishes before a queued Try again can recheck authority and grant.
it.each(Object.entries(preparationWire.errors))("answers a %s preparation refusal without a fence or a held block", async (_name, wire) => {
  const o = await enrolledServiceHost(), n = refusedNative(o);
  o.engine.prepareFailure = new EngineRequestError(900, wire);
  // A reply may have been lost after the engine installed the block.
  o.engine.prepared = prepared(o);
  const parked = o.park("liveApplication.prepareRetirement"), stopping = hostStop(o).catch(errorResponse);
  await parked.entered.promise;
  const granting = o.host.retryKeptEdits(n.row()!, () => {
    expect(o.engine.prepared).toBeUndefined();
    expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
  });
  void granting.catch(() => {});
  expect(engineParams(o, "ydoc.ownerOutbox.retry")).toEqual([]);
  parked.release.resolve();
  const response = await stopping;
  expect(response).toBeInstanceOf(Response);
  if (wire.code === "INVALID_PARAMS") {
    expect((response as Response).status).toBe(500);
    expect(await (response as Response).json()).toMatchObject({ok: false, code: "internal_error"});
  } else {
    expect((response as Response).status).toBe(409);
    expect(await (response as Response).json()).toEqual({ok: false, code: "restore-in-progress", error: "Stop live editing is waiting. You can keep editing."});
  }
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([prepared(o)]);
  expect(o.engine.prepared).toBeUndefined();
  stillLive(o);
  if (wire.code === "CONFLICT") await expect(granting).resolves.toBe("granted");
  else {await granting.catch(() => {}); expect(o.host.invalidated.aborted).toBe(true);}
});

it("replays a committed Stop on a preparation Conflict and refuses the Try again queued behind it", async () => {
  const o = await enrolledServiceHost(), n = refusedNative(o);
  o.engine.prepareFailure = new EngineRequestError(900, preparationWire.errors.conflict);
  const parked = o.park("liveApplication.prepareRetirement"), stopping = hostStop(o);
  void stopping.catch(() => {});
  await parked.entered.promise;
  const granting = o.host.retryKeptEdits(n.row()!, () => {});
  void granting.catch(() => {});
  expect(engineParams(o, "ydoc.ownerOutbox.retry")).toEqual([]);
  const retired = preparedStop(o.f.storage, {workspaceId: "workspace", ownerUserId: "owner", path: o.sibling.path,
    enabled: false, retire: true, nowMs: 20, guard() {}});
  const open = readServiceActivationRetirement(o.f.storage as StorageContext, o.document)!;
  const tip = o.tip(), evidence = o.raw.prepare("SELECT accepted_event_count,accepted_evidence_digest FROM sync_relay_live_update_journal WHERE journal_cursor=?").get(tip.journalCursor)!;
  o.f.storage.createServiceActivationStore(o.f.history).completeRetirement({workspaceId: "workspace",
    key: {...prepared(o), acceptedThrough: open.acceptedThrough},
    boundary: {terminalReceipt: tip, eventCount: Number(evidence.accepted_event_count), historyEvidenceDigest: String(evidence.accepted_evidence_digest)},
    host: o.host.coordinate, registeredAtMs: Date.now(), nowMs: Date.now(), guard() {}});
  expect(retiredRow(o).retired).toBe(true);
  expect(readServiceActivationRetirement(o.f.storage as StorageContext, o.document)).toBeNull();
  expect(o.f.storage.serviceActivationRetirementDecision(o.document, prepared(o))).toMatchObject({activationId: ACTIVATION, acceptedThrough: retired!.acceptedCursor});
  expect(o.f.storage.serviceActivationRetirementDecision({...o.document, workspaceId: "other"}, prepared(o))).toBeNull();
  expect(o.f.storage.serviceActivationRetirementDecision({...o.document, objectId: "other"}, prepared(o))).toBeNull();
  for (const stale of [{...prepared(o), activationId: SUCCESSOR}, {...prepared(o), lineageClaimId: "c".repeat(64)},
    {...prepared(o), restoreFenceGeneration: open.restoreFenceGeneration + 1}]) {
    expect(o.f.storage.serviceActivationRetirementDecision(o.document, stale)).toBeNull();
  }
  const identity = o.f.storage.getWorkspaceIdentity("workspace")!;
  o.raw.prepare("UPDATE sync_relay_workspaces SET stream_identity='other' WHERE workspace_id='workspace'").run();
  expect(o.f.storage.serviceActivationRetirementDecision(o.document, prepared(o))).toBeNull();
  o.raw.prepare("UPDATE sync_relay_workspaces SET stream_identity=? WHERE workspace_id='workspace'").run(identity.streamIdentity);
  parked.release.resolve();
  await expect(stopping).resolves.toMatchObject({retired: true, acceptedCursor: retired!.acceptedCursor});
  await expect(granting).resolves.toBe("unavailable");
  expect(engineParams(o, "ydoc.ownerOutbox.retry")).toEqual([]);
  expect(engineParams(o, "liveApplication.releaseRetirementPreparation")).toEqual([]);
  expect(n.row()).toMatchObject({retrying: false});
});

it("rechecks the retirement candidate after a Stop queued behind another Stop", async () => {
  const o = await enrolledServiceHost();
  o.passes.deliver = false;
  const parked = o.park("liveApplication.prepareRetirement"), first = hostStop(o);
  await parked.entered.promise;
  const second = hostStop(o);
  parked.release.resolve();
  await expect(first).resolves.toMatchObject({retired: true});
  await expect(second).resolves.toMatchObject({retired: true});
  expect(engineParams(o, "liveApplication.prepareRetirement")).toEqual([prepared(o)]);
});

it.each(["liveApplication.prepareRetirement", "liveApplication.releaseRetirementPreparation"])(
  "rejects a wrong request scalar type against the shared fixture for %s", async method => {
    const o = await enrolledServiceHost();
    const request = {id: 900, workspace: "attached-handle", method, params: {...prepared(o), restoreFenceGeneration: "0"}};
    await expect(o.client().sendRequest(request)).rejects.toThrow("INVALID_PARAMS: invalid-retirement-preparation");
  });

it.each(["running without this workspace", "running without this document"] as const)(
  "answers Stop with the session host state %s without fencing", async state => {
    const o = await enrolledServiceHost();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await o.host.update({workspaces: [], documents: [], ...stay});
    if (state === "running without this document") await o.host.update({workspaces: [o.workspace], documents: [], ...stay});
    const response = await hostStop(o).catch(errorResponse);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(409);
    expect(await (response as Response).json()).toEqual({ok: false, code: "host-not-loaded", sessionHost: "running, document not loaded yet",
      error: "Live editing didn't stop. The server hasn't loaded this document yet and may hold recent edits to it. Try again in a moment."});
    stillLive(o);
    expect(engineParams(o, "liveApplication.prepareRetirement")).toEqual([]);
    expect(log.mock.calls.filter(([line]) => String(line).includes("Session host:"))).toEqual([
      ["Live editing Stop for workspace workspace, object object. Session host: running, document not loaded yet"],
    ]);
  });

// A host of ready workspaces with no documents, passing every millisecond. Its mocked engine keeps each hosted
// replica as the engine does: a pull reads the relay log after the replica's cursor and the hosted scope's
// documents, and its commit applies those rows and that scope and moves the cursor. `holdPull` keeps a workspace's
// next pull in flight before it reads the relay, or after, until released. `pushWrites` is how many of a
// workspace's next pushes each append a row, as the host's settled work does.
// Each workspace has one enrolled document, so the relay holds a hosted scope for it, unless `unscoped`.
async function readyHostedHost(workspaceIds: readonly string[], {unscoped = false} = {}) {
  const f = await fixture();
  await configureActivation(f, {targets: [], pollIntervalMs: 1});
  const base = f.config.workspaces[0]!;
  f.config.workspaces = await Promise.all(workspaceIds.map(async workspaceId => {
    const root = join(f.root, `root-${workspaceId}`); await mkdir(root);
    return {...base, root, workspaceId};
  }));
  await f.save();
  const raw = new DatabaseSync(join(f.root, "relay", "relay.sqlite")); cleanup.push(async () => raw.close());
  for (const workspaceId of workspaceIds) {
    raw.prepare("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity) VALUES (?,'person',0,'epoch','stream')").run(workspaceId);
    if (unscoped) continue;
    raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'person','{\"paths\":[\"docs\"],\"versionId\":null}',0)")
      .run(`share-${workspaceId}`, workspaceId);
    raw.prepare(`INSERT INTO sync_relay_service_host_enrollments(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
      created_at_ms,updated_at_ms,accounted_bytes) VALUES (?,'object','docs/note.md','person',?,'epoch','stream',1,0,0,1)`).run(workspaceId, `share-${workspaceId}`);
    expect(f.storage.readServiceHostFeedScope(workspaceId)?.hosted.size).toBe(1);
  }
  const append = (workspaceId: string) => f.storage.appendLogBatch({workspaceId, originId: "device",
    ops: [parseLogOp({originSeq: f.storage.maxOriginSeq(workspaceId, "device") + 1, opKind: "workspace.init", recordedAtMs: 1, payload: {}})]});
  const relayRows = (workspaceId: string) => f.storage.fetchLogPage({workspaceId, sinceRelaySeq: 0, limit: 1000}).rows.map(row => row.relaySeq);
  const hostedNow = (workspaceId: string) => [...f.storage.readServiceHostFeedScope(workspaceId)?.hosted.keys() ?? []];
  const replicas = new Map(workspaceIds.map(workspaceId => [workspaceId,
    {cursor: 0, applied: [] as number[], read: [] as number[], next: 0, more: false, scope: [] as string[], reading: [] as string[]}]));
  type Held = {entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>>};
  const holds = {read: new Map<string, Held>(), reply: new Map<string, Held>()};
  const pushWrites = new Map<string, number>(), failures = {pulls: 0};
  let client!: ReturnType<typeof clientFrom>["client"];
  spawn.mockImplementation(async options => {
    const captured = clientFrom(options); client = captured.client;
    client.sendRequest.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as {method: string; params?: {workspaceId?: string}};
      const workspaceId = request.params?.workspaceId ?? "", replica = replicas.get(workspaceId)!;
      switch (request.method) {
        case "liveApplication.hosts": return {result: {relayNamespace: captured.config.relayNamespace, host: captured.config.host,
          workspaces: captured.config.workspaces.map((row: {workspaceId: string}) => ({workspaceId: row.workspaceId, workspaceHandle: `handle-${row.workspaceId}`}))}} as never;
        case "sync.createHostedReplica": return {result: {hosted: true}} as never;
        case "sync.push": {
          const writes = pushWrites.get(workspaceId) ?? 0;
          if (writes > 0) {pushWrites.set(workspaceId, writes - 1); append(workspaceId);}
          return {result: {...pushReply, pushed: writes > 0 ? 1 : 0}} as never;
        }
        case "sync.pullHosted": {
          if (failures.pulls > 0) {failures.pulls--; throw new Error("The relay did not answer.");}
          const gate = async (at: keyof typeof holds) => {
            const held = holds[at].get(workspaceId);
            if (held) {holds[at].delete(workspaceId); held.entered.resolve(); await held.release.promise;}
          };
          await gate("read");
          const page = f.storage.fetchLogPage({workspaceId, sinceRelaySeq: replica.cursor, limit: 100});
          Object.assign(replica, {read: page.rows.map(row => row.relaySeq), next: page.nextCursor, more: page.hasMore, reading: hostedNow(workspaceId)});
          await gate("reply");
          return {result: hostedPass({fetched: page.rows.length, applied: page.rows.length, hasMore: page.hasMore})} as never;
        }
        case "sync.materializePendingCursor": return {result: {materialized: true}} as never;
        case "sync.commitCursor": {
          replica.applied.push(...replica.read); replica.cursor = replica.next; replica.scope = replica.reading;
          return {result: hostedCommit({hasMore: replica.more})} as never;
        }
      }
      throw new Error(`Unexpected engine request ${request.method}`);
    });
    return client;
  });
  const requests = (method: string, workspaceId: string) => client.sendRequest.mock.calls.filter(call => {
    const request = (call as unknown[])[0] as {method: string; params?: {workspaceId?: string}};
    return request.method === method && request.params?.workspaceId === workspaceId;
  }).length;
  const pulls = (workspaceId: string) => requests("sync.pullHosted", workspaceId);
  const passes = (count: number) => afterPasses(f, count);
  // The replica applied every row the relay holds and the hosted scope it holds now, and its cursor reached the last row.
  const caughtUp = (workspaceId: string) => {
    const rows = relayRows(workspaceId), replica = replicas.get(workspaceId)!;
    expect(replica.applied).toEqual(rows);
    expect(replica.cursor).toBe(rows.at(-1) ?? 0);
    expect(replica.scope).toEqual(hostedNow(workspaceId));
  };
  const holdPull = (workspaceId: string, at: keyof typeof holds = "reply") => {
    const held = {entered: deferred<void>(), release: deferred<void>()};
    holds[at].set(workspaceId, held);
    return held;
  };
  return {f, raw, append, relayRows, replicas, pushWrites, failures, pulls, passes, caughtUp, holdPull};
}

// Issue #1967: a ready workspace pulled its hosted replica on every 250 ms pass, with nothing new on the relay.
// Proves: once its replica caught up, it stays quiet over 100 passes, and notices of writes that change nothing it reads pull nothing.
it("pulls a ready, unchanged hosted workspace once rather than on every pass", async () => {
  const h = await readyHostedHost(["workspace"]);
  h.append("workspace");
  const host = await startServiceLiveHost(h.f);
  cleanup.push(() => host.close());
  await vi.waitFor(() => h.caughtUp("workspace"));
  await h.passes(2);
  await h.passes(100);
  notifyRelayWrite(h.f.storage);
  await h.passes(2);
  notifyRelayWrite(h.f.storage);
  await h.passes(2);
  expect(h.pulls("workspace")).toBe(1);
  expect(host.hostedPulls("workspace")).toEqual({total: 1, reasons: {first: 1}});
  h.caughtUp("workspace");
});

// Proves: a burst of writes pulls once, and a write while a pull is in flight, after it read the relay, pulls exactly once more.
it("pulls once for a burst of writes and once more for a write during a pull", async () => {
  const h = await readyHostedHost(["workspace"]);
  const host = await startServiceLiveHost(h.f);
  cleanup.push(() => host.close());
  await vi.waitFor(() => expect(h.pulls("workspace")).toBeGreaterThanOrEqual(1));
  await h.passes(2);
  for (let index = 0; index < 5; index++) h.append("workspace");
  await vi.waitFor(() => h.caughtUp("workspace"));
  await h.passes(3);
  expect(h.pulls("workspace")).toBe(2);
  const held = h.holdPull("workspace");
  h.append("workspace");
  await held.entered.promise;
  h.append("workspace");
  expect(h.replicas.get("workspace")!.read).toHaveLength(1);
  held.release.resolve();
  await vi.waitFor(() => h.caughtUp("workspace"));
  await h.passes(3);
  expect(h.pulls("workspace")).toBe(4);
  expect(host.hostedPulls("workspace")).toEqual({total: 4, reasons: {first: 1, changed: 3}});
  h.caughtUp("workspace");
});

// A pull read a scope change that then went back before the pull ended, so the relay state read as when it began.
// Proves: a notice that lands during a pull pulls once more on the next pass, whatever the relay state reads then.
it("pulls once more for a scope change during a pull that went back before the pull ended", async () => {
  const h = await readyHostedHost(["workspace"]);
  const host = await startServiceLiveHost(h.f);
  cleanup.push(() => host.close());
  await vi.waitFor(() => h.caughtUp("workspace"));
  await h.passes(2);
  const enabled = (value: 0 | 1) => {
    h.raw.prepare("UPDATE sync_relay_service_host_enrollments SET enabled=? WHERE workspace_id='workspace'").run(value);
    notifyRelayWrite(h.f.storage);
  };
  const reading = h.holdPull("workspace", "read"), replying = h.holdPull("workspace", "reply");
  h.append("workspace");
  await reading.entered.promise;
  enabled(0);
  reading.release.resolve();
  await replying.entered.promise;
  expect(h.replicas.get("workspace")!.reading).toEqual([]);
  enabled(1);
  replying.release.resolve();
  await vi.waitFor(() => h.caughtUp("workspace"));
  await h.passes(3);
  expect(host.hostedPulls("workspace")).toEqual({total: 3, reasons: {first: 1, changed: 2}});
  h.caughtUp("workspace");
});

// Proves: a write to one workspace pulls only that workspace, and writes to two in the same tick pull each once.
it("pulls only the workspace a write reached, and each of two written in one tick", async () => {
  const h = await readyHostedHost(["workspace-a", "workspace-b"]);
  const host = await startServiceLiveHost(h.f);
  cleanup.push(() => host.close());
  await vi.waitFor(() => {expect(h.pulls("workspace-a")).toBeGreaterThanOrEqual(1); expect(h.pulls("workspace-b")).toBeGreaterThanOrEqual(1);});
  await h.passes(2);
  h.append("workspace-a");
  await vi.waitFor(() => h.caughtUp("workspace-a"));
  await h.passes(3);
  expect(h.pulls("workspace-a")).toBe(2);
  expect(h.pulls("workspace-b")).toBe(1);
  h.append("workspace-a"); h.append("workspace-b");
  await vi.waitFor(() => {h.caughtUp("workspace-a"); h.caughtUp("workspace-b");});
  await h.passes(3);
  expect(h.pulls("workspace-a")).toBe(3);
  expect(h.pulls("workspace-b")).toBe(2);
  expect(host.hostedPulls("workspace-b")).toEqual({total: 2, reasons: {first: 1, changed: 1}});
});

// Proves: rows the host's own pushes write to the relay pull at most once each, and the workspace then goes quiet.
it("goes quiet after the host's own pushes write to the relay", async () => {
  const h = await readyHostedHost(["workspace"]);
  h.pushWrites.set("workspace", 3);
  const host = await startServiceLiveHost(h.f);
  cleanup.push(() => host.close());
  await vi.waitFor(() => expect(h.pushWrites.get("workspace")).toBe(0));
  await vi.waitFor(() => h.caughtUp("workspace"));
  const settled = h.pulls("workspace");
  expect(settled).toBeLessThanOrEqual(4);
  await h.passes(20);
  expect(h.pulls("workspace")).toBe(settled);
  expect(h.relayRows("workspace")).toHaveLength(3);
  h.caughtUp("workspace");
});

// Proves: a relay change that sent no notice, as a write on another connection, reaches a quiet workspace
// once the 30 s recovery probe is due, and not before.
it("catches a relay change that sent no notice at the 30 s recovery probe", async () => {
  const h = await readyHostedHost(["workspace"]);
  let clock = 1_000_000;
  const host = await startServiceLiveHost({...h.f, nowMs: () => clock});
  cleanup.push(() => host.close());
  await vi.waitFor(() => expect(h.pulls("workspace")).toBe(1));
  await h.passes(2);
  h.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','device',0,'workspace.init','{}',1)").run();
  clock += 29_999;
  await h.passes(5);
  expect(h.pulls("workspace")).toBe(1);
  expect(h.replicas.get("workspace")!.applied).toEqual([]);
  clock += 1;
  await vi.waitFor(() => {expect(h.relayRows("workspace")).toHaveLength(1); h.caughtUp("workspace");});
  await h.passes(5);
  expect(host.hostedPulls("workspace")).toEqual({total: 2, reasons: {first: 1, probe: 1}});
});

// Proves: a failed pull keeps its workspace pulling every pass, with no further relay change, until one succeeds.
it("keeps pulling a ready workspace after a failed pull until one succeeds", async () => {
  const h = await readyHostedHost(["workspace"]);
  const host = await startServiceLiveHost(h.f);
  cleanup.push(() => host.close());
  vi.spyOn(console, "error").mockImplementation(() => {});
  await vi.waitFor(() => expect(h.pulls("workspace")).toBe(1));
  await h.passes(2);
  h.failures.pulls = 2;
  h.append("workspace");
  await vi.waitFor(() => {expect(h.relayRows("workspace")).toHaveLength(1); h.caughtUp("workspace");});
  await h.passes(3);
  expect(host.hostedPulls("workspace")).toEqual({total: 4, reasons: {first: 1, changed: 1, pending: 2}});
});

// Proves: while the relay holds no hosted scope for a ready workspace, it pulls every pass as before, since no
// relay reading says when the feed answers again; once enrolled, it pulls once more and goes quiet.
it("keeps pulling a ready workspace every pass while the relay holds no hosted scope for it", async () => {
  const h = await readyHostedHost(["workspace"], {unscoped: true});
  const host = await startServiceLiveHost(h.f);
  cleanup.push(() => host.close());
  await vi.waitFor(() => expect(h.pulls("workspace")).toBeGreaterThanOrEqual(1));
  const before = h.pulls("workspace");
  await h.passes(5);
  expect(h.pulls("workspace")).toBeGreaterThanOrEqual(before + 4);
  expect(host.hostedPulls("workspace").reasons).toMatchObject({first: 1, unscoped: expect.any(Number)});
  // Written on another connection, so no notice: the next pass's pull reads the new scope.
  h.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('share','workspace','person','{\"paths\":[\"docs\"],\"versionId\":null}',0)").run();
  h.raw.prepare(`INSERT INTO sync_relay_service_host_enrollments(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,enabled,
    created_at_ms,updated_at_ms,accounted_bytes) VALUES ('workspace','object','docs/note.md','person','share','epoch','stream',1,0,0,1)`).run();
  expect(h.f.storage.readServiceHostFeedScope("workspace")?.hosted.size).toBe(1);
  await h.passes(3);
  const enrolled = h.pulls("workspace");
  await h.passes(20);
  expect(h.pulls("workspace")).toBe(enrolled);
  h.caughtUp("workspace");
});
