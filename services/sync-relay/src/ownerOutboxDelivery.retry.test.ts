import {afterEach, expect, it, vi} from "vitest";
import * as Y from "yjs";
import {OwnerYDocOutbox} from "@dohc/workspace-engine-client";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {LiveUpdateHostApplicationAck, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";
import {createLiveMarkdownJournalValidator} from "@dohc/ydoc-projection/live-journal-validation";
import {cleanupLiveDeliveryFixtures, DatabaseSync, hash, policy, registered} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {captureNamedLiveFrameHost, createNamedFrameChanges} from "./namedLiveFrameHost";
import {createLiveTickets} from "./liveTickets";
import {liveBrowserActor} from "./liveBrowserContext";
import {drainOwnerOutbox, type OwnerOutboxAdmission} from "./ownerOutboxDelivery";
import {openRelayDeployment} from "./relayDeployment";
import type {SyncRelayStorage} from "./storage";
import type {StorageContext} from "./storage/context";
import type {LiveJournalValidation} from "./storage/types";

const cleanup: Array<() => void> = [];
afterEach(() => {for (const close of cleanup.splice(0).reverse()) close(); cleanupLiveDeliveryFixtures(); vi.restoreAllMocks();});
const validateProjection = createLiveMarkdownJournalValidator(policy);
const validateJournal: OwnerOutboxAdmission["validate"] = ({retainStateUpdate: _retainStateUpdate, ...input}) => validateProjection(input);
function deferred() {
  let resolve!: () => void;
  return {promise: new Promise<void>(done => {resolve = done;}), resolve: () => resolve()};
}

function fixture(edit: (doc: Y.Doc) => void = doc => doc.getMap("frontmatter").set("owner", "Owner edit")) {
  const liveTickets = {retainedTicketsPerPrincipalGrant: 2,expiredTicketCleanupBatchSize: 1,now: () => 1_000};
  const relay = registered({deployment: true,liveTickets});
  const live = {storage: relay.storage as SyncRelayStorage,close: () => relay.close()};
  cleanup.push(() => live.close());
  const before = Y.encodeStateVector(relay.doc);
  edit(relay.doc);
  const update = Y.encodeStateAsUpdate(relay.doc, before), captured = relay.capture(update, "owner-delivery");
  const {binding} = captured.metadata, document = captured.cutToken.document, host = captured.host;
  const entry = {sequence: 1,appendKey: "owner-append",deliveryId: captured.metadata.deliveryId,
    updateDigest: hash(update),byteLength: update.byteLength,createdAtMs: 1};
  // The native outbox's durable record, which outlives every client and relay process.
  const pending = [entry], receipts: LiveUpdateReceipt[] = [], quarantines: string[] = [];
  const native = {state: "active", quarantineReason: null as string | null, retryDeliveryId: null as string | null};
  const cursor = (part: string) => ({snapshot: "a".repeat(64),part,sequence: part === "header" || part === "base" ? 0 : 1,offset: 0});
  const engine = () => ({sendRequest: vi.fn<EngineClient["sendRequest"]>(async request => {
    if (request.method === "liveApplication.ownerOutbox") return {id: request.id,result: {outboxId: "outbox",pendingBytes: pending.length * update.byteLength,state: native.state,retryDeliveryId: native.retryDeliveryId}};
    if (request.method === "liveApplication.quarantineOwnerOutbox") {
      const {reason} = request.params as {reason: string};
      native.state = "quarantined"; native.quarantineReason = reason; native.retryDeliveryId = null; quarantines.push(reason);
      return {id: request.id,result: {state: "quarantined"}};
    }
    if (request.method === "liveApplication.acknowledgeOwnerOutbox") {
      const receipt = (request.params as unknown as {receipts: LiveUpdateReceipt[]}).receipts[0]!;
      // Only the head its owner asked to try again leaves quarantine, and its acceptance resumes the queue.
      if (native.state === "quarantined" && native.retryDeliveryId !== receipt.deliveryId) throw new Error("A quarantined owner outbox refuses acknowledgement.");
      Object.assign(native, {state: "active", quarantineReason: null, retryDeliveryId: null});
      expect(receipt).toMatchObject({deliveryId: entry.deliveryId,updateDigest: entry.updateDigest});
      receipts.push(receipt); pending.shift();
      return {id: request.id,result: {acknowledged: 1,pendingBytes: 0,oldestEntryAtMs: null}};
    }
    // The relay reads through its registration; a native reader reads the outbox directly.
    expect(["liveApplication.readOwnerOutbox","ydoc.ownerOutbox.readPending"]).toContain(request.method);
    const current = (request.params as {cursor?: ReturnType<typeof cursor>}).cursor ?? cursor("header");
    let bytes: Buffer, nextCursor: ReturnType<typeof cursor> | null;
    if (current.part === "header") {
      bytes = Buffer.from(JSON.stringify({outboxId: "outbox",binding,baseUpdateDigest: binding.lineageClaimId,
        baseByteLength: relay.input.baselineBytes.byteLength,state: native.state,pendingBytes: pending.length * update.byteLength,
        pendingEntryCount: pending.length,nextSequence: 2,oldestEntryAtMs: pending.length ? 1 : null,quarantineReason: native.quarantineReason,
        observedBinding: null,retryDeliveryId: native.retryDeliveryId,firstEntryCursor: pending.length ? cursor("entryHeader") : null}));
      nextCursor = cursor("base");
    } else if (current.part === "entryHeader") {
      bytes = Buffer.from(JSON.stringify(entry)); nextCursor = cursor("update");
    } else {
      expect(current.part).toBe("update"); bytes = Buffer.from(update); nextCursor = null;
    }
    return {id: request.id,result: {kind: "page",...current,totalBytes: bytes.byteLength,digest: hash(bytes),bytesBase64: bytes.toString("base64"),nextCursor}};
  })});
  const applyThrough = vi.fn(async (receipt: LiveUpdateReceipt): Promise<LiveUpdateHostApplicationAck> =>
    ({...receipt,localYDocSequence: receipt.journalCursor,applicationReplayed: false}));
  const validate = vi.fn<OwnerOutboxAdmission["validate"]>(input => validateJournal(input));
  const commit = vi.spyOn(relay.storage, "commitLiveUpdateJournal");
  let requestId = 0;
  // Each drain builds its delivery objects afresh, as a new relay pass does.
  const run = (admit = validate) => drainOwnerOutbox({storage: live.storage,client: engine() as unknown as EngineClient,
    admission: {trustedAccount: (accountId: string) => ({accountId, name: "Owner name"}), shares: new Map([[document.workspaceId,"share"]]),maxEntriesPerDrain: 1,maxBytesPerDrain: 10_000,validate: admit},
    workspace: "handle",host,registrationId: 1,binding,adoption: {adoptionId: "adoption",sequence: 1,applied() {}},nextRequestId: () => ++requestId,deadlineMs: 1_000,
    assertCurrent() {},applyThrough});
  const restart = () => {
    live.close();
    const reopened = openRelayDeployment(relay.configPath, {liveTickets}).storage;
    live.storage = reopened; live.close = () => reopened.close();
    return reopened;
  };
  return {relay,document,host,binding,update,entry,pending,receipts,quarantines,native,engine,applyThrough,validate,commit,run,restart};
}

it("retries the retained owner head when a named submission advances its validated journal cut", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  f.validate.mockImplementationOnce(async input => {entered.resolve(); await release.promise; return validateJournal(input);});
  const first = f.run();
  const firstOutcome = Promise.allSettled([first]);
  await Promise.race([entered.promise, first.then(() => {throw new Error("Owner drain ended before validation.");})]);
  const scope = {kind: "named" as const,workspaceId: f.document.workspaceId,shareId: "share",grantId: "grant",userId: "reader"};
  const tickets = createLiveTickets({storage: f.relay.storage,audience: "https://share.example.test",key: new Uint8Array(32).fill(13),
    hostReports: {currentBinding: async () => ({connection: f.host,binding: f.binding})}});
  const minted = await tickets.mint({objectId: f.document.objectId}, scope);
  expect(minted).not.toBeNull();
  const ticket = await tickets.redeem(minted!.token, scope);
  expect(ticket).not.toBeNull();
  const named = captureNamedLiveFrameHost({ticket: ticket!,actor: liveBrowserActor(scope),storage: f.relay.storage,validate: validateJournal,
    native: {client: {readLiveApplicationAck: async () => null} as never,workspace: "handle",registrationId: 1,coordinate: f.host,binding: f.binding,
      invalidated: new AbortController().signal,changes: createNamedFrameChanges(1),deadlineMs: 1_000,nextRequestId: () => 1,drain: async () => {}},
    bounds: {maxClientVectorBytes: 1_000,maxSyncOutputBytes: 10_000,maxAppliedUpdateBytes: 10_000,maxSubmissionBytes: 10_000,maxAdmissionBytes: 100_000}});
  cleanup.push(() => named.close());
  const namedDoc = new Y.Doc();
  let namedUpdate: Uint8Array;
  try {
    Y.applyUpdate(namedDoc, f.relay.input.baselineBytes);
    const before = Y.encodeStateVector(namedDoc);
    namedDoc.getMap("frontmatter").set("named", "Named edit");
    namedUpdate = Y.encodeStateAsUpdate(namedDoc, before);
  } finally {namedDoc.destroy();}
  expect(await named.submit({deliveryId: "named-delivery",updateDigest: hash(namedUpdate),updateBytes: namedUpdate}, new AbortController().signal))
    .toEqual({result: "retry",reason: "application-pending"});
  expect(f.relay.journalRows().journal).toMatchObject([{delivery_id: "named-delivery",principal_kind: "named"}]);
  expect(f.pending).toEqual([f.entry]); expect(f.receipts).toEqual([]); expect(f.applyThrough).not.toHaveBeenCalled();
  release.resolve();
  const [outcome] = await firstOutcome;
  expect(f.commit.mock.results[1]!.value).toMatchObject({result: {kind: "retry",reason: "admission-unavailable"},admitted: null});
  expect(f.pending).toEqual([f.entry]); expect(f.receipts).toEqual([]); expect(f.applyThrough).not.toHaveBeenCalled();
  expect(outcome).toEqual({status: "fulfilled",value: {admittedEntries: 0,hasMore: true,retryReady: true}});
  expect(await f.run()).toEqual({admittedEntries: 1,hasMore: false});
  expect(f.validate.mock.calls.map(([input]) => input.suffix.length)).toEqual([0,1]);
  expect(f.relay.journalRows().journal).toMatchObject([{delivery_id: "named-delivery"},{delivery_id: "owner-delivery",principal_kind: "owner"}]);
  expect(f.receipts).toHaveLength(1); expect(f.applyThrough).toHaveBeenCalledTimes(1); expect(f.pending).toEqual([]);
  expect(await f.run()).toEqual({admittedEntries: 0,hasMore: false});
  expect(f.receipts).toHaveLength(1); expect(f.relay.journalRows().journal).toHaveLength(2);
});

