import {
  RelayUnauthorizedError,
  ShareUnavailableError,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";

export interface ShareViewSelector {
  paths: string[];
  versionId: string | null;
}

export interface ShareViewInfo {
  shareId: string;
  granterUserId: string;
  granterEmail: string | null;
  /**
   * The accepted selector, or null when the share grants a chat channel and
   * has no file selector at all. NEVER a softened stand-in for a response
   * this client could not read — see `ShareSelectorInvalidError`.
   */
  selector: ShareViewSelector | null;
  createdAtMs: number;
}

/**
 * The relay answered with something that is not a selector this client can
 * enforce. It is refused rather than softened, because every permissive
 * reading of a missing selector lands on the WIDEST grant: empty paths with
 * no version is "the whole tracked workspace" to the engine, so a relay that
 * simply omits the field would disarm the containment it is checked by.
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

// Strict, because this value BECOMES the recorded grant every later pull is
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
  };
  if (record.kind === "chat-channel") return null;
  if (!Array.isArray(record.paths)) throw new ShareSelectorInvalidError(shareId);
  if (
    !record.paths.every((path) => typeof path === "string" && path.length > 0)
  ) {
    throw new ShareSelectorInvalidError(shareId);
  }
  if (record.versionId !== null && record.versionId !== undefined) {
    if (typeof record.versionId !== "string" || record.versionId.length === 0) {
      throw new ShareSelectorInvalidError(shareId);
    }
  }
  const versionId =
    typeof record.versionId === "string" ? record.versionId : null;
  // The relay refuses to CREATE a selector that selects nothing, so a
  // response carrying one is not a grant — it is a relay this client cannot
  // enforce anything against.
  if (record.paths.length === 0 && versionId === null) {
    throw new ShareSelectorInvalidError(shareId);
  }
  return { paths: record.paths as string[], versionId };
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
