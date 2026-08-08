// Main namespaces each renderer-minted session id by sender. The claim re-reads
// the slot after the open and refuses a newcomer rather than replacing a live
// session and stranding its daemon lease.

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
