// HOW MAIN FILES A LIVE ENGINE Y.DOC SESSION, and the one rule that keeps the
// registry honest: a registration NEVER replaces a different live session.
//
// The renderer mints the session id, so main cannot trust it to be unique. Two
// opens carrying the same id both pass the open handler's first look at the
// registry while neither has registered yet, and an unconditional `set` then
// buries the first session — live in the daemon, unreachable from main, while
// every later update and close for its document lands on the second entry. That
// is a second writer over a document the first session still holds.
//
// The key namespaces the id by the SENDER, which main owns, so two renderers
// can never collide. Inside one renderer the id is still the renderer's, so the
// claim below re-reads the slot after the open and refuses the newcomer — the
// same yield a failed close makes when the id it wants is taken
// (engineYDocSessionRelease.ts).

/** The registry key for one renderer-minted session id. */
export function engineYDocSessionKey(senderId: number, sessionId: string): string {
  return `${senderId}:${sessionId}`;
}

/** What the claim must read to report the collision it refuses. */
interface ClaimableEngineYDocEntry {
  /** The document this session holds, workspace-relative. */
  path: string;
}

export type EngineYDocSlotClaim =
  | { claimed: true }
  // `released` false means the refused session's close failed, so the engine
  // may still hold its document and the caller must not fall back to a
  // writable plain editor.
  | { claimed: false; released: boolean };

interface ClaimEngineYDocSessionSlotInput<TEntry extends ClaimableEngineYDocEntry> {
  sessions: Map<string, TEntry>;
  key: string;
  entry: TEntry;
  /** Release the refused session. False when the daemon may still hold it. */
  release: (reason: string) => Promise<boolean>;
  onRefused: (message: string) => void;
}

/** Registers the session, or refuses it when the slot is already live. */
export async function claimEngineYDocSessionSlot<
  TEntry extends ClaimableEngineYDocEntry,
>(input: ClaimEngineYDocSessionSlotInput<TEntry>): Promise<EngineYDocSlotClaim> {
  const { sessions, key, entry } = input;
  const live = sessions.get(key);
  if (!live) {
    sessions.set(key, entry);
    return { claimed: true };
  }
  input.onRefused(
    `[desktop] engine Y.Doc session slot ${key} is already live for ` +
      `${live.path}; refusing this open of ${entry.path} rather than ` +
      "replacing it. One session id may hold one document per renderer: " +
      "mint a fresh id for each open.",
  );
  return {
    claimed: false,
    released: await input.release("session id already live"),
  };
}
