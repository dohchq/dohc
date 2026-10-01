import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {expect, it} from "vitest";
import {parseAdmittedLiveUpdateMetadata, type AdmittedLiveUpdateMetadata} from "@dohc/live-session-contract/live-update-admission";
import {canonicalAcceptedMetadata, canonicalVersionedAcceptedMetadata, initialAcceptedHistoryDigest,
  nextAcceptedHistoryDigest, nextVersionedAcceptedHistoryDigest} from "./liveAcceptedHistory";
import {parseNativeRestoreProposalReceipt, type NativeRestoreHistoryProof} from "./liveRestoreProposal";

const fixture = JSON.parse(gunzipSync(readFileSync(new URL("../../../packages/ydoc-projection/src/fixtures/native-accepted-history/small.json.gz", import.meta.url))).toString()) as {
  receiptJson: string; acceptedEvents: {metadataJson: string; evidenceDigest: string}[];
};
const budget = {maxBytes: 1_000_000, maxEvents: 10};
const legacy = () => parseAdmittedLiveUpdateMetadata(JSON.parse(fixture.acceptedEvents[0]!.metadataJson));
const modern = (metadata = legacy()): AdmittedLiveUpdateMetadata => ({...metadata, canonicalVersion: 2,
  authorSnapshot: [{kind: "human", humanId: "alice", humanName: "Alice"}],
  firstSeenDeletes: [{clientId: 7, startClock: 1, endClock: 3}]});
const proofDigest = (history: NativeRestoreHistoryProof) => history.suffix.reduce((previous, event, index) =>
  nextVersionedAcceptedHistoryDigest(previous, history.checkpoint.eventCount + index + 1, event), history.checkpoint.evidenceDigest);

it("keeps the native v1 canonical bytes and event digests unchanged", () => {
  const old = legacy(), initial = initialAcceptedHistoryDigest("namespace", old.accepted.binding);
  expect(JSON.stringify(canonicalAcceptedMetadata(old))).toBe(fixture.acceptedEvents[0]!.metadataJson);
  expect(JSON.stringify(canonicalVersionedAcceptedMetadata(old))).toBe(fixture.acceptedEvents[0]!.metadataJson);
  expect(nextAcceptedHistoryDigest(initial, 1, old)).toBe(fixture.acceptedEvents[0]!.evidenceDigest);
  expect(nextVersionedAcceptedHistoryDigest(initial, 1, old)).toBe(fixture.acceptedEvents[0]!.evidenceDigest);
  expect(parseNativeRestoreProposalReceipt(fixture.receiptJson, budget).acceptedHistory.eventCount).toBe(2);
});

it("uses the v2 field order and binds authors, deletion ranges and checkpoint coverage", () => {
  const old = legacy(), metadata = modern(old);
  const reordered: AdmittedLiveUpdateMetadata = {...metadata,
    authorSnapshot: [{humanName: "Alice", humanId: "alice", kind: "human"}],
    firstSeenDeletes: [{endClock: 3, startClock: 1, clientId: 7}]};
  const canonical = canonicalVersionedAcceptedMetadata(reordered);
  const json = fixture.acceptedEvents[0]!.metadataJson.slice(0, -1) +
    ',"canonicalVersion":2,"authorSnapshot":[{"kind":"human","humanId":"alice","humanName":"Alice"}],"firstSeenDeletes":[{"clientId":7,"startClock":1,"endClock":3}]}';
  expect(JSON.stringify(canonical)).toBe(json);
  const initial = initialAcceptedHistoryDigest("namespace", old.accepted.binding);
  const evidence = createHash("sha256").update(`["accepted-event-v2","${initial}",1,${json}]`).digest("hex");
  expect(nextVersionedAcceptedHistoryDigest(initial, 1, reordered)).toBe(evidence);
  expect(nextVersionedAcceptedHistoryDigest(initial, 1, {...metadata, authorSnapshot: []})).not.toBe(evidence);
  expect(nextVersionedAcceptedHistoryDigest(initial, 1, {...metadata, firstSeenDeletes: []})).not.toBe(evidence);
  expect(nextVersionedAcceptedHistoryDigest(initial, 1, {...metadata, checkpointCoverage: []})).not.toBe(evidence);
  const checkpoint = {...metadata, checkpointCoverage: [{author: {kind: "human" as const, humanId: "alice", humanName: "Alice"},
    structRanges: [], deletionRanges: metadata.firstSeenDeletes!}]};
  expect(Object.keys(canonicalVersionedAcceptedMetadata(checkpoint))).toEqual([
    "accepted", "firstSeen", "canonicalVersion", "authorSnapshot", "firstSeenDeletes", "checkpointCoverage"]);
});

it("allows a v1-to-v2 suffix and refuses a validly hashed downgrade", () => {
  const receipt = parseNativeRestoreProposalReceipt(fixture.receiptJson, budget);
  receipt.acceptedHistory.suffix[1] = modern(receipt.acceptedHistory.suffix[1]);
  receipt.acceptedHistory.evidenceDigest = proofDigest(receipt.acceptedHistory);
  expect(parseNativeRestoreProposalReceipt(JSON.stringify(receipt), budget).acceptedHistory.suffix[1]!.canonicalVersion).toBe(2);
  receipt.acceptedHistory.suffix[0] = modern(receipt.acceptedHistory.suffix[0]);
  receipt.acceptedHistory.suffix[1] = canonicalAcceptedMetadata(receipt.acceptedHistory.suffix[1]!);
  receipt.acceptedHistory.evidenceDigest = proofDigest(receipt.acceptedHistory);
  expect(() => parseNativeRestoreProposalReceipt(JSON.stringify(receipt), budget)).toThrow(/inconsistent/);
});

it("refuses downgrade across a v2 checkpoint boundary", () => {
  const receipt = parseNativeRestoreProposalReceipt(fixture.receiptJson, budget), history = receipt.acceptedHistory;
  const first = modern(history.suffix[0]), second = history.suffix[1]!;
  const evidence = nextVersionedAcceptedHistoryDigest(history.checkpoint.evidenceDigest, 1, first);
  history.checkpoint = {...history.checkpoint, eventCount: 1, terminal: first.accepted.receipt,
    canonicalVersion: 2, evidenceDigest: evidence};
  history.suffix = [second];history.evidenceDigest = proofDigest(history);
  expect(() => parseNativeRestoreProposalReceipt(JSON.stringify(receipt), budget)).toThrow(/inconsistent/);
  history.suffix = [modern(second)];history.evidenceDigest = proofDigest(history);
  expect(parseNativeRestoreProposalReceipt(JSON.stringify(receipt), budget).acceptedHistory.checkpoint.canonicalVersion).toBe(2);
});
