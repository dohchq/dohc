import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProtocolShapeError } from "../wireSchema";
import { decodeHeldContributions, decodeHostedSyncResult, decodeOrdinarySyncResult, hostedWindowCovers } from "./ordinarySyncWireContract";
import { canonicalJson } from "./releasedLineageBinding";
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
  { objectId: "g", reason: "released-lineage-unsettled", path: "docs/g.md", bindingDigest: vectors.valid[0]!.digest,
    continuation: "frozen", bindingStale: false },
];
const hosted = { fetched: 2, applied: 1, refused: 1, skipped: 0, conflictsOpened: 0, hasMore: true,
  pendingCursor: { kind: "hosted", token: "opaque-issued-token" }, changedPaths: [change], changedPathsOmitted: 0, refusals: [refusal],
  refusalsOmitted: 0, sharingDeclined: [], sharingDeclinedOmitted: 0, held: holds, heldThrough: null, newlyHeld: [], newlyHeldOmitted: 0,
  departed: ["gone"], departedThrough: null };
// What `newlyHeld` names of a hold: only what holding it needs.
const newly = (hold: (typeof holds)[number]) => ({ objectId: hold.objectId, reason: hold.reason,
  ...("bindingDigest" in hold ? { bindingDigest: hold.bindingDigest } : {}) });

