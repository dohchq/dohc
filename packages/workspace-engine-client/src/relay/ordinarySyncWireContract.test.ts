import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProtocolShapeError } from "../wireSchema";
import { decodeHostedSyncResult, decodeOrdinarySyncResult, releasedLineageBindingDigest } from "./ordinarySyncWireContract";
import vectors from "./releasedLineageBindingVectors.json" with { type: "json" };

const decline = { path: "work.md", objectId: "work.md", versionId: "main", lineagePruned: false, headBlobSha256: null, constraint: "MAX_YDOC_UPDATE_BYTES", limitBytes: 20, observedBytes: 21 };
const admission = { workspaceId: "workspace", originId: "owner", originSeq: 2, versionId: "main", objectId: "object", path: "work.md" };
const change = { versionId: "main", path: "work.md", operation: "write", contentKind: "text" };
const refusal = { workspaceId: "workspace", originId: "peer", originSeq: 1, opKind: "text.write", code: "invalid-input", reason: "Cannot apply this operation." };
const push = { status: "complete", pushed: 0, fetched: 0, applied: 0, refused: 0, skipped: 0, conflictsOpened: 0,
  hasMore: false, nextCursor: null, pendingCursor: null, changedPaths: [], refusals: [], ownerAdmissionPending: [admission], sharingDeclined: [decline] };
const pull = { ...push, fetched: 2, applied: 1, refused: 1, nextCursor: 9, pendingCursor: { kind: "relay", token: "opaque-issued-token" },
  ownerAdmissionPending: [], changedPaths: [change], refusals: [refusal] };

describe("ordinary native sync contract", () => {
  it("projects native push without requiring its null pull cursor fields", () => {
    expect(decodeOrdinarySyncResult("sync.push", push)).toEqual({ status: "complete", pushed: 0, hasMore: false,
      ownerAdmissionPending: [admission], sharingDeclined: [decline] });
  });

  it("preserves producing versions, full refusal evidence and the issued token", () => {
    expect(decodeOrdinarySyncResult("sync.pull", { ...pull, ignored: true,
      pendingCursor: { ...pull.pendingCursor, ignored: true } })).toEqual({ status: "complete", fetched: 2, applied: 1,
      refused: 1, skipped: 0, conflictsOpened: 0, hasMore: false, nextCursor: 9, pendingCursor: pull.pendingCursor,
      changedPaths: [change], refusals: [refusal], sharingDeclined: [decline] });
  });

  it.each(["objectId", "versionId", "lineagePruned", "headBlobSha256"] as const)(
    "rejects sharing declines without %s on every ordinary result", field => {
      const incomplete: Partial<typeof decline> = { ...decline };
      delete incomplete[field];
      for (const [method, result] of [
        ["sync.push", push], ["sync.pull", pull],
        ["sync.commitCursor", { committed: true }],
      ] as const) {
        expect(() => decodeOrdinarySyncResult(method, { ...result, sharingDeclined: [incomplete] }))
          .toThrow(ProtocolShapeError);
      }
    },
  );

  it.each([
    { fetched: undefined }, { applied: "1" }, { refused: null }, { nextCursor: -1 },
    { skipped: Number.MAX_SAFE_INTEGER + 1 }, { conflictsOpened: 0.5 }, { hasMore: null },
    { status: "crashedAfterApply" }, { status: "crashedAfterRemoteCommit" },
    { pendingCursor: null }, { pendingCursor: { kind: "shareView", token: "opaque-issued-token" } },
    { pendingCursor: { kind: "relay", token: "" } },
    { changedPaths: [{ ...change, versionId: undefined }] }, { changedPaths: [{ ...change, operation: "move" }] },
    { changedPaths: [{ ...change, contentKind: "unknown" }] }, { changedPaths: null },
    { refusals: [{ ...refusal, workspaceId: undefined }] }, { refusals: [{ ...refusal, reason: null }] },
    { sharingDeclined: [{ ...decline, objectId: "" }] }, { sharingDeclined: [{ ...decline, versionId: "" }] },
    { sharingDeclined: [{ ...decline, lineagePruned: "true" }] }, { sharingDeclined: [{ ...decline, path: "" }] }, { sharingDeclined: [{ ...decline, limitBytes: -1 }] },
    { sharingDeclined: [{ ...decline, observedBytes: Number.MAX_SAFE_INTEGER + 1 }] },
  ])("rejects an unusable pull result: %j", patch => {
    expect(() => decodeOrdinarySyncResult("sync.pull", { ...pull, ...patch })).toThrow(ProtocolShapeError);
    expect(() => decodeOrdinarySyncResult("sync.pull", { ...pull, ...patch })).toThrow("sync.pull result");
  });

  it.each([
    { status: "crashedAfterRemoteCommit" }, { pushed: null }, { hasMore: undefined },
    { ownerAdmissionPending: null }, { ownerAdmissionPending: [{}] },
    { ownerAdmissionPending: [{ ...admission, originSeq: -1 }] },
    { ownerAdmissionPending: [{ ...admission, objectId: null }] },
    { ownerAdmissionPending: [{ ...admission, versionId: "" }] },
  ])("rejects incomplete publication evidence: %j", patch => {
    expect(() => decodeOrdinarySyncResult("sync.push", { ...push, ...patch })).toThrow(ProtocolShapeError);
  });

  it("accepts secret deletion and strips unrelated fields", () => {
    expect(decodeOrdinarySyncResult("sync.pull", { ...pull,
      changedPaths: [{ ...change, operation: "delete", contentKind: "secret", ignored: true }] }).changedPaths)
      .toEqual([{ ...change, operation: "delete", contentKind: "secret" }]);
  });

  it("requires positive acknowledgements and complete decline evidence", () => {
    expect(decodeOrdinarySyncResult("sync.commitCursor", { committed: true, sharingDeclined: [decline] }).sharingDeclined).toEqual([decline]);
    expect(decodeOrdinarySyncResult("sync.materializePendingCursor", { materialized: true })).toEqual({ materialized: true });
    for (const value of [false, null, undefined, "true"]) {
      expect(() => decodeOrdinarySyncResult("sync.commitCursor", { committed: value, sharingDeclined: [] })).toThrow(ProtocolShapeError);
      expect(() => decodeOrdinarySyncResult("sync.materializePendingCursor", { materialized: value })).toThrow(ProtocolShapeError);
    }
    expect(() => decodeOrdinarySyncResult("sync.commitCursor", { committed: true })).toThrow(ProtocolShapeError);
  });
});

