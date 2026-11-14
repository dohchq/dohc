import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { OwnerYDocOutbox } from "@dohc/workspace-engine-client";
import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import type {
  LiveUpdateHostApplicationAck,
  LiveUpdateReceipt,
} from "@dohc/live-session-contract/live-update-admission";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import {
  cleanupLiveDeliveryFixtures,
  DatabaseSync,
  hash,
  policy,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import { captureNamedLiveFrameHost, createNamedFrameChanges } from "./namedLiveFrameHost";
import { createLiveTickets } from "./liveTickets";
import { liveBrowserActor } from "./liveBrowserContext";
import { drainOwnerOutbox, type OwnerOutboxAdmission } from "./ownerOutboxDelivery";
import { openRelayDeployment } from "./relayDeployment";
import type { SyncRelayStorage } from "./storage";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  cleanupLiveDeliveryFixtures();
  vi.restoreAllMocks();
});
const validateProjection = createLiveMarkdownJournalValidator(policy);
const validateJournal: OwnerOutboxAdmission["validate"] = ({
  retainStateUpdate: _retainStateUpdate,
  ...input
}) => validateProjection(input);
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}

function fixture(
  edit: (doc: Y.Doc) => void = (doc) => doc.getMap("frontmatter").set("owner", "Owner edit"),
) {
  const liveTickets = {
    retainedTicketsPerPrincipalGrant: 2,
    expiredTicketCleanupBatchSize: 1,
    now: () => 1_000,
  };
  const relay = registered({ deployment: true, liveTickets });
  const live = { storage: relay.storage as SyncRelayStorage, close: () => relay.close() };
  cleanup.push(() => live.close());
  const before = Y.encodeStateVector(relay.doc);
  edit(relay.doc);
  const update = Y.encodeStateAsUpdate(relay.doc, before),
    captured = relay.capture(update, "owner-delivery");
  const { binding } = captured.metadata,
    document = captured.cutToken.document,
    host = captured.host;
  const entry = {
    sequence: 1,
    appendKey: "owner-append",
    deliveryId: captured.metadata.deliveryId,
    updateDigest: hash(update),
    byteLength: update.byteLength,
    createdAtMs: 1,
  };
  // The native outbox's durable record, which outlives every client and relay process.
  const pending = [entry],
    receipts: LiveUpdateReceipt[] = [],
    quarantines: string[] = [];
  const native = {
    state: "active",
    quarantineReason: null as string | null,
    retryDeliveryId: null as string | null,
  };
  // A fault fails a native write, or commits it and loses the response.
  const faults = {
    quarantine: [] as Array<"failed" | "lost">,
    acknowledge: [] as Array<"failed" | "lost">,
  };
  let recordedRefusal: unknown;
  const cursor = (part: string) => ({
    snapshot: "a".repeat(64),
    part,
    sequence: part === "header" || part === "base" ? 0 : 1,
    offset: 0,
  });
  const engine = () => ({
    sendRequest: vi.fn<EngineClient["sendRequest"]>(async (request) => {
      if (request.method === "liveApplication.ownerOutbox")
        return {
          id: request.id,
          result: {
            outboxId: "outbox",
            pendingBytes: pending.length * update.byteLength,
            state: native.state,
            retryDeliveryId: native.retryDeliveryId,
          },
        };
      if (request.method === "liveApplication.quarantineOwnerOutbox") {
        const fault = faults.quarantine.shift(),
          { reason, deliveryId, refusalKey } = request.params as {
            reason: string;
            deliveryId: string;
            refusalKey: string;
          };
        if (fault === "failed") throw new Error("Engine unavailable.");
        // Like native, a refusal records once, and only while it is its head's own attempt.
        if (
          refusalKey !== recordedRefusal &&
          pending[0]?.deliveryId === deliveryId &&
          (native.state !== "quarantined" || native.retryDeliveryId === deliveryId)
        ) {
          native.state = "quarantined";
          native.quarantineReason = reason;
          native.retryDeliveryId = null;
          quarantines.push(reason);
          recordedRefusal = refusalKey;
        }
        if (fault === "lost") throw new Error("Engine response lost.");
        return { id: request.id, result: { state: "quarantined" } };
      }
      if (request.method === "liveApplication.acknowledgeOwnerOutbox") {
        const fault = faults.acknowledge.shift(),
          receipt = (request.params as unknown as { receipts: LiveUpdateReceipt[] }).receipts[0]!;
        if (fault === "failed") throw new Error("Engine unavailable.");
        // Only the head its owner asked to try again leaves quarantine, and its acceptance resumes the queue.
        if (native.state === "quarantined" && native.retryDeliveryId !== receipt.deliveryId)
          throw new Error("A quarantined owner outbox refuses acknowledgement.");
        Object.assign(native, { state: "active", quarantineReason: null, retryDeliveryId: null });
        expect(receipt).toMatchObject({
          deliveryId: entry.deliveryId,
          updateDigest: entry.updateDigest,
        });
        receipts.push(receipt);
        pending.shift();
        if (fault === "lost") throw new Error("Engine response lost.");
        return {
          id: request.id,
          result: { acknowledged: 1, pendingBytes: 0, oldestEntryAtMs: null },
        };
      }
      // The relay reads through its registration; a native reader reads the outbox directly.
      expect(["liveApplication.readOwnerOutbox", "ydoc.ownerOutbox.readPending"]).toContain(
        request.method,
      );
      const current =
        (request.params as { cursor?: ReturnType<typeof cursor> }).cursor ?? cursor("header");
      let bytes: Buffer, nextCursor: ReturnType<typeof cursor> | null;
      if (current.part === "header") {
        bytes = Buffer.from(
          JSON.stringify({
            outboxId: "outbox",
            binding,
            baseUpdateDigest: binding.lineageClaimId,
            baseByteLength: relay.input.baselineBytes.byteLength,
            state: native.state,
            pendingBytes: pending.length * update.byteLength,
            pendingEntryCount: pending.length,
            nextSequence: 2,
            oldestEntryAtMs: pending.length ? 1 : null,
            quarantineReason: native.quarantineReason,
            observedBinding: null,
            retryDeliveryId: native.retryDeliveryId,
            firstEntryCursor: pending.length ? cursor("entryHeader") : null,
            frozenAtRefusedSeed: false,
            checkpointDigest: null,
            recoveryCheckpointDigest: null,
          }),
        );
        nextCursor = cursor("base");
      } else if (current.part === "entryHeader") {
        bytes = Buffer.from(JSON.stringify(entry));
        nextCursor = cursor("update");
      } else {
        expect(current.part).toBe("update");
        bytes = Buffer.from(update);
        nextCursor = null;
      }
      return {
        id: request.id,
        result: {
          kind: "page",
          ...current,
          totalBytes: bytes.byteLength,
          digest: hash(bytes),
          bytesBase64: bytes.toString("base64"),
          nextCursor,
        },
      };
    }),
  });
  const applyThrough = vi.fn(
    async (receipt: LiveUpdateReceipt): Promise<LiveUpdateHostApplicationAck> => ({
      ...receipt,
      localYDocSequence: receipt.journalCursor,
      applicationReplayed: false,
    }),
  );
  const validate = vi.fn<OwnerOutboxAdmission["validate"]>((input) => validateJournal(input));
  const commit = vi.spyOn(relay.storage, "commitLiveUpdateJournal");
  let requestId = 0;
  // The relay process's delivery state, which a pass or reconnect keeps and a crash loses.
  let refusals = new OwnerKnownRefusals();
  const crash = () => {
    refusals = new OwnerKnownRefusals();
  };
  // Each drain builds its delivery objects and engine connection afresh, as a new relay pass does.
  const run = (admit = validate) =>
    drainOwnerOutbox({
      storage: live.storage,
      client: engine() as unknown as EngineClient,
      admission: {
        trustedAccount: (accountId: string) => ({ accountId, name: "Owner name" }),
        workspaceIds: new Set([document.workspaceId]),
        maxEntriesPerDrain: 1,
        maxBytesPerDrain: 10_000,
        refusals,
        validate: admit,
      },
      workspace: "handle",
      host,
      registrationId: 1,
      binding,
      adoption: { adoptionId: "adoption", sequence: 1, applied() {} },
      nextRequestId: () => ++requestId,
      deadlineMs: 1_000,
      assertCurrent() {},
      applyThrough,
    });
  const restart = () => {
    live.close();
    const reopened = openRelayDeployment(relay.configPath, { liveTickets }).storage;
    live.storage = reopened;
    live.close = () => reopened.close();
    return reopened;
  };
  const known = () => refusals.get(JSON.stringify([host.mode, host.hostId, "outbox"]));
  return {
    relay,
    document,
    host,
    binding,
    update,
    entry,
    pending,
    receipts,
    quarantines,
    native,
    faults,
    engine,
    applyThrough,
    validate,
    commit,
    run,
    restart,
    crash,
    known,
  };
}

