import { bytesToBase64, base64ToBytes } from "../base64";
import type * as Y from "yjs";

import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
  modifyAwarenessUpdate,
} from "y-protocols/awareness";
import {
  createPresenceChannel,
  type PresenceChannel,
  type PresencePeer,
  type PresenceTransport,
  resolvePeerDisplayName,
} from "./presenceChannel";

import { presentationColor, relayPresentation } from "../workbench/actorPresentation";

type AwarenessChanges = {
  added: number[];
  updated: number[];
  removed: number[];
};

class SnapshotAwareness extends Awareness {
  private pending: AwarenessChanges | null = null;

  override emit(...args: Parameters<Awareness["emit"]>): void {
    if (this.pending && args[0] === "change" && args[1][1] === "presence-remote") {
      const changes = args[1][0] as AwarenessChanges;
      this.pending.added.push(...changes.added);
      this.pending.updated.push(...changes.updated);
      this.pending.removed.push(...changes.removed);
      return;
    }
    super.emit(...args);
  }

  batchRemoteChanges(apply: () => void): void {
    this.pending = { added: [], updated: [], removed: [] };
    try {
      apply();
    } finally {
      const changes = this.pending;
      this.pending = null;
      const added = new Set(changes.added);
      const removed = new Set(changes.removed);
      const updated = [...new Set(changes.updated)].filter(
        (id) => !added.has(id) && !removed.has(id),
      );
      if (added.size || updated.length || removed.size) {
        this.emit("change", [
          { added: [...added], updated, removed: [...removed] },
          "presence-remote",
        ]);
      }
    }
  }
}

// MU-C1 — DOC co-presence: bind a Yjs Awareness to the engine mirror doc and
// bridge it over the same ephemeral relay transport as chat presence, keyed by
// the doc's path/objectId rather than a channel. This is the design's handoff:
// "the provider exposes the live session.doc; presence binds Yjs awareness to
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
// clientID (`yc`), so the receiver can apply the update and reconcile removals
// (drop the awareness state of a peer that is no longer in the snapshot).
interface DocPresenceState {
  yc: number;
  update: string; // base64 of encodeAwarenessUpdate for this client
}

export interface DocPresenceBinding {
  // The Awareness bound to the doc (for a future caret extension).
  readonly awareness: Awareness;
  // Resolves once the channel's leave reached the transport, so a rebinding
  // with the same topic and client id can wait it out instead of racing it.
  destroy(): Promise<void>;
}

interface DocPresenceOptions {
  doc: Y.Doc;
  transport: PresenceTransport;
  topic: string;
  clientId: string;
  user: DocPresenceUser;
  // Called with the display names of other editors whenever the set changes.
  onPeers: (names: string[]) => void;
}

// y-protocols' applyAwarenessUpdate trusts whatever clientIDs are embedded in
// the update — it does not validate ownership, so a hostile co-editor could
// craft an update that overwrites another peer's awareness entry (or ours).
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
  const awareness = new SnapshotAwareness(options.doc);
  awareness.setLocalStateField("user", options.user);

  // Encode only cursor/drawing fields. Local presentation stays on this device.
  const encodedLocalState = (): string => {
    const full = awareness.getLocalState();
    const clean = Object.fromEntries(
      Object.entries(full ?? {}).filter(([key]) =>
        ["cursor", "pointer", "button", "selectedElementIds"].includes(key),
      ),
    );
    return bytesToBase64(
      encodeAwarenessUpdate(
        awareness,
        [awareness.clientID],
        new Map([[awareness.clientID, clean]]),
      ),
    );
  };
  const localState = (): DocPresenceState => ({
    yc: awareness.clientID,
    update: encodedLocalState(),
  });

  // Yjs clientIDs of remote peers we've applied, so we can prune the ones that
  // leave (their presence entry disappears from the snapshot).
  const remoteClients = new Set<number>();
  // Bind each Yjs clientID to the relay-issued session token that first
  // claimed it. Awareness itself never
  // validates clientID ownership, so without this one authenticated peer
  // could publish updates that spoof/overwrite another peer's slot.
  const ycOwners = new Map<number, string>();

  const onPeers = (peers: PresencePeer[]): void => {
    awareness.batchRemoteChanges(() => {
      const present = new Set<number>();
      for (const peer of peers) {
        if (peer.isSelf) continue;
        const state = peer.state as DocPresenceState | null;
        if (!state || typeof state.yc !== "number" || typeof state.update !== "string") continue;
        // No remote peer may ever claim our Yjs clientID: applying such an
        // update would overwrite (or clock-poison) the local awareness entry.
        if (state.yc === awareness.clientID) continue;
        // First authenticated claimant wins the slot; a different peer relaying
        // updates for someone else's clientID is dropped.
        const ownerKey = peer.sessionToken;
        const owner = ycOwners.get(state.yc);
        if (owner !== undefined && owner !== ownerKey) continue;
        try {
          const update = base64ToBytes(state.update);
          // The update must touch exactly the claimed slot — an update smuggling
          // extra clientIDs (another peer's, or ours) is rejected wholesale.
          const embedded = awarenessUpdateClientIds(update);
          if (!embedded || embedded.some((id) => id !== state.yc)) continue;
          const user = {
            name: resolvePeerDisplayName(peer),
            color: presentationColor(relayPresentation(peer.paletteSlot, peer.isSelf)).stroke,
            paletteSlot: peer.paletteSlot,
            sessionToken: peer.sessionToken,
          };
          applyAwarenessUpdate(
            awareness,
            modifyAwarenessUpdate(update, (state) => (state === null ? null : { ...state, user })),
            "presence-remote",
          );
          // Same-clock heartbeats are ignored by Yjs, but relay presentation can still change.
          const remote = awareness.getStates().get(state.yc);
          if (
            remote &&
            (remote.user?.name !== user.name ||
              remote.user?.color !== user.color ||
              remote.user?.paletteSlot !== user.paletteSlot ||
              remote.user?.sessionToken !== user.sessionToken)
          ) {
            remote.user = user;
            awareness.emit("change", [
              { added: [], updated: [state.yc], removed: [] },
              "presence-remote",
            ]);
          }
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
    });
    // Faces include every admitted peer, even when their grant has no caret authority.
    const faces = new Map<string, string>();
    for (const peer of peers) {
      if (!peer.isSelf) faces.set(peer.faceToken, resolvePeerDisplayName(peer));
    }
    options.onPeers([...faces.values()]);
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
  const onLocalChange = (_changes: unknown, origin: unknown): void => {
    if (origin === "presence-remote") return; // don't echo applied remote state
    channel?.setState(localState());
  };
  awareness.on("update", onLocalChange);

  return {
    awareness,
    destroy() {
      awareness.off("update", onLocalChange);
      const stopped = channel?.stop() ?? Promise.resolve();
      channel = null;
      // Clear the local awareness entry (peers prune us on their next poll).
      removeAwarenessStates(awareness, [awareness.clientID], "presence-local");
      awareness.destroy();
      return stopped.catch(() => undefined);
    },
  };
}
