import { randomBytes } from "node:crypto";
import { createReceivedIdentity } from "./receivedIdentity";
import { accountDisplayName, type LookupUserDisplayName } from "./accountDisplayName";
import type { TokenBucketLimiter } from "@dohc/service-http";
import { visibleSharePath, type ShareAccess } from "@dohc/security-contract/share-selector";
import { createAccountlessPathProjection } from "./accountlessPathProjection";
import {
  DiscussionActivityCapacityError,
  linkLogWaitGroup,
  type DiscussionActivityHub,
} from "./discussionActivity";
import { notFound, relayError, RelayError } from "./errors";
import type { createLinkResponseStreams } from "./linkResponseStreams";
import {
  isMemberRequest,
  type LinkAuthority,
  type LinkAuthorityResolver,
  type LinkJsonResponse,
} from "./linkAuthority";
import { linkRefusal } from "./linkRefusal";
import type { LinkEgressRateLimiter } from "./linkSecurity";
import { assertSha256, parseCursor, parseLimit, parseLinkLogHold } from "./requestInputs";
import { authorizeLinkChatAction } from "./shareAuthorization";
import { pathLevel, targetVersionId, type ShareSelector } from "./shareFilter";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import { MAX_BLOB_BYTES } from "./wireLimits";

export type LinkReadRoute =
  | { route: "link-share" }
  | { route: "link-current" }
  | { route: "link-log" }
  | { route: "link-blob"; sha256: string };

// The current files are read before reach filters them, so the read is capped at this many times the listing limit.
// Past the cap the relay refuses as for an unknown grant: the answer must not say how much work a member cannot see.
const CURRENT_SCAN_FACTOR = 10;

/**
 * A member's level on one file, which varies by folder. An admin reads rule
 * files but edits none, so Edit there reads as Comment, as live editing judges.
 */
function memberFileAccess(files: ShareSelector, path: string): ShareAccess | null {
  const level = pathLevel(files, path);
  return level === "edit" && pathLevel({ ...files, ruleFiles: undefined }, path) !== "edit"
    ? "comment"
    : level;
}

