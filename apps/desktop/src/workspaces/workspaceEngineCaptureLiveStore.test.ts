import type { EngineDaemonClient } from "@dohc/workspace-engine-client/daemon";
import type {
  EngineWorkspaceBinding,
  EngineWorkspaceRunOptions,
  EngineWorkspace,
} from "@dohc/workspace-engine-client/daemon";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  VERSIONED_METHOD,
  WORKSPACE_METHOD,
  type AgentAuthor,
  type ConflictRecord,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createCaptureLiveStores as createAttachedCaptureLiveStores,
  EngineCaptureNotSettledError,
} from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";
import { restoreDirectWrites, type StopAndRestoreDependencies } from "./stopAndRestore";

vi.mock("node:timers/promises", { spy: true });

const WORKSPACE_ID = "workspace";
const WORKSPACE_HANDLE = "workspace-handle";
const SENTINEL = new Error("sentinel");

// Small advertised caps exercise omitted-body hydration with UTF-8 and a BOM.
const OVER_CAP_TEXT = `\uFEFF# héllo\n${"é".repeat(12)}\n`;
const OVER_CAP_BYTES = new Uint8Array(Buffer.from(OVER_CAP_TEXT, "utf8"));
const OVER_CAP_SHA256 = createHash("sha256").update(OVER_CAP_BYTES).digest("hex");

function createCaptureLiveStores(
  workspace: EngineWorkspace,
  sessions: EngineWorkspaceSessions,
  signal?: AbortSignal,
) {
  return createAttachedCaptureLiveStores(
    {
      ...workspace,
      attachmentId:
        workspace.attachmentId ?? Symbol(`test-workspace-attachment:${workspace.workspaceId}`),
    },
    sessions,
    signal,
  );
}

function sessionsFor(
  client: EngineDaemonClient,
  optionsSeen: Array<EngineWorkspaceRunOptions | undefined> = [],
  captureAuthorsSeen: Array<AgentAuthor | null> = [],
): EngineWorkspaceSessions {
  const binding: EngineWorkspaceBinding = {
    client,
    workspace: WORKSPACE_HANDLE,
    localStateReady: true,
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
    rememberCaptureAuthor(_workspace: EngineWorkspace, author: AgentAuthor | null) {
      captureAuthor = author;
    },
    async closeWorkspace() {},
  } as unknown as EngineWorkspaceSessions;
}

function clientFor(sendRequest: (request: Request) => Promise<Response>): EngineDaemonClient {
  return { close: () => undefined, sendRequest };
}

type CompletedBlob = Parameters<Parameters<NonNullable<EngineDaemonClient["onBlob"]>>[0]>[0];

/**
 * The daemon's answer to `versionedText.readBlob` for the digests this
 * workspace references, and a refusal for every other one:
 * `read_text_blob_with_hydration` (store.rs) authorizes a digest against the
 * workspace's text references before it reads a byte. A fake that answered any
 * digest could not fail, and would pin nothing about the request sent.
 *
 * Delivery is out of band because the bodies exceed the fixture's 8-byte cap.
 */
function overCapBlobResult(
  request: Request,
  deliver: (blob: CompletedBlob) => void,
  bodies: ReadonlyMap<string, Uint8Array> = new Map([[OVER_CAP_SHA256, OVER_CAP_BYTES]]),
): Response["result"] {
  const params = request.params as { sha256?: unknown };
  const bytes = typeof params.sha256 === "string" ? bodies.get(params.sha256) : undefined;
  if (bytes === undefined) {
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
    totalBytes: bytes.byteLength,
    sha256: params.sha256 as string,
    bytes,
  });
  return {
    bytesBase64: null,
    byteLength: bytes.byteLength,
    inbandLimitBytes: 8,
  };
}

/**
 * An over-cap body whose bytes and digest are the label's alone. Three of
 * these on one conflict make a side hydrated from another side's digest read
 * back the wrong text, rather than passing on the coincidence that all three
 * sides named the same body.
 */
