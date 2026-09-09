import {afterEach, expect, it, vi} from "vitest";
import type {EngineClient} from "../../workspace-engine-client/src/daemon/engineClient.js";
import type {LiveUpdateHostApplicationAck, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";
import type {OwnerOutboxAdmission} from "../../../services/sync-relay/src/ownerOutboxDelivery.js";
import {OwnerCommittedDelivery} from "../../../services/sync-relay/src/ownerCommittedDelivery.js";
import {createLiveJournalHistoryAuthority} from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import {createLiveMarkdownJournalValidator} from "./liveDocumentValidation.js";
import {registered, host, hash, policy, cleanupLiveDeliveryFixtures} from "./liveCommittedDeliveryTestSupport.js";

afterEach(() => {vi.restoreAllMocks(); cleanupLiveDeliveryFixtures();});

it("replays a real journal admission and retains the owner entry until native application and ACK", async () => {
  const f = registered();
  try {
    const history = createLiveJournalHistoryAuthority({namespace: "owner-outbox-retry",reconciled: true});
    const store = f.storage.createLiveCommittedDeliveryStore(history), document = f.input.evidence.document;
    const bounds = {maxBytes: 100_000,maxEvents: 1};
    const adoption = store.captureOwnerCut({host,document,actor: f.actor,adoptionId: "owner-adoption",
      expectedLocalSequence: 1,throughCursor: 0,...bounds});
    store.acknowledgeOwnerAdoption(adoption,{adoptionId: "owner-adoption",localYDocSequence: 1,terminalCursor: 0,adoptionReplayed: false});
    const binding = adoption.binding, update = f.update("title", "Retained owner edit");
    const entry = {sequence: 1,appendKey: "append-1",deliveryId: "owner-edit",updateDigest: hash(update),byteLength: update.byteLength,createdAtMs: 10};
    let pending = true, requestId = 0, nativeAck: LiveUpdateHostApplicationAck | null = null;
    const removed: LiveUpdateReceipt[] = [], order: string[] = [];
    const journalValidator = createLiveMarkdownJournalValidator(policy);
    const validate = vi.fn((input: Parameters<OwnerOutboxAdmission["validate"]>[0]) => journalValidator(input));
    const commits = vi.spyOn(f.storage,"commitLiveUpdateJournal");
    const cursor = (part: string, sequence = 0) => ({snapshot: hash(Buffer.from(String(pending))),part,sequence,offset: 0});
    // Only the native protocol is simulated. Both delivery layers, Yjs validation,
    // owner progress and journal replay use their production implementations.
    const client = {
      sendRequest: vi.fn<EngineClient["sendRequest"]>(async request => {
        const params = request.params as Record<string,unknown>;
        if (request.method === "liveApplication.register") return {id: request.id,result: {registrationId: 1}};
        if (request.method === "liveApplication.ownerOutbox") return {id: request.id,result: {outboxId: "outbox",pendingBytes: pending ? update.byteLength : 0,state: pending ? "sealed" : "active"}};
        if (request.method === "liveApplication.acknowledgeOwnerOutbox") {
          const receipts = params.receipts as LiveUpdateReceipt[];
          expect(receipts).toHaveLength(1);
          expect(nativeAck).toMatchObject(receipts[0]!);
          expect(store.ownerDeliveryProgress(store.openOwnerDelivery({host,document,actor: f.actor})).terminal).toEqual(receipts[0]);
          expect(order).toEqual(["native-application", "native-ack-read"]);
          order.push("outbox-remove"); removed.push(...receipts); pending = false;
          return {id: request.id,result: {acknowledged: 1,pendingBytes: 0,oldestEntryAtMs: null}};
        }
        expect(request.method).toBe("liveApplication.readOwnerOutbox");
        const current = (params.cursor ?? cursor("header")) as ReturnType<typeof cursor>;
        expect(current.snapshot).toBe(cursor("header").snapshot);
        let bytes: Uint8Array, nextCursor: ReturnType<typeof cursor> | null;
        if (current.part === "header") {
          bytes = Buffer.from(JSON.stringify({outboxId: "outbox",binding,baseUpdateDigest: binding.lineageClaimId,
            baseByteLength: f.input.baselineBytes.byteLength,state: pending ? "sealed" : "active",pendingBytes: pending ? update.byteLength : 0,
            pendingEntryCount: pending ? 1 : 0,nextSequence: 2,oldestEntryAtMs: pending ? 10 : null,
            quarantineReason: null,observedBinding: null,firstEntryCursor: pending ? cursor("entryHeader",1) : null}));
          nextCursor = cursor("base");
        } else if (current.part === "entryHeader") {
          expect(pending).toBe(true); bytes = Buffer.from(JSON.stringify(entry)); nextCursor = cursor("update",1);
        } else {
          expect(current.part).toBe("update"); expect(pending).toBe(true); bytes = update; nextCursor = null;
        }
        return {id: request.id,result: {kind: "page",...current,totalBytes: bytes.byteLength,digest: hash(bytes),bytesBase64: Buffer.from(bytes).toString("base64"),nextCursor}};
      }),
      sendLiveApplication: vi.fn<EngineClient["sendLiveApplication"]>(),
      readLiveApplicationAck: vi.fn<EngineClient["readLiveApplicationAck"]>(async (_request,identity) => {
        expect(nativeAck).not.toBeNull(); expect(nativeAck).toMatchObject(identity);
        order.push("native-ack-read"); return nativeAck;
      }),
    };
    const consumer = new OwnerCommittedDelivery(f.storage,history,{client: client as unknown as EngineClient,
      workspace: "handle",host,deadlineMs: 1_000,nextRequestId: () => ++requestId,bounds,
      ownerAdmission: {shares: new Map([[document.workspaceId,"share"]]),maxEntriesPerDrain: 1,maxBytesPerDrain: 100_000,validate}});
    client.sendLiveApplication.mockResolvedValueOnce({id: 1,result: {status: "pending",reason: "native busy"}});
    expect(await consumer.drain(document)).toMatchObject({kind: "pending",continueDrain: false});
    expect(pending).toBe(true); expect(removed).toEqual([]); expect(nativeAck).toBeNull();
    expect(client.readLiveApplicationAck).not.toHaveBeenCalled();
    const firstCommit = commits.mock.results[0]!.value as ReturnType<typeof f.storage.commitLiveUpdateJournal>;
    expect(firstCommit.result).toMatchObject({kind: "accepted",replayed: false});
    if (firstCommit.result.kind !== "accepted") throw Error("Expected relay admission.");
    const receipt = firstCommit.result.receipt, journal = f.journalRows().journal, provenance = f.journalRows().provenance;
    expect(journal).toHaveLength(1);
    expect(validate.mock.calls[0]![0].suffix).toEqual([]);
    let entered!: () => void, apply!: () => void;
    const applying = new Promise<void>(resolve => {entered = resolve;});
    const released = new Promise<void>(resolve => {apply = resolve;});
    client.sendLiveApplication.mockImplementationOnce(async (request,event) => {
      expect(event.metadata.accepted.receipt).toEqual(receipt);
      entered(); await released;
      nativeAck = {...receipt,localYDocSequence: 2,applicationReplayed: false};
      order.push("native-application");
      return {id: request.id,result: {status: "applied",ack: {...nativeAck}}};
    });
    const retry = consumer.drain(document);
    await Promise.race([applying,retry.then(() => {throw Error("Drain finished before native application.");})]);
    let outcome: Awaited<typeof retry>;
    try {
      expect(pending).toBe(true); expect(removed).toEqual([]); expect(nativeAck).toBeNull();
      expect(commits).toHaveBeenCalledTimes(2);
      const secondCommit = commits.mock.results[1]!.value as ReturnType<typeof f.storage.commitLiveUpdateJournal>;
      expect(secondCommit.result).toMatchObject({kind: "accepted",receipt,replayed: true});
      expect(validate.mock.calls[1]![0]).toMatchObject({suffix: [update],candidate: update});
      expect(f.journalRows().journal).toEqual(journal);
      expect(f.journalRows().provenance).toEqual(provenance);
    } finally {apply(); outcome = await retry;}
    expect(outcome).toMatchObject({kind: "done",terminalReceipt: receipt});
    expect(pending).toBe(false); expect(removed).toEqual([receipt]);
    expect(order).toEqual(["native-application","native-ack-read","outbox-remove"]);
    expect(client.sendLiveApplication).toHaveBeenCalledTimes(2);
    expect(client.readLiveApplicationAck).toHaveBeenCalledTimes(1);
    expect(f.journalRows().journal).toEqual(journal);
    expect(f.journalRows().provenance).toEqual(provenance);
  } finally {f.close();}
});
