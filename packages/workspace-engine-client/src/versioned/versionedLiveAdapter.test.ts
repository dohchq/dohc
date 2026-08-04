import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import {
  DaemonProtocolError,
  DaemonRefusalError,
  type MinimalDaemonClient,
} from "../live/daemonLiveAdapter";
import {
  WORKSPACE_METHOD,
  WorkspaceProtocolShapeError,
  decodeWorkspaceResult,
  type ConflictRecord,
  type WorkspaceMethod,
  type WorkspaceMethodParamsMap,
} from "../workspace/workspaceWireContract";
import {
  VERSIONED_METHOD,
  VersionedProtocolShapeError,
  decodeVersionedResult,
  type VersionedMethod,
  type VersionedMethodParamsMap,
} from "./versionedWireContract";
import {
  VersionedAdapterCapabilityError,
  VersionedLiveAdapter,
} from "./versionedLiveAdapter";
import { VersionedLoopbackEngine } from "./versionedLoopbackEngine";

const WORKSPACE = "workspace";
const SENTINEL = new Error("captured");

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
  {
    method: WORKSPACE_METHOD.searchQuery,
    params: { versionId: "main", query: "hello" },
  },
  { method: WORKSPACE_METHOD.watcherStatus, params: {} },
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
  { method: WORKSPACE_METHOD.searchQuery, valid: [] },
  {
    method: WORKSPACE_METHOD.watcherStatus,
    valid: { running: true, degraded: false, terminal: false },
  },
  {
    method: WORKSPACE_METHOD.captureFlush,
    valid: { settled: true, running: true, degraded: false },
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
  it("requires a workspace binding before the adapter can issue requests", () => {
    const requests: Request[] = [];
    expect(() => {
      // @ts-expect-error The logical workspace binding is intentionally required.
      new VersionedLiveAdapter(captureClient(requests), WORKSPACE);
    }).toThrow(VersionedAdapterCapabilityError);
    expect(requests).toEqual([]);
  });

  it("passes ONE conflicts.list page through with the daemon's continuation", async () => {
    // #562: the drain that undid the daemon's paging lived here. One call is
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
    // MUTATION: drop the hydration branch in `listTextConflicts` and this
    // side reaches the caller with no body at all.
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
    // `listOpenConflictIds` drains every page to collect ids. Hydrating for it
    // fetches every body of every open conflict and keeps none of them.
    // MUTATION: drop the `bodies: "withheld"` early return and this listing
    // issues a blob read.
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
    // MUTATION: drop the budget cut in `listTextConflicts` and both conflicts
    // hydrate, issuing a second blob read.
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
      async sendRequest(): Promise<Response> {
        throw {
          wireError: {
            code: "INVALID_PARAMS",
            message: "file-not-found",
            retry: "no",
          },
        };
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
      async sendRequest() {
        throw {
          wireError: {
            code: "INVALID_PARAMS",
            message: "text-head-not-binary",
            retry: "no",
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
        path: "note.md",
      }),
    ).resolves.toBeNull();
  });

  it("does not hide unrelated invalid binary-read parameters as an absent value", async () => {
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest() {
        throw {
          wireError: {
            code: "INVALID_PARAMS",
            message: "invalid-version",
            retry: "no",
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
        metadata: { summary: "Delete note" },
        mutate: () =>
        adapter.deleteTextFile({
          workspaceId: "workspace",
          versionId: "main",
          path: "notes/delete.md",
          metadata: { origin: "api", summary: "Delete note" },
        }),
      },
    ];

    for (const entry of mutations) {
      await expect(entry.mutate()).rejects.toBe(SENTINEL);
      expect(requests.at(-1)).toMatchObject({
        method: entry.method,
        params: entry.metadata,
      });
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
    expect(VERSIONED_REQUEST_CASES).toHaveLength(33);
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

  it("encodes workspace.open and all eight bound workspace-family methods", async () => {
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

  it.each(WORKSPACE_DECODER_CASES)(
    "strictly decodes $method and rejects malformed or unknown fields",
    ({ method, valid }) => {
      expect(() => decodeWorkspaceResult(method as never, valid)).not.toThrow();
      expect(() =>
        decodeWorkspaceResult(method as never, { unexpected: true }),
      ).toThrow(WorkspaceProtocolShapeError);
    },
  );

  it("decodes a withheld conflict body from either surface as a hydration hint", () => {
    // `conflicts.resolve` withholds over-cap sides to keep its answer inside
    // one control frame (`settled_conflict_json`, lib.rs), and `conflicts.list`
    // withholds the sides of a row past the conflict row frame cap (#537).
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
    ).toThrow(WorkspaceProtocolShapeError);
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
    ).toThrow(VersionedProtocolShapeError);
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.versionsCompare, {
        status: "same",
      }),
    ).toThrow(VersionedProtocolShapeError);
    expect(() =>
      decodeVersionedResult(VERSIONED_METHOD.secretsFork, { accepted: true }),
    ).toThrow(VersionedProtocolShapeError);
  });

  it("maps daemon refusals through the shared retryability contract", async () => {
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(): Promise<Response> {
        throw {
          wireError: {
            code: "SESSION_EXPIRED",
            message: "reopen",
            retry: "afterReconnect",
          },
        };
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

  it("bounds concurrent hydration when listing text files", async () => {
    const files = Array.from({ length: 100 }, (_, index) => ({
      path: `notes/${index}.md`,
      objectId: `object-${index}`,
      contentKind: "text" as const,
      sha256: "a".repeat(64),
      byteLength: index,
      binarySha256: null,
      updatedAtMs: index,
      latestMomentId: `moment-${index}`,
      metadataOrigin: "api",
      hasYdocMarker: false,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const client: MinimalDaemonClient = {
      close: () => undefined,
      async sendRequest(request): Promise<Response> {
        if (request.method === VERSIONED_METHOD.textList) {
          return {
            id: request.id,
            result: { files, nextAfterPath: null },
          };
        }
        const path = (request.params as { path: string }).path;
        const row = files.find((candidate) => candidate.path === path)!;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return {
          id: request.id,
          result: {
            workspaceId: WORKSPACE,
            versionId: "main",
            objectId: row.objectId,
            path,
            contentKind: "text",
            text: path,
            sha256: "a".repeat(64),
            blobSha256: "a".repeat(64),
            byteLength: Buffer.byteLength(path),
            updatedAtMs: row.updatedAtMs,
            latestMomentId: row.latestMomentId,
            metadataOrigin: "api",
          },
        };
      },
    };
    const adapter = new VersionedLiveAdapter(client, WORKSPACE, {
      workspaceId: WORKSPACE,
    });

    await expect(
      adapter.listTextFiles({ workspaceId: WORKSPACE, versionId: "main" }),
    ).resolves.toHaveLength(files.length);
    expect(maxInFlight).toBe(8);
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
