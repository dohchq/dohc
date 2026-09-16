import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { EngineClient, FrameDecoder, FrameType, encodeFrame, type EngineClientConnection } from "@dohc/workspace-engine-client/daemon";
import type { Envelope, JsonValue } from "../../../packages/workspace-engine-client/src/protocol";
import { createLiveTickets } from "./liveTickets.js";
import { audience, binding, fixture, host, key, report, scope } from "./liveTickets.test-helper.js";
import { liveBrowserActor } from "./liveBrowserContext.js";
import { captureNamedLiveFrameHost, captureOwnerLiveFrameHost, createNamedFrameChanges } from "./namedLiveFrameHost.js";
import type { LiveUpdateJournalCut, LiveUpdateJournalCommitInput } from "./storage/types.js";
import { observeRelayWrites } from "./relayWriteChanges.js";
import { queueLiveHostRequests } from "./liveHostRequests.js";
import { createLiveMembershipRegistry } from "./liveMembership.js";
import type { StorageContext } from "./storage/context.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {promise: new Promise<T>(done => {resolve = done;}), resolve: (value: T) => resolve(value)};
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const wireLimits = { maxFrameBytes: 1024 * 1024, maxBlobChunkBytes: 65536, maxStringBytes: 65536,
  maxCollectionLen: 1024, maxBatchLen: 64, maxJsonDepth: 32 };
class Peer implements EngineClientConnection {
  readonly events = new EventEmitter();
  readonly decoder = new FrameDecoder(wireLimits.maxFrameBytes);
  readonly requests: Extract<Envelope, { type: "request" }>[] = [];
  response?: (request: Extract<Envelope, { type: "request" }>) => void;
  pendingSync?: Extract<Envelope, { type: "request" }>;
  closed = false;
  write(bytes: Buffer) {
    for (const frame of this.decoder.push(bytes)) {
      if (frame.kind === "blobChunk") { this.events.emit("chunk", frame); if (frame.fin && this.pendingSync) this.response?.(this.pendingSync); continue; }
      const value = JSON.parse(frame.payload.toString()) as Envelope;
      if (value.type === "request") {
        this.requests.push(value);
        if (value.method === "liveApplication.syncOpen") this.pendingSync = value;
        else this.response?.(value);
      }
    }
    return true;
  }
  send(value: Envelope) { this.events.emit("data", encodeFrame(1, 0, Buffer.from(JSON.stringify(value)), wireLimits.maxFrameBytes)); }
  blob(id: number, result: Record<string, JsonValue>, bytes = Buffer.from([0, 0])) {
    const digest = hash(bytes);
    this.send({ type: "blobStart", requestId: id, streamId: id, totalBytes: bytes.length, sha256: digest });
    this.events.emit("data", encodeFrame(FrameType.BlobChunk, 1, { streamId: id, bytes }, wireLimits.maxBlobChunkBytes));
    this.send({ type: "response", id, result: { ...result, streamId: id, byteLength: bytes.length, digest } });
  }
  onData(fn: (bytes: Buffer | Uint8Array) => void) { this.events.on("data", fn); }
  offData(fn: (bytes: Buffer | Uint8Array) => void) { this.events.off("data", fn); }
  onClose(fn: () => void) { this.events.on("close", fn); }
  offClose(fn: () => void) { this.events.off("close", fn); }
  onError(fn: (error: unknown) => void) { this.events.on("fault", fn); }
  offError(fn: (error: unknown) => void) { this.events.off("fault", fn); }
  onDrain(fn: () => void) { this.events.on("drain", fn); }
  offDrain(fn: () => void) { this.events.off("drain", fn); }
  close() { this.closed = true; }
}
const position = { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) };
const bytes = Uint8Array.of(0, 0);
const ack = { deliveryId: "delivery", updateDigest: hash(bytes), journalCursor: 11, acceptingHostEpoch: host.hostEpoch,
  localYDocSequence: 3, applicationReplayed: true };