it("retries without acknowledging when SQLite is busy before the first journal write", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  f.validate.mockImplementationOnce(async input => {entered.resolve(); await release.promise; return validateJournal(input);});
  const first = f.run(), firstOutcome = Promise.allSettled([first]);
  await Promise.race([entered.promise, first.then(() => {throw new Error("Owner drain ended before validation.");})]);
  const lock = new DatabaseSync(f.relay.path); cleanup.push(() => lock.close());
  const database = (f.relay.storage as StorageContext).db;
  const timeout = database.prepare("PRAGMA busy_timeout").get()!.timeout;
  database.exec("PRAGMA busy_timeout = 0");
  lock.exec("BEGIN IMMEDIATE");
  let outcome: PromiseSettledResult<Awaited<ReturnType<typeof f.run>>>;
  try {release.resolve(); [outcome] = await firstOutcome;} finally {lock.exec("ROLLBACK"); database.exec(`PRAGMA busy_timeout = ${timeout}`);}
  expect(f.commit.mock.results[0]!.value).toMatchObject({result: {kind: "retry",reason: "admission-unavailable"},admitted: null});
  expect(f.relay.journalRows().journal).toEqual([]); expect(f.receipts).toEqual([]);
  expect(f.pending).toEqual([f.entry]); expect(f.applyThrough).not.toHaveBeenCalled();
  expect(outcome!).toEqual({status: "fulfilled",value: {admittedEntries: 0,hasMore: true,retryReady: true}});
  expect(await f.run()).toEqual({admittedEntries: 1,hasMore: false});
  expect(f.relay.journalRows().journal).toHaveLength(1); expect(f.receipts).toHaveLength(1);
});

