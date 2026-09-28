import type {
  ChatChannelRecord,
  ChatChannelShareGrantRow,
  ChatChannelShareReceivedRow,
  JoinedChannelAnswer,
} from "../../ipc/bridgeContract";

// What the view keeps: the flat merged share listing. This is not the contract
// result — that one may answer "the relay was unreachable", which is not
// storable as rows. commitShareListing translates, lane by lane. The relay
// rows carry the session they were read under, because they are
// account-scoped: preservation through an outage may only ever keep the same
// session's rows.
export interface ShareListing {
  granted: ChatChannelShareGrantRow[];
  received: ChatChannelShareReceivedRow[];
  // Share ids whose owner removed this account, as the relay confirms. The
  // only source for saying so.
  removed: string[];
  // One answer per channel the read covered. A channel the read did not cover
  // is absent, which is unknown, and unknown locks it — see channelIsLocked.
  joined: JoinedChannelAnswer[];
  sessionKey: string | null;
}

// What this surface is showing, and therefore the only channels it may ask
// the joined lane about: the channels in the list, plus the invitations under
// "Shared with you" (each one needs to know whether this workspace already
// joined that channel). The response is one answer per name, so it is bounded
// by the view and not by how many channels the account has ever joined.
export function shownChannelWireIds(
  channels: readonly ChatChannelRecord[],
  received: readonly ChatChannelShareReceivedRow[],
): string[] {
  const ids = new Set<string>();
  for (const channel of channels) {
    if (channel.wireId) ids.add(channel.wireId);
  }
  for (const row of received) ids.add(row.channelWireId);
  return [...ids];
}

// A share listing answers two independent questions. The joined rows come from
// the local registry, so any reader that got a listing at all has the true
// answer. The granted/received rows come from the relay — a reader that is not
// authoritative for them must leave them exactly as they were.
// The joined lane is a set of PER-CHANNEL facts, so a read replaces the
// channels it named and leaves the rest alone. Replacing the whole array threw
// away answers the new read never spoke to — a read issued before a channel
// was created landing after it dropped that channel's answer, and the composer
// vanished under the user.
//
// Ordering is unaffected: claimLanes still decides who may write at all, and a
// claim now writes only what it answered.
// Two different questions, and they must not be confused:
//
//  - Merging is answer-driven. A read writes the channels it answered and
//    leaves the rest, so a read that never named a channel cannot drop it.
//  - Eviction is view-driven. The newest read also discards answers for
//    channels the view no longer shows — an invitation that was revoked or
//    claimed by another workspace would otherwise sit in the map forever, and
//    a cache that grows with history is the growth this whole change removes.
//
// `keep` is the newest read's view: its own scope plus anything answered
// locally since it was issued. Older reads pass null and evict nothing — they
// are not entitled to say what the view shows.
function applyJoinedAnswers(
  current: readonly JoinedChannelAnswer[],
  answers: readonly JoinedChannelAnswer[],
  keep: ReadonlySet<string> | null,
): JoinedChannelAnswer[] {
  const byWire = new Map(current.map((answer) => [answer.channelWireId, answer]));
  for (const answer of answers) byWire.set(answer.channelWireId, answer);
  const merged = [...byWire.values()];
  return keep === null ? merged : merged.filter((a) => keep.has(a.channelWireId));
}

// What a response may do to the joined lane, or null when it may do nothing.
export type JoinedCommit = {
  // Writes this response's answers into the cached lane. It takes the cached
  // answers because only the updater knows them.
  write: (current: readonly JoinedChannelAnswer[]) => JoinedChannelAnswer[];
  // This response is the newest for the lane. Only it may evict, and only it
  // may establish a lane that does not exist yet: seeding is a whole-lane act,
  // and a response that owns a few wires must not put itself — and its own
  // relay rows — over an unknown a newer read established on purpose.
  ownsLane: boolean;
};

// What the joined lane remembers between reads.
export type JoinedLaneOrder = {
  // The workspace these entries are about. They are cleared when it changes,
  // and the state carries the identity rather than a caller remembering to
  // reset it: `local` is eviction-immune until a read NAMES its wire, and no
  // read in another workspace ever will, so a channel created and abandoned
  // in one workspace would sit in every later workspace's `keep` forever.
  workspaceId: string | null;
  // The highest ticket that has answered each wire id. The lane orders per
  // WIRE, not per lane: one watermark for the whole lane let a newer read
  // outrank an older one for channels the newer read never mentioned. A
  // refreshShares issuing from a stale overview took the watermark, and the
  // overview response that alone knew about a freshly imported channel was
  // then barred whole — leaving that channel unanswered, and therefore
  // locked, until some later refresh. A newer claim outranks only what it
  // answered.
  answeredAt: Map<string, number>;
  // Wire ids this surface answered itself — see answerLocally.
  local: Set<string>;
};

