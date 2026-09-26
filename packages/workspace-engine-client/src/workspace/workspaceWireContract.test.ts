import { ProtocolShapeError } from "../wireSchema";
import { describe, expect, it } from "vitest";
import { validateFieldValue } from "@dohc/workspace-contracts/collection-values";
import type { CollectionValue } from "@dohc/workspace-contracts/collection";
import type { JsonValue } from "../protocol";
import pipelineFixture from "../../../../crates/dohc-engine-domain/tests/fixtures/collection-field-pipeline.json";
import reasonCodes from "../../../../crates/dohc-engine-domain/tests/fixtures/collection-reason-codes.json";
import {
  WORKSPACE_METHOD,
  decodeCollectionValue,
  decodeConflictRecord,
  decodeWorkspaceResult,
  encodeCollectionValue,
  encodeCollectionQueryParams,
} from "./workspaceWireContract";
import { encodeFixtureBigInts } from "../testing/fixtureBigInts";

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

const reservedCollectionMarkerObjects: Array<{
  value: CollectionValue;
  encoded: JsonValue;
}> = [
  {
    value: { $dohcInt64: "9007199254740993" },
    encoded: { $$dohcInt64: "9007199254740993" },
  },
  {
    value: { $dohcFloat64: "100000000000000000000" },
    encoded: { $$dohcFloat64: "100000000000000000000" },
  },
  {
    value: { $$dohcInt64: "literal" },
    encoded: { $$$dohcInt64: "literal" },
  },
  {
    value: { $dohcEscaped: { $dohcFloat64: "100000000000000000000" } },
    encoded: { $dohcEscaped: { $$dohcFloat64: "100000000000000000000" } },
  },
];

