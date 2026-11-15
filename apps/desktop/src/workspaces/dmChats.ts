import type { LinkedChatStore } from "@dohc/workspace-contracts/engine";
import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { relayApiFetch } from "./sharedChannels";

// A workspace's older person-to-person chats are kind:"dm" channels shared
// through chat grants. Direct messages now live on the account's server, but
// those grants still arrive, so the shared-channel lane tells them apart from
// Group invitations and keeps them out of Join.

// Main-process trust-boundary guard for the generic shared-channel IPC. A
// renderer can craft bridge payloads, so the handler must derive the channel
// kind from the engine rather than trusting which UI initiated the request.
// A person-to-person chat is never shared as a Group.
export async function requireShareableChatChannel(input: {
  workspaceId: string;
  channelId: string;
  store: Pick<LinkedChatStore, "listChannels">;
}): Promise<Awaited<ReturnType<LinkedChatStore["listChannels"]>>[number]> {
  const channel = (await input.store.listChannels({ workspaceId: input.workspaceId })).find(
    (candidate) => candidate.id === input.channelId,
  );
  if (!channel) throw new Error("This group no longer exists.");
  if (channel.kind === "dm") {
    throw new Error("A direct message can't be shared as a group.");
  }
  if (channel.kind !== "channel") {
    throw new Error("Only groups can be shared.");
  }
  return channel;
}

// One page of a relay share-log GET (`/sync/shares/:id/log`): the relay
// paginates raw log rows and applies the share filter after, so `ops` can be
// empty while `hasMore` is true and the cursor still advances over the dropped
// (filtered-out) rows.
export interface ShareLogPage {
  ops?: Array<{ opKind?: unknown; payload?: unknown }>;
  nextCursor?: unknown;
  hasMore?: unknown;
}

// The outcome of peeking a received grant's channel kind:
//   "dm"      — a pending DM request.
//   "not-dm"  — a DEFINITIVE ordinary-channel answer: an authoritative
//               channel.create was observed with kind "channel". Safe to
//               CACHE because a grant's channel kind is immutable.
//   "unknown" — no authoritative create is visible yet, or a page could not
//               be fetched. Do not cache; retry on the next pass. A grant can
//               become visible before the owner's bootstrap ops reach relay.
export type DmPeekResult = "dm" | "not-dm" | "unknown";

const DM_KIND_PEEK_BATCH_SIZE = 5;

// Resolve immutable grant kinds in the shared cache, peeking uncached shares.
// Unknown and failed peeks stay uncached so the next call retries. A caller
// that must keep DMs out of an ordinary invite lane withholds every share that
// is not confirmed "not-dm" after this attempt.
export async function resolveDmKinds(input: {
  shareIds: readonly string[];
  cache: Map<string, "dm" | "not-dm">;
  peekKind: (shareId: string) => Promise<DmPeekResult>;
}): Promise<void> {
  for (let start = 0; start < input.shareIds.length; start += DM_KIND_PEEK_BATCH_SIZE) {
    const batch = input.shareIds.slice(start, start + DM_KIND_PEEK_BATCH_SIZE);
    // A failed peek proves no immutable kind. It stays uncached for the next call.
    await Promise.allSettled(
      batch.map(async (shareId) => {
        if (input.cache.has(shareId)) return;
        const kind = await input.peekKind(shareId);
        if (kind !== "unknown") input.cache.set(shareId, kind);
      }),
    );
  }
}

export function shareIdsToWithholdFromOrdinaryInvites(input: {
  shareIds: readonly string[];
  cache: ReadonlyMap<string, "dm" | "not-dm">;
}): Set<string> {
  return new Set(input.shareIds.filter((shareId) => input.cache.get(shareId) !== "not-dm"));
}

// Peek a received chat grant's KIND without mutating the local store
// to classify it as a pending DM request or an ordinary shared-channel invite.
// The share filter serves the
// channel.create as the join bootstrap, so the earliest served op carries the
// channel kind. But the log GET paginates raw rows before filtering — a normal
// owner log has `workspace.init` before `chat.channel.create`, so the first
// page is served empty (ops:[], hasMore:true). Naively reading only page one
// is a permanent false negative. Page through `nextCursor` until the first
// served op appears (inspect its kind) or the log is exhausted. Bounded to
// `maxPages` so a hostile/huge filtered prefix can't loop forever on since=0;
// hitting the cap, a stalled cursor, or exhausting a currently empty log does
// not prove the immutable kind: the grant can race ahead of its owner's
// channel bootstrap. Those states are "unknown" and retryable.
export async function peekReceivedGrantKind(input: {
  fetchPage: (since: number) => Promise<ShareLogPage | null>;
  maxPages?: number;
}): Promise<DmPeekResult> {
  const maxPages = input.maxPages ?? 50;
  let since = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await input.fetchPage(since);
    if (!result) return "unknown";
    const first = result.ops?.[0];
    if (first) {
      if (first.opKind !== "chat.channel.create") return "unknown";
      const payload = first.payload as { kind?: unknown } | null;
      if (payload?.kind === "dm") return "dm";
      return payload?.kind === "channel" ? "not-dm" : "unknown";
    }
    if (result.hasMore !== true) return "unknown";
    const next = typeof result.nextCursor === "number" ? result.nextCursor : null;
    // No forward progress ⇒ stop rather than re-request the same cursor forever.
    if (next === null || next <= since) return "unknown";
    since = next;
  }
  return "unknown";
}

// Peeks a received chat grant's kind through the relay's share log.
export function peekReceivedGrantKindForShare(
  relay: SyncRelayConnection,
  shareId: string,
): Promise<DmPeekResult> {
  const base = relay.baseUrl.replace(/\/+$/u, "");
  return peekReceivedGrantKind({
    fetchPage: async (since) => {
      const response = await (relay.fetch ?? relayApiFetch())(
        `${base}/sync/shares/${encodeURIComponent(shareId)}/log?since=${since}&limit=200`,
        { headers: { authorization: `Bearer ${relay.token}` } },
      );
      if (!response.ok) return null;
      return (await response.json().catch(() => null)) as ShareLogPage | null;
    },
  });
}
