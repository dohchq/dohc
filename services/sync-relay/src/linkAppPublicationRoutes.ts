import type { AppPublicationLimits } from "@dohc/security-contract/app-publication";
import type { PublicEditRelease } from "@dohc/security-contract";
import type { TokenBucketLimiter } from "@dohc/service-http";
import { badRequest, notFound, relayError } from "./errors";
import { hashLinkProfileSecret, type ValidatedLinkCapability, LinkEgressRateLimiter } from "./linkSecurity";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import type { createLinkResponseStreams } from "./linkResponseStreams";
import type { SyncRelayStorage } from "./storage";
import { MAX_BLOB_BYTES } from "./wireLimits";

export type LinkAppPublicationRoute = {route: "link-app-publication"; publicationId?: string; sha256?: string};

export function createLinkAppPublicationRoutes(options: {
  storage: SyncRelayStorage;
  limits?: AppPublicationLimits;
  linkKey: string | Uint8Array;
  publicEditRelease?: PublicEditRelease;
  nowMs(): number;
  requireLinkRead(request: Request, capabilityLimiter: TokenBucketLimiter, grantLimiter: TokenBucketLimiter): {
    capabilityToken: string; capability: ValidatedLinkCapability;
  };
  capabilityLimiter: TokenBucketLimiter;
  grantLimiter: TokenBucketLimiter;
  egress: Pick<LinkEgressRateLimiter, "reserve">;
  streams: Pick<ReturnType<typeof createLinkResponseStreams>, "admitLinkBlobBytes" | "respondWithLinkBytes">;
}) {
  const limits = options.limits && {...options.limits};
  return (request: Request, route: LinkAppPublicationRoute): Response => {
    if (!limits || request.headers.has("cookie")) throw notFound();
    const {capability} = options.requireLinkRead(request, options.capabilityLimiter, options.grantLimiter);
    const profileSecret = request.headers.get("x-dohc-link-profile-secret");
    if (profileSecret === null || !LINK_SECRET_PATTERN.test(profileSecret)) throw notFound();
    if (request.method !== "GET") throw relayError("method_not_allowed");
    const query = new URL(request.url).searchParams;
    if (route.publicationId === undefined) {
      if ([...query.keys()].some(key => key !== "cursor") || query.getAll("cursor").length > 1) throw badRequest("Invalid publication query.");
      const cursor = query.get("cursor") ?? undefined;
      if (cursor !== undefined && !/^[0-9a-f]{64}$/.test(cursor)) throw badRequest("Invalid publication cursor.");
      const input = {capabilityHash: capability.session.capabilityHash, profileTokenHash: hashLinkProfileSecret(profileSecret, options.linkKey),
        limits, publicEditRelease: options.publicEditRelease, cursor};
      const signal = AbortSignal.any([request.signal, options.storage.unavailable]);signal.throwIfAborted();
      const {page, assertCurrent} = options.storage.listLinkAppPublications({...input, nowMs: options.nowMs()});

      const body = JSON.stringify(page), bytes = new TextEncoder().encode(body);
      const release = options.streams.admitLinkBlobBytes(capability.grantId, bytes.byteLength);
      if (!release) throw relayError("link_read_rate_limited");
      const settle = options.egress.reserve(capability.grantId, bytes.byteLength, options.nowMs());
      if (!settle) {release();throw relayError("link_read_rate_limited");}
      try {
        return options.streams.respondWithLinkBytes(bytes, capability.shareId, capability.grantId, release, settle,
          {"content-type": "application/json", "content-length": String(bytes.byteLength), "cache-control": "private, no-store", "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff"},
          {signal, guard() {signal.throwIfAborted();assertCurrent(options.nowMs());}});
      } catch (error) {release();settle(0, options.nowMs());throw error;}
    }
    if ([...query.keys()].some(key => key !== "authorityRevision") || query.getAll("authorityRevision").length > 1) throw badRequest("Invalid publication query.");
    const rawRevision = query.get("authorityRevision");
    const expectedAuthorityRevision = rawRevision === null ? undefined : Number(rawRevision);
    if ((route.sha256 && expectedAuthorityRevision === undefined) ||
        (rawRevision !== null && (!/^[1-9]\d*$/.test(rawRevision) || !Number.isSafeInteger(expectedAuthorityRevision)))) {
      throw badRequest("Invalid publication authority revision.");
    }
    const input = {publicationId: route.publicationId, capabilityHash: capability.session.capabilityHash, profileTokenHash: hashLinkProfileSecret(profileSecret, options.linkKey),
      limits, expectedAuthorityRevision, publicEditRelease: options.publicEditRelease};
    const signal = AbortSignal.any([request.signal, options.storage.unavailable]);
    signal.throwIfAborted();
    const admitted = options.storage.authorizeLinkAppPublication({...input, nowMs: options.nowMs()});
    const pinned = {...input, expectedAuthorityRevision: admitted.descriptor.authorityRevision};
    const file = route.sha256 ? admitted.descriptor.files.find(file => file.sha256 === route.sha256) : undefined;
    if (route.sha256 && (!file || file.byteLength > MAX_BLOB_BYTES)) throw notFound();

    const metadata = file ? null : new TextEncoder().encode(JSON.stringify(admitted.descriptor));
    const byteLength = file?.byteLength ?? metadata!.byteLength;
    const retainedByteLength = byteLength + limits.maxMetadataBytes;
    if (!Number.isSafeInteger(retainedByteLength)) throw relayError("link_read_rate_limited");
    const releaseBytes = options.streams.admitLinkBlobBytes(admitted.grantId, retainedByteLength);
    if (!releaseBytes) throw relayError("link_read_rate_limited");
    const settleEgress = options.egress.reserve(admitted.grantId, byteLength, options.nowMs());
    if (!settleEgress) {releaseBytes();throw relayError("link_read_rate_limited");}
    let streamOwnsAdmission = false;
    try {
      const bytes = file ? options.storage.readLinkAppPublicationBlob({...pinned, sha256: file.sha256, nowMs: options.nowMs()}).bytes : metadata!;
      const assertCurrent = options.storage.createLinkAppPublicationGuard({...pinned, nowMs: options.nowMs()});
      const guard = () => {
        signal.throwIfAborted();
        assertCurrent(options.nowMs());
      };
      guard();
      const response = options.streams.respondWithLinkBytes(bytes, admitted.shareId, admitted.grantId, releaseBytes, settleEgress, {
        "content-type": file?.contentType ?? "application/json",
        "content-length": String(byteLength),
        "cache-control": "private, no-store",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      }, {guard, signal});
      streamOwnsAdmission = true;
      return response;
    } finally {
      if (!streamOwnsAdmission) {releaseBytes();settleEgress(0, options.nowMs());}
    }
  };
}