describe("hosted native sync contract", () => {
  it("keeps the issued hosted cursor, every hold with its fields, departed documents, and a pass that adopted a scope", () => {
    expect(decodeHostedSyncResult("sync.pullHosted", { ...hosted, ignored: true })).toEqual(hosted);
    expect(decodeHostedSyncResult("sync.pullHosted", { ...hosted, pendingCursor: null, held: [] }).pendingCursor).toBeNull();
  });

  it("keeps a held list that stops early at the last document it lists, in the engine's byte order", () => {
    const cut = { ...hosted, held: holds.slice(0, 2), heldThrough: "c" };
    expect(decodeHostedSyncResult("sync.pullHosted", cut)).toEqual(cut);
    // UTF-16 puts the astral ID first; the engine's UTF-8 bytes put it last.
    const ordered = [{ objectId: "￿", reason: "hosted-backfill-work-waiting" }, { objectId: "\u{10000}", reason: "hosted-backfill-work-waiting" }];
    expect(decodeHostedSyncResult("sync.pullHosted", { ...hosted, held: ordered }).held).toEqual(ordered);
    expect(() => decodeHostedSyncResult("sync.pullHosted", { ...hosted, held: [...ordered].reverse() })).toThrow(ProtocolShapeError);
  });

  it.each([
    { held: holds.slice(0, 2), heldThrough: "a" }, { held: holds.slice(0, 2), heldThrough: "b" }, { held: [], heldThrough: "a" },
    { held: [holds[1], holds[0]] }, { held: [holds[0], holds[0]] }, { held: holds.slice(0, 2), heldThrough: "" },
    { heldThrough: undefined },
  ])("rejects a held list that contradicts where it stops: %j", patch => {
    expect(() => decodeHostedSyncResult("sync.pullHosted", { ...hosted, ...patch })).toThrow("hosted sync.pullHosted result");
  });

  it("speaks for a document only inside its list's window", () => {
    const window = { after: "b", through: "d" };
    expect(["a", "b", "c", "d", "e"].filter(objectId => hostedWindowCovers(window, objectId))).toEqual(["c", "d"]);
    expect(hostedWindowCovers({ after: undefined, through: null }, "any")).toBe(true);
    expect(hostedWindowCovers({ after: "￿", through: null }, "\u{10000}")).toBe(true);
    expect(hostedWindowCovers({ after: undefined, through: "￿" }, "\u{10000}")).toBe(false);
  });

  it("keeps a commit that stands beside the retirement error after it, and unread departed documents", () => {
    const retirement = { code: "INTERNAL", message: "hosted file unexpected: docs/a.md", retry: "no" };
    const commit = { committed: true, hasMore: false, retirement, departed: ["gone"], departedThrough: null, sharingDeclined: [] };
    expect(decodeHostedSyncResult("sync.commitCursor", commit)).toEqual(commit);
    expect(decodeHostedSyncResult("sync.commitCursor", { ...commit, retirement: null, departed: null }).departed).toBeNull();
    expect(decodeHostedSyncResult("sync.commitCursor", { ...commit, committed: false, retirement: null }).committed).toBe(false);
    const cut = { ...commit, departed: ["a", "b"], departedThrough: "b" };
    expect(decodeHostedSyncResult("sync.commitCursor", cut)).toEqual(cut);
  });

  it.each([
    { departed: null, departedThrough: "a" }, { departed: ["b", "a"] }, { departed: ["a", "a"] }, { departed: ["a", "b"], departedThrough: "a" },
    { departed: [], departedThrough: "a" }, { departedThrough: undefined },
  ])("rejects a commit whose departed documents contradict where they stop: %j", patch => {
    const commit = { committed: true, hasMore: false, retirement: null, departed: ["gone"], departedThrough: null, sharingDeclined: [], ...patch };
    expect(() => decodeHostedSyncResult("sync.commitCursor", commit)).toThrow("hosted sync.commitCursor result");
  });

  it("keeps each cut list with how many it leaves out or where it stops, and what a pass moved from ready to held", () => {
    const cut = { ...hosted, changedPathsOmitted: 7, refusalsOmitted: 8, sharingDeclinedOmitted: 9, newlyHeld: [newly(holds[2]!), newly(holds[5]!)],
      newlyHeldOmitted: 3, departed: ["a", "b"], departedThrough: "b" };
    expect(decodeHostedSyncResult("sync.pullHosted", cut)).toEqual(cut);
    // Only what holding a document needs reaches the relay.
    expect(decodeHostedSyncResult("sync.pullHosted", { ...hosted, newlyHeld: [holds[0], holds[5]] }).newlyHeld)
      .toEqual([newly(holds[0]!), newly(holds[5]!)]);
  });

  it.each([
    { newlyHeld: [newly(holds[5]!), newly(holds[2]!)] }, { newlyHeld: [newly(holds[2]!), newly(holds[2]!)] },
    { newlyHeld: [{ objectId: "a", reason: "unknown" }] }, { newlyHeld: [{ objectId: "g", reason: "released-lineage-unsettled" }] },
    { newlyHeld: undefined }, { newlyHeldOmitted: undefined }, { newlyHeldOmitted: -1 },
    { departed: ["b", "a"] }, { departed: ["a", "a"] }, { departed: ["a", "b"], departedThrough: "a" }, { departed: [], departedThrough: "a" },
    { departedThrough: undefined }, { changedPathsOmitted: -1 }, { refusalsOmitted: 0.5 }, { sharingDeclinedOmitted: null },
  ])("rejects a pass whose cut lists are unusable: %j", patch => {
    expect(() => decodeHostedSyncResult("sync.pullHosted", { ...hosted, ...patch })).toThrow("hosted sync.pullHosted result");
  });

  it("names a released-lineage hold by the summary discovery lists, its binding only by its digest", () => {
    expect(decodeHostedSyncResult("sync.pullHosted", hosted).held[5]).toEqual(holds[5]);
    const stale = { ...holds[5], continuation: "dependency-drain", bindingStale: true };
    expect(decodeHostedSyncResult("sync.pullHosted", { ...hosted, held: [stale] }).held).toEqual([stale]);
  });

  it.each([
    { held: [{ ...holds[5], binding: JSON.parse(vectors.valid[0]!.canonical) }] }, { held: [{ ...holds[5], binding: null }] },
    { held: [{ ...holds[5], bindingDigest: undefined }] }, { held: [{ ...holds[5], bindingDigest: "D".repeat(64) }] },
    { held: [{ ...holds[5], path: undefined }] }, { held: [{ ...holds[5], path: "" }] },
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

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// The first artifact vector names the first binding vector, the work of its
// one valid tail, relay-a, and one contribution merged.
const [listedArtifact, emptyArtifact] = vectors.artifacts as [typeof vectors.artifacts[number], typeof vectors.artifacts[number]];
const bound = JSON.parse(vectors.valid[0]!.canonical);
const held = { objectId: bound.objectId, path: "notes/plan.md", bindingDigest: vectors.valid[0]!.digest,
  continuation: "frozen", bindingStale: false };
const markdown = "# Plan\n\nRetained.\n";
const [carried, outbox] = vectors.commitments[0]!.contributions as unknown as [Record<string, unknown>, Record<string, unknown>];
// Where each is, as a finding names it.
const { authors: _carriedAuthors, ...carriedAt } = carried;
const { authors: _outboxAuthors, ...outboxAt } = outbox;
const artifactBytes = Buffer.from(listedArtifact.canonical, "utf8");
const complete = { status: "complete", reasons: [], mergedContributions: listedArtifact.mergedContributions,
  contributionsSha256: listedArtifact.sha256, contributionsByteLength: artifactBytes.length, contributionsTooLarge: false,
  markdown, markdownSha256: sha(markdown), markdownByteLength: Buffer.byteLength(markdown), inbandLimitBytes: 49152 };
const inspected = { ...held, status: "current", preservation: complete, resolution: null };
// What no merged contributions commit to.
const nothingMerged = emptyArtifact.mergedContributions;
// Complete preservation whose artifact is past what one blob streams: its
// merged commitment still answers.
const tooLarge = { ...complete, contributionsSha256: null, contributionsByteLength: null, contributionsTooLarge: true };

describe("held document inspection contract", () => {
  it("keeps a page of held document summaries, and refuses one that claims more with nothing listed", () => {
    const page = { documents: [held], hasMore: true };
    expect(decodeHostedSyncResult("sync.heldDocuments", page)).toEqual(page);
    expect(decodeHostedSyncResult("sync.heldDocuments", { documents: [], hasMore: false }).documents).toEqual([]);
    expect(() => decodeHostedSyncResult("sync.heldDocuments", { documents: [], hasMore: true })).toThrow(ProtocolShapeError);
    expect(() => decodeHostedSyncResult("sync.heldDocuments", { documents: [{ ...held, bindingDigest: "D".repeat(64) }], hasMore: false }))
      .toThrow(ProtocolShapeError);
  });

  it("keeps complete preservation, its artifact's digest and length, its merged commitment and its exact text", () => {
    expect(decodeHostedSyncResult("sync.heldDocument", inspected)).toEqual(inspected);
    // Text the engine streams instead; its digest and length still name it.
    const streamed = { ...complete, markdown: null };
    expect(decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation: streamed })?.preservation).toEqual(streamed);
    // Merging added nothing: the empty list's commitment names that.
    const contained = { ...complete, mergedContributions: nothingMerged };
    expect(decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation: contained })?.preservation).toEqual(contained);
    expect(decodeHostedSyncResult("sync.heldDocument", null)).toBeNull();
  });

  it("keeps preservation, its text and its merged commitment whose artifact is too large, naming no artifact", () => {
    const decodedTooLarge = decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation: tooLarge })?.preservation;
    expect(decodedTooLarge).toEqual(tooLarge);
    expect(decodedTooLarge?.mergedContributions).toEqual(listedArtifact.mergedContributions);
    const streamed = { ...tooLarge, markdown: null };
    expect(decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation: streamed })?.preservation).toEqual(streamed);
    const contained = { ...tooLarge, mergedContributions: nothingMerged };
    expect(decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation: contained })?.preservation).toEqual(contained);
  });

  // One reason with its total, and the examples listed of it.
  const reason = (code: string, status: string, total: number, ...examples: unknown[]) =>
    ({ reason: code, status, total, omitted: total - examples.length, examples });
  const at = (namespace: string | null, contribution: unknown = null) => ({ namespace, contribution });
  const incomplete = (status: string, ...reasons: unknown[]) => ({ ...complete, status, reasons, mergedContributions: nothingMerged,
    markdown: null, markdownSha256: null, markdownByteLength: null });
  const pending = reason("pending-contribution-dependencies", "pending-dependencies", 1, at(null));
  const missing = reason("source-missing", "missing-evidence", 1, at("relay-a", outboxAt));
  const contradictory = reason("contradictory-evidence", "invalid-evidence", 1, at("relay-b"));
  const decoded = (preservation: unknown) => decodeHostedSyncResult("sync.heldDocument", { ...inspected, preservation })?.preservation;

  it("keeps each machine-readable reason preservation is incomplete, and a stale binding claims nothing", () => {
    for (const found of [
      reason("pending-head-dependencies", "pending-dependencies", 1, at(null)),
      pending,
      missing,
      reason("contradictory-evidence", "invalid-evidence", 2, at("relay-b"), at("relay-b", carriedAt)),
      reason("digest-mismatch", "invalid-evidence", 1, at("relay-a", carriedAt)),
      // Authorship that does not read names where its work is, and nothing else.
      reason("malformed-authorship", "invalid-evidence", 1, at("relay-b", outboxAt)),
    ]) {
      const preservation = incomplete(found.status, found);
      expect(decoded(preservation)).toEqual(preservation);
    }
    const stale = { ...inspected, status: "stale", preservation: null, bindingStale: true };
    expect(decodeHostedSyncResult("sync.heldDocument", stale)).toEqual(stale);
  });

  it("keeps a few examples of each reason with its exact total, and the worst reason's status even with none listed", () => {
    const eight = Array.from({ length: 8 }, (_, index) => at("relay-a", { ...outboxAt, sequence: index + 1 }));
    // Of 50,000 missing sources eight are listed; the invalid authorship the budget left without an example still decides.
    const truncated = incomplete("invalid-evidence", reason("source-missing", "missing-evidence", 50_000, ...eight),
      reason("malformed-authorship", "invalid-evidence", 3));
    expect(decoded(truncated)).toEqual(truncated);
    expect(decoded(truncated)?.reasons.map(found => [found.total, found.omitted, found.examples.length])).toEqual([[50_000, 49_992, 8], [3, 3, 0]]);
    for (const [status, reasons] of [
      ["missing-evidence", [missing, pending]],
      ["invalid-evidence", [missing, pending, contradictory]],
    ] as const) {
      const preservation = incomplete(status, ...reasons);
      expect(decoded(preservation)).toEqual(preservation);
    }
    const preservation = incomplete("missing-evidence", reason("source-missing", "missing-evidence", 2,
      at("relay-a", { ...carriedAt, journalCursor: 1 }), at("relay-a", { ...outboxAt, sequence: Number.MAX_SAFE_INTEGER })));
    expect(decoded(preservation)).toEqual(preservation);
  });

  const nine = Array.from({ length: 9 }, () => at(null));
  it.each([
    ["another binding's digest that is no SHA-256", { bindingDigest: "0".repeat(63) }],
    ["a stale binding that preserves", { status: "stale" }],
    ["a current binding with nothing inspected", { preservation: null }],
    ["a stale-marked hold that claims to be current", { bindingStale: true }],
    ["text its digest does not name", { preservation: { ...complete, markdown: `${markdown}!` } }],
    ["text its length does not name", { preservation: { ...complete, markdownByteLength: 1 } }],
    ["complete with a reason", { preservation: { ...complete, reasons: [missing] } }],
    ["incomplete with text", { preservation: { ...complete, status: "missing-evidence", reasons: [missing] } }],
    ["an unknown reason", { preservation: incomplete("invalid-evidence", reason("guess", "invalid-evidence", 1)) }],
    ["a reason under another reason's status", { preservation: incomplete("invalid-evidence", reason("source-missing", "invalid-evidence", 1)) }],
    ["a pending reason claiming invalid evidence",
      { preservation: incomplete("invalid-evidence", reason("pending-head-dependencies", "invalid-evidence", 1)) }],
    ["a status better than its worst reason", { preservation: incomplete("pending-dependencies", missing, pending) }],
    ["a status better than a worst reason listed without examples",
      { preservation: incomplete("missing-evidence", missing, reason("malformed-authorship", "invalid-evidence", 3)) }],
    ["a status worse than its worst reason", { preservation: incomplete("invalid-evidence", missing) }],
    ["no reasons but an incomplete status", { preservation: incomplete("missing-evidence") }],
    ["examples and omitted findings past the total", { preservation: incomplete("missing-evidence", { ...missing, total: 1, omitted: 1 }) }],
    ["examples and omitted findings short of the total", { preservation: incomplete("missing-evidence", { ...missing, total: 5, omitted: 3 }) }],
    ["a reason no finding gave", { preservation: incomplete("missing-evidence", reason("source-missing", "missing-evidence", 0)) }],
    ["more than eight examples", { preservation: incomplete("missing-evidence", reason("source-missing", "missing-evidence", 9, ...nine)) }],
    ["a reason listed twice", { preservation: incomplete("missing-evidence", missing, missing) }],
    ["reasons out of order", { preservation: incomplete("invalid-evidence", contradictory, missing) }],
    ["a negative omitted count", { preservation: incomplete("missing-evidence", { ...missing, total: 0, omitted: -1 }) }],
    ["a fractional total", { preservation: incomplete("missing-evidence", { ...missing, total: 1.5, omitted: 0.5 }) }],
    ["an example with no SHA-256", { preservation: incomplete("missing-evidence",
      reason("source-missing", "missing-evidence", 1, at("relay-a", { ...outboxAt, updateDigest: "not-a-digest" }))) }],
    ["an example at journal cursor zero", { preservation: incomplete("missing-evidence",
      reason("source-missing", "missing-evidence", 1, at("relay-a", { ...carriedAt, journalCursor: 0 }))) }],
    ["merged work under the empty list's digest", { preservation: { ...complete, mergedContributions: { ...nothingMerged, count: 1 } } }],
    ["nothing merged under another digest", { preservation: { ...complete, mergedContributions: { ...listedArtifact.mergedContributions, count: 0 } } }],
    ["a merged digest that is no SHA-256", { preservation: { ...complete, mergedContributions: { count: 1, digest: "d" } } }],
    ["the artifact's own digest for the merged list",
      { preservation: { ...complete, mergedContributions: { count: 1, digest: listedArtifact.sha256 } } }],
    ["an artifact digest that is no SHA-256", { preservation: { ...complete, contributionsSha256: "A".repeat(64) } }],
    ["an empty artifact", { preservation: { ...complete, contributionsByteLength: 0 } }],
    ["no artifact", { preservation: { ...complete, contributionsSha256: undefined, contributionsByteLength: undefined } }],
    ["no artifact, not too large", { preservation: { ...tooLarge, contributionsTooLarge: false } }],
    ["no merged commitment, not too large", { preservation: { ...complete, mergedContributions: null } }],
    ["no artifact digest, not too large", { preservation: { ...complete, contributionsSha256: null } }],
    ["no artifact length, not too large", { preservation: { ...complete, contributionsByteLength: null } }],
    ["an artifact too large to name, named", { preservation: { ...complete, contributionsTooLarge: true } }],
    ["a too-large artifact with no merged commitment", { preservation: { ...tooLarge, mergedContributions: null } }],
    ["a too-large artifact's merged work under the empty list's digest",
      { preservation: { ...tooLarge, mergedContributions: { ...nothingMerged, count: 1 } } }],
    ["a too-large artifact's digest", { preservation: { ...tooLarge, contributionsSha256: listedArtifact.sha256 } }],
    ["a too-large artifact's length", { preservation: { ...tooLarge, contributionsByteLength: artifactBytes.length } }],
    ["no word on whether the artifact is too large", { preservation: { ...complete, contributionsTooLarge: undefined } }],
    ["a resolution this round never records", { resolution: {} }],
  ])("rejects %s", (_case, patch) => {
    expect(() => decodeHostedSyncResult("sync.heldDocument", { ...inspected, ...patch })).toThrow(ProtocolShapeError);
  });
});

