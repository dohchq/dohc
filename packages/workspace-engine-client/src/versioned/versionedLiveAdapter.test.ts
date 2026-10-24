import type { HistoryCursor } from "./versionedWireContract";
function historyCursor(): HistoryCursor { return { format: 1, engineUuid: "test", workspaceId: "workspace", versionId: "main", objectId: null, operationId: null, textFence: 41, protectedFence: -1, markerFence: -1, text: null, protected: null, marker: null }; }
import { ProtocolShapeError } from "../wireSchema";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EngineRequestError } from "../daemon/engineClient";
import type { JsonValue, Request, Response } from "../protocol";
import {
  DaemonProtocolError,
  DaemonRefusalError,
  type MinimalDaemonClient,
} from "../live/daemonLiveAdapter";
import {
  WORKSPACE_METHOD,
  decodeWorkspaceResult,
  type ConflictRecord,
  type WorkspaceMethod,
  type WorkspaceMethodParamsMap,
} from "../workspace/workspaceWireContract";
import {
  VERSIONED_METHOD,
  decodeVersionedResult,
  type VersionedMethod,
  type VersionedMethodParamsMap,
} from "./versionedWireContract";
import {
  VersionedAdapterCapabilityError,
  VersionedLiveAdapter,
} from "./versionedLiveAdapter";
import { VersionedLoopbackEngine } from "../testing/versionedLoopbackEngine";

const WORKSPACE = "workspace";
const SENTINEL = new Error("captured");

