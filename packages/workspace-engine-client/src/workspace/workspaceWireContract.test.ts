import { describe, expect, it } from "vitest";
import reasonCodes from "../../../../crates/dohc-engine-domain/tests/fixtures/collection-reason-codes.json";
import {
  WORKSPACE_METHOD,
  WorkspaceProtocolShapeError,
  decodeCollectionValue,
  decodeConflictRecord,
  decodeWorkspaceResult,
  encodeCollectionValue,
  encodeCollectionQueryParams,
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

  it("accepts the shared full collection reason-code set", () => {
    for (const code of reasonCodes.schemaReasonCodes) {
      expect(() =>
        decodeWorkspaceResult(WORKSPACE_METHOD.collectionsList, {
          collections: [
            {
              path: "projects",
              status: "degraded",
              reasons: [{ code, path: "/fields" }],
            },
          ],
        }),
      ).not.toThrow();
    }

    for (const code of reasonCodes.fieldValueReasonCodes) {
      const result = decodeWorkspaceResult(WORKSPACE_METHOD.collectionsQuery, {
        collection: { path: "projects", status: "valid", reasons: [] },
        records: [
          {
            id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            path: "projects/roadmap.md",
            conflicted: false,
            values: [
              {
                field: "status",
                value: "active",
                validation: {
                  status: "flagged",
                  reason: { code, path: "" },
                },
                resolvedRelations: [],
              },
            ],
          },
        ],
        groups: null,
        nextCursor: null,
      });

      expect(result.records[0]?.values[0]?.validation).toEqual({
        status: "flagged",
        reason: { code, path: "" },
      });
    }
  });

  it("round-trips exact signed 64-bit collection integers", () => {
    const markedInteger = { $dohcInt64: "9007199254740993" };
    const record = {
      id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      path: "projects/roadmap.md",
      conflicted: false,
      values: [
        {
          field: "estimate",
          value: markedInteger,
          validation: { status: "valid" },
          resolvedRelations: [],
        },
      ],
    };

    const queried = decodeWorkspaceResult(WORKSPACE_METHOD.collectionsQuery, {
      collection: { path: "projects", status: "valid", reasons: [] },
      records: [record],
      groups: [{ value: markedInteger, records: [record] }],
      nextCursor: {
        sortValues: [{ present: true, value: markedInteger }],
        recordPath: record.path,
        recordId: record.id,
      },
    });
    expect(queried.records[0]?.values[0]?.value).toBe(9007199254740993n);
    expect(queried.groups?.[0]?.value).toBe(9007199254740993n);
    expect(queried.nextCursor?.sortValues[0]?.value).toBe(
      9007199254740993n,
    );

    const fetched = decodeWorkspaceResult(
      WORKSPACE_METHOD.collectionsGetRecord,
      {
        collection: { path: "projects", status: "valid", reasons: [] },
        record,
        history: [
          {
            historyId: 1,
            field: "estimate",
            previous: { present: false, value: null },
            next: { present: true, value: markedInteger },
            authorOriginId: null,
            recordedAtMs: 1,
          },
        ],
      },
    );
    expect(fetched.record.values[0]?.value).toBe(9007199254740993n);
    expect(fetched.history[0]?.next.value).toBe(9007199254740993n);

    expect(
      encodeCollectionQueryParams({
        collectionPath: "projects",
        filter: {
          field: "estimate",
          operator: "equals",
          value: 9007199254740993n,
        },
        cursor: {
          sortValues: [{ present: true, value: 9007199254740993n }],
          recordPath: record.path,
          recordId: record.id,
        },
      }),
    ).toMatchObject({
      filter: { value: markedInteger },
      cursor: { sortValues: [{ value: markedInteger }] },
    });
  });

  it("round-trips a marker-shaped user collection object unchanged", () => {
    const value = { $dohcInt64: "9007199254740993" };
    const encoded = encodeCollectionValue(value);

    expect(encoded).toEqual({ $dohcEscaped: value });
    expect(decodeCollectionValue(encoded)).toEqual(value);
  });

  it.each([
    [-(1n << 63n), "-9223372036854775808"],
    [(1n << 64n) - 1n, "18446744073709551615"],
  ])(
    "round-trips the collection integer marker domain edge %s into a follow-up filter",
    (integer, decimal) => {
      const marker = { $dohcInt64: decimal };
      const decoded = decodeCollectionValue(marker);

      expect(decoded).toBe(integer);
      expect(encodeCollectionValue(decoded)).toEqual(marker);
      expect(
        encodeCollectionQueryParams({
          collectionPath: "projects",
          filter: {
            field: "estimate",
            operator: "equals",
            value: decoded,
          },
        }),
      ).toMatchObject({ filter: { value: marker } });
    },
  );

  it.each([
    [-(1n << 63n) - 1n, "-9223372036854775809"],
    [1n << 64n, "18446744073709551616"],
  ])(
    "rejects the collection integer marker immediately outside domain edge %s in both directions",
    (integer, decimal) => {
      expect(() =>
        decodeCollectionValue({ $dohcInt64: decimal }),
      ).toThrow(WorkspaceProtocolShapeError);
      expect(() => encodeCollectionValue(integer)).toThrow(
        WorkspaceProtocolShapeError,
      );
    },
  );

  it("enforces safe-range collection integer marker rules", () => {
    expect(() =>
      decodeCollectionValue({ $dohcInt64: "9007199254740991" }),
    ).toThrow(WorkspaceProtocolShapeError);
    expect(encodeCollectionValue(9007199254740991n)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(encodeCollectionValue(-9007199254740991n)).toBe(
      -Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects collection escape markers the encoder does not produce", () => {
    expect(() =>
      decodeCollectionValue({ $dohcEscaped: { plain: true } }),
    ).toThrow(WorkspaceProtocolShapeError);
  });

  it("rejects malformed collection integer markers", () => {
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.collectionsQuery, {
        collection: { path: "projects", status: "valid", reasons: [] },
        records: [
          {
            id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            path: "projects/roadmap.md",
            conflicted: false,
            values: [
              {
                field: "estimate",
                value: { $dohcInt64: "01" },
                validation: { status: "valid" },
                resolvedRelations: [],
              },
            ],
          },
        ],
        groups: null,
        nextCursor: null,
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
