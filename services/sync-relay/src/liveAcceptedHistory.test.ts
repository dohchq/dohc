import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import {
  parseAdmittedLiveUpdateMetadata,
  type AdmittedLiveUpdateMetadata,
} from "@dohc/live-session-contract/live-update-admission";
import {
  canonicalAcceptedMetadata,
  canonicalVersionedAcceptedMetadata,
  initialAcceptedHistoryDigest,
  nextAcceptedHistoryDigest,
  nextVersionedAcceptedHistoryDigest,
} from "./liveAcceptedHistory";

const fixture = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL(
        "../../../packages/ydoc-projection/src/fixtures/native-accepted-history/small.json.gz",
        import.meta.url,
      ),
    ),
  ).toString(),
) as {
  acceptedEvents: { metadataJson: string; evidenceDigest: string }[];
};
const legacy = () =>
  parseAdmittedLiveUpdateMetadata(JSON.parse(fixture.acceptedEvents[0]!.metadataJson));
const modern = (metadata = legacy()): AdmittedLiveUpdateMetadata => ({
  ...metadata,
  canonicalVersion: 2,
  authorSnapshot: [{ kind: "human", humanId: "alice", humanName: "Alice" }],
  firstSeenDeletes: [{ clientId: 7, startClock: 1, endClock: 3 }],
});
it("keeps the native v1 canonical bytes and event digests unchanged", () => {
  const old = legacy(),
    initial = initialAcceptedHistoryDigest("namespace", old.accepted.binding);
  expect(JSON.stringify(canonicalAcceptedMetadata(old))).toBe(
    fixture.acceptedEvents[0]!.metadataJson,
  );
  expect(JSON.stringify(canonicalVersionedAcceptedMetadata(old))).toBe(
    fixture.acceptedEvents[0]!.metadataJson,
  );
  expect(nextAcceptedHistoryDigest(initial, 1, old)).toBe(
    fixture.acceptedEvents[0]!.evidenceDigest,
  );
  expect(nextVersionedAcceptedHistoryDigest(initial, 1, old)).toBe(
    fixture.acceptedEvents[0]!.evidenceDigest,
  );
});

it("uses the v2 field order and binds authors, deletion ranges and checkpoint coverage", () => {
  const old = legacy(),
    metadata = modern(old);
  const reordered: AdmittedLiveUpdateMetadata = {
    ...metadata,
    authorSnapshot: [{ humanName: "Alice", humanId: "alice", kind: "human" }],
    firstSeenDeletes: [{ endClock: 3, startClock: 1, clientId: 7 }],
  };
  const canonical = canonicalVersionedAcceptedMetadata(reordered);
  const json =
    fixture.acceptedEvents[0]!.metadataJson.slice(0, -1) +
    ',"canonicalVersion":2,"authorSnapshot":[{"kind":"human","humanId":"alice","humanName":"Alice"}],"firstSeenDeletes":[{"clientId":7,"startClock":1,"endClock":3}]}';
  expect(JSON.stringify(canonical)).toBe(json);
  const initial = initialAcceptedHistoryDigest("namespace", old.accepted.binding);
  const evidence = createHash("sha256")
    .update(`["accepted-event-v2","${initial}",1,${json}]`)
    .digest("hex");
  expect(nextVersionedAcceptedHistoryDigest(initial, 1, reordered)).toBe(evidence);
  expect(
    nextVersionedAcceptedHistoryDigest(initial, 1, { ...metadata, authorSnapshot: [] }),
  ).not.toBe(evidence);
  expect(
    nextVersionedAcceptedHistoryDigest(initial, 1, { ...metadata, firstSeenDeletes: [] }),
  ).not.toBe(evidence);
  expect(
    nextVersionedAcceptedHistoryDigest(initial, 1, { ...metadata, checkpointCoverage: [] }),
  ).not.toBe(evidence);
  const checkpoint = {
    ...metadata,
    checkpointCoverage: [
      {
        author: { kind: "human" as const, humanId: "alice", humanName: "Alice" },
        structRanges: [],
        deletionRanges: metadata.firstSeenDeletes!,
      },
    ],
  };
  expect(Object.keys(canonicalVersionedAcceptedMetadata(checkpoint))).toEqual([
    "accepted",
    "firstSeen",
    "canonicalVersion",
    "authorSnapshot",
    "firstSeenDeletes",
    "checkpointCoverage",
  ]);
});

const shared = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/live-session-contract/vectors/live-update-admission-vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  acceptedHistoryDigests: {
    case: string;
    namespace: string;
    document: import("@dohc/live-session-contract").LiveDocumentKey;
    initialDigest: string;
    eventCount: number;
    metadata: AdmittedLiveUpdateMetadata;
    canonicalJson: string;
    eventDigest: string;
  }[];
};
it.each(shared.acceptedHistoryDigests.map((row) => [row.case, row] as const))(
  "matches the shared accepted-history vector: %s",
  (_case, row) => {
    expect(initialAcceptedHistoryDigest(row.namespace, row.document)).toBe(row.initialDigest);
    expect(JSON.stringify(canonicalVersionedAcceptedMetadata(row.metadata))).toBe(
      row.canonicalJson,
    );
    expect(
      nextVersionedAcceptedHistoryDigest(row.initialDigest, row.eventCount, row.metadata),
    ).toBe(row.eventDigest);
  },
);
