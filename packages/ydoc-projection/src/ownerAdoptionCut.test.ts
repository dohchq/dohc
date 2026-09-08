import { afterEach, expect, it } from "vitest";
import { cleanupLiveDeliveryFixtures, registered, host } from "./liveCommittedDeliveryTestSupport.js";
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import { liveDeliveryBookkeepingBytes } from "./liveDeliveryQuotaTestSupport.js";

afterEach(cleanupLiveDeliveryFixtures);

it("transfers owner metadata quota for all100 maximum-length selectors and detects selector changes", () => {
  const f = registered();
  try {
    const selectors = ["docs",...Array.from({length: 99},(_,index) => `${index}`.padEnd(1024,"x"))];
    f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='share'").run(JSON.stringify({paths: selectors,versionId: null}));
    const history = createLiveJournalHistoryAuthority({namespace: "owner-history",reconciled: true}), store = f.storage.createLiveCommittedDeliveryStore(history);
    const capture = store.captureOwnerCut({host,document: f.input.evidence.document,actor: {kind: "owner",userId: "owner",shareId: "share"},adoptionId: "origin",expectedLocalSequence: 0,maxBytes: 1_000_000,maxEvents: 10});
    expect(capture.binding.selectorPaths).toHaveLength(100);
    const before = Number(f.journalRows().usage)-liveDeliveryBookkeepingBytes(f.raw);
    store.acknowledgeOwnerAdoption(capture,{adoptionId: "origin",localYDocSequence: 0,terminalCursor: 0,adoptionReplayed: false});
    expect(Number(f.journalRows().usage)-liveDeliveryBookkeepingBytes(f.raw)).toBe(before);
    const row = f.raw.prepare("SELECT origin_json FROM sync_relay_live_delivery_owners").get()!;
    expect(Buffer.byteLength(String(row.origin_json))).toBeLessThan(4096);
    f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='share'").run(JSON.stringify({paths: ["docs/a.md"],versionId: null}));
    expect(() => capture.assertCurrent()).toThrow();
  } finally {f.close();}
});

it("records owner origin and ACK progress with exact quota transfer and restart replay", () => {
  const f = registered();
  try {
    const history = createLiveJournalHistoryAuthority({namespace: "owner-history",reconciled: true}), store = f.storage.createLiveCommittedDeliveryStore(history);
    const first = f.storage.commitLiveUpdateJournal(f.capture(f.update("one","first"),"first"));
    expect(first.result.kind).toBe("accepted");
    const input = {host,document: f.input.evidence.document,adoptionId: "origin",expectedLocalSequence: 1,maxBytes: 1_000_000,maxEvents: 10};
    const capture = store.captureOwnerCut(input), cursor = capture.cut.terminalReceipt!.journalCursor;
    const delta = Number(f.journalRows().usage)-liveDeliveryBookkeepingBytes(f.raw);
    const ack = {adoptionId: "origin",localYDocSequence: 1,terminalCursor: cursor,adoptionReplayed: false};
    store.acknowledgeOwnerAdoption(capture,ack);
    expect(Number(f.journalRows().usage)-liveDeliveryBookkeepingBytes(f.raw)).toBe(delta);
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_delivery_bootstraps").get()!.count).toBe(0);
    const usage = f.journalRows().usage;
    store.acknowledgeOwnerAdoption(capture,{...ack,adoptionReplayed: true});
    expect(f.journalRows().usage).toBe(usage);
    expect(f.storage.commitLiveUpdateJournal(f.capture(f.update("two","second"),"second")).result.kind).toBe("accepted");
    const replay = store.captureOwnerCut({...input,throughCursor: cursor});
    expect(replay.cut.events).toHaveLength(1);
    store.acknowledgeOwnerAdoption(replay,{...ack,adoptionReplayed: true});
    const latest = store.captureOwnerCut(input), receipt = latest.cut.terminalReceipt!;
    const before = Number(f.journalRows().usage)-liveDeliveryBookkeepingBytes(f.raw);
    const updateAck = {...receipt,localYDocSequence: 2,applicationReplayed: false};
    store.acknowledgeOwnerApplication(latest,updateAck);
    expect(store.ownerProgress(latest)).toEqual({terminal: receipt,sequence: 2});
    expect(Number(f.journalRows().usage)-liveDeliveryBookkeepingBytes(f.raw)).toBe(before);
    store.acknowledgeOwnerApplication(latest,{...updateAck,applicationReplayed: true});
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_delivery_reservations").get()!.count).toBe(0);
  } finally { f.close(); }
});

it("captures the original relay source and every admitted event within explicit bounds", () => {
  const f = registered();
  try {
    const history = createLiveJournalHistoryAuthority({ namespace: "owner-history", reconciled: true });
    const store = f.storage.createLiveCommittedDeliveryStore(history);
    for (const index of [1,2]) expect(f.storage.commitLiveUpdateJournal(f.capture(f.update(`field${index}`,`value${index}`),`delivery${index}`)).result.kind).toBe("accepted");
    const input = { host, document: f.input.evidence.document, adoptionId: "adoption", expectedLocalSequence: 2, maxBytes: 1_000_000, maxEvents: 10 };
    const before = f.journalRows();
    const captured = store.captureOwnerCut(input);
    expect(captured.cut.baselineBytes).toEqual(f.input.baselineBytes);
    const source = f.raw.prepare("SELECT moment_id FROM sync_relay_object_moments WHERE relay_seq=1").get()!;
    expect(captured.cut.sourceMomentId).toBe(source.moment_id);
    expect(captured.cut.events.map(event => event.metadata.accepted.receipt.deliveryId)).toEqual(["delivery1","delivery2"]);
    expect(captured.cut.terminalReceipt).toEqual(captured.cut.events[1]!.metadata.accepted.receipt);
    captured.assertCurrent();
    expect(f.journalRows()).toEqual(before);
    expect(() => store.captureOwnerCut({ ...input, maxEvents: 1 })).toThrow(/bounds/);
    expect(() => store.captureOwnerCut({ ...input, maxBytes: 1 })).toThrow(/bounds/);
    history.markUnreconciled();
    expect(() => captured.assertCurrent()).toThrow();
  } finally { f.close(); }
});
