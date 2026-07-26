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
  { method: WORKSPACE_METHOD.conflictsResolve, valid: { conflict } },
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
  it("consumes the matching out-of-band blob for an over-cap binary read", async () => {
    const bytes = new Uint8Array([0, 255, 17, 42, 99]);
    const sha256 = "a".repeat(64);
    const requests: Request[] = [];
    const blobHandlers = new Set<
      Parameters<NonNullable<MinimalDaemonClient["onBlob"]>>[0]
    >();
    const client: MinimalDaemonClient = {
      close: () => undefined,
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

  it("fails with a typed capability error when blob egress is unavailable", async () => {
    const client: MinimalDaemonClient = {
      close: () => undefined,
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

  it("never silently drops unsupported text and binary mutation metadata", async () => {
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
      WORKSPACE,
      { workspaceId: "workspace" },
    );

    const mutations = [
      () =>
        adapter.writeTextFile({
          workspaceId: "workspace",
          versionId: "main",
          path: "notes/write.md",
          text: "text",
          metadata: { origin: "api", summary: "Write note" },
        }),
      () =>
        adapter.writeBinaryFile({
          workspaceId: "workspace",
          versionId: "main",
          path: "asset.bin",
          bytes: new Uint8Array([1]),
          metadata: { origin: "api", correlationId: "binary-write" },
        }),
      () =>
        adapter.mergeTextFileFromVersion({
          workspaceId: "workspace",
          targetVersionId: "main",
          sourceVersionId: "feature",
          path: "notes/merge.md",
          metadata: { origin: "api", summary: "Merge note" },
        }),
      () =>
        adapter.renameTextFile({
          workspaceId: "workspace",
          versionId: "main",
          fromPath: "notes/old.md",
          toPath: "notes/new.md",
          metadata: { origin: "api", correlationId: "rename-note" },
        }),
      () =>
        adapter.deleteTextFile({
          workspaceId: "workspace",
          versionId: "main",
          path: "notes/delete.md",
          metadata: { origin: "api", summary: "Delete note" },
        }),
    ];

    for (const mutate of mutations) {
      await expect(mutate()).rejects.toBeInstanceOf(
        VersionedAdapterCapabilityError,
      );
    }
    expect(requests).toEqual([]);
  });

  it("never silently drops secret mutation metadata rejected by the daemon", async () => {
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(
      captureClient(requests),
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
    ).rejects.toBeInstanceOf(VersionedAdapterCapabilityError);
    await expect(
      adapter.deleteSecretFile({
        workspaceId: "workspace",
        versionId: "main",
        path: ".env",
        metadata: { origin: "api", correlationId: "operation-1" },
      }),
    ).rejects.toBeInstanceOf(VersionedAdapterCapabilityError);
    await expect(
      adapter.restoreSecretFileToBeforeMoment({
        workspaceId: "workspace",
        momentId: "secret-moment",
        metadata: { origin: "restore", summary: "Undo secret change" },
      }),
    ).rejects.toBeInstanceOf(VersionedAdapterCapabilityError);
    await expect(
      adapter.restoreSecretFileToBeforeMoment({
        workspaceId: "workspace",
        momentId: "secret-moment",
        metadata: { origin: "api" },
      }),
    ).rejects.toBeInstanceOf(VersionedAdapterCapabilityError);
    expect(requests).toEqual([]);

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
    expect(requests[0]).toMatchObject({
      method: VERSIONED_METHOD.secretsApply,
      params: {
        origin: "sync",
        summary: "Apply source secret",
        correlationId: "operation-2",
      },
    });
  });

  it("encodes every one of the 30 versioned methods with exact params", async () => {
    expect(VERSIONED_REQUEST_CASES).toHaveLength(30);
    const requests: Request[] = [];
    const adapter = new VersionedLiveAdapter(captureClient(requests), WORKSPACE);

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
    const adapter = new VersionedLiveAdapter(captureClient(requests), WORKSPACE);
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
        status: "merged",
      }),
    ).toEqual({ status: "merged" });
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
      new VersionedLiveAdapter(client, WORKSPACE).request(
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
