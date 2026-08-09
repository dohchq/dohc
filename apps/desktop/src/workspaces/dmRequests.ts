import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { resolveDmKinds, type DmPeekResult } from "./dmChats";
import type { JoinedSharedChannel } from "./registryStore";
import type { SharedChannelInfo } from "./sharedChannelInfo";
import { mergeJoinedChannel } from "./sharedChannels";

export interface DmRequestRow {
  shareId: string;
  granterEmail: string | null;
}

interface ReceivedDmGrantRow {
  shareId?: unknown;
  granterEmail?: unknown;
  selector?: { kind?: unknown; channelWireId?: unknown };
}

interface WorkspaceSharedChannelRegistry {
  workspaceId: string;
  rootPath: string;
  sharedChannels?: readonly JoinedSharedChannel[];
}

// One pass over every workspace's registry maps each shareId with a LIVE
// (non-ended) row to the workspace ids holding it. Ended rows are provenance
// tombstones, never a claim: leaving must stay reversible in any workspace.
export function liveSharedChannelHoldersByShareId(
  workspaces: readonly WorkspaceSharedChannelRegistry[],
): Map<string, Set<string>> {
  const holders = new Map<string, Set<string>>();
  for (const workspace of workspaces) {
    for (const channel of workspace.sharedChannels ?? []) {
      if (channel.ended === true) continue;
      const shareHolders = holders.get(channel.shareId) ?? new Set<string>();
      shareHolders.add(workspace.workspaceId);
      holders.set(channel.shareId, shareHolders);
    }
  }
  return holders;
}

// A re-grant mints a new shareId for the same channelWireId. This map keeps
// that channel in one workspace until its old row ends. Ended rows remain
// reversible and do not hold the wire id.
export function liveSharedChannelHoldersByWireId(
  workspaces: readonly WorkspaceSharedChannelRegistry[],
): Map<string, Set<string>> {
  const holders = new Map<string, Set<string>>();
  for (const workspace of workspaces) {
    for (const channel of workspace.sharedChannels ?? []) {
      if (channel.ended === true) continue;
      const wireHolders =
        holders.get(channel.channelWireId) ?? new Set<string>();
      wireHolders.add(workspace.workspaceId);
      holders.set(channel.channelWireId, wireHolders);
    }
  }
  return holders;
}

function otherLiveSharedChannelHolderFromMap(input: {
  workspaces: readonly WorkspaceSharedChannelRegistry[];
  workspaceId: string;
  holderIds: ReadonlySet<string> | undefined;
}): WorkspaceSharedChannelRegistry | null {
  const holderIds = input.holderIds;
  if (!holderIds) return null;
  return (
    input.workspaces.find(
      (workspace) =>
        workspace.workspaceId !== input.workspaceId &&
        holderIds.has(workspace.workspaceId),
    ) ?? null
  );
}

export function otherLiveSharedChannelHolder(input: {
  workspaces: readonly WorkspaceSharedChannelRegistry[];
  shareId: string;
  workspaceId: string;
}): WorkspaceSharedChannelRegistry | null {
  return otherLiveSharedChannelHolderFromMap({
    workspaces: input.workspaces,
    workspaceId: input.workspaceId,
    holderIds: liveSharedChannelHoldersByShareId(input.workspaces).get(
      input.shareId,
    ),
  });
}

export function otherLiveSharedChannelHolderByWireId(input: {
  workspaces: readonly WorkspaceSharedChannelRegistry[];
  channelWireId: string;
  workspaceId: string;
}): WorkspaceSharedChannelRegistry | null {
  return otherLiveSharedChannelHolderFromMap({
    workspaces: input.workspaces,
    workspaceId: input.workspaceId,
    holderIds: liveSharedChannelHoldersByWireId(input.workspaces).get(
      input.channelWireId,
    ),
  });
}

export function isShareAcceptedInWorkspace(
  channels: readonly JoinedSharedChannel[],
  shareId: string,
): boolean {
  // An ended row records a reversible leave. It is not an accepted share, so
  // reaccepting must run the full reserve-and-pull path that revives the row.
  return channels.some(
    (channel) => channel.shareId === shareId && channel.ended !== true,
  );
}

