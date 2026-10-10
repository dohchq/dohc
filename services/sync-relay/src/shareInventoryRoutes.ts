import {normalizeShareLabel} from "@dohc/security-contract/share-labels";
import {parseWorkspaceId, readJsonObject} from "./requestInputs";
import { jsonResponse, TokenBucketLimiter } from "@dohc/service-http";
import type {PublicEditRelease} from "@dohc/security-contract";
import { badRequest, notFound, relayError } from "./errors";
import { cursorCodec } from "./requestInputs";
import { resolveReceivedShareAuthority, selectorTargetsBlockedChannel, type AuthorizedShareAction } from "./shareAuthorization";
import { fileSideOf, parseStoredAnyShareSelectorJson } from "./shareFilter";
import type { createShareSummaries } from "./shareSummaries";
import type { SyncRelayGrantedInventoryCursor, SyncRelayReceivedInventoryCursor, SyncRelayIndependentGrantInventoryCursor, SyncRelayLinkInventoryCursor, SyncRelayShareWithGrantRow, SyncRelayStorage } from "./storage";

export type ShareInventoryRoute =
  | { route: "shares-list" }
  | { route: "share-access"; shareId: string }
  | { route: "share"; shareId: string };

export function createShareInventoryRoutes(
  storage: Pick<SyncRelayStorage,
    | "listSharesGrantedBy"
    | "listSharesGrantedPage"
    | "listSharesReceivedBy"
    | "listReceivedShareIdsPage"
    | "listRemovedSharesForRecipient"
    | "getShare"
    | "setShareLabels"
    | "shareHasActiveGrants"
    | "getShareGrant"
    | "listActiveShareGrantsForRecipient"
    | "findChannelCreateKind"
    | "workspaceIsOwnedBy"
    | "listLinkGrantsByWorkspace"
    | "listActiveIndependentShareGrants"
  >,
  nowMs: () => number,
  claimPendingShares: (userId: string) => Promise<void>,
  lookupUserEmail: ((userId: string) => Promise<string | null> | string | null) | undefined,
  requireShareAction: (shareId: string, actorUserId: string, action: "read") => AuthorizedShareAction,
  grantedShareSummary: ReturnType<typeof createShareSummaries>["grantedShareSummary"],
  receivedShareSummary: ReturnType<typeof createShareSummaries>["receivedShareSummary"],
  independentGrantSummary: ReturnType<typeof createShareSummaries>["independentGrantSummary"],
  linkInventorySummary: ReturnType<typeof createShareSummaries>["linkInventorySummary"],
  publicEditRelease?: PublicEditRelease,
  senderLabel?: (userId: string, email: string | null) => Promise<string>,
  accessRateLimiter = new TokenBucketLimiter(30, 1, 10_000),
) {
  async function receivedSummaries(rows: readonly SyncRelayShareWithGrantRow[], actorUserId: string) {
    const receivedLookups = await Promise.all(rows.map(async fallback => {
      const granterEmail = lookupUserEmail ? await lookupUserEmail(fallback.share.granterUserId) : null;
      const sharerName = await senderLabel?.(fallback.share.granterUserId, granterEmail) ?? granterEmail;
      return { fallback, granterEmail, sharerName };
    }));
    return receivedLookups.flatMap(({ fallback, granterEmail, sharerName }) => {
      const effective = resolveReceivedShareAuthority({ storage, actorUserId, shareId: fallback.share.shareId });
      if (effective.ok) return [receivedShareSummary({ share: effective.share, grant: effective.grant }, granterEmail,
        effective.genericChatWritable, sharerName)];
      const currentFallback = effective.fallback;
      if (!currentFallback) return [];
      const selector = parseStoredAnyShareSelectorJson(currentFallback.share.selectorJson);
      return selector && selectorTargetsBlockedChannel(storage, currentFallback.share.workspaceId, selector)
        ? [] : [receivedShareSummary(currentFallback, granterEmail, effective.genericChatWritable, sharerName)];
    });
  }
  async function respondToShareInventory(
    request: Request,
    route: ShareInventoryRoute,
    actor: { userId: string },
  ): Promise<Response> {
    if (route.route === "share-access") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      if (!accessRateLimiter.allow(actor.userId, nowMs())) throw relayError("share_access_rate_limited");
      const authorized = requireShareAction(route.shareId, actor.userId, "read");
      return jsonResponse({ status: "current", access: fileSideOf(authorized.effectiveSelector)?.access ?? "view" },
        200, { "cache-control": "private, no-store" });
    }
    if (route.route === "shares-list" && request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.getAll("workspaceId").length > 1 || url.searchParams.getAll("cursor").length > 1 ||
          url.searchParams.getAll("received").length > 1) {
        throw badRequest("inventory coordinates are invalid");
      }
      if (url.searchParams.has("received")) {
        if (url.searchParams.get("received") !== "true" || url.searchParams.has("workspaceId")) throw badRequest("received inventory coordinates are invalid");
        const cursor = receivedInventoryCursor.decode(url.searchParams.get("cursor"));
        await claimPendingShares(actor.userId);
        const page = storage.listReceivedShareIdsPage(actor.userId, cursor);
        const active = page.shareIds.flatMap(shareId => {
          const share = storage.getShare(shareId);
          const grant = storage.listActiveShareGrantsForRecipient(shareId, actor.userId)[0];
          return share && grant ? [{ share, grant }] : [];
        });
        const received = await receivedSummaries(active, actor.userId);
        // Re-read removals after asynchronous serialization; a grant can end during a page.
        const pageIds = new Set(page.shareIds);
        const removed = storage.listRemovedSharesForRecipient(actor.userId).filter(row => pageIds.has(row.shareId));
        return jsonResponse({ ok: true, received, removed,
          ...(page.nextCursor ? { nextCursor: receivedInventoryCursor.encode(page.nextCursor) } : {}),
        });
      }
      if (url.searchParams.has("workspaceId")) {
        const workspaceId = parseWorkspaceId(url.searchParams.get("workspaceId"));
        if (!storage.workspaceIsOwnedBy(workspaceId, actor.userId)) throw notFound();
        const cursor = grantedInventoryCursor.decode(url.searchParams.get("cursor"));
        const page = storage.listSharesGrantedPage(actor.userId, workspaceId, cursor);
        const granterEmail = lookupUserEmail ? await lookupUserEmail(actor.userId) : null;
        const granted = await Promise.all(page.granted.map(row => grantedShareSummary(row, { granterEmail })));
        if (!storage.workspaceIsOwnedBy(workspaceId, actor.userId)) throw notFound();
        return jsonResponse({ok: true, granterUserId: actor.userId, granterEmail, granted,
          ...(page.nextCursor ? {nextCursor: grantedInventoryCursor.encode(page.nextCursor)} : {}),
        });
      }
      if (url.searchParams.has("cursor")) throw badRequest("workspaceId is required for granted pages");
      await claimPendingShares(actor.userId);
      const granted = await Promise.all(
        storage
          .listSharesGrantedBy(actor.userId)
          .filter((row) => row.grant.principalKind !== "link")
          .map((row) => grantedShareSummary(row)),
      );
      const receivedByShare = new Map<string, SyncRelayShareWithGrantRow[]>();
      for (const row of storage
        .listSharesReceivedBy(actor.userId)
        .filter((candidate) => candidate.grant.principalKind !== "link")) {
        const rows = receivedByShare.get(row.share.shareId);
        if (rows) rows.push(row);
        else receivedByShare.set(row.share.shareId, [row]);
      }
      const received = await receivedSummaries([...receivedByShare.values()].map(rows => rows[0]!), actor.userId);
      return jsonResponse({ ok: true, granted, received, removed: storage.listRemovedSharesForRecipient(actor.userId) });
    }
    if (route.route === "shares-list") throw relayError("method_not_allowed");

    if (route.route === "share" && request.method === "PUT") {
      const input = await readJsonObject(request);
      const share = storage.getShare(route.shareId);
      if (!share || share.granterUserId !== actor.userId || !storage.workspaceIsOwnedBy(share.workspaceId, actor.userId) || !storage.shareHasActiveGrants(share.shareId)) throw notFound();
      if (Object.keys(input).sort().join() !== "subjectName") throw badRequest("Share labels require subjectName.");
      storage.setShareLabels(share.shareId, {subjectName: normalizeShareLabel(input.subjectName)}, nowMs());
      return jsonResponse({ok: true});
    }
    if (route.route === "share" && request.method === "GET") {
      await claimPendingShares(actor.userId);
      const initial = requireShareAction(route.shareId, actor.userId, "read");
      const granterEmail = lookupUserEmail
        ? await lookupUserEmail(initial.share.granterUserId)
        : null;
      const sharerName = await senderLabel?.(initial.share.granterUserId, granterEmail) ?? granterEmail;
      const authorized = resolveReceivedShareAuthority({
        storage,
        actorUserId: actor.userId,
        shareId: route.shareId,
      });
      if (!authorized.ok) { requireShareAction(route.shareId, actor.userId, "read"); throw notFound(); }
      const summary = receivedShareSummary(
        { share: authorized.share, grant: authorized.grant },
        granterEmail,
        authorized.genericChatWritable,
        sharerName,
      );
      return jsonResponse({ ok: true, ...summary });
    }
    throw relayError("method_not_allowed");
  }

  async function respondToWorkspaceLinkInventory(
    request: Request,
    workspaceId: string,
    actor: { userId: string },
  ): Promise<Response> {
    if (!storage.workspaceIsOwnedBy(workspaceId, actor.userId)) throw notFound();
    const url = new URL(request.url);
    if (
      url.searchParams.getAll("cursor").length > 1 ||
      url.searchParams.getAll("independentGrantCursor").length > 1
    ) {
      throw badRequest("cursor is invalid");
    }
    const linkCursor = linkInventoryCursor.decode(
      url.searchParams.get("cursor"),
    );
    const independentGrantCursor = independentGrantInventoryCursor.decode(
      url.searchParams.get("independentGrantCursor"),
    );
    const page = storage.listLinkGrantsByWorkspace(
      workspaceId,
      linkCursor,
    );
    const independentGrantPage = storage.listActiveIndependentShareGrants({
      workspaceId: workspaceId,
      shareIds: page.links.map((row) => row.share.shareId),
      ...(independentGrantCursor
        ? { cursor: independentGrantCursor }
        : {}),
    });
    const [links, independentGrants] = await Promise.all([
      independentGrantCursor
        ? []
        : Promise.all(page.links.map(linkInventorySummary)),
      Promise.all(
        independentGrantPage.grants.map(independentGrantSummary),
      ),
    ]);
    if (!storage.workspaceIsOwnedBy(workspaceId, actor.userId)) throw notFound();
    return jsonResponse({
      ok: true,
      links,
      independentGrants,
      supportedLinkAccess: publicEditRelease ? ["view", "comment", "edit"] : ["view", "comment"],
      ...(independentGrantPage.nextCursor
        ? {
            nextIndependentGrantCursor:
              independentGrantInventoryCursor.encode(
                independentGrantPage.nextCursor,
              ),
          }
        : {}),
      ...(page.nextCursor
        ? { nextCursor: linkInventoryCursor.encode(page.nextCursor) }
        : {}),
    });
  }

  return { respondToShareInventory, respondToWorkspaceLinkInventory };
}

const linkInventoryCursor = cursorCodec<SyncRelayLinkInventoryCursor>(
  { shareCreatedAtMs: "ms", shareId: "id", linkCreatedAtMs: "ms", grantId: "id" },
  "cursor",
);
const independentGrantInventoryCursor = cursorCodec<SyncRelayIndependentGrantInventoryCursor>(
  { shareId: "id", grantCreatedAtMs: "ms", grantId: "id" },
  "independentGrantCursor",
);

const grantedInventoryCursor = cursorCodec<SyncRelayGrantedInventoryCursor>({grantId: "id"}, "cursor");

const receivedInventoryCursor = cursorCodec<SyncRelayReceivedInventoryCursor>({ shareId: "id" }, "cursor");
