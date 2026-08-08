// THE ONE STATEMENT OF WHAT A FAILED CLOSE MEANS. Every non-quit teardown of an
// engine Y.Doc session runs through this: a stale session under a reused id, a
// session whose renderer died mid-open, a lineage that came back the wrong
// content kind, the close IPC, the renderer sweep, and the retry a later open
// makes. Call sites say which branch they are; they do not restate this.
//
// A close that FAILS is not a teardown. The capture layer retains the session
// as `failing-close` and rethrows exactly because the reservation may still be
// held (workspaceEngineCapture.ts, `closeEntry`), and the daemon reinserts a
// refused close's entry with its lease held. So the document may still be the
// engine's, and a writable plain editor over it would be a second writer.
//
// The session therefore stays in the registry, MARKED, and the caller is told
// the release did not happen — which is how a surface knows to stay read-only
// and offer the retry that eventually discharges it.

interface ReleasableEngineYDocSession {
  close: () => Promise<void>;
}

/** What the registry must carry for a failed release to stay retriable. */
interface RetainableEngineYDocEntry {
  session: ReleasableEngineYDocSession;
  /** The document this session holds, workspace-relative. */
  path: string;
  /**
   * This session's close failed, so the engine may still hold its document.
   * Only a release clears it — by dropping the entry outright.
   */
  closeFailed?: boolean;
}

interface ReleaseEngineYDocSessionInput<TEntry extends RetainableEngineYDocEntry> {
  sessions: Map<string, TEntry>;
  /** The registry key this entry is filed under (engineYDocSessionRegistry.ts). */
  sessionKey: string;
  entry: TEntry;
  /** Why main is releasing this session, for the failure report. */
  reason: string;
  onCloseFailed: (message: string, error: unknown) => void;
}

/** Returns true when the session was released and deregistered. */
export async function releaseEngineYDocSession<
  TEntry extends RetainableEngineYDocEntry,
>(input: ReleaseEngineYDocSessionInput<TEntry>): Promise<boolean> {
  const { sessions, sessionKey, entry } = input;
  try {
    await entry.session.close();
  } catch (error) {
    // Mark it so the next open of this path retries THIS session instead of
    // binding a second writer over it, and register it so that retry (and every
    // later teardown) can reach it.
    entry.closeFailed = true;
    if (sessions.get(sessionKey) !== entry) {
      // Two opens can share a session id across the handler's awaits, and
      // displacing the live one would strand it. Dropping this one instead is
      // the unreachability this module exists to remove — no sweep, no close,
      // no retry could ever find the lease again — so it takes a derived key.
      // Nothing looks a session up by that key: everything that must reach it
      // walks the values (the renderer and quit sweeps) or scans by document
      // (the open's retry), while a keyed lookup still finds the live owner.
      let key = sessionKey;
      for (let n = 1; sessions.has(key); n += 1) key = `${sessionKey}#failed-${n}`;
      sessions.set(key, entry);
    }
    input.onCloseFailed(
      `[desktop] engine Y.Doc session close failed for ${entry.path} ` +
        `(${input.reason}); the engine may still hold the document, so it ` +
        "stays read-only until a retry releases it.",
      error,
    );
    return false;
  }
  if (sessions.get(sessionKey) === entry) sessions.delete(sessionKey);
  return true;
}
