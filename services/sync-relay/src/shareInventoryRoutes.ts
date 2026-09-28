import { jsonResponse } from "@dohc/service-http";
import type {PublicEditRelease} from "@dohc/security-contract";
import { badRequest, notFound, relayError } from "./errors";
import { cursorCodec } from "./requestInputs";
import { resolveReceivedShareAuthority, selectorTargetsBlockedChannel, type AuthorizedShareAction } from "./shareAuthorization";
import { parseStoredAnyShareSelectorJson } from "./shareFilter";
import type { createShareSummaries } from "./shareSummaries";
import type { SyncRelayIndependentGrantInventoryCursor, SyncRelayLinkInventoryCursor, SyncRelayShareWithGrantRow, SyncRelayStorage } from "./storage";

export type ShareInventoryRoute =
  | { route: "shares-list" }
  | { route: "share"; shareId: string };

export function createShareInventoryRoutes(
  storage: Pick<SyncRelayStorage,
    | "listSharesGrantedBy"
    | "listSharesReceivedBy"
    | "listRemovedSharesForRecipient"
    | "getShare"
    | "getShareGrant"
    | "listActiveShareGrantsForRecipient"
    | "findChannelCreateKind"
    | "workspaceIsOwnedBy"
    | "listLinkGrantsByWorkspace"
    | "listActiveIndependentShareGrants"
  >,
  claimPendingShares: (userId: string) => Promise<void>,
  lookupUserEmail: ((userId: string) => Promise<string | null> | string | null) | undefined,
  requireShareAction: (shareId: string, actorUserId: string, action: "read") => AuthorizedShareAction,
  grantedShareSummary: ReturnType<typeof createShareSummaries>["grantedShareSummary"],
  receivedShareSummary: ReturnType<typeof createShareSummaries>["receivedShareSummary"],
  independentGrantSummary: ReturnType<typeof createShareSummaries>["independentGrantSummary"],
  linkInventorySummary: ReturnType<typeof createShareSummaries>["linkInventorySummary"],
  publicEditRelease?: PublicEditRelease,
) {
  async function respondToShareInventory(
    request: Request,
    route: ShareInventoryRoute,
    actor: { userId: string },
  ): Promise<Response> {
    if (route.route === "shares-list" && request.method === "GET") {
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
      const receivedLookups = await Promise.all(
        [...receivedByShare.values()].map(async (rows) => {
          const fallback = rows[0]!;
          const granterEmail = lookupUserEmail
            ? await lookupUserEmail(fallback.share.granterUserId)
            : null;
          return { fallback, granterEmail };
        }),
      );
      const received = receivedLookups.flatMap(({ fallback, granterEmail }) => {
        const effective = resolveReceivedShareAuthority({
          storage,
          actorUserId: actor.userId,
          shareId: fallback.share.shareId,
        });
        if (effective.ok) {
          return [
            receivedShareSummary(
              { share: effective.share, grant: effective.grant },
              granterEmail,
              effective.genericChatWritable,
            ),
          ];
        }

        const currentFallback = effective.fallback;
        if (!currentFallback) return [];
        // A damaged fallback does not carry validated selector authority.
        // Recheck its selector immediately before serialization so a channel
        // that became blocked does not get one final exposure.
        const selector = parseStoredAnyShareSelectorJson(
          currentFallback.share.selectorJson,
        );
        return selector &&
          selectorTargetsBlockedChannel(
            storage,
            currentFallback.share.workspaceId,
            selector,
          )
          ? []
          : [
              receivedShareSummary(
                currentFallback,
                granterEmail,
                effective.genericChatWritable,
              ),
            ];
      });
      return jsonResponse({ ok: true, granted, received, removed: storage.listRemovedSharesForRecipient(actor.userId) });
    }
    if (route.route === "shares-list") throw relayError("method_not_allowed");

    if (route.route === "share" && request.method === "GET") {
      await claimPendingShares(actor.userId);
      const initial = requireShareAction(route.shareId, actor.userId, "read");
      const granterEmail = lookupUserEmail
        ? await lookupUserEmail(initial.share.granterUserId)
        : null;
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
