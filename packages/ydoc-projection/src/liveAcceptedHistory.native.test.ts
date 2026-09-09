import {readFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {afterEach, expect, it} from "vitest";
import * as Y from "yjs";
import {parseAdmittedLiveUpdateMetadata} from "@dohc/live-session-contract/live-update-admission";
import {registered, cleanupLiveDeliveryFixtures, hash, policy} from "./liveCommittedDeliveryTestSupport.js";
import {resolveLiveRestorePoint} from "./liveRestorePoint.js";
import {canonicalAcceptedMetadata, initialAcceptedHistoryDigest, nextAcceptedHistoryDigest} from "../../../services/sync-relay/src/liveAcceptedHistory.js";
import {parseNativeRestoreProposalReceipt} from "../../../services/sync-relay/src/liveRestoreProposal.js";
import {readAcceptedHistory, readAcceptedHistoryDelivery, requireAcceptedHistoryProof, RestoreHistoryBudget} from "../../../services/sync-relay/src/storage/liveAcceptedHistory.js";
import type {StorageContext} from "../../../services/sync-relay/src/storage/context.js";

afterEach(cleanupLiveDeliveryFixtures);

it.each(["small", "long"])("authenticates the native %s history through retained relay checkpoints", size => {
  const fixture = JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/native-accepted-history/${size}.json.gz`, import.meta.url))).toString()) as {
    generatedFromCommit: string; baselineBytes: number[]; receiptJson: string;
    acceptedEvents: {eventCount: number; evidenceDigest: string; metadataJson: string; updateBytes: number[]}[];
  };
  expect(fixture.generatedFromCommit).toBe("e3af57cd5d896fe93f94c258dea02d3e1a84483a");
  const receipt = parseNativeRestoreProposalReceipt(fixture.receiptJson, {maxBytes: 64_000_000, maxEvents: 10});
  const binding = receipt.fence.operation.oldBinding, namespace = receipt.fence.operation.relayDatabaseNamespace;
  const baseline = Uint8Array.from(fixture.baselineBytes), f = registered({baselineBytes: baseline}), doc = new Y.Doc({gc: false});
  try {
    Y.applyUpdate(doc, baseline);
    let digest = initialAcceptedHistoryDigest(namespace, binding), count = 0, suffixBytes = 0, suffixCount = 0;
    const insert = f.raw.prepare(`INSERT INTO sync_relay_live_update_journal(journal_cursor,delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,
      current_path,selector_paths_json,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation,accepting_host_epoch,received_at_ms,
      update_bytes,validation_checkpoint_sha256,validation_checkpoint_bytes,relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertRange = f.raw.prepare(`INSERT INTO sync_relay_live_update_struct_provenance VALUES (?,?,?,?,?,?,?,?)`);
    f.raw.exec("BEGIN");
    for (const event of fixture.acceptedEvents) {
      const metadata = canonicalAcceptedMetadata(parseAdmittedLiveUpdateMetadata(JSON.parse(event.metadataJson)));
      expect(JSON.stringify(metadata)).toBe(event.metadataJson);
      digest = nextAcceptedHistoryDigest(digest, ++count, metadata);
      expect(digest).toBe(event.evidenceDigest);expect(count).toBe(event.eventCount);
      const bytes = Uint8Array.from(event.updateBytes), {receipt: r, binding: b, authority: a, receivedAtMs} = metadata.accepted;
      expect(hash(bytes)).toBe(r.updateDigest);Y.applyUpdate(doc, bytes);
      suffixBytes += bytes.byteLength;suffixCount++;
      const due = suffixCount === 4095 || suffixBytes >= 20_971_520;
      const checkpoint = due ? Y.encodeStateAsUpdate(doc) : null;
      insert.run(r.journalCursor,r.deliveryId,r.updateDigest,b.workspaceId,b.mainVersionId,b.objectId,b.lineageClaimId,b.currentPath,
        JSON.stringify(b.selectorPaths),b.restoreFenceGeneration,a.principalKind,a.principalId,a.grantId,a.grantGeneration,r.acceptingHostEpoch,receivedAtMs,
        bytes,checkpoint ? hash(checkpoint) : null,checkpoint,namespace,count,digest,Buffer.byteLength(event.metadataJson));
      for (const range of metadata.firstSeen) insertRange.run(b.workspaceId,b.mainVersionId,b.objectId,b.lineageClaimId,range.clientId,range.startClock,range.endClock,r.journalCursor);
      if (due) {suffixBytes = 0;suffixCount = 0;}
    }
    f.raw.exec("COMMIT");
    const totalSuffix = receipt.selectedHistory.suffix.length + receipt.acceptedHistory.suffix.length;
    expect(() => parseNativeRestoreProposalReceipt(fixture.receiptJson, {maxBytes: 64_000_000, maxEvents: totalSuffix - 1})).toThrow(/bound/);
    const budget = new RestoreHistoryBudget(64_000_000, totalSuffix);
    const read = (through: number) => readAcceptedHistory(f.storage as StorageContext, {document: binding,namespace,through,
      baseline,baselineDigest: hash(baseline),originBinding: binding}, budget);
    const selected = read(receipt.point.journalCursor), accepted = read(receipt.fence.operation.terminal!.journalCursor);
    expect(budget.events).toBe(0);
    requireAcceptedHistoryProof(selected.proof, receipt.selectedHistory);
    requireAcceptedHistoryProof(accepted.proof, receipt.acceptedHistory);
    const first = JSON.parse(fixture.acceptedEvents[0]!.metadataJson);
    expect(readAcceptedHistoryDelivery(f.storage as StorageContext, {document: binding,namespace,through: receipt.fence.operation.terminal!.journalCursor,
      eventCount: receipt.acceptedHistory.eventCount,deliveryId: first.accepted.receipt.deliveryId}, new RestoreHistoryBudget(64_000_000,1))).toEqual(first);
    expect(resolveLiveRestorePoint({target: "selected", binding, ...selected, point: receipt.point, assertCurrent() {}}, policy)).toEqual(receipt.point);
    if (size === "long") {
      expect(selected.proof.checkpoint.eventCount).toBe(4095);
      expect(selected.events).toHaveLength(2);expect(accepted.events).toHaveLength(3);
      const earlyRestore = structuredClone(receipt.acceptedHistory);earlyRestore.checkpoint.restoreOperationId = "unverified-restore";
      expect(() => requireAcceptedHistoryProof(accepted.proof, earlyRestore)).toThrow(/damaged/);
      const cursor = selected.proof.checkpoint.terminal!.journalCursor;
      f.raw.prepare("UPDATE sync_relay_live_update_journal SET restore_fence_generation=restore_fence_generation+1 WHERE journal_cursor=?").run(cursor);
      expect(() => readAcceptedHistory(f.storage as StorageContext, {document: binding,namespace,through: receipt.point.journalCursor,
        baseline,baselineDigest: hash(baseline),originBinding: binding}, new RestoreHistoryBudget(64_000_000,10))).toThrow(/damaged/);
      f.raw.prepare("UPDATE sync_relay_live_update_journal SET restore_fence_generation=restore_fence_generation-1 WHERE journal_cursor=?").run(cursor);
    } else {
      expect(selected.proof.checkpoint.eventCount).toBe(0);
      expect(fixture.acceptedEvents.map(e => JSON.parse(e.metadataJson).accepted.receipt.journalCursor)).toEqual([7, 11]);
      const originBinding = {...binding, selectorPaths: [binding.currentPath, "other.md"]};
      const adopted = readAcceptedHistory(f.storage as StorageContext, {document: binding,namespace,through: receipt.point.journalCursor,
        baseline,baselineDigest: hash(baseline),originBinding}, new RestoreHistoryBudget(64_000_000,10));
      expect(adopted.proof.checkpoint.binding).toEqual(originBinding);
      expect(adopted.proof.evidenceDigest).toBe(selected.proof.evidenceDigest);
    }
    const altered = structuredClone(receipt.acceptedHistory);altered.evidenceDigest = "f".repeat(64);
    expect(() => requireAcceptedHistoryProof(accepted.proof, altered)).toThrow(/damaged/);
    const endpoint = receipt.fence.operation.terminal!.journalCursor;
    f.raw.prepare("UPDATE sync_relay_live_update_journal SET received_at_ms=received_at_ms+1 WHERE journal_cursor=?").run(endpoint);
    expect(() => readAcceptedHistory(f.storage as StorageContext, {document: binding,namespace,through: endpoint,
      baseline,baselineDigest: hash(baseline),originBinding: binding}, new RestoreHistoryBudget(64_000_000,10))).toThrow(/damaged/);
  } finally {doc.destroy();f.close();}
});
