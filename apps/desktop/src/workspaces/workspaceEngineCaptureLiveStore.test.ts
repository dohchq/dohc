import type {
  EngineDaemonClient,
} from "./engineDaemonLifecycle";
import type {
  EngineWorkspaceBinding,
  EngineWorkspaceRunOptions,
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "./engineWorkspaceSessions";
import {
  VERSIONED_METHOD,
  WORKSPACE_METHOD,
  type ConflictRecord,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { describe, expect, it } from "vitest";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";

const WORKSPACE_ID = "workspace";
const WORKSPACE_HANDLE = "workspace-handle";
const SENTINEL = new Error("sentinel");

function sessionsFor(
  client: EngineDaemonClient,
  optionsSeen: Array<EngineWorkspaceRunOptions | undefined> = [],
): EngineWorkspaceSessions {
  const binding: EngineWorkspaceBinding = {
    client,
    workspace: WORKSPACE_HANDLE,
  };
  return {
    async run<T>(
      _workspace: EngineWorkspace,
      operation: (binding: EngineWorkspaceBinding) => Promise<T>,
      options?: EngineWorkspaceRunOptions,
    ): Promise<T> {
      optionsSeen.push(options);
      return await operation(binding);
    },
    async closeWorkspace() {},
  } as unknown as EngineWorkspaceSessions;
}

function clientFor(
  sendRequest: (request: Request) => Promise<Response>,
): EngineDaemonClient {
  return { close: () => undefined, sendRequest };
}

const snapshot = {
  workspaceId: WORKSPACE_ID,
  versionId: "main",
  objectId: "object",
  path: "note.md",
  text: "hello",
  contentKind: "text",
  sha256: "a".repeat(64),
  byteLength: 5,
  blobSha256: "a".repeat(64),
  updatedAtMs: 2,
  latestMomentId: "moment",
  metadataOrigin: "capture",
} as const;

const moment = {
  momentOrder: 1,
  momentId: "resolved-moment",
  versionId: "main",
  objectId: "object",
  path: "note.md",
  recordedAtMs: 3,
  operation: "write",
  afterContentKind: "text",
  afterBlobSha256: "a".repeat(64),
  afterBinarySha256: null,
  beforePresent: true,
  beforeContentKind: "text",
  beforeBlobSha256: "a".repeat(64),
  beforeBinarySha256: null,
  beforeLatestMomentId: "moment",
  metadataOrigin: "api",
  metadataSummary: "Resolved note.md",
  metadataCorrelationId: "conflict-1",
  author: null,
  syncRecordOnly: false,
  afterText: "hello",
  afterByteLength: 5,
  afterInbandLimitBytes: null,
  beforeText: "hello",
  beforeByteLength: 5,
  beforeInbandLimitBytes: null,
} as const;

function conflict(status: "open" | "resolved" = "open"): ConflictRecord {
  const state = {
    path: snapshot.path,
    contentKind: "text" as const,
    snapshot,
    binarySha256: null,
    binaryObjectId: null,
    binaryLatestMomentId: null,
    metadataSummary: "side summary",
    metadataCorrelationId: null,
  };
  return {
    id: "conflict",
    workspaceId: WORKSPACE_ID,
    path: snapshot.path,
    targetVersionId: "main",
    sourceVersionId: "draft",
    createdAtMs: 1,
    updatedAtMs: 2,
    status,
    chosenFrom: status === "open" ? "current" : "incoming",
    resolution: status === "open" ? null : "applied-incoming",
    metadata: {
      origin: "capture",
      summary: null,
      correlationId: null,
    },
    base: state,
    current: state,
    incoming: state,
  };
}

describe("createCaptureLiveStores", () => {
  it("retries transport failures for reads but not mutations", async () => {
    const optionsSeen: Array<EngineWorkspaceRunOptions | undefined> = [];
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      throw SENTINEL;
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client, optionsSeen),
    );

    await expect(
      store.readTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "note.md",
      }),
    ).rejects.toBe(SENTINEL);
    await expect(
      store.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "note.md",
        text: "hello",
        metadata: {
          origin: "api",
          summary: "Updated note.md",
          correlationId: "capture-1",
        },
      }),
    ).rejects.toBe(SENTINEL);

    expect(optionsSeen).toEqual([
      { retryTransportErrors: true },
      undefined,
    ]);
    expect(requests.at(-1)?.params).toMatchObject({
      origin: "api",
      summary: "Updated note.md",
      correlationId: "capture-1",
    });
  });

  it("translates capture origins and flattens daemon conflict side states", async () => {
    const client = clientFor(async (request) => {
      expect(request.method).toBe(WORKSPACE_METHOD.conflictsList);
      return { id: request.id, result: [conflict()] };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" }),
    ).resolves.toMatchObject([
      {
        metadata: { origin: "local-file" },
        base: {
          exists: true,
          path: "note.md",
          text: "hello",
          sha256: "a".repeat(64),
          metadata: {
            origin: "local-file",
            summary: "side summary",
          },
        },
      },
    ]);
  });

  it("builds the daemon local conflict-resolution envelope", async () => {
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      if (request.method === WORKSPACE_METHOD.conflictsList) {
        return { id: request.id, result: [conflict()] };
      }
      if (request.method === WORKSPACE_METHOD.conflictsResolve) {
        return {
          id: request.id,
          result: {
            conflict: conflict("resolved"),
            write: {
              object: {
                id: "object",
                workspaceId: WORKSPACE_ID,
                createdAtMs: 1,
              },
              snapshot,
              moment,
            },
            delete: null,
          },
        };
      }
      throw new Error(`Unexpected method ${request.method}`);
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: "conflict",
        resolution: { kind: "apply-merged", text: "merged" },
        metadata: {
          origin: "api",
          summary: "Resolved note.md",
          correlationId: "conflict-1",
        },
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      write: {
        object: { id: "object" },
        snapshot: { text: "hello" },
        moment: { id: "resolved-moment" },
      },
    });
    expect(
      requests.some((request) => request.method === VERSIONED_METHOD.textRead),
    ).toBe(false);
    expect(
      requests.find(
        (request) => request.method === WORKSPACE_METHOD.conflictsResolve,
      )?.params,
    ).toMatchObject({
      local: {
        conflictId: "conflict",
        resolution: "apply-merged",
        mergedText: "merged",
        objectId: expect.stringMatching(/^object-/),
        writeMomentId: expect.stringMatching(/^moment-/),
        deleteMomentId: expect.stringMatching(/^moment-/),
        metadataOrigin: "api",
        metadataSummary: "Resolved note.md",
        metadataCorrelationId: "conflict-1",
      },
    });
  });

  it("preserves keep-current as a conflict-only no-op", async () => {
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      if (request.method === WORKSPACE_METHOD.conflictsList) {
        return { id: request.id, result: [conflict()] };
      }
      if (request.method === WORKSPACE_METHOD.conflictsResolve) {
        return {
          id: request.id,
          result: {
            conflict: {
              ...conflict("resolved"),
              chosenFrom: "current",
              resolution: "kept-current",
            },
            write: null,
            delete: null,
          },
        };
      }
      throw new Error(`Unexpected method ${request.method}`);
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.resolveTextConflict({
        workspaceId: WORKSPACE_ID,
        conflictId: "conflict",
        resolution: { kind: "keep-current" },
        metadata: { origin: "api" },
      }),
    ).resolves.toEqual({
      kind: "resolved",
      conflict: expect.objectContaining({
        id: "conflict",
        resolution: "kept-current",
      }),
    });
    expect(
      requests.some((request) => request.method === VERSIONED_METHOD.textRead),
    ).toBe(false);
  });

  it("returns the oracle comparison states instead of mergeability shorthand", async () => {
    const client = clientFor(async (request) => {
      expect(request.method).toBe(VERSIONED_METHOD.versionsCompare);
      return {
        id: request.id,
        result: {
          workspaceId: WORKSPACE_ID,
          path: "note.md",
          targetVersionId: "main",
          sourceVersionId: "draft",
          base: snapshot,
          current: null,
          incoming: { ...snapshot, versionId: "draft", text: "incoming" },
          status: "incoming-changed",
        },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.compareTextFileVersions({
        workspaceId: WORKSPACE_ID,
        targetVersionId: "main",
        sourceVersionId: "draft",
        path: "note.md",
      }),
    ).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      path: "note.md",
      targetVersionId: "main",
      sourceVersionId: "draft",
      base: expect.objectContaining({
        exists: true,
        path: "note.md",
        text: "hello",
        metadata: { origin: "local-file" },
      }),
      current: { exists: false, path: "note.md" },
      incoming: expect.objectContaining({
        exists: true,
        path: "note.md",
        text: "incoming",
      }),
      status: "incoming-changed",
    });
  });

  it("rejects a truncated text moment instead of fabricating empty content", async () => {
    const client = clientFor(async (request) => {
      expect(request.method).toBe(VERSIONED_METHOD.momentsGet);
      return {
        id: request.id,
        result: {
          ...moment,
          afterText: null,
          afterByteLength: 60 * 1024,
          afterInbandLimitBytes: 48 * 1024,
        },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.getMoment({
        workspaceId: WORKSPACE_ID,
        momentId: "resolved-moment",
      }),
    ).rejects.toThrow("exceeds the RPC in-band limit");
  });

  it("keeps digest and byte length on metadata-only listings", async () => {
    const client = clientFor(async (request) => {
      expect(request.method).toBe(VERSIONED_METHOD.textList);
      return {
        id: request.id,
        result: {
          files: [
            {
              path: "note.md",
              objectId: "object",
              contentKind: "text",
              sha256: "a".repeat(64),
              byteLength: 5,
              binarySha256: null,
              updatedAtMs: 2,
              latestMomentId: "moment",
              metadataOrigin: "capture",
              metadataSummary: null,
              metadataCorrelationId: null,
            },
          ],
          nextAfterPath: null,
        },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.listTextFileMetadata?.({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        path: "note.md",
        sha256: "a".repeat(64),
        byteLength: 5,
      }),
    ]);
  });

  it("omits nullable protected-moment metadata fields", async () => {
    const client = clientFor(async (request) => {
      expect(request.method).toBe(VERSIONED_METHOD.secretsMomentsList);
      return {
        id: request.id,
        result: {
          moments: [
            {
              id: "secret-moment",
              workspaceId: WORKSPACE_ID,
              versionId: "main",
              path: ".env",
              recordedAtMs: 1,
              operation: "write",
              metadata: {
                origin: "capture",
                summary: null,
                correlationId: null,
              },
              momentOrder: 1,
              protected: true,
            },
          ],
          nextBeforeMomentOrder: null,
        },
      };
    });
    const { secretStore } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      secretStore.listSecretMoments({ workspaceId: WORKSPACE_ID }),
    ).resolves.toEqual([
      {
        id: "secret-moment",
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        recordedAtMs: 1,
        operation: "write",
        metadata: { origin: "local-file" },
        momentOrder: 1,
        protected: true,
      },
    ]);
  });
});
