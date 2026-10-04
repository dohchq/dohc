import {readFileSync} from "node:fs";
import {expect, it} from "vitest";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import type {AdmittedLiveUpdateMetadata} from "@dohc/live-session-contract/live-update-admission";
import {canonicalAcceptedMetadata, initialAcceptedHistoryDigest, nextAcceptedHistoryDigest} from "./liveAcceptedHistory";

// The native engine hashes the same bytes. These digests were computed from the
// literal JSON below with sha256sum, independently of this module.
const document = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "b".repeat(64)};
const metadata: AdmittedLiveUpdateMetadata = {
  accepted: {
    receipt: {deliveryId: "delivery-1", updateDigest: "a".repeat(64), journalCursor: 1, acceptingHostEpoch: parseHostEpoch(1)},
    binding: {...document, currentPath: "docs/a.md", selectorPaths: ["docs"], restoreFenceGeneration: 0},
    authority: {principalKind: "owner", principalId: "owner", grantId: null, grantGeneration: null},
    receivedAtMs: 30,
  },
  firstSeen: [{clientId: 1, startClock: 0, endClock: 2}],
};
const absentJson = `{"accepted":{"receipt":{"deliveryId":"delivery-1","updateDigest":"${"a".repeat(64)}","journalCursor":1,"acceptingHostEpoch":1},` +
  `"binding":{"workspaceId":"workspace","mainVersionId":"main","objectId":"object","lineageClaimId":"${"b".repeat(64)}","currentPath":"docs/a.md","selectorPaths":["docs"],"restoreFenceGeneration":0},` +
  `"authority":{"grantGeneration":null,"grantId":null,"principalId":"owner","principalKind":"owner"},"receivedAtMs":30},` +
  `"firstSeen":[{"clientId":1,"startClock":0,"endClock":2}]}`;
const initial = "0c9c20efaac4316fb778488adbd36bf99a1a6cbc2f1307bd5d1be64a02df8ceb";

// The native engine reads the same rows from the shared contract vectors.
const shared = JSON.parse(readFileSync(new URL("../../../packages/live-session-contract/vectors/live-update-admission-vectors.json", import.meta.url), "utf8")) as {
  acceptedHistoryDigests: {case: string; namespace: string; document: typeof document; initialDigest: string; eventCount: number;
    metadata: AdmittedLiveUpdateMetadata; canonicalJson: string; eventDigest: string}[];
};
it.each(shared.acceptedHistoryDigests.map(row => [row.case, row] as const))("matches the shared accepted-history vector: %s", (_case, row) => {
  expect(initialAcceptedHistoryDigest(row.namespace, row.document)).toBe(row.initialDigest);
  expect(JSON.stringify(canonicalAcceptedMetadata(row.metadata))).toBe(row.canonicalJson);
  expect(nextAcceptedHistoryDigest(row.initialDigest, row.eventCount, row.metadata)).toBe(row.eventDigest);
});

it("keeps an undeclared event's canonical bytes and evidence digest", () => {
  expect(initialAcceptedHistoryDigest("relay", document)).toBe(initial);
  expect(JSON.stringify(canonicalAcceptedMetadata(metadata))).toBe(absentJson);
  expect(nextAcceptedHistoryDigest(initial, 1, metadata)).toBe("ff31ce6590c8a8cf8a6095d29f68a2df1c91476e54882336f06b7e5790701ab6");
});

it("places a Unicode agent declaration after receivedAtMs in the hashed bytes", () => {
  // Members out of order and a stray member must not reach the hash.
  const declared = {...metadata, accepted: {...metadata.accepted,
    agentDeclaration: {depth: 2, onBehalfOf: "人", agentId: "trip-agent-ü", stray: true} as never}};
  expect(JSON.stringify(canonicalAcceptedMetadata(declared))).toBe(absentJson.replace(`"receivedAtMs":30}`,
    `"receivedAtMs":30,"agentDeclaration":{"agentId":"trip-agent-ü","onBehalfOf":"人","depth":2}}`));
  expect(nextAcceptedHistoryDigest(initial, 1, declared)).toBe("f49898b95992874ac8c7c13a068fc5d4cbf46f1344abc6a4fa3aa5565a170cf6");
  const unattributed = {...declared, accepted: {...declared.accepted, agentDeclaration: {agentId: "trip-agent-ü", onBehalfOf: null, depth: 2}}};
  expect(nextAcceptedHistoryDigest(initial, 1, unattributed)).not.toBe(nextAcceptedHistoryDigest(initial, 1, declared));
});