it("retries the retained owner head when a named submission advances its validated journal cut", async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  f.validate.mockImplementationOnce(async (input) => {
    entered.resolve();
    await release.promise;
    return validateJournal(input);
  });
  const first = f.run();
  const firstOutcome = Promise.allSettled([first]);
  await Promise.race([
    entered.promise,
    first.then(() => {
      throw new Error("Owner drain ended before validation.");
    }),
  ]);
  const scope = {
    kind: "named" as const,
    workspaceId: f.document.workspaceId,
    shareId: "share",
    grantId: "grant",
    userId: "reader",
  };
  const tickets = createLiveTickets({
    storage: f.relay.storage,
    audience: "https://share.example.test",
    key: new Uint8Array(32).fill(13),
    hostReports: { currentBinding: async () => ({ connection: f.host, binding: f.binding }) },
  });
  const minted = await tickets.mint({ objectId: f.document.objectId }, scope);
  expect(minted).not.toBeNull();
  const ticket = await tickets.redeem(minted!.token, scope);
  expect(ticket).not.toBeNull();
  const named = captureNamedLiveFrameHost({
    ticket: ticket!,
    actor: liveBrowserActor(scope),
    storage: f.relay.storage,
    validate: validateJournal,
    native: {
      client: { readLiveApplicationAck: async () => null } as never,
      workspace: "handle",
      registrationId: 1,
      coordinate: f.host,
      binding: f.binding,
      invalidated: new AbortController().signal,
      changes: createNamedFrameChanges(1),
      deadlineMs: 1_000,
      nextRequestId: () => 1,
      drain: async () => {},
    },
    bounds: {
      maxClientVectorBytes: 1_000,
      maxSyncOutputBytes: 10_000,
      maxAppliedUpdateBytes: 10_000,
      maxSubmissionBytes: 10_000,
      maxAdmissionBytes: 100_000,
    },
  });
  cleanup.push(() => named.close());
  const namedDoc = new Y.Doc();
  let namedUpdate: Uint8Array;
  try {
    Y.applyUpdate(namedDoc, f.relay.input.baselineBytes);
    const before = Y.encodeStateVector(namedDoc);
    namedDoc.getMap("frontmatter").set("named", "Named edit");
    namedUpdate = Y.encodeStateAsUpdate(namedDoc, before);
  } finally {
    namedDoc.destroy();
  }
  expect(
    await named.submit(
      { deliveryId: "named-delivery", updateDigest: hash(namedUpdate), updateBytes: namedUpdate },
      new AbortController().signal,
    ),
  ).toEqual({ result: "retry", reason: "application-pending" });
  expect(f.relay.journalRows().journal).toMatchObject([
    { delivery_id: "named-delivery", principal_kind: "named" },
  ]);
  expect(f.pending).toEqual([f.entry]);
  expect(f.receipts).toEqual([]);
  expect(f.applyThrough).not.toHaveBeenCalled();
  release.resolve();
  const [outcome] = await firstOutcome;
  expect(f.commit.mock.results[1]!.value).toMatchObject({
    result: { kind: "retry", reason: "admission-unavailable" },
    admitted: null,
  });
  expect(f.pending).toEqual([f.entry]);
  expect(f.receipts).toEqual([]);
  expect(f.applyThrough).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    status: "fulfilled",
    value: { admittedEntries: 0, hasMore: true, retryReady: true },
  });
  expect(await f.run()).toEqual({ admittedEntries: 1, hasMore: false });
  expect(f.validate.mock.calls.map(([input]) => input.suffix.length)).toEqual([0, 1]);
  expect(f.relay.journalRows().journal).toMatchObject([
    { delivery_id: "named-delivery" },
    { delivery_id: "owner-delivery", principal_kind: "owner" },
  ]);
  expect(f.receipts).toHaveLength(1);
  expect(f.applyThrough).toHaveBeenCalledTimes(1);
  expect(f.pending).toEqual([]);
  expect(await f.run()).toEqual({ admittedEntries: 0, hasMore: false, empty: true });
  expect(f.receipts).toHaveLength(1);
  expect(f.relay.journalRows().journal).toHaveLength(2);
});