function collectionValueDepth(value: CollectionValue): number {
  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map(collectionValueDepth));
  }
  if (value !== null && typeof value === "object") {
    return 1 + Math.max(0, ...Object.values(value).map(collectionValueDepth));
  }
  return 1;
}

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
    ).toThrow(ProtocolShapeError);
  });

  it("rejects unsafe integers", () => {
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.searchQueryPage, {
        results: [
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
        ],
        nextCursor: null,
        versionId: "main",
        restartRequired: false,
      }),
    ).toThrow(ProtocolShapeError);
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
    ).toThrow(ProtocolShapeError);
  });

  it("decodes a button field definition", () => {
    const result = decodeWorkspaceResult(WORKSPACE_METHOD.collectionsGet, {
      path: "invoices",
      status: "valid",
      reasons: [],
      schema: {
        name: null,
        description: null,
        fields: [{ name: "Mark paid", type: "button" }],
        views: [],
      },
      recordCount: 0,
    });
    expect(result.schema.fields).toEqual([{ name: "Mark paid", type: "button" }]);
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
          nextCursor: null,
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

  it("decodes the shared collection field pipeline wire vector", () => {
    const rawValues = pipelineFixture.vectors.map((vector) => {
      expect(JSON.stringify(vector.expectedWireValue), vector.name).toBe(
        vector.expectedWireJson,
      );
      return {
        field: vector.fieldName,
        value: vector.expectedWireValue,
        validation: vector.expectedValidation,
        resolvedRelations: [],
      };
    });
    const decoded = decodeWorkspaceResult(WORKSPACE_METHOD.collectionsQuery, {
      collection: { path: "pipeline", status: "valid", reasons: [] },
      records: [
        {
          id: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
          path: "pipeline/imported.md",
          conflicted: false,
          values: rawValues,
        },
      ],
      groups: null,
      nextCursor: null,
    });

    expect(decoded.records[0]?.values).toHaveLength(pipelineFixture.vectors.length);
    for (const [index, vector] of pipelineFixture.vectors.entries()) {
      const value = decoded.records[0]?.values[index];
      expect(value?.field, vector.name).toBe(vector.fieldName);
      expect(encodeFixtureBigInts(value?.value), vector.name).toEqual(
        vector.expectedSemantic,
      );
      expect(value?.validation, vector.name).toEqual(
        vector.expectedValidation,
      );
    }
  });

  it.each([
    {
      name: "out-of-safe-range integer",
      marker: { $dohcInt64: "9007199254740993" },
      decoded: 9007199254740993n,
    },
    {
      name: "out-of-safe-range integral float",
      marker: { $dohcFloat64: "100000000000000000000" },
      decoded: 1e20,
    },
  ])(
    "round-trips $name through every collection request and response surface",
    ({ marker, decoded }) => {
    const record = {
      id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      path: "projects/roadmap.md",
      conflicted: false,
      values: [
        {
          field: "estimate",
          value: marker,
          validation: { status: "valid" },
          resolvedRelations: [],
        },
      ],
    };

    const queried = decodeWorkspaceResult(WORKSPACE_METHOD.collectionsQuery, {
      collection: { path: "projects", status: "valid", reasons: [] },
      records: [record],
      groups: [{ value: marker, records: [record] }],
      nextCursor: {
        sortValues: [{ present: true, value: marker }],
        recordPath: record.path,
        recordId: record.id,
      },
    });
    expect(queried.records[0]?.values[0]?.value).toBe(decoded);
    expect(queried.groups?.[0]?.value).toBe(decoded);
    expect(queried.groups?.[0]?.records[0]?.values[0]?.value).toBe(decoded);
    expect(queried.nextCursor?.sortValues[0]?.value).toBe(decoded);

    const fetched = decodeWorkspaceResult(
      WORKSPACE_METHOD.collectionsGetRecord,
      {
        collection: { path: "projects", status: "valid", reasons: [] },
        record,
        history: [
          {
            historyId: 1,
            field: "estimate",
            previous: { present: true, value: marker },
            next: { present: true, value: marker },
            authorOriginId: null,
            actorKind: "agent",
            onBehalfOf: "user:ice",
            depth: 0,
            recordedAtMs: 1,
          },
        ],
        nextBeforeHistoryId: null,
      },
    );
    expect(fetched.record.values[0]?.value).toBe(decoded);
    expect(fetched.history[0]?.previous.value).toBe(decoded);
    expect(fetched.history[0]?.next.value).toBe(decoded);

    expect(
      encodeCollectionQueryParams({
        collectionPath: "projects",
        filter: {
          field: "estimate",
          operator: "equals",
          value: decoded,
        },
        cursor: {
          sortValues: [{ present: true, value: decoded }],
          recordPath: record.path,
          recordId: record.id,
        },
      }),
    ).toMatchObject({
      filter: { value: marker },
      cursor: { sortValues: [{ value: marker }] },
    });

    expect(
      validateFieldValue({ name: "estimate", type: "number" }, decoded),
    ).toEqual({ status: "valid" });

    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.collectionsList, {
        collections: [
          { path: "projects", status: "valid", reasons: [] },
        ],
        nextCursor: null,
      }).collections,
    ).toHaveLength(1);
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.collectionsGet, {
        path: "projects",
        status: "valid",
        reasons: [],
        schema: {
          name: null,
          description: null,
          fields: [],
          views: [],
        },
        recordCount: 1,
      }).recordCount,
    ).toBe(1);
    expect(
      decodeWorkspaceResult(
        WORKSPACE_METHOD.collectionsListPendingAdoptions,
        {
          adoptions: [
            {
              versionId: "main",
              recordId: record.id,
              collectionPath: "projects",
              filePath: record.path,
              objectId: "object",
            },
          ],
          nextCursor: null,
        },
      ).adoptions,
    ).toHaveLength(1);
    },
  );

  it.each(reservedCollectionMarkerObjects)(
    "round-trips reserved marker-shaped user object $value unchanged",
    ({ value, encoded }) => {
      expect(encodeCollectionValue(value)).toEqual(encoded);
      expect(decodeCollectionValue(encoded)).toEqual(value);
    },
  );

  it("keeps reserved marker escaping depth-neutral at the collection depth boundary", () => {
    let value: CollectionValue = "leaf";
    for (let depth = 1; depth < 24; depth += 1) {
      value = { $dohcInt64: value };
    }

    const encoded = encodeCollectionValue(value);

    expect(collectionValueDepth(value)).toBe(24);
    expect(collectionValueDepth(encoded as CollectionValue)).toBe(24);
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
      expect(
        validateFieldValue({ name: "estimate", type: "number" }, decoded),
      ).toEqual({ status: "valid" });
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
      ).toThrow(ProtocolShapeError);
      expect(() => encodeCollectionValue(integer)).toThrow(
        ProtocolShapeError,
      );
    },
  );

  it("enforces safe-range collection integer marker rules", () => {
    expect(() =>
      decodeCollectionValue({ $dohcInt64: "9007199254740991" }),
    ).toThrow(ProtocolShapeError);
    expect(encodeCollectionValue(9007199254740991n)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(encodeCollectionValue(-9007199254740991n)).toBe(
      -Number.MAX_SAFE_INTEGER,
    );
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
    ).toThrow(ProtocolShapeError);
  });

  it.each([
    "01",
    "9007199254740991",
    "100000000000000000001",
  ])("rejects malformed collection float marker %s", (decimal) => {
    expect(() =>
      decodeCollectionValue({ $dohcFloat64: decimal }),
    ).toThrow(ProtocolShapeError);
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
      ).toThrow(ProtocolShapeError);
    },
  );
});

