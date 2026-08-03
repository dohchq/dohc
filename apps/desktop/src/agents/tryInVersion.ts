// PR 0N-2 "Try it in a version" — the agent-loop gesture. One main-side
// orchestration that COMPOSES existing operations, never re-implements them:
//
//   1. name the fork after the task ("Try: <short snippet>", suffixed on
//      collision),
//   2. capture.createVersion(name) — the 0M-4 create-and-switch: latest disk
//      edits are captured into the version being left and the fork becomes
//      active, all serialized on the engine capture chain,
//   3. start a dohc-tracked agent run (AgentIntegration / AgentSessionManager)
//      so 0N-1 attribution applies to everything the agent writes.
//
// When the run ends — every terminal path funnels through
// AgentIntegration.endAgentRun (driver turn-completed, a Settings stop,
// the endAgentRun IPC) — the session becomes a REVIEW state carrying the
// changed-file count vs Main (0M-4 compare, also on the capture chain).
// Sessions are in-memory: runs cannot outlive the app (quit ends them), and
// the versions themselves are durable engine state either way — nothing a
// lost card could silently discard.

export interface TryVersionRecordLike {
  id: string;
  name: string;
  kind: "main" | "named";
  forkPoint?: { versionId: string };
}

export interface TryVersionSnapshotLike {
  versions: TryVersionRecordLike[];
  activeVersionId: string;
}

// The subset of WorkspaceEngineCapture the gesture composes. Structural so
// unit tests never need a real engine store.
export interface TryVersionOperations {
  listVersions(): Promise<TryVersionSnapshotLike>;
  createVersion(name: string): Promise<TryVersionSnapshotLike>;
  // The review card needs the count only; counting reads the engine's
  // metadata listing and hydrates no text (#562).
  compareVersionsChangedCount(sourceVersionId: string): Promise<number>;
}

export type TryInVersionRunState =
  | {
      status: "running";
      task: string;
      versionId: string;
      versionName: string;
      runId: string;
      startedAtMs: number;
      mergeAvailable: boolean;
    }
  | {
      status: "review";
      task: string;
      versionId: string;
      versionName: string;
      runId: string;
      startedAtMs: number;
      endedAtMs: number;
      runOutcome: "complete" | "failed";
      // null = the count could not be computed (compare failed); the review
      // surface says so instead of inventing a number.
      changedFileCount: number | null;
      mergeAvailable: boolean;
    };

export interface TryInVersionSessionsOptions {
  // Resolves the workspace's version operations; throws when versions are not
  // enabled for the workspace (the same gate the version IPC handlers apply).
  operationsFor(workspaceId: string): Promise<TryVersionOperations>;
  // Starts the dohc-tracked run that owns the try. Resolves to the run id the
  // end-of-run signal will carry.
  startRun(
    workspaceId: string,
    task: string,
    driverId?: string,
  ): Promise<{ id: string }>;
  // Fired on every state transition so main can ping the renderer's single
  // workspace-activity channel.
  onStateChanged?: (workspaceId: string) => void;
  now?: () => number;
}

export const TRY_VERSION_NAME_PREFIX = "Try: ";
const TASK_SNIPPET_MAX_CHARS = 40;
// Remember the last few ended runs per workspace so an end signal that races
// start() (a driver session can fail and finalize before its run id is
// returned) is never lost.
const ENDED_RUNS_REMEMBERED = 8;

export function tryVersionName(
  task: string,
  existingNames: Iterable<string>,
): string {
  const collapsed = task.replace(/\s+/g, " ").trim();
  const characters = [...collapsed];
  const snippet =
    characters.length > TASK_SNIPPET_MAX_CHARS
      ? `${characters.slice(0, TASK_SNIPPET_MAX_CHARS).join("").trimEnd()}…`
      : collapsed;
  const base = `${TRY_VERSION_NAME_PREFIX}${snippet}`;
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable in practice; keep the gesture total rather than looping.
  return `${base} ${Date.now()}`;
}

interface Session {
  state: TryInVersionRunState;
  ops: TryVersionOperations;
  // Set once the review transition has been kicked off, so duplicate end
  // signals never run compare twice.
  finishing: boolean;
}

