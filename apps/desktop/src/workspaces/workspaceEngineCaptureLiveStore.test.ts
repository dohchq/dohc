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
  type AgentAuthor,
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
  captureAuthorsSeen: Array<AgentAuthor | null> = [],
): EngineWorkspaceSessions {
  const binding: EngineWorkspaceBinding = {
    client,
    workspace: WORKSPACE_HANDLE,
  };
  let captureAuthor: AgentAuthor | null = null;
  return {
    async run<T>(
      _workspace: EngineWorkspace,
      operation: (binding: EngineWorkspaceBinding) => Promise<T>,
      options?: EngineWorkspaceRunOptions,
    ): Promise<T> {
      optionsSeen.push(options);
      captureAuthorsSeen.push(captureAuthor);
      return await operation(binding);
    },
    rememberCaptureAuthor(_workspaceId: string, author: AgentAuthor | null) {
      captureAuthor = author;
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
  metadataSummary: null,
  metadataCorrelationId: null,
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
    binaryByteLength: null,
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
  it("mutation proof: remembers capture authorship across later session generations", async () => {
    const captureAuthorsSeen: Array<AgentAuthor | null> = [];
    const client = clientFor(async (request) => ({
      id: request.id,
      result:
        request.method === WORKSPACE_METHOD.captureFlush
          ? { settled: true, running: true, degraded: false }
          : { updated: true },
    }));
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client, [], captureAuthorsSeen),
    );
    const author = {
      kind: "agent" as const,
      agentId: "agent",
      onBehalfOf: "local",
      agentRunId: "run",
    };

    await store.setCaptureAuthor?.(author);
    await store.flushCapture?.();

    expect(captureAuthorsSeen).toEqual([null, author]);
  });

  it("mutation proof: does not remember capture authorship rejected by the daemon", async () => {
    const captureAuthorsSeen: Array<AgentAuthor | null> = [];
    const author = {
      kind: "agent" as const,
      agentId: "agent",
      onBehalfOf: "local",
      agentRunId: "rejected-run",
    };
    const client = clientFor(async (request) => {
      if (request.method === WORKSPACE_METHOD.captureSetAuthor) throw SENTINEL;
      return {
        id: request.id,
        result: { settled: true, running: true, degraded: false },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client, [], captureAuthorsSeen),
    );

    await expect(store.setCaptureAuthor?.(author)).rejects.toBe(SENTINEL);
    await store.flushCapture?.();

    expect(captureAuthorsSeen).toEqual([null, null]);
  });

  it("mutation proof: rejects an unsettled daemon capture flush", async () => {
    const client = clientFor(async (request) => ({
      id: request.id,
      result: { settled: false, running: true, degraded: true },
    }));
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(store.flushCapture?.()).rejects.toThrow("did not settle");
  });

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
      return {
        id: request.id,
        result: { conflicts: [conflict()], nextAfterConflictId: null },
      };
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

  it("preserves nonempty binary conflict-side byte lengths", async () => {
    const binaryState = {
      path: "asset.bin",
      contentKind: "binary" as const,
      snapshot: null,
      binarySha256: "b".repeat(64),
      binaryByteLength: 17,
      binaryObjectId: "binary-object",
      binaryLatestMomentId: "binary-moment",
      metadataSummary: null,
      metadataCorrelationId: null,
    };
    const client = clientFor(async (request) => ({
      id: request.id,
      result: {
        conflicts: [
          {
            ...conflict(),
            path: "asset.bin",
            base: binaryState,
            current: binaryState,
            incoming: binaryState,
          },
        ],
        nextAfterConflictId: null,
      },
    }));
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.listTextConflicts({ workspaceId: WORKSPACE_ID, status: "open" }),
    ).resolves.toMatchObject([
      {
        current: {
          exists: true,
          contentKind: "binary",
          sha256: "b".repeat(64),
          byteLength: 17,
        },
      },
    ]);
  });

  it("builds the daemon local conflict-resolution envelope", async () => {
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      if (request.method === WORKSPACE_METHOD.conflictsList) {
        return {
          id: request.id,
          result: { conflicts: [conflict()], nextAfterConflictId: null },
        };
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
        return {
          id: request.id,
          result: { conflicts: [conflict()], nextAfterConflictId: null },
        };
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

  it("mutation proof: returns the conflict id created by this merge", async () => {
    const older = conflict();
    const created = { ...conflict(), id: "created-conflict", createdAtMs: 9 };
    const client = clientFor(async (request) => {
      if (request.method === VERSIONED_METHOD.textRead) {
        return { id: request.id, result: snapshot };
      }
      if (request.method === VERSIONED_METHOD.versionsMerge) {
        return {
          id: request.id,
          result: {
            status: "conflict",
            conflictId: created.id,
            deduped: false,
            comparison: {
              workspaceId: WORKSPACE_ID,
              path: "note.md",
              targetVersionId: "main",
              sourceVersionId: "draft",
              base: snapshot,
              current: snapshot,
              incoming: { ...snapshot, versionId: "draft", text: "incoming" },
              status: "diverged",
            },
            materializeEnqueued: false,
            materialized: false,
            materializeOutcome: "skipped",
          },
        };
      }
      expect(request.method).toBe(WORKSPACE_METHOD.conflictsList);
      return {
        id: request.id,
        result: { conflicts: [older, created], nextAfterConflictId: null },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    const result = await store.mergeTextFileFromVersion({
      workspaceId: WORKSPACE_ID,
      targetVersionId: "main",
      sourceVersionId: "draft",
      path: "note.md",
      metadata: { origin: "api" },
    });

    expect(result).toMatchObject({
      kind: "conflict",
      conflict: { id: "created-conflict" },
    });
  });

  it("mutation proof: preserves a rename moment's source path", async () => {
    const client = clientFor(async (request) => ({
      id: request.id,
      result: {
        ...moment,
        operation: "rename",
        path: "renamed.md",
        beforePath: "note.md",
      },
    }));
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    const detail = await store.getMoment({
      workspaceId: WORKSPACE_ID,
      momentId: moment.momentId,
    });

    expect(detail?.payload.before?.path).toBe("note.md");
    expect(detail?.payload.after.path).toBe("renamed.md");
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

  it.each([VERSIONED_METHOD.momentsGet, VERSIONED_METHOD.momentsList] as const)(
    "rejects corrupt author provenance returned by %s",
    async (method) => {
      const corruptMoment = { ...moment, author: { corrupt: true } as const };
      const client = clientFor(async (request) => ({
        id: request.id,
        result:
          method === VERSIONED_METHOD.momentsGet
            ? corruptMoment
            : {
                moments: [corruptMoment],
                nextBeforeMomentOrder: null,
                latestMomentOrder: 1,
              },
      }));
      const { store } = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
        sessionsFor(client),
      );

      const read =
        method === VERSIONED_METHOD.momentsGet
          ? store.getMoment({
              workspaceId: WORKSPACE_ID,
              momentId: "resolved-moment",
            })
          : store.listMoments({ workspaceId: WORKSPACE_ID });
      await expect(read).rejects.toMatchObject({ code: "state-corrupt" });
    },
  );

  it("hydrates a delete preimage from the atomic mutation result", async () => {
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      expect(request.method).toBe(VERSIONED_METHOD.textDelete);
      return {
        id: request.id,
        result: {
          object: {
            id: "object",
            workspaceId: WORKSPACE_ID,
            createdAtMs: 1,
          },
          before: {
            workspaceId: WORKSPACE_ID,
            versionId: "main",
            objectId: "object",
            path: "note.md",
            contentKind: "text",
            sha256: "c".repeat(64),
            byteLength: 13,
            updatedAtMs: 3,
            latestMomentId: "concurrent-moment",
            metadataOrigin: "api",
          },
          moment: {
            ...moment,
            operation: "delete",
            beforeBlobSha256: "c".repeat(64),
            beforeLatestMomentId: "concurrent-moment",
            beforeText: "newer content",
            beforeByteLength: 13,
            afterBlobSha256: null,
            afterText: "",
            afterByteLength: 0,
          },
          deduped: false,
        },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.deleteTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "note.md",
        metadata: { origin: "api" },
      }),
    ).resolves.toMatchObject({
      before: {
        text: "newer content",
        sha256: "c".repeat(64),
        latestMomentId: "concurrent-moment",
      },
      moment: {
        payload: { before: { text: "newer content", sha256: "c".repeat(64) } },
      },
    });
    expect(requests).toHaveLength(1);
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
