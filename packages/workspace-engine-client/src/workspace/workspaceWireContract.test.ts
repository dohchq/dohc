import { describe, expect, it } from "vitest";
import {
  WORKSPACE_METHOD,
  WorkspaceProtocolShapeError,
  decodeConflictRecord,
  decodeWorkspaceResult,
} from "./workspaceWireContract";

const snapshot = {
  workspaceId: "workspace",
  versionId: "main",
  objectId: "object",
  path: "note.md",
  text: "body",
  contentKind: "text",
  sha256: "a".repeat(64),
  byteLength: 4,
  blobSha256: "a".repeat(64),
  updatedAtMs: 1,
  latestMomentId: "moment",
  metadataOrigin: "api",
  metadataSummary: null,
  metadataCorrelationId: null,
};

const state = {
  path: "note.md",
  contentKind: "text",
  snapshot,
  binarySha256: null,
  binaryByteLength: null,
  binaryObjectId: null,
  binaryLatestMomentId: null,
  metadataSummary: null,
  metadataCorrelationId: null,
};

const conflict = {
  id: "conflict",
  workspaceId: "workspace",
  path: "note.md",
  targetVersionId: "main",
  sourceVersionId: "draft",
  createdAtMs: 1,
  updatedAtMs: 2,
  status: "open",
  chosenFrom: "current",
  resolution: null,
  metadata: { origin: "merge", summary: null, correlationId: null },
  base: state,
  current: state,
  incoming: state,
};

describe("workspace wire schemas", () => {
  it("preserves the public object-shape error", () => {
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.searchQueryPage, []),
    ).toThrow("must be a JSON object");
  });

  it("rejects nested excess fields", () => {
    expect(() =>
      decodeConflictRecord({
        ...conflict,
        metadata: { ...conflict.metadata, unexpected: true },
      }),
    ).toThrow(WorkspaceProtocolShapeError);
  });

  it("rejects unsafe integers", () => {
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.searchQuery, [
        {
          surface: "file",
          path: "note.md",
          title: "Note",
          line: Number.MAX_SAFE_INTEGER + 1,
          preview: "body",
          matchStart: 0,
          matchEnd: 4,
          threadId: null,
          objectId: null,
        },
      ]),
    ).toThrow(WorkspaceProtocolShapeError);
  });

  it("omits a null in-band limit", () => {
    const decoded = decodeConflictRecord({
      ...conflict,
      base: {
        ...state,
        snapshot: { ...snapshot, text: null, inbandLimitBytes: null },
      },
    });

    expect(decoded.base.snapshot).not.toHaveProperty("inbandLimitBytes");
  });

  it("preserves arbitrary write and delete objects", () => {
    const decoded = decodeWorkspaceResult(WORKSPACE_METHOD.conflictsResolve, {
      conflict,
      write: { nested: { values: [1, true, null] } },
      delete: { path: "old.md", reason: "replaced" },
    });

    expect(decoded).toMatchObject({
      write: { nested: { values: [1, true, null] } },
      delete: { path: "old.md", reason: "replaced" },
    });
  });
});