it("sends the link rewrite request identity and author in the correct fields", async () => {
  const requests: Request[] = [];
  const reply = {documents: 2, links: 4, unchecked: ["open.md"], uncheckedCount: 1, complete: false};
  const adapter = new VersionedLiveAdapter({close() {}, async sendRequest(request: Request): Promise<Response> {
    requests.push(request);
    return {id: request.id, result: reply};
  }}, WORKSPACE, {workspaceId: WORKSPACE});
  expect(await adapter.rewriteHistoryLinks({workspaceId: WORKSPACE, operationId: "dohc-operation:rename", requestId: "rewrite-retry", author: {kind: "agent", agentId: "mover", onBehalfOf: "owner"}})).toEqual(reply);
  expect(requests[0]).toMatchObject({method: "history.rewriteLinks", idempotencyKey: "rewrite-retry", params: {operationId: "dohc-operation:rename", author: {kind: "agent", agentId: "mover", onBehalfOf: "owner"}}});
  expect(requests[0]?.params).not.toHaveProperty("requestId");
  await expect(adapter.rewriteHistoryLinks({workspaceId: "other", operationId: "dohc-operation:rename", requestId: "retry"})).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

type VersionedRequestCase = {
  method: VersionedMethod;
  params: VersionedMethodParamsMap[VersionedMethod];
};

const VERSIONED_REQUEST_CASES: VersionedRequestCase[] = [
  {
    method: VERSIONED_METHOD.textWrite,
    params: { versionId: "main", path: "a.md", text: "a" },
  },
  { method: VERSIONED_METHOD.textRead, params: { versionId: "main", path: "a.md" } },
  {
    method: VERSIONED_METHOD.textReadBlob,
    params: { workspaceId: WORKSPACE, sha256: "a".repeat(64) },
  },
  {
    method: VERSIONED_METHOD.textRename,
    params: { versionId: "main", fromPath: "a.md", toPath: "b.md" },
  },
  { method: VERSIONED_METHOD.textDelete, params: { versionId: "main", path: "a.md" } },
  {
    method: VERSIONED_METHOD.textRollback,
    params: { versionId: "main", path: "a.md", mutationMomentId: "moment" },
  },
  { method: VERSIONED_METHOD.textList, params: { versionId: "main" } },
  { method: VERSIONED_METHOD.textCaptureSources, params: { versionId: "main", paths: ["a.md"], bounds: { maxInputFiles: 1, maxInputBytes: 1024 } } },
  {
    method: VERSIONED_METHOD.binaryWrite,
    params: { versionId: "main", path: "a.bin", bytes: [1] },
  },
  {
    method: VERSIONED_METHOD.binaryWriteBlob,
    params: {
      versionId: "main",
      path: "a.bin",
      sha256: "a".repeat(64),
    },
  },
  { method: VERSIONED_METHOD.binaryRead, params: { versionId: "main", path: "a.bin" } },
  {
    method: VERSIONED_METHOD.binaryReadBlob,
    params: { workspaceId: WORKSPACE, sha256: "a".repeat(64) },
  },
  {
    method: VERSIONED_METHOD.versionsCreateNamed,
    params: { workspaceId: WORKSPACE, name: "draft", fromVersionId: "main" },
  },
  { method: VERSIONED_METHOD.versionsList, params: {} },
  {
    method: VERSIONED_METHOD.versionsSetActive,
    params: { workspaceId: WORKSPACE, versionId: "main" },
  },
  { method: VERSIONED_METHOD.versionsEnsureMain, params: { workspaceId: WORKSPACE } },
  { method: VERSIONED_METHOD.versionsActive, params: { workspaceId: WORKSPACE } },
  {
    method: VERSIONED_METHOD.versionsMerge,
    params: { path: "a.md", sourceVersionId: "draft", targetVersionId: "main" },
  },
  {
    method: VERSIONED_METHOD.versionsCompare,
    params: { path: "a.md", sourceVersionId: "draft", targetVersionId: "main" },
  },
  {
    method: VERSIONED_METHOD.versionsCompareFiles,
    params: { sourceVersionId: "draft", targetVersionId: "main" },
  },
  {
    method: VERSIONED_METHOD.secretsWrite,
    params: {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      text: "A=1",
      origin: "api",
      momentId: "moment",
    },
  },
  { method: VERSIONED_METHOD.secretsList, params: { versionId: "main" } },
  {
    method: VERSIONED_METHOD.secretsStateExists,
    params: { workspaceId: WORKSPACE },
  },
  {
    method: VERSIONED_METHOD.secretsMaterialize,
    params: { versionId: "main", path: ".env" },
  },
  {
    method: VERSIONED_METHOD.secretsDelete,
    params: {
      workspaceId: WORKSPACE,
      versionId: "main",
      path: ".env",
      origin: "api",
      momentId: "moment",
    },
  },
  {
    method: VERSIONED_METHOD.secretsFork,
    params: { workspaceId: WORKSPACE, fromVersionId: "main", toVersionId: "draft" },
  },
  {
    method: VERSIONED_METHOD.secretsCompare,
    params: { workspaceId: WORKSPACE, sourceVersionId: "draft", targetVersionId: "main" },
  },
  {
    method: VERSIONED_METHOD.secretsApply,
    params: {
      workspaceId: WORKSPACE,
      path: ".env",
      sourceVersionId: "draft",
      targetVersionId: "main",
      momentId: "moment",
      origin: "api",
    },
  },
  {
    method: VERSIONED_METHOD.secretsRestore,
    params: {
      workspaceId: WORKSPACE,
      path: ".env",
      beforeMomentId: "before",
      momentId: "after",
      origin: "restore",
    },
  },
  {
    method: VERSIONED_METHOD.secretsMomentsList,
    params: { workspaceId: WORKSPACE },
  },
  {
    method: VERSIONED_METHOD.secretsMomentsGet,
    params: { workspaceId: WORKSPACE, momentId: "moment" },
  },
  { method: VERSIONED_METHOD.momentsList, params: {} },
  { method: VERSIONED_METHOD.momentsGet, params: { momentId: "moment" } },
  {
    method: VERSIONED_METHOD.publicationApplied,
    params: { requestId: "request", momentId: "moment" },
  },
  {
    method: VERSIONED_METHOD.historyPage,
    params: { workspaceId: WORKSPACE },
  },
  {
    method: VERSIONED_METHOD.searchEnsureIndex,
    params: { workspaceId: WORKSPACE, versionId: "main" },
  },
];

type WorkspaceRequestCase = {
  method: Exclude<WorkspaceMethod, "workspace.open">;
  params: WorkspaceMethodParamsMap[
    Exclude<WorkspaceMethod, "workspace.open">
  ];
};

const WORKSPACE_REQUEST_CASES: WorkspaceRequestCase[] = [
  { method: WORKSPACE_METHOD.close, params: {} },
  { method: WORKSPACE_METHOD.conflictsList, params: {} },
  { method: WORKSPACE_METHOD.conflictsOpen, params: { conflict: {} } },
  { method: WORKSPACE_METHOD.conflictsResolve, params: { local: {} } },
  { method: WORKSPACE_METHOD.watcherStatus, params: {} },
  { method: WORKSPACE_METHOD.captureClearRecovery, params: { momentId: "recovery" } },
  { method: WORKSPACE_METHOD.captureFlush, params: {} },
  { method: WORKSPACE_METHOD.captureSetAuthor, params: { author: null } },
];

const snapshot = {
  workspaceId: WORKSPACE,
  versionId: "main",
  objectId: "object",
  path: "a.md",
  text: "hello",
  contentKind: "text",
  sha256: "a".repeat(64),
  byteLength: 5,
  blobSha256: "a".repeat(64),
  updatedAtMs: 1,
  latestMomentId: "moment",
  metadataOrigin: "api",
  metadataSummary: "Updated a.md",
  metadataCorrelationId: "capture-1",
} as const;
const conflictState = {
  path: "a.md",
  contentKind: "text",
  snapshot,
  binarySha256: null,
  binaryByteLength: null,
  binaryObjectId: null,
  binaryLatestMomentId: null,
  metadataSummary: null,
  metadataCorrelationId: null,
} as const;
const conflict: ConflictRecord = {
  id: "conflict",
  workspaceId: WORKSPACE,
  path: "a.md",
  targetVersionId: "main",
  sourceVersionId: "draft",
  createdAtMs: 1,
  updatedAtMs: 2,
  status: "open",
  chosenFrom: "current",
  resolution: null,
  metadata: { origin: "merge", summary: null, correlationId: null },
  base: conflictState,
  current: conflictState,
  incoming: conflictState,
};

const collectionSummary = {
  path: "projects",
  objectId: "object-projects",
  status: "degraded",
  reasons: [{ code: "unknown-field-reference", path: "/views/0/groupBy" }],
};
const collectionRecord = {
  id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  path: "projects/roadmap.md",
  conflicted: true,
  values: [
    {
      field: "status",
      value: "active",
      validation: { status: "valid" },
      resolvedRelations: [],
    },
    {
      field: "legacy",
      value: { nested: [1, true, null] },
      validation: { status: "untyped" },
      resolvedRelations: [
        { recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb", label: "Linked" },
      ],
    },
  ],
};

const WORKSPACE_DECODER_CASES: Array<{
  method: WorkspaceMethod;
  valid: Parameters<typeof decodeWorkspaceResult>[1];
}> = [
  { method: WORKSPACE_METHOD.open, valid: { workspace: WORKSPACE } },
  { method: WORKSPACE_METHOD.close, valid: { closed: true } },
  {
    method: WORKSPACE_METHOD.conflictsList,
    valid: { conflicts: [conflict], nextAfterConflictId: null },
  },
  { method: WORKSPACE_METHOD.conflictsOpen, valid: { inserted: true } },
  {
    method: WORKSPACE_METHOD.conflictsResolve,
    valid: { conflict, write: null, delete: null },
  },
  {
    method: WORKSPACE_METHOD.collectionsList,
    valid: { collections: [collectionSummary], nextCursor: null },
  },
  {
    method: WORKSPACE_METHOD.collectionsListPendingAdoptions,
    valid: {
      adoptions: [
        {
          versionId: "main",
          recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
          collectionPath: "projects",
          filePath: "projects/roadmap.md",
          objectId: "object",
        },
      ],
      nextCursor: {
        filePath: "projects/roadmap.md",
        recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
  },
  {
    method: WORKSPACE_METHOD.collectionsGet,
    valid: {
      ...collectionSummary,
      schema: {
        name: "Projects",
        description: null,
        fields: [{ name: "status", type: "text" }],
        views: [
          {
            name: "All",
            kind: "table",
            groupBy: null,
            sort: [{ field: "status", direction: "asc" }],
            visibleFields: null,
            dateField: null,
          },
        ],
      },
      recordCount: 1,
    },
  },
  {
    method: WORKSPACE_METHOD.collectionsQuery,
    valid: {
      collection: collectionSummary,
      records: [collectionRecord],
      groups: [{ value: "active", records: [collectionRecord] }],
      nextCursor: {
        sortValues: [{ present: true, value: "active" }],
        recordPath: collectionRecord.path,
        recordId: collectionRecord.id,
      },
    },
  },
  {
    method: WORKSPACE_METHOD.collectionsGetRecord,
    valid: {
      collection: collectionSummary,
      record: collectionRecord,
      history: [
        {
          historyId: 1,
          field: "status",
          previous: { present: false, value: null },
          next: { present: true, value: "active" },
          authorOriginId: null,
          actorKind: null,
          onBehalfOf: null,
          depth: null,
          recordedAtMs: 1,
          automationRun: null,
          linkAuthor: null,
        },
      ],
      nextBeforeHistoryId: null,
    },
  },
  {
    method: WORKSPACE_METHOD.watcherStatus,
    valid: {
      running: true,
      degraded: false,
      terminal: false,
      phase: "ready",
      noAtomicPlacement: false, recoveryUnavailable: false, deferredWrites: [], keptFiles: [], captureRecoveries: [], heldFiles: [], retainedCopies: { count: 0, bytes: 0 },
    },
  },
  {
    method: WORKSPACE_METHOD.captureClearRecovery,
    valid: { cleared: true },
  },
  {
    method: WORKSPACE_METHOD.captureFlush,
    valid: { deferredWrites: [], settled: true, running: true, degraded: false, heldFiles: [] },
  },
  {
    method: WORKSPACE_METHOD.captureSetAuthor,
    valid: { updated: true },
  },
];

function captureClient(requests: Request[]): MinimalDaemonClient {
  return {
    close: () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      throw SENTINEL;
    },
  };
}

describe("VersionedLiveAdapter", () => {
  it("retries a held path with the real flush and retried result", async () => {
    const result = { deferredWrites: [], settled: true, running: true, degraded: false, retried: false, heldFiles: [] };
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
      requests.push(request); return { id: request.id, result };
    } }, WORKSPACE, { workspaceId: WORKSPACE });
    expect(await adapter.retryHeldCapture("notes/held.md")).toEqual(result);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "capture.retryHeld", params: { path: "notes/held.md" } });
  });
  it.each(["workspaceId", "engineUuid", "versionId", "objectId"] as const)("rejects a History cursor from another %s", async field => {
    const engine = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter({ sendRequest: request => engine.sendRequest(request), close: () => undefined }, WORKSPACE, { workspaceId: WORKSPACE });
    await adapter.ensureMainVersion({ workspaceId: WORKSPACE });
    const first = await adapter.readHistoryPage({ workspaceId: WORKSPACE });
    await expect(adapter.readHistoryPage({ workspaceId: WORKSPACE, cursor: { ...first.startCursor, [field]: "another" } })).rejects.toThrow("invalid-input");
  });

  it("rejects an actual cursor issued by another engine", async () => {
    const make = async () => {
      const engine = new VersionedLoopbackEngine();
      const adapter = new VersionedLiveAdapter({ sendRequest: request => engine.sendRequest(request), close: () => undefined }, WORKSPACE, { workspaceId: WORKSPACE });
      await adapter.ensureMainVersion({ workspaceId: WORKSPACE });
      return adapter;
    };
    const source = await make(), target = await make();
    const first = await source.readHistoryPage({ workspaceId: WORKSPACE });
    await expect(target.readHistoryPage({ workspaceId: WORKSPACE, cursor: first.startCursor })).rejects.toThrow("invalid-input");
  });
  it.each(["api", "local-file"] as const)("records %s text without publishing unless explicitly requested", async (origin) => {
    const loopback = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter({ sendRequest: (request) => loopback.sendRequest(request), close: () => undefined }, WORKSPACE, { workspaceId: WORKSPACE });
    const input = { workspaceId: WORKSPACE, versionId: "main", path: "captured.txt", text: "on disk", requestId: "capture", metadata: { origin } };
    const captured = await adapter.writeTextFile(input);
    expect(captured.materializeOutcome).toBe("skipped");
    expect(captured.materialized).toBe(false);
    await expect(adapter.writeTextFile({ ...input, publish: true })).rejects.toThrow();
    const authored = await adapter.writeTextFile({ ...input, requestId: "authored", text: "authored", publish: true });
    expect(authored.materializeOutcome).toBe("applied");
    expect(loopback.requests.filter(request => request.method === VERSIONED_METHOD.textWrite).map(request => (request.params as { publish?: boolean }).publish)).toEqual([undefined, true, true]);
  });

  it.each([128 * 1024 - 1, 128 * 1024, 128 * 1024 + 1, 10 * 1024 * 1024])("keeps %i UTF-8 bytes as text and reuses the caller key", async (bytes) => {
    const loopback = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter({ sendRequest: (request) => loopback.sendRequest(request), close: () => undefined }, WORKSPACE, { workspaceId: WORKSPACE });
    const text = "a".repeat(bytes - 3) + "€";
    const input = { workspaceId: WORKSPACE, versionId: "main", path: "large.txt", text, publish: true, requestId: "stable", metadata: { origin: "api" as const } };
    const first = await adapter.writeTextFile(input);
    const replay = await adapter.writeTextFile(input);
    expect(first.snapshot.text).toBe(text);
    expect(replay.moment.momentId).toBe(first.moment.momentId);
    expect(replay.materializeOutcome).toBe("applied");
    expect(loopback.requests.filter(request => request.method.includes("write")).map(request => request.method)).toEqual(Array(2).fill(bytes > 128 * 1024 ? VERSIONED_METHOD.textWriteBlob : VERSIONED_METHOD.textWrite));
    expect(loopback.requests.filter(request => request.method.includes("write")).every(request => request.idempotencyKey === "stable")).toBe(true);
  });

  it("refuses authored text above 10 MiB", async () => {
    const loopback = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter({ sendRequest: (request) => loopback.sendRequest(request), close: () => undefined }, WORKSPACE, { workspaceId: WORKSPACE });
    await expect(adapter.writeTextFile({ workspaceId: WORKSPACE, versionId: "main", path: "large.txt", text: "a".repeat(10 * 1024 * 1024 - 2) + "€", metadata: { origin: "api" } })).rejects.toThrow();
  });

  it("replays only the exact authored create request", async () => {
    const loopback = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter({
      sendRequest: (request) => loopback.sendRequest(request), close: () => undefined,
    }, WORKSPACE, { workspaceId: WORKSPACE });
    await adapter.ensureMainVersion({ workspaceId: WORKSPACE });
    const input = {
      workspaceId: WORKSPACE, versionId: "main", path: "new.md", text: "original",
      publish: true, createOnly: true, requestId: "create-request", metadata: { origin: "api" as const },
    };
    const first = await adapter.writeTextFile(input);
    const replay = await adapter.writeTextFile(input);
    expect(replay.deduped).toBe(true);
    expect(replay.moment.momentId).toBe(first.moment.momentId);
    await expect(adapter.writeTextFile({ ...input, text: "changed" })).rejects.toThrow();
    await expect(adapter.writeTextFile({ ...input, requestId: "other-create" })).rejects.toThrow("target-path-exists");
    const ordinary = { ...input, createOnly: false, path: "ordinary.md", requestId: "ordinary-request" };
    await adapter.writeTextFile(ordinary);
    await expect(adapter.writeTextFile({ ...ordinary, createOnly: true })).rejects.toThrow();
  });

  it("confirms a keyed publication only for the moment its request recorded", async () => {
    const loopback = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter({ sendRequest: (request) => loopback.sendRequest(request), close: () => undefined }, WORKSPACE, { workspaceId: WORKSPACE });
    await adapter.ensureMainVersion({ workspaceId: WORKSPACE });
    const base = { workspaceId: WORKSPACE, versionId: "main", metadata: { origin: "api" as const } };
    const published = await adapter.writeTextFile({ ...base, path: "published.md", text: "a", publish: true, requestId: "published" });
    const recorded = await adapter.writeTextFile({ ...base, path: "recorded.md", text: "b", requestId: "recorded" });
    const expectedSha256 = createHash("sha256").update("a").digest("hex");
    const checked = await adapter.deleteTextFile({ ...base, path: "published.md", expectedSha256, requestId: "checked" });
    const unchecked = await adapter.deleteTextFile({ ...base, path: "recorded.md", requestId: "unchecked" });
    const applied = (requestId: string, momentId: string) => adapter.publicationApplied({ workspaceId: WORKSPACE, requestId, momentId });
    // A published write and a checked delete reach disk inside the engine.
    expect(await applied("published", published.moment.momentId)).toBe(true);
    expect(await applied("checked", checked.moment.momentId)).toBe(true);
    // A recorded-only write and an unchecked delete never confirm publication.
    expect(await applied("recorded", recorded.moment.momentId)).toBe(false);
    expect(await applied("unchecked", unchecked.moment.momentId)).toBe(false);
    // A request binds only to the moment it recorded.
    expect(await applied("published", checked.moment.momentId)).toBe(false);
    expect(await applied("missing", published.moment.momentId)).toBe(false);
    await expect(applied("", published.moment.momentId)).rejects.toThrow();
  });

  it("seeds a delete's moment from its envelope key and replays only that payload", async () => {
    const loopback = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter({
      sendRequest: (request) => loopback.sendRequest(request), close: () => undefined,
    }, WORKSPACE, { workspaceId: WORKSPACE });
    await adapter.ensureMainVersion({ workspaceId: WORKSPACE });
    for (const path of ["gone.md", "keep.md"]) {
      await adapter.writeTextFile({ workspaceId: WORKSPACE, versionId: "main", path, text: path, metadata: { origin: "api" } });
    }
    const input = { workspaceId: WORKSPACE, versionId: "main", path: "gone.md", requestId: "undo", metadata: { origin: "api" as const } };
    const first = await adapter.deleteTextFile(input);
    const replay = await adapter.deleteTextFile(input);
    expect(first.moment.momentId).toBe("moment-9d2c5f198351202686a63750833ad3570ce3a554f83c63262b085071d2612002");
    expect(replay.deduped).toBe(true);
    expect(replay.moment.momentId).toBe(first.moment.momentId);
    await expect(adapter.deleteTextFile({ ...input, path: "keep.md" })).rejects.toThrow("idempotency-key-reuse-mismatch");
    const deletes = loopback.requests.filter(request => request.method === VERSIONED_METHOD.textDelete);
    expect(deletes.map(request => request.idempotencyKey)).toEqual(["undo", "undo", "undo"]);
  });

  it("refuses a body requestId beside the envelope key on every versioned mutation", async () => {
    const loopback = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter({
      sendRequest: (request) => loopback.sendRequest(request), close: () => undefined,
    }, WORKSPACE, { workspaceId: WORKSPACE });
    await adapter.ensureMainVersion({ workspaceId: WORKSPACE });
    const seeded = await adapter.writeTextFile({ workspaceId: WORKSPACE, versionId: "main", path: "seed.md", text: "seed", metadata: { origin: "api" } });
    const before = (await adapter.listMoments({ workspaceId: WORKSPACE })).moments.length;
    const bytes = Buffer.from("body");
    const blob = { sha256: createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64") };
    const cases: Array<[VersionedMethod, { [key: string]: JsonValue }]> = [
      [VERSIONED_METHOD.textWrite, { versionId: "main", path: "body.md", text: "body", origin: "api" }],
      [VERSIONED_METHOD.textWriteBlob, { versionId: "main", path: "body.md", ...blob, origin: "api" }],
      [VERSIONED_METHOD.binaryWrite, { versionId: "main", path: "body.bin", bytes: [1, 2], origin: "api" }],
      [VERSIONED_METHOD.binaryWriteBlob, { versionId: "main", path: "body.bin", ...blob, origin: "api" }],
      [VERSIONED_METHOD.textRename, { versionId: "main", fromPath: "seed.md", toPath: "moved.md", origin: "api" }],
      [VERSIONED_METHOD.textDelete, { versionId: "main", path: "seed.md", origin: "api" }],
      [VERSIONED_METHOD.textRollback, { versionId: "main", path: "seed.md", mutationMomentId: seeded.moment.momentId, origin: "restore" }],
      [VERSIONED_METHOD.versionsMerge, { path: "seed.md", sourceVersionId: "main", targetVersionId: "main", origin: "api" }],
    ];
    let id = 100;
    for (const [method, params] of cases) {
      for (const bodyKey of ["body-key", "other-key"]) {
        await expect(loopback.sendRequest({
          id: id++, method, workspace: WORKSPACE, idempotencyKey: "body-key", params: { ...params, requestId: bodyKey },
        })).rejects.toThrow("invalid parameters");
      }
    }
    expect((await adapter.listMoments({ workspaceId: WORKSPACE })).moments).toHaveLength(before);
    // The refusals recorded nothing under the key they named.
    const written = await adapter.writeTextFile({ workspaceId: WORKSPACE, versionId: "main", path: "body.md", text: "body", requestId: "body-key", metadata: { origin: "api" } });
    expect(written.deduped).toBe(false);
  });

  it("requires a workspace binding before the adapter can issue requests", () => {
    const requests: Request[] = [];
    expect(() => {
      // @ts-expect-error The logical workspace binding is intentionally required.
      new VersionedLiveAdapter(captureClient(requests), WORKSPACE);
    }).toThrow(VersionedAdapterCapabilityError);
    expect(requests).toEqual([]);
  });

  it.each([undefined, "object-1"])("reads one aggregate history page for %s with one daemon request", async (objectId) => {
    const requests: Request[] = [];
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        requests.push(request);
        return {
          id: request.id,
          result: {
            activeVersion: {
              id: "main",
              workspaceId: WORKSPACE,
              kind: "main",
              name: "Main",
              createdAtMs: 1,
            },

              moments: [],
              nextCursor: null,
              latestMomentOrder: -1,
          protectedMoments: [], startCursor: historyCursor(), versionMarkers: [],

          },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.readHistoryPage({
        workspaceId: WORKSPACE,
        ...(objectId !== undefined ? { objectId } : {}),
        limit: 50,
        cursor: historyCursor(),
      }),
    ).resolves.toMatchObject({
      activeVersion: { id: "main" },
       moments: [], protectedMoments: [], startCursor: historyCursor(), nextCursor: null, versionMarkers: [],

    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: VERSIONED_METHOD.historyPage,
      params: {
        workspaceId: WORKSPACE,
        ...(objectId !== undefined ? { objectId } : {}),
        limit: 50,
        cursor: historyCursor(),
      },
    });
  });

  it("passes one conflicts.list page through with the daemon's continuation", async () => {
    // The drain that undid the daemon's paging lived here. One call is
    // one page — a second request from a single call is the drain coming back.
    const requests: Request[] = [];
    const second = { ...conflict, id: "conflict-2", createdAtMs: 2 };
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        requests.push(request);
        const afterConflictId = (
          request.params as { afterConflictId?: string }
        ).afterConflictId;
        return {
          id: request.id,
          result:
            afterConflictId === undefined
              ? {
                  conflicts: [conflict],
                  nextAfterConflictId: conflict.id,
                }
              : {
                  conflicts: [second],
                  nextAfterConflictId: null,
                },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.listTextConflicts({
        workspaceId: WORKSPACE,
        status: "open",
      }),
    ).resolves.toEqual({
      conflicts: [conflict],
      nextAfterConflictId: conflict.id,
    });
    expect(requests.map((request) => request.params)).toEqual([
      { status: "open" },
    ]);

    // The caller continues by handing the token back, one page per call.
    await expect(
      adapter.listTextConflicts({
        workspaceId: WORKSPACE,
        status: "open",
        afterConflictId: conflict.id,
      }),
    ).resolves.toEqual({ conflicts: [second], nextAfterConflictId: null });
    expect(requests.map((request) => request.params)).toEqual([
      { status: "open" },
      { status: "open", afterConflictId: conflict.id },
    ]);
  });

  it("maps one versions.compareFiles page onto the store's entry page", async () => {
    const requests: Request[] = [];
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        requests.push(request);
        return {
          id: request.id,
          result: {
            entries: [
              { path: "a.md", status: "modified" },
              { path: "b.png", status: "added", binary: true },
            ],
            nextCursor: "b.png",
          },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.compareVersionFilesPage({
        workspaceId: WORKSPACE,
        sourceVersionId: "version-1",
        targetVersionId: "main",
        afterPath: "0.md",
      }),
    ).resolves.toEqual({
      entries: [
        { path: "a.md", status: "modified" },
        { path: "b.png", status: "added", binary: true },
      ],
      nextAfterPath: "b.png",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe(VERSIONED_METHOD.versionsCompareFiles);
    expect(requests[0]!.params).toEqual({
      workspaceId: WORKSPACE,
      sourceVersionId: "version-1",
      targetVersionId: "main",
      afterPath: "0.md",
    });
  });

  it("hydrates a withheld conflict side through the text blob route", async () => {
    // The daemon degrades a conflicts.list row past its frame cap: the side
    // body arrives as `text: null` beside `inbandLimitBytes` and `blobSha256`.
    const body = "an over-cap side body";
    const bodySha = createHash("sha256").update(body, "utf8").digest("hex");
    const withheld: ConflictRecord = {
      ...conflict,
      current: {
        ...conflictState,
        snapshot: {
          ...snapshot,
          text: null,
          inbandLimitBytes: 128 * 1024,
          byteLength: body.length,
          blobSha256: bodySha,
        },
      },
    };
    const requests: Request[] = [];
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        requests.push(request);
        if (request.method === WORKSPACE_METHOD.conflictsList) {
          return {
            id: request.id,
            result: { conflicts: [withheld], nextAfterConflictId: null },
          };
        }
        expect(request.method).toBe(VERSIONED_METHOD.textReadBlob);
        expect((request.params as { sha256?: string }).sha256).toBe(bodySha);
        return {
          id: request.id,
          result: {
            bytesBase64: Buffer.from(body, "utf8").toString("base64"),
          },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    const listed = await adapter.listTextConflicts({ workspaceId: WORKSPACE });
    expect(listed.conflicts).toHaveLength(1);
    const hydrated = listed.conflicts[0]!.current.snapshot;
    expect(hydrated?.text).toBe(body);
    // The hydration hint does not outlive the hydration.
    expect(hydrated?.inbandLimitBytes).toBeUndefined();
    // Sides that carried their bodies in band are returned as served, with
    // no extra blob round trips.
    expect(listed.conflicts[0]!.base.snapshot?.text).toBe("hello");
    expect(listed.conflicts[0]!.incoming.snapshot?.text).toBe("hello");
    expect(
      requests.filter(
        (request) => request.method === VERSIONED_METHOD.textReadBlob,
      ),
    ).toHaveLength(1);
  });

  it("reads no bodies for a metadata-only conflict listing", async () => {
    // A metadata-only conflict listing must not fetch bodies it will not use.
    const withheld: ConflictRecord = {
      ...conflict,
      current: {
        ...conflictState,
        snapshot: { ...snapshot, text: null, inbandLimitBytes: 128 * 1024 },
      },
    };
    const requests: Request[] = [];
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        requests.push(request);
        expect(request.method).toBe(WORKSPACE_METHOD.conflictsList);
        return {
          id: request.id,
          result: { conflicts: [withheld], nextAfterConflictId: null },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    const listed = await adapter.listTextConflicts({
      workspaceId: WORKSPACE,
      bodies: "withheld",
    });
    expect(listed.conflicts).toHaveLength(1);
    // Served exactly as the daemon sent it: still withheld, not an empty body.
    expect(listed.conflicts[0]!.current.snapshot?.text).toBeNull();
    expect(
      requests.filter(
        (request) => request.method === VERSIONED_METHOD.textReadBlob,
      ),
    ).toHaveLength(0);
  });

  it("cuts a hydrated conflict page to its byte budget before fetching bodies", async () => {
    // The concurrency limit bounds simultaneous reads, not retained bytes. A
    // page of degraded conflicts whose sides approach the daemon's text limit
    // is kilobytes of metadata on the wire and hundreds of megabytes once
    // rebuilt. The page is cut by the `byteLength` each withheld side already
    // carries, so the bodies past the budget are never transferred.
    //
    const body = "rebuilt";
    const bodySha = createHash("sha256").update(body, "utf8").digest("hex");
    const huge = (id: string): ConflictRecord => ({
      ...conflict,
      id,
      base: { ...conflictState, snapshot: null },
      incoming: { ...conflictState, snapshot: null },
      current: {
        ...conflictState,
        snapshot: {
          ...snapshot,
          text: null,
          inbandLimitBytes: 128 * 1024,
          // Each side alone fits the budget; two together cannot.
          byteLength: 5 * 1024 * 1024,
          blobSha256: bodySha,
        },
      },
    });
    const requests: Request[] = [];
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        requests.push(request);
        if (request.method === WORKSPACE_METHOD.conflictsList) {
          return {
            id: request.id,
            result: {
              conflicts: [huge("conflict-a"), huge("conflict-b")],
              nextAfterConflictId: null,
            },
          };
        }
        return {
          id: request.id,
          result: { bytesBase64: Buffer.from(body, "utf8").toString("base64") },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    const listed = await adapter.listTextConflicts({ workspaceId: WORKSPACE });
    expect(listed.conflicts).toHaveLength(1);
    expect(listed.conflicts[0]!.id).toBe("conflict-a");
    expect(listed.conflicts[0]!.current.snapshot?.text).toBe(body);
    // The caller continues from the row the cut stopped at, not the daemon's
    // own continuation, or the dropped conflict would never be served.
    expect(listed.nextAfterConflictId).toBe("conflict-a");
    // The body past the budget was never fetched.
    expect(
      requests.filter(
        (request) => request.method === VERSIONED_METHOD.textReadBlob,
      ),
    ).toHaveLength(1);
  });

  it("refuses a withheld conflict side whose blob the daemon cannot serve", async () => {
    // A withheld side names its body by digest. When the daemon then cannot
    // serve that digest, silently returning the null-bodied record would hand
    // readers an empty document that looks like an edit.
    const withheld: ConflictRecord = {
      ...conflict,
      current: {
        ...conflictState,
        snapshot: {
          ...snapshot,
          text: null,
          inbandLimitBytes: 128 * 1024,
        },
      },
    };
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        if (request.method === WORKSPACE_METHOD.conflictsList) {
          return {
            id: request.id,
            result: { conflicts: [withheld], nextAfterConflictId: null },
          };
        }
        throw Object.assign(new Error("file-not-found"), {
          wireError: {
            code: "INVALID_PARAMS",
            message: "file-not-found",
            retry: "no",
          },
        });
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.listTextConflicts({ workspaceId: WORKSPACE }),
    ).rejects.toThrow(DaemonProtocolError);
  });

  it("consumes the matching out-of-band blob for an over-cap binary read", async () => {
    const bytes = new Uint8Array([0, 255, 17, 42, 99]);
    const sha256 = "a".repeat(64);
    const requests: Request[] = [];
    const blobHandlers = new Set<
      Parameters<NonNullable<MinimalDaemonClient["onBlob"]>>[0]
    >();
    const client: MinimalDaemonClient = {
      close: () => undefined,
      helloAck: { capabilities: ["blobs"] },
      onBlob(handler) {
        blobHandlers.add(handler);
        return () => blobHandlers.delete(handler);
      },
      async sendRequest(request): Promise<Response> {
        requests.push(request);
        if (request.method === VERSIONED_METHOD.binaryRead) {
          return {
            id: request.id,
            result: {
              objectId: "object",
              sha256,
              byteLength: bytes.byteLength,
              bytesBase64: null,
              inbandLimitBytes: 48 * 1024,
            },
          };
        }
        for (const handler of blobHandlers) {
          handler({
            requestId: request.id + 100,
            streamId: 999,
            totalBytes: 1,
            sha256,
            bytes: new Uint8Array([7]),
          });
          handler({
            requestId: request.id,
            streamId: request.id,
            totalBytes: bytes.byteLength,
            sha256,
            bytes,
          });
        }
        return {
          id: request.id,
          result: {
            bytesBase64: null,
            byteLength: bytes.byteLength,
            inbandLimitBytes: 48 * 1024,
          },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.readBinaryFile({
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "large.bin",
      }),
    ).resolves.toEqual(bytes);
    expect(requests.map((request) => request.method)).toEqual([
      VERSIONED_METHOD.binaryRead,
      VERSIONED_METHOD.binaryReadBlob,
    ]);
    expect(blobHandlers.size).toBe(0);
  });

  it("round-trips a BOM-prefixed over-cap text body exactly", async () => {
    const text = `\uFEFF${"x".repeat(128 * 1024 + 1)}`;
    const bytes = new TextEncoder().encode(text);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const requests: Request[] = [];
    const blobHandlers = new Set<
      Parameters<NonNullable<MinimalDaemonClient["onBlob"]>>[0]
    >();
    const client: MinimalDaemonClient = {
      close: () => undefined,
      helloAck: { capabilities: ["blobs"] },
      onBlob(handler) {
        blobHandlers.add(handler);
        return () => blobHandlers.delete(handler);
      },
      async sendRequest(request): Promise<Response> {
        requests.push(request);
        if (request.method === VERSIONED_METHOD.textRead) {
          return {
            id: request.id,
            result: {
              workspaceId: WORKSPACE,
              versionId: "main",
              objectId: "object",
              path: "large.md",
              contentKind: "text",
              text: null,
              sha256,
              blobSha256: sha256,
              byteLength: bytes.byteLength,
              updatedAtMs: 1,
              latestMomentId: "moment",
              metadataOrigin: "api",
              inbandLimitBytes: 128 * 1024,
            },
          };
        }
        for (const handler of blobHandlers) {
          handler({
            requestId: request.id,
            streamId: request.id,
            totalBytes: bytes.byteLength,
            sha256,
            bytes,
          });
        }
        return {
          id: request.id,
          result: {
            bytesBase64: null,
            byteLength: bytes.byteLength,
            inbandLimitBytes: 48 * 1024,
          },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    const read = await adapter.readTextFile({
      workspaceId: WORKSPACE,
      versionId: "main",
      path: "large.md",
    });
    const hydratedText = read?.text;
    expect(typeof hydratedText).toBe("string");
    if (typeof hydratedText !== "string") throw new Error("missing hydrated text");

    expect(hydratedText.charCodeAt(0)).toBe(0xfeff);
    expect(createHash("sha256").update(hydratedText).digest("hex")).toBe(sha256);
    expect(read).not.toHaveProperty("inbandLimitBytes");
    expect(requests.map((request) => request.method)).toEqual([
      VERSIONED_METHOD.textRead,
      VERSIONED_METHOD.textReadBlob,
    ]);
    expect(blobHandlers.size).toBe(0);
  });

  it("writes an over-cap binary by digest instead of embedding its bytes", async () => {
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: WORKSPACE },
    );
    const bytes = new Uint8Array(48 * 1024 + 1).fill(7);

    await expect(
      adapter.writeBinaryFile({
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "asset.bin",
        bytes,
        metadata: { origin: "restore", summary: "Restore asset" },
      }),
    ).rejects.toBe(SENTINEL);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: VERSIONED_METHOD.binaryWriteBlob,
      params: {
        versionId: "main",
        path: "asset.bin",
        sha256: "be094ba239945c6a73d6f4bb49cebcede4910e2fc62f5daa17946f1f0af5d39a",
        origin: "restore",
        summary: "Restore asset",
      },
    });
    expect(requests[0]?.params).not.toHaveProperty("bytes");
    expect(requests[0]?.params).not.toHaveProperty("bytesBase64");
  });

  it("mutation proof: routes a 16,385-byte binary around the wire collection limit", async () => {
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: WORKSPACE },
    );

    await expect(
      adapter.writeBinaryFile({
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "collection-limit.bin",
        bytes: new Uint8Array(16_385).fill(3),
        metadata: { origin: "api" },
      }),
    ).rejects.toBe(SENTINEL);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe(VERSIONED_METHOD.binaryWriteBlob);
    expect(requests[0]?.params).not.toHaveProperty("bytes");
  });

  it("uses the full-range blob endpoint for a new over-cap binary", async () => {
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: WORKSPACE },
    );
    const bytes = new Uint8Array(48 * 1024 + 1).fill(11);

    await expect(
      adapter.writeBinaryFile({
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "new-asset.bin",
        bytes,
        metadata: { origin: "api" },
      }),
    ).rejects.toBe(SENTINEL);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: VERSIONED_METHOD.binaryWriteBlob,
      params: {
        versionId: "main",
        path: "new-asset.bin",
        sha256: "a676bf58279257bf7913f059ee405a3c40aab6be644a0ffd072a3aa3231f58ca",
        bytesBase64: Buffer.from(bytes).toString("base64"),
        origin: "api",
      },
    });
    expect(requests[0]?.params).not.toHaveProperty("bytes");
  });

  it("fails with a typed capability error when blob egress is unavailable", async () => {
    const client: MinimalDaemonClient = {
      close: () => undefined,
      helloAck: { capabilities: [] },
      onBlob: () => () => undefined,
      async sendRequest(request): Promise<Response> {
        return {
          id: request.id,
          result:
            request.method === VERSIONED_METHOD.binaryRead
              ? {
                  objectId: "object",
                  sha256: "b".repeat(64),
                  byteLength: 49 * 1024,
                  bytesBase64: null,
                  inbandLimitBytes: 48 * 1024,
                }
              : {
                  bytesBase64: null,
                  byteLength: 49 * 1024,
                  inbandLimitBytes: 48 * 1024,
                },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.readBinaryFile({
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "large.bin",
      }),
    ).rejects.toBeInstanceOf(VersionedAdapterCapabilityError);
  });

  it("correlates concurrent blob reads across adapters sharing a transport", async () => {
    const blobHandlers = new Set<
      Parameters<NonNullable<MinimalDaemonClient["onBlob"]>>[0]
    >();
    const pending: Array<{
      request: Request;
      resolve: (response: Response) => void;
    }> = [];
    const client: MinimalDaemonClient = {
      close: () => undefined,
      helloAck: { capabilities: ["blobs"] },
      onBlob(handler) {
        blobHandlers.add(handler);
        return () => blobHandlers.delete(handler);
      },
      sendRequest(request): Promise<Response> {
        return new Promise((resolve) => {
          pending.push({ request, resolve });
          if (pending.length !== 2) return;
          for (const entry of pending) {
            const sha256 = (entry.request.params as { sha256: string }).sha256;
            const bytes = new Uint8Array([
              sha256 === "a".repeat(64) ? 1 : 2,
            ]);
            for (const handler of blobHandlers) {
              handler({
                requestId: entry.request.id,
                streamId: entry.request.id,
                totalBytes: bytes.byteLength,
                sha256,
                bytes,
              });
            }
          }
          for (const entry of pending) {
            entry.resolve({
              id: entry.request.id,
              result: {
                bytesBase64: null,
                byteLength: 1,
                inbandLimitBytes: 48 * 1024,
              },
            });
          }
        });
      },
    };
    const first = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });
    const second = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      Promise.all([
        first.readBinaryBlob({
          workspaceId: WORKSPACE,
          sha256: "a".repeat(64),
        }),
        second.readBinaryBlob({
          workspaceId: WORKSPACE,
          sha256: "b".repeat(64),
        }),
      ]),
    ).resolves.toEqual([new Uint8Array([1]), new Uint8Array([2])]);
    expect(new Set(pending.map(({ request }) => request.id)).size).toBe(2);
    expect(blobHandlers.size).toBe(0);
  });

  it("returns null when the daemon reports a missing binary blob", async () => {
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        throw new EngineRequestError(request.id, {
          code: "INVALID_PARAMS",
          message: "file-not-found",
          retry: "no",
        });
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.readBinaryBlob({
        workspaceId: WORKSPACE,
        sha256: "c".repeat(64),
      }),
    ).resolves.toBeNull();
  });

  it("preserves the store null contract when an older daemon refuses a text-headed binary read", async () => {
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        throw new EngineRequestError(request.id, {
          code: "INVALID_PARAMS",
          message: "text-head-not-binary",
          retry: "no",
        });
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.readBinaryFile({
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "note.md",
      }),
    ).resolves.toBeNull();
  });

  it("does not hide unrelated invalid binary-read parameters as an absent value", async () => {
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request) {
        throw new EngineRequestError(request.id, {
          code: "INVALID_PARAMS",
          message: "invalid-version",
          retry: "no",
        });
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.readBinaryFile({
        workspaceId: WORKSPACE,
        versionId: "missing",
        path: "note.md",
      }),
    ).rejects.toMatchObject({
      name: "DaemonRefusalError",
      wireCode: "INVALID_PARAMS",
      message: "invalid-version",
    });
  });

  it("rejects a caller-supplied delete moment id the daemon cannot preserve", async () => {
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    await expect(
      adapter.deleteTextFile({
        workspaceId: "workspace",
        versionId: "main",
        path: "notes/delete.md",
        metadata: { origin: "api" },
        momentId: "caller-moment",
      }),
    ).rejects.toBeInstanceOf(VersionedAdapterCapabilityError);
    expect(requests).toEqual([]);
  });

  it("forwards text and binary mutation metadata without dropping it", async () => {
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    const mutations = [
      {
        method: VERSIONED_METHOD.textWrite,
        metadata: { summary: "Write note" },
        mutate: () =>
        adapter.writeTextFile({
          workspaceId: "workspace",
          versionId: "main",
          path: "notes/write.md",
          text: "text",
          metadata: { origin: "api", summary: "Write note" },
        }),
      },
      {
        method: VERSIONED_METHOD.binaryWrite,
        metadata: { correlationId: "binary-write" },
        mutate: () =>
        adapter.writeBinaryFile({
          workspaceId: "workspace",
          versionId: "main",
          path: "asset.bin",
          bytes: new Uint8Array([1]),
          metadata: { origin: "api", correlationId: "binary-write" },
        }),
      },
      {
        method: VERSIONED_METHOD.versionsMerge,
        metadata: { summary: "Merge note" },
        mutate: () =>
        adapter.mergeTextFileFromVersion({
          workspaceId: "workspace",
          targetVersionId: "main",
          sourceVersionId: "feature",
          path: "notes/merge.md",
          metadata: { origin: "api", summary: "Merge note" },
        }),
      },
      {
        method: VERSIONED_METHOD.textRename,
        metadata: { correlationId: "rename-note" },
        mutate: () =>
        adapter.renameTextFile({
          workspaceId: "workspace",
          versionId: "main",
          fromPath: "notes/old.md",
          toPath: "notes/new.md",
          metadata: { origin: "api", correlationId: "rename-note" },
        }),
      },
      {
        method: VERSIONED_METHOD.textDelete,
        metadata: {
          summary: "Delete note",
          expectedObjectId: "accepted-object",
          onlyIfAbsentOnDisk: true,
        },
        mutate: () =>
        adapter.deleteTextFile({
          workspaceId: "workspace",
          versionId: "main",
          path: "notes/delete.md",
          expectedObjectId: "accepted-object",
          onlyIfAbsentOnDisk: true,
          metadata: { origin: "api", summary: "Delete note" },
        }),
      },
    ];

    for (const entry of mutations) {
      await expect(entry.mutate()).rejects.toBe(SENTINEL);
      expect(requests.at(-1)).toMatchObject({
        method: entry.method,
        params: entry.metadata,
        idempotencyKey: expect.any(String),
      });
      expect(requests.at(-1)?.params).not.toHaveProperty("requestId");
    }
  });

  it("forwards metadata for every secret mutation, including restore", async () => {
    const requests: Request[] = [];
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        requests.push(request);
        if (request.method === VERSIONED_METHOD.secretsMomentsGet) {
          return {
            id: request.id,
            result: {
              id: "secret-moment",
              workspaceId: WORKSPACE,
              versionId: "main",
              path: ".env",
              recordedAtMs: 1,
              operation: "write",
              metadata: {
                origin: "api",
                summary: null,
                correlationId: null,
              },
              momentOrder: 1,
              protected: true,
            },
          };
        }
        throw SENTINEL;
      },
    };
    const adapter = new VersionedLiveAdapter(
      client,
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    await expect(
      adapter.writeSecretFile({
        workspaceId: "workspace",
        versionId: "main",
        path: ".env",
        text: "TOKEN=value",
        metadata: { origin: "api", summary: "Set token" },
      }),
    ).rejects.toBe(SENTINEL);
    expect(requests.at(-1)).toMatchObject({
      method: VERSIONED_METHOD.secretsWrite,
      params: { summary: "Set token" },
    });
    await expect(
      adapter.deleteSecretFile({
        workspaceId: "workspace",
        versionId: "main",
        path: ".env",
        metadata: { origin: "api", correlationId: "operation-1" },
      }),
    ).rejects.toBe(SENTINEL);
    expect(requests.at(-1)).toMatchObject({
      method: VERSIONED_METHOD.secretsDelete,
      params: { correlationId: "operation-1" },
    });
    await expect(
      adapter.restoreSecretFileToBeforeMoment({
        workspaceId: "workspace",
        momentId: "secret-moment",
        metadata: {
          origin: "restore",
          summary: "Undo secret change",
          correlationId: "operation-restore",
        },
      }),
    ).rejects.toBe(SENTINEL);
    expect(requests.at(-1)).toMatchObject({
      method: VERSIONED_METHOD.secretsRestore,
      params: {
        path: ".env",
        beforeMomentId: "secret-moment",
        origin: "restore",
        summary: "Undo secret change",
        correlationId: "operation-restore",
      },
    });

    await expect(
      adapter.applySecretFileFromVersion({
        workspaceId: "workspace",
        sourceVersionId: "source",
        targetVersionId: "target",
        path: ".env",
        metadata: {
          origin: "sync",
          summary: "Apply source secret",
          correlationId: "operation-2",
        },
      }),
    ).rejects.toBe(SENTINEL);
    expect(requests.at(-1)).toMatchObject({
      method: VERSIONED_METHOD.secretsApply,
      params: {
        origin: "sync",
        summary: "Apply source secret",
        correlationId: "operation-2",
      },
    });
  });

  it("encodes every one of the 33 versioned methods with exact params", async () => {
    expect(VERSIONED_REQUEST_CASES).toHaveLength(36);
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: WORKSPACE },
    );

    for (const entry of VERSIONED_REQUEST_CASES) {
      await expect(
        adapter.request(entry.method as never, entry.params as never),
      ).rejects.toBe(SENTINEL);
      expect(requests.at(-1)).toMatchObject({
        method: entry.method,
        workspace: WORKSPACE,
        params: entry.params,
      });
    }
  });

  it("encodes workspace.open and representative bound workspace-family methods", async () => {
    const openRequests: Request[] = [];
    const captureAuthor = {
      kind: "agent" as const,
      agentId: "agent",
      onBehalfOf: "local",
      agentRunId: "run",
    };
    await expect(
      VersionedLiveAdapter.openWorkspace(captureClient(openRequests), {
        rootDir: "C:/shadow",
        workspaceId: WORKSPACE,
        captureAuthor,
      }),
    ).rejects.toBe(SENTINEL);
    expect(openRequests[0]).toMatchObject({
      method: WORKSPACE_METHOD.open,
      params: {
        rootDir: "C:/shadow",
        workspaceId: WORKSPACE,
        captureAuthor,
      },
    });
    expect(openRequests[0]?.workspace).toBeUndefined();

    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: WORKSPACE },
    );
    for (const entry of WORKSPACE_REQUEST_CASES) {
      await expect(
        adapter.workspaceRequest(entry.method as never, entry.params as never),
      ).rejects.toBe(SENTINEL);
      expect(requests.at(-1)).toMatchObject({
        method: entry.method,
        workspace: WORKSPACE,
        params: entry.params,
      });
    }
  });

  it("encodes the collection reads with their exact methods and params", async () => {
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: WORKSPACE },
    );
    const query = {
      collectionPath: "projects",
      filter: {
        field: "metadata",
        operator: "contains" as const,
        value: { nested: ["active", 1, true, null] },
      },
      sort: [
        { field: "due", direction: "asc" as const },
        { field: "title", direction: "desc" as const },
      ],
      groupBy: "status",
      resolveRelations: true,
      limit: 25,
      cursor: {
        sortValues: [
          { present: true, value: "2026-09-01" },
          { present: false, value: null },
        ],
        recordPath: "projects/roadmap.md",
        recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    };

    await expect(adapter.listCollections()).rejects.toBe(SENTINEL);
    await expect(
      adapter.getCollection({ collectionPath: "projects" }),
    ).rejects.toBe(SENTINEL);
    await expect(
      adapter.listPendingCollectionAdoptions({
        limit: 25,
        cursor: {
          filePath: "projects/old.md",
          recordId: "rec_zzzzzzzzzzzzzzzzzzzzzzzzzz",
        },
      }),
    ).rejects.toBe(SENTINEL);
    await expect(adapter.queryCollectionRecords(query)).rejects.toBe(SENTINEL);
    await expect(
      adapter.getCollectionRecord({
        collectionPath: "projects",
        recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        historyLimit: 25,
        beforeHistoryId: 17,
      }),
    ).rejects.toBe(SENTINEL);

    expect(
      requests.map(
        ({ method, workspace, params, idempotencyKey, deadlineMs }) => ({
          method,
          workspace,
          params,
          idempotencyKey,
          deadlineMs,
        }),
      ),
    ).toEqual([
      {
        method: "collections.list",
        workspace: WORKSPACE,
        params: {},
        idempotencyKey: undefined,
        deadlineMs: undefined,
      },
      {
        method: "collections.get",
        workspace: WORKSPACE,
        params: { collectionPath: "projects" },
        idempotencyKey: undefined,
        deadlineMs: undefined,
      },
      {
        method: "collections.listPendingAdoptions",
        workspace: WORKSPACE,
        params: {
          limit: 25,
          cursor: {
            filePath: "projects/old.md",
            recordId: "rec_zzzzzzzzzzzzzzzzzzzzzzzzzz",
          },
        },
        idempotencyKey: undefined,
        deadlineMs: undefined,
      },
      {
        method: "collections.query",
        workspace: WORKSPACE,
        params: query,
        idempotencyKey: undefined,
        deadlineMs: undefined,
      },
      {
        method: "collections.getRecord",
        workspace: WORKSPACE,
        params: {
          collectionPath: "projects",
          recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
          historyLimit: 25,
          beforeHistoryId: 17,
        },
        idempotencyKey: undefined,
        deadlineMs: undefined,
      },
    ]);
  });

  it("hydrates near-limit collection results from correlated blob egress", async () => {
    const notes = "x".repeat(10 * 1024 * 1024 - 1024);
    const markedInteger = { $dohcInt64: "9007199254740993" };
    const record = {
      id: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      path: "projects/roadmap.md",
      conflicted: false,
      values: [
        {
          field: "notes",
          value: notes,
          validation: { status: "valid" },
          resolvedRelations: [],
        },
        {
          field: "estimate",
          value: markedInteger,
          validation: { status: "valid" },
          resolvedRelations: [],
        },
      ],
    };
    const results = {
      [WORKSPACE_METHOD.collectionsGet]: {
        path: "projects",
        objectId: "object-projects",
        status: "valid",
        reasons: [],
        schema: {
          name: "Projects",
          description: notes,
          fields: [],
          views: [],
        },
        recordCount: 1,
      },
      [WORKSPACE_METHOD.collectionsQuery]: {
        collection: { path: "projects", objectId: "object-projects", status: "valid", reasons: [] },
        records: [record],
        groups: null,
        nextCursor: null,
      },
      [WORKSPACE_METHOD.collectionsGetRecord]: {
        collection: { path: "projects", objectId: "object-projects", status: "valid", reasons: [] },
        record,
        history: [],
        nextBeforeHistoryId: null,
      },
    } as const;
    const blobHandlers = new Set<
      Parameters<NonNullable<MinimalDaemonClient["onBlob"]>>[0]
    >();
    const client: MinimalDaemonClient = {
      close: () => undefined,
      helloAck: { capabilities: ["blobs"] },
      onBlob(handler) {
        blobHandlers.add(handler);
        return () => blobHandlers.delete(handler);
      },
      async sendRequest(request): Promise<Response> {
        const method = request.method as keyof typeof results;
        const bytes = new TextEncoder().encode(JSON.stringify(results[method]));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        for (const handler of blobHandlers) {
          handler({
            requestId: request.id,
            streamId: request.id,
            totalBytes: bytes.byteLength,
            sha256,
            bytes,
          });
        }
        return {
          id: request.id,
          result: {
            collectionJson: null,
            blobSha256: sha256,
            byteLength: bytes.byteLength,
            inbandLimitBytes: 8 * 1024 * 1024,
          },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    const collection = await adapter.getCollection({
      collectionPath: "projects",
    });
    const queried = await adapter.queryCollectionRecords({
      collectionPath: "projects",
      limit: 1,
    });
    const fetched = await adapter.getCollectionRecord({
      collectionPath: "projects",
      recordId: record.id,
      historyLimit: 1,
    });

    expect(collection.schema.description).toBe(notes);
    expect(queried.records[0]?.values[0]?.value).toBe(notes);
    expect(queried.records[0]?.values[1]?.value).toBe(9007199254740993n);
    expect(fetched.record.values[0]?.value).toBe(notes);
    expect(fetched.record.values[1]?.value).toBe(9007199254740993n);
  });

  it.each(WORKSPACE_DECODER_CASES)(
    "strictly decodes $method and rejects malformed or unknown fields",
    ({ method, valid }) => {
      expect(() => decodeWorkspaceResult(method as never, valid)).not.toThrow();
      expect(() =>
        decodeWorkspaceResult(method as never, { unexpected: true }),
      ).toThrow(ProtocolShapeError);
    },
  );

  it("decodes a withheld conflict body from either surface as a hydration hint", () => {
    // `conflicts.resolve` withholds over-cap sides to keep its answer inside
    // one control frame (`settled_conflict_json`, lib.rs), and `conflicts.list`
    // withholds the sides of a row past the conflict row frame cap.
    // The null is a hint, not content: `blobSha256` names the body, and
    // `listTextConflicts` hydrates it — or throws — before any reader sees
    // the record.
    const withheld = {
      ...conflict,
      base: {
        ...conflict.base,
        snapshot: { ...snapshot, text: null, inbandLimitBytes: 131072 },
      },
    };

    const listed = decodeWorkspaceResult(WORKSPACE_METHOD.conflictsList, {
      conflicts: [withheld],
      nextAfterConflictId: null,
    }) as { conflicts: ConflictRecord[] };
    expect(listed.conflicts[0]?.base.snapshot?.text).toBeNull();
    expect(listed.conflicts[0]?.base.snapshot?.inbandLimitBytes).toBe(131072);

    const resolved = decodeWorkspaceResult(WORKSPACE_METHOD.conflictsResolve, {
      conflict: withheld,
      write: null,
      delete: null,
    }) as { conflict: ConflictRecord };
    expect(resolved.conflict.base.snapshot?.text).toBeNull();
    expect(resolved.conflict.base.snapshot?.inbandLimitBytes).toBe(131072);

    // A body is a string or an explicit withholding — never anything else.
    expect(() =>
      decodeWorkspaceResult(WORKSPACE_METHOD.conflictsList, {
        conflicts: [
          {
            ...conflict,
            base: { ...conflict.base, snapshot: { ...snapshot, text: 5 } },
          },
        ],
        nextAfterConflictId: null,
      }),
    ).toThrow(ProtocolShapeError);
  });

  it("keeps the daemon's provenance fields on decoded conflict snapshots", () => {
    const decoded = decodeWorkspaceResult(WORKSPACE_METHOD.conflictsList, {
      conflicts: [conflict],
      nextAfterConflictId: null,
    }) as { conflicts: ConflictRecord[] };
    const base = decoded.conflicts[0]?.base.snapshot;
    expect(base?.metadataSummary).toBe("Updated a.md");
    expect(base?.metadataCorrelationId).toBe("capture-1");
  });

  it("strictly decodes the newly dispatched versioned list, compare, and empty acknowledgements", () => {
    expect(
      decodeVersionedResult(VERSIONED_METHOD.textList, {
        files: [
          {
            path: "a.md",
            objectId: "object",
            contentKind: "text",
            sha256: "a".repeat(64),
            byteLength: 1,
            binarySha256: null,
            updatedAtMs: 1,
            latestMomentId: "moment",
            metadataOrigin: "api",
            hasYdocMarker: false,
          },
        ],
        nextAfterPath: null,
      }),
    ).toMatchObject({ files: [{ path: "a.md" }] });
    expect(
      decodeVersionedResult(VERSIONED_METHOD.versionsCompare, {
        workspaceId: WORKSPACE,
        path: "a.md",
        targetVersionId: "main",
        sourceVersionId: "draft",
        base: snapshot,
        current: null,
        incoming: snapshot,
        status: "incoming-changed",
      }),
    ).toMatchObject({
      path: "a.md",
      status: "incoming-changed",
      current: null,
    });
    expect(
      decodeVersionedResult(VERSIONED_METHOD.secretsFork, {}),
    ).toEqual({});
    expect(
      decodeVersionedResult(VERSIONED_METHOD.searchEnsureIndex, {}),
    ).toEqual({});

    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.textList, {
        files: [],
        nextAfterPath: null,
        unknown: true,
      }),
    ).toThrow(ProtocolShapeError);
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.versionsCompare, {
        status: "same",
      }),
    ).toThrow(ProtocolShapeError);
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.secretsFork, { accepted: true }),
    ).toThrow(ProtocolShapeError);
  });

  it("maps daemon refusals through the shared retryability contract", async () => {
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        throw new EngineRequestError(request.id, {
          code: "SESSION_EXPIRED",
          message: "reopen",
          retry: "afterReconnect",
        });
      },
    };

    await expect(
      new VersionedLiveAdapter(client, WORKSPACE, {
        workspaceId: WORKSPACE,
      }).request(
        VERSIONED_METHOD.versionsActive,
        {},
      ),
    ).rejects.toMatchObject({
      name: "DaemonRefusalError",
      retry: "afterReconnect",
      disposition: "afterReconnect",
      wireCode: "SESSION_EXPIRED",
    } satisfies Partial<DaemonRefusalError>);
  });

  it("refuses local author controls and byte budgets before rename, delete, or rollback", async () => {
    const loopback = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter({
      sendRequest: request => loopback.sendRequest(request), close: () => undefined,
    }, WORKSPACE, { workspaceId: WORKSPACE });
    const main = await adapter.ensureMainVersion({ workspaceId: WORKSPACE });
    const input = { workspaceId: WORKSPACE, versionId: main.id, path: "a.txt" };
    const seed = await adapter.writeTextFile({ ...input, text: "kept", metadata: { origin: "api" } });
    const valid = { kind: "agent" as const, agentId: "agent", onBehalfOf: "person" };
    const invalid = [
      { ...valid, agentId: "é".repeat(257) },
      { ...valid, onBehalfOf: "x".repeat(513) },
      { ...valid, agentRunId: "x".repeat(513) },
      { ...valid, agentId: "agent\n" },
      { ...valid, onBehalfOf: "person\u0085" },
      { ...valid, name: "agent\u009f" },
      { ...valid, name: "x".repeat(128 * 1024) },
    ];
    for (const author of invalid) {
      await expect(adapter.renameTextFile({ ...input, fromPath: input.path, toPath: "b.txt",
        metadata: { origin: "api" }, author })).rejects.toThrow("invalid-metadata");
      await expect(adapter.deleteTextFile({ ...input, metadata: { origin: "api" }, author }))
        .rejects.toThrow("invalid-metadata");
      await expect(adapter.rollbackTextFileMutation({ ...input, mutationMomentId: seed.moment.momentId,
        origin: "api", author })).rejects.toThrow("invalid-metadata");
    }
    expect((await adapter.readTextFile(input))?.text).toBe("kept");
    expect((await adapter.listMoments({ workspaceId: WORKSPACE })).moments).toHaveLength(1);
    const moved = await adapter.renameTextFile({ ...input, fromPath: input.path, toPath: "b.txt",
      metadata: { origin: "api" }, author: { ...valid, agentId: "é".repeat(256) } });
    expect(moved.moment.authors).toEqual([{ ...valid, agentId: "é".repeat(256) }]);
  });

  it("decodes loopback responses through the live adapter", async () => {
    const loopback = new VersionedLoopbackEngine();
    const adapter = new VersionedLiveAdapter(
      {
        sendRequest: (request) => loopback.sendRequest(request),
        close: () => undefined,
      },
      WORKSPACE,
      { workspaceId: WORKSPACE },
    );

    const main = await adapter.ensureMainVersion({ workspaceId: WORKSPACE });
    await expect(
      adapter.secretStateExists({ workspaceId: WORKSPACE }),
    ).resolves.toBe(false);
    const write = await adapter.writeTextFile({
      workspaceId: WORKSPACE,
      versionId: main.id,
      path: "a.md",
      text: "hello",
      metadata: { origin: "api" },
    });
    const read = await adapter.readTextFile({
      workspaceId: WORKSPACE,
      versionId: main.id,
      path: "a.md",
    });
    await adapter.writeSecretFile({
      workspaceId: WORKSPACE,
      versionId: main.id,
      path: ".env",
      text: "TOKEN=loopback",
      metadata: { origin: "api" },
    });

    expect(write.snapshot.text).toBe("hello");
    expect(read?.text).toBe("hello");
    await expect(
      adapter.secretStateExists({ workspaceId: WORKSPACE }),
    ).resolves.toBe(true);
  });
});

