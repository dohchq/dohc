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
  selector: ShareViewSelector;
  createdAtMs: number;
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

function parseSelector(value: unknown): ShareViewSelector {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { paths?: unknown; versionId?: unknown })
      : {};
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((path): path is string => typeof path === "string")
    : [];
  const versionId = typeof record.versionId === "string" ? record.versionId : null;
  return { paths, versionId };
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
    selector: parseSelector(body.selector),
    createdAtMs: Number(body.createdAtMs ?? 0),
  };
}
