import {afterEach, expect, it, vi} from "vitest";
import * as Y from "yjs";
import {registered, cleanupLiveDeliveryFixtures} from "./liveCommittedDeliveryTestSupport.js";
import {createLiveJournalHistoryAuthority} from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import {readAcceptedHistory, RestoreHistoryBudget} from "../../../services/sync-relay/src/storage/liveAcceptedHistory.js";
import type {StorageContext} from "../../../services/sync-relay/src/storage/context.js";

afterEach(() => {vi.restoreAllMocks(); cleanupLiveDeliveryFixtures();});

it("refuses fragmented provenance before loading rows beyond the restore budget", () => {
  const f = registered(), storage = f.storage as StorageContext;
  try {
    f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace: "budget-test", reconciled: true}));
    const updates: Uint8Array[] = [];
    for (let i = 0; i < 64; i++) {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, f.input.baselineBytes);
        const vector = Y.encodeStateVector(doc);
        doc.getMap("frontmatter").set(`contributor-${i}`, "value");
        updates.push(Y.encodeStateAsUpdate(doc, vector));
      } finally {doc.destroy();}
    }
    const document = f.input.evidence.document;
    const current = f.storage.resolveCurrentLiveDocumentBinding({document, actor: f.actor});
    if (current.kind !== "current") throw Error(current.kind);
    const committed = f.storage.commitLiveUpdateJournal(f.capture(Y.mergeUpdates(updates))).result;
    if (committed.kind !== "accepted") throw Error(committed.kind);
    const header = f.raw.prepare("SELECT length(update_bytes) AS bytes,accepted_metadata_bytes FROM sync_relay_live_update_journal").get()!;
    const legacyBudget = f.input.baselineBytes.byteLength + Number(header.bytes) + Number(header.accepted_metadata_bytes);
    const input = {document, namespace: "budget-test", through: committed.receipt.journalCursor,
      baseline: f.input.baselineBytes, baselineDigest: document.lineageClaimId, originBinding: current.binding};
    const reads = vi.spyOn(storage.db, "prepare");
    expect(() => readAcceptedHistory(storage, input, new RestoreHistoryBudget(legacyBudget, 10))).toThrow("configured byte bounds");
    expect(reads.mock.calls.some(([sql]) => /^SELECT \* FROM sync_relay_live_update_(journal|struct_provenance)/.test(sql))).toBe(false);
    reads.mockRestore();
    const history = readAcceptedHistory(storage, input, new RestoreHistoryBudget(1_000_000, 10));
    expect(history.events).toHaveLength(1);
    expect(history.events[0]!.metadata.firstSeen).toHaveLength(64);
  } finally {f.close();}
});
