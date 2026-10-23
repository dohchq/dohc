import type { HeldDocumentInspection, HostedSyncMethodResultMap } from "@dohc/workspace-engine-client/relay-wire";
import { badRequest, notFound, relayError } from "./errors";
import type { SyncRelayStorage } from "./storage";
import { MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";

export type HeldDocumentsPage = HostedSyncMethodResultMap["sync.heldDocuments"];
export type { HeldDocumentInspection };

/** The session host's read-only view of the documents its hosted replica holds for released retained work. */
export type HeldDocumentHost = {
  /** Null when the workspace has no hosted replica on this host. */
  heldDocuments(workspaceId: string, page: {afterObjectId?: string; limit: number}, signal?: AbortSignal): Promise<HeldDocumentsPage | null>;
  /** Null when the document is not held for released retained work, or its workspace is not hosted here. */
  heldDocument(workspaceId: string, objectId: string, signal?: AbortSignal): Promise<HeldDocumentInspection | null>;
};
export type HeldDocumentRoute = {route: "held-documents"; workspaceId: string; objectId?: string};

/** The largest page the engine answers. */
export const MAX_HELD_DOCUMENTS_PAGE = 256;
const DEFAULT_HELD_DOCUMENTS_PAGE = 50;
export const MAX_HELD_OBJECT_ID_CHARS = 512;

function page(url: URL): {afterObjectId?: string; limit: number} {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== "after" && key !== "limit") || new Set(keys).size !== keys.length) throw badRequest("Invalid held documents query.");
  const after = url.searchParams.get("after"), limit = url.searchParams.get("limit");
  const parsed = limit === null ? DEFAULT_HELD_DOCUMENTS_PAGE : Number(limit);
  if (!/^[1-9][0-9]*$/.test(limit ?? "1") || !Number.isSafeInteger(parsed) || parsed > MAX_HELD_DOCUMENTS_PAGE) {
    throw badRequest("Invalid held documents limit.");
  }
  if (after !== null && (after.length === 0 || after.length > MAX_HELD_OBJECT_ID_CHARS)) throw badRequest("Invalid held documents cursor.");
  return {...(after === null ? {} : {afterObjectId: after}), limit: parsed};
}

/**
 * `GET /sync/:workspaceId/held-documents` and `.../held-documents/:objectId`:
 * the workspace's owner, or an agent acting with the owner's credential,
 * reads what the session host holds for retained work and what it preserves.
 * Authority comes from the authenticated owner alone. The host's read yields,
 * so ownership and the answering host must still hold before anything is
 * returned; anything else answers as if nothing were there.
 */
export function createHeldDocumentRoutes(options: {storage: SyncRelayStorage; host(): HeldDocumentHost | undefined}) {
  return async (request: Request, route: HeldDocumentRoute, ownerUserId: string) => {
    const {storage} = options;
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    if (request.method !== "GET") throw relayError("method_not_allowed");
    const {objectId} = route, url = new URL(request.url);
    // Read the page before asking the host, so a bad query asks nothing.
    const query = objectId === undefined ? page(url) : null;
    if (objectId !== undefined && url.search) throw badRequest("Invalid held document query.");
    const host = options.host();
    if (!host) throw notFound();
    const signal = AbortSignal.any([request.signal, storage.unavailable]);
    const answered = objectId !== undefined
      ? await host.heldDocument(route.workspaceId, objectId, signal)
      : await host.heldDocuments(route.workspaceId, query ?? page(url), signal);
    signal.throwIfAborted();
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId) || options.host() !== host || answered === null) throw notFound();
    const body = JSON.stringify(answered);
    if (Buffer.byteLength(body) > MAX_PAYLOAD_JSON_BYTES) throw relayError("payload_too_large", "Held document details exceed the metadata limit.");
    return new Response(body, {status: 200, headers: {"content-type": "application/json", "cache-control": "private, no-store"}});
  };
}
