import { describe, expect, it } from "vitest";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import {
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
} as const;
const conflictState = {
  path: "a.md",
  contentKind: "text",
  snapshot,
  binarySha256: null,
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
  { method: WORKSPACE_METHOD.conflictsList, valid: [conflict] },
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

  it("encodes every one of the 31 versioned methods with exact params", async () => {
    expect(VERSIONED_REQUEST_CASES).toHaveLength(31);
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

  it("encodes workspace.open and all seven bound workspace-family methods", async () => {
    const openRequests: Request[] = [];
    await expect(
      VersionedLiveAdapter.openWorkspace(captureClient(openRequests), {
        rootDir: "C:/shadow",
        workspaceId: WORKSPACE,
      }),
    ).rejects.toBe(SENTINEL);
    expect(openRequests[0]).toMatchObject({
      method: WORKSPACE_METHOD.open,
      params: { rootDir: "C:/shadow", workspaceId: WORKSPACE },
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

    expect(write.snapshot.text).toBe("hello");
    expect(read?.text).toBe("hello");
  });
});
