import {afterEach, expect, it, vi} from "vitest";
import * as Y from "yjs";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {LiveUpdateHostApplicationAck, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";
import {createLiveMarkdownJournalValidator} from "@dohc/ydoc-projection/live-journal-validation";
import {cleanupLiveDeliveryFixtures, DatabaseSync, hash, policy, registered} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {captureNamedLiveFrameHost, createNamedFrameChanges} from "./namedLiveFrameHost";
import {createLiveTickets} from "./liveTickets";
import {liveBrowserActor} from "./liveBrowserContext";
import {drainOwnerOutbox, type OwnerOutboxAdmission} from "./ownerOutboxDelivery";
import type {StorageContext} from "./storage/context";

const cleanup: Array<() => void> = [];
afterEach(() => {for (const close of cleanup.splice(0).reverse()) close(); cleanupLiveDeliveryFixtures(); vi.restoreAllMocks();});
const validateJournal = createLiveMarkdownJournalValidator(policy);
function deferred() {
  let resolve!: () => void;
  return {promise: new Promise<void>(done => {resolve = done;}), resolve: () => resolve()};
}

function fixture() {
  const relay = registered({deployment: true,liveTickets: {retainedTicketsPerPrincipalGrant: 2,expiredTicketCleanupBatchSize: 1,now: () => 1_000}});
  cleanup.push(() => relay.close());
  const update = relay.update("owner", "Owner edit"), captured = relay.capture(update, "owner-delivery");
  const {binding} = captured.metadata, document = captured.cutToken.document, host = captured.host;
  const entry = {sequence: 1,appendKey: "owner-append",deliveryId: captured.metadata.deliveryId,
    updateDigest: hash(update),byteLength: update.byteLength,createdAtMs: 1};
  const pending = [entry], receipts: LiveUpdateReceipt[] = [];
  const cursor = (part: string) => ({snapshot: "a".repeat(64),part,sequence: part === "header" || part === "base" ? 0 : 1,offset: 0});
  const client = {sendRequest: vi.fn<EngineClient["sendRequest"]>(async request => {
    if (request.method === "liveApplication.ownerOutbox") return {id: request.id,result: {outboxId: "outbox",pendingBytes: pending.length * update.byteLength,state: "active"}};
    if (request.method === "liveApplication.acknowledgeOwnerOutbox") {
      const receipt = (request.params as unknown as {receipts: LiveUpdateReceipt[]}).receipts[0]!;
      expect(receipt).toMatchObject({deliveryId: entry.deliveryId,updateDigest: entry.updateDigest});
      receipts.push(receipt); pending.shift();
      return {id: request.id,result: {acknowledged: 1,pendingBytes: 0,oldestEntryAtMs: null}};
    }
    expect(request.method).toBe("liveApplication.readOwnerOutbox");
    const current = (request.params as {cursor?: ReturnType<typeof cursor>}).cursor ?? cursor("header");
    let bytes: Buffer, nextCursor: ReturnType<typeof cursor> | null;
    if (current.part === "header") {
      bytes = Buffer.from(JSON.stringify({outboxId: "outbox",binding,baseUpdateDigest: binding.lineageClaimId,
        baseByteLength: relay.input.baselineBytes.byteLength,state: "active",pendingBytes: pending.length * update.byteLength,
        pendingEntryCount: pending.length,nextSequence: 2,oldestEntryAtMs: pending.length ? 1 : null,quarantineReason: null,
        observedBinding: null,firstEntryCursor: pending.length ? cursor("entryHeader") : null}));
      nextCursor = cursor("base");
    } else if (current.part === "entryHeader") {
      bytes = Buffer.from(JSON.stringify(entry)); nextCursor = cursor("update");
    } else {
      expect(current.part).toBe("update"); bytes = Buffer.from(update); nextCursor = null;
    }
    return {id: request.id,result: {kind: "page",...current,totalBytes: bytes.byteLength,digest: hash(bytes),bytesBase64: bytes.toString("base64"),nextCursor}};
  })};
  const applyThrough = vi.fn(async (receipt: LiveUpdateReceipt): Promise<LiveUpdateHostApplicationAck> =>
    ({...receipt,localYDocSequence: receipt.journalCursor,applicationReplayed: false}));
  const validate = vi.fn<OwnerOutboxAdmission["validate"]>(input => validateJournal(input));
  const commit = vi.spyOn(relay.storage, "commitLiveUpdateJournal");
  let requestId = 0;
  const run = () => drainOwnerOutbox({storage: relay.storage,client: client as unknown as EngineClient,
    admission: {shares: new Map([[document.workspaceId,"share"]]),maxEntriesPerDrain: 1,maxBytesPerDrain: 10_000,validate},
    workspace: "handle",host,registrationId: 1,binding,nextRequestId: () => ++requestId,deadlineMs: 1_000,
    assertCurrent() {},applyThrough});
  return {relay,document,host,binding,entry,pending,receipts,applyThrough,validate,commit,run};
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

it("still throws on a genuine journal admission refusal and retains the owner head", async () => {
  const f = fixture();
  f.validate.mockReturnValueOnce({kind: "refused",reason: "invalid-update",source: "candidate"});
  await expect(f.run()).rejects.toThrow("Owner update admission refused.");
  expect(f.commit.mock.results[0]!.value).toMatchObject({result: {kind: "refused",reason: "invalid-update"},admitted: null});
  expect(f.relay.journalRows().journal).toEqual([]); expect(f.receipts).toEqual([]);
  expect(f.pending).toEqual([f.entry]); expect(f.applyThrough).not.toHaveBeenCalled();
});
