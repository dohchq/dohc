// Tearing down an engine Y.Doc session main opened but will not hand to a
// renderer: a stale session under a reused id, a session whose renderer died
// mid-open, a lineage that came back the wrong content kind.
//
// A close that FAILS is not a clean teardown. The capture layer retains the
// session as `failing-close` and rethrows exactly because the reservation may
// still be held (workspaceEngineCapture.ts, `closeEntry`), and the daemon
// reinserts a refused close's entry with its lease held. So the document may
// still be the engine's, and a writable plain editor over it would be a second
// writer.
//
// Main therefore keeps the session in its registry on failure — that is what
// the close IPC, the renderer-destroy hook, and the quit sweep walk — and tells
// the caller the release did not happen.

export interface ReleasableEngineYDocSession {
  close: () => Promise<void>;
}

export interface ReleaseEngineYDocSessionInput<
  TEntry extends { session: ReleasableEngineYDocSession },
> {
  sessions: Map<string, TEntry>;
  sessionId: string;
  entry: TEntry;
  /** Workspace-relative path, for the failure report. */
  path: string;
  /** Why main is discarding this session, for the failure report. */
  reason: string;
  onCloseFailed: (message: string, error: unknown) => void;
}

/** Returns true when the session was released and deregistered. */
export async function releaseEngineYDocSession<
  TEntry extends { session: ReleasableEngineYDocSession },
>(input: ReleaseEngineYDocSessionInput<TEntry>): Promise<boolean> {
  const { sessions, sessionId, entry } = input;
  try {
    await entry.session.close();
  } catch (error) {
    // Register it so a later teardown can retry — unless another session now
    // owns this id, in which case displacing it would strand the live one.
    if (!sessions.has(sessionId)) sessions.set(sessionId, entry);
    input.onCloseFailed(
      `[desktop] engine Y.Doc session close failed for ${input.path} ` +
        `(${input.reason}); the engine may still hold the document, so it ` +
        "stays read-only until a retry releases it.",
      error,
    );
    return false;
  }
  if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
  return true;
}
