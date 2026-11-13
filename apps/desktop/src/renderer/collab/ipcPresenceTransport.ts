import type {
  PresenceResult,
  PresenceScopeInput,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { PresenceSnapshot, PresenceTransport } from "./presenceChannel";

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
      faceToken: peer.faceToken,
      sessionToken: peer.sessionToken,
      isSelf: peer.isSelf,
      displayName: peer.displayName,
      paletteSlot: peer.paletteSlot,
      state: peer.state ?? null,
      updatedAtMs: peer.updatedAtMs,
    })),
  };
}

export function createIpcPresenceTransport(
  scope: PresenceScopeInput,
): PresenceTransport {
  return {
    async publish({ topic, clientId, incarnationId, state }): Promise<PresenceSnapshot> {
      const result = await bridge().presencePublish({
        scope,
        topic,
        clientId,
        incarnationId,
        state,
      });
      if (!result.ok) throw new Error(`presence publish ${result.reason}`);
      return toSnapshot(result.snapshot);
    },
    async leave({ topic, clientId, incarnationId }): Promise<void> {
      // Best-effort: a failed leave is fine — the relay entry expires on TTL.
      await bridge()
        .presencePublish({
          scope,
          topic,
          clientId,
          incarnationId,
          leave: true,
        })
        .catch(() => undefined);
    },
    async poll({ topic, clientId, since, signal }): Promise<PresenceSnapshot> {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const pollId = nextPollId();
      const onAbort = () => {
        // Tell main to abort the in-flight relay long-poll for this poll id.
        void bridge().presenceCancel({ pollId }).catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await bridge().presencePoll({ scope, topic, clientId, since, pollId });
        if (!result.ok) throw new Error(`presence poll ${result.reason}`);
        return toSnapshot(result.snapshot);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