describe("listTextFileMetadata under a folder", () => {
  const row = (path: string) => ({ path, objectId: path, contentKind: "text", sha256: "a".repeat(64), byteLength: 1, binarySha256: null,
    updatedAtMs: 1, latestMomentId: "moment", metadataOrigin: "api", hasYdocMarker: false });
  it("starts after the folder and stops at the first path past it", async () => {
    const paths = ["app.txt", "app/a.html", "app/b/c.css", "app/d.js", "app0/x.js", "zeta.md"].sort();
    const requests: Array<Record<string, unknown>> = [];
    const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request: Request): Promise<Response> {
      const params = request.params as Record<string, unknown>;
      requests.push(params);
      const rest = paths.filter(path => path > String(params.afterPath ?? ""));
      // Two rows a page, so the folder spans a page boundary.
      const files = rest.slice(0, 2).map(row);
      return { id: request.id, result: { files, nextAfterPath: rest.length > 2 ? files.at(-1)!.path : null } };
    } }, WORKSPACE, { workspaceId: WORKSPACE });
    const files = await adapter.listTextFileMetadata({ workspaceId: WORKSPACE, versionId: "main", under: "app" });
    expect(files.map(file => file.path)).toEqual(["app/a.html", "app/b/c.css", "app/d.js"]);
    expect(requests.map(request => request.afterPath)).toEqual(["app/", "app/b/c.css"]);
  });
  it("reads one bounded page from the folder or a cursor and reports whether the folder continues", async () => {
    const paths = ["app.txt", "app/a.html", "app/b/c.css", "app/d.js", "app0/x.js"].sort();
    const requests: Array<Record<string, unknown>> = [];
    const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request: Request): Promise<Response> {
      const params = request.params as Record<string, unknown>;
      requests.push(params);
      const rest = paths.filter(path => path > String(params.afterPath ?? "")), files = rest.slice(0, Number(params.limit)).map(row);
      return { id: request.id, result: { files, nextAfterPath: rest.length > files.length ? files.at(-1)!.path : null } };
    } }, WORKSPACE, { workspaceId: WORKSPACE });
    const first = await adapter.listTextFilePage({ workspaceId: WORKSPACE, versionId: "main", under: "app", limit: 2 });
    expect([first.files.map(file => file.path), first.more]).toEqual([["app/a.html", "app/b/c.css"], true]);
    const last = await adapter.listTextFilePage({ workspaceId: WORKSPACE, versionId: "main", under: "app", afterPath: "app/b/c.css", limit: 2 });
    expect([last.files.map(file => file.path), last.more]).toEqual([["app/d.js"], false]);
    expect(requests).toEqual([{ versionId: "main", limit: 2, afterPath: "app/" }, { versionId: "main", limit: 2, afterPath: "app/b/c.css" }]);
  });
});


