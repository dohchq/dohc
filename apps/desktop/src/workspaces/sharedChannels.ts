import {
  ShareUnavailableError,
  SharedChannelReadOnlyError,
  pullSharedChannel,
  pushSharedChannel,
  type SyncRelayConnection,
} from "@dohc/workspace-engine";
import type { JoinedSharedChannel } from "./registryStore";

// MU-C4 shared channels — the desktop's refresh pass over every shared
// channel a workspace has JOINED: push the member's locally-authored channel
// ops through the share's member-append route, then pull everyone else's.
// Best-effort by design: one failing share never blocks the others (or the
// workspace's own sync pass), and a revoked share is reported as ENDED so the
// caller can mark it in the registry — the local copy stays readable, it just
// stops updating (PR-18's honest end-of-share).

// Per-key async serializer (CodeRabbit Stability): shared-channel sync fires
// from the relay cadence, several fire-and-forget IPC sends, AND an awaited
// listChatChannels — all for the same workspace. Overlapping passes race the
// per-share cursor/peer updates in engine.db. Calls for the same key QUEUE
// (never coalesce: a send journaled after a pass started still gets its own
// pass), different keys stay concurrent, and a rejected run never wedges the
// queue.
export function createKeyedSerializer(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return (key, run) => {
    const tail = tails.get(key) ?? Promise.resolve();
    const result = tail.then(run);
    // The stored tail always settles resolved so a rejection (surfaced to THIS
    // caller via `result`) cannot poison later runs.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return result;
  };
}

// Bounds every relay request in a shared-channel pass (CodeRabbit Stability):
// listChatChannels AWAITS the pass, so a hung relay socket must abort after
// the timeout instead of blocking the Chats surface indefinitely. Errors ride
// the pass's normal transient-failure path (logged, retried next pass).
export function relayFetchWithTimeout(
  timeoutMs: number,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (input, init) =>
    baseFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
}

// Registry merge for the join flow (CodeRabbit Data Integrity): a re-join of
// the SAME channel under a NEW share id (revoked + re-granted) must replace
// the stale row, not sit beside it — matching on shareId alone left the
// channel listed and synced twice.
export function mergeJoinedChannel(
  existing: readonly JoinedSharedChannel[],
  joined: JoinedSharedChannel,
): JoinedSharedChannel[] {
  return [
    ...existing.filter(
      (channel) =>
        channel.shareId !== joined.shareId && channel.channelWireId !== joined.channelWireId,
    ),
    joined,
  ];
}

export interface SyncJoinedSharedChannelsResult {
  // Shares whose relay view closed (revoked / gone): mark ended, stop syncing.
  endedShareIds: string[];
  // Shares whose ACCESS turned out read-only on push (flipped or always was):
  // their local ops stay local; pull still ran.
  readOnlyShareIds: string[];
  // True when any pull applied new ops — the caller should refresh the UI.
  changed: boolean;
}

export async function syncJoinedSharedChannels(input: {
  rootDir: string;
  workspaceId: string;
  relay: SyncRelayConnection;
  channels: readonly JoinedSharedChannel[];
  // Injection seams for tests; default to the real engine client.
  pull?: typeof pullSharedChannel;
  push?: typeof pushSharedChannel;
}): Promise<SyncJoinedSharedChannelsResult> {
  const pull = input.pull ?? pullSharedChannel;
  const push = input.push ?? pushSharedChannel;
  const endedShareIds: string[] = [];
  const readOnlyShareIds: string[] = [];
  let changed = false;
  for (const channel of input.channels) {
    if (channel.ended) continue;
    const target = {
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      relay: input.relay,
      shareId: channel.shareId,
      channelWireId: channel.channelWireId,
    };
    try {
      if (channel.access === "read-write") {
        try {
          await push(target);
        } catch (error) {
          // The grant's access can be read-only even when we recorded
          // read-write (a stale registry row): reads keep flowing, appends
          // stay local, and the caller may surface the downgrade.
          if (!(error instanceof SharedChannelReadOnlyError)) throw error;
          readOnlyShareIds.push(channel.shareId);
        }
      }
      const pulled = await pull(target);
      if (pulled.applied > 0) changed = true;
    } catch (error) {
      if (error instanceof ShareUnavailableError) {
        endedShareIds.push(channel.shareId);
        continue;
      }
      // Transient failures (offline, relay hiccup) are logged and retried on
      // the next pass; they must not fail the workspace's own sync.
      console.error(
        `[desktop] shared channel sync failed (share ${channel.shareId}):`,
        error,
      );
    }
  }
  return { endedShareIds, readOnlyShareIds, changed };
}
