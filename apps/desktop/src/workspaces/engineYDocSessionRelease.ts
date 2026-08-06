// Releasing an engine Y.Doc session main will not (or no longer will) hand to a
// renderer: a stale session under a reused id, a session whose renderer died
// mid-open, a lineage that came back the wrong content kind, the close IPC, and
// the renderer-teardown sweep.
//
// A close that FAILS is not a clean teardown. The capture layer retains the
// session as `failing-close` and rethrows exactly because the reservation may
// still be held (workspaceEngineCapture.ts, `closeEntry`), and the daemon
// reinserts a refused close's entry with its lease held. So the document may
// still be the engine's, and a writable plain editor over it would be a second
// writer.
//
// Main therefore keeps the session in its registry on failure, MARKED — that is
// what the close IPC, the renderer teardown, the next open of the same path,
// and the quit sweep walk — and tells the caller the release did not happen.

export interface ReleasableEngineYDocSession {
  close: () => Promise<void>;
}

/** What the registry must carry for a failed release to stay retriable. */
export interface RetainableEngineYDocEntry {
  session: ReleasableEngineYDocSession;
  /** The document this session holds, workspace-relative. */
  path: string;
  /**
   * This session's close failed, so the engine may still hold its document.
   * Only a release clears it — by dropping the entry outright.
   */
  closeFailed?: boolean;
}

export interface ReleaseEngineYDocSessionInput<
  TEntry extends RetainableEngineYDocEntry,
> {
  sessions: Map<string, TEntry>;
  sessionId: string;
  entry: TEntry;
  /** Why main is releasing this session, for the failure report. */
  reason: string;
  onCloseFailed: (message: string, error: unknown) => void;
}

/** Returns true when the session was released and deregistered. */
export async function releaseEngineYDocSession<
  TEntry extends RetainableEngineYDocEntry,
>(input: ReleaseEngineYDocSessionInput<TEntry>): Promise<boolean> {
  const { sessions, sessionId, entry } = input;
  try {
    await entry.session.close();
  } catch (error) {
    // Mark it so the next open of this path retries THIS session instead of
    // binding a second writer over it, and register it so that retry (and every
    // later teardown) can reach it — unless another session now owns this id,
    // in which case displacing it would strand the live one.
    entry.closeFailed = true;
    if (!sessions.has(sessionId)) sessions.set(sessionId, entry);
    input.onCloseFailed(
      `[desktop] engine Y.Doc session close failed for ${entry.path} ` +
        `(${input.reason}); the engine may still hold the document, so it ` +
        "stays read-only until a retry releases it.",
      error,
    );
    return false;
  }
  if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
  return true;
}