export function emptyJoinedLaneOrder(): JoinedLaneOrder {
  return { workspaceId: null, answeredAt: new Map(), local: new Set() };
}

function adoptWorkspace(order: JoinedLaneOrder, workspaceId: string): void {
  if (order.workspaceId === workspaceId) return;
  order.workspaceId = workspaceId;
  order.answeredAt.clear();
  order.local.clear();
}

// A channel this surface answered itself, with no read behind it. It survives
// eviction until a read names it, because every read now in flight was issued
// before the channel existed.
export function answerLocally(
  order: JoinedLaneOrder,
  workspaceId: string,
  channelWireId: string,
): void {
  adoptWorkspace(order, workspaceId);
  order.local.add(channelWireId);
}

// The one decision the joined lane makes: what this response may write, and
// what the cache may still hold once it has.
//
// Exported with its state because the property this change exists for — a
// cache bounded by the view rather than by history — is a property of these
// two collections and of nothing on screen.
export function planJoinedCommit(
  order: JoinedLaneOrder,
  input: {
    // The workspace this response is about. The order forgets any other.
    workspaceId: string;
    ticket: number;
    answers: readonly JoinedChannelAnswer[];
    // The lane claim. Only the newest response may evict.
    newestForLane: boolean;
    // What the surface shows now, or null while it cannot say. A response's
    // own scope is not the view: a read issued from an older render answers
    // less than the surface has since put on screen, so evicting to its scope
    // would drop the answer for a channel the user is looking at — and an
    // unanswered channel locks.
    shown: readonly string[] | null;
  },
): JoinedCommit | null {
  const { workspaceId, ticket, answers, newestForLane, shown } = input;
  adoptWorkspace(order, workspaceId);
  const writable = answers.filter(
    (answer) => ticket > (order.answeredAt.get(answer.channelWireId) ?? 0),
  );
  for (const answer of writable) order.answeredAt.set(answer.channelWireId, ticket);
  let keep: Set<string> | null = null;
  if (newestForLane) {
    // A channel this read named is answered by a read from now on.
    for (const answer of answers) order.local.delete(answer.channelWireId);
    if (shown !== null) {
      keep = new Set([
        ...answers.map((answer) => answer.channelWireId),
        ...shown,
        ...order.local,
      ]);
      // The watermarks are the same cache. Ordering kept for a channel the
      // view no longer shows would grow exactly what evicting the answers
      // stopped growing.
      for (const wire of order.answeredAt.keys()) {
        if (!keep.has(wire)) order.answeredAt.delete(wire);
      }
    }
  }
  // Authority, not payload. A response that owns the lane always commits, even
  // with nothing to write: an answer covering no channel is still the lane's
  // answer, and it is what seeds the listing on a solo workspace.
  if (writable.length === 0 && !newestForLane) return null;
  return {
    write: (current) => applyJoinedAnswers(current, writable, keep),
    ownsLane: newestForLane,
  };
}

// Merges into a listing that EXISTS. Establishing one is a different question
// and each reader answers it for itself: only a reader that speaks for the
// relay lanes can, and only while it owns the joined lane.
export function mergeShareLanes(
  current: ShareListing,
  next: ShareListing,
  lanes: { joined: JoinedCommit | null; relay: boolean },
): ShareListing {
  return {
    joined: lanes.joined ? lanes.joined.write(current.joined) : current.joined,
    granted: lanes.relay ? next.granted : current.granted,
    received: lanes.relay ? next.received : current.received,
    removed: lanes.relay ? next.removed : current.removed,
    sessionKey: lanes.relay ? next.sessionKey : current.sessionKey,
  };
}

// A channel this workspace just created answers itself. main mints the new
// channel's wire id from its own local id, so no grant can exist for it — and
// the caller could not have named it in the read that is already on screen.
// Without this the new channel is unanswered, and unanswered locks: the user
// creates a channel and lands in it with no composer.
//
// It writes one key, and applyJoinedAnswers is what keeps it: a read issued
// before the create never named this channel, so when it lands it replaces the
// channels it did name and leaves this entry alone. refreshShares is
// deliberately not liveToken-guarded, so a token bump would not have been
// enough on its own.
export function answerCreatedChannel(
  current: ShareListing | null,
  channel: ChatChannelRecord,
): ShareListing | null {
  // Nothing has vouched for the lane yet, and one local fact does not make it
  // an answer. channelIsLocked keeps failing closed until a read settles it.
  if (current === null) return current;
  if (!channel.wireId) return current;
  const wireId = channel.wireId;
  return {
    ...current,
    joined: [
      ...current.joined.filter((answer) => answer.channelWireId !== wireId),
      { channelWireId: wireId, joined: null },
    ],
  };
}
