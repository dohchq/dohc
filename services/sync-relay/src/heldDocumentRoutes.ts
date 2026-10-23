import { createHash } from "node:crypto";
import type { HeldDocumentInspection, HostedSyncMethodResultMap } from "@dohc/workspace-engine-client/relay-wire";
import { badRequest, notFound, relayError } from "./errors";
import type { SyncRelayStorage } from "./storage";
import { MAX_BLOB_BYTES, MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";

export type HeldDocumentsPage = HostedSyncMethodResultMap["sync.heldDocuments"];
export type { HeldDocumentInspection };

/** The session host's read-only view of the documents its hosted replica holds for released retained work. */
export type HeldDocumentHost = {
  /** Null when the workspace has no hosted replica on this host. */
  heldDocuments(workspaceId: string, page: {afterObjectId?: string; limit: number}, signal?: AbortSignal): Promise<HeldDocumentsPage | null>;
  /**
   * Null when the document is not held for released retained work, or its workspace is not hosted here.
   * A complete preservation carries its whole Markdown, however long.
   */
  heldDocument(workspaceId: string, objectId: string, signal?: AbortSignal): Promise<HeldDocumentInspection | null>;
};
export type HeldDocumentRoute = {route: "held-documents"; workspaceId: string; objectId?: string; markdown?: true};

/** The largest page the engine answers. */
export const MAX_HELD_DOCUMENTS_PAGE = 256;
const DEFAULT_HELD_DOCUMENTS_PAGE = 50;
export const MAX_HELD_OBJECT_ID_CHARS = 512;
const DIGEST = /^[0-9a-f]{64}$/;

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

/** Which inspected text a Markdown read asks for: the binding it was inspected under, and its digest. */
function markdownQuery(url: URL): {bindingDigest: string; sha256: string} {
  const keys = [...url.searchParams.keys()].sort();
  const bindingDigest = url.searchParams.get("bindingDigest"), sha256 = url.searchParams.get("sha256");
  if (keys.join() !== "bindingDigest,sha256" || !DIGEST.test(bindingDigest ?? "") || !DIGEST.test(sha256 ?? "")) {
    throw badRequest("Invalid held document Markdown query.");
  }
  return {bindingDigest: bindingDigest!, sha256: sha256!};
}

/**
 * `inspected` with the Markdown the engine streamed in place of the in-band
 * text it left out. The stream must be the text the result names.
 */
export function withStreamedMarkdown(inspected: HeldDocumentInspection, streamed: Uint8Array | undefined): HeldDocumentInspection {
  const preservation = inspected.preservation;
  if (preservation?.status !== "complete" || preservation.markdown !== null) return inspected;
  if (!streamed || streamed.length !== preservation.markdownByteLength ||
    createHash("sha256").update(streamed).digest("hex") !== preservation.markdownSha256) {
    throw new Error("Held document Markdown does not match its inspection.");
  }
  const markdown = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(streamed);
  return {...inspected, preservation: {...preservation, markdown}};
}

/** The inspection as the JSON route answers it: Markdown above the in-band limit is read from its own route. */
function inband(inspected: HeldDocumentInspection): HeldDocumentInspection {
  const preservation = inspected.preservation;
  if (preservation?.markdown == null || preservation.markdownByteLength! <= preservation.inbandLimitBytes) return inspected;
  return {...inspected, preservation: {...preservation, markdown: null}};
}

/**
 * `GET /sync/:workspaceId/held-documents`, `.../held-documents/:objectId` and
 * `.../held-documents/:objectId/markdown`: the workspace's owner, or an agent
 * acting with the owner's credential, reads what the session host holds for
 * retained work and what it preserves. Authority comes from the
 * authenticated owner alone. The host's read yields, so ownership and the
 * answering host must still hold before anything is returned; anything else
 * answers as if nothing were there.
 *
 * The Markdown route answers the whole text of a current, complete
 * preservation, only while the binding and digest the caller inspected
 * still name it.
 */
export function createHeldDocumentRoutes(options: {storage: SyncRelayStorage; host(): HeldDocumentHost | undefined}) {
  return async (request: Request, route: HeldDocumentRoute, ownerUserId: string) => {
    const {storage} = options;
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    if (request.method !== "GET") throw relayError("method_not_allowed");
    const {objectId} = route, url = new URL(request.url);
    // Read the query before asking the host, so a bad query asks nothing.
    const query = objectId === undefined ? page(url) : null;
    const wanted = route.markdown ? markdownQuery(url) : null;
    if (objectId !== undefined && !route.markdown && url.search) throw badRequest("Invalid held document query.");
    const host = options.host();
    if (!host) throw notFound();
    const signal = AbortSignal.any([request.signal, storage.unavailable]);
    const answered = objectId !== undefined
      ? await host.heldDocument(route.workspaceId, objectId, signal)
      : await host.heldDocuments(route.workspaceId, query ?? page(url), signal);
    signal.throwIfAborted();
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId) || options.host() !== host || answered === null) throw notFound();
    const headers = {"cache-control": "private, no-store"};
    if (wanted) {
      const inspected = answered as HeldDocumentInspection, preservation = inspected.preservation;
      if (inspected.status !== "current" || inspected.bindingDigest !== wanted.bindingDigest ||
        preservation?.status !== "complete" || preservation.markdown === null || preservation.markdownSha256 !== wanted.sha256) throw notFound();
      const bytes = Buffer.from(preservation.markdown, "utf8");
      if (bytes.length > MAX_BLOB_BYTES) throw relayError("payload_too_large", "Held document Markdown exceeds the blob limit.");
      return new Response(bytes, {status: 200, headers: {...headers, "content-type": "text/markdown; charset=utf-8"}});
    }
    const body = JSON.stringify(objectId !== undefined ? inband(answered as HeldDocumentInspection) : answered);
    if (Buffer.byteLength(body) > MAX_PAYLOAD_JSON_BYTES) throw relayError("payload_too_large", "Held document details exceed the metadata limit.");
    return new Response(body, {status: 200, headers: {...headers, "content-type": "application/json"}});
  };
}
