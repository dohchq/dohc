import { createHash } from "node:crypto";
import type { HeldDocumentInspection, HostedSyncMethodResultMap } from "@dohc/workspace-engine-client/relay-wire";
import { badRequest, notFound, relayError } from "./errors";
import { HeldReadBusyError } from "./liveHostRequests";
import type { SyncRelayStorage } from "./storage";
import { MAX_BLOB_BYTES, MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";

export type HeldDocumentsPage = HostedSyncMethodResultMap["sync.heldDocuments"];
export type { HeldDocumentInspection };

/**
 * The host's registration, or the attachment it read through, ended while it read, so what it read
 * answers no one. Not a failure: the host that read is no longer the one to ask.
 */
export type HeldReadInvalidated = {readonly invalidated: "registration" | "attachment"};

/**
 * An inspection with the contribution artifact the engine streamed for it, exactly the bytes it names;
 * null when the inspection is not current, so it names none.
 */
export type HeldContributionsRead = {inspected: HeldDocumentInspection; contributions: Uint8Array | null};

/** The session host's read-only view of the documents its hosted replica holds for released retained work. */
export type HeldDocumentHost = {
  /** Null when the workspace has no hosted replica on this host. */
  heldDocuments(workspaceId: string, page: {afterObjectId?: string; limit: number}, signal?: AbortSignal):
    Promise<HeldDocumentsPage | HeldReadInvalidated | null>;
  /**
   * Null when the document is not held for released retained work, or its workspace is not hosted here.
   * With `markdown`, a complete preservation carries its whole Markdown, however long; without it, only
   * text within the in-band limit.
   */
  heldDocument(workspaceId: string, objectId: string, read: {markdown: boolean}, signal?: AbortSignal):
    Promise<HeldDocumentInspection | HeldReadInvalidated | null>;
  /** {@link heldDocument} with its contribution artifact, and nothing else, streamed. */
  heldContributions(workspaceId: string, objectId: string, signal?: AbortSignal):
    Promise<HeldContributionsRead | HeldReadInvalidated | null>;
};
export type HeldDocumentRoute = {route: "held-documents"; workspaceId: string; objectId?: string; read?: "markdown" | "contributions"};

/** The largest page the engine answers. */
export const MAX_HELD_DOCUMENTS_PAGE = 256;
const DEFAULT_HELD_DOCUMENTS_PAGE = 50;
export const MAX_HELD_OBJECT_ID_CHARS = 512;
/** The largest contribution artifact answered: the most the engine streams as one blob. */
export const MAX_HELD_CONTRIBUTIONS_BYTES = 64 * 1024 * 1024;
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

/**
 * Which inspected Markdown or contribution artifact a read asks for: the binding it was inspected under,
 * and its digest.
 */
function inspectedQuery(url: URL): {bindingDigest: string; sha256: string} {
  const keys = [...url.searchParams.keys()].sort();
  const bindingDigest = url.searchParams.get("bindingDigest"), sha256 = url.searchParams.get("sha256");
  if (keys.join() !== "bindingDigest,sha256" || !DIGEST.test(bindingDigest ?? "") || !DIGEST.test(sha256 ?? "")) {
    throw badRequest("Invalid held document query.");
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

/**
 * `inspected` with the contribution artifact the engine streamed for it. A
 * current inspection names one, and the stream must be exactly its bytes.
 */
export function withStreamedContributions(inspected: HeldDocumentInspection, streamed: Uint8Array | undefined): HeldContributionsRead {
  const preservation = inspected.preservation;
  if (preservation === null) return {inspected, contributions: null};
  if (!streamed || streamed.length !== preservation.contributionsByteLength ||
    createHash("sha256").update(streamed).digest("hex") !== preservation.contributionsSha256) {
    throw new Error("Held document contributions do not match their inspection.");
  }
  return {inspected, contributions: streamed};
}

/**
 * `GET /sync/:workspaceId/held-documents`, `.../held-documents/:objectId`,
 * `.../held-documents/:objectId/markdown` and `.../contributions`: the
 * workspace's owner, or an agent acting with the owner's credential, reads
 * what the session host holds for retained work and what it preserves.
 * Authority comes from the authenticated owner alone. The host's read
 * yields, so ownership and the answering host must still hold before
 * anything is returned, or a failure is reported; anything else, and a read
 * its host's registration or attachment overtook, answers as if nothing were
 * there.
 *
 * The details leave Markdown above the in-band limit out, and name the
 * binding and the covered and merged contributions only by the contribution
 * artifact's digest. The Markdown route answers the whole text of a current,
 * complete preservation, and the contributions route the artifact of a
 * current one, each only while the binding and digest the caller inspected
 * still name it.
 */
export function createHeldDocumentRoutes(options: {storage: SyncRelayStorage; host(): HeldDocumentHost | undefined}) {
  // One admitted read per owner and workspace. The host's read ends on the request's signal and its own deadline.
  const admitted = new Set<string>();
  return async (request: Request, route: HeldDocumentRoute, ownerUserId: string) => {
    const {storage} = options, slot = JSON.stringify([ownerUserId, route.workspaceId]);
    if (admitted.has(slot)) {
      // A caller who no longer owns the workspace learns nothing from a read still running.
      if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
      throw relayError("held_read_busy");
    }
    admitted.add(slot);
    try {return await respond(request, route, ownerUserId);}
    finally {admitted.delete(slot);}
  };

  async function respond(request: Request, route: HeldDocumentRoute, ownerUserId: string) {
    const {storage} = options;
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    if (request.method !== "GET") throw relayError("method_not_allowed");
    const {objectId, read} = route, url = new URL(request.url);
    // Read the query before asking the host, so a bad query asks nothing.
    const query = objectId === undefined ? page(url) : null;
    const wanted = read ? inspectedQuery(url) : null;
    if (objectId !== undefined && !read && url.search) throw badRequest("Invalid held document query.");
    const host = options.host();
    if (!host) throw notFound();
    const signal = AbortSignal.any([request.signal, storage.unavailable]);
    const standing = () => storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId) && options.host() === host;
    let answered: HeldDocumentsPage | HeldDocumentInspection | HeldContributionsRead | HeldReadInvalidated | null;
    try {
      answered = objectId === undefined ? await host.heldDocuments(route.workspaceId, query ?? page(url), signal)
        : read === "contributions" ? await host.heldContributions(route.workspaceId, objectId, signal)
        : await host.heldDocument(route.workspaceId, objectId, {markdown: read === "markdown"}, signal);
    } catch (error) {
      // A former owner, or a caller of a replaced host, learns nothing from how the read ended.
      if (!standing()) throw notFound();
      if (error instanceof HeldReadBusyError) throw relayError("held_read_busy");
      throw error;
    }
    signal.throwIfAborted();
    if (!standing() || answered === null || "invalidated" in answered) throw notFound();
    const headers = {"cache-control": "private, no-store"};
    if (wanted && read === "contributions") {
      const {inspected, contributions} = answered as HeldContributionsRead;
      if (inspected.status !== "current" || inspected.bindingDigest !== wanted.bindingDigest || contributions === null ||
        inspected.preservation?.contributionsSha256 !== wanted.sha256) throw notFound();
      if (contributions.length > MAX_HELD_CONTRIBUTIONS_BYTES) {
        throw relayError("payload_too_large", "Held document contributions exceed the blob limit.");
      }
      return new Response(Buffer.from(contributions), {status: 200, headers: {...headers, "content-type": "application/json"}});
    }
    if (wanted) {
      const inspected = answered as HeldDocumentInspection, preservation = inspected.preservation;
      if (inspected.status !== "current" || inspected.bindingDigest !== wanted.bindingDigest ||
        preservation?.status !== "complete" || preservation.markdown === null || preservation.markdownSha256 !== wanted.sha256) throw notFound();
      const bytes = Buffer.from(preservation.markdown, "utf8");
      if (bytes.length > MAX_BLOB_BYTES) throw relayError("payload_too_large", "Held document Markdown exceeds the blob limit.");
      return new Response(bytes, {status: 200, headers: {...headers, "content-type": "text/markdown; charset=utf-8"}});
    }
    const body = JSON.stringify(answered);
    if (Buffer.byteLength(body) > MAX_PAYLOAD_JSON_BYTES) throw relayError("payload_too_large", "Held document details exceed the metadata limit.");
    return new Response(body, {status: 200, headers: {...headers, "content-type": "application/json"}});
  }
}
