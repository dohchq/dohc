import {
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  type CompletedDaemonBlob,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";

// A type alias, not an interface: only aliases get an implicit index signature,
// which is what makes this assignable to the wire's `JsonValue`.
export type CaptureFlushResult = {
  settled: boolean;
  running: boolean;
  degraded: boolean;
};

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
      if (request.method === "capture.flush") {
        return { id: request.id, result: captureFlushResult() };
      }
      if (request.method === "capture.reconcile") {
        return { id: request.id, result: captureFlushResult() };
      }
      if (request.method === "capture.setAuthor") {
        return { id: request.id, result: { updated: true } };
      }
      if (request.method === "watcher.status") {
        return {
          id: request.id,
          result: { running: true, degraded: false, terminal: false },
        };
      }
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
