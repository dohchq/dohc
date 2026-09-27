import type { TokenBucketLimiter } from "@dohc/service-http";
import { createAccountlessPathProjection } from "./accountlessPathProjection";
import {
  DiscussionActivityCapacityError,
  linkLogWaitGroup,
  type DiscussionActivityHub,
} from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import type { createLinkResponseStreams } from "./linkResponseStreams";
import type { LinkEgressRateLimiter, ValidatedLinkCapability } from "./linkSecurity";
import { assertSha256, parseCursor, parseLimit } from "./requestInputs";
import { targetVersionId } from "./shareFilter";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import { MAX_BLOB_BYTES, MAX_DISCUSSION_ACTIVITY_HOLD_MS } from "./wireLimits";

export type LinkReadRoute =
  | { route: "link-share" }
  | { route: "link-current" }
  | { route: "link-log" }
  | { route: "link-blob"; sha256: string };

export function createLinkReadRoutes(
  storage: Pick<
    SyncRelayStorage,
    | "getShare"
    | "getShareLabels"
    | "getEpochLogFloor"
    | "readCurrentFileState"
    | "currentFileBlobByteLength"
    | "getBlob"
  >,
  nowMs: () => number,
  linkCurrentFileLimit: number,
  requireLinkRead: (
    request: Request,
    capabilityRateLimiter: TokenBucketLimiter,
    grantRateLimiter: TokenBucketLimiter,
  ) => { capabilityToken: string; capability: ValidatedLinkCapability },
  requireFreshLinkRead: (
    capabilityToken: string,
    expected: { shareId: string; grantId: string; generation: number },
  ) => ValidatedLinkCapability,
  linkJsonResponse: (shareId: string, grantId: string, body: unknown) => Response,
  filteredLogPage: ReturnType<typeof createShareReadQueries>["filteredLogPage"],
  newestFilteredOpFreshness: ReturnType<typeof createShareReadQueries>["newestFilteredOpFreshness"],
  linkRevisionByteLength: ReturnType<typeof createShareReadQueries>["linkRevisionByteLength"],
  linkReadRateLimiter: TokenBucketLimiter,
  linkGrantReadRateLimiter: TokenBucketLimiter,
  linkLogReadRateLimiter: TokenBucketLimiter,
  linkGrantLogReadRateLimiter: TokenBucketLimiter,
  linkGrantEgressRateLimiter: Pick<LinkEgressRateLimiter, "reserve">,
  discussionActivity: Pick<DiscussionActivityHub, "wait">,
  admitLinkBlobBytes: (grantId: string, byteLength: number) => (() => void) | null,
  respondWithLinkBytes: ReturnType<typeof createLinkResponseStreams>["respondWithLinkBytes"],
) {
  return async function respondToLinkRead(
    request: Request,
    route: LinkReadRoute,
  ): Promise<Response> {
    const capabilityRateLimiter =
      route.route === "link-log" ? linkLogReadRateLimiter : linkReadRateLimiter;
    const grantRateLimiter =
      route.route === "link-log"
        ? linkGrantLogReadRateLimiter
        : linkGrantReadRateLimiter;
    const { capabilityToken, capability } = requireLinkRead(
      request,
      capabilityRateLimiter,
      grantRateLimiter,
    );
    if (request.method !== "GET") throw relayError("method_not_allowed");
    const share = storage.getShare(capability.shareId);
    if (!share) throw notFound();

    if (route.route === "link-share") {
      const epochLogFloor = storage.getEpochLogFloor(share.workspaceId);
      const freshness = newestFilteredOpFreshness(
        share.workspaceId,
        capability.effectiveSelector,
        epochLogFloor,
      );
      const fresh = requireFreshLinkRead(capabilityToken, capability);
      const presentation = createAccountlessPathProjection(
        fresh.effectiveSelector,
      );
      return linkJsonResponse(fresh.shareId, fresh.grantId, {
        ok: true,
        effectiveSelector: presentation.selector,
        access: fresh.access,
        subjectName: storage.getShareLabels(fresh.shareId).subjectName,
        ...freshness,
      });
    }

    if (route.route === "link-current") {
      const snapshot = storage.readCurrentFileState({
        workspaceId: share.workspaceId,
        versionId: targetVersionId(capability.effectiveSelector),
        selectorPaths: capability.effectiveSelector.paths,
        limit: linkCurrentFileLimit,
      });
      if (snapshot.tooMany) throw notFound();
      const freshness = newestFilteredOpFreshness(
        share.workspaceId,
        capability.effectiveSelector,
        snapshot.epochLogFloor,
      );
      const fresh = requireFreshLinkRead(capabilityToken, capability);
      const presentation = createAccountlessPathProjection(
        fresh.effectiveSelector,
      );
      const files = snapshot.files.map((file) => {
        const path = presentation.projectPath(file.path);
        if (path === null) throw notFound();
        return {
          path,
          blobSha256: file.blobSha256,
          contentKind: file.contentKind,
        };
      });
      return linkJsonResponse(fresh.shareId, fresh.grantId, {
        ok: true,
        effectiveSelector: presentation.selector,
        access: fresh.access,
        subjectName: storage.getShareLabels(fresh.shareId).subjectName,
        files,
        nextCursor: snapshot.nextCursor,
        epochLogFloor: snapshot.epochLogFloor,
        ...freshness,
      });
    }

    const epochLogFloor = storage.getEpochLogFloor(share.workspaceId);
    if (route.route === "link-log") {
      const url = new URL(request.url);
      const requestedSince = parseCursor(url.searchParams.get("since"));
      const since = Math.max(requestedSince, epochLogFloor);
      const limit = parseLimit(url.searchParams.get("limit"));
      const hold = parseLinkLogHold(url.searchParams.get("hold"));
      let page = filteredLogPage(
        share.workspaceId,
        capability.effectiveSelector,
        since,
        limit,
        "accountless",
      );
      if (
        hold > 0 &&
        page.ops.length === 0 &&
        page.hasMore === false &&
        page.nextCursor === since
      ) {
        const deadlineAtMs = Date.now() + hold;
        let scanSince = since;
        for (;;) {
          requireFreshLinkRead(capabilityToken, capability);
          const remainingHoldMs = Math.max(0, deadlineAtMs - Date.now());
          if (remainingHoldMs === 0) break;
          try {
            await discussionActivity.wait(
              linkLogWaitGroup(share.workspaceId),
              `link:${capability.session.capabilityHash}`,
              {
                holdMs: remainingHoldMs,
                signal: request.signal,
                shouldPark: () => {
                  try {
                    const fresh = requireFreshLinkRead(
                      capabilityToken,
                      capability,
                    );
                    const currentEpochLogFloor = storage.getEpochLogFloor(
                      share.workspaceId,
                    );
                    if (currentEpochLogFloor !== epochLogFloor) return false;
                    const checked = filteredLogPage(
                      share.workspaceId,
                      fresh.effectiveSelector,
                      scanSince,
                      limit,
                      "accountless",
                    );
                    if (checked.ops.length > 0 || checked.hasMore) return false;
                    scanSince = checked.nextCursor;
                    return true;
                  } catch {
                    return false;
                  }
                },
              },
            );
          } catch (error) {
            if (error instanceof DiscussionActivityCapacityError) {
              throw relayError("link_read_rate_limited");
            }
            throw error;
          }

          const fresh = requireFreshLinkRead(capabilityToken, capability);
          const currentEpochLogFloor = storage.getEpochLogFloor(
            share.workspaceId,
          );
          page = filteredLogPage(
            share.workspaceId,
            fresh.effectiveSelector,
            Math.max(scanSince, currentEpochLogFloor),
            limit,
            "accountless",
          );
          scanSince = page.nextCursor;
          if (
            page.ops.length > 0 ||
            page.hasMore ||
            currentEpochLogFloor !== epochLogFloor ||
            Date.now() >= deadlineAtMs ||
            request.signal.aborted
          ) {
            requireFreshLinkRead(capabilityToken, capability);
            return linkJsonResponse(capability.shareId, capability.grantId, {
              ok: true,
              ...page,
              epochLogFloor: currentEpochLogFloor,
            });
          }
        }
        const fresh = requireFreshLinkRead(capabilityToken, capability);
        const currentEpochLogFloor = storage.getEpochLogFloor(
          share.workspaceId,
        );
        page = filteredLogPage(
          share.workspaceId,
          fresh.effectiveSelector,
          Math.max(scanSince, currentEpochLogFloor),
          limit,
          "accountless",
        );
        requireFreshLinkRead(capabilityToken, capability);
        return linkJsonResponse(capability.shareId, capability.grantId, {
          ok: true,
          ...page,
          epochLogFloor: currentEpochLogFloor,
        });
      }
      requireFreshLinkRead(capabilityToken, capability);
      return linkJsonResponse(capability.shareId, capability.grantId, {
        ok: true,
        ...page,
        epochLogFloor,
      });
    }

    assertSha256(route.sha256);
    // A current file first, then an earlier revision of a file still in the share.
    const byteLength = storage.currentFileBlobByteLength({
      workspaceId: share.workspaceId,
      versionId: targetVersionId(capability.effectiveSelector),
      selectorPaths: capability.effectiveSelector.paths,
      sha256: route.sha256,
      epochLogFloor,
    }) ?? linkRevisionByteLength(
      share.workspaceId,
      capability.effectiveSelector,
      route.sha256,
      epochLogFloor,
    );
    if (
      byteLength === null ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > MAX_BLOB_BYTES
    ) {
      throw notFound();
    }
    const releaseBytes = admitLinkBlobBytes(
      capability.grantId,
      byteLength,
    );
    if (!releaseBytes) throw relayError("link_read_rate_limited");
    const settleEgress = linkGrantEgressRateLimiter.reserve(
      capability.grantId,
      byteLength,
      nowMs(),
    );
    if (!settleEgress) {
      releaseBytes();
      throw relayError("link_read_rate_limited");
    }
    let streamOwnsAdmission = false;
    try {
      const blob = storage.getBlob(share.workspaceId, route.sha256);
      if (!blob || blob.byteLength !== byteLength) throw notFound();
      requireFreshLinkRead(capabilityToken, capability);
      const response = respondWithLinkBytes(
        blob,
        capability.shareId,
        capability.grantId,
        releaseBytes,
        settleEgress,
        {
          "content-length": String(byteLength),
          "content-type": "application/octet-stream",
        },
      );
      streamOwnsAdmission = true;
      return response;
    } finally {
      if (!streamOwnsAdmission) {
        releaseBytes();
        settleEgress(0, nowMs());
      }
    }
  };
}

function parseLinkLogHold(value: string | null): number {
  if (value === null) return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw badRequest("hold must be a non-negative integer");
  }
  const hold = Number(value);
  if (
    !Number.isSafeInteger(hold) ||
    hold < 0 ||
    hold > MAX_DISCUSSION_ACTIVITY_HOLD_MS
  ) {
    throw badRequest(
      `hold must be a non-negative integer no greater than ${String(MAX_DISCUSSION_ACTIVITY_HOLD_MS)}`,
    );
  }
  return hold;
}
