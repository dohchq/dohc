import type {
  EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import type {
  EngineWorkspaceBinding,
  EngineWorkspaceRunOptions,
  EngineWorkspace,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import {
  VERSIONED_METHOD,
  WORKSPACE_METHOD,
  type AgentAuthor,
  type ConflictRecord,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";

const WORKSPACE_ID = "workspace";
const WORKSPACE_HANDLE = "workspace-handle";
const SENTINEL = new Error("sentinel");

// Past `MAX_DESKTOP_CAPTURE_TEXT_BYTES` (128 KiB), so the daemon withholds this
// body from a moment payload and reports its digest instead. The leading BOM
// and the two-byte characters make the readback a real UTF-8 check rather than
// an ASCII one.
const OVER_CAP_TEXT = `\uFEFF# héllo\n${"é".repeat(70 * 1024)}\n`;
const OVER_CAP_BYTES = new Uint8Array(Buffer.from(OVER_CAP_TEXT, "utf8"));
const OVER_CAP_SHA256 = createHash("sha256")
  .update(OVER_CAP_BYTES)
  .digest("hex");

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

type CompletedBlob = Parameters<
  Parameters<NonNullable<EngineDaemonClient["onBlob"]>>[0]
>[0];

/**
 * The daemon's answer to `versionedText.readBlob` for the one digest this
 * workspace references, and a refusal for every other one:
 * `read_text_blob_with_hydration` (store.rs) authorizes a digest against the
 * workspace's text references before it reads a byte. A fake that answered any
 * digest could not fail, and would pin nothing about the request sent.
 *
 * Delivery is out of band because the body is past the 48 KiB egress cap.
 */
function overCapBlobResult(
  request: Request,
  deliver: (blob: CompletedBlob) => void,
): Response["result"] {
  const params = request.params as { sha256?: unknown };
  if (params.sha256 !== OVER_CAP_SHA256) {
    throw {
      wireError: {
        code: "INVALID_PARAMS",
        message: "file-not-found",
        retry: "no",
      },
    };
  }
  deliver({
    requestId: request.id,
    streamId: request.id,
    totalBytes: OVER_CAP_BYTES.byteLength,
    sha256: OVER_CAP_SHA256,
    bytes: OVER_CAP_BYTES,
  });
  return {
    bytesBase64: null,
    byteLength: OVER_CAP_BYTES.byteLength,
    inbandLimitBytes: 48 * 1024,
  };
}

/**
 * A client that can deliver a completed blob out of band, which is the only
 * way a body past the 48 KiB egress cap reaches the adapter. `clientFor` has
 * no `helloAck` and no `onBlob`, so a suite built on it cannot observe blob
 * hydration at all — it refuses first, on the missing capability.
 */
function blobClientFor(
  sendRequest: (
    request: Request,
    deliver: (blob: CompletedBlob) => void,
  ) => Promise<Response>,
): EngineDaemonClient {
  const handlers = new Set<(blob: CompletedBlob) => void>();
  return {
    close: () => undefined,
    helloAck: { capabilities: ["blobs"] },
    onBlob(handler: (blob: CompletedBlob) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async sendRequest(request: Request): Promise<Response> {
      return await sendRequest(request, (blob) => {
        for (const handler of handlers) handler(blob);
      });
    },
  } as unknown as EngineDaemonClient;
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

  it.each(["after", "before"] as const)(
    "hydrates an over-cap %s moment body out of band (#359)",
    async (side) => {
      const requests: Request[] = [];
      const client = blobClientFor(async (request, deliver) => {
        requests.push(request);
        if (request.method === VERSIONED_METHOD.momentsGet) {
          return {
            id: request.id,
            result:
              side === "after"
                ? {
                    ...moment,
                    afterText: null,
                    afterBlobSha256: OVER_CAP_SHA256,
                    afterByteLength: OVER_CAP_BYTES.byteLength,
                    afterInbandLimitBytes: 128 * 1024,
                  }
                : {
                    ...moment,
                    beforeText: null,
                    beforeBlobSha256: OVER_CAP_SHA256,
                    beforeByteLength: OVER_CAP_BYTES.byteLength,
                    beforeInbandLimitBytes: 128 * 1024,
                  },
          };
        }
        expect(request.method).toBe(VERSIONED_METHOD.textReadBlob);
        return { id: request.id, result: overCapBlobResult(request, deliver) };
      });
      const { store } = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
        sessionsFor(client),
      );

      const detail = await store.getMoment({
        workspaceId: WORKSPACE_ID,
        momentId: "resolved-moment",
      });

      const hydrated =
        side === "after" ? detail?.payload.after : detail?.payload.before;
      expect(hydrated?.text).toBe(OVER_CAP_TEXT);
      // Byte-identical, not merely equal-looking: a decoder that strips the
      // leading BOM returns a body whose digest no longer matches the one the
      // moment recorded.
      expect(Buffer.from(hydrated?.text ?? "", "utf8")).toEqual(
        Buffer.from(OVER_CAP_BYTES),
      );
      expect(
        createHash("sha256").update(hydrated?.text ?? "", "utf8").digest("hex"),
      ).toBe(OVER_CAP_SHA256);
      expect(requests.map((request) => request.method)).toEqual([
        VERSIONED_METHOD.momentsGet,
        VERSIONED_METHOD.textReadBlob,
      ]);
    },
  );

  it("hydrates an over-cap moment returned by a write, not just by a read", async () => {
    const requests: Request[] = [];
    const client = blobClientFor(async (request, deliver) => {
      requests.push(request);
      if (request.method === VERSIONED_METHOD.textWrite) {
        return {
          id: request.id,
          result: {
            object: { id: "object", workspaceId: WORKSPACE_ID, createdAtMs: 1 },
            snapshot: { ...snapshot, text: OVER_CAP_TEXT },
            moment: {
              ...moment,
              afterText: null,
              afterBlobSha256: OVER_CAP_SHA256,
              afterByteLength: OVER_CAP_BYTES.byteLength,
              afterInbandLimitBytes: 128 * 1024,
            },
            deduped: false,
          },
        };
      }
      return { id: request.id, result: overCapBlobResult(request, deliver) };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    const written = await store.writeTextFile({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      path: "note.md",
      text: OVER_CAP_TEXT,
      metadata: { origin: "api" },
    });

    expect(written.moment.payload.after.text).toBe(OVER_CAP_TEXT);
    expect(requests.map((request) => request.method)).toEqual([
      VERSIONED_METHOD.textWrite,
      VERSIONED_METHOD.textReadBlob,
    ]);
  });

  it("spends no blob request on a moment whose body already fits", async () => {
    const requests: Request[] = [];
    const client = blobClientFor(async (request) => {
      requests.push(request);
      return { id: request.id, result: moment };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    const detail = await store.getMoment({
      workspaceId: WORKSPACE_ID,
      momentId: "resolved-moment",
    });

    expect(detail?.payload.after.text).toBe("hello");
    expect(requests.map((request) => request.method)).toEqual([
      VERSIONED_METHOD.momentsGet,
    ]);
  });

  // Every OTHER surface that returns a moment payload. `getMoment` and
  // `writeTextFile` are pinned above; without these rows the hydration call at
  // each site below could be deleted and the suite would stay green.
  //
  // `sides` is not cosmetic: a delete or rename records ONE digest on BOTH
  // sides (store.rs binds the same `before.blob_sha256` to `after_blob_sha256`
  // and `before_blob_sha256`), so those rows also pin that the body is fetched
  // once rather than streamed twice.
  const overCapAfter = {
    ...moment,
    afterText: null,
    afterBlobSha256: OVER_CAP_SHA256,
    afterByteLength: OVER_CAP_BYTES.byteLength,
    afterInbandLimitBytes: 128 * 1024,
  };
  const overCapBothSides = {
    ...overCapAfter,
    beforeText: null,
    beforeBlobSha256: OVER_CAP_SHA256,
    beforeByteLength: OVER_CAP_BYTES.byteLength,
    beforeInbandLimitBytes: 128 * 1024,
  };
  const overCapMetadata = {
    workspaceId: WORKSPACE_ID,
    versionId: "main",
    objectId: "object",
    path: "note.md",
    contentKind: "text",
    sha256: OVER_CAP_SHA256,
    byteLength: OVER_CAP_BYTES.byteLength,
    updatedAtMs: 3,
    latestMomentId: "resolved-moment",
    metadataOrigin: "api",
    metadataSummary: null,
    metadataCorrelationId: null,
  };
  const mergeComparison = {
    workspaceId: WORKSPACE_ID,
    path: "note.md",
    targetVersionId: "main",
    sourceVersionId: "draft",
    base: snapshot,
    current: snapshot,
    incoming: { ...snapshot, versionId: "draft", text: "incoming" },
    status: "diverged",
  };
  const materialization = {
    materializeEnqueued: false,
    materialized: false,
    materializeOutcome: "skipped",
  };
  const fileObject = {
    id: "object",
    workspaceId: WORKSPACE_ID,
    createdAtMs: 1,
  };

  interface MomentSurface {
    name: string;
    sides: readonly ("before" | "after")[];
    blobReads: number;
    respond: (request: Request) => Response["result"] | undefined;
    run: (
      store: ReturnType<typeof createCaptureLiveStores>["store"],
    ) => Promise<VersionedTextMoment>;
  }

  const MOMENT_SURFACES: MomentSurface[] = [
    {
      name: "writeBinaryFile",
      // Binary written over a text head: the preimage is the over-cap body.
      sides: ["before"],
      blobReads: 1,
      respond: (request) =>
        request.method === VERSIONED_METHOD.binaryWrite
          ? {
              object: fileObject,
              snapshot: {
                workspaceId: WORKSPACE_ID,
                versionId: "main",
                objectId: "object",
                path: "note.md",
                contentKind: "binary",
                text: "",
                sha256: "b".repeat(64),
                byteLength: 3,
                updatedAtMs: 3,
                latestMomentId: "resolved-moment",
                metadataOrigin: "api",
              },
              moment: {
                ...overCapBothSides,
                afterContentKind: "binary",
                afterBinarySha256: "b".repeat(64),
                afterBlobSha256: null,
                afterText: "",
                afterByteLength: 3,
                afterInbandLimitBytes: null,
              },
              deduped: false,
              ...materialization,
            }
          : undefined,
      run: async (store) =>
        (
          await store.writeBinaryFile({
            workspaceId: WORKSPACE_ID,
            versionId: "main",
            path: "note.md",
            bytes: new Uint8Array([1, 2, 3]),
            metadata: { origin: "api" },
          })
        ).moment,
    },
    {
      name: "deleteTextFile",
      sides: ["before", "after"],
      blobReads: 1,
      respond: (request) =>
        request.method === VERSIONED_METHOD.textDelete
          ? {
              object: fileObject,
              before: overCapMetadata,
              moment: { ...overCapBothSides, operation: "delete" },
              deduped: false,
            }
          : undefined,
      run: async (store) =>
        (
          await store.deleteTextFile({
            workspaceId: WORKSPACE_ID,
            versionId: "main",
            path: "note.md",
            metadata: { origin: "api" },
          })
        ).moment,
    },
    {
      name: "renameTextFile",
      sides: ["before", "after"],
      blobReads: 1,
      respond: (request) => {
        if (request.method === VERSIONED_METHOD.textRead) return snapshot;
        return request.method === VERSIONED_METHOD.textRename
          ? {
              object: fileObject,
              before: overCapMetadata,
              after: { ...overCapMetadata, path: "renamed.md" },
              moment: {
                ...overCapBothSides,
                operation: "rename",
                path: "renamed.md",
                beforePath: "note.md",
              },
              deduped: false,
            }
          : undefined;
      },
      run: async (store) =>
        (
          await store.renameTextFile({
            workspaceId: WORKSPACE_ID,
            versionId: "main",
            fromPath: "note.md",
            toPath: "renamed.md",
            metadata: { origin: "api" },
          })
        ).moment,
    },
    {
      name: "mergeTextFileFromVersion (write)",
      sides: ["after"],
      blobReads: 1,
      respond: (request) => {
        if (request.method === VERSIONED_METHOD.textRead) return snapshot;
        return request.method === VERSIONED_METHOD.versionsMerge
          ? {
              status: "merged",
              writeKind: "write",
              object: fileObject,
              snapshot: overCapMetadata,
              moment: overCapAfter,
              deduped: false,
              comparison: mergeComparison,
              ...materialization,
            }
          : undefined;
      },
      run: async (store) => {
        const merged = await store.mergeTextFileFromVersion({
          workspaceId: WORKSPACE_ID,
          targetVersionId: "main",
          sourceVersionId: "draft",
          path: "note.md",
          metadata: { origin: "api" },
        });
        if (merged.kind !== "merged" || merged.operation !== "write") {
          throw new Error("expected a merged write");
        }
        return merged.write.moment;
      },
    },
    {
      name: "mergeTextFileFromVersion (delete)",
      sides: ["before", "after"],
      blobReads: 1,
      respond: (request) => {
        if (request.method === VERSIONED_METHOD.textRead) return snapshot;
        return request.method === VERSIONED_METHOD.versionsMerge
          ? {
              status: "merged",
              writeKind: "delete",
              object: fileObject,
              before: overCapMetadata,
              moment: { ...overCapBothSides, operation: "delete" },
              deduped: false,
              comparison: mergeComparison,
              ...materialization,
            }
          : undefined;
      },
      run: async (store) => {
        const merged = await store.mergeTextFileFromVersion({
          workspaceId: WORKSPACE_ID,
          targetVersionId: "main",
          sourceVersionId: "draft",
          path: "note.md",
          metadata: { origin: "api" },
        });
        if (merged.kind !== "merged" || merged.operation !== "delete") {
          throw new Error("expected a merged delete");
        }
        return merged.delete.moment;
      },
    },
    {
      name: "resolveTextConflict (write)",
      sides: ["after"],
      blobReads: 1,
      respond: (request) => {
        if (request.method === WORKSPACE_METHOD.conflictsList) {
          return { conflicts: [conflict()], nextAfterConflictId: null };
        }
        return request.method === WORKSPACE_METHOD.conflictsResolve
          ? {
              conflict: conflict("resolved"),
              write: { object: fileObject, snapshot, moment: overCapAfter },
              delete: null,
            }
          : undefined;
      },
      run: async (store) => {
        const resolved = await store.resolveTextConflict({
          workspaceId: WORKSPACE_ID,
          conflictId: "conflict",
          resolution: { kind: "apply-incoming" },
          metadata: { origin: "api" },
        });
        if (resolved.write === undefined) throw new Error("expected a write");
        return resolved.write.moment;
      },
    },
    {
      name: "resolveTextConflict (delete)",
      sides: ["before", "after"],
      blobReads: 1,
      respond: (request) => {
        if (request.method === WORKSPACE_METHOD.conflictsList) {
          return { conflicts: [conflict()], nextAfterConflictId: null };
        }
        return request.method === WORKSPACE_METHOD.conflictsResolve
          ? {
              conflict: conflict("resolved"),
              write: null,
              delete: {
                object: fileObject,
                before: snapshot,
                moment: { ...overCapBothSides, operation: "delete" },
              },
            }
          : undefined;
      },
      run: async (store) => {
        const resolved = await store.resolveTextConflict({
          workspaceId: WORKSPACE_ID,
          conflictId: "conflict",
          resolution: { kind: "apply-incoming" },
          metadata: { origin: "api" },
        });
        if (resolved.delete === undefined) throw new Error("expected a delete");
        return resolved.delete.moment;
      },
    },
  ];

  it.each(MOMENT_SURFACES)(
    "hydrates the over-cap moment $name returns (#359)",
    async (surface) => {
      const requests: Request[] = [];
      const client = blobClientFor(async (request, deliver) => {
        requests.push(request);
        if (request.method === VERSIONED_METHOD.textReadBlob) {
          return { id: request.id, result: overCapBlobResult(request, deliver) };
        }
        const result = surface.respond(request);
        if (result === undefined) {
          throw new Error(`Unexpected method ${request.method}`);
        }
        return { id: request.id, result };
      });
      const { store } = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
        sessionsFor(client),
      );

      const hydrated = await surface.run(store);

      for (const side of surface.sides) {
        const payload =
          side === "after" ? hydrated.payload.after : hydrated.payload.before;
        expect(
          Buffer.from(payload?.text ?? "", "utf8"),
          `${surface.name} payload.${side}`,
        ).toEqual(Buffer.from(OVER_CAP_BYTES));
      }
      expect(
        requests.filter(
          (request) => request.method === VERSIONED_METHOD.textReadBlob,
        ),
      ).toHaveLength(surface.blobReads);
    },
  );

  it("rejects a withheld text moment that carries no digest to hydrate from", async () => {
    const client = blobClientFor(async (request) => ({
      id: request.id,
      result: {
        ...moment,
        afterText: null,
        afterBlobSha256: null,
        afterByteLength: OVER_CAP_BYTES.byteLength,
        afterInbandLimitBytes: 128 * 1024,
      },
    }));
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.getMoment({
        workspaceId: WORKSPACE_ID,
        momentId: "resolved-moment",
      }),
    ).rejects.toThrow("carries no text digest");
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
          // The daemon's delete shape: `delete_text_in_tx` (store.rs) binds the
          // preimage digest to BOTH `after_blob_sha256` and
          // `before_blob_sha256`, and the read joins the same blob row per
          // side, so the removed body and its length repeat on the after side.
          moment: {
            ...moment,
            operation: "delete",
            beforeBlobSha256: "c".repeat(64),
            beforeLatestMomentId: "concurrent-moment",
            beforeText: "newer content",
            beforeByteLength: 13,
            afterBlobSha256: "c".repeat(64),
            afterText: "newer content",
            afterByteLength: 13,
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
        payload: {
          before: { text: "newer content", sha256: "c".repeat(64) },
          // Read from the record's own after side, not copied from the before
          // side: one digest covers both, which is what earns the single blob
          // fetch when the body is over cap (#487).
          after: { text: "newer content", sha256: "c".repeat(64) },
        },
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
              hasYdocMarker: false,
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
