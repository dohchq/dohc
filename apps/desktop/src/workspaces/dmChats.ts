import type { LinkedChatStore } from "@dohc/workspace-contracts/engine";
import type { JoinedSharedChannel } from "./registryStore";

// WS-MU-C3 — desktop DM orchestration, kept out of main.ts so it is unit
// testable. A DM is a `kind:"dm"` channel plus one MU-C4 chat-channel grant
// per participant, riding the shared-channel lane (`syncSharedChannel.ts` /
// `shared_channel_*`) unchanged:
//   - the OWNER minted the channel locally (its wire id IS its channel id);
//     their ops ride the normal workspace push, and members' ops arrive in
//     their bucket through the relay's member-append route.
//   - a PARTICIPANT discovered the channel through a received grant and joined
//     it; the join replayed the share's filtered log, minting a FRESH local
//     channel id whose wire id is the OWNER's channel id — so a replayed
//     channel's wire id never equals its local id.
// The role rule is deterministic and durable: a locally-created channel's wire
// id equals its channel id; a replayed channel mints a fresh local id.
// Authorization NEVER derives from any of this local state — the relay
// re-derives membership from the grant row on every request.

export interface DmRecordInfo {
  channelId: string;
  channelWireId: string;
  name: string;
  // What the DM is CALLED for this viewer: the owner sees the recipients they
  // addressed (the channel name); a participant sees the granter's email —
  // the replicated channel name is the owner's recipient list, which would
  // read as the participant's own address.
  peerLabel: string;
  role: "owner" | "participant";
  shareId: string | null;
  threadId: string | null;
  unreadCount: number;
  // False for a participant whose grant ended (revoked / owner gone): the
  // messages they already replayed stay readable, but sending is closed.
  connected: boolean;
  updatedAtMs: number;
}

type DmStore = Pick<
  LinkedChatStore,
  "listChannels" | "listChannelThreads" | "getChannelWireId"
>;

// Main-process trust-boundary guard for the generic shared-channel IPC. A
// renderer can craft bridge payloads, so the handler must derive the channel
// kind from the engine rather than trusting which UI initiated the request.
// DM membership is created atomically by startDm; allowing the generic share
// path would add a participant without updating the DM's recipient identity.
export async function requireShareableChatChannel(input: {
  workspaceId: string;
  channelId: string;
  store: Pick<LinkedChatStore, "listChannels">;
}): Promise<void> {
  const channel = (await input.store.listChannels({ workspaceId: input.workspaceId })).find(
    (candidate) => candidate.id === input.channelId,
  );
  if (!channel) throw new Error("This channel no longer exists.");
  if (channel.kind === "dm") {
    throw new Error(
      "Direct messages can't be shared as channels. Start a direct message to choose its participants.",
    );
  }
  if (channel.kind !== "channel") {
    throw new Error("Only ordinary channels can be shared.");
  }
}

// The single running conversation (the anti-forum rule): the OLDEST thread in
// the DM channel, deterministically (createdAtMs, then thread id) — every
// participant picks the same one even if a race ever minted a duplicate.
// Exported so startDm reuses the SAME canonical-thread rule as listDmRecords
// (the two must never drift).
export function runningThread<
  T extends { thread: { id: string; createdAtMs: number } },
>(threads: T[]): T | undefined {
  return threads
    .slice()
    .sort(
      (a, b) =>
        a.thread.createdAtMs - b.thread.createdAtMs ||
        (a.thread.id < b.thread.id ? -1 : 1),
    )[0];
}