describe("shared file update states", () => {
  it("looks up only recorded outboxes, batching at the wire limit", async () => {
    const requests: string[] = [];
    const draft = (path: string, nativeUnsettled: boolean, pendingBytes = 0) => ({
      binding: {workspaceId: WORKSPACE, mainVersionId: "main", objectId: path, lineageClaimId: "a".repeat(64),
        currentPath: path, selectorPaths: [path], restoreFenceGeneration: 0},
      relayDatabaseNamespace: "relay", revision: 1, acceptedCursor: 1, nativeHeadSequence: 2,
      nativeUnsettled, outboxId: pendingBytes ? "outbox" : null, pendingBytes, state: pendingBytes ? "active" : null,
    });
    const writes = Array.from({length: 65}, (_, sequence) => ({outboxId: `outbox-${sequence}`, appendKey: `write-${sequence}`,
      binding: draft("renamed.md", false).binding, nativeHeadSequence: 2}));
    const adapter = new VersionedLiveAdapter({close() {}, async sendRequest(request: Request): Promise<Response> {
      requests.push(request.method);
      if (request.method !== "ydoc.ownerDelivery.listDrafts") throw new Error("ydoc-session-busy");
      const params = request.params as Record<string, unknown>;
      expect(params.limit).toBe(64);
      const batch = params.writes as typeof writes;
      expect(batch.length).toBeLessThanOrEqual(64);
      expect(batch.every(write => writes.includes(write) || writes.some(original => original.outboxId === write.outboxId))).toBe(true);
      return {id: request.id, result: {states: batch.map(write => write.appendKey === "write-1" ? "absent" : "pending")}};
    }}, WORKSPACE, {workspaceId: WORKSPACE});
    const expected = Array(65).fill("pending");
    expected[1] = "absent";
    expect(await adapter.sharedFileUpdateStates(writes)).toEqual(expected);
    expect(requests).toEqual(Array(2).fill("ydoc.ownerDelivery.listDrafts"));
  });
});