async function setup(maxListeners = 4) {
  const state = await fixture(); cleanup.push(() => state.close());
  const tickets = createLiveTickets({ storage: state.storage, audience, key, hostReports: { currentBinding: async () => report } });
  const minted = await tickets.mint({ objectId: binding.objectId }, scope);
  const ticket = (await tickets.redeem(minted!.token, scope))!;
  const peer = new Peer();
  let client = new EngineClient(peer, { authToken: "test-parent-secret", protocolVersion: 2, capabilities: ["core", "blobs"],
    connectTimeoutMs: 5000, privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 2 } });
  peer.send({ type: "helloAck", protocolVersion: 2, sessionGeneration: 7, capabilities: ["core", "blobs"], limits: wireLimits });
  await client.ready(); cleanup.push(async () => { client.close(); });
  const changes = createNamedFrameChanges(maxListeners), invalidated = new AbortController();
  client = queueLiveHostRequests(client, {maxPendingReads: maxListeners, maxPendingWrites: maxListeners, deadlineMs: 5000,
    maxRetainedInputBytes: 128 * 1024 * 1024,
    signal: invalidated.signal, retire: () => invalidated.abort()});
  let requestId = 0;
  const drain = vi.fn(async () => {});
  const nativeBinding = { ...binding, selectorPaths: [binding.currentPath] };
  peer.response = request => {
    if (request.method === "liveApplication.syncOpen") peer.blob(request.id, { status: "sync", binding: nativeBinding, position,
      observedLocalYDocHeadSequence: 99, hostVectorByteLength: 1 }, Buffer.from([0, 0, 0]));
    else if (request.method === "liveApplication.appliedRead") peer.send({ type: "response", id: request.id,
      result: { status: "empty", after: (request.params as { after: JsonValue }).after } });
    else if (request.method === "liveApplication.ack") peer.send({ type: "response", id: request.id, result: { status: "applied", ack } });
  };
  const validate = vi.fn(() => ({ kind: "refused" as const, reason: "invalid-update" as const, source: "candidate" as const }));
  const native = { client, workspace: "trusted-native-handle", registrationId: 7, coordinate: host, binding: nativeBinding,
    invalidated: invalidated.signal, changes, deadlineMs: 5000, nextRequestId: () => ++requestId, drain };
  const bounds = { maxClientVectorBytes: 32, maxSyncOutputBytes: 1024, maxAppliedUpdateBytes: 1024, maxSubmissionBytes: 1024, maxAdmissionBytes: 4096 };
  const capture = captureNamedLiveFrameHost({ ticket, actor: liveBrowserActor(scope), storage: state.storage, validate, native, bounds });
  cleanup.push(async () => { capture.close(); });
  return { ...state, peer, client, changes, invalidated, drain, capture, validate, native, bounds };
}
it.each(["maxSyncOutputBytes", "maxAppliedUpdateBytes"])("rejects %s below the native output minimum", async field => {
  const f = await setup();
  expect(() => captureNamedLiveFrameHost({ticket: f.capture.ticket, actor: liveBrowserActor(scope), storage: f.storage,
    validate: f.validate, native: f.native, bounds: {...f.bounds, [field]: 1}})).toThrow("Invalid named native frame bound");
  expect(f.peer.requests).toHaveLength(0);
});
it("uses the native atomic cut, excluding the diagnostic local head, and leaves the shared client running", async () => {
  const f = await setup();
  const sync = await f.capture.openSync(Uint8Array.of(0), new AbortController().signal);
  expect(sync.appliedThroughJournalCursor).toBe(0);
  expect([...sync.missingStateUpdate]).toEqual([0, 0]);
  expect(f.peer.requests[0]).toMatchObject({ method: "liveApplication.syncOpen", workspace: "trusted-native-handle", params: { registrationId: 7 } });
  f.capture.close(); sync.close();
  expect(f.changes.listenerCount()).toBe(0); expect(f.peer.closed).toBe(false);
});
it("reads every member's current authority in one read transaction without taking a writer lock", async () => {
  const f = await setup(16);
  const tickets = createLiveTickets({storage: f.storage, audience, key, hostReports: {currentBinding: async () => report}});
  const minted = await tickets.mint({objectId: binding.objectId}, scope), ticket = await tickets.redeem(minted!.token, scope);
  const other = captureNamedLiveFrameHost({ticket: ticket!, actor: liveBrowserActor(scope), storage: f.storage,
    native: f.native, bounds: f.bounds, validate: f.validate});
  const registry = createLiveMembershipRegistry({maxSessions: 4, maxMembers: 4, maxSnapshotBytes: 89}, f.storage.readLiveAuthority.bind(f.storage));
  const members = [f.capture, other].map(host => registry.join({ticket: host.ticket, invalidated: host.invalidated, assertCurrent: host.assertCurrent}));
  cleanup.push(async () => {members.forEach(member => member.close()); other.close();});
  const exec = vi.spyOn((f.storage as StorageContext).db, "exec");
  expect(members[0].snapshot(1024).members).toHaveLength(2);
  expect(exec.mock.calls.filter(([sql]) => sql === "BEGIN IMMEDIATE")).toHaveLength(0);
  expect(exec.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(1);
});
it("closes failed authority read scopes and refuses asynchronous callbacks and results", async () => {
  const f = await setup(), exec = vi.spyOn((f.storage as StorageContext).db, "exec");
  let asyncRan = false;
  expect(() => f.storage.readLiveAuthority(async () => {asyncRan = true;})).toThrow("must be synchronous");
  expect(asyncRan).toBe(false);
  expect(exec).not.toHaveBeenCalled();
  expect(() => f.storage.readLiveAuthority(() => Promise.resolve(null))).toThrow("must be synchronous");
  expect(() => f.storage.readLiveAuthority(() => ({then() {}}))).toThrow("must be synchronous");
  expect(() => f.storage.readLiveAuthority(() => f.storage.readLiveAuthority(() => {throw new Error("failed check");}))).toThrow("failed check");
  expect(exec.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(3);
  exec.mockClear();
  f.capture.assertCurrent();
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
});
it("keeps three readers alive when a relay write wakes them during a native upload", async () => {
  const f = await setup(16), caller = new AbortController();
  const captures = [f.capture, ...[1, 2].map(() => captureNamedLiveFrameHost({
    actor: liveBrowserActor(scope), ticket: f.capture.ticket, storage: f.storage, native: f.native, bounds: f.bounds, validate: f.validate,
  }))];
  cleanup.push(async () => {caller.abort(); for (const capture of captures) capture.close();});
  const syncs = [];
  for (const capture of captures) syncs.push(await capture.openSync(Uint8Array.of(0), caller.signal));
  const read = f.peer.response!;
  let firstRead = deferred<void>();
  f.peer.response = request => {read(request); firstRead.resolve();};
  const pending = [];
  for (const sync of syncs) {
    firstRead = deferred<void>();
    pending.push(sync.nextApplied(caller.signal));
    await firstRead.promise;
  }
  const outcomes = Promise.allSettled(pending);
  const uploading = deferred<number>();
  const uploaded = deferred<void>();
  let rangeStreamId = 0;
  f.peer.events.on("chunk", (frame: {streamId: number; fin: boolean}) => {if (frame.fin && frame.streamId === rangeStreamId) uploaded.resolve();});
  f.peer.response = request => {
    if (request.method === "liveApplication.apply") {rangeStreamId = (request.params as {rangeStreamId: number}).rangeStreamId; uploading.resolve(request.id);}
    else if (request.method === "liveApplication.appliedRead") f.peer.blob(request.id,
      {status: "update", position: {eventCount: 1, journalCursor: 11, evidenceDigest: "cd".repeat(32)}, ack});
  };
  const upload = f.client.sendLiveApplication({id: f.native.nextRequestId(), workspace: f.native.workspace,
    registrationId: f.native.registrationId, deadlineMs: 5000}, {
    metadata: {accepted: {binding: f.native.binding, authority: {principalKind: "owner", principalId: "owner-1", grantId: null, grantGeneration: null},
      receipt: {deliveryId: ack.deliveryId, updateDigest: ack.updateDigest, journalCursor: 11, acceptingHostEpoch: host.hostEpoch}, receivedAtMs: 1}, firstSeen: []}, updateBytes: bytes,
  });
  const wireId = await uploading.promise;
  await uploaded.promise;
  const remove = observeRelayWrites(f.storage, () => f.changes.notify());
  const authorityWake = deferred<void>(), removeAuthority = f.changes.subscribe(() => authorityWake.resolve());
  try {
    f.storage.claimWorkspace({workspaceId: "unrelated-workspace", ownerUserId: "unrelated-owner", createdAtMs: 1});
    await authorityWake.promise;
    expect(f.peer.requests.filter(row => row.method === "liveApplication.appliedRead")).toHaveLength(3);
    f.peer.send({type: "response", id: wireId, result: {status: "applied", ack}}); await upload;
    f.changes.notify(binding);
    const result = await outcomes;
    expect(result.map(row => row.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    for (const row of result) if (row.status === "fulfilled") row.value.release();
    expect(captures.every(capture => !capture.invalidated.aborted)).toBe(true);
    expect(f.peer.closed).toBe(false);
  } finally {
    remove(); removeAuthority();
  }
});
it("keeps two named selectors distinct while borrowing one native registration", async () => {
  const f = await setup();
  const secondScope = { ...scope, shareId: "share-2", grantId: "edit-2", userId: "reader-2" };
  const secondBinding = { ...binding, selectorPaths: [binding.currentPath] };
  f.raw.prepare("INSERT INTO sync_relay_shares (share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)")
    .run(secondScope.shareId, scope.workspaceId, JSON.stringify({ paths: secondBinding.selectorPaths, versionId: null }));
  f.raw.prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES (?,?,'user',?,NULL,'edit',4,'active',0,NULL,NULL)`).run(secondScope.grantId, secondScope.shareId, secondScope.userId);
  const tickets = createLiveTickets({ storage: f.storage, audience, key, hostReports: { currentBinding: async () => ({ connection: host, binding: secondBinding }) } });
  const minted = await tickets.mint({ objectId: binding.objectId }, secondScope);
  const ticket = (await tickets.redeem(minted!.token, secondScope))!;
  const second = captureNamedLiveFrameHost({ ticket, actor: liveBrowserActor(secondScope), storage: f.storage, native: f.native, bounds: f.bounds, validate: f.validate });
  cleanup.push(async () => { second.close(); });
  const signal = new AbortController().signal;
  const firstSync = await f.capture.openSync(Uint8Array.of(0), signal);
  const secondSync = await second.openSync(Uint8Array.of(0), signal);
  expect(firstSync.binding.selectorPaths).toEqual(["docs"]);
  expect(secondSync.binding.selectorPaths).toEqual(["docs/a.md"]);
  expect(firstSync.missingStateUpdate).toEqual(secondSync.missingStateUpdate);
  expect(f.peer.requests.map(request => (request.params as { registrationId: number }).registrationId)).toEqual([7, 7]);
  firstSync.close(); secondSync.close(); f.capture.close();
  expect(f.peer.closed).toBe(false); second.assertCurrent();
});
it("rejects a captured native registration for a different document fence", async () => {
  const f = await setup();
  expect(() => captureNamedLiveFrameHost({ actor: liveBrowserActor(scope), ticket: f.capture.ticket, storage: f.storage, validate: f.validate, bounds: f.bounds,
    native: { ...f.native, binding: { ...f.native.binding, restoreFenceGeneration: binding.restoreFenceGeneration + 1 } } }))
    .toThrow(/registration binding changed/);
});
it("arms a coalesced wake before an empty native read and retains one output lease", async () => {
  const f = await setup();
  const sync = await f.capture.openSync(Uint8Array.of(0), new AbortController().signal);
  let reads = 0;
  f.peer.response = request => {
    expect(request.method).toBe("liveApplication.appliedRead");
    if (++reads === 1) {
      expect(f.changes.listenerCount()).toBe(2);
      f.changes.notify(binding); f.changes.notify(binding);
      f.peer.send({ type: "response", id: request.id, result: { status: "empty", after: position } });
    } else f.peer.blob(request.id, { status: "update", position: { eventCount: 1, journalCursor: 11, evidenceDigest: "cd".repeat(32) }, ack });
  };
  const lease = await sync.nextApplied(new AbortController().signal);
  expect(reads).toBe(2); expect(lease.value.journalCursor).toBe(11);
  await expect(sync.nextApplied(new AbortController().signal)).rejects.toThrow(/already owns/);
  expect(reads).toBe(2); lease.release(); lease.release();
});
it("aborts an empty-feed wait without polling or leaving listeners", async () => {
  const f = await setup();
  const sync = await f.capture.openSync(Uint8Array.of(0), new AbortController().signal);
  let read!: () => void; const reading = new Promise<void>(resolve => { read = resolve; });
  const response = f.peer.response!;
  f.peer.response = request => { response(request); read(); };
  const abort = new AbortController();
  const next = sync.nextApplied(abort.signal); await reading; abort.abort();
  await expect(next).rejects.toThrow();
  expect(f.peer.requests.filter(row => row.method === "liveApplication.appliedRead")).toHaveLength(1);
  expect(f.changes.listenerCount()).toBe(1);
});
it("rejects another pull while the first waits for a shared wake", async () => {
  const f = await setup(); const signal = new AbortController();
  const sync = await f.capture.openSync(Uint8Array.of(0), signal.signal);
  const pending = sync.nextApplied(signal.signal);
  await expect(sync.nextApplied(signal.signal)).rejects.toThrow(/already owns/);
  signal.abort(); await expect(pending).rejects.toThrow();
});
it("freezes the captured ticket and its binding before exposing them", async () => {
  const f = await setup();
  expect(() => { (f.capture.ticket.binding.selectorPaths as string[])[0] = "other.md"; }).toThrow();
  expect(Object.isFrozen(f.capture.ticket.authority)).toBe(true);
  expect(Object.isFrozen(f.capture.ticket.binding)).toBe(true);
  expect(Object.isFrozen(f.capture.ticket)).toBe(true);
  f.capture.assertCurrent();
});
it.each(["grant", "selector", "restore", "host"])("invalidates the capture when %s standing changes", async mode => {
  const f = await setup();
  if (mode === "grant") f.raw.prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE grant_id=?").run(scope.grantId);
  if (mode === "selector") f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?").run(JSON.stringify({ paths: ["other"], versionId: null }), scope.shareId);
  if (mode === "restore") f.raw.prepare("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1").run();
  if (mode === "host") f.invalidated.abort(); else f.changes.notify();
  await Promise.resolve();
  expect(f.capture.invalidated.aborted).toBe(true);
  expect(f.peer.closed).toBe(false); expect(f.changes.listenerCount()).toBe(0);
});

function journal(f: Awaited<ReturnType<typeof setup>>) {
  const document = { workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId };
  const cut: LiveUpdateJournalCut = { document, currentPath: binding.currentPath, restoreFenceGeneration: binding.restoreFenceGeneration,
    authorityHistory: [], baseline: { sequence: 1, digest: binding.lineageClaimId, bytes, ranges: [], projectedDigest: "b".repeat(64),
      projectedLength: 1, registeredAtMs: 1, replacesLineageClaimId: null },
    checkpoint: { cursor: null, digest: binding.lineageClaimId, bytes, metadata: null, updateBytes: null }, suffix: [],
    highWater: null, suffixCount: 0, suffixBytes: 0 };
  vi.spyOn(f.storage, "readLiveUpdateJournalCut").mockReturnValue({ kind: "cut", cut });
  return vi.spyOn(f.storage, "commitLiveUpdateJournal").mockImplementation((input: LiveUpdateJournalCommitInput) => {
    const receipt = { deliveryId: input.metadata.deliveryId, updateDigest: input.metadata.updateDigest, journalCursor: 11, acceptingHostEpoch: host.hostEpoch };
    return { result: { kind: "accepted", receipt, replayed: false }, admitted: { updateBytes: input.updateBytes,
      metadata: { accepted: { binding, receipt, authority: input.expectedAuthority, receivedAtMs: input.receivedAtMs }, firstSeen: [] } } };
  });
}

function ownerCapture(f: Awaited<ReturnType<typeof setup>>, authenticatedUserId = "owner-1") {
  const capture = captureOwnerLiveFrameHost({authenticatedUserId, shareId: scope.shareId,
    storage: f.storage, native: f.native, bounds: f.bounds, validate: f.validate});
  cleanup.push(async () => {capture.close();});
  return capture;
}

it("opens the owner on the same native feed without a recipient ticket or grant", async () => {
  const f = await setup();
  f.raw.prepare("DELETE FROM sync_relay_share_grants").run();
  f.raw.prepare("DELETE FROM sync_relay_live_session_tickets").run();
  const capture = ownerCapture(f);
  expect(capture.hostEpoch).toBe(host.hostEpoch);
  expect(capture).not.toHaveProperty("ticket");
  const sync = await capture.openSync(Uint8Array.of(0), new AbortController().signal);
  expect(sync.binding).toEqual(binding);
  expect([...sync.missingStateUpdate]).toEqual([0, 0]);
  expect(f.raw.prepare("SELECT count(*) AS count FROM sync_relay_live_session_tickets").get()).toEqual({count: 0});
  sync.close(); capture.close();
  expect(f.peer.closed).toBe(false);
});

it("refuses a recipient account on the owner path", async () => {
  const f = await setup();
  expect(() => ownerCapture(f, scope.userId)).toThrow("Owner live authority is unavailable");
  expect(f.peer.requests).toEqual([]);
});

it.each(["applied", "missing", "ambiguous"])("requires exact native evidence for owner delivery: %s", async mode => {
  const f = await setup(), capture = ownerCapture(f), commit = journal(f);
  if (mode === "ambiguous") f.drain.mockRejectedValueOnce(new Error("Lost response"));
  if (mode === "missing") f.peer.response = request => f.peer.send({type: "response", id: request.id, result: {status: "missing"}});
  expect(await capture.submit({deliveryId: ack.deliveryId, updateDigest: hash(bytes), updateBytes: bytes}, new AbortController().signal))
    .toEqual(mode === "missing" ? {result: "retry", reason: "application-pending"} : {result: "success", ack});
  expect(commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    actor: {kind: "owner", userId: "owner-1", shareId: scope.shareId},
    expectedAuthority: {principalKind: "owner", principalId: "owner-1", grantId: null, grantGeneration: null},
    metadata: {deliveryId: ack.deliveryId, updateDigest: hash(bytes), binding}, updateBytes: bytes,
  }));
});

it.each(["owner", "selector", "restore"])("invalidates owner capture when %s changes", async kind => {
  const f = await setup(), capture = ownerCapture(f);
  if (kind === "owner") f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='different-owner'").run();
  if (kind === "selector") f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?")
    .run(JSON.stringify({paths: ["other"], versionId: null}), scope.shareId);
  if (kind === "restore") f.raw.prepare("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1").run();
  f.changes.notify(); await Promise.resolve();
  expect(capture.invalidated.aborted).toBe(true);
  await expect(capture.submit({deliveryId: ack.deliveryId, updateDigest: hash(bytes), updateBytes: bytes}, new AbortController().signal)).rejects.toThrow();
  expect(f.peer.requests).toEqual([]);
});

it("does not report an owner ACK after restore changes during application", async () => {
  const f = await setup(), capture = ownerCapture(f); journal(f);
  f.drain.mockImplementationOnce(async () => {
    f.raw.prepare("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1").run();
  });
  await expect(capture.submit({deliveryId: ack.deliveryId, updateDigest: hash(bytes), updateBytes: bytes}, new AbortController().signal))
    .rejects.toThrow("standing changed");
  expect(f.peer.requests).toEqual([]);
});

it.each(["applied", "missing", "ambiguous", "receipt-only"])("uses exact durable ACK evidence for %s delivery", async mode => {
  const f = await setup(); const commit = journal(f);
  if (mode === "ambiguous") f.drain.mockRejectedValueOnce(new Error("Lost application response."));
  if (mode === "missing" || mode === "receipt-only") f.peer.response = request => f.peer.send({ type: "response", id: request.id,
    result: mode === "missing" ? { status: "missing" } : { status: "applied", ack: { deliveryId: ack.deliveryId,
      updateDigest: ack.updateDigest, journalCursor: ack.journalCursor, acceptingHostEpoch: ack.acceptingHostEpoch } } });
  const submitted = f.capture.submit({ deliveryId: ack.deliveryId, updateDigest: hash(bytes), updateBytes: bytes }, new AbortController().signal);
  if (mode === "receipt-only") await expect(submitted).rejects.toThrow();
  else expect(await submitted).toEqual(mode === "missing" ? { result: "retry", reason: "application-pending" } : { result: "success", ack });
  expect(commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actor: { kind: "named", userId: scope.userId, grantId: scope.grantId },
    metadata: { deliveryId: ack.deliveryId, updateDigest: hash(bytes), binding }, updateBytes: bytes }));
});
it("rejects a parsed native ACK for a different accepted journal cursor", async () => {
  const f = await setup(); journal(f);
  f.peer.response = request => f.peer.send({ type: "response", id: request.id, result: { status: "applied", ack: { ...ack, journalCursor: 12 } } });
  await expect(f.capture.submit({ deliveryId: ack.deliveryId, updateDigest: hash(bytes), updateBytes: bytes }, new AbortController().signal))
    .rejects.toThrow(/ACK identity changed/);
});

it("coalesces shared wakes and preserves listener bounds and independent delivery", async () => {
  const changes = createNamedFrameChanges(2), called = vi.fn();
  const remove = changes.subscribe(() => { throw new Error("Subscriber failed."); });
  changes.subscribe(called);
  expect(() => changes.subscribe(() => {})).toThrow(/capacity/);
  changes.notify(); changes.notify(); expect(called).not.toHaveBeenCalled();
  await Promise.resolve(); expect(called).toHaveBeenCalledTimes(1);
  changes.notify(); remove(); await Promise.resolve(); expect(called).toHaveBeenCalledTimes(2);
  expect(changes.listenerCount()).toBe(1);
});

it("checks authority globally while waking native readers only for their document", async () => {
  const changes = createNamedFrameChanges(3), authority = vi.fn(), first = vi.fn(), second = vi.fn();
  changes.subscribe(authority); changes.subscribe(first, binding); changes.subscribe(second, {...binding, workspaceId: "other-workspace"});
  changes.notify(); await new Promise<void>(queueMicrotask);
  expect(authority).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  changes.notify(binding); changes.notify(binding); await new Promise<void>(queueMicrotask);
  expect(authority).toHaveBeenCalledTimes(2); expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  changes.notify({...binding, workspaceId: "other-workspace"}); await new Promise<void>(queueMicrotask);
  expect(authority).toHaveBeenCalledTimes(3); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
});

it("rechecks revocation after asynchronous validation and never commits its stale result", async () => {
  const f = await setup(), commit = journal(f), waiting = deferred<void>();
  const capture = captureNamedLiveFrameHost({ticket: f.capture.ticket, actor: liveBrowserActor(scope), storage: f.storage,
    native: f.native, bounds: f.bounds, validate: async () => {await waiting.promise; return {kind: "refused", reason: "invalid-update", source: "candidate"};}});
  cleanup.push(async () => capture.close());
  const submitting = capture.submit({deliveryId: "delivery", updateDigest: hash(bytes), updateBytes: bytes}, new AbortController().signal);
  f.raw.prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE grant_id=?").run(scope.grantId);
  waiting.resolve(); await expect(submitting).rejects.toThrow("standing changed");
  expect(commit).not.toHaveBeenCalled();
});
