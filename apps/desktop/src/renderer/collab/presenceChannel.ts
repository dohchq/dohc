// MU-C1 — the CLIENT half of the ephemeral awareness transport.
//
// A PresenceChannel drives one (scope, topic): it heartbeats the local state
// so the relay keeps this client "present", long-polls for peer changes, and
// clears itself on stop (best-effort leave + TTL backstop). It is
// transport-agnostic — the relay transport is one implementation; tests inject
// a fake. Nothing here is durable; if the relay is unreachable the channel
// degrades silently (presence goes dark, chat/editing keep working — the
// design's "awareness-channel-down still allows chat/edit" contract).
//
// GATING: a channel is only ever CONSTRUCTED under collaboration
// (signedIn && relayConnected). A solo/offline surface passes a null transport
// and builds none of this — mirroring how the engine co-editing doc stays
// dormant for solo.

export interface PresencePeer {
  // Server-derived attribution (the relay echoes the authenticated actor).
  userId: string;
  clientId: string;
  // Opaque display payload the publisher sent, e.g. { displayName, typing }.
  state: unknown;
  updatedAtMs: number;
}

export interface PresenceSnapshot {
  version: number;
  peers: PresencePeer[];
}

// The wire abstraction. publish/leave/poll map 1:1 to the relay routes but are
// swappable for tests.
export interface PresenceTransport {
  publish(input: { topic: string; clientId: string; state: unknown }): Promise<PresenceSnapshot>;
  leave(input: { topic: string; clientId: string }): Promise<void>;
  poll(input: { topic: string; since: number; signal: AbortSignal }): Promise<PresenceSnapshot>;
}

export type PresenceScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "share"; shareId: string };

export interface RelayPresenceConfig {
  baseUrl: string;
  token: string;
  scope: PresenceScope;
  fetch?: typeof fetch;
}

function presenceUrl(config: RelayPresenceConfig, topic: string, query: Record<string, string>): string {
  const base =
    config.scope.kind === "workspace"
      ? `${config.baseUrl}/sync/${encodeURIComponent(config.scope.workspaceId)}/presence`
      : `${config.baseUrl}/sync/shares/${encodeURIComponent(config.scope.shareId)}/presence`;
  const params = new URLSearchParams({ topic, ...query });
  return `${base}?${params.toString()}`;
}

function parseSnapshot(value: unknown): PresenceSnapshot {
  const record = (value ?? {}) as Record<string, unknown>;
  const peers = Array.isArray(record.peers) ? (record.peers as PresencePeer[]) : [];
  const version = typeof record.version === "number" ? record.version : 0;
  return { version, peers };
}

// Build a relay-backed transport. The bearer token authenticates the actor;
// the relay derives identity from it (never from the body), so this client
// cannot claim another user's presence.
export function createRelayPresenceTransport(config: RelayPresenceConfig): PresenceTransport {
  const doFetch = config.fetch ?? fetch;
  const authHeaders = { authorization: `Bearer ${config.token}` };
  return {
    async publish({ topic, clientId, state }) {
      const response = await doFetch(presenceUrl(config, topic, {}), {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ clientId, state }),
      });
      if (!response.ok) throw new Error(`presence publish failed: ${response.status}`);
      return parseSnapshot(await response.json());
    },
    async leave({ topic, clientId }) {
      // Best-effort: a failed leave is fine — the entry expires on TTL anyway.
      await doFetch(presenceUrl(config, topic, {}), {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ clientId, leave: true }),
      }).catch(() => undefined);
    },
    async poll({ topic, since, signal }) {
      const response = await doFetch(presenceUrl(config, topic, { since: String(since) }), {
        method: "GET",
        headers: authHeaders,
        signal,
      });
      if (!response.ok) throw new Error(`presence poll failed: ${response.status}`);
      return parseSnapshot(await response.json());
    },
  };
}

