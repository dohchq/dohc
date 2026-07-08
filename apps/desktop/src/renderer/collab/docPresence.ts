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

  const onPeers = (peers: PresencePeer[]): void => {
    const present = new Set<number>();
    for (const peer of peers) {
      if (peer.clientId === options.clientId) continue;
      const state = peer.state as DocPresenceState | null;
      if (!state || typeof state.yc !== "number" || typeof state.update !== "string") continue;
      present.add(state.yc);
      try {
        applyAwarenessUpdate(awareness, fromBase64(state.update), "presence-remote");
      } catch {
        // A malformed peer update never breaks local editing.
      }
      remoteClients.add(state.yc);
    }
    // Prune peers that vanished from the snapshot.
    const departed = [...remoteClients].filter((id) => !present.has(id));
    if (departed.length > 0) {
      removeAwarenessStates(awareness, departed, "presence-remote");
      for (const id of departed) remoteClients.delete(id);
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
