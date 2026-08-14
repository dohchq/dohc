import {
  type ShareAccess,
  isShareAccessValue,
  isShareablePath,
  isValidShareVersionId,
} from "@dohc/security-contract/share-selector";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";

export interface ShareViewSelector {
  paths: string[];
  versionId: string | null;
  // The level the relay states for this share (#646). Required: it is pinned
  // with the rest of the selector and travels to the engine on every pull.
  access: ShareAccess;
}

export interface ShareViewInfo {
  shareId: string;
  granterUserId: string;
  granterEmail: string | null;
  /**
   * The selector the relay states for this share, or null when the share
   * grants a chat channel and has no file selector at all. NEVER a softened
   * stand-in for a response this client could not read — see
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
  const response = await (relay.fetch ?? fetch)(shareUrl(relay, path), {
    ...init,
    headers,
  });
  if (response.status === 401) throw new RelayUnauthorizedError();
  if (response.status === 404) throw new ShareUnavailableError();
  if (!response.ok) throw new Error(`Share request failed (${response.status})`);
  return response;
}

// Strict, because this value BECOMES the pinned grant every later pull is
// enforced against. `null` means "a chat-channel grant, no file selector";
// anything unreadable throws rather than degrading into a wider grant.
function parseSelector(
  value: unknown,
  shareId: string,
): ShareViewSelector | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShareSelectorInvalidError(shareId);
  }
  const record = value as {
    kind?: unknown;
    paths?: unknown;
    versionId?: unknown;
    access?: unknown;
  };
  if (record.kind === "chat-channel") return null;
  if (!Array.isArray(record.paths)) throw new ShareSelectorInvalidError(shareId);
  // Same shared rule as the registry read-back: a path the relay could not
  // have issued is a response this client cannot enforce.
  if (!record.paths.every((path) => isShareablePath(path))) {
    throw new ShareSelectorInvalidError(shareId);
  }
  // The version dimension is held to the relay's OWN rule, from the one
  // place that states it. A version id the relay could not have issued is a
  // response this client cannot enforce, not a share that follows main:
  // reading it as `null` would silently downgrade a version share.
  if (record.versionId !== null && record.versionId !== undefined) {
    if (!isValidShareVersionId(record.versionId)) {
      throw new ShareSelectorInvalidError(shareId);
    }
  }
  const versionId = isValidShareVersionId(record.versionId)
    ? record.versionId
    : null;
  // The relay refuses to CREATE a selector that selects nothing, so a
  // response carrying one is not a grant — it is a relay this client cannot
  // enforce anything against.
  if (record.paths.length === 0 && versionId === null) {
    throw new ShareSelectorInvalidError(shareId);
  }
  // The level is held to the relay's OWN rule, from the same one place as the
  // version dimension. A missing or unrecognized level is refused, never read
  // as `view`: the narrowest guess is still a guess, and the record it would
  // pin outlives the response it came from.
  if (!isShareAccessValue(record.access)) {
    throw new ShareSelectorInvalidError(shareId);
  }
  return {
    paths: record.paths as string[],
    versionId,
    access: record.access,
  };
}

export async function fetchShareViewInfo(input: {
  relay: SyncRelayConnection;
  shareId: string;
}): Promise<ShareViewInfo> {
  const response = await shareFetch(
    input.relay,
    `/sync/shares/${encodeURIComponent(input.shareId)}`,
  );
  const body = (await response.json()) as Record<string, unknown>;
  return {
    shareId: String(body.shareId ?? input.shareId),
    granterUserId: String(body.granterUserId ?? ""),
    granterEmail: typeof body.granterEmail === "string" ? body.granterEmail : null,
    selector: parseSelector(body.selector, input.shareId),
    createdAtMs: Number(body.createdAtMs ?? 0),
  };
}
