import { receivedReferencePin, type ReceivedReferencePin } from "./workspaceFileReferenceScopes";
import { normalizeShareLabel } from "@dohc/security-contract/share-labels";
import {
  type ShareAccess,
  isShareAccessValue,
  isShareablePathList,
  isValidShareVersionId,
} from "@dohc/security-contract/share-selector";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
  type ShareReachSignatures,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { isChatShareAccessValue } from "@dohc/security-contract/share-grant";
import { parseListedReach, type ListedReach } from "@dohc/security-contract/listed-reach";
import { relayApiFetch } from "./sharedChannels";

export interface ShareViewSelector {
  paths: string[];
  versionId: string | null;
  // The level the relay states for this share. Required: it is pinned
  // with the rest of the selector and travels to the engine on every pull.
  access: ShareAccess;
  // A membership: every tracked path on main and the workspace's Groups,
  // with no paths and no version. The relay states it as
  // `{kind: "workspace"}`.
  wholeWorkspace?: true;
}

export type WorkspaceRole = "admin" | "member";

// A restriction's display snapshot. Capture and pull must not use these paths.
export interface ShareUnconfirmedChanges {
  paths: string[];
  unchecked: boolean;
  checked: number;
  dismissedKey?: string;
}

export interface ShareViewInfo {
  receivedIdentity?: ReceivedReferencePin;
  subjectName?: string | null;
  sharerName?: string | null;
  shareId: string;
  statedShareId?: string;
  granterUserId: string;
  granterEmail: string | null;
  genericChatWritable: boolean;
  /** The caller's role, for a membership only. */
  role?: WorkspaceRole;
  /** The owner's workspace id, which Members routes name. A membership only. */
  membersWorkspaceId?: string;
  /**
   * The effective selector composed from the relay's stored scope and grant
   * access, or null when the share grants a chat channel and has no file
   * selector at all. Never a softened stand-in for an unreadable response. See
   * `ShareSelectorInvalidError`.
   */
  selector: ShareViewSelector | null;
  createdAtMs: number;
}

/**
 * The relay answered with something that is not a selector this client can
 * enforce. It is refused rather than softened: a client that guesses at a
 * selector is not pinning the relay's assertion, it is inventing one, and
 * every permissive guess is wider than the grant it stands in for.
 *
 * The contract is the relay's own (`validateShareSelector` in
 * `services/sync-relay/src/shareFilter.ts`): paths are non-empty strings, and
 * a share selects at least one path OR a version.
 */
export class ShareSelectorInvalidError extends Error {
  constructor(readonly shareId: string) {
    super(`The relay did not describe share ${shareId} in a readable way.`);
    this.name = "ShareSelectorInvalidError";
  }
}

function shareUrl(relay: SyncRelayConnection, path: string): string {
  return `${relay.baseUrl.replace(/\/+$/u, "")}${path}`;
}

