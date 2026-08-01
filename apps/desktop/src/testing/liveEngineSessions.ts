import {
  VersionedLoopbackEngine,
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
  const client = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      await beforeRequest?.(request);
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
      if (request.method === "capture.setAuthor") {
        return { id: request.id, result: { updated: true } };
      }
      if (request.method === "watcher.status") {
        return {
          id: request.id,
          result: { running: true, degraded: false, terminal: false },
        };
      }
      return await loopback.sendRequest(request);
    },
  };
  return new EngineWorkspaceSessions({
    currentClient: () => client,
  });
}
