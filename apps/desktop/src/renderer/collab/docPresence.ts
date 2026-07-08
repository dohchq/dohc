import type * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  createPresenceChannel,
  type PresenceChannel,
  type PresencePeer,
  type PresenceTransport,
} from "./presenceChannel";

// MU-C1 — DOC co-presence: bind a Yjs Awareness to the engine mirror doc and
// bridge it over the SAME ephemeral relay transport as chat presence, keyed by
// the doc's path/objectId rather than a channel. This is the design's handoff:
// "the provider exposes the live session.doc; presence binds Yjs AWARENESS to
// it as the ephemeral channel." The Awareness lives on the doc so a future
// CollaborationCaret can render remote cursors; today we surface the calm
// "who's editing" set (names + count) for the editor's presence line.
//
// The awareness state is never journaled — it rides the ephemeral transport
// and drops on disconnect/TTL, exactly like chat presence.

export interface DocPresenceUser {
  name: string;
  color: string;
}

// Each publish carries the encoded Yjs awareness update plus the numeric Yjs
// clientID (`yc`), so the receiver can apply the update AND reconcile removals
// (drop the awareness state of a peer that is no longer in the snapshot).
interface DocPresenceState {
  user: DocPresenceUser;
  yc: number;
  update: string; // base64 of encodeAwarenessUpdate for this client
}

export interface DocPresenceBinding {
  // The Awareness bound to the doc (for a future caret extension).
  readonly awareness: Awareness;
  destroy(): void;
}

export interface DocPresenceOptions {
  doc: Y.Doc;
  transport: PresenceTransport;
  topic: string;
  clientId: string;
  user: DocPresenceUser;
  // Called with the display names of OTHER editors whenever the set changes.
  onPeers: (names: string[]) => void;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

// y-protocols' applyAwarenessUpdate trusts whatever clientIDs are embedded in
// the update — it does NOT validate ownership, so a hostile co-editor could
// craft an update that overwrites ANOTHER peer's awareness entry (or ours).
// Walk the update's wire format (varUint count, then per entry: varUint
// clientID, varUint clock, varString state) and return the embedded clientIDs
// so the caller can reject updates that touch any slot but the claimed one.
// Returns null for anything malformed or suspiciously large.
function awarenessUpdateClientIds(update: Uint8Array): number[] | null {
  let pos = 0;
  const readVarUint = (): number => {
    let value = 0;
    let multiplier = 1;
    for (;;) {
      if (pos >= update.length) throw new Error("truncated awareness update");
      const byte = update[pos]!;
      pos += 1;
      value += (byte & 0x7f) * multiplier;
      if (byte < 0x80) return value;
      multiplier *= 0x80;
    }
  };
  try {
    const count = readVarUint();
    // A presence publish carries exactly one client's state; anything bulk is
    // not ours to apply.
    if (count > 8) return null;
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(readVarUint());
      readVarUint(); // clock
      const stateLength = readVarUint();
      pos += stateLength;
      if (pos > update.length) throw new Error("truncated awareness update");
    }
    return ids;
  } catch {
    return null;
  }
}

// Bind doc co-presence. Returns the Awareness (for carets) and a destroy hook.
export function bindDocPresence(options: DocPresenceOptions): DocPresenceBinding {
  const awareness = new Awareness(options.doc);
  awareness.setLocalStateField("user", options.user);

  const localState = (): DocPresenceState => ({
    user: options.user,
    yc: awareness.clientID,
    update: toBase64(encodeAwarenessUpdate(awareness, [awareness.clientID])),
  });

  // Yjs clientIDs of remote peers we've applied, so we can prune the ones that
  // leave (their presence entry disappears from the snapshot).
  const remoteClients = new Set<number>();
  // Bind each Yjs clientID to the server-authenticated presence entry
  // (userId + clientId) that first claimed it. Awareness itself never
  // validates clientID ownership, so without this one authenticated peer
  // could publish updates that spoof/overwrite another peer's slot.
  const ycOwners = new Map<number, string>();

  const onPeers = (peers: PresencePeer[]): void => {
    const present = new Set<number>();
    for (const peer of peers) {
      if (peer.clientId === options.clientId) continue;
      const state = peer.state as DocPresenceState | null;
      if (!state || typeof state.yc !== "number" || typeof state.update !== "string") continue;
      // No remote peer may ever claim OUR Yjs clientID: applying such an
      // update would overwrite (or clock-poison) the local awareness entry.
      if (state.yc === awareness.clientID) continue;
      // First authenticated claimant wins the slot; a different peer relaying
      // updates for someone else's clientID is dropped.
      const ownerKey = `${peer.userId}\u0000${peer.clientId}`;
      const owner = ycOwners.get(state.yc);
      if (owner !== undefined && owner !== ownerKey) continue;
      try {
        const update = fromBase64(state.update);
        // The update must touch exactly the claimed slot — an update smuggling
        // extra clientIDs (another peer's, or ours) is rejected wholesale.
        const embedded = awarenessUpdateClientIds(update);
        if (!embedded || embedded.some((id) => id !== state.yc)) continue;
        applyAwarenessUpdate(awareness, update, "presence-remote");
      } catch {
        // A malformed peer update never breaks local editing.
        continue;
      }
      ycOwners.set(state.yc, ownerKey);
      present.add(state.yc);
      remoteClients.add(state.yc);
    }
    // Prune peers that vanished from the snapshot (and free their slot claim).
    const departed = [...remoteClients].filter((id) => !present.has(id));
    if (departed.length > 0) {
      removeAwarenessStates(awareness, departed, "presence-remote");
      for (const id of departed) {
        remoteClients.delete(id);
        ycOwners.delete(id);
      }
    }
    // Report other editors' names (unique).
    const names = new Set<string>();
    for (const [clientId, remoteState] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      // Remote awareness state is attacker/bug-controllable network payload;
      // only a real string may enter the `string[]` contract of onPeers.
      const user = (remoteState as { user?: Partial<DocPresenceUser> }).user;
      if (typeof user?.name === "string" && user.name.trim()) names.add(user.name);
    }
    options.onPeers([...names]);
  };

  let channel: PresenceChannel | null = createPresenceChannel({
    transport: options.transport,
    topic: options.topic,
    clientId: options.clientId,
    initialState: localState(),
    onPeers,
  });

  // Re-publish when the local awareness state changes (cursor move, etc.), so
  // peers track this client's caret without waiting for the heartbeat.
  const onLocalChange = (
    _changes: unknown,
    origin: unknown,
  ): void => {
    if (origin === "presence-remote") return; // don't echo applied remote state
    channel?.setState(localState());
  };
  awareness.on("update", onLocalChange);

  return {
    awareness,
    destroy() {
      awareness.off("update", onLocalChange);
      void channel?.stop();
      channel = null;
      // Clear the local awareness entry (peers prune us on their next poll).
      removeAwarenessStates(awareness, [awareness.clientID], "presence-local");
      awareness.destroy();
    },
  };
}