export interface PresenceChannelOptions {
  transport: PresenceTransport;
  topic: string;
  clientId: string;
  initialState: unknown;
  // Called with the FULL peer set (including this client, echoed by the relay)
  // whenever it changes. Never called after stop().
  onPeers: (peers: PresencePeer[]) => void;
  // Re-publish this often so the relay TTL never lapses. Must be < the relay
  // entry TTL (default 30s). Default 10s.
  heartbeatMs?: number;
  // Delay before retrying a failed poll/publish (presence degrades gracefully,
  // never crashes). Default 3s.
  retryMs?: number;
}

export interface PresenceChannel {
  // Update the local state and publish it immediately (e.g. typing on/off).
  setState(state: unknown): void;
  // Stop heartbeating + polling, abort any in-flight poll, and best-effort
  // leave. Idempotent. After this, onPeers never fires again. Resolves once
  // the internal poll loop has fully exited (including a pending retry
  // sleep), so teardown is deterministic and nothing dangles.
  stop(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_RETRY_MS = 3_000;

// Start a live presence channel. The first publish happens immediately so the
// user appears "here" at once; the poll loop then tracks peers.
export function createPresenceChannel(options: PresenceChannelOptions): PresenceChannel {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  let state = options.initialState;
  let stopped = false;
  let version = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Resolver for the retry sleep, so stop() can release a loop that is
  // waiting out a relay outage instead of leaving it suspended forever.
  let retryResolve: (() => void) | null = null;
  let pollController: AbortController | null = null;
  let loopDone: Promise<void> | null = null;

  function emit(snapshot: PresenceSnapshot): void {
    if (stopped) return;
    version = snapshot.version;
    options.onPeers(snapshot.peers);
  }

  async function publishNow(): Promise<void> {
    if (stopped) return;
    try {
      const snapshot = await options.transport.publish({
        topic: options.topic,
        clientId: options.clientId,
        state,
      });
      emit(snapshot);
    } catch {
      // Presence is best-effort; a failed publish just means we appear later.
    }
  }

  function scheduleHeartbeat(): void {
    if (stopped) return;
    heartbeatTimer = setTimeout(() => {
      void publishNow().finally(scheduleHeartbeat);
    }, heartbeatMs);
  }

  async function pollLoop(): Promise<void> {
    while (!stopped) {
      pollController = new AbortController();
      try {
        const snapshot = await options.transport.poll({
          topic: options.topic,
          since: version,
          signal: pollController.signal,
        });
        emit(snapshot);
      } catch {
        if (stopped) return;
        // Relay unreachable / poll aborted mid-switch: back off, then retry.
        // Presence degrades to dark; it never throws into the UI. The sleep
        // is resolvable by stop() so the loop always exits promptly.
        await new Promise<void>((resolve) => {
          retryResolve = resolve;
          retryTimer = setTimeout(resolve, retryMs);
        });
        retryTimer = null;
        retryResolve = null;
      }
    }
  }

  // Kick off: immediate publish, then heartbeat + poll loop.
  void publishNow().then(() => {
    if (stopped) return;
    scheduleHeartbeat();
    loopDone = pollLoop();
  });

  return {
    setState(next) {
      state = next;
      void publishNow();
    },
    stop() {
      if (!stopped) {
        stopped = true;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (retryTimer) clearTimeout(retryTimer);
        // Release a pending retry sleep so the loop observes `stopped` and
        // returns; clearing the timer alone would strand it forever.
        retryResolve?.();
        pollController?.abort();
        // Best-effort explicit leave so peers see the departure before the
        // TTL. Guarded: this channel accepts any transport, and a rejecting
        // leave must never surface as an unhandled rejection.
        try {
          void Promise.resolve(
            options.transport.leave({ topic: options.topic, clientId: options.clientId }),
          ).catch(() => undefined);
        } catch {
          // Sync-throwing transports get the same best-effort treatment.
        }
      }
      return loopDone ?? Promise.resolve();
    },
  };
}