// The local DM list (no network): every dm-kind channel with its running
// thread, role, joined-share label, and display label. Most recent activity
// first. Participant metadata (peerLabel, connected, shareId) is sourced from
// the MU-C4 JoinedSharedChannel registry (keyed by channelWireId), which the
// main-process workspace entry owns — a DM channel is joined exactly like any
// shared channel.
export async function listDmRecords(input: {
  workspaceId: string;
  store: DmStore;
  sharedChannels: JoinedSharedChannel[];
}): Promise<DmRecordInfo[]> {
  const channels = await input.store.listChannels({ workspaceId: input.workspaceId });
  const joinedByWire = new Map(
    input.sharedChannels.map((channel) => [channel.channelWireId, channel]),
  );
  const dms: DmRecordInfo[] = [];
  for (const channel of channels) {
    if (channel.kind !== "dm") continue;
    const wireId =
      (await input.store.getChannelWireId({
        workspaceId: input.workspaceId,
        channelId: channel.id,
      })) ?? channel.id;
    const threads = await input.store.listChannelThreads({
      workspaceId: input.workspaceId,
      channelId: channel.id,
    });
    const running = runningThread(threads);
    const joined = joinedByWire.get(wireId);
    // Current Rust imports preserve the owner's channel id. Joined-share state
    // identifies those participants; id inequality preserves provenance for
    // older imported rows whose leave record was deleted before tombstones.
    const role = joined !== undefined || wireId !== channel.id ? "participant" : "owner";
    // An OWNER DM with no running thread is an aborted / rolled-back start: a
    // committed owner DM always sent its first message (creating the thread),
    // and startDm revokes this call's grants on a partial grant failure, so the
    // orphan is left with zero live recipients. Hide it — a failed startDm must
    // never linger as a broken empty conversation, and a retry mints a fresh
    // complete DM. A PARTICIPANT with no thread yet is a REAL pending DM (the
    // owner may grant before sending the first message), so it stays visible.
    if (role === "owner" && running === undefined) continue;
    dms.push({
      channelId: channel.id,
      channelWireId: wireId,
      name: channel.name,
      peerLabel:
        role === "participant" ? (joined?.granterEmail ?? channel.name) : channel.name,
      role,
      shareId: joined?.shareId ?? null,
      threadId: running?.thread.id ?? null,
      unreadCount: channel.unreadCount,
      connected: role === "owner" ? true : joined !== undefined && joined.ended !== true,
      updatedAtMs: running?.thread.updatedAtMs ?? channel.updatedAtMs,
    });
  }
  return dms.sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs || (a.channelId < b.channelId ? -1 : 1),
  );
}

// One identity, one place: a DM whose share currently appears in the request
// lanes (pending or declined) is withheld from the DM list, and the
// request-lane representation wins. Without this, Leave (#742) would end the
// row but the conversation would stay visible here too — listDmRecords keeps
// an ended participant row readable (connected:false) on purpose, so an
// owner-revoked grant's history survives after the owner ends it. Leaving
// yourself doesn't revoke anything, so the grant is still "received" and
// classifyDmRequests re-lists it — this filter is what makes that re-listing
// also remove the old placement instead of duplicating it. An owner-revoked
// row is unaffected: its grant is gone from the relay's received listing, so
// it never reaches the request lanes and this filter leaves it in the list.
export function withholdDmsInRequestLanes<T extends { shareId: string | null }>(
  dms: readonly T[],
  requestShareIds: ReadonlySet<string>,
): T[] {
  return dms.filter((dm) => dm.shareId === null || !requestShareIds.has(dm.shareId));
}

// One page of a relay share-log GET (`/sync/shares/:id/log`): the relay
// paginates RAW log rows and applies the share filter AFTER, so `ops` can be
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
//               be fetched. Do NOT cache; retry on the next pass. A grant can
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
  for (
    let start = 0;
    start < input.shareIds.length;
    start += DM_KIND_PEEK_BATCH_SIZE
  ) {
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
  return new Set(
    input.shareIds.filter((shareId) => input.cache.get(shareId) !== "not-dm"),
  );
}

// Peek a received chat-channel grant's KIND without mutating the local store
// to classify it as a pending DM request or an ordinary shared-channel invite.
// The share filter serves the
// channel.create as the join bootstrap, so the EARLIEST SERVED op carries the
// channel kind. But the log GET paginates raw rows before filtering — a normal
// owner log has `workspace.init` before `chat.channel.create`, so the first
// page is served EMPTY (ops:[], hasMore:true). Naively reading only page one
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

