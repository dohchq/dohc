import { useEffect, useMemo, useRef, useState } from "react";
import {
  createPresenceChannel,
  resolvePeerDisplayName,
  type PresenceChannel,
  type PresencePeer,
  type PresenceTransport,
} from "./presenceChannel";

// MU-C1 — the React binding for channel/doc presence + typing.
//
// It is DORMANT for solo/offline: with `enabled === false` (or no transport)
// it constructs no channel, opens no poll, and returns an empty presence — the
// same "build nothing for solo" posture as the engine co-editing hook.
//
// No-stale-repaint guard (product invariant): every channel carries a
// monotonic token. A slow poll for workspace/topic A can never repaint after
// the user switches to B — the stale snapshot is dropped because its token no
// longer matches the live one.

export interface PresenceLocalState {
  displayName: string;
  typing: boolean;
}

export interface UsePresenceInput {
  // collaborationEnabled (signedIn && relayConnected) AND a resolvable scope.
  enabled: boolean;
  // The relay-backed (or test) transport, or null when collaboration is off.
  transport: PresenceTransport | null;
  // The presence scope key within the transport's workspace/share: a channel
  // wire id, DM id, or doc path.
  topic: string;
  // Stable per-tab/device id so this client's own entry is identifiable.
  clientId: string;
  // How this user is shown to peers.
  displayName: string;
  // Auto-clear typing after this idle window even if the caller forgets to
  // clear it. Default 5s.
  typingIdleMs?: number;
}

export interface PresenceResult {
  // Peers OTHER than this client (self is filtered out by clientId).
  others: PresencePeer[];
  // Display names of others currently typing.
  typingNames: string[];
  // Report local typing state; publishes immediately and self-clears on idle.
  setTyping: (typing: boolean) => void;
  // Imperative early stop, for an action that will make this scope reject
  // presence calls once it completes (#742 P2-E: leaving a DM ends its share,
  // and an ended-scope transport rejects the leave the effect cleanup would
  // otherwise send later — the peer would then read as present until the
  // relay's TTL). Await this BEFORE that action. A no-op if presence was
  // never active (channelRef is null) or already stopped.
  leave: () => Promise<void>;
  // Re-arms presence with a fresh channel (#742 P2, round 3): call this if
  // the action `leave()` was preparing for did NOT go through — leave()
  // already stopped the old channel, so without this the client stays
  // invisible to peers until it navigates elsewhere and back. A no-op if the
  // scope is not currently active (nothing to re-arm).
  restart: () => void;
}

function peerState(peer: PresencePeer): Partial<PresenceLocalState> {
  return (peer.state ?? {}) as Partial<PresenceLocalState>;
}

const EMPTY_PEERS: PresencePeer[] = [];

export function usePresence(input: UsePresenceInput): PresenceResult {
  const { enabled, transport, topic, clientId, displayName } = input;
  const typingIdleMs = input.typingIdleMs ?? 5_000;
  const [peers, setPeers] = useState<PresencePeer[]>(EMPTY_PEERS);
  // Bumped by restart() to force the channel effect below to tear down (a
  // no-op — it is already stopped) and stand up a FRESH channel (#742 P2,
  // round 3), without needing any of the scope inputs to actually change.
  const [restartGeneration, setRestartGeneration] = useState(0);
  // Monotonic per-channel token; only the newest channel may repaint.
  const tokenRef = useRef(0);
  const channelRef = useRef<PresenceChannel | null>(null);
  const typingRef = useRef(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = enabled && transport !== null;

  useEffect(() => {
    if (!active || !transport) {
      // Solo/offline: build nothing, show nothing.
      setPeers(EMPTY_PEERS);
      return;
    }
    const token = ++tokenRef.current;
    let cancelled = false;
    typingRef.current = false;

    const channel = createPresenceChannel({
      transport,
      topic,
      clientId,
      initialState: { displayName, typing: false } satisfies PresenceLocalState,
      onPeers: (next) => {
        // Drop a stale response: a newer channel (topic/workspace switch)
        // superseded this one, or the effect already cleaned up.
        if (cancelled || token !== tokenRef.current) return;
        setPeers(next);
      },
    });
    channelRef.current = channel;

    return () => {
      cancelled = true;
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      void channel.stop();
      if (channelRef.current === channel) channelRef.current = null;
      setPeers(EMPTY_PEERS);
    };
  }, [active, transport, topic, clientId, displayName, restartGeneration]);

  const others = useMemo(
    () => peers.filter((peer) => peer.clientId !== clientId),
    [peers, clientId],
  );
  const typingNames = useMemo(
    () =>
      others
        .filter((peer) => peerState(peer).typing === true)
        // Peer state is network payload; the shared guard admits only a real
        // string into the `string[]` contract (same as PresenceIndicators).
        .map(resolvePeerDisplayName),
    [others],
  );

  const setTyping = useMemo(() => {
    return (typing: boolean) => {
      const channel = channelRef.current;
      if (!channel) return;
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      // Publish only on the false<->true EDGE: a keystroke while already
      // typing refreshes the idle timer below but must not republish the same
      // state on every character (the heartbeat re-sends it anyway).
      const changed = typing !== typingRef.current;
      typingRef.current = typing;
      if (changed) channel.setState({ displayName, typing } satisfies PresenceLocalState);
      if (typing) {
        // Self-clearing: a forgotten typing state clears on idle.
        typingTimerRef.current = setTimeout(() => {
          typingRef.current = false;
          channelRef.current?.setState({ displayName, typing: false } satisfies PresenceLocalState);
        }, typingIdleMs);
      }
    };
  }, [displayName, typingIdleMs]);

  const leave = useMemo(
    () => () => channelRef.current?.stop() ?? Promise.resolve(),
    [],
  );

  const restart = useMemo(
    () => () => setRestartGeneration((generation) => generation + 1),
    [],
  );

  return { others, typingNames, setTyping, leave, restart };
}
