// Before a live page, or a folder holding one, moves, this device catches up
// with the server for a few seconds: one owner sync for each page it is bound
// to, then one ordinary pull, so the move carries edits the server already
// accepted. The guard never refuses a move. Offline, failing or out of time,
// the move goes ahead as it would without it.

export interface LiveDocumentPath {
  path: string;
  objectId: string;
}

export interface MoveAcceptedEditsGuardOptions {
  // The last complete live-host list for the workspace. Undefined before the
  // first list arrives, when nothing counts as live.
  liveDocuments(workspaceId: string): readonly LiveDocumentPath[] | undefined;
  // Sync already reports a failure, so catching up would only wait.
  offline(workspaceId: string): boolean;
  // One owner sync for each listed page. True only when every page answered
  // or this device is not bound to it.
  ownerCatchUp(workspaceId: string, objectIds: readonly string[], signal: AbortSignal): Promise<boolean>;
  // One ordinary pull, which lands the saved edit in the file.
  relayCatchUp(workspaceId: string, signal: AbortSignal): Promise<void>;
  // How long each move waits, from its arrival.
  waitMs?: number;
  // A monotonic clock in milliseconds. Tests replace it.
  now?(): number;
}

export const MOVE_ACCEPTED_EDITS_WAIT_MS = 3_000;

interface Attempt {
  targets: Set<string>;
  waiting: number;
  // The latest deadline of the moves that joined it. Nothing starts after it.
  expiresAt: number;
  controller: AbortController;
  done: Promise<void>;
  settle(): void;
}

function newAttempt(): Attempt {
  let settle!: () => void;
  const done = new Promise<void>(resolve => { settle = resolve; });
  return { targets: new Set(), waiting: 0, expiresAt: -Infinity, controller: new AbortController(), done, settle };
}

// Each workspace has at most one active attempt, already sent, and one
// pending attempt. A move joins an attempt only when that attempt's targets
// cover every page it needs.
export function createMoveAcceptedEditsGuard(options: MoveAcceptedEditsGuardOptions) {
  const waitMs = options.waitMs ?? MOVE_ACCEPTED_EDITS_WAIT_MS;
  const now = options.now ?? (() => performance.now());
  const active = new Map<string, Attempt>();
  const pending = new Map<string, Attempt>();

  // A deadline can pass before its timer runs, so each phase checks the clock too.
  const expired = (attempt: Attempt) => attempt.controller.signal.aborted || now() >= attempt.expiresAt;

  async function run(workspaceId: string, attempt: Attempt): Promise<void> {
    const { signal } = attempt.controller;
    if (expired(attempt) || options.offline(workspaceId)) return;
    const answered = await options.ownerCatchUp(workspaceId, [...attempt.targets], signal);
    if (!answered || expired(attempt)) return;
    await options.relayCatchUp(workspaceId, signal);
  }

  function start(workspaceId: string, attempt: Attempt): void {
    active.set(workspaceId, attempt);
    // Late results and rejections are swallowed: the move already went ahead
    // or is about to, and ordinary sync reports its own failures.
    void run(workspaceId, attempt).catch(() => undefined).finally(() => {
      attempt.settle();
      if (active.get(workspaceId) === attempt) active.delete(workspaceId);
      // A settled attempt never runs again. Only a pending, unexpired one
      // starts. An expired one releases its moves at once.
      const next = pending.get(workspaceId);
      if (!next) return;
      pending.delete(workspaceId);
      if (!expired(next)) start(workspaceId, next);
      else {next.controller.abort(); next.settle();}
    });
  }

  // The last waiting move's timer expires its attempt. A pending attempt is
  // dropped and never starts; an active one aborts its signal.
  function leave(workspaceId: string, attempt: Attempt): void {
    attempt.waiting -= 1;
    if (attempt.waiting > 0) return;
    attempt.controller.abort();
    if (pending.get(workspaceId) === attempt) pending.delete(workspaceId);
  }

  function join(workspaceId: string, objectIds: readonly string[], deadline: number): Attempt {
    const current = active.get(workspaceId);
    if (current && !current.controller.signal.aborted && objectIds.every(id => current.targets.has(id))) {
      current.expiresAt = Math.max(current.expiresAt, deadline);
      return current;
    }
    let attempt = current ? pending.get(workspaceId) : undefined;
    if (!attempt) {
      attempt = newAttempt();
      if (current) pending.set(workspaceId, attempt);
    }
    for (const id of objectIds) attempt.targets.add(id);
    attempt.expiresAt = Math.max(attempt.expiresAt, deadline);
    if (!current) start(workspaceId, attempt);
    return attempt;
  }

  return {
    // `path` is the source's stored spelling. Paths are compared as stored,
    // at or under, so a case alias of a page or of its folder still matches.
    async beforeMove(workspaceId: string, path: string): Promise<void> {
      let objectIds: string[];
      try {
        objectIds = (options.liveDocuments(workspaceId) ?? [])
          .filter(document => document.path === path || document.path.startsWith(`${path}/`))
          .map(document => document.objectId);
      } catch {
        return;
      }
      if (!objectIds.length) return;
      const attempt = join(workspaceId, objectIds, now() + waitMs);
      attempt.waiting += 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); });
      try {
        await Promise.race([attempt.done, expired]);
      } finally {
        clearTimeout(timer);
        leave(workspaceId, attempt);
      }
    },
  };
}

export type MoveAcceptedEditsGuard = ReturnType<typeof createMoveAcceptedEditsGuard>;