describe("outage typing recovery import", () => {
  const checkpoint = {
    versionId: "main", objectId: "object", path: "note.md", expectedClaimId: "claim",
    expectedStateVectorSha256: "a".repeat(64), expectedDiskSha256: "b".repeat(64), admittedBaseBase64: "AAA=", text: "kept typing",
    updates: [{requestId: "original", updateBase64: "AAA=", actorOriginId: "person",
      attribution: {actorKind: "human" as const, onBehalfOf: "person", depth: 0}}],
  };
  it.each(["replayed", "covered", "imported"])("preserves original requests and authors for a committed %s reply", async outcome => {
    const reply = {committed: true, outcome, momentId: outcome === "imported" ? "recovery-moment" : null};
    const adapter = new VersionedLiveAdapter({close() {}, async sendRequest(request: Request): Promise<Response> {
      expect(request.method).toBe("capture.importRecovery");
      expect(request.workspace).toBe(WORKSPACE);
      expect(request.params).toEqual(checkpoint);
      return {id: request.id, result: reply};
    }}, WORKSPACE, {workspaceId: WORKSPACE});
    expect(await adapter.importRecovery(checkpoint)).toEqual(reply);
  });
  it.each([
    {committed: false, outcome: "covered", momentId: null},
    {committed: true, outcome: "unknown", momentId: null},
  ])("refuses malformed retirement acknowledgements %#", async reply => {
    const adapter = new VersionedLiveAdapter({close() {}, async sendRequest(request: Request): Promise<Response> {
      return {id: request.id, result: reply};
    }}, WORKSPACE, {workspaceId: WORKSPACE});
    await expect(adapter.importRecovery(checkpoint)).rejects.toThrow();
  });
});

