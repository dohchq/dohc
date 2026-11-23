import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { parseAdmittedLiveUpdateMetadata } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { registered, cleanupLiveDeliveryFixtures } from "./liveCommittedDeliveryTestSupport.js";
import {
  canonicalAcceptedMetadata,
  canonicalVersionedAcceptedMetadata,
  initialAcceptedHistoryDigest,
  nextAcceptedHistoryDigest,
  nextVersionedAcceptedHistoryDigest,
} from "../../../services/sync-relay/src/liveAcceptedHistory.js";
import {
  readAcceptedHistoryDelivery,
  readAcceptedHistoryDeliveryMetadata,
  readAcceptedHistoryInterval,
  RestoreHistoryBudget,
} from "../../../services/sync-relay/src/storage/liveAcceptedHistory.js";
import type { StorageContext } from "../../../services/sync-relay/src/storage/context.js";

afterEach(cleanupLiveDeliveryFixtures);

it("retains v2 metadata in bounded readers and refuses a rehashed v1 downgrade", () => {
  const fixture = JSON.parse(
    gunzipSync(
      readFileSync(new URL("./fixtures/native-accepted-history/small.json.gz", import.meta.url)),
    ).toString(),
  ) as {
    baselineBytes: number[];
    receiptJson: string;
    acceptedEvents: { metadataJson: string; updateBytes: number[] }[];
  };
  const { operation } = (
    JSON.parse(fixture.receiptJson) as {
      fence: { operation: { oldBinding: unknown; relayDatabaseNamespace: string } };
    }
  ).fence;
  const document = parseLiveObjectBinding(operation.oldBinding),
    namespace = operation.relayDatabaseNamespace;
  const baseline = Uint8Array.from(fixture.baselineBytes),
    f = registered({ baselineBytes: baseline });
  const initial = initialAcceptedHistoryDigest(namespace, document);
  let digest = initial;
  try {
    const metadata = fixture.acceptedEvents.map((event, index) => {
      const row = canonicalVersionedAcceptedMetadata({
        ...parseAdmittedLiveUpdateMetadata(JSON.parse(event.metadataJson)),
        canonicalVersion: 2,
        authorSnapshot: [{ kind: "human", humanId: "alice", humanName: "Alice" }],
        firstSeenDeletes: [],
      });
      const { receipt: r, binding: b, authority: a, receivedAtMs } = row.accepted;
      digest = nextVersionedAcceptedHistoryDigest(digest, index + 1, row);
      f.raw
        .prepare(`INSERT INTO sync_relay_live_update_journal(journal_cursor,delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,
        current_path,selector_paths_json,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation,accepting_host_epoch,received_at_ms,
        update_bytes,relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes,canonical_version,author_snapshot_json,first_seen_deletes_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          r.journalCursor,
          r.deliveryId,
          r.updateDigest,
          b.workspaceId,
          b.mainVersionId,
          b.objectId,
          b.lineageClaimId,
          b.currentPath,
          JSON.stringify(b.selectorPaths),
          b.restoreFenceGeneration,
          a.principalKind,
          a.principalId,
          a.grantId,
          a.grantGeneration,
          r.acceptingHostEpoch,
          receivedAtMs,
          Uint8Array.from(event.updateBytes),
          namespace,
          index + 1,
          digest,
          Buffer.byteLength(JSON.stringify(row)),
          2,
          JSON.stringify(row.authorSnapshot),
          "[]",
        );
      return row;
    });
    const through = metadata[1]!.accepted.receipt.journalCursor;
    const read = () =>
      readAcceptedHistoryInterval(
        f.storage as StorageContext,
        {
          document,
          namespace,
          selected: { eventCount: 0, terminal: null, evidenceDigest: initial },
          accepted: {
            eventCount: 2,
            terminal: metadata[1]!.accepted.receipt,
            evidenceDigest: digest,
          },
        },
        new RestoreHistoryBudget(64_000_000, 2),
      ).map((event) => event.metadata);
    expect(read()).toEqual(metadata);
    const delivery = {
      document,
      namespace,
      through,
      eventCount: 2,
      deliveryId: metadata[1]!.accepted.receipt.deliveryId,
    };
    expect(
      readAcceptedHistoryDeliveryMetadata(
        f.storage as StorageContext,
        delivery,
        new RestoreHistoryBudget(64_000_000, 1),
      ),
    ).toEqual(metadata[1]);
    expect(
      readAcceptedHistoryDelivery(
        f.storage as StorageContext,
        delivery,
        new RestoreHistoryBudget(64_000_000, 1),
      ),
    ).toEqual(metadata[1]);
    const cursor = through;
    f.raw
      .prepare(
        "UPDATE sync_relay_live_update_journal SET first_seen_deletes_json=? WHERE journal_cursor=?",
      )
      .run(" ".repeat(10_001) + "[]", cursor);
    expect(() =>
      readAcceptedHistoryDeliveryMetadata(
        f.storage as StorageContext,
        delivery,
        new RestoreHistoryBudget(10_000, 1),
      ),
    ).toThrow(/bounds/);
    f.raw
      .prepare(
        "UPDATE sync_relay_live_update_journal SET first_seen_deletes_json='[]',author_snapshot_json=? WHERE journal_cursor=?",
      )
      .run(JSON.stringify([{ kind: "human", humanId: "bob", humanName: "Bob" }]), cursor);
    expect(read).toThrow(/damaged/);
    const downgraded = canonicalAcceptedMetadata(metadata[1]!);
    const previous = nextVersionedAcceptedHistoryDigest(initial, 1, metadata[0]!);
    f.raw
      .prepare(`UPDATE sync_relay_live_update_journal SET canonical_version=1,author_snapshot_json=NULL,
      accepted_evidence_digest=?,accepted_metadata_bytes=? WHERE journal_cursor=?`)
      .run(
        nextAcceptedHistoryDigest(previous, 2, downgraded),
        Buffer.byteLength(JSON.stringify(downgraded)),
        cursor,
      );
    expect(read).toThrow(/damaged/);
  } finally {
    f.close();
  }
});