describe("held document contribution artifact", () => {
  const artifact = JSON.parse(listedArtifact.canonical);
  // `bytes` under an inspection that names exactly them.
  const namedBytes = (bytes: Buffer) =>
    [bytes, { ...inspected, preservation: { ...complete, contributionsSha256: sha(bytes), contributionsByteLength: bytes.length } }] as const;
  // `value` as the engine encodes it, or `text`, so named.
  const named = (value: unknown, text = canonicalJson(value)) => namedBytes(Buffer.from(text, "utf8"));
  const current = (value: unknown) => decodeHostedSyncResult("sync.heldDocument", value)!;

  it("names the binding, every covered contribution with its authors, and the merged list, none left out", () => {
    expect(decodeHeldContributions(artifactBytes, current(inspected))).toEqual({
      binding: bound,
      coveredContributions: [{ namespace: "relay-a", contributions: [carried, outbox] }],
      mergedContributionIds: [outbox],
    });
    // A binding whose tails do not read covers nothing, and nothing merged.
    const unread = Buffer.from(emptyArtifact.canonical, "utf8");
    const nothing = { ...inspected, objectId: "object-2", bindingDigest: vectors.valid[1]!.digest,
      preservation: { ...incomplete(), contributionsSha256: emptyArtifact.sha256, contributionsByteLength: unread.length } };
    expect(decodeHeldContributions(unread, current(nothing))).toEqual({
      binding: JSON.parse(vectors.valid[1]!.canonical), coveredContributions: [], mergedContributionIds: [],
    });
  });

  function incomplete() {
    return { ...complete, status: "invalid-evidence", reasons: [{ reason: "contradictory-evidence", status: "invalid-evidence",
      total: 1, omitted: 0, examples: [{ namespace: null, contribution: null }] }], mergedContributions: nothingMerged,
      markdown: null, markdownSha256: null, markdownByteLength: null };
  }

  it.each([
    ["bytes its length does not name", [Buffer.concat([artifactBytes, Buffer.from(" ")]), inspected]],
    ["bytes its digest does not name", [Buffer.from(listedArtifact.canonical.replace("relay-a\"}]", "relay-b\"}]")), inspected]],
    ["a stale inspection", [artifactBytes, { ...inspected, status: "stale", preservation: null, bindingStale: true }]],
    ["an inspection whose artifact is too large", [artifactBytes, { ...inspected, preservation: tooLarge }]],
    ["bytes that are no UTF-8", namedBytes(Buffer.from([0x7b, 0xff, 0x7d]))],
    ["bytes that are no JSON", named(null, "{")],
    ["whitespace", named(null, JSON.stringify(artifact, null, 1))],
    ["keys out of order", named(null, JSON.stringify({ version: 1, ...artifact }))],
    ["another format version", named({ ...artifact, version: 2 })],
    ["an unknown key", named({ ...artifact, extra: 1 })],
    ["no binding", named({ ...artifact, binding: null })],
    ["another binding", named({ ...artifact, binding: { ...bound, headDigest: "c".repeat(64) } })],
    ["covered work left out", named({ ...artifact, coveredContributions: [{ namespace: "relay-a", contributions: [outbox] }] })],
    ["covered work credited to someone else", named({ ...artifact,
      coveredContributions: [{ namespace: "relay-a", contributions: [{ ...carried, authors: [{ kind: "unattributed" }] }, outbox] }] })],
    ["covered work under another tail", named({ ...artifact, coveredContributions: [{ ...artifact.coveredContributions[0], namespace: "relay-b" }] })],
    ["covered work for a tail that does not read", named({ ...artifact,
      coveredContributions: [...artifact.coveredContributions, { namespace: "relay-b", contributions: [carried] }] })],
    ["no covered work", named({ ...artifact, coveredContributions: [] })],
    ["covered work with malformed authorship", named({ ...artifact,
      coveredContributions: [{ namespace: "relay-a", contributions: [{ ...carried, authors: [] }, outbox] }] })],
    ["a covered tail with another key", named({ ...artifact, coveredContributions: [{ ...artifact.coveredContributions[0], extra: 1 }] })],
    ["a merged contribution nothing covers", named({ ...artifact, mergedContributionIds: [{ ...outbox, sequence: 4 }] })],
    ["a merged contribution credited to someone else", named({ ...artifact,
      mergedContributionIds: [{ ...outbox, authors: [{ kind: "agent", agentId: "stranger" }] }] })],
    ["a merged contribution without its authors", named({ ...artifact, mergedContributionIds: [outboxAt] })],
    ["merged contributions out of canonical order", named({ ...artifact, mergedContributionIds: [outbox, carried] })],
    ["a merged contribution listed twice", named({ ...artifact, mergedContributionIds: [outbox, outbox] })],
    ["merged work its commitment does not name", named({ ...artifact, mergedContributionIds: [carried] })],
    ["less merged work than its commitment names", named({ ...artifact, mergedContributionIds: [] })],
  ] as const)("rejects %s", (_case, [bytes, inspection]) => {
    expect(() => decodeHeldContributions(bytes, current(inspection))).toThrow(ProtocolShapeError);
  });
});