// Grant every not-yet-covered recipient of a DM ATOMICALLY. Create all missing
// grants first, tracking the ones created in THIS call; if ANY create fails,
// best-effort REVOKE the just-created grants before rethrowing — so a partial
// failure never leaves the channel with an INCOMPLETE live-grant set.
// matchDmChannelByRecipients requires an EXACT recipient-set match, so a
// half-granted channel would be missed on the retry and a DUPLICATE DM minted
// (with a split conversation). Rolling back to zero grants keeps the retry
// clean. The commit callback writes the first message inside the same rollback
// scope, so a thrown rollback means nothing was said yet. A revoke failure
// never masks the original error (the lingering grant is the owner's to revoke;
// the local channel stays hidden while it has no committed thread).
export async function grantDmRecipients<Result = void>(input: {
  // Normalized recipient set (parseDmRecipients output).
  recipients: string[];
  // Recipients that already hold a live grant (skip — don't re-grant).
  covered: ReadonlySet<string>;
  // Create one grant; returns its shareId. A null shareId means the relay
  // accepted the grant but withheld its id — an untrackable grant we could
  // never revoke, so it is treated as a FAILURE (roll back the rest) rather
  // than left dangling.
  createGrant: (email: string) => Promise<string | null>;
  revokeGrant: (shareId: string) => Promise<void>;
  // A thrown identity check aborts after the new share id is tracked, so the
  // pinned revoke client can roll it back.
  assertCurrent?: () => void;
  // Finish all awaited work that must succeed before the caller starts the
  // first message mutation. A failure here revokes this call's grants too.
  beforeCommit?: () => Promise<void>;
  // The first durable message mutation. A storage or journal failure still
  // belongs to grant setup and revokes this call's grants.
  commit?: () => Promise<Result>;
}): Promise<Result | undefined> {
  const created: string[] = [];
  try {
    for (const email of input.recipients) {
      if (input.covered.has(email)) continue;
      input.assertCurrent?.();
      const shareId = await input.createGrant(email);
      if (shareId === null) {
        throw new Error(`DM grant for ${email} returned no share id`);
      }
      created.push(shareId);
      input.assertCurrent?.();
    }
    await input.beforeCommit?.();
    input.assertCurrent?.();
    return await input.commit?.();
  } catch (error) {
    for (const shareId of created) {
      try {
        await input.revokeGrant(shareId);
      } catch {
        // Best-effort rollback; never mask the original grant failure.
      }
    }
    throw error;
  }
}

// Normalized, deduped recipient emails for a new DM ("a@x, b@y" input form).
export function parseDmRecipients(raw: string): string[] {
  const emails = raw
    .split(/[,\s]+/u)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const unique = [...new Set(emails)];
  if (unique.length === 0) {
    throw new Error("Enter at least one recipient email address.");
  }
  for (const email of unique) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) {
      throw new Error(`"${email}" doesn't look like an email address.`);
    }
  }
  return unique.sort();
}

// The DM channel's display name for its OWNER: the recipient set, bounded to
// the channel-name cap. COSMETIC ONLY — it truncates and can collide across
// distinct recipient sets, so it must NEVER be a DM's dedup identity (see
// matchDmChannelByRecipients).
export function dmChannelNameFor(recipients: string[]): string {
  const name = recipients.join(", ");
  return name.length <= 80 ? name : `${name.slice(0, 77)}...`;
}

// A DM's true identity is its LIVE grant recipient set — the set of live
// chat-channel grant recipients on the channel's wire — NOT its (truncatable,
// collidable) display name. Reuse an existing DM channel ONLY when its live
// grant recipients EXACTLY equal the requested normalized recipient set;
// otherwise the caller must create a fresh channel, even if the derived name
// collides. Matching by name instead would grant a new recipient someone
// else's existing conversation log when two recipient sets collide at the cap.
export function matchDmChannelByRecipients(input: {
  // Normalized (parseDmRecipients output: lowercased, deduped, sorted).
  recipients: string[];
  channels: Array<{ id: string; wireId: string }>;
  liveGrantEmailsByWire: Map<string, Set<string>>;
}): string | null {
  const requested = new Set(input.recipients);
  if (requested.size === 0) return null;
  for (const channel of input.channels) {
    const live = input.liveGrantEmailsByWire.get(channel.wireId);
    if (!live || live.size !== requested.size) continue;
    let equal = true;
    for (const email of requested) {
      if (!live.has(email)) {
        equal = false;
        break;
      }
    }
    if (equal) return channel.id;
  }
  return null;
}