const holds = [
  { objectId: "a", reason: "hosted-backfill-path-held", path: "docs/a.md", heldBy: "b" },
  { objectId: "c", reason: "hosted-conflict-parent-withheld", conflictId: "conflict" },
  { objectId: "d", reason: "hosted-backfill-work-waiting" },
  { objectId: "e", reason: "hosted-scope-path-mismatch", scopePath: "docs/e.md", headPath: null },
  { objectId: "f", reason: "hosted-live-edit-unadmitted" },
  { objectId: "g", reason: "released-lineage-unsettled", binding: JSON.parse(vectors.valid[0]!.canonical),
    continuation: "frozen", bindingStale: false },
];
const hosted = { fetched: 2, applied: 1, refused: 1, skipped: 0, conflictsOpened: 0, hasMore: true,
  pendingCursor: { kind: "hosted", token: "opaque-issued-token" }, changedPaths: [change], refusals: [refusal], sharingDeclined: [], held: holds,
  departed: ["gone"] };

describe("hosted native sync contract", () => {
  it("keeps the issued hosted cursor, every hold with its fields, departed documents, and a pass that adopted a scope", () => {
    expect(decodeHostedSyncResult("sync.pullHosted", { ...hosted, ignored: true })).toEqual(hosted);
    expect(decodeHostedSyncResult("sync.pullHosted", { ...hosted, pendingCursor: null, held: [] }).pendingCursor).toBeNull();
  });

  it("keeps a commit that stands beside the retirement error after it, and unread departed documents", () => {
    const retirement = { code: "INTERNAL", message: "hosted file unexpected: docs/a.md", retry: "no" };
    const commit = { committed: true, hasMore: false, retirement, departed: ["gone"], sharingDeclined: [] };
    expect(decodeHostedSyncResult("sync.commitCursor", commit)).toEqual(commit);
    expect(decodeHostedSyncResult("sync.commitCursor", { ...commit, retirement: null, departed: null }).departed).toBeNull();
    expect(decodeHostedSyncResult("sync.commitCursor", { ...commit, committed: false, retirement: null }).committed).toBe(false);
  });

  it("keeps a released-lineage hold's binding exactly, so its digest is the engine's", () => {
    const held = decodeHostedSyncResult("sync.pullHosted", hosted).held[5]!;
    if (held.reason !== "released-lineage-unsettled") throw new Error("Expected the released-lineage hold.");
    expect(releasedLineageBindingDigest(held.binding)).toBe(vectors.valid[0]!.digest);
    const stale = { ...holds[5], continuation: "dependency-drain", bindingStale: true };
    expect(decodeHostedSyncResult("sync.pullHosted", { ...hosted, held: [stale] }).held).toEqual([stale]);
  });

  const binding = JSON.parse(vectors.valid[1]!.canonical);
  const v1 = vectors.invalid.find(vector => vector.name === "a version 1 binding")!;
  it.each([
    { held: [{ ...holds[5], binding: undefined }] }, { held: [{ ...holds[5], binding: { ...binding, extra: 1 } }] },
    { held: [{ ...holds[5], binding: JSON.parse(v1.text) }] },
    { held: [{ ...holds[5], binding: { ...binding, currentPath: undefined } }] },
    { held: [{ ...holds[5], binding: { ...binding, incoming: { ...binding.incoming, relaySeq: 0 } } }] },
    { held: [{ ...holds[5], continuation: "thawed" }] }, { held: [{ ...holds[5], continuation: undefined }] },
    { held: [{ ...holds[5], bindingStale: undefined }] }, { held: [{ ...holds[5], bindingStale: 0 }] },
  ])("rejects an unusable released-lineage hold: %j", patch => {
    expect(() => decodeHostedSyncResult("sync.pullHosted", { ...hosted, ...patch })).toThrow("hosted sync.pullHosted result");
  });

  it.each([
    { pendingCursor: { kind: "relay", token: "opaque-issued-token" } }, { pendingCursor: undefined }, { held: undefined },
    { held: [{ objectId: "a", reason: "hosted-backfill-path-held" }] }, { held: [{ objectId: "a", reason: "unknown" }] },
    { held: [{ ...holds[3], headPath: "" }] }, { status: "complete", nextCursor: 1, held: null },
    { departed: undefined }, { departed: null }, { departed: [""] },
  ])("rejects an unusable hosted pass: %j", patch => {
    expect(() => decodeHostedSyncResult("sync.pullHosted", { ...hosted, ...patch })).toThrow("hosted sync.pullHosted result");
  });

  it("rejects an ordinary pull and an ordinary commit as hosted results", () => {
    expect(() => decodeHostedSyncResult("sync.pullHosted", pull)).toThrow(ProtocolShapeError);
    expect(() => decodeHostedSyncResult("sync.commitCursor", { committed: true, sharingDeclined: [] })).toThrow(ProtocolShapeError);
    expect(() => decodeHostedSyncResult("sync.commitCursor", { committed: true, hasMore: false, retirement: null, sharingDeclined: [] }))
      .toThrow(ProtocolShapeError);
    expect(() => decodeHostedSyncResult("sync.createHostedReplica", { hosted: false })).toThrow(ProtocolShapeError);
  });
});

