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
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.searchQuery, null),
    ).toThrow("Expected array");
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

  it("strictly decodes collection results and recursive JSON values", () => {
    const collection = {
      path: "projects",
      status: "valid",
      reasons: [],
    };
    const record = {
      id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      path: "projects/roadmap.md",
      values: [
        {
          field: "metadata",
          value: { nested: ["active", 1, true, null] },
          validation: { status: "untyped" },
          resolvedRelations: [
            {
              recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
              label: "Linked",
            },
          ],
        },
      ],
    };

    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.collectionsList, {
        collections: [collection],
      }),
    ).toEqual({ collections: [collection] });
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.collectionsGet, {
        ...collection,
        schema: {
          name: "Projects",
          description: null,
          fields: [{ name: "status", type: "select", options: ["active"] }],
          views: [],
        },
        recordCount: 1,
      }),
    ).toMatchObject({ path: "projects", recordCount: 1 });
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.collectionsQuery, {
        collection,
        records: [record],
        groups: [{ value: null, records: [record] }],
      }),
    ).toMatchObject({ records: [record], groups: [{ value: null }] });
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.collectionsGetRecord, {
        collection,
        record,
        history: [
          {
            field: "metadata",
            previous: { present: false, value: null },
            next: { present: true, value: { nested: [1, null] } },
            authorOriginId: null,
            recordedAtMs: 1,
          },
        ],
      }),
    ).toMatchObject({ record, history: [{ field: "metadata" }] });
  });

  it("rejects excess fields nested in collection results", () => {
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.collectionsQuery, {
        collection: { path: "projects", status: "valid", reasons: [] },
        records: [
          {
            id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            path: "projects/roadmap.md",
            values: [
              {
                field: "status",
                value: "active",
                validation: { status: "valid", unexpected: true },
                resolvedRelations: [],
              },
            ],
          },
        ],
        groups: null,
      }),
    ).toThrow(WorkspaceProtocolShapeError);
  });

  it.each([
    {
      replicated: true,
      status: "applied",
      conflictId: "conflict",
      inserted: null,
      matched: true,
    },
    { replicated: true, status: "skipped" },
    { replicated: true, status: "crashed", committed: true },
  ])("decodes replicated conflict result $status", (result) => {
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.conflictsOpen, result),
    ).toEqual(result);
  });

  it.each(["deferred", "pendingResolve"])(
    "rejects the removed replicated conflict field %s",
    (field) => {
      expect(() =>
        decodeWorkspaceResult(WORKSPACE_METHOD.conflictsOpen, {
          replicated: true,
          status: "applied",
          conflictId: "conflict",
          inserted: null,
          matched: true,
          [field]: field === "deferred" ? false : null,
        }),
      ).toThrow(WorkspaceProtocolShapeError);
    },
  );
});