function overCapBody(label: string): {
  text: string;
  bytes: Uint8Array;
  sha256: string;
} {
  const text = `\uFEFF# ${label}\n${"é".repeat(12)}\n`;
  const bytes = new Uint8Array(Buffer.from(text, "utf8"));
  return {
    text,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const BASE_BODY = overCapBody("base");
const CURRENT_BODY = overCapBody("current");
const INCOMING_BODY = overCapBody("incoming");

/**
 * A client that can deliver a completed blob out of band, which is the only
 * way a body past the fixture's 8-byte cap reaches the adapter. `clientFor` has
 * no `helloAck` and no `onBlob`, so a suite built on it cannot observe blob
 * hydration at all — it refuses first, on the missing capability.
 */
function blobClientFor(
  sendRequest: (request: Request, deliver: (blob: CompletedBlob) => void) => Promise<Response>,
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
  authors: null,
  syncRecordOnly: false,
  afterText: "hello",
  afterByteLength: 5,
  afterInbandLimitBytes: null,
  beforeText: "hello",
  beforeByteLength: 5,
  beforeInbandLimitBytes: null,
} as const;

describe("Stop and restore relay confirmation through the moment reader", () => {
  it.each(["confirmed", "local"] as readonly ("confirmed" | "local" | "mixed" | "unattributed")[])(
    "checks %s live settlement authors from the daemon",
    async (kind) => {
      const human = {
        kind: "human",
        humanId: "ana",
        ...(kind === "local" ? {} : { humanName: "Ana", relayConfirmed: true }),
      };
      const created = {
        ...moment,
        momentId: "created",
        beforePresent: false,
        authors: [{ kind: "named", userId: "ana", grantId: "grant", grantGeneration: 1 }],
      };
      const later = {
        ...moment,
        momentId: `moment-ydoc-${"b".repeat(64)}`,
        metadataOrigin: "local-file",
        beforeBlobSha256: moment.afterBlobSha256,
        afterBlobSha256: "b".repeat(64),
        afterText: "Changed",
        authors:
          kind === "mixed"
            ? [human, { kind: "human", humanId: "owner", humanName: "Owner", relayConfirmed: true }]
            : kind === "unattributed"
              ? [human, { kind: "unattributed" }]
              : [human],
      };
      const client = clientFor(async (request) => {
        expect(request.method).toBe(VERSIONED_METHOD.momentsGet);
        return {
          id: request.id,
          result: (request.params as { momentId: string }).momentId === "created" ? created : later,
        };
      });
      const { store } = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
        sessionsFor(client),
      );
      const restore = vi.fn<StopAndRestoreDependencies["restore"]>(async () => ({
        kind: "restored",
        receipt: { path: moment.path, restoredMomentId: "back", removed: true },
      }));
      const outcome = await restoreDirectWrites(
        {
          moment: (id) => store.getMoment({ workspaceId: WORKSPACE_ID, momentId: id }),
          momentsAfter: async () => [later.momentId],
          assertCurrent() {},
          restore,
          folderEntries: async () => [],
          removeEmptyFolder: async () => {},
          undoRuns: async () => {
            throw new Error("no automations");
          },
        },
        [
          {
            momentId: created.momentId,
            objectId: moment.objectId,
            path: moment.path,
            created: true,
          },
        ],
      );
      if (kind === "confirmed") {
        expect(outcome).toMatchObject({
          restored: [{ path: moment.path, removed: true }],
          review: [],
        });
        expect(restore).toHaveBeenCalledWith(created.momentId, later.momentId, false);
      } else {
        expect(outcome).toMatchObject({
          restored: [],
          review: [
            {
              path: moment.path,
              reason: "changed-since",
              changedBy:
                kind === "local"
                  ? "Person ana"
                  : kind === "unattributed"
                    ? "An unrecorded author"
                    : "Another author",
            },
          ],
        });
        expect(restore).not.toHaveBeenCalled();
      }
    },
  );
  it.each([false])("refuses a snapshot person's relay confirmation of %s", async (marker) => {
    const later = {
      ...moment,
      authors: [{ kind: "human", humanId: "ana", humanName: "Ana", relayConfirmed: marker }],
    };
    const client = clientFor(async (request) => ({ id: request.id, result: later }));
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );
    await expect(
      store.getMoment({ workspaceId: WORKSPACE_ID, momentId: later.momentId }),
    ).rejects.toThrow();
  });
});

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
  it("remembers capture authors only for an attached non-share workspace", () => {
    const remembered: Array<[EngineWorkspace, AgentAuthor | null]> = [];
    const sessions = {
      rememberCaptureAuthor(workspace: EngineWorkspace, author: AgentAuthor | null) {
        remembered.push([workspace, author]);
      },
    } as unknown as EngineWorkspaceSessions;
    const attached = {
      workspaceId: WORKSPACE_ID,
      rootPath: "/attached",
      attachmentId: Symbol("attached-workspace"),
    };

    createAttachedCaptureLiveStores(attached, sessions);
    createAttachedCaptureLiveStores(
      {
        workspaceId: "synthetic-share",
        rootPath: "/share",
        shareMount: true,
      },
      sessions,
    );

    expect(remembered).toEqual([[attached, null]]);
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
        result: {
          deferredWrites: [],
          settled: true,
          running: true,
          degraded: false,
          heldFiles: [],
        },
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
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(delay).mockImplementation(async (ms, value) => {
      now += ms ?? 0;
      return value;
    });
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      return {
        id: request.id,
        result:
          request.method === WORKSPACE_METHOD.watcherStatus
            ? {
                deferredWrites: [],
                running: true,
                degraded: false,
                terminal: false,
                phase: "ready",
                noAtomicPlacement: false,
                recoveryUnavailable: false,
                keptFiles: [],
                captureRecoveries: [],
                heldFiles: [],
                retainedCopies: { count: 0, bytes: 0 },
              }
            : { deferredWrites: [], settled: false, running: true, degraded: true, heldFiles: [] },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    try {
      await expect(store.flushCapture?.()).rejects.toThrow(EngineCaptureNotSettledError);
      expect(now).toBe(1_000);
      expect(
        requests.filter((request) => request.method === WORKSPACE_METHOD.captureFlush),
      ).toHaveLength(51);
    } finally {
      clock.mockRestore();
      vi.mocked(delay).mockRestore();
    }
  });

  it.each(["first flush"])(
    "bounds the whole flush when %s hangs without a request deadline",
    async (hangingCall) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      vi.mocked(delay).mockImplementation(
        (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
      );
      const requests: Request[] = [];
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const client = clientFor(async (request) => {
        requests.push(request);
        const hangs =
          hangingCall === "first flush" ||
          (hangingCall === "watcher status" && request.method === WORKSPACE_METHOD.watcherStatus) ||
          (hangingCall === "later flush" && requests.length === 3);
        if (hangs) {
          await pending;
        }
        return {
          id: request.id,
          result:
            request.method === WORKSPACE_METHOD.watcherStatus
              ? {
                  deferredWrites: [],
                  running: true,
                  degraded: false,
                  terminal: false,
                  phase: "ready",
                  noAtomicPlacement: false,
                  recoveryUnavailable: false,
                  keptFiles: [],
                  captureRecoveries: [],
                  heldFiles: [],
                  retainedCopies: { count: 0, bytes: 0 },
                }
              : {
                  deferredWrites: [],
                  settled: false,
                  running: true,
                  degraded: false,
                  heldFiles: [],
                },
        };
      });
      const { store } = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
        sessionsFor(client),
      );
      let result: unknown;
      const flushing = store.flushCapture!().catch((error) => {
        result = error;
      });
      try {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toBe(
          `Engine capture for ${WORKSPACE_ID} did not settle.`,
        );
        expect(requests.every((request) => request.deadlineMs === undefined)).toBe(true);
        expect(performance.now()).toBe(30_000);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        const requestCount = requests.length;
        finish();
        await vi.runAllTimersAsync();
        await flushing;
        expect(requests).toHaveLength(requestCount);
        vi.mocked(delay).mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("does not reopen a closed workspace when an expired flush answers unsettled", async () => {
    const workspace = {
      workspaceId: WORKSPACE_ID,
      rootPath: await createTestScratch("dohc-expired-flush-"),
      attachmentId: Symbol("expired-flush"),
    };
    const requests: Request[] = [];
    const reply = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const client = clientFor(async (request) => {
      requests.push(request);
      if (request.method === WORKSPACE_METHOD.open) {
        return { id: request.id, result: { workspace: WORKSPACE_HANDLE } };
      }
      if (request.method === WORKSPACE_METHOD.close) {
        return { id: request.id, result: { closed: true } };
      }
      if (request.method === WORKSPACE_METHOD.captureFlush) {
        started.resolve();
        await reply.promise;
        return {
          id: request.id,
          result: {
            deferredWrites: [],
            settled: false,
            running: true,
            degraded: false,
            heldFiles: [],
          },
        };
      }
      throw new Error(`Unexpected method: ${request.method}`);
    });
    const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
    const { store } = createCaptureLiveStores(workspace, sessions);
    await sessions.run(workspace, async () => undefined);
    const runs = vi.spyOn(sessions, "run");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const flushing = store.flushCapture!().catch((error) => error);
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await flushing).toEqual(new EngineCaptureNotSettledError(WORKSPACE_ID));
      const closing = store.close!();
      reply.resolve();
      await closing;
      await Promise.allSettled(runs.mock.results.map((result) => result.value));
      expect(requests.map((request) => request.method)).toEqual([
        WORKSPACE_METHOD.open,
        WORKSPACE_METHOD.captureFlush,
        WORKSPACE_METHOD.close,
      ]);
    } finally {
      reply.resolve();
      await flushing;
      await sessions.closeAll();
      runs.mockRestore();
      vi.useRealTimers();
    }
  });

  it("leaves no poll or follow-up request after the total deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.mocked(delay).mockImplementation(
      (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
    );
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      if (request.method === WORKSPACE_METHOD.captureFlush) {
        await new Promise<void>((resolve) => setTimeout(resolve, 29_990));
        return {
          id: request.id,
          result: {
            deferredWrites: [],
            settled: false,
            running: true,
            degraded: false,
            heldFiles: [],
          },
        };
      }
      return {
        id: request.id,
        result: {
          deferredWrites: [],
          running: true,
          degraded: false,
          terminal: false,
          phase: "ready",
          noAtomicPlacement: false,
          recoveryUnavailable: false,
          keptFiles: [],
          captureRecoveries: [],
          heldFiles: [],
          retainedCopies: { count: 0, bytes: 0 },
        },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );
    let result: unknown = "pending";
    const flushing = store.flushCapture!().catch((error) => {
      result = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(result).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect((result as Error).message).toContain("did not settle");
      expect(requests.map((request) => request.method)).toEqual([
        WORKSPACE_METHOD.captureFlush,
        WORKSPACE_METHOD.watcherStatus,
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      await flushing;
      vi.mocked(delay).mockRestore();
      vi.useRealTimers();
    }
  });

  it("abandons an in-flight capture flush when shutdown aborts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const controller = new AbortController();
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const client = clientFor(async (request) => {
      entered();
      await pending;
      return {
        id: request.id,
        result: {
          deferredWrites: [],
          settled: true,
          running: true,
          degraded: false,
          heldFiles: [],
        },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
      controller.signal,
    );
    const flushing = store.flushCapture!();
    const outcome = flushing.catch((error: unknown) => error);
    await started;
    controller.abort();
    try {
      expect(
        await Promise.race([outcome, pending.then(() => "flush was not abandoned")]),
      ).toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      await outcome;
      vi.useRealTimers();
    }
  });

  it("translates a measured size refusal and keeps its measurements", async () => {
    const message = "payload exceeds MAX_TEXT_BYTES: limit 10485760 bytes, observed 10485761 bytes";
    const client = clientFor(async () => {
      throw {
        wireError: { code: "PAYLOAD_TOO_LARGE", message, retry: "no" },
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "note.md",
        text: "over cap",
        metadata: { origin: "api" },
      }),
    ).rejects.toMatchObject({
      name: "VersionedTextStoreError",
      code: "payload-too-large",
      message,
    });
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

    expect(optionsSeen).toEqual([{ retryTransportErrors: true }, undefined]);
    expect(requests.at(-1)?.params).toMatchObject({
      origin: "api",
      summary: "Updated note.md",
      correlationId: "capture-1",
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

  it.each([
    {
      name: "a distinct digest per side",
      // Three different bodies, so a side hydrated from another side's digest
      // reads back the wrong text instead of coinciding with the right one.
      sides: {
        base: BASE_BODY,
        current: CURRENT_BODY,
        incoming: INCOMING_BODY,
      },
      blobDigests: [BASE_BODY.sha256, CURRENT_BODY.sha256, INCOMING_BODY.sha256],
    },
  ])(
    "mutation proof: scans open conflicts without bodies and hydrates only the match, $name (#655)",
    async ({ sides, blobDigests }) => {
      // The scanned-past conflict names a digest this workspace does not
      // reference, so the blob fake refuses it the way the daemon refuses an
      // unauthorized digest. A scan that asked for bodies would hydrate this
      // row on its way to the match and fail here, not merely read too much.
      const DECOY_SHA256 = "d".repeat(64);
      const withheldSide = (body: { bytes: Uint8Array; sha256: string }) => ({
        path: snapshot.path,
        contentKind: "text" as const,
        snapshot: {
          ...snapshot,
          text: null,
          sha256: body.sha256,
          blobSha256: body.sha256,
          byteLength: body.bytes.byteLength,
          inbandLimitBytes: 8,
        },
        binarySha256: null,
        binaryByteLength: null,
        binaryObjectId: null,
        binaryLatestMomentId: null,
        metadataSummary: "side summary",
        metadataCorrelationId: null,
      });
      const decoy = withheldSide({ bytes: OVER_CAP_BYTES, sha256: DECOY_SHA256 });
      const pages = [
        {
          conflicts: [
            {
              ...conflict(),
              id: "scanned-past",
              base: decoy,
              current: decoy,
              incoming: decoy,
            },
          ],
          nextAfterConflictId: "scanned-past",
        },
        {
          conflicts: [
            {
              ...conflict(),
              id: "created-conflict",
              base: withheldSide(sides.base),
              current: withheldSide(sides.current),
              incoming: withheldSide(sides.incoming),
            },
          ],
          nextAfterConflictId: null,
        },
      ] satisfies { conflicts: ConflictRecord[]; nextAfterConflictId: string | null }[];
      // Only the match's digests are readable. The decoy's is not, and neither
      // is any digest no side named.
      const served = new Map(
        [sides.base, sides.current, sides.incoming].map((body) => [body.sha256, body.bytes]),
      );
      const requests: Request[] = [];
      const client = blobClientFor(async (request, deliver) => {
        requests.push(request);
        if (request.method === VERSIONED_METHOD.textReadBlob) {
          return {
            id: request.id,
            result: overCapBlobResult(request, deliver, served),
          };
        }
        if (request.method === VERSIONED_METHOD.textRead) {
          return { id: request.id, result: snapshot };
        }
        if (request.method === VERSIONED_METHOD.versionsMerge) {
          return {
            id: request.id,
            result: {
              status: "conflict",
              conflictId: "created-conflict",
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
        const params = request.params as { afterConflictId?: string };
        if (params.afterConflictId === undefined) {
          return { id: request.id, result: pages[0] };
        }
        // The walk continues from the page's own last row, so a cursor the
        // daemon never issued must not be served page two.
        expect(params.afterConflictId).toBe("scanned-past");
        return { id: request.id, result: pages[1] };
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

      if (result.kind !== "conflict") throw new Error("expected a conflict");
      for (const side of ["base", "current", "incoming"] as const) {
        expect(
          Buffer.from((result.conflict[side] as { text?: string }).text ?? "", "utf8"),
          `conflict.${side}`,
        ).toEqual(Buffer.from(sides[side].bytes));
      }
      expect(
        requests
          .filter((request) => request.method === VERSIONED_METHOD.textReadBlob)
          .map((request) => (request.params as { sha256: string }).sha256),
      ).toEqual(blobDigests);
    },
  );

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

  it.each(["after"] as readonly ("after" | "before")[])(
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
                    afterInbandLimitBytes: 16,
                  }
                : {
                    ...moment,
                    beforeText: null,
                    beforeBlobSha256: OVER_CAP_SHA256,
                    beforeByteLength: OVER_CAP_BYTES.byteLength,
                    beforeInbandLimitBytes: 16,
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

      const hydrated = side === "after" ? detail?.payload.after : detail?.payload.before;
      expect(hydrated?.text).toBe(OVER_CAP_TEXT);
      // Byte-identical, not merely equal-looking: a decoder that strips the
      // leading BOM returns a body whose digest no longer matches the one the
      // moment recorded.
      expect(Buffer.from(hydrated?.text ?? "", "utf8")).toEqual(Buffer.from(OVER_CAP_BYTES));
      expect(
        createHash("sha256")
          .update(hydrated?.text ?? "", "utf8")
          .digest("hex"),
      ).toBe(OVER_CAP_SHA256);
      expect(requests.map((request) => request.method)).toEqual([
        VERSIONED_METHOD.momentsGet,
        VERSIONED_METHOD.textReadBlob,
      ]);
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
        afterInbandLimitBytes: 16,
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

  it.each([VERSIONED_METHOD.momentsGet] as readonly (
    | typeof VERSIONED_METHOD.momentsGet
    | typeof VERSIONED_METHOD.momentsList
  )[])("rejects corrupt author provenance returned by %s", async (method) => {
    const corruptMoment = {
      ...moment,
      authors: [{ kind: "agent", agentId: "agent" }, { corrupt: true }],
    };
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
  });

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
          // preimage digest to both `after_blob_sha256` and
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
          // One digest covers both sides, which is what earns the single blob
          // fetch when the body is over cap. This pair being equal is
          // the daemon's shape, so it cannot show WHERE the after side came
          // from — the test below does that.
          after: { text: "newer content", sha256: "c".repeat(64) },
        },
      },
    });
    expect(requests).toHaveLength(1);
  });

  it("refuses a delete whose after side is absent instead of copying its preimage", async () => {
    // The after side is read, never reconstructed from the before side. The two
    // agree on every daemon-written delete, so only a record that disagrees can
    // prove which one the store reports — and this one the daemon cannot write
    // at all: `map_moment_row` (store.rs) fails closed on a text moment missing
    // its after blob. Copying the preimage over it would answer with content
    // the record does not carry.
    const client = clientFor(async (request) => ({
      id: request.id,
      result: {
        ...moment,
        operation: "delete",
        beforeText: "removed body",
        beforeBlobSha256: "c".repeat(64),
        beforeByteLength: 12,
        afterText: null,
        afterBlobSha256: null,
        afterByteLength: null,
      },
    }));
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace" },
      sessionsFor(client),
    );

    await expect(
      store.getMoment({ workspaceId: WORKSPACE_ID, momentId: "resolved-moment" }),
    ).rejects.toThrow(/after text for note\.md is absent and carries no text digest/);
  });

  it("lists pending and refused heads without ignored local edits making the check incomplete", async () => {
    const requests: Request[] = [];
    const paths = [
      "tasks/automations.yaml",
      "tasks/draft.md",
      "tasks/refused.md",
      "tasks/accepted.md",
      "tasks/owner.md",
      "private.md",
      "tasks/node_modules/local.md",
    ];
    const client = clientFor(async (request) => {
      requests.push(request);
      if (request.method === VERSIONED_METHOD.textList)
        return {
          id: request.id,
          result: {
            files: paths.map((path) => ({
              path,
              objectId: path,
              contentKind: "text",
              sha256: "a".repeat(64),
              byteLength: 5,
              binarySha256: null,
              updatedAtMs: 2,
              hasYdocMarker: false,
              latestMomentId: path === "tasks/owner.md" ? "moment-share-owner" : "moment-local",
              metadataOrigin: path === "tasks/owner.md" ? "sync" : "local-file",
              metadataSummary: null,
              metadataCorrelationId: null,
            })),
            nextAfterPath: null,
          },
        };
      expect(request.method).toBe("share.direct.statuses");
      expect(request.workspace).toBe(WORKSPACE_HANDLE);
      const params = request.params as { paths: string[] };
      if (params.paths.includes("tasks/node_modules/local.md"))
        throw new Error("ignored path refused by engine");
      return {
        id: request.id,
        result: Object.fromEntries(
          params.paths.map((path) => [
            path,
            {
              state:
                path === "tasks/accepted.md"
                  ? "accepted"
                  : path === "tasks/refused.md"
                    ? "refused"
                    : "pending",
            },
          ]),
        ),
      };
    });
    const { store } = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: "C:/workspace", shareMount: true },
      sessionsFor(client),
    );
    await expect(
      store.listUnconfirmedSharePaths({
        workspaceId: WORKSPACE_ID,
        shareId: "share-a",
        grantedSelector: { paths: ["tasks"], versionId: null, access: "edit" },
      }),
    ).resolves.toEqual({ paths: paths.slice(0, 3), unchecked: false, checked: 4 });
    expect(requests.filter((request) => request.method === "share.direct.statuses")).toHaveLength(
      1,
    );
    expect(requests.filter((request) => request.method === VERSIONED_METHOD.textList)).toHaveLength(
      1,
    );
    expect(requests.at(-1)?.params).toEqual({
      workspaceId: WORKSPACE_ID,
      shareId: "share-a",
      paths: paths.slice(0, 4),
      grantedSelector: { paths: ["tasks"], versionId: null, access: "edit" },
    });
    expect(
      requests
        .filter((request) => request.method === "share.direct.statuses")
        .every((request) => request.deadlineMs != null && request.deadlineMs <= 1_000),
    ).toBe(true);
    await expect(
      store.listUnconfirmedSharePaths({
        workspaceId: WORKSPACE_ID,
        shareId: "share-a",
        grantedSelector: { paths: [], versionId: null, access: "edit" },
      }),
    ).resolves.toEqual({ paths: [], unchecked: false, checked: 0 });
    expect(requests.filter((request) => request.method === "share.direct.statuses")).toHaveLength(
      1,
    );
  });
});