describe("held document inspection contract", () => {
  const bound = JSON.parse(vectors.valid[0]!.canonical);
  const held = { objectId: bound.objectId, path: "notes/plan.md", binding: bound, bindingDigest: vectors.valid[0]!.digest,
    continuation: "frozen", bindingStale: false };
  const markdown = "# Plan\n\nRetained.\n";
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const carried = { kind: "carried", deliveryId: "delivery-1", updateDigest: "c".repeat(64), journalCursor: 7 };
  const outbox = { kind: "outbox", outboxId: "outbox", sequence: 3, deliveryId: "delivery-2", updateDigest: "d".repeat(64) };
  const complete = { status: "complete", reasons: [], mergedContributionIds: [outbox], markdown,
    markdownSha256: sha(markdown), markdownByteLength: Buffer.byteLength(markdown), inbandLimitBytes: 49152 };
  const inspected = { ...held, status: "current", preservation: complete, resolution: null };

  it("keeps a page of held documents and each binding's digest", () => {
    const page = { documents: [held], hasMore: true };
    expect(decodeHostedSyncResult("sync.heldDocuments", page)).toEqual(page);
    expect(decodeHostedSyncResult("sync.heldDocuments", { documents: [], hasMore: false }).documents).toEqual([]);
  });

  it("keeps complete preservation, its merged contributions and its exact text", () => {
    expect(decodeHostedSyncResult("sync.heldDocument", inspected)).toEqual(inspected);
    // Text above the in-band limit streams; its digest and length still name it.
    const streamed = { ...complete, markdown: null, inbandLimitBytes: 4 };
    expect(decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation: streamed })?.preservation).toEqual(streamed);
    expect(decodeHostedSyncResult("sync.heldDocument", null)).toBeNull();
  });

  it("keeps each machine-readable reason preservation is incomplete, and a stale binding claims nothing", () => {
    const reasons = [
      { reason: "pending-head-dependencies", status: "pending-dependencies", namespace: null, contribution: null },
      { reason: "pending-contribution-dependencies", status: "pending-dependencies", namespace: null, contribution: null },
      { reason: "source-missing", status: "missing-evidence", namespace: "relay", contribution: outbox },
      { reason: "contradictory-evidence", status: "invalid-evidence", namespace: "relay", contribution: null },
      { reason: "digest-mismatch", status: "invalid-evidence", namespace: "relay", contribution: carried },
    ];
    for (const reason of reasons) {
      const incomplete = { status: reason.status, reasons: [reason], mergedContributionIds: [], markdown: null,
        markdownSha256: null, markdownByteLength: null, inbandLimitBytes: 49152 };
      expect(decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation: incomplete })?.preservation).toEqual(incomplete);
    }
    const stale = { ...inspected, status: "stale", preservation: null, bindingStale: true };
    expect(decodeHostedSyncResult("sync.heldDocument", stale)).toEqual(stale);
  });

  it.each([
    ["another binding's digest", { bindingDigest: "0".repeat(64) }],
    ["another object", { objectId: "elsewhere" }],
    ["a stale binding that preserves", { status: "stale" }],
    ["a current binding with nothing inspected", { preservation: null }],
    ["text its digest does not name", { preservation: { ...complete, markdown: `${markdown}!` } }],
    ["text its length does not name", { preservation: { ...complete, markdownByteLength: 1 } }],
    ["in-band text left out", { preservation: { ...complete, markdown: null } }],
    ["complete with a reason", { preservation: { ...complete, reasons: [{ reason: "source-missing", status: "missing-evidence", namespace: null, contribution: null }] } }],
    ["incomplete with text", { preservation: { ...complete, status: "missing-evidence",
      reasons: [{ reason: "source-missing", status: "missing-evidence", namespace: null, contribution: null }] } }],
    ["an unknown reason", { preservation: { ...complete, status: "invalid-evidence",
      reasons: [{ reason: "guess", status: "invalid-evidence", namespace: null, contribution: null }], markdown: null, markdownSha256: null, markdownByteLength: null } }],
    ["a resolution this round never records", { resolution: {} }],
  ])("rejects %s", (_case, patch) => {
    expect(() => decodeHostedSyncResult("sync.heldDocument", { ...inspected, ...patch })).toThrow(ProtocolShapeError);
  });

  const found = (reason: string, status: string) => ({ reason, status, namespace: null, contribution: null });
  const incomplete = (status: string, ...reasons: unknown[]) => ({ status, reasons, mergedContributionIds: [],
    markdown: null, markdownSha256: null, markdownByteLength: null, inbandLimitBytes: 49152 });
  const pending = found("pending-contribution-dependencies", "pending-dependencies");
  const missing = found("source-missing", "missing-evidence");
  const contradictory = found("contradictory-evidence", "invalid-evidence");

  it("keeps mixed reasons under the worst one's status, and coordinates from one", () => {
    for (const [status, reasons] of [
      ["missing-evidence", [pending, missing]],
      ["invalid-evidence", [missing, contradictory, pending]],
    ] as const) {
      const preservation = incomplete(status, ...reasons);
      expect(decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation })?.preservation).toEqual(preservation);
    }
    const first = [{ ...carried, journalCursor: 1 }, { ...outbox, sequence: Number.MAX_SAFE_INTEGER }];
    const preservation = { ...complete, mergedContributionIds: first };
    expect(decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation })?.preservation).toEqual(preservation);
  });

  it.each([
    ["a stale-marked hold that claims to be current", { bindingStale: true }],
    ["a reason under another reason's status", { preservation: incomplete("invalid-evidence", found("source-missing", "invalid-evidence")) }],
    ["a pending reason claiming invalid evidence", { preservation: incomplete("invalid-evidence", found("pending-head-dependencies", "invalid-evidence")) }],
    ["a status better than its worst reason", { preservation: incomplete("pending-dependencies", pending, missing) }],
    ["a status worse than its worst reason", { preservation: incomplete("invalid-evidence", missing) }],
    ["no reasons but an incomplete status", { preservation: incomplete("missing-evidence") }],
    ["an update digest that is no SHA-256", { preservation: { ...complete, mergedContributionIds: [{ ...outbox, updateDigest: "d" }] } }],
    ["an uppercase update digest", { preservation: { ...complete, mergedContributionIds: [{ ...carried, updateDigest: "C".repeat(64) }] } }],
    ["a reason's contribution with no SHA-256", { preservation: incomplete("missing-evidence",
      { ...missing, contribution: { ...outbox, updateDigest: "not-a-digest" } }) }],
    ["journal cursor zero", { preservation: { ...complete, mergedContributionIds: [{ ...carried, journalCursor: 0 }] } }],
    ["outbox sequence zero", { preservation: { ...complete, mergedContributionIds: [{ ...outbox, sequence: 0 }] } }],
    ["an unsafe journal cursor", { preservation: { ...complete, mergedContributionIds: [{ ...carried, journalCursor: Number.MAX_SAFE_INTEGER + 1 }] } }],
    ["a fractional sequence", { preservation: { ...complete, mergedContributionIds: [{ ...outbox, sequence: 1.5 }] } }],
  ])("rejects %s", (_case, patch) => {
    expect(() => decodeHostedSyncResult("sync.heldDocument", { ...inspected, ...patch })).toThrow(ProtocolShapeError);
  });
});
