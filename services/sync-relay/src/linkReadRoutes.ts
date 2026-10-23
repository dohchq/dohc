import { createReceivedIdentity } from "./receivedIdentity";
import type { TokenBucketLimiter } from "@dohc/service-http";
import { createAccountlessPathProjection } from "./accountlessPathProjection";
import {
  DiscussionActivityCapacityError,
  linkLogWaitGroup,
  type DiscussionActivityHub,
} from "./discussionActivity";
import { notFound, relayError, RelayError } from "./errors";
import type { createLinkResponseStreams } from "./linkResponseStreams";
import type { LinkEgressRateLimiter, ValidatedLinkCapability } from "./linkSecurity";
import { assertSha256, parseCursor, parseLimit, parseLinkLogHold } from "./requestInputs";
import { authorizeLinkChatAction } from "./shareAuthorization";
import { targetVersionId } from "./shareFilter";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import { MAX_BLOB_BYTES } from "./wireLimits";

export type LinkReadRoute =
  | { route: "link-share" }
  | { route: "link-current" }
  | { route: "link-log" }
  | { route: "link-blob"; sha256: string };

export function createLinkReadRoutes(
  storage: Pick<
    SyncRelayStorage,
    | "findChannelCreateKind"
    | "getShare"
    | "getShareGrant"
    | "getShareLabels"
    | "workspaceIsOwnedBy"
    | "getEpochLogFloor"
    | "readCurrentFileState"
    | "currentFileBlobByteLength"
    | "getBlob"
    | "automationSwitchableFolder"
    | "currentFileObjectId"
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
  linkKey?: string | Uint8Array,
  replica?:ReturnType<SyncRelayStorage["createReplicaLinkReadService"]>,
) {
  const identity = createReceivedIdentity(linkKey);
  // A Group link also reads, or with read-write access posts in, the Group's
  // channel. The share's answer and its files' answer both name it.
  const linkChannel = (grantId: string) => {
    const group = authorizeLinkChatAction({ storage, grantId, action: "read" });
    return group.ok ? { channel: { channelWireId: group.effectiveSelector.channelWireId, access: group.effectiveSelector.access } } : {};
  };
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
        receivedSource: identity.source(["link", fresh.grantId], share.workspaceId),
        effectiveSelector: presentation.selector,
        access: fresh.access,
        subjectName: storage.getShareLabels(fresh.shareId).subjectName,
        ...linkChannel(fresh.grantId),
        ...freshness,
      });
    }

    if (route.route === "link-current") {
      if(replica) {
        const body=replica.inventory({grantId:capability.grantId,generation:capability.generation},
          ()=>requireFreshLinkRead(capabilityToken,capability),new URL(request.url).searchParams.get("collectionPath"));
        if(body.files.length>linkCurrentFileLimit)throw notFound();
        return linkJsonResponse(capability.shareId,capability.grantId,{...body,...linkChannel(capability.grantId)});
      }
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
      const requestedFolder = new URL(request.url).searchParams.get("collectionPath");
      const files = snapshot.files.map((file) => {
        const path = presentation.projectPath(file.path);
        if (path === null) throw notFound();
        return {
          path,
          objectId: identity.object(["link", fresh.grantId], share.workspaceId, storage.currentFileObjectId({ workspaceId: share.workspaceId, versionId: targetVersionId(fresh.effectiveSelector), path: file.path })),
          blobSha256: file.blobSha256,
          contentKind: file.contentKind,
          ...(requestedFolder !== null && path === `${requestedFolder}/automations.yaml` ? { automationSwitchable: fresh.access === "edit"
            && fresh.effectiveSelector.versionId === null
            && fresh.effectiveSelector.paths.some(root => file.path.slice(0, -"/automations.yaml".length) === root
              || file.path.startsWith(`${root}/`))
            && storage.automationSwitchableFolder(share.workspaceId, file.path.slice(0, -"/automations.yaml".length)) } : {}),
        };
      });
      return linkJsonResponse(fresh.shareId, fresh.grantId, {
        ok: true,
        effectiveSelector: presentation.selector,
        access: fresh.access,
        subjectName: storage.getShareLabels(fresh.shareId).subjectName,
        ...linkChannel(fresh.grantId),
        files,
        nextCursor: snapshot.nextCursor,
        epochLogFloor: snapshot.epochLogFloor,
        ...freshness,
      });
    }

    const epochLogFloor = storage.getEpochLogFloor(share.workspaceId);
    if (route.route === "link-log") {
      const url = new URL(request.url);
      const currentOnly = url.searchParams.get("current") === "true";
      if(replica && currentOnly) {
        const input={grantId:capability.grantId,generation:capability.generation};
        let since=parseCursor(url.searchParams.get("since"));
        if(!Number.isSafeInteger(since))throw notFound();
        const limit=parseLimit(url.searchParams.get("limit")),hold=parseLinkLogHold(url.searchParams.get("hold"));
        const deadline=Date.now()+hold;
        const read=()=>replica.feed(input,()=>requireFreshLinkRead(capabilityToken,capability),since,limit);
        let page=read();
        while(hold>0 && !page.ops.length && !page.hasMore && Date.now()<deadline && !request.signal.aborted) {
          since=page.nextCursor;
          try {
            await discussionActivity.wait(linkLogWaitGroup(share.workspaceId),`link:${capability.session.capabilityHash}`,{
              holdMs:Math.max(0,deadline-Date.now()),signal:request.signal,shouldPark:()=>{
                try {const checked=read();return !checked.ops.length && !checked.hasMore;}catch{return false;}
              }});
          }catch(error) {
            if(error instanceof DiscussionActivityCapacityError)throw relayError("link_read_rate_limited");
            throw error;
          }
          page=read();
        }
        return linkJsonResponse(capability.shareId,capability.grantId,{ok:true,...page});
      }
      if (!currentOnly && capability.access !== "edit") throw notFound();
      const freshRead = () => {
        const fresh = requireFreshLinkRead(capabilityToken, capability);
        if (!currentOnly && fresh.access !== "edit") throw notFound();
        return fresh;
      };
      const requestedSince = parseCursor(url.searchParams.get("since"));
      const since = Math.max(requestedSince, epochLogFloor);
      const limit = parseLimit(url.searchParams.get("limit"));
      const hold = parseLinkLogHold(url.searchParams.get("hold"));
      let page = filteredLogPage(
        share.workspaceId,
        share.shareId,
        capability.effectiveSelector,
        since,
        limit,
        "accountless",

        undefined,

        ["link", capability.grantId],
        currentOnly,
        epochLogFloor,
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
          freshRead();
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
                    const fresh = freshRead();
                    const currentEpochLogFloor = storage.getEpochLogFloor(
                      share.workspaceId,
                    );
                    if (currentEpochLogFloor !== epochLogFloor) return false;
                    const checked = filteredLogPage(
                      share.workspaceId,
                      share.shareId,
                      fresh.effectiveSelector,
                      scanSince,
                      limit,
                      "accountless",

                      undefined,

                      ["link", capability.grantId],
                      currentOnly,
                      currentEpochLogFloor,
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

          const fresh = freshRead();
          const currentEpochLogFloor = storage.getEpochLogFloor(
            share.workspaceId,
          );
          page = filteredLogPage(
            share.workspaceId,
            share.shareId,
            fresh.effectiveSelector,
            Math.max(scanSince, currentEpochLogFloor),
            limit,
            "accountless",

            undefined,

            ["link", capability.grantId],
            currentOnly,
            currentEpochLogFloor,
          );
          scanSince = page.nextCursor;
          if (
            page.ops.length > 0 ||
            page.hasMore ||
            currentEpochLogFloor !== epochLogFloor ||
            Date.now() >= deadlineAtMs ||
            request.signal.aborted
          ) {
            freshRead();
            return linkJsonResponse(capability.shareId, capability.grantId, {
              ok: true,
              ...page,
              epochLogFloor: currentEpochLogFloor,
            });
          }
        }
        const fresh = freshRead();
        const currentEpochLogFloor = storage.getEpochLogFloor(
          share.workspaceId,
        );
        page = filteredLogPage(
          share.workspaceId,
          share.shareId,
          fresh.effectiveSelector,
          Math.max(scanSince, currentEpochLogFloor),
          limit,
          "accountless",

          undefined,

          ["link", capability.grantId],
          currentOnly,
          currentEpochLogFloor,
        );
        freshRead();
        return linkJsonResponse(capability.shareId, capability.grantId, {
          ok: true,
          ...page,
          epochLogFloor: currentEpochLogFloor,
        });
      }
      freshRead();
      return linkJsonResponse(capability.shareId, capability.grantId, {
        ok: true,
        ...page,
        epochLogFloor,
      });
    }

    assertSha256(route.sha256);
    const replicaInput={grantId:capability.grantId,generation:capability.generation};
    const readReplicaBlob=(includeBytes=true)=>replica!.blob(replicaInput,()=>requireFreshLinkRead(capabilityToken,capability),route.sha256,includeBytes);
    let historicalByteLength:number|null|undefined;
    const historicalLength=()=>historicalByteLength===undefined ? historicalByteLength=capability.access === "edit" ? linkRevisionByteLength(
      share.workspaceId,capability.effectiveSelector,route.sha256,epochLogFloor) : null : historicalByteLength;
    let replicaMetadata:ReturnType<typeof readReplicaBlob>=null;
    if(replica) {
      try {replicaMetadata=readReplicaBlob(false);}
      catch(error) {if(!(error instanceof RelayError) || error.code!=="link_read_rate_limited" || historicalLength()===null)throw error;}
    }
    // A current file first, then an earlier revision of a file still in the share.
    const currentByteLength = replica ? replicaMetadata?.byteLength ?? null : storage.currentFileBlobByteLength({
      workspaceId: share.workspaceId,
      versionId: targetVersionId(capability.effectiveSelector),
      selectorPaths: capability.effectiveSelector.paths,
      sha256: route.sha256,
      epochLogFloor,
    });
    const byteLength = currentByteLength ?? historicalLength();
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
      const replicaBlob=replicaMetadata ? readReplicaBlob() : null;
      const blob = replicaMetadata ? replicaBlob?.bytes : storage.getBlob(share.workspaceId, route.sha256);
      if (!blob || blob.byteLength !== byteLength) throw notFound();
      const fresh = requireFreshLinkRead(capabilityToken, capability);
      if (currentByteLength === null && fresh.access !== "edit") throw notFound();
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
        replicaBlob ? {signal:request.signal,guard:replicaBlob.guard} : undefined,
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