describe("automations wire schemas", () => {
  const summary = {
    claimId: "claim-1",
    automationId: "plugin:hello-plugin/triage",
    trigger: { originId: "origin-a", originSeq: 7 },
    recordId: "record-1",
    collectionPath: "tasks",
    depth: 0,
    change: {
      kind: "changed",
      authorOriginId: "agent-editor",
      actorKind: "agent",
      onBehalfOf: "user:ice",
    },
    state: "pending",
    attempts: 1,
    run: 1,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
  const claim = {
    ...summary,
    change: {
      ...summary.change,
      fields: [
        {
          field: "body",
          historyId: 11,
          previous: null,
          next: { truncated: true, bytes: 9_000 },
        },
        {
          field: "status",
          historyId: 12,
          previous: { value: "open" },
          next: { value: null },
        },
      ],
      fieldsOmitted: 0,
    },
  };

  it("decodes the subscription round trip", () => {
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsSubscribe, {
        subscribed: true,
      }),
    ).toEqual({ subscribed: true });
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsUnsubscribe, {
        unsubscribed: false,
      }),
    ).toEqual({ unsubscribed: false });
  });

  it("decodes a claim from claimNext with its change's field facts", () => {
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsClaimNext, claim),
    ).toEqual(claim);
  });

  it("decodes a Group message claim, whose message has no record and may carry its body truncated", () => {
    const message = {
      ...claim,
      trigger: { key: "message:m1" },
      recordId: null,
      change: {
        ...claim.change,
        kind: "message",
        fields: [],
        message: {
          id: "m1", threadId: "t1", groupId: "trip", lane: "posts", authorKind: "human",
          authorDisplayName: "Ana", authorUserId: "user-ana", createdAtMs: 1, body: { truncated: true, bytes: 70_000 },
        },
      },
    };
    expect(decodeWorkspaceResult(WORKSPACE_METHOD.automationsClaimNext, message)).toEqual(message);
  });

  it("decodes null from a drained claimNext", () => {
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsClaimNext, null),
    ).toBeNull();
  });

  it("decodes a history-keyed failed claim from settle and retry without facts", () => {
    const failed = {
      ...summary,
      trigger: { historyId: 41 },
      change: {
        kind: "added",
        authorOriginId: null,
        actorKind: null,
        onBehalfOf: null,
      },
      state: "failed",
      error: "handler threw",
    };
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsSettle, failed),
    ).toEqual(failed);
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsRetry, summary),
    ).toEqual(summary);
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsRelease, summary),
    ).toEqual(summary);
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.syncRemoteChanges, { applied: 3 }),
    ).toEqual({ applied: 3 });
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.syncRemoteChanges, { applied: 1.5 }),
    ).toThrow(ProtocolShapeError);
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsSettle, claim),
    ).toThrow(ProtocolShapeError);
  });

  it("decodes a removed record's claim keyed by its moment", () => {
    const removed = {
      ...claim,
      trigger: { momentOrder: 42 },
      change: {
        ...claim.change,
        kind: "removed",
        fields: [
          { field: "status", historyId: null, previous: { value: "done" }, next: null },
        ],
      },
    };
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsClaimNext, removed),
    ).toEqual(removed);
  });

  it("decodes the claim history", () => {
    const history = { claims: [summary, { ...summary, state: "done" }] };
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsListClaims, history),
    ).toEqual(history);
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsListClaims, {
        claims: [],
      }),
    ).toEqual({ claims: [] });
  });

  it("decodes the failure listing and refuses a row without a generation", () => {
    const failure = {
      automationId: "plugin:hello-plugin/triage",
      claimId: "claim-1",
      chainStopped: true,
      error: "chain-stopped",
      updatedAtMs: 2_000,
      generation: 3,
    };
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsFailures, {
        failures: [failure],
      }),
    ).toEqual({ failures: [failure] });
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsFailures, {
        failures: [],
      }),
    ).toEqual({ failures: [] });
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsFailures, {
        failures: [
          { automationId: "plugin:hello-plugin/triage", claimId: "claim-1", error: "x" },
        ],
      }),
    ).toThrow(ProtocolShapeError);
  });

  it("decodes keyed claims for a message, a press, and a due time", () => {
    const keyed = (key: string, kind: string, recordId: string | null) => ({
      ...claim,
      automationId: "collection:Invoices#mark-paid",
      trigger: { key },
      recordId,
      change: { ...claim.change, kind, fields: [], fieldsOmitted: 0 },
    });
    const pressed = keyed("press:press-1", "button", "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    const due = keyed("schedule:1790000000000", "schedule", null);
    const facts = {
      id: "m1",
      threadId: "t1",
      groupId: "trip",
      lane: "chat",
      authorKind: "human",
      authorDisplayName: "Ada",
      createdAtMs: 20,
      body: "/task Buy tickets",
    };
    const withMessage = (fields: Record<string, unknown>) => ({
      ...keyed("message:m1", "message", null),
      change: { ...keyed("message:m1", "message", null).change, message: fields },
    });
    const message = withMessage(facts);
    const long = withMessage({
      ...facts,
      body: { truncated: true, bytes: 70_000 },
      parentMessageId: "m0",
      authorOwnerDisplayName: "Ice",
      authorUserId: "ada",
    });
    for (const served of [pressed, due, message, long]) {
      expect(decodeWorkspaceResult(WORKSPACE_METHOD.automationsClaimNext, served)).toEqual(served);
    }
    const { id: _id, ...withoutId } = facts;
    for (const malformed of [
      { ...due, trigger: { key: "" } },
      keyed("message:m1", "message", null),
      withMessage({}),
      withMessage(withoutId),
      withMessage({ ...facts, authorKind: "robot" }),
      withMessage({ ...facts, lane: "posts-and-chat" }),
      withMessage({ ...facts, body: { truncated: false, bytes: 1 } }),
      withMessage({ ...facts, createdAtMs: "20" }),
      withMessage({ ...facts, extra: true }),
      { ...pressed, change: { ...pressed.change, message: facts } },
    ]) {
      expect(() => decodeWorkspaceResult(WORKSPACE_METHOD.automationsClaimNext, malformed)).toThrow(ProtocolShapeError);
    }
  });

  it("decodes a press answer: its claim, or busy with none", () => {
    const pressed = {
      ...summary,
      automationId: "collection:Invoices#mark-paid",
      trigger: { key: "press:press-1" },
      change: { kind: "button", authorOriginId: null, actorKind: "human", onBehalfOf: "user:ada" },
    };
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsPress, { busy: false, claim: pressed }),
    ).toEqual({ busy: false, claim: pressed });
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsPress, { busy: true, claim: null }),
    ).toEqual({ busy: true, claim: null });
    for (const malformed of [{ busy: true, claim: pressed }, { busy: false, claim: null }, { claim: pressed }]) {
      expect(() => decodeWorkspaceResult(WORKSPACE_METHOD.automationsPress, malformed)).toThrow(ProtocolShapeError);
    }
  });

  it("decodes a schedule step and the schedule marks", () => {
    const mark = { automationId: "collection:Invoices#weekday-report", scheduleHash: "h1", throughMs: 3_000 };
    const due = {
      ...summary,
      automationId: mark.automationId,
      trigger: { key: "schedule:2000" },
      recordId: null,
      change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null },
    };
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsClaimSchedule, { claims: [due], mark }),
    ).toEqual({ claims: [due], mark });
    expect(
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsScheduleMarks, { marks: [mark] }),
    ).toEqual({ marks: [mark] });
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.automationsClaimSchedule, { claims: [] }),
    ).toThrow(ProtocolShapeError);
  });

  it("refuses a claim with an unknown state, trigger, change kind, or fact value", () => {
    for (const malformed of [
      { ...claim, state: "paused" },
      { ...claim, trigger: { originId: "origin-a" } },
      { ...claim, change: { ...claim.change, kind: "moved" } },
      { ...claim, change: { ...claim.change, actorKind: "robot" } },
      { ...claim, run: undefined },
      {
        ...claim,
        change: {
          ...claim.change,
          fields: [{ field: "status", historyId: 1, previous: "open", next: null }],
        },
      },
      {
        ...claim,
        change: {
          ...claim.change,
          fields: [
            {
              field: "status",
              historyId: 1,
              previous: { truncated: false, bytes: 1 },
              next: null,
            },
          ],
        },
      },
    ]) {
      expect(() =>
        decodeWorkspaceResult(WORKSPACE_METHOD.automationsClaimNext, malformed),
      ).toThrow(ProtocolShapeError);
    }
  });
});
