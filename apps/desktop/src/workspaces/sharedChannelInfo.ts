import {
  isChatShareAccessValue,
  type ChatShareAccess,
} from "@dohc/security-contract/share-grant";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";

export interface SharedChannelInfo {
  shareId: string;
  granterUserId: string;
  granterEmail: string | null;
  channelWireId: string;
  access: ChatShareAccess;
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
  return response;
}

export async function fetchSharedChannelInfo(input: {
  relay: SyncRelayConnection;
  shareId: string;
}): Promise<SharedChannelInfo> {
  const response = await shareFetch(
    input.relay,
    `/sync/shares/${encodeURIComponent(input.shareId)}`,
  );
  if (!response.ok) throw new Error(`Share request failed (${response.status})`);
  const body = (await response.json()) as Record<string, unknown>;
  const selector =
    body.selector && typeof body.selector === "object" && !Array.isArray(body.selector)
      ? (body.selector as Record<string, unknown>)
      : {};
  if (
    selector.kind !== "chat-channel" ||
    typeof selector.channelWireId !== "string" ||
    selector.channelWireId.length === 0 ||
    !isChatShareAccessValue(body.access)
  ) {
    throw new ShareUnavailableError();
  }
  return {
    shareId: String(body.shareId ?? input.shareId),
    granterUserId: String(body.granterUserId ?? ""),
    granterEmail: typeof body.granterEmail === "string" ? body.granterEmail : null,
    channelWireId: selector.channelWireId,
    access: body.access,
    createdAtMs: Number(body.createdAtMs ?? 0),
  };
}