it("sends Undo retry identity in the request envelope and reads body-free operation references", async () => {
  const requests: Request[]=[];
  const client:MinimalDaemonClient={close:()=>undefined,sendRequest:async request=>{
    requests.push(request);
    return {id:request.id,result:{operationId:"dohc-operation:minted",versionId:"main",momentCount:0,...(request.method===VERSIONED_METHOD.historyUndo?{notRestored: [], compensationOperationId:"dohc-operation:undo:replayed",deduped:true,materialized:false}:{kind:"file-duplicate"})}};
  }};
  const adapter=new VersionedLiveAdapter(client,WORKSPACE,{workspaceId:WORKSPACE});
  await adapter.holdCapture({operationId:"dohc-operation:minted"}).catch(()=>undefined);
  expect(await adapter.readHistoryOperation({workspaceId:WORKSPACE,operationId:"dohc-operation:minted"})).toMatchObject({kind:"file-duplicate"});
  await adapter.undoHistoryOperation({workspaceId:WORKSPACE,operationId:"dohc-operation:minted",requestId:"retry"});
  expect(requests[0]?.params).toEqual({operationId:"dohc-operation:minted"});
  expect(requests[1]).toMatchObject({method:"history.operations",params:{operationId:"dohc-operation:minted"}});
  expect(requests[2]).toMatchObject({method:"history.undo",idempotencyKey:"retry",params:{operationId:"dohc-operation:minted"}});
  expect(requests[2]?.params).not.toHaveProperty("requestId");
});

