import {afterEach, expect, it, vi} from "vitest";
import * as Y from "yjs";
import {policy, hash, cleanupLiveDeliveryFixtures} from "./liveCommittedDeliveryTestSupport.js";
import {fixture, bootstrapAck, applicationAck} from "./liveRestoreFixture.integration-helper.js";
import {resolveLiveRestorePoint} from "./liveRestorePoint.js";
import {yDocToMarkdown} from "./import-export.js";
import {liveBaselineStoredBytes} from "./liveBaselineQuotaTestSupport.js";
import {journalMetadataBytes, liveDeliveryBookkeepingBytes} from "./liveDeliveryQuotaTestSupport.js";
import {liveJournalHistoryNamespace} from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import {appendValidatedLiveJournal} from "../../../services/sync-relay/src/storage/liveUpdateJournal.js";

afterEach(cleanupLiveDeliveryFixtures);

it("checkpoints exactly the 4095th real delivery including no-ops, restores its suffix, and refuses stale checkpoint authority", () => {
  const f = fixture("bootstrap", "service");
  try {
    const receipts: ReturnType<typeof f.add>[] = [];
    const changed = f.update("checkpoint", "checkpoint");
    const noop = Y.encodeStateAsUpdate(f.doc, Y.encodeStateVector(f.doc));
    expect([...noop]).toEqual([0, 0]);
    const stateCapture = vi.fn(() => {f.raw.exec("BEGIN IMMEDIATE"); f.raw.exec("ROLLBACK");});
    const commit = (bytes: Uint8Array, index: number) => {
      const input = f.capture(bytes, `checkpoint-${index}`, f.actor, stateCapture);
      expect(input.validation.kind).toBe("accepted");
      const committed = f.storage.commitLiveUpdateJournal(input);
      expect(committed.result).toMatchObject({kind: "accepted", replayed: false, receipt: {journalCursor: index + 1}});
      if (committed.result.kind !== "accepted") throw Error(committed.result.kind);
      receipts.push(committed.result.receipt);
      return committed.admitted!.metadata;
    };
    const opening = commit(changed, 0);
    expect(opening.firstSeen.length).toBeGreaterThan(0);
    // A real commit rereads its whole suffix, so 4095 of them take minutes. Seed the middle
    // through the append that ends every real commit; the boundary commits stay real.
    const template = f.capture(noop, "template");
    f.context.tx(() => {
      let prior = opening;
      for (let index = 1; index < 4093; index++) {
        prior = appendValidatedLiveJournal(f.context, {document: f.document, namespace: liveJournalHistoryNamespace(f.context),
          host: template.host, current: {binding: template.metadata.binding, authority: template.expectedAuthority},
          metadata: {deliveryId: `checkpoint-${index}`, updateDigest: template.metadata.updateDigest}, updateBytes: Uint8Array.from(noop),
          receivedAtMs: template.receivedAtMs, firstSeen: [], checkpointBytes: null, checkpointDigest: null, priorMetadata: prior}).metadata;
        receipts.push(prior.accepted.receipt);
      }
    });
    expect(commit(noop, 4093).firstSeen).toEqual([]);
    expect(stateCapture).not.toHaveBeenCalled();
    expect(f.storage.readLiveUpdateJournalCut({document: f.document}))
      .toMatchObject({kind: "cut", cut: {suffixCount: 4094, checkpoint: {cursor: null}}});
    expect(commit(noop, 4094).firstSeen).toEqual([]);
    expect(stateCapture).toHaveBeenCalledTimes(1);
    const cut = f.storage.readLiveUpdateJournalCut({document: f.document});
    expect(cut).toMatchObject({kind: "cut", cut: {highWater: 4095, checkpoint: {cursor: 4095}, suffixCount: 0, suffixBytes: 0}});
    if (cut.kind !== "cut") throw Error(cut.kind);
    const checkpoint = Uint8Array.from(cut.cut.checkpoint.bytes);
    expect(checkpoint).toEqual(Y.encodeStateAsUpdate(f.doc));
    expect(checkpoint).not.toEqual(f.input.baselineBytes);
    expect(f.journalRows().usage).toBe(liveBaselineStoredBytes(f.raw) + changed.byteLength + noop.byteLength * 4094 + checkpoint.byteLength
      + journalMetadataBytes(f.raw) + liveDeliveryBookkeepingBytes(f.raw));
    const next = f.storage.commitLiveUpdateJournal(f.capture(noop, "next"));
    expect(next.result.kind).toBe("accepted");
    if (next.result.kind !== "accepted") throw Error(next.result.kind);
    receipts.push(next.result.receipt);
    expect(f.storage.readLiveUpdateJournalCut({document: f.document}))
      .toMatchObject({kind: "cut", cut: {highWater: 4096, suffixCount: 1, checkpoint: {cursor: 4095}}});
    const point = f.add("point"), expected = hash(Buffer.from(yDocToMarkdown(f.doc)));
    receipts.push(point, f.add("future"));
    expect(receipts).toHaveLength(4098);
    f.intent.restorePointCursor = point.journalCursor;
    f.intent.restorePointReceiptDigest = point.updateDigest;
    f.fence();
    const drain = f.open(), first = f.store.nextStopRestoreCut(drain);
    if (first.kind !== "bootstrap") throw Error(first.kind);
    f.store.acknowledgeStopRestoreBootstrap(drain, bootstrapAck(first.baseline));
    // Each acknowledgement is its own durable transaction, which sets this test's timeout.
    for (const [index, receipt] of receipts.entries()) {
      f.store.acknowledgeStopRestoreApplication(drain, receipts[index - 1] ?? null, applicationAck(receipt, index + 1));
    }
    f.store.completeStopRestoreCut(drain);
    const nativeReceipt = {operation: f.store.pendingStopRestoreFence(f.lookup).operation, localHeadSequence: receipts.length, recordedAtMs: 100};
    f.store.acknowledgeStopRestoreFence(f.lookup, nativeReceipt);
    const input = {...f.lookup, maxBytes: 1_000_000, maxEvents: 10};
    const capture = f.store.captureStopRestorePoint(input);
    expect(capture.checkpoint).toEqual({cursor: 4095, bytes: checkpoint, digest: hash(checkpoint)});
    expect(capture.events.map(event => event.metadata.accepted.receipt)).toEqual([next.result.receipt, point]);
    expect(resolveLiveRestorePoint(capture, policy)).toEqual({journalCursor: point.journalCursor, receiptDigest: point.updateDigest,
      markdownDigest: expected, projectionDigest: expected});
    expect(expected).not.toBe(hash(Buffer.from(yDocToMarkdown(f.doc))));
    const original = f.raw.prepare("SELECT current_path,restore_fence_generation FROM sync_relay_live_update_journal WHERE journal_cursor=4095").get()!;
    const before = f.journalRows();
    for (const [column, value] of [["current_path", "docs/stale.md"], ["restore_fence_generation", 2]] as const) {
      try {
        f.raw.prepare(`UPDATE sync_relay_live_update_journal SET ${column}=? WHERE journal_cursor=4095`).run(value);
        expect(() => f.store.captureStopRestorePoint(input)).toThrow();
      } finally {
        f.raw.prepare(`UPDATE sync_relay_live_update_journal SET ${column}=? WHERE journal_cursor=4095`).run(original[column]!);
      }
    }
    expect(f.journalRows()).toEqual(before);
    expect(resolveLiveRestorePoint(f.store.captureStopRestorePoint(input), policy)).toEqual(resolveLiveRestorePoint(capture, policy));
  } finally {f.close();}
}, 180_000);
