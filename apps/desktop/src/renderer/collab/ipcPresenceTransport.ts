import type { PresenceResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { PresenceScope, PresenceSnapshot, PresenceTransport } from "./presenceChannel";

// MU-C5 — the IPC-PROXIED presence transport.
//
// SECURITY: the renderer NEVER holds the relay bearer token. This transport
// implements the same PresenceTransport contract as createRelayPresenceTransport
// but makes NO relay request itself — it calls the presence IPC handlers, and
// MAIN (the sole token holder) makes the actual relay presence call. The renderer
// only ever sees the resulting snapshot. Scope is authorized in main; a scope
// this account can't join comes back as { ok: false } → the channel degrades to
// dark, exactly like an unreachable relay.
//
// A poll long-polls over IPC (main holds the relay long-poll open). The poll's
// AbortSignal — fired by PresenceChannel.stop() on unmount / workspace switch —
// is wired to presenceCancel(pollId), so main aborts the exact in-flight relay
// fetch rather than leaking a request or repainting a switched-away workspace.

let pollCounter = 0;

function nextPollId(): string {
  pollCounter += 1;
  // Bounded (< 128 chars) + unique per poll, like the engine-doc session id.
  return `pp-${Date.now().toString(36)}-${pollCounter.toString(36)}`;
}

// The IPC result's peer `state` is optional (zod z.unknown()); PresenceSnapshot
// requires it. Normalize to the transport's shape (a missing state is null).
function toSnapshot(snapshot: Extract<PresenceResult, { ok: true }>["snapshot"]): PresenceSnapshot {
  return {
    version: snapshot.version,
    peers: snapshot.peers.map((peer) => ({
      userId: peer.userId,
      clientId: peer.clientId,
      state: peer.state ?? null,
      updatedAtMs: peer.updatedAtMs,
    })),
  };
}

export function createIpcPresenceTransport(scope: PresenceScope): PresenceTransport {
  return {
    async publish({ topic, clientId, state }): Promise<PresenceSnapshot> {
      const result = await bridge().presencePublish({ scope, topic, clientId, state });
      if (!result.ok) throw new Error(`presence publish ${result.reason}`);
      return toSnapshot(result.snapshot);
    },
    async leave({ topic, clientId }): Promise<void> {
      // Best-effort: a failed leave is fine — the relay entry expires on TTL.
      await bridge()
        .presencePublish({ scope, topic, clientId, leave: true })
        .catch(() => undefined);
    },
    async poll({ topic, since, signal }): Promise<PresenceSnapshot> {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const pollId = nextPollId();
      const onAbort = () => {
        // Tell main to abort the in-flight relay long-poll for THIS poll id.
        void bridge().presenceCancel({ pollId }).catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await bridge().presencePoll({ scope, topic, since, pollId });
        if (!result.ok) throw new Error(`presence poll ${result.reason}`);
        return toSnapshot(result.snapshot);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
