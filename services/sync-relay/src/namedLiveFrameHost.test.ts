import {
  createLiveBufferBudget,
  LiveConnectionLimitError,
} from "@dohc/live-session-contract/live-connection";
import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  EngineClient,
  FrameDecoder,
  FrameType,
  encodeFrame,
  type EngineClientConnection,
} from "@dohc/workspace-engine-client/daemon";
import type { Envelope, JsonValue } from "../../../packages/workspace-engine-client/src/protocol";
import { createLiveTickets } from "./liveTickets.js";
import { audience, binding, fixture, host, key, report, scope } from "./liveTickets.test-helper.js";
import { liveBrowserActor } from "./liveBrowserContext.js";
import {
  captureNamedLiveFrameHost,
  captureOwnerLiveFrameHost,
  createNamedFrameChanges,
} from "./namedLiveFrameHost.js";
import type { LiveUpdateJournalCut, LiveUpdateJournalCommitInput } from "./storage/types.js";

import { queueLiveHostRequests } from "./liveHostRequests.js";

import type { CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const wireLimits = {
  maxFrameBytes: 1024 * 1024,
  maxBlobChunkBytes: 65536,
  maxStringBytes: 65536,
  maxCollectionLen: 1024,
  maxBatchLen: 64,
  maxJsonDepth: 32,
};
class Peer implements EngineClientConnection {
  readonly events = new EventEmitter();
  readonly decoder = new FrameDecoder(wireLimits.maxFrameBytes);
  readonly requests: Extract<Envelope, { type: "request" }>[] = [];
  response?: (request: Extract<Envelope, { type: "request" }>) => void;
  pendingSync?: Extract<Envelope, { type: "request" }>;
  closed = false;
  write(bytes: Buffer) {
    for (const frame of this.decoder.push(bytes)) {
      if (frame.kind === "blobChunk") {
        this.events.emit("chunk", frame);
        if (frame.fin && this.pendingSync) this.response?.(this.pendingSync);
        continue;
      }
      const value = JSON.parse(frame.payload.toString()) as Envelope;
      if (value.type === "request") {
        this.requests.push(value);
        if (value.method === "liveApplication.syncOpen") this.pendingSync = value;
        else this.response?.(value);
      }
    }
    return true;
  }
  send(value: Envelope) {
    this.events.emit(
      "data",
      encodeFrame(1, 0, Buffer.from(JSON.stringify(value)), wireLimits.maxFrameBytes),
    );
  }
  blob(id: number, result: Record<string, JsonValue>, bytes = Buffer.from([0, 0])) {
    const digest = hash(bytes);
    this.send({
      type: "blobStart",
      requestId: id,
      streamId: id,
      totalBytes: bytes.length,
      sha256: digest,
    });
    this.events.emit(
      "data",
      encodeFrame(FrameType.BlobChunk, 1, { streamId: id, bytes }, wireLimits.maxBlobChunkBytes),
    );
    this.send({
      type: "response",
      id,
      result: { ...result, streamId: id, byteLength: bytes.length, digest },
    });
  }
  onData(fn: (bytes: Buffer | Uint8Array) => void) {
    this.events.on("data", fn);
  }
  offData(fn: (bytes: Buffer | Uint8Array) => void) {
    this.events.off("data", fn);
  }
  onClose(fn: () => void) {
    this.events.on("close", fn);
  }
  offClose(fn: () => void) {
    this.events.off("close", fn);
  }
  onError(fn: (error: unknown) => void) {
    this.events.on("fault", fn);
  }
  offError(fn: (error: unknown) => void) {
    this.events.off("fault", fn);
  }
  onDrain(fn: () => void) {
    this.events.on("drain", fn);
  }
  offDrain(fn: () => void) {
    this.events.off("drain", fn);
  }
  close() {
    this.closed = true;
  }
}
const position = { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) };
const bytes = Uint8Array.of(0, 0);
const ack = {
  deliveryId: "delivery",
  updateDigest: hash(bytes),
  journalCursor: 11,
  acceptingHostEpoch: host.hostEpoch,
  localYDocSequence: 3,
  applicationReplayed: true,
};
async function setup(maxListeners = 4, reserveBytes?: (size: number) => () => void) {
  const state = await fixture();
  cleanup.push(() => state.close());
  const tickets = createLiveTickets({
    storage: state.storage,
    audience,
    key,
    hostReports: { currentBinding: async () => report },
  });
  const minted = await tickets.mint({ objectId: binding.objectId }, scope);
  const ticket = (await tickets.redeem(minted!.token, scope))!;
  const peer = new Peer();
  let client = new EngineClient(peer, {
    authToken: "test-parent-secret",
    protocolVersion: 2,
    capabilities: ["core", "blobs"],
    connectTimeoutMs: 5000,
    privateLiveApplication: { aggregateBytes: 128 * 1024 * 1024, maxUploads: 2 },
  });
  peer.send({
    type: "helloAck",
    protocolVersion: 2,
    sessionGeneration: 7,
    capabilities: ["core", "blobs"],
    limits: wireLimits,
  });
  await client.ready();
  cleanup.push(async () => {
    client.close();
  });
  const changes = createNamedFrameChanges(maxListeners),
    invalidated = new AbortController();
  client = queueLiveHostRequests(client, {
    maxPendingReads: maxListeners,
    maxPendingWrites: maxListeners,
    deadlineMs: 5000,
    maxRetainedInputBytes: 128 * 1024 * 1024,
    signal: invalidated.signal,
    retire: () => invalidated.abort(),
  });
  let requestId = 0;
  const drain = vi.fn(async () => {});
  const nativeBinding = { ...binding, selectorPaths: [binding.currentPath] };
  peer.response = (request) => {
    if (request.method === "liveApplication.syncOpen")
      peer.blob(
        request.id,
        {
          status: "sync",
          binding: nativeBinding,
          position,
          observedLocalYDocHeadSequence: 99,
          hostVectorByteLength: 1,
        },
        Buffer.from([0, 0, 0]),
      );
    else if (request.method === "liveApplication.appliedRead")
      peer.send({
        type: "response",
        id: request.id,
        result: { status: "empty", after: (request.params as { after: JsonValue }).after },
      });
    else if (request.method === "liveApplication.ack")
      peer.send({ type: "response", id: request.id, result: { status: "applied", ack } });
  };
  const validate = vi.fn(() => ({
    kind: "refused" as const,
    reason: "invalid-update" as const,
    source: "candidate" as const,
  }));
  const native = {
    client,
    workspace: "trusted-native-handle",
    registrationId: 7,
    coordinate: host,
    binding: nativeBinding,
    invalidated: invalidated.signal,
    changes,
    deadlineMs: 5000,
    nextRequestId: () => ++requestId,
    drain,
  };
  const bounds = {
    maxClientVectorBytes: 32,
    maxSyncOutputBytes: 1024,
    maxAppliedUpdateBytes: 1024,
    maxSubmissionBytes: 1024,
    maxAdmissionBytes: 4096,
  };
  const capture = captureNamedLiveFrameHost({
    ticket,
    actor: liveBrowserActor(scope),
    storage: state.storage,
    validate,
    native,
    bounds,
    reserveBytes,
    validationBudget: reserveBytes
      ? { reserve: () => () => {}, maxBytes: Number.MAX_SAFE_INTEGER, reserveBytes }
      : undefined,
  });
  cleanup.push(async () => {
    capture.close();
  });
  return { ...state, peer, client, changes, invalidated, drain, capture, validate, native, bounds };
}
it("uses the native atomic cut, excluding the diagnostic local head, and leaves the shared client running", async () => {
  const f = await setup();
  const sync = await f.capture.openSync(Uint8Array.of(0), new AbortController().signal);
  expect(sync.appliedThroughJournalCursor).toBe(0);
  expect([...sync.missingStateUpdate]).toEqual([0, 0]);
  expect(f.peer.requests[0]).toMatchObject({
    method: "liveApplication.syncOpen",
    workspace: "trusted-native-handle",
    params: { registrationId: 7 },
  });
  f.capture.close();
  sync.close();
  expect(f.changes.listenerCount()).toBe(0);
  expect(f.peer.closed).toBe(false);
});
it("shows each named recipient its own share's selector on one binding and one native registration", async () => {
  const f = await setup();
  const secondScope = { ...scope, shareId: "share-2", grantId: "edit-2", userId: "reader-2" };
  f.raw
    .prepare(
      "INSERT INTO sync_relay_shares (share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)",
    )
    .run(
      secondScope.shareId,
      scope.workspaceId,
      JSON.stringify({ paths: ["docs/a.md"], versionId: null }),
    );
  f.raw
    .prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES (?,?,'user',?,NULL,'edit',4,'active',0,NULL,NULL)`)
    .run(secondScope.grantId, secondScope.shareId, secondScope.userId);
  const tickets = createLiveTickets({
    storage: f.storage,
    audience,
    key,
    hostReports: { currentBinding: async () => report },
  });
  const minted = await tickets.mint({ objectId: binding.objectId }, secondScope);
  const ticket = (await tickets.redeem(minted!.token, secondScope))!;
  // Both recipients' accepted events carry the lineage's one recorded binding.
  expect(ticket.binding).toEqual(f.capture.ticket.binding);
  expect(ticket.binding).toEqual(binding);
  const second = captureNamedLiveFrameHost({
    ticket,
    actor: liveBrowserActor(secondScope),
    storage: f.storage,
    native: f.native,
    bounds: f.bounds,
    validate: f.validate,
  });
  cleanup.push(async () => {
    second.close();
  });
  const signal = new AbortController().signal;
  const firstSync = await f.capture.openSync(Uint8Array.of(0), signal);
  const secondSync = await second.openSync(Uint8Array.of(0), signal);
  expect(firstSync.binding.selectorPaths).toEqual(["docs"]);
  expect(secondSync.binding.selectorPaths).toEqual(["docs/a.md"]);
  expect(firstSync.missingStateUpdate).toEqual(secondSync.missingStateUpdate);
  expect(
    f.peer.requests.map((request) => (request.params as { registrationId: number }).registrationId),
  ).toEqual([7, 7]);
  firstSync.close();
  secondSync.close();
  f.capture.close();
  expect(f.peer.closed).toBe(false);
  second.assertCurrent();
});
it("arms a coalesced wake before an empty native read and retains one output lease", async () => {
  const f = await setup();
  const sync = await f.capture.openSync(Uint8Array.of(0), new AbortController().signal);
  let reads = 0;
  f.peer.response = (request) => {
    expect(request.method).toBe("liveApplication.appliedRead");
    if (++reads === 1) {
      expect(f.changes.listenerCount()).toBe(2);
      f.changes.notify(binding);
      f.changes.notify(binding);
      f.peer.send({
        type: "response",
        id: request.id,
        result: { status: "empty", after: position },
      });
    } else
      f.peer.blob(request.id, {
        status: "update",
        position: { eventCount: 1, journalCursor: 11, evidenceDigest: "cd".repeat(32) },
        ack,
      });
  };
  const lease = await sync.nextApplied(new AbortController().signal);
  expect(reads).toBe(2);
  expect(lease.value.journalCursor).toBe(11);
  await expect(sync.nextApplied(new AbortController().signal)).rejects.toThrow(/already owns/);
  expect(reads).toBe(2);
  lease.release();
  lease.release();
});

// Only the relay attributes work to a personal agent. The host refuses before it reads who records.
it.each(["account"] as const)(
  "refuses an %s recording context that names a personal agent before journal admission",
  async (kind) => {
    const f = await setup(),
      capture = ownerCapture(f),
      commit = journal(f);
    const update = (agentId: string) => {
      const agent = { agentId, agentName: "Helper", depth: 0 };
      return {
        deliveryId: ack.deliveryId,
        updateDigest: hash(bytes),
        updateBytes: bytes,
        authorContext: { kind, accountId: "owner-1", agent },
      };
    };
    expect(
      await capture.submit(update(`p-${"a".repeat(26)}`), new AbortController().signal),
    ).toEqual({ result: "refused", reason: "provenance-refused" });
    expect(commit).not.toHaveBeenCalled();
    expect(await capture.submit(update("helper"), new AbortController().signal)).toEqual({
      result: "success",
      ack,
    });
  },
);

function journal(f: Awaited<ReturnType<typeof setup>>) {
  const document = {
    workspaceId: binding.workspaceId,
    mainVersionId: binding.mainVersionId,
    objectId: binding.objectId,
    lineageClaimId: binding.lineageClaimId,
  };
  const cut: LiveUpdateJournalCut = {
    document,
    currentPath: binding.currentPath,
    restoreFenceGeneration: binding.restoreFenceGeneration,
    authorityHistory: [],
    baseline: {
      sequence: 1,
      digest: binding.lineageClaimId,
      bytes,
      ranges: [],
      projectedDigest: "b".repeat(64),
      projectedLength: 1,
      registeredAtMs: 1,
      replacesLineageClaimId: null,
    },
    checkpoint: {
      cursor: null,
      digest: binding.lineageClaimId,
      bytes,
      metadata: null,
      updateBytes: null,
    },
    suffix: [],
    highWater: null,
    suffixCount: 0,
    suffixBytes: 0,
  };
  vi.spyOn(f.storage, "readLiveUpdateJournalCut").mockReturnValue({ kind: "cut", cut });
  return vi
    .spyOn(f.storage, "commitLiveUpdateJournal")
    .mockImplementation((input: LiveUpdateJournalCommitInput) => {
      const receipt = {
        deliveryId: input.metadata.deliveryId,
        updateDigest: input.metadata.updateDigest,
        journalCursor: 11,
        acceptingHostEpoch: host.hostEpoch,
      };
      return {
        result: { kind: "accepted", receipt, replayed: false },
        admitted: {
          updateBytes: input.updateBytes,
          metadata: {
            accepted: {
              binding,
              receipt,
              authority: input.expectedAuthority,
              receivedAtMs: input.receivedAtMs,
            },
            firstSeen: [],
          },
        },
      };
    });
}

function ownerCapture(f: Awaited<ReturnType<typeof setup>>, authenticatedUserId = "owner-1") {
  const capture = captureOwnerLiveFrameHost({
    authenticatedUserId,
    storage: f.storage,
    native: f.native,
    bounds: f.bounds,
    validate: f.validate,
  });
  cleanup.push(async () => {
    capture.close();
  });
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
  expect(sync.binding).toEqual({ ...binding, selectorPaths: [binding.currentPath] });
  expect([...sync.missingStateUpdate]).toEqual([0, 0]);
  expect(
    f.raw.prepare("SELECT count(*) AS count FROM sync_relay_live_session_tickets").get(),
  ).toEqual({ count: 0 });
  sync.close();
  capture.close();
  expect(f.peer.closed).toBe(false);
});

it("refuses a recipient account on the owner path", async () => {
  const f = await setup();
  expect(() => ownerCapture(f, scope.userId)).toThrow("Owner live authority is unavailable");
  expect(f.peer.requests).toEqual([]);
});

it.each(["owner"])("invalidates owner capture when %s changes", async (kind) => {
  const f = await setup(),
    capture = ownerCapture(f);
  if (kind === "owner")
    f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='different-owner'").run();
  if (kind === "restore")
    f.raw
      .prepare(
        "UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1",
      )
      .run();
  f.changes.notify();
  await Promise.resolve();
  expect(capture.invalidated.aborted).toBe(true);
  await expect(
    capture.submit(
      { deliveryId: ack.deliveryId, updateDigest: hash(bytes), updateBytes: bytes },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.peer.requests).toEqual([]);
});

it("does not report an owner ACK after restore changes during application", async () => {
  const f = await setup(),
    capture = ownerCapture(f);
  journal(f);
  f.drain.mockImplementationOnce(async () => {
    f.raw
      .prepare(
        "UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1",
      )
      .run();
  });
  await expect(
    capture.submit(
      { deliveryId: ack.deliveryId, updateDigest: hash(bytes), updateBytes: bytes },
      new AbortController().signal,
    ),
  ).rejects.toThrow("standing changed");
  expect(f.peer.requests).toEqual([]);
});

it.each(["applied", "missing", "receipt-only"])(
  "uses exact durable ACK evidence for %s delivery",
  async (mode) => {
    const f = await setup();
    const commit = journal(f);
    if (mode === "ambiguous")
      f.drain.mockRejectedValueOnce(new Error("Lost application response."));
    if (mode === "missing" || mode === "receipt-only")
      f.peer.response = (request) =>
        f.peer.send({
          type: "response",
          id: request.id,
          result:
            mode === "missing"
              ? { status: "missing" }
              : {
                  status: "applied",
                  ack: {
                    deliveryId: ack.deliveryId,
                    updateDigest: ack.updateDigest,
                    journalCursor: ack.journalCursor,
                    acceptingHostEpoch: ack.acceptingHostEpoch,
                  },
                },
        });
    const submitted = f.capture.submit(
      { deliveryId: ack.deliveryId, updateDigest: hash(bytes), updateBytes: bytes },
      new AbortController().signal,
    );
    if (mode === "receipt-only") await expect(submitted).rejects.toThrow();
    else
      expect(await submitted).toEqual(
        mode === "missing"
          ? { result: "retry", reason: "application-pending" }
          : { result: "success", ack },
      );
    expect(commit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        actor: { kind: "named", userId: scope.userId, grantId: scope.grantId },
        metadata: { deliveryId: ack.deliveryId, updateDigest: hash(bytes), binding },
        updateBytes: bytes,
      }),
    );
  },
);

it("rechecks revocation after asynchronous validation and never commits its stale result", async () => {
  const f = await setup(),
    commit = journal(f),
    waiting = deferred<void>(),
    entered = deferred<void>();
  const capture = captureNamedLiveFrameHost({
    ticket: f.capture.ticket,
    actor: liveBrowserActor(scope),
    storage: f.storage,
    native: f.native,
    bounds: f.bounds,
    validate: async () => {
      entered.resolve();
      await waiting.promise;
      return { kind: "refused", reason: "invalid-update", source: "candidate" };
    },
  });
  cleanup.push(async () => capture.close());
  const submitting = capture.submit(
    { deliveryId: "delivery", updateDigest: hash(bytes), updateBytes: bytes },
    new AbortController().signal,
  );
  await entered.promise;
  f.raw
    .prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE grant_id=?")
    .run(scope.grantId);
  waiting.resolve();
  await expect(submitting).rejects.toThrow("standing changed");
  expect(commit).not.toHaveBeenCalled();
});

it("terminally refuses an oversized submission as a capacity refusal before validation or journal admission", async () => {
  const f = await setup();
  const commit = journal(f);
  const oversized = new Uint8Array(f.bounds.maxSubmissionBytes + 1);
  const capture = ownerCapture(f);
  expect(
    await capture.submit(
      { deliveryId: "oversized", updateDigest: hash(oversized), updateBytes: oversized },
      new AbortController().signal,
    ),
  ).toEqual({ result: "refused", reason: "capacity-refused" });
  expect(commit).not.toHaveBeenCalled();
  expect(f.validate).not.toHaveBeenCalled();
});

it("logs a slow or unsuccessful submission with cut ids, timings and a fixed word, once a minute for each document and result", async () => {
  const f = await setup();
  journal(f);
  // Far past any line an earlier test logged, so none of their minutes still holds a line back.
  let clock = 1e12;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const oversized = new Uint8Array(f.bounds.maxSubmissionBytes + 1);
  const submit = (deliveryId: string, updateBytes: Uint8Array) =>
    f.capture.submit(
      { deliveryId, updateDigest: hash(updateBytes), updateBytes },
      new AbortController().signal,
    );
  expect(await submit(ack.deliveryId, bytes)).toEqual({ result: "success", ack });
  expect(log).not.toHaveBeenCalled();
  f.drain.mockImplementationOnce(async () => {
    clock += 600;
  });
  expect(await submit(ack.deliveryId, bytes)).toEqual({ result: "success", ack });
  for (let i = 0; i < 3; i++)
    expect(await submit("delivery-with-a-longer-id", oversized)).toEqual({
      result: "refused",
      reason: "capacity-refused",
    });
  clock += 60_000;
  expect(await submit("delivery-with-a-longer-id", oversized)).toEqual({
    result: "refused",
    reason: "capacity-refused",
  });
  const object = binding.objectId.slice(0, 8);
  expect(log.mock.calls).toEqual([
    [
      "Live submit answered.",
      { submitter: "named", object, checkMs: 0, commitMs: 0, drainMs: 600, result: "success" },
    ],
    [
      "Live submit answered.",
      {
        submitter: "named",
        object,
        checkMs: 0,
        commitMs: null,
        drainMs: null,
        result: "capacity-refused",
      },
    ],
    [
      "Live submit answered.",
      {
        submitter: "named",
        object,
        checkMs: 0,
        commitMs: null,
        drainMs: null,
        result: "capacity-refused",
        repeated: 2,
      },
    ],
  ]);
  const shown = JSON.stringify(log.mock.calls);
  // No part of a delivery id, which the client chooses, reaches the log.
  for (const hidden of [
    binding.currentPath,
    binding.workspaceId,
    binding.lineageClaimId,
    hash(oversized),
    "deliver",
  ])
    expect(shown).not.toContain(hidden);
});

it("refuses an applied payload only after reading its size without retaining budget", async () => {
  const budget = createLiveBufferBudget(30),
    f = await setup(4, budget.reserve),
    signal = new AbortController().signal;
  const sync = await f.capture.openSync(Uint8Array.of(0), signal);
  const read = vi.spyOn(f.native.client, "readNextLiveApplied").mockResolvedValue({
    position: { eventCount: 1, journalCursor: 11, evidenceDigest: "cd".repeat(32) },
    ack,
    updateBytes: Buffer.alloc(31),
  });
  await expect(sync.nextApplied(signal)).rejects.toThrowError(LiveConnectionLimitError);
  expect(read).toHaveBeenCalledOnce();
  expect(budget.usage()).toBe(0);
});

it("reads one cut when one slot frees for three waiting submissions", async () => {
  const f = await setup(64);
  journal(f);
  const read = vi.mocked(f.storage.readLiveUpdateJournalCut);
  let available = false;
  const waiters = new Set<() => void>();
  const waiting = deferred<void>();
  const validate = Object.assign(
    vi.fn(() => {
      if (!available)
        return {
          kind: "retry" as const,
          reason: "admission-unavailable" as const,
          waitForCapacity,
        };
      available = false;
      return {
        kind: "refused" as const,
        reason: "invalid-update" as const,
        source: "candidate" as const,
      };
    }),
    { hasCapacity: () => available, waitForCapacity },
  );
  function waitForCapacity(signal?: AbortSignal) {
    if (available) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        waiters.delete(wake);
        reject(signal!.reason);
      };
      waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (waiters.size === 3) waiting.resolve();
    });
  }
  const caller = new AbortController();
  const captures = Array.from({ length: 3 }, () =>
    captureNamedLiveFrameHost({
      ticket: f.capture.ticket,
      actor: liveBrowserActor(scope),
      storage: f.storage,
      native: f.native,
      bounds: f.bounds,
      validate,
    }),
  );
  cleanup.push(async () => {
    captures.forEach((capture) => capture.close());
  });
  const outcomes = captures.map((capture) =>
    capture.submit(
      {
        deliveryId: ack.deliveryId,
        updateDigest: hash(bytes),
        updateBytes: bytes,
      },
      caller.signal,
    ),
  );
  const settled = Promise.allSettled(outcomes);
  await waiting.promise;
  expect(read).not.toHaveBeenCalled();
  available = true;
  for (const wake of [...waiters]) wake();
  expect(await Promise.race(outcomes)).toEqual({ result: "success", ack });
  expect(read).toHaveBeenCalledOnce();
  expect(validate).toHaveBeenCalledOnce();
  caller.abort();
  await settled;
});

it.each(["cancellation"])("releases validation bytes and the person slot on %s", async (mode) => {
  const f = await setup(),
    commit = journal(f),
    admission = createLiveConnectionAdmission(),
    budget = admission.buffers(12_288);
  const read = vi.mocked(f.storage.readLiveUpdateJournalCut),
    cut = read({ document: binding }),
    entered = deferred<void>();
  read.mockImplementation((_input, reserve) => {
    reserve!(1_024);
    return cut;
  });
  const reserve = vi.fn(() => admission.reserve([["person-validation", 1]]));
  const validate: CapacityLiveAdmissionValidator = async (_input, signal) => {
    entered.resolve();
    if (mode !== "refusal")
      await new Promise<void>((_resolve, reject) => {
        signal!.throwIfAborted();
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    return { kind: "refused", reason: "invalid-update", source: "candidate" };
  };
  commit.mockReturnValue({ result: { kind: "refused", reason: "invalid-update" }, admitted: null });
  const capture = captureNamedLiveFrameHost({
    ticket: f.capture.ticket,
    actor: liveBrowserActor(scope),
    storage: f.storage,
    native: { ...f.native, deadlineMs: 50 },
    bounds: f.bounds,
    validate,
    validationBudget: { reserve, maxBytes: 12_288, reserveBytes: budget.reserve },
  });
  cleanup.push(async () => capture.close());
  vi.useFakeTimers();
  const caller = new AbortController(),
    submitted = capture.submit(
      { deliveryId: ack.deliveryId, updateDigest: hash(bytes), updateBytes: bytes },
      caller.signal,
    );
  const outcome =
    mode === "cancellation"
      ? expect(submitted).rejects.toThrow("cancelled")
      : expect(submitted).resolves.toEqual(
          mode === "deadline"
            ? { result: "retry", reason: "admission-unavailable" }
            : { result: "refused", reason: "invalid-update" },
        );
  await entered.promise;
  if (mode === "deadline") await vi.advanceTimersByTimeAsync(50);
  if (mode === "cancellation") caller.abort(new Error("cancelled"));
  await outcome;
  expect(budget.usage()).toBe(0);
  expect(reserve).toHaveBeenCalledOnce();
  const released = admission.reserve([["person-validation", 1]]);
  expect(released).not.toBeNull();
  released?.();
  expect(vi.getTimerCount()).toBe(0);
});
