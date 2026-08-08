import {
  ShareUnavailableError,
  SharedChannelReadOnlyError,
  type PullSharedChannelResult,
  type PushSharedChannelResult,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import type { JoinedChannelAnswer } from "../ipc/bridgeContract";
import type { JoinedSharedChannel } from "./registryStore";

// MU-C4 shared channels — the desktop's refresh pass over a bounded window of
// the shared channels a workspace has JOINED: push the member's locally-authored
// channel ops through the share's member-append route, then pull everyone else's.
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

// The joined lane, answered for the channels a caller is SHOWING (#640).
//
// The registry array holds one row per channel this workspace ever joined,
// including a tombstone per channel it has left. Returning all of it made the
// IPC response grow with history, and that growth was the only thing a join
// refusal ever bounded. So the read is scoped instead: name the channels, get
// one answer each. Nothing about the size of the array reaches the caller.
//
// Tombstones therefore stay. An ended row is the write gate —
// assertSharedChannelWritable reads it to keep a revoked channel's local copy
// read-only, and the sharing surface reads it to keep the invitation on offer
// so Leave has a reverse path. Reaping one would re-open writes into a channel
// whose share is gone.
//
// A named channel with no row answers null, which is "this workspace holds no
// grant for it". That is a different fact from a channel the caller did not
// name, which stays absent and reads as unknown.
export function scopeJoinedChannels(
  rows: readonly JoinedSharedChannel[],
  channelWireIds: readonly string[],
): JoinedChannelAnswer[] {
  const wanted = new Set(channelWireIds);
  const byWire = new Map<string, JoinedSharedChannel>();
  for (const channel of rows) {
    // Last write wins, matching how the renderer resolves a wire id to the
    // one canonical grant row.
    if (wanted.has(channel.channelWireId)) byWire.set(channel.channelWireId, channel);
  }
  return [...wanted].map((channelWireId) => {
    const channel = byWire.get(channelWireId);
    return {
      channelWireId,
      joined: channel
        ? {
            shareId: channel.shareId,
            channelWireId: channel.channelWireId,
            access: channel.access,
            granterEmail: channel.granterEmail,
            ended: channel.ended === true,
          }
        : null,
    };
  });
}

// Registry merge for the join flow (CodeRabbit Data Integrity): a re-join of
// the SAME channel under a NEW share id (revoked + re-granted) must replace
// the stale row, not sit beside it — matching on shareId alone left the
// channel listed and synced twice.
//
// It refuses nothing. The join gate this used to carry existed to bound the
// joined-lane response, and the scoped read bounds that now (#640). A desktop
// that refused a join could not stop the relay granting one either — it could
// only make the user's own channel unreachable, which is how the same cap
// produced three permanent-refusal defects in one review cycle.
//
// The replacement happens IN PLACE. A re-granted channel is the same channel,
// and the sync rotation reads its position from this array — appending it would
// move it to the end, which strands every row the rotation had not reached yet
// (#718). Only a channel this workspace has never joined is appended.
export function mergeJoinedChannel(
  existing: readonly JoinedSharedChannel[],
  joined: JoinedSharedChannel,
): JoinedSharedChannel[] {
  const merged: JoinedSharedChannel[] = [];
  let replaced = false;
  for (const channel of existing) {
    if (
      channel.shareId !== joined.shareId &&
      channel.channelWireId !== joined.channelWireId
    ) {
      merged.push(channel);
      continue;
    }
    // A second stale row for the same channel (one matched by share, one by
    // wire) collapses into the first: one channel, one row.
    if (replaced) continue;
    replaced = true;
    merged.push(joined);
  }
  if (!replaced) merged.push(joined);
  return merged;
}

// Member leave stops sync but keeps a durable provenance tombstone. The local
// rows stay readable, and DM ownership must not flip when live grant data goes.
export function endJoinedChannel(
  existing: readonly JoinedSharedChannel[],
  shareId: string,
): JoinedSharedChannel[] {
  return existing.map((channel) =>
    channel.shareId === shareId ? { ...channel, ended: true } : channel,
  );
}

// MU-C4 write gate (CodeRabbit security; product invariant "agent writes must
// respect sharing boundaries"): a READ-ONLY or ENDED shared-channel grant must
// reject chat writes BEFORE any durable local mutation. The renderer disabling
// its composers is honesty, not authorization — main is the boundary; without
// this gate a crafted IPC call would mint durable local messages/reactions
// that sync forever refuses to deliver. An ENDED grant (revoked / owner gone)
// is a read-only local copy: it already stopped syncing, so a post-revocation
// write would only ever live locally, violating "ended means read-only".
// Resolution is by the channel's WIRE identity (thread → channel → wire)
// against the joined registry rows. Targets that resolve OUTSIDE any
// read-only/ended grant — plain local channels, file-linked threads, unknown
// ids — pass through; the store's own write path owns those errors.
interface SharedChannelTargetInput {
  workspaceId: string;
  sharedChannels: readonly JoinedSharedChannel[] | undefined;
  store: {
    findThreadChannelId(input: {
      workspaceId: string;
      threadId: string;
    }): Promise<string | null>;
    getChannelWireId(input: { workspaceId: string; channelId: string }): Promise<string | null>;
  };
  target: { channelId: string } | { threadId: string };
}

export async function joinedSharedChannelForTarget(
  input: SharedChannelTargetInput,
): Promise<JoinedSharedChannel | null> {
  if ((input.sharedChannels?.length ?? 0) === 0) return null;
  let channelId: string | null;
  if ("channelId" in input.target) {
    channelId = input.target.channelId;
  } else {
    channelId = await input.store.findThreadChannelId({
      workspaceId: input.workspaceId,
      threadId: input.target.threadId,
    });
  }
  if (!channelId) return null;
  const wireId = await input.store.getChannelWireId({
    workspaceId: input.workspaceId,
    channelId,
  });
  const matching = (input.sharedChannels ?? []).filter(
    (channel) => channel.channelWireId === wireId,
  );
  return (
    matching.find((channel) => channel.access === "read-only" || channel.ended === true) ??
    matching[0] ??
    null
  );
}

export async function assertSharedChannelWritable(
  input: SharedChannelTargetInput,
): Promise<void> {
  const channel = await joinedSharedChannelForTarget(input);
  if (channel?.access === "read-only" || channel?.ended === true) {
    // The engine's read-only refusal, reused verbatim (an ended grant is a
    // read-only local copy) so the IPC error copy matches what the relay-side
    // downgrade path surfaces.
    throw new SharedChannelReadOnlyError();
  }
}

// How many live joined rows one pass covers (#718). listChatChannels awaits the
// pass, and the pass is sequential whatever it does: EngineRelayClient chains
// every relay RPC for a workspace (engineRelayClient.ts:591, 1020-1037), so
// running the rows concurrently could not overlap a round trip.
//
// Its cost is therefore rows x requests. Each request already had a bound — a
// 15 s fetch timeout and a 30 s daemon deadline — and a row costs one pull, or a
// push plus a paged pull at 500 ops a page (sync-relay/src/server.ts:87,
// dohc-engine-sync/src/model.rs:7). Rows were the only unbounded multiplier.
// Sixteen caps a pass near 32 requests: what the pass already spends on ONE
// channel carrying an 8,000-op backlog. A pass that a write triggered adds that
// one share on top, so the true ceiling is 17 rows.
export const SHARED_CHANNEL_SYNC_PASS_ROWS = 16;

// A pass that left rows behind must say so, naming the constraint, the limit,
// the unit, and what it covered. The DM poll runs every 5 s, so the notice
// repeats only when the remainder changes.
export function createPassCoverageReporter(
  report: (message: string) => void,
): (input: {
  workspaceId: string;
  live: number;
  uncovered: number;
  passRows: number;
}) => void {
  const reported = new Map<string, number>();
  return ({ workspaceId, live, uncovered, passRows }) => {
    if (uncovered <= 0) {
      reported.delete(workspaceId);
      return;
    }
    if (reported.get(workspaceId) === uncovered) return;
    reported.set(workspaceId, uncovered);
    report(
      `[desktop] shared channel sync covered ${live - uncovered} of ${live} joined channels this pass ` +
        `(limit SHARED_CHANNEL_SYNC_PASS_ROWS=${passRows} rotation rows/pass, plus 1 row for a channel ` +
        `a write named); ${uncovered} resume on the next pass.`,
    );
  };
}

export interface SyncJoinedSharedChannelsResult {
  // Shares whose relay view closed (revoked / gone): mark ended, stop syncing.
  endedShareIds: string[];
  // Shares whose ACCESS turned out read-only on push (flipped or always was):
  // their local ops stay local; pull still ran.
  readOnlyShareIds: string[];
  // True when any pull applied new ops — the caller should refresh the UI.
  changed: boolean;
  // Live rows that this bounded pass did not reach.
  uncovered: number;
  // The channel the rotation stopped on, or null when the pass covered no live
  // row. A CHANNEL, not a grant: a share id dies with its grant, and a revoked
  // and re-granted channel would lose the rotation's place with it.
  resumeAfterChannelWireId: string | null;
}

export async function syncJoinedSharedChannels(input: {
  rootDir: string;
  workspaceId: string;
  relay: SyncRelayConnection;
  // The rows this pass may sync: live, and syncable by the current account.
  channels: readonly JoinedSharedChannel[];
  // Every row the workspace has ever joined, in registry order, tombstones
  // included. This fixes the rotation's positions; `channels` is the work set.
  // The two are separate because a row can leave the work set — revoked, or
  // joined under another account — while the rotation still needs its place.
  registryOrder: readonly JoinedSharedChannel[];
  passRows: number;
  resumeAfterChannelWireId?: string;
  // The share whose write triggered this pass. Always covered, and covered in
  // ADDITION to the rotation's rows.
  priorityShareId?: string;
  // Required factory-selected operations prevent a rooted sync pass from
  // silently falling back to the legacy TypeScript relay client.
  pull: (input: {
    rootDir: string;
    workspaceId: string;
    relay: SyncRelayConnection;
    shareId: string;
    channelWireId: string;
  }) => Promise<PullSharedChannelResult>;
  push: (input: {
    rootDir: string;
    workspaceId: string;
    relay: SyncRelayConnection;
    shareId: string;
    channelWireId: string;
  }) => Promise<PushSharedChannelResult>;
}): Promise<SyncJoinedSharedChannelsResult> {
  const { pull, push } = input;
  const endedShareIds: string[] = [];
  const readOnlyShareIds: string[] = [];
  let changed = false;
  // The window rotates: this pass resumes after the row the last one stopped on
  // and wraps, so freshness decays evenly instead of the pass growing with the
  // registry. Above the window, every row is reached within
  // ceil(live / passRows) passes, and the caller is told how many it did not
  // reach — a partial pass never reads as a full refresh.
  const live = input.channels.filter((channel) => channel.ended !== true);
  // Rotation positions come from the registry, so a row that left the work set
  // between passes keeps its place. Resolving the cursor inside the work set
  // loses that place the moment the cursor's own channel is revoked, and the
  // next pass restarts at the front, re-covering the prefix it just did.
  const registryPosition = new Map(
    input.registryOrder.map(
      (channel, index) => [channel.channelWireId, index] as const,
    ),
  );
  const cursorPosition = input.resumeAfterChannelWireId
    ? (registryPosition.get(input.resumeAfterChannelWireId) ?? -1)
    : -1;
  const afterCursor =
    cursorPosition < 0
      ? -1
      : live.findIndex(
          (channel) =>
            (registryPosition.get(channel.channelWireId) ?? -1) > cursorPosition,
        );
  const startIndex = afterCursor < 0 ? 0 : afterCursor;
  // The rotation always gets the whole window. A write's own share is EXTRA
  // work — it has to go out now, and charging it a rotation slot would make the
  // coverage promise depend on write traffic: repeated writes to one channel
  // would starve the tail of the registry forever. So a pass costs at most
  // passRows + 1 rows, and ceil(live / passRows) holds whatever the writes do.
  const rotationBudget = Math.min(Math.max(input.passRows, 0), live.length);
  const priority = input.priorityShareId
    ? (live.find((channel) => channel.shareId === input.priorityShareId) ?? null)
    : null;
  const rotation: JoinedSharedChannel[] = [];
  for (let offset = 0; rotation.length < rotationBudget && offset < live.length; offset += 1) {
    const channel = live[(startIndex + offset) % live.length]!;
    if (channel.shareId === priority?.shareId) continue;
    rotation.push(channel);
  }
  const covered = priority ? [priority, ...rotation] : rotation;
  const uncovered = live.length - covered.length;
  // The cursor follows the ROTATION only. A priority row is covered out of
  // order, so letting it move the cursor would skip whatever it jumped over.
  const resumeAfterChannelWireId =
    rotation.at(-1)?.channelWireId ?? input.resumeAfterChannelWireId ?? null;
  for (const channel of covered) {
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
  return {
    endedShareIds,
    readOnlyShareIds,
    changed,
    uncovered,
    resumeAfterChannelWireId,
  };
}
