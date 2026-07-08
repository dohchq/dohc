import type { LinkedChatStore } from "@dohc/workspace-engine";
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

// The single running conversation (the anti-forum rule): the OLDEST thread in
// the DM channel, deterministically (createdAtMs, then thread id) — every
// participant picks the same one even if a race ever minted a duplicate.
function runningThread<
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
    const role = wireId === channel.id ? "owner" : "participant";
    const joined = joinedByWire.get(wireId);
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
// the channel-name cap.
export function dmChannelNameFor(recipients: string[]): string {
  const name = recipients.join(", ");
  return name.length <= 80 ? name : `${name.slice(0, 77)}...`;
}
