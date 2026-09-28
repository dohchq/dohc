import type { CloudCredentials } from "./cloudCredentialStore";
import { joinedChannelMatchesCredentials } from "./chatRelayIdentity";
import type {
  JoinedSharedChannel,
  RegistryEntry,
  ShareMountRecord,
  ShareViewIdentity,
} from "./registryStore";
import { relayUrlsMatch } from "./syncCode";

// Reconcile local copies with the authenticated account listing.
export interface ConfirmedShareRemoval {
  shareId: string;
  // The relay's time for the removal, from its `removed` listing.
  removedAtMs: number;
}

export interface ReceivedShareListing {
  // Share ids the relay lists as active for this account.
  received: ReadonlySet<string>;
  removed: readonly ConfirmedShareRemoval[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parts of a `/sync/shares` body this reconciliation reads, or null when
 * the body is not one it can act on. A lane that is present but not an array
 * makes the whole listing unusable: a partial read must not resume anything.
 */
export function readReceivedShareListing(listing: unknown): ReceivedShareListing | null {
  if (!isRecord(listing)) return null;
  const receivedRows = listing.received ?? [];
  const removedRows = listing.removed ?? [];
  if (!Array.isArray(receivedRows) || !Array.isArray(removedRows)) return null;
  const received = new Set<string>();
  for (const row of receivedRows) {
    if (isRecord(row) && typeof row.shareId === "string" && row.shareId.length > 0) {
      received.add(row.shareId);
    }
  }
  const removed: ConfirmedShareRemoval[] = [];
  for (const row of removedRows) {
    if (
      isRecord(row) &&
      typeof row.shareId === "string" &&
      row.shareId.length > 0 &&
      typeof row.removedAtMs === "number" &&
      Number.isFinite(row.removedAtMs) &&
      row.removedAtMs >= 0
    ) {
      removed.push({ shareId: row.shareId, removedAtMs: row.removedAtMs });
    }
  }
  return { received, removed };
}

function shareViewMatches(view: ShareViewIdentity, credentials: CloudCredentials): boolean {
  return (
    credentials.relayUrl !== undefined &&
    (view.relayUrl === undefined || relayUrlsMatch(credentials.relayUrl, view.relayUrl))
  );
}

function mountMatches(mount: ShareMountRecord, credentials: CloudCredentials): boolean {
  return (
    credentials.relayUrl !== undefined &&
    relayUrlsMatch(credentials.relayUrl, mount.relayUrl) &&
    (mount.recipientEmail == null ||
      credentials.email == null ||
      mount.recipientEmail === credentials.email)
  );
}

function withoutEnded<Record extends { ended?: boolean }>(record: Record): Record {
  const next = { ...record };
  delete next.ended;
  return next;
}

function confirmedRemovals(entry: Readonly<RegistryEntry>): readonly ConfirmedShareRemoval[] {
  const raw: unknown = entry.confirmedRemovedShares;
  return Array.isArray(raw)
    ? raw.filter(
        (row): row is ConfirmedShareRemoval =>
          isRecord(row) && typeof row.shareId === "string" && typeof row.removedAtMs === "number",
      )
    : [];
}

// The registry file is data: a row can be malformed. Only object rows are
// read, and only the fields the checks below name are trusted.
function mounts(entry: Readonly<RegistryEntry>): readonly ShareMountRecord[] {
  const raw: unknown = entry.shareMounts;
  return Array.isArray(raw) ? (raw.filter(isRecord) as unknown as ShareMountRecord[]) : [];
}

function channels(entry: Readonly<RegistryEntry>): readonly JoinedSharedChannel[] {
  const raw: unknown = entry.sharedChannels;
  return Array.isArray(raw) ? (raw.filter(isRecord) as unknown as JoinedSharedChannel[]) : [];
}

function shareView(entry: Readonly<RegistryEntry>): ShareViewIdentity | null {
  const raw: unknown = entry.shareView;
  return isRecord(raw) && typeof raw.shareId === "string"
    ? (raw as unknown as ShareViewIdentity)
    : null;
}

/**
 * Apply one authenticated listing to one entry. Returns the changed entry,
 * or null when the listing changes nothing about it.
 */
export function reconcileRecipientShares(
  entry: Readonly<RegistryEntry>,
  listing: ReceivedShareListing,
  credentials: CloudCredentials,
): RegistryEntry | null {
  const active = (shareId: string) => listing.received.has(shareId);
  // Share ids this listing speaks for: records pinned to its relay and
  // account. Records pinned elsewhere keep their state, ended or not.
  const spokenFor = new Set<string>();
  const heldElsewhere = new Set<string>();

  const view = shareView(entry);
  let nextView = view;
  if (view) {
    if (shareViewMatches(view, credentials)) {
      spokenFor.add(view.shareId);
      if (view.ended === true && active(view.shareId)) nextView = withoutEnded(view);
    } else {
      heldElsewhere.add(view.shareId);
    }
  }

  let mountsChanged = false;
  const nextMounts = mounts(entry).map((mount) => {
    if (!mountMatches(mount, credentials)) {
      heldElsewhere.add(mount.shareId);
      return mount;
    }
    spokenFor.add(mount.shareId);
    if (mount.ended !== true || !active(mount.shareId)) return mount;
    mountsChanged = true;
    return withoutEnded(mount);
  });

  let channelsChanged = false;
  const nextChannels = channels(entry).map((channel) => {
    if (!joinedChannelMatchesCredentials(channel, credentials)) {
      heldElsewhere.add(channel.shareId);
      return channel;
    }
    spokenFor.add(channel.shareId);
    // A channel the person left stays left: its grant is active, and Join
    // is the way back. Only a relay-ended row resumes.
    if (channel.ended !== true || channel.left === true || !active(channel.shareId)) {
      return channel;
    }
    channelsChanged = true;
    return withoutEnded(channel);
  });

  const existing = confirmedRemovals(entry);
  const listedRemovals = new Set(listing.removed.map(row => row.shareId));
  const nextRemovals = [
    ...existing.filter(
      (removal) => !spokenFor.has(removal.shareId)
        ? heldElsewhere.has(removal.shareId)
        : !active(removal.shareId) && !listedRemovals.has(removal.shareId),
    ),
    ...listing.removed.filter(
      (removal) => spokenFor.has(removal.shareId) && !active(removal.shareId),
    ),
  ];
  const removalsChanged =
    JSON.stringify(nextRemovals) !== JSON.stringify(existing) ||
    (nextRemovals.length === 0) !== (entry.confirmedRemovedShares === undefined);

  if (nextView === view && !mountsChanged && !channelsChanged && !removalsChanged) {
    return null;
  }
  const next: RegistryEntry = { ...entry };
  if (nextView !== view && nextView) next.shareView = nextView;
  if (mountsChanged) next.shareMounts = nextMounts as ShareMountRecord[];
  if (channelsChanged) next.sharedChannels = nextChannels as JoinedSharedChannel[];
  if (nextRemovals.length === 0) delete next.confirmedRemovedShares;
  else next.confirmedRemovedShares = nextRemovals;
  return next;
}

// An ended copy needs a fresh listing even after the Undo period: its owner
// may have restored it while this device was offline.
export function recipientShareNeedsRecheck(entry: Readonly<RegistryEntry>): boolean {
  return shareView(entry)?.ended === true ||
    mounts(entry).some(mount => mount.ended === true) ||
    channels(entry).some(channel => channel.ended === true && channel.left !== true);
}