// Proves: deleting an enrolled document's last Edit share refuses the owner
// outbox entry an in-flight drain validated before it. The journal admits
// nothing and the owner head stays.
it("refuses an owner outbox entry validated before the document's last Edit share was deleted", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  f.relay.storage.claimWorkspaceIdentity({workspaceId: f.document.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  f.relay.storage.enrollServiceHostDocument({workspaceId: f.document.workspaceId, ownerUserId: "owner", shareId: "share",
    path: f.binding.currentPath, nowMs: 10, guard() {}});
  f.validate.mockImplementationOnce(async input => {entered.resolve(); await release.promise; return validateJournal(input);});
  const first = f.run(), firstOutcome = Promise.allSettled([first]);
  await Promise.race([entered.promise, first.then(() => {throw new Error("Owner drain ended before validation.");})]);
  expect(f.relay.storage.revokeShare("share", 30)).toBe(true);
  release.resolve();
  const [outcome] = await firstOutcome;
  expect(outcome).toMatchObject({status: "rejected", reason: new Error("Owner update admission refused.")});
  expect(f.commit.mock.results[0]!.value).toMatchObject({result: {kind: "refused",reason: "authority-refused"},admitted: null});
  expect(f.relay.journalRows().journal).toEqual([]); expect(f.receipts).toEqual([]);
  expect(f.pending).toEqual([f.entry]); expect(f.applyThrough).not.toHaveBeenCalled();
});

// A newer owner writes a schema version this relay does not know; an older one writes a version it no longer accepts.
it.each([["a newer", 2], ["an older", 0]])("quarantines %s owner schema the relay refuses for good, and never validates it again", async (_name, version) => {
  const f = fixture(doc => doc.getMap("meta").set("schemaVersion", version));
  expect(await f.run()).toEqual({admittedEntries: 0,hasMore: false});
  expect(f.validate.mock.results[0]!.value).toEqual({kind: "refused",reason: "invalid-schema",source: "final"});
  expect(f.commit.mock.results[0]!.value).toMatchObject({result: {kind: "refused",reason: "invalid-update"},admitted: null});
  expect(f.native).toEqual({state: "quarantined",quarantineReason: "invalid-update",retryDeliveryId: null});
  expect(f.relay.journalRows().journal).toEqual([]); expect(f.receipts).toEqual([]);
  expect(f.pending).toEqual([f.entry]); expect(f.applyThrough).not.toHaveBeenCalled();
  f.validate.mockClear(); f.commit.mockClear();
  expect(await f.run()).toEqual({admittedEntries: 0,hasMore: false});
  expect(f.validate).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  expect(f.quarantines).toEqual(["invalid-update"]);
});

it.each<LiveJournalValidation>([
  {kind: "refused",reason: "invalid-update",source: "call"},
  {kind: "refused",reason: "projection-mutated",source: "final"},
  {kind: "refused",reason: "invalid-schema",source: "admitted-cut"},
  {kind: "refused",reason: "capacity-refused",source: "admitted-cut"},
])("does not blame the owner's candidate for a validator or admitted-cut failure: %j", async validation => {
  const f = fixture();
  f.validate.mockReturnValueOnce(validation);
  await expect(f.run()).rejects.toThrow();
  expect(f.quarantines).toEqual([]); expect(f.native.state).toBe("active");
  expect(f.relay.journalRows().journal).toEqual([]); expect(f.pending).toEqual([f.entry]);
  expect(await f.run()).toEqual({admittedEntries: 1,hasMore: false});
  expect(f.receipts).toHaveLength(1);
});

it("keeps a quarantined head and its bytes through a relay restart and upgrade, without probing it", async () => {
  const f = fixture(doc => doc.getMap("meta").set("schemaVersion", 2));
  expect(await f.run()).toEqual({admittedEntries: 0,hasMore: false});
  const storage = f.restart(), commit = vi.spyOn(storage, "commitLiveUpdateJournal");
  const upgraded = vi.fn<OwnerOutboxAdmission["validate"]>(input => validateJournal(input));
  expect(await f.run(upgraded)).toEqual({admittedEntries: 0,hasMore: false});
  expect(await f.run(upgraded)).toEqual({admittedEntries: 0,hasMore: false});
  expect(upgraded).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  expect(f.quarantines).toEqual(["invalid-update"]);
  const outbox = new OwnerYDocOutbox(f.engine(), "handle");
  try {
    const head = await outbox.readDeliveryHead("outbox", f.binding);
    expect(head).toMatchObject({state: "quarantined",quarantineReason: "invalid-update",entry: {deliveryId: f.entry.deliveryId,updateDigest: f.entry.updateDigest}});
    expect(Buffer.from(head.entry!.update).equals(Buffer.from(f.update))).toBe(true);
  } finally {outbox.dispose();}
  const raw = new DatabaseSync(f.relay.path, {readOnly: true}); cleanup.push(() => raw.close());
  expect(raw.prepare("SELECT * FROM sync_relay_live_update_journal").all()).toEqual([]);
});

it("re-quarantines a Try again the relay's schema check refuses again, and no background pass tries it", async () => {
  const f = fixture(doc => doc.getMap("meta").set("schemaVersion", 2));
  expect(await f.run()).toEqual({admittedEntries: 0,hasMore: false});
  expect(await f.run()).toEqual({admittedEntries: 0,hasMore: false});
  expect(f.validate).toHaveBeenCalledTimes(1);
  // The owner's Try again, which only native records.
  f.native.retryDeliveryId = f.entry.deliveryId;
  expect(await f.run()).toEqual({admittedEntries: 0,hasMore: false});
  expect(f.validate.mock.results[1]!.value).toEqual({kind: "refused",reason: "invalid-schema",source: "final"});
  expect(f.commit.mock.calls.map(([input]) => input.metadata.deliveryId)).toEqual([f.entry.deliveryId, f.entry.deliveryId]);
  expect(f.native).toEqual({state: "quarantined",quarantineReason: "invalid-update",retryDeliveryId: null});
  for (let pass = 0; pass < 3; pass++) expect(await f.run()).toEqual({admittedEntries: 0,hasMore: false});
  expect(f.validate).toHaveBeenCalledTimes(2); expect(f.commit).toHaveBeenCalledTimes(2);
  expect(f.quarantines).toEqual(["invalid-update","invalid-update"]);
  expect(f.relay.journalRows().journal).toEqual([]); expect(f.pending).toEqual([f.entry]); expect(f.receipts).toEqual([]);
});

it("admits a Try again granted before a relay restart once, under its original delivery, when the upgraded validator accepts it", async () => {
  const f = fixture();
  // The relay before its upgrade did not know this edit's schema.
  const older = vi.fn<OwnerOutboxAdmission["validate"]>(() => ({kind: "refused",reason: "invalid-schema",source: "final"}));
  expect(await f.run(older)).toEqual({admittedEntries: 0,hasMore: false});
  expect(f.commit.mock.results[0]!.value).toMatchObject({result: {kind: "refused",reason: "invalid-update"},admitted: null});
  f.native.retryDeliveryId = f.entry.deliveryId;
  const storage = f.restart(), commit = vi.spyOn(storage, "commitLiveUpdateJournal");
  expect(await f.run()).toEqual({admittedEntries: 1,hasMore: false});
  expect(f.validate).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls.map(([input]) => input.metadata)).toEqual([f.commit.mock.calls[0]![0].metadata]);
  const raw = new DatabaseSync(f.relay.path, {readOnly: true}); cleanup.push(() => raw.close());
  const journal = () => raw.prepare("SELECT delivery_id,principal_kind FROM sync_relay_live_update_journal").all();
  expect(journal()).toEqual([{delivery_id: f.entry.deliveryId,principal_kind: "owner"}]);
  expect(f.receipts).toMatchObject([{deliveryId: f.entry.deliveryId,updateDigest: f.entry.updateDigest}]);
  expect(f.native).toEqual({state: "active",quarantineReason: null,retryDeliveryId: null});
  expect(f.pending).toEqual([]); expect(f.applyThrough).toHaveBeenCalledTimes(1);
  expect(await f.run()).toEqual({admittedEntries: 0,hasMore: false});
  expect(commit).toHaveBeenCalledTimes(1); expect(journal()).toHaveLength(1);
});