export function createLinkReadRoutes(
  storage: Pick<
    SyncRelayStorage,
    | "findChannelCreateKind"
    | "getShare"
    | "getShareGrant"
    | "getShareLabels"
    | "getWorkspaceMembershipByShare"
    | "workspaceIsOwnedBy"
    | "getEpochLogFloor"
    | "readCurrentFileState"
    | "currentFileBlobByteLength"
    | "getBlob"
    | "automationSwitchableFolder"
    | "currentFileObjectId"
    | "indexReceivedWorkTargets"
    | "workspaceRoleOf"
    | "workspaceLevelChangedBy"
    | "readShareTx"
  >,
  nowMs: () => number,
  linkCurrentFileLimit: number,
  linkAuthority: Pick<LinkAuthorityResolver, "require" | "requireMember" | "fresh">,
  linkJsonResponse: LinkJsonResponse,
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
  replica?: ReturnType<SyncRelayStorage["createReplicaLinkReadService"]>,
  lookupUserDisplayName?: LookupUserDisplayName,
) {
  const identity = createReceivedIdentity(linkKey);
  // A member's answers carry their keyed reach signature. A change tells the browser to read the files again.
  const reachKey = linkKey ?? randomBytes(32);
  const memberReach = (fresh: LinkAuthority) =>
    fresh.credential.kind === "member" &&
    "reach" in fresh.effectiveSelector &&
    fresh.effectiveSelector.reach
      ? { reach: fresh.effectiveSelector.reach.keyedSignature(reachKey) }
      : {};

  // A Group link also reads, or with read-write access posts in, the Group's
  // channel. The share's answer and its files' answer both name it.
  const linkChannel = (grantId: string) => {
    const group = authorizeLinkChatAction({ storage, grantId, action: "read" });
    return group.ok
      ? {
          channel: {
            channelWireId: group.effectiveSelector.channelWireId,
            access: group.effectiveSelector.access,
          },
        }
      : {};
  };
  // A membership's share names its workspace; a link's share keeps its own label.
  // A member reads the label's file links through their own fresh reach.
  const subjectName = (shareId: string, request: Request, readerFiles: ShareSelector) =>
    storage.getShareLabels(shareId, isMemberRequest(request) ? "member" : "link", readerFiles)
      .subjectName ??
    (isMemberRequest(request)
      ? storage.getWorkspaceMembershipByShare(shareId)?.workspaceName
      : null) ??
    null;
  // A member hears who last set the members' level, named from the relay's own record of the change.
  const levelChangedBy = async (workspaceId: string, userId: string) => {
    if (storage.workspaceRoleOf(workspaceId, userId)?.role !== "member") return {};
    const changedBy = storage.workspaceLevelChangedBy(workspaceId);
    const name =
      changedBy === null ? null : await accountDisplayName(lookupUserDisplayName, changedBy);
    return name === null ? {} : { levelChangedBy: name };
  };
  return async function respondToLinkRead(
    request: Request,
    route: LinkReadRoute,
  ): Promise<Response> {
    const capabilityRateLimiter =
      route.route === "link-log" ? linkLogReadRateLimiter : linkReadRateLimiter;
    const grantRateLimiter =
      route.route === "link-log" ? linkGrantLogReadRateLimiter : linkGrantReadRateLimiter;
    const capability = isMemberRequest(request)
      ? await linkAuthority.requireMember(request, capabilityRateLimiter, grantRateLimiter)
      : linkAuthority.require(request, capabilityRateLimiter, grantRateLimiter);
    const requireFresh = () => linkAuthority.fresh(capability);
    if (request.method !== "GET") throw relayError("method_not_allowed");
    const share = storage.getShare(capability.shareId);
    if (!share) throw notFound();

    if (route.route === "link-share") {
      const epochLogFloor = storage.getEpochLogFloor(share.workspaceId);
      const freshness = newestFilteredOpFreshness(
        share.workspaceId,
        () => requireFresh().effectiveSelector,
        epochLogFloor,
      );
      const fresh = requireFresh();
      const presentation = createAccountlessPathProjection(fresh.effectiveSelector);
      const changed =
        fresh.credential.kind === "member"
          ? await levelChangedBy(share.workspaceId, fresh.credential.userId)
          : {};
      requireFresh();
      return linkJsonResponse(
        fresh,
        {
          ...changed,
          ...memberReach(fresh),
          ok: true,
          receivedSource: identity.source(["link", fresh.grantId], share.workspaceId),
          effectiveSelector: presentation.selector,
          access: fresh.access,
          subjectName: subjectName(fresh.shareId, request, fresh.effectiveSelector),
          ...linkChannel(fresh.grantId),
          ...freshness,
          // share-web learns a holder's grant at exchange. It learns an agent's
          // here, to count the agent with the link's holders, and keeps it to itself.
          ...(fresh.credential.kind === "agent" ? { grantId: fresh.grantId } : {}),
        },
        request.signal,
      );
    }

    if (route.route === "link-current") {
      // A member hears that the list is too long, once their grant proves fresh. A link holder's
      // refusal stays generic.
      const tooManyFiles = () => {
        if (requireFresh().credential.kind !== "member") throw notFound();
        return linkRefusal("link_too_many_files");
      };
      if (replica) {
        const body = replica.inventory(
          { grantId: capability.grantId, generation: capability.generation },
          () => requireFresh(),
          new URL(request.url).searchParams.get("collectionPath"),
        );
        if (body.files.length > linkCurrentFileLimit) return tooManyFiles();
        return linkJsonResponse(
          capability,
          { ...body, ...linkChannel(capability.grantId) },
          request.signal,
        );
      }
      const observed: Parameters<SyncRelayStorage["indexReceivedWorkTargets"]>[0][number][] = [];
      const read = () => {
        const snapshot = storage.readCurrentFileState({
          workspaceId: share.workspaceId,
          versionId: targetVersionId(capability.effectiveSelector),
          selectorPaths: capability.effectiveSelector.paths,
          limit: linkCurrentFileLimit * CURRENT_SCAN_FACTOR,
        });
        if (snapshot.tooMany) throw notFound();
        const freshness = newestFilteredOpFreshness(
          share.workspaceId,
          () => requireFresh().effectiveSelector,
          snapshot.epochLogFloor,
        );
        const fresh = requireFresh();
        const presentation = createAccountlessPathProjection(fresh.effectiveSelector);
        const requestedFolder = new URL(request.url).searchParams.get("collectionPath");
        const identity = createReceivedIdentity(
          linkKey,
          (recipient, workspaceId, objectId, objectToken) => {
            const sourceHandle = identity.source(recipient, workspaceId);
            if (sourceHandle)
              observed.push({ recipient, workspaceId, objectId, objectToken, sourceHandle });
          },
        );
        // The listing selects by path prefix; a rule file under it stays hidden.
        const visible = snapshot.files.filter(
          (file) => visibleSharePath(fresh.effectiveSelector, file.path) !== null,
        );
        if (visible.length > linkCurrentFileLimit) return tooManyFiles();
        const files = visible.map((file) => {
          const path = presentation.projectPath(file.path);
          if (path === null) throw notFound();
          return {
            path,
            objectId: identity.object(
              ["link", fresh.grantId],
              share.workspaceId,
              storage.currentFileObjectId({
                workspaceId: share.workspaceId,
                versionId: targetVersionId(fresh.effectiveSelector),
                path: file.path,
              }),
            ),
            blobSha256: file.blobSha256,
            contentKind: file.contentKind,
            ...(fresh.credential.kind === "member"
              ? { access: memberFileAccess(fresh.effectiveSelector, file.path) }
              : {}),
            ...(requestedFolder !== null && path === `${requestedFolder}/automations.yaml`
              ? {
                  automationSwitchable:
                    pathLevel(fresh.effectiveSelector, file.path) === "edit" &&
                    fresh.effectiveSelector.versionId === null &&
                    (fresh.effectiveSelector.wholeWorkspace === true ||
                      fresh.effectiveSelector.paths.some(
                        (root) =>
                          file.path.slice(0, -"/automations.yaml".length) === root ||
                          file.path.startsWith(`${root}/`),
                      )) &&
                    storage.automationSwitchableFolder(
                      share.workspaceId,
                      file.path.slice(0, -"/automations.yaml".length),
                    ),
                }
              : {}),
          };
        });
        return linkJsonResponse(
          fresh,
          {
            ok: true,
            ...memberReach(fresh),
            effectiveSelector: presentation.selector,
            access: fresh.access,
            subjectName: subjectName(fresh.shareId, request, fresh.effectiveSelector),
            ...linkChannel(fresh.grantId),
            files,
            nextCursor: snapshot.nextCursor,
            epochLogFloor: snapshot.epochLogFloor,
            ...freshness,
          },
          request.signal,
        );
      };
      const response = capability.credential.kind === "member" ? storage.readShareTx(read) : read();
      storage.indexReceivedWorkTargets(observed);
      return response;
    }

    const epochLogFloor = storage.getEpochLogFloor(share.workspaceId);
    if (route.route === "link-log") {
      const url = new URL(request.url);
      const currentOnly = url.searchParams.get("current") === "true";
      if (replica && currentOnly) {
        const input = { grantId: capability.grantId, generation: capability.generation };
        let since = parseCursor(url.searchParams.get("since"));
        if (!Number.isSafeInteger(since)) throw notFound();
        const limit = parseLimit(url.searchParams.get("limit")),
          hold = parseLinkLogHold(url.searchParams.get("hold"));
        const deadline = Date.now() + hold;
        const read = () => replica.feed(input, () => requireFresh(), since, limit);
        let page = read();
        while (
          hold > 0 &&
          !page.ops.length &&
          !page.hasMore &&
          Date.now() < deadline &&
          !request.signal.aborted
        ) {
          since = page.nextCursor;
          try {
            await discussionActivity.wait(
              linkLogWaitGroup(share.workspaceId),
              `link:${capability.callerKey}`,
              {
                holdMs: Math.max(0, deadline - Date.now()),
                signal: request.signal,
                shouldPark: () => {
                  try {
                    const checked = read();
                    return !checked.ops.length && !checked.hasMore;
                  } catch {
                    return false;
                  }
                },
              },
            );
          } catch (error) {
            if (error instanceof DiscussionActivityCapacityError)
              throw relayError("link_read_rate_limited");
            throw error;
          }
          page = read();
        }
        return linkJsonResponse(capability, { ok: true, ...page }, request.signal);
      }
      if (!currentOnly && capability.credential.kind !== "member" && capability.access !== "edit")
        throw notFound();
      const freshRead = () => {
        const fresh = requireFresh();
        if (!currentOnly && fresh.credential.kind !== "member" && fresh.access !== "edit")
          throw notFound();
        return fresh;
      };
      const requestedSince = parseCursor(url.searchParams.get("since"));
      const since = Math.max(requestedSince, epochLogFloor);
      const limit = parseLimit(url.searchParams.get("limit"));
      const hold = parseLinkLogHold(url.searchParams.get("hold"));
      let page = filteredLogPage(
        share.workspaceId,
        share.shareId,
        () => freshRead().effectiveSelector,
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
              `link:${capability.callerKey}`,
              {
                holdMs: remainingHoldMs,
                signal: request.signal,
                shouldPark: () => {
                  try {
                    const currentEpochLogFloor = storage.getEpochLogFloor(share.workspaceId);
                    if (currentEpochLogFloor !== epochLogFloor) return false;
                    const checked = filteredLogPage(
                      share.workspaceId,
                      share.shareId,
                      () => freshRead().effectiveSelector,
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

          const currentEpochLogFloor = storage.getEpochLogFloor(share.workspaceId);
          page = filteredLogPage(
            share.workspaceId,
            share.shareId,
            () => freshRead().effectiveSelector,
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
            return linkJsonResponse(
              capability,
              {
                ok: true,
                ...page,
                epochLogFloor: currentEpochLogFloor,
              },
              request.signal,
            );
          }
        }
        const currentEpochLogFloor = storage.getEpochLogFloor(share.workspaceId);
        page = filteredLogPage(
          share.workspaceId,
          share.shareId,
          () => freshRead().effectiveSelector,
          Math.max(scanSince, currentEpochLogFloor),
          limit,
          "accountless",

          undefined,

          ["link", capability.grantId],
          currentOnly,
          currentEpochLogFloor,
        );
        freshRead();
        return linkJsonResponse(
          capability,
          {
            ok: true,
            ...page,
            epochLogFloor: currentEpochLogFloor,
          },
          request.signal,
        );
      }
      freshRead();
      return linkJsonResponse(
        capability,
        {
          ok: true,
          ...page,
          epochLogFloor,
        },
        request.signal,
      );
    }

    assertSha256(route.sha256);
    const replicaInput = { grantId: capability.grantId, generation: capability.generation };
    const readReplicaBlob = (includeBytes = true) =>
      replica!.blob(replicaInput, () => requireFresh(), route.sha256, includeBytes);
    let historicalByteLength: number | null | undefined;
    const historicalLength = () =>
      historicalByteLength === undefined
        ? (historicalByteLength =
            capability.credential.kind === "member" || capability.access === "edit"
              ? linkRevisionByteLength(
                  share.workspaceId,
                  () => requireFresh().effectiveSelector,
                  route.sha256,
                  epochLogFloor,
                )
              : null)
        : historicalByteLength;
    let replicaMetadata: ReturnType<typeof readReplicaBlob> = null;
    if (replica) {
      try {
        replicaMetadata = readReplicaBlob(false);
      } catch (error) {
        if (
          !(error instanceof RelayError) ||
          error.code !== "link_read_rate_limited" ||
          historicalLength() === null
        )
          throw error;
      }
    }
    // A current file first, then an earlier revision of a file still in the share.
    const currentByteLength = replica
      ? (replicaMetadata?.byteLength ?? null)
      : storage.currentFileBlobByteLength({
          workspaceId: share.workspaceId,
          versionId: targetVersionId(capability.effectiveSelector),
          selectorPaths: capability.effectiveSelector.paths,
          sha256: route.sha256,
          epochLogFloor,
          visible: (path) => visibleSharePath(capability.effectiveSelector, path) !== null,
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

    const releaseBytes = admitLinkBlobBytes(capability.grantId, byteLength);
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
      const replicaBlob = replicaMetadata ? readReplicaBlob() : null;
      const blob = replicaMetadata
        ? replicaBlob?.bytes
        : storage.getBlob(share.workspaceId, route.sha256);
      if (!blob || blob.byteLength !== byteLength) throw notFound();
      const fresh = requireFresh();
      if (
        currentByteLength === null &&
        fresh.credential.kind !== "member" &&
        fresh.access !== "edit"
      )
        throw notFound();
      // An agent's download checks its token before every chunk, so it stops
      // once the token expires or its connection or link ends.
      const replicaGuard = replicaBlob?.guard;
      const agentGuard =
        capability.credential.kind === "agent" || capability.credential.kind === "member"
          ? () => {
              requireFresh();
            }
          : undefined;
      const guard =
        replicaGuard && agentGuard
          ? () => {
              replicaGuard();
              agentGuard();
            }
          : (replicaGuard ?? agentGuard);
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
        guard ? { signal: request.signal, guard } : undefined,
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
