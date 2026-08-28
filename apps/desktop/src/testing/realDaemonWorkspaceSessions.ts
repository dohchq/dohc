import {
  EngineWorkspaceSessions,
  type EngineDaemonClientSource,
} from "@dohc/workspace-engine-client/daemon";

const REAL_DAEMON_WORKSPACE_OPEN_DEADLINE_MS = 10_000;

/**
 * Creates sessions for tests that start a real engine daemon.
 *
 * Aggregate test load can delay daemon workspace initialization beyond the
 * product's two-second guarantee. One fixed test-only deadline keeps that
 * contention policy out of individual suites without changing production.
 */
export function createRealDaemonWorkspaceSessions(
  source: EngineDaemonClientSource,
): EngineWorkspaceSessions {
  return new EngineWorkspaceSessions(source, {
    workspaceOpenDeadlineMs: REAL_DAEMON_WORKSPACE_OPEN_DEADLINE_MS,
  });
}