it("forwards link batches through the workspace handle and rejects malformed replies", async () => {
  const requests: Request[] = [];
  let result: JsonValue = { versionId: "main", results: [{ path: "target.md", fragment: null }], mountsCovered: true };
  const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) { requests.push(request); return { id: request.id, result }; } }, WORKSPACE, { workspaceId: WORKSPACE });
  const input = { source: "source.md", literals: [{ kind: "wikilink" as const, literal: "target" }] };
  expect(await adapter.resolveLinks(input)).toEqual(result);
  expect(requests[0]).toMatchObject({ method: "links.resolve", workspace: WORKSPACE, params: input });
  result = { versionId: "main", results: [], mountsCovered: true };
  await expect(adapter.resolveLinks(input)).rejects.toThrow("different literal count");
  result = null;
  expect(await adapter.incomingLinks({ subject: { objectId: "absent" } })).toBeNull();
  result = { entries: [] };
  await expect(adapter.incomingLinks({ subject: { path: "target.md" } })).rejects.toThrow();
});

it("binds edge pages to the workspace handle and validates the shared record budget", async () => {
  const requests: Request[] = [];
  let result: JsonValue = {versionId:"main",files:[{objectId:"a",path:"a.md",title:"A"}],entries:[],unchecked:[],complete:false,indexBuilding:true,mountsCovered:false,nextCursor:"sealed"};
  const adapter = new VersionedLiveAdapter({close(){},async sendRequest(request){requests.push(request);return {id:request.id,result};}}, WORKSPACE, {workspaceId:WORKSPACE});
  expect(await adapter.linkEdges({cursor:"previous"})).toEqual(result);
  expect(requests[0]).toMatchObject({method:"links.edges",workspace:WORKSPACE,params:{cursor:"previous"}});
  result = {...result,unchecked:Array.from({length:100},()=> "pending.md")};
  await expect(adapter.linkEdges({})).rejects.toThrow("100 records");
});