export async function classifyDmRequests(input: {
  received: readonly ReceivedDmGrantRow[];
  kindCache: Map<string, "dm" | "not-dm">;
  peekKind: (shareId: string) => Promise<DmPeekResult>;
  holdersByShareId: () => ReadonlyMap<string, ReadonlySet<string>>;
  holdersByWireId: () => ReadonlyMap<string, ReadonlySet<string>>;
  declinedShareIds: ReadonlySet<string> | null;
}): Promise<{ pending: DmRequestRow[]; declined: DmRequestRow[] }> {
  const received: Array<DmRequestRow & { channelWireId: string }> = [];
  for (const row of input.received) {
    const shareId = typeof row.shareId === "string" ? row.shareId : null;
    if (
      !shareId ||
      row.selector?.kind !== "chat-channel" ||
      typeof row.selector.channelWireId !== "string" ||
      row.selector.channelWireId.length === 0
    ) {
      continue;
    }
    received.push({
      shareId,
      channelWireId: row.selector.channelWireId,
      granterEmail:
        typeof row.granterEmail === "string" ? row.granterEmail : null,
    });
  }

  const holdersBeforePeek = input.holdersByShareId();
  const wireHoldersBeforePeek = input.holdersByWireId();
  await resolveDmKinds({
    shareIds: received
      .filter(
        (row) =>
          !holdersBeforePeek.has(row.shareId) &&
          !wireHoldersBeforePeek.has(row.channelWireId),
      )
      .map((row) => row.shareId),
    cache: input.kindCache,
    peekKind: input.peekKind,
  });
  const holders = input.holdersByShareId();
  const wireHolders = input.holdersByWireId();
  const requests: DmRequestRow[] = received
    .filter(
      (row) =>
        input.kindCache.get(row.shareId) === "dm" &&
        !holders.has(row.shareId) &&
        !wireHolders.has(row.channelWireId),
    )
    .map(({ shareId, granterEmail }) => ({ shareId, granterEmail }));
  const declinedShareIds = input.declinedShareIds;
  if (declinedShareIds === null) return { pending: [], declined: [] };
  return {
    pending: requests.filter((row) => !declinedShareIds.has(row.shareId)),
    declined: requests.filter((row) => declinedShareIds.has(row.shareId)),
  };
}

export async function reserveAndPullSharedChannel(input: {
  relay: SyncRelayConnection;
  shareId: string;
  workspaceId: string;
  rootPath: string;
  recipientUserId: string;
  relayUrl: string;
  readSharedChannels: (
    workspaceId: string,
  ) => readonly JoinedSharedChannel[];
  writeSharedChannels: (
    workspaceId: string,
    channels: JoinedSharedChannel[],
  ) => void;
  fetchInfo: (input: {
    relay: SyncRelayConnection;
    shareId: string;
  }) => Promise<SharedChannelInfo>;
  pull: (input: {
    workspaceId: string;
    rootPath: string;
    relay: SyncRelayConnection;
    shareId: string;
    channelWireId: string;
  }) => Promise<{ applied: number }>;
  serialize: (
    workspaceId: string,
    run: () => Promise<void>,
  ) => Promise<void>;
  afterPull?: (workspaceId: string) => Promise<void>;
  preWrite?: (info: { channelWireId: string }) => void;
}): Promise<JoinedSharedChannel> {
  const info = await input.fetchInfo({
    relay: input.relay,
    shareId: input.shareId,
  });
  const joined: JoinedSharedChannel = {
    shareId: info.shareId,
    channelWireId: info.channelWireId,
    access: info.access,
    granterEmail: info.granterEmail,
    relayUrl: input.relayUrl,
    recipientUserId: input.recipientUserId,
  };

  // Record the row BEFORE the pull. The row is the write gate, and a pull is
  // durable: pulling first can import channel data without its access gate.
  input.preWrite?.(info);
  input.writeSharedChannels(
    input.workspaceId,
    mergeJoinedChannel(input.readSharedChannels(input.workspaceId), joined),
  );
  // If a multi-page pull fails, keep the reserved row. Earlier pages can be
  // durable, and removing the row would remove their write gate.
  await input.serialize(input.workspaceId, async () => {
    const pulled = await input.pull({
      workspaceId: input.workspaceId,
      rootPath: input.rootPath,
      relay: input.relay,
      shareId: info.shareId,
      channelWireId: info.channelWireId,
    });
    if (pulled.applied > 0) await input.afterPull?.(input.workspaceId);
  });
  return joined;
}