export function createTryInVersionSessions(options: TryInVersionSessionsOptions) {
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, Session>();
  const endedRuns = new Map<string, Map<string, "complete" | "failed">>();
  // Background review transitions, joined by settled() so tests (and
  // shutdown-sensitive callers) can await quiescence.
  let pending: Promise<void> = Promise.resolve();

  function rememberEnded(
    workspaceId: string,
    runId: string,
    status: "complete" | "failed",
  ): void {
    let runs = endedRuns.get(workspaceId);
    if (!runs) {
      runs = new Map();
      endedRuns.set(workspaceId, runs);
    }
    runs.set(runId, status);
    while (runs.size > ENDED_RUNS_REMEMBERED) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }
  }

  function beginReview(workspaceId: string, session: Session, runOutcome: "complete" | "failed"): void {
    if (session.state.status !== "running" || session.finishing) return;
    session.finishing = true;
    const task = (async () => {
      let changedFileCount: number | null = null;
      try {
        changedFileCount = await session.ops.compareVersionsChangedCount(
          session.state.versionId,
        );
      } catch {
        // Count unavailable — the review state says so (null), never guesses.
      }
      if (sessions.get(workspaceId) !== session) return;
      session.state = {
        status: "review",
        task: session.state.task,
        versionId: session.state.versionId,
        versionName: session.state.versionName,
        runId: session.state.runId,
        startedAtMs: session.state.startedAtMs,
        endedAtMs: now(),
        runOutcome,
        changedFileCount,
        mergeAvailable: session.state.mergeAvailable,
      };
      options.onStateChanged?.(workspaceId);
    })();
    pending = pending.then(() => task.catch(() => undefined));
  }

  async function start(
    workspaceId: string,
    task: string,
    driverId?: string,
  ): Promise<{ versionId: string; versionName: string; runId: string }> {
    const trimmed = task.replace(/\s+/g, " ").trim();
    if (trimmed.length === 0) {
      throw new Error("Describe what the agent should try first.");
    }
    const existing = sessions.get(workspaceId);
    if (existing && existing.state.status === "running") {
      throw new Error(
        "An agent is already trying something in this workspace. Wait for it to finish, or stop it from Settings → Agents & MCP.",
      );
    }
    const ops = await options.operationsFor(workspaceId);
    const before = await ops.listVersions();
    const name = tryVersionName(
      trimmed,
      before.versions.map((version) => version.name),
    );
    // 0M-4 create-and-switch: the latest disk edits are captured first and the
    // fork becomes the active version — no disk rewrite, nothing lost.
    const created = await ops.createVersion(name);
    const versionId = created.activeVersionId;
    const record = created.versions.find((version) => version.id === versionId);
    const mergeAvailable =
      record?.kind === "named" && record.forkPoint?.versionId === "main";
    let run: { id: string };
    try {
      run = await options.startRun(workspaceId, trimmed, driverId);
    } catch (error) {
      // The fork exists (visible in the version menu, nothing to clean up —
      // no-silent-loss) but no run owns it; say both things plainly.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The version "${name}" was created, but the agent could not start: ${reason}`,
      );
    }
    const session: Session = {
      state: {
        status: "running",
        task: trimmed,
        versionId,
        versionName: name,
        runId: run.id,
        startedAtMs: now(),
        mergeAvailable,
      },
      ops,
      finishing: false,
    };
    sessions.set(workspaceId, session);
    options.onStateChanged?.(workspaceId);
    // The run may have ended while start() was still awaiting its id (a
    // driver session that fails finalizes immediately) — catch up now.
    const alreadyEnded = endedRuns.get(workspaceId)?.get(run.id);
    if (alreadyEnded) beginReview(workspaceId, session, alreadyEnded);
    return { versionId, versionName: name, runId: run.id };
  }

  function handleRunEnded(
    workspaceId: string,
    runId: string,
    status: "complete" | "failed",
  ): void {
    rememberEnded(workspaceId, runId, status);
    const session = sessions.get(workspaceId);
    if (!session || session.state.status !== "running" || session.state.runId !== runId) {
      return;
    }
    beginReview(workspaceId, session, status);
  }

  function snapshot(workspaceId: string): TryInVersionRunState | null {
    return sessions.get(workspaceId)?.state ?? null;
  }

  // Clears a REVIEW session ("Keep working in it" / after set-aside or merge).
  // A running session is live status, not dismissible.
  function dismiss(workspaceId: string): boolean {
    const session = sessions.get(workspaceId);
    if (!session || session.state.status !== "review") return false;
    sessions.delete(workspaceId);
    options.onStateChanged?.(workspaceId);
    return true;
  }

  // Resolves when every review transition kicked off so far has settled.
  function settled(): Promise<void> {
    return pending;
  }

  return { start, handleRunEnded, snapshot, dismiss, settled };
}

export type TryInVersionSessions = ReturnType<typeof createTryInVersionSessions>;
