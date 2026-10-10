import {afterEach, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {registered, cleanupLiveDeliveryFixtures} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {canonicalVersionedAcceptedMetadata} from "../liveAcceptedHistory";
import {parseAuthenticatedLogOps} from "../relayLogInputs";

afterEach(cleanupLiveDeliveryFixtures);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function application(inBatch = false) {
  const f = registered({deployment: true});
  const captured = f.capture(f.update(), "recipient-edit", {kind: "named", userId: "reader", grantId: "grant"});
  const admitted = f.storage.commitLiveUpdateJournal({...captured, trustedAccount: {accountId: "reader", name: "Reader"},
    metadata: {...captured.metadata, authorContext: {kind: "account", accountId: "reader"}}});
  expect(admitted.result.kind).toBe("accepted");
  const metadata = canonicalVersionedAcceptedMetadata(admitted.admitted!.metadata);
  const row = f.journalRows().journal[0]!;
  const content = {versionId: "main", objectId: "object", path: metadata.accepted.binding.currentPath,
    lineageClaimId: metadata.accepted.binding.lineageClaimId, contentKind: "richdoc", updateBlobSha256: metadata.accepted.receipt.updateDigest};
  f.storage.putBlob({workspaceId: "workspace", sha256: content.updateBlobSha256, content: captured.updateBytes, createdAtMs: 1});
  const contentOps = [
    {originSeq: 0, opKind: "ydoc.update", payloadJson: JSON.stringify(content), recordedAtMs: 1},
    {originSeq: 1, opKind: "ydoc.update", payloadJson: JSON.stringify({...content, path: "other.md"}), recordedAtMs: 1},
  ];
  if (!inBatch) f.storage.appendLogBatch({workspaceId: "workspace", originId: "device", ops: contentOps});
  const record = {kind: "application", relayDatabaseNamespace: String(row.relay_database_namespace), eventCount: Number(row.accepted_event_count),
    evidenceDigest: String(row.accepted_evidence_digest), updateByteLength: captured.updateBytes.byteLength, metadata,
    sourceApplication: null, sourceRestore: null, contentCoordinate: {originId: "device", originSeq: 0}};
  const publish = async (edit: (value: typeof record) => void = () => {}, forgedCarrier = false) => {
    const value = structuredClone(record); edit(value);
    const bytes = Buffer.from(JSON.stringify(value)), digest = hash(bytes);
    f.storage.putBlob({workspaceId: "workspace", sha256: digest, content: bytes, createdAtMs: 1});
    const raw = {originSeq: 2, opKind: "live.audit.application", recordedAtMs: 1,
      ...(forgedCarrier ? {admittedAuthorSnapshot: [{kind: "human", humanId: "forged", humanName: "Forged"}]} : {}),
      payload: {relayDatabaseNamespace: value.relayDatabaseNamespace, mainVersionId: value.metadata.accepted.binding.mainVersionId,
        objectId: value.metadata.accepted.binding.objectId, lineageClaimId: value.metadata.accepted.binding.lineageClaimId,
        eventCount: value.eventCount, manifest: {formatVersion: 1, recordDigest: digest, byteLength: bytes.byteLength,
          chunks: [{sha256: digest, byteLength: bytes.byteLength}]}, updateBlobSha256: value.metadata.accepted.receipt.updateDigest}};
    const ops = await parseAuthenticatedLogOps([raw, {originSeq: 3, opKind: "opaque", payload: {}, recordedAtMs: 1}], "owner");
    f.storage.appendLogBatch({workspaceId: "workspace", originId: "device", ops: inBatch ? [...contentOps, ...ops] : ops});
    expect(f.storage.maxOriginSeq("workspace", "device")).toBe(3);
    return f.storage.fetchLogCoordinate({workspaceId: "workspace", originId: "device", originSeq: 2});
  };
  return {...f, publish};
}

it("confirms an audit application only with the relay journal snapshot", async () => {
  const f = application();
  try {
    expect(await f.publish()).toMatchObject({admittedAuthorSnapshot: [{kind: "human", humanId: "reader", humanName: "Reader"}]});
  } finally {f.close();}
});

it("confirms content earlier in the same batch and retains confirmation on retry", async () => {
  const f = application(true);
  try {
    const first = await f.publish();
    expect(first).toHaveProperty("admittedAuthorSnapshot");
    expect(await f.publish()).toEqual(first);
  } finally {f.close();}
});

it.each(["person", "document", "coordinate", "unknown", "marker", "cursor", "evidence", "namespace", "future-coordinate"] as const)("keeps the log flowing without confirming a %s mismatch", async (mismatch) => {
  const f = application();
  try {
    const op = await f.publish(record => {
      if (mismatch === "person") Object.assign(record.metadata, {authorSnapshot: [{kind: "human", humanId: "forged", humanName: "Forged"}]});
      if (mismatch === "document") Object.assign(record.metadata.accepted.binding, {objectId: "other"});
      if (mismatch === "coordinate") record.contentCoordinate.originSeq = 1;
      if (mismatch === "unknown") Object.assign(record.metadata.accepted.receipt, {deliveryId: "unknown"});
      if (mismatch === "marker") Object.assign(record.metadata.authorSnapshot![0]!, {relayConfirmed: true});
      if (mismatch === "cursor") Object.assign(record.metadata.accepted.receipt, {journalCursor: 999});
      if (mismatch === "evidence") record.evidenceDigest = "0".repeat(64);
      if (mismatch === "namespace") record.relayDatabaseNamespace = "another-relay";
      if (mismatch === "future-coordinate") record.contentCoordinate.originSeq = 3;
    }, true);
    expect(op).not.toHaveProperty("admittedAuthorSnapshot");
  } finally {f.close();}
});
