import { describe, expect, it } from "vitest";
import { ProtocolShapeError } from "../wireSchema";
import { decodeHostedSyncResult, decodeOrdinarySyncResult } from "./ordinarySyncWireContract";

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