it("refuses an owner outbox entry validated before the document's last Edit share was deleted", async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  f.relay.storage.claimWorkspaceIdentity({
    workspaceId: f.document.workspaceId,
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  f.relay.storage.ensureOwnedLiveDocument({
    intent: "share",
    workspaceId: f.document.workspaceId,
    ownerUserId: "owner",
    shareId: "share",
    path: f.binding.currentPath,
    nowMs: 10,
    guard() {},
  });
  f.validate.mockImplementationOnce(async (input) => {
    entered.resolve();
    await release.promise;
    return validateJournal(input);
  });
  const first = f.run(),
    firstOutcome = Promise.allSettled([first]);
  await Promise.race([
    entered.promise,
    first.then(() => {
      throw new Error("Owner drain ended before validation.");
    }),
  ]);
  expect(f.relay.storage.revokeShare("share", 30)).toBe(true);
  release.resolve();
  const [outcome] = await firstOutcome;
  expect(outcome).toMatchObject({
    status: "rejected",
    reason: new Error("Owner update admission refused."),
  });
  expect(f.commit.mock.results[0]!.value).toMatchObject({
    result: { kind: "refused", reason: "authority-refused" },
    admitted: null,
  });
  expect(f.relay.journalRows().journal).toEqual([]);
  expect(f.receipts).toEqual([]);
  expect(f.pending).toEqual([f.entry]);
  expect(f.applyThrough).not.toHaveBeenCalled();
});

it("does not quarantine the owner's head when the real validator refuses the admitted history", async () => {
  const f = fixture(),
    peer = new Y.Doc();
  let admitted: Uint8Array;
  try {
    Y.applyUpdate(peer, f.relay.input.baselineBytes);
    const before = Y.encodeStateVector(peer);
    for (let index = 0; index < 64; index++)
      peer.getMap("frontmatter").set(`admitted${index}`, index);
    admitted = Y.encodeStateAsUpdate(peer, before);
  } finally {
    peer.destroy();
  }
  expect(
    f.relay.storage.commitLiveUpdateJournal(f.relay.capture(admitted, "admitted-row")).result.kind,
  ).toBe("accepted");
  const read = f.relay.storage.readLiveUpdateJournalCut({ document: f.document });
  if (read.kind !== "cut") throw new Error("The journal has no cut.");
  const call = {
    document: read.cut.document,
    currentPath: read.cut.currentPath,
    checkpoint: read.cut.checkpoint.bytes,
    suffix: read.cut.suffix.map((row) => row.bytes),
    candidate: f.update,
  };
  let stricter: ReturnType<typeof createLiveMarkdownJournalValidator> | undefined;
  for (let limit = 1; limit < 5_000 && !stricter; limit++) {
    const candidate = createLiveMarkdownJournalValidator({ ...policy, maxStructVisits: limit });
    const result = candidate(call);
    if (result.kind === "refused" && result.source === "admitted-cut") stricter = candidate;
  }
  if (!stricter) throw new Error("No budget refuses only the admitted history.");
  const strict = stricter;
  const validate = vi.fn<OwnerOutboxAdmission["validate"]>(
    ({ retainStateUpdate: _retainStateUpdate, ...input }) => strict(input),
  );
  await expect(f.run(validate)).rejects.toThrow();
  expect(validate.mock.results[0]!.value).toEqual({
    kind: "refused",
    reason: "capacity-refused",
    source: "admitted-cut",
  });
  expect(f.quarantines).toEqual([]);
  expect(f.native.state).toBe("active");
  expect(f.relay.journalRows().journal).toMatchObject([{ delivery_id: "admitted-row" }]);
  expect(f.pending).toEqual([f.entry]);
  expect(f.receipts).toEqual([]);
  expect(f.applyThrough).not.toHaveBeenCalled();
  // The relay's own budget admits the same head on the next pass.
  expect(await f.run()).toEqual({ admittedEntries: 1, hasMore: false });
  expect(f.receipts).toMatchObject([{ deliveryId: f.entry.deliveryId }]);
});

it("keeps a quarantined head and its bytes through a relay restart and upgrade, without probing it", async () => {
  const f = fixture((doc) => doc.getMap("meta").set("schemaVersion", 2));
  expect(await f.run()).toEqual({ admittedEntries: 0, hasMore: false });
  const storage = f.restart(),
    commit = vi.spyOn(storage, "commitLiveUpdateJournal");
  const upgraded = vi.fn<OwnerOutboxAdmission["validate"]>((input) => validateJournal(input));
  expect(await f.run(upgraded)).toEqual({ admittedEntries: 0, hasMore: false });
  expect(await f.run(upgraded)).toEqual({ admittedEntries: 0, hasMore: false });
  expect(upgraded).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  expect(f.quarantines).toEqual(["invalid-update"]);
  const outbox = new OwnerYDocOutbox(f.engine(), "handle");
  try {
    const head = await outbox.readDeliveryHead("outbox", f.binding);
    expect(head).toMatchObject({
      state: "quarantined",
      quarantineReason: "invalid-update",
      entry: { deliveryId: f.entry.deliveryId, updateDigest: f.entry.updateDigest },
    });
    expect(Buffer.from(head.entry!.update).equals(Buffer.from(f.update))).toBe(true);
  } finally {
    outbox.dispose();
  }
  const raw = new DatabaseSync(f.relay.path, { readOnly: true });
  cleanup.push(() => raw.close());
  expect(raw.prepare("SELECT * FROM sync_relay_live_update_journal").all()).toEqual([]);
});

const olderValidator = () =>
  vi.fn<OwnerOutboxAdmission["validate"]>(() => ({
    kind: "refused",
    reason: "invalid-schema",
    source: "final",
  }));
const journalRows = (f: ReturnType<typeof fixture>) => {
  const raw = new DatabaseSync(f.relay.path, { readOnly: true });
  cleanup.push(() => raw.close());
  return raw.prepare("SELECT delivery_id,principal_kind FROM sync_relay_live_update_journal").all();
};

it("admits an outstanding Try again once, under its original delivery, after a crash lost its refusal", async () => {
  const f = fixture(),
    older = olderValidator();
  expect(await f.run(older)).toEqual({ admittedEntries: 0, hasMore: false });
  f.native.retryDeliveryId = f.entry.deliveryId;
  f.faults.quarantine.push("failed");
  await expect(f.run(older)).rejects.toThrow("Engine unavailable.");
  expect(f.native).toEqual({
    state: "quarantined",
    quarantineReason: "invalid-update",
    retryDeliveryId: f.entry.deliveryId,
  });
  // The relay crashes with the refusal it received; the owner's request is still open.
  f.crash();
  const storage = f.restart(),
    commit = vi.spyOn(storage, "commitLiveUpdateJournal");
  expect(await f.run()).toEqual({ admittedEntries: 1, hasMore: false });
  expect(older).toHaveBeenCalledTimes(2);
  expect(f.validate).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls.map(([input]) => input.metadata)).toEqual([
    f.commit.mock.calls[0]![0].metadata,
  ]);
  expect(journalRows(f)).toEqual([{ delivery_id: f.entry.deliveryId, principal_kind: "owner" }]);
  expect(f.native).toEqual({ state: "active", quarantineReason: null, retryDeliveryId: null });
  expect(f.receipts).toHaveLength(1);
  expect(f.pending).toEqual([]);
  expect(await f.run()).toEqual({ admittedEntries: 0, hasMore: false, empty: true });
  expect(commit).toHaveBeenCalledTimes(1);
});

it.each(["failed", "lost"] as const)(
  "recovers an accepted Try again whose acknowledgement %s under its original delivery, without a duplicate",
  async (fault) => {
    const f = fixture();
    expect(await f.run(olderValidator())).toEqual({ admittedEntries: 0, hasMore: false });
    f.native.retryDeliveryId = f.entry.deliveryId;
    f.faults.acknowledge.push(fault);
    await expect(f.run()).rejects.toThrow();
    expect(await f.run()).toEqual(
      fault === "failed"
        ? { admittedEntries: 1, hasMore: false }
        : { admittedEntries: 0, hasMore: false, empty: true },
    );
    expect(new Set(f.commit.mock.calls.map(([input]) => input.metadata.deliveryId))).toEqual(
      new Set([f.entry.deliveryId]),
    );
    expect(journalRows(f)).toEqual([{ delivery_id: f.entry.deliveryId, principal_kind: "owner" }]);
    expect(f.receipts).toHaveLength(1);
    expect(f.pending).toEqual([]);
    expect(f.native).toEqual({ state: "active", quarantineReason: null, retryDeliveryId: null });
  },
);
