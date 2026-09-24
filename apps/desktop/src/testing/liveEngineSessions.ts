import {
  VERSIONED_METHOD,
  type CompletedDaemonBlob,
  type JsonValue,
  type Request,
  type Response,
  type WatcherStatusResult,
} from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createFakeDaemonCapture } from "./fakeDaemonCapture";

// A type alias, not an interface: only aliases get an implicit index signature,
// which is what makes this assignable to the wire's `JsonValue`.
export type CaptureFlushResult = {
  settled: boolean;
  running: boolean;
  degraded: boolean;
};

const READY_WATCHER_STATUS = {
  running: true,
  degraded: false,
  terminal: false,
  phase: "ready",
} satisfies WatcherStatusResult;

/**
 * The daemon capture lifecycle the loopback has no concept of: flush,
 * reconcile, author, watcher status, and pending adoptions. A fake transport
 * that forwards everything else to a `VersionedLoopbackEngine` answers these
 * first so `capture.start()`, `flush()`, and `stop()` behave as they do
 * against the daemon. Returns null for every other method.
 */
export function daemonCaptureLifecycleAnswer(
  request: Request,
  captureFlushResult: () => CaptureFlushResult = () => ({
    settled: true,
    running: true,
    degraded: false,
  }),
): Response | null {
  switch (request.method) {
    case "capture.flush":
    case "capture.reconcile":
      return { id: request.id, result: captureFlushResult() };
    case "capture.setAuthor":
      return { id: request.id, result: { updated: true } };
    case "watcher.status":
      return { id: request.id, result: READY_WATCHER_STATUS };
    case "collections.listPendingAdoptions":
      return { id: request.id, result: { adoptions: [], nextCursor: null } };
    default:
      return null;
  }
}

/**
 * Daemon-shaped `EngineWorkspaceSessions` backed by a real
 * `VersionedLoopbackEngine`, for suites that need the daemon capture path
 * without a daemon process.
 *
 * The loopback answers every versioned/secret/moment method with real state and
 * real sha256, so tests that read content back are not asserting against a
 * hand-written responder. Only the handful of methods the loopback has no
 * concept of — workspace open/close, capture flush and author, watcher status —
 * are answered here.
 *
 * Extracted from `workspaceEngineCapture.test.ts`, where it was private, so the
 * remaining suites on the legacy fallback can migrate onto one harness instead
 * of each growing its own. Keeping it shared matters: a per-suite copy is how
 * fixtures drift apart and start disagreeing about what the daemon does.
 *
 * `requests` collects every request when supplied, which is how a test proves
 * the path it took rather than inferring it from the result.
 */
export function mockLiveSessions(
  loopback: VersionedLoopbackEngine,
  requests?: Request[],
  captureFlushResult: () => CaptureFlushResult = () => ({
    settled: true,
    running: true,
    degraded: false,
  }),
  beforeRequest?: (request: Request) => void | Promise<void>,
): EngineWorkspaceSessions {
  return loopbackSessions(loopback, { requests, captureFlushResult, beforeRequest });
}

/**
 * `mockLiveSessions` plus the daemon's disk side (`createFakeDaemonCapture`):
 * `capture.flush` ingests the workspace folder and `versions.setActive`
 * rewrites it. For suites whose subject is chain-side state that depends on
 * capture having happened: restore, version switch, secret materialization.
 */
export function mockDaemonSessions(input: {
  rootPath: string;
  workspaceId: string;
  loopback: VersionedLoopbackEngine;
  requests?: Request[];
  // Runs before the daemon sees a request.
  beforeRequest?: (request: Request) => void | Promise<void>;
  // Runs after the daemon answered a request, before the caller sees it.
  afterRequest?: (request: Request) => void | Promise<void>;
}): EngineWorkspaceSessions {
  const disk = createFakeDaemonCapture(input);
  return loopbackSessions(input.loopback, {
    requests: input.requests,
    ...(input.beforeRequest ? { beforeRequest: input.beforeRequest } : {}),
    answer: async (request) => {
      const answered = await disk.sendRequest(request);
      await input.afterRequest?.(request);
      return answered;
    },
  });
}

function loopbackSessions(
  loopback: VersionedLoopbackEngine,
  options: {
    requests?: Request[];
    captureFlushResult?: () => CaptureFlushResult;
    beforeRequest?: (request: Request) => void | Promise<void>;
    // Answers ahead of the lifecycle defaults; null falls through.
    answer?: (request: Request) => Promise<Response | null>;
  },
): EngineWorkspaceSessions {
  const { requests, captureFlushResult, beforeRequest, answer } = options;
  const blobHandlers = new Set<(blob: CompletedDaemonBlob) => void>();
  const client = {
    close: () => undefined,
    onEvent: () => () => undefined,
    // A body past the 48 KiB egress cap never rides in a result. Speaking the
    // blob capability here is what lets a suite on this harness read back an
    // over-cap body at all — without it every over-cap read refuses on the
    // missing capability, and no test can reach the hydration the daemon's
    // withheld answers require.
    helloAck: { capabilities: ["blobs"] },
    onBlob(handler: (blob: CompletedDaemonBlob) => void) {
      blobHandlers.add(handler);
      return () => blobHandlers.delete(handler);
    },
    async sendRequest(request: Request): Promise<Response> {
      if (beforeRequest) {
        await beforeRequest(request);
      }
      requests?.push(request);
      const params = request.params as Record<string, JsonValue | undefined>;
      if (request.method === "workspace.open") {
        return {
          id: request.id,
          result: { workspace: String(params.workspaceId) },
        };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      const answered = answer ? await answer(request) : null;
      if (answered) return answered;
      const lifecycle = daemonCaptureLifecycleAnswer(request, captureFlushResult);
      if (lifecycle) return lifecycle;
      const response = await loopback.sendRequest(request);
      if (request.method === VERSIONED_METHOD.textReadBlob) {
        deliverWithheldBlob(loopback, request, response, blobHandlers);
      }
      return response;
    },
  };
  return new EngineWorkspaceSessions({
    currentClient: () => client,
  });
}

/**
 * Stream the body the loopback withheld, the way the daemon does: a
 * `versionedText.readBlob` answer with `bytesBase64: null` is metadata, and
 * the bytes arrive on the blob channel before the caller sees the response.
 * Delivery happens here, synchronously, because `requestWithBlob` reads the
 * correlated blob the moment its send resolves.
 */
function deliverWithheldBlob(
  loopback: VersionedLoopbackEngine,
  request: Request,
  response: Response,
  handlers: Set<(blob: CompletedDaemonBlob) => void>,
): void {
  const result = response.result as { bytesBase64?: JsonValue } | null;
  if (result === null || result.bytesBase64 !== null) return;
  const params = request.params as Record<string, JsonValue | undefined>;
  const workspace = String(request.workspace);
  const sha256 = String(params.sha256);
  const text = loopback.textBodyForDigest(workspace, sha256);
  if (text === null) return;
  const bytes = new Uint8Array(Buffer.from(text, "utf8"));
  for (const handler of [...handlers]) {
    handler({
      requestId: request.id,
      streamId: request.id,
      totalBytes: bytes.byteLength,
      sha256,
      bytes,
    });
  }
}
