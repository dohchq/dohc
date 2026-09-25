import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
  type EngineDaemonClientSource,
  type EngineDaemonLifecycleOptions,
} from "@dohc/workspace-engine-client/daemon";

// Aggregate test load delays a real daemon's workspace work well beyond the
// product's deadlines: 2 s for a session's workspace open and 5 s for a
// lifecycle request. Under the full JS gate one startup smoke open took longer
// than 5 s, and a loaded run of the capture suite saw a session open take 6.5 s.
// One fixed test-only deadline keeps that contention policy out of individual
// suites without changing production.
export const REAL_DAEMON_DEADLINE_MS = 20_000;
// A real-daemon test does several deadline-bounded steps. Three deadlines let
// a slow step fail on its own deadline, with its own error, before the test's.
export const REAL_DAEMON_TEST_TIMEOUT_MS = 3 * REAL_DAEMON_DEADLINE_MS;

/** Creates sessions for tests that start a real engine daemon. */
export function createRealDaemonWorkspaceSessions(
  source: EngineDaemonClientSource,
  options: { workspaceOpenDeadlineMs?: number } = {},
): EngineWorkspaceSessions {
  return new EngineWorkspaceSessions(source, {
    workspaceOpenDeadlineMs:
      options.workspaceOpenDeadlineMs ?? REAL_DAEMON_DEADLINE_MS,
  });
}

/**
 * Creates the lifecycle for a test that starts a real engine daemon.
 *
 * The request timeout also bounds the background startup smoke. A smoke that
 * misses it kills the daemon, which ends a suite that allows no restarts.
 */
export function createRealDaemonLifecycle(
  options: EngineDaemonLifecycleOptions,
): EngineDaemonLifecycle {
  return new EngineDaemonLifecycle({
    requestTimeoutMs: REAL_DAEMON_DEADLINE_MS,
    ...options,
  });
}