async function shareFetch(
  relay: SyncRelayConnection,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${relay.token}`);
  const response = await (relay.fetch ?? relayApiFetch())(shareUrl(relay, path), {
    ...init,
    headers,
  });
  if (response.status === 401) throw new RelayUnauthorizedError();
  if (response.status === 404) throw new ShareUnavailableError();
  if (!response.ok) throw new Error(`Share request failed (${response.status})`);
  return response;
}

// Strict, because this value becomes the pinned grant every later pull is
// enforced against. `null` means "a chat grant, no file selector";
// anything unreadable throws rather than degrading into a wider grant.
function parseSelector(value: unknown, access: unknown, shareId: string): ShareViewSelector | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShareSelectorInvalidError(shareId);
  }
  const record = value as {
    kind?: unknown;
    paths?: unknown;
    versionId?: unknown;
  };
  if (record.kind === "chat") return null;
  if (record.kind === "workspace") {
    if (
      readWorkspaceRole(value) === null ||
      "paths" in record ||
      "versionId" in record ||
      !isShareAccessValue(access)
    ) {
      throw new ShareSelectorInvalidError(shareId);
    }
    return { paths: [], versionId: null, access, wholeWorkspace: true };
  }
  if (record.kind === "group") {
    // A group's folder half. The relay states one access for the whole
    // group: read-write edits the folder, read-only views it. The channel
    // half is joined from Chats and never reaches a mount.
    if (
      !Array.isArray(record.paths) ||
      record.paths.length === 0 ||
      !isShareablePathList(record.paths) ||
      (record.versionId !== null && record.versionId !== undefined) ||
      !isChatShareAccessValue(access)
    ) {
      throw new ShareSelectorInvalidError(shareId);
    }
    return {
      paths: record.paths as string[],
      versionId: null,
      access: access === "read-write" ? "edit" : "view",
    };
  }
  if (!Array.isArray(record.paths)) throw new ShareSelectorInvalidError(shareId);
  // Same shared rule as the registry read-back: a path the relay could not
  // have issued is a response this client cannot enforce.
  if (!isShareablePathList(record.paths)) {
    throw new ShareSelectorInvalidError(shareId);
  }
  // The version dimension is held to the relay's own rule, from the one
  // place that states it. A version id the relay could not have issued is a
  // response this client cannot enforce, not a share that follows main:
  // reading it as `null` would silently downgrade a version share.
  if (record.versionId !== null && record.versionId !== undefined) {
    if (!isValidShareVersionId(record.versionId)) {
      throw new ShareSelectorInvalidError(shareId);
    }
  }
  const versionId = isValidShareVersionId(record.versionId) ? record.versionId : null;
  // The relay refuses to CREATE a selector that selects nothing, so a
  // response carrying one is not a grant — it is a relay this client cannot
  // enforce anything against.
  if (record.paths.length === 0 && versionId === null) {
    throw new ShareSelectorInvalidError(shareId);
  }
  // The level is held to the relay's own rule, from the same one place as the
  // version dimension. A missing or unrecognized level is refused, never read
  // as `view`: the narrowest guess is still a guess, and the record it would
  // pin outlives the response it came from.
  if (!isShareAccessValue(access)) {
    throw new ShareSelectorInvalidError(shareId);
  }
  return {
    paths: record.paths as string[],
    versionId,
    access,
  };
}

function readWorkspaceRole(selector: unknown): WorkspaceRole | null {
  if (!selector || typeof selector !== "object" || !("role" in selector)) return null;
  return selector.role === "admin" || selector.role === "member" ? selector.role : null;
}

export async function fetchShareViewInfo(input: {
  relay: SyncRelayConnection;
  shareId: string;
  signal?: AbortSignal;
}): Promise<ShareViewInfo> {
  const response = await shareFetch(
    input.relay,
    `/sync/shares/${encodeURIComponent(input.shareId)}`,
    { signal: input.signal },
  );
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.genericChatWritable !== "boolean") {
    throw new ShareSelectorInvalidError(input.shareId);
  }
  const selector = parseSelector(body.selector, body.access, input.shareId);
  if (
    selector?.wholeWorkspace &&
    (typeof body.workspaceId !== "string" || body.workspaceId.length === 0)
  ) {
    throw new ShareSelectorInvalidError(input.shareId);
  }
  return {
    receivedIdentity: receivedReferencePin(body),
    shareId: String(body.shareId ?? input.shareId),
    ...(typeof body.shareId === "string" ? { statedShareId: body.shareId } : {}),
    granterUserId: String(body.granterUserId ?? ""),
    subjectName: normalizeShareLabel(body.subjectName),
    sharerName: normalizeShareLabel(body.sharerName, 320),
    granterEmail: typeof body.granterEmail === "string" ? body.granterEmail : null,
    genericChatWritable: body.genericChatWritable,
    ...(selector?.wholeWorkspace
      ? { role: readWorkspaceRole(body.selector)!, membersWorkspaceId: body.workspaceId as string }
      : {}),
    selector,
    createdAtMs: Number(body.createdAtMs ?? 0),
  };
}

export async function fetchShareViewAccess(input: {
  relay: SyncRelayConnection;
  shareId: string;
  signal?: AbortSignal;
}): Promise<{ access: ShareAccess; role?: WorkspaceRole; levelChangedBy?: string }> {
  const response = await (input.relay.fetch ?? relayApiFetch())(
    shareUrl(input.relay, `/sync/shares/${encodeURIComponent(input.shareId)}/access`),
    { headers: { authorization: `Bearer ${input.relay.token}` }, signal: input.signal },
  );
  if (response.status === 401) throw new RelayUnauthorizedError();
  if (response.status === 404) {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "code" in body &&
      body.code === "share_access_removed"
    ) {
      throw new ShareUnavailableError();
    }
  }
  if (!response.ok) throw new Error(`Share access request failed (${response.status})`);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("status" in body) ||
    body.status !== "current" ||
    !("access" in body) ||
    !isShareAccessValue(body.access)
  ) {
    throw new ShareSelectorInvalidError(input.shareId);
  }
  // A membership also names its role, and the person who set its level.
  if (!("role" in body)) return { access: body.access };
  const role = readWorkspaceRole(body);
  if (role === null) throw new ShareSelectorInvalidError(input.shareId);
  if (!("levelChangedBy" in body)) return { access: body.access, role };
  if (typeof body.levelChangedBy !== "string" || !body.levelChangedBy.trim())
    throw new ShareSelectorInvalidError(input.shareId);
  return { access: body.access, role, levelChangedBy: body.levelChangedBy };
}

/**
 * A membership's reach as the relay lists it now. Each share log page lists
 * it, so this reads the smallest page.
 */
export async function fetchShareViewReach(input: {
  relay: SyncRelayConnection;
  shareId: string;
  signal?: AbortSignal;
}): Promise<ListedReach> {
  const response = await shareFetch(
    input.relay,
    `/sync/shares/${encodeURIComponent(input.shareId)}/log?since=0&limit=1`,
    { signal: input.signal },
  );
  const body: unknown = await response.json();
  const reach =
    body && typeof body === "object" && "reach" in body ? parseListedReach(body.reach) : null;
  if (reach === null) throw new Error("The server did not return a readable reach for this share.");
  return reach;
}

export async function probeShareViewLog(input: {
  relay: SyncRelayConnection;
  shareId: string;
  since: number;
  // How long the relay may wait for news before answering an empty page.
  hold?: number;
  // The level this computer knows. The relay answers a hold at once when its
  // own record differs.
  level?: ShareAccess;
  // The reach signatures this computer holds for a membership.
  reach?: ShareReachSignatures;
  signal?: AbortSignal;
}): Promise<{ unchanged: boolean; levelChanged?: true }> {
  // Standalone share.view.pull reads the whole share log without channelWireId,
  // including group shares. Only shared-channel pulls pass a channel filter.
  const response = await shareFetch(
    input.relay,
    `/sync/shares/${encodeURIComponent(input.shareId)}/log?since=${input.since}&scan=page${input.hold ? `&hold=${input.hold}` : ""}${input.hold && input.level ? `&level=${input.level}` : ""}`,
    { signal: input.signal },
  );
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("ops" in body) ||
    !Array.isArray(body.ops) ||
    !("hasMore" in body) ||
    typeof body.hasMore !== "boolean" ||
    !("nextCursor" in body) ||
    typeof body.nextCursor !== "number" ||
    !Number.isSafeInteger(body.nextCursor) ||
    body.nextCursor < input.since
  ) {
    throw new Error("The server did not return a readable share log.");
  }
  // This cursor is only a probe. The engine commits the next cursor after
  // applying changes and recording refusals through the full refresh path.
  // A page under other reach signatures is news even with no ops: the levels,
  // or what they reach, moved, and only the full refresh reads them again.
  const listed =
    "reach" in body && body.reach !== null && typeof body.reach === "object" ? body.reach : {};
  const reachMoved =
    input.reach !== undefined &&
    (("signature" in listed ? listed.signature : undefined) !== input.reach.signature ||
      ("visibilitySignature" in listed ? listed.visibilitySignature : undefined) !==
        input.reach.visibilitySignature);
  const unchanged = body.ops.length === 0 && !body.hasMore && !reachMoved;
  return "levelChanged" in body && body.levelChanged === true
    ? { unchanged, levelChanged: true }
    : { unchanged };
}

export async function fetchShareAutomationSwitchable(input: {
  relay: SyncRelayConnection;
  shareId: string;
  collectionPath: string;
}): Promise<boolean> {
  const response = await shareFetch(
    input.relay,
    `/sync/shares/${encodeURIComponent(input.shareId)}/collection-writes?${new URLSearchParams({ collectionPath: input.collectionPath })}`,
  );
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("canSwitch" in body) ||
    typeof body.canSwitch !== "boolean"
  ) {
    throw new Error("The server did not confirm automation switches.");
  }
  return body.canSwitch;
}
