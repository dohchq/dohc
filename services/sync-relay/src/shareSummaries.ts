import {
  isChatShareAccessValue,
  isShareAccessValue,
} from "@dohc/security-contract";
import { effectiveShareSelector, isLiveEditShareSelector, parseStoredAnyShareSelectorJson, type StoredAnyShareSelector } from "./shareFilter";
import type {
  SyncRelayShareWithGrantRow,
  SyncRelayShareGrantRow,
  SyncRelayLinkInventoryRow,
} from "./storage";

// The selector KIND from a stored row, without trusting the rest of it. A
// row can be damaged in every other dimension and still say honestly which
// manager owns it; `undefined` means even that could not be read.
function storedSelectorKind(
  selectorJson: string,
): { selectorKind: "chat" | "group" } | Record<string, never> {
  try {
    const parsed: unknown = JSON.parse(selectorJson);
    const kind = (parsed as { kind?: unknown } | null)?.kind;
    if (typeof parsed === "object" && parsed !== null && (kind === "chat" || kind === "group")) {
      return { selectorKind: kind };
    }
  } catch {
    // Unreadable JSON names no kind.
  }
  return {};
}

export function createShareSummaries(
  lookupUserEmail?: (userId: string) => Promise<string | null> | string | null,
  namedBrowserOrigin?: string,
) {
  const namedBrowserInvitation = (grantId: string, selector: StoredAnyShareSelector, access: string) => {
    const effective = effectiveShareSelector(selector, access);
    return namedBrowserOrigin && effective && isLiveEditShareSelector(effective)
      ? { browserInvitationUrl: `${namedBrowserOrigin}/s/edit/${encodeURIComponent(grantId)}` }
      : {};
  };
  const shareSummaryBase = (
    row: SyncRelayShareWithGrantRow,
    storedSelector = parseStoredAnyShareSelectorJson(row.share.selectorJson),
  ): Record<string, unknown> => {
    const { share, grant } = row;
    // This serialization boundary is the one authority that decides whether
    // stored selector and grant access form a readable row. Every listing
    // caller gets the same damage classification.
    const selector =
      storedSelector &&
      ("kind" in storedSelector
        ? isChatShareAccessValue(grant.access)
        : isShareAccessValue(grant.access))
        ? storedSelector
        : null;
    return {
      shareId: share.shareId,
      // An unreadable row says so. It does not get a stand-in scope: empty
      // paths with no version would claim the entire live workspace, on a row
      // whose own reads answer 404. The row stays listed because it is the
      // caller's own share and ending it must remain possible — the reverse
      // path is the invariant here, and listing it reveals nothing the
      // caller did not already have.
      selector,
      access: grant.access,
      grantId: grant.grantId,
      principalKind: grant.principalKind,
      generation: grant.generation,
      // The KIND survives the damage when it can be read at all. It is what
      // routes a row to the right manager, and losing it made a damaged
      // chat grant surface in the path/version lists as an unreadable
      // path share. A kind that cannot be read is not invented.
      ...(selector
        ? {}
        : { damaged: true as const, ...storedSelectorKind(share.selectorJson) }),
      createdAtMs: share.createdAtMs,
    };
  };

  const grantedShareSummary = async (
    row: SyncRelayShareWithGrantRow,
  ): Promise<Record<string, unknown>> => {
    const { share, grant } = row;
    // A pending invite has no recipient user id yet; surface the addressed
    // email the granter typed. A claimed/real share resolves the email from
    // its recipient id for display.
    const recipientEmail = grant.principalUserId
      ? lookupUserEmail
        ? await lookupUserEmail(grant.principalUserId)
        : null
      : grant.principalEmail;
    const selector = parseStoredAnyShareSelectorJson(share.selectorJson);
    return {
      ...shareSummaryBase(row, selector),
      workspaceId: share.workspaceId,
      recipientUserId: grant.principalUserId,
      recipientEmail,
      revokedAtMs: grant.revokedAtMs,
      ...(selector && grant.status === "active" && grant.revokedAtMs === null && grant.parentGrantId === null &&
        (grant.principalKind === "user" || grant.principalKind === "email")
        ? namedBrowserInvitation(grant.grantId, selector, grant.access) : {}),
    };
  };

  const receivedShareSummary = (
    row: SyncRelayShareWithGrantRow,
    granterEmail: string | null,
    genericChatWritable: boolean,
  ): Record<string, unknown> => {
    // Received summaries deliberately omit the workspace id: the recipient's
    // access is share-scoped, and the granter's workspace identity is not
    // theirs to see.
    return {
      ...shareSummaryBase(row),
      granterUserId: row.share.granterUserId,
      granterEmail,
      genericChatWritable,
    };
  };

  const linkGrantBody = (grant: {
    grantId: string;
    shareId: string;
    principalKind: string;
    access: string;
    generation: number;
    status: string;
    createdAtMs: number;
    revokedAtMs: number | null;
    parentGrantId: string | null;
  }) => ({
    shareId: grant.shareId,
    grantId: grant.grantId,
    principalKind: grant.principalKind,
    access: grant.access,
    generation: grant.generation,
    status: grant.status,
    createdAtMs: grant.createdAtMs,
    revokedAtMs: grant.revokedAtMs,
    parentGrantId: grant.parentGrantId,
  });

  const namedGrantTransitionBody = (grant: {
    grantId: string;
    access: string;
    generation: number;
    status: string;
    revokedAtMs: number | null;
    parentGrantId: string | null;
  }) => ({
    grantId: grant.grantId,
    access: grant.access,
    generation: grant.generation,
    status: grant.status,
    revokedAtMs: grant.revokedAtMs,
    parentGrantId: grant.parentGrantId,
  });

  const dependentGrantSummary = async (grant: {
    grantId: string;
    principalUserId: string | null;
    access: string;
    generation: number;
    createdAtMs: number;
  }): Promise<Record<string, unknown>> => {
    let recipientEmail: string | null = null;
    if (lookupUserEmail && grant.principalUserId) {
      try {
        recipientEmail = await lookupUserEmail(grant.principalUserId);
      } catch {
        recipientEmail = null;
      }
    }
    return {
      grantId: grant.grantId,
      recipientUserId: grant.principalUserId,
      recipientEmail,
      access: grant.access,
      generation: grant.generation,
      createdAtMs: grant.createdAtMs,
    };
  };

  const independentGrantSummary = async (grant: SyncRelayShareGrantRow) => {
    let recipientEmail = grant.principalEmail;
    if (lookupUserEmail && grant.principalUserId) {
      try {
        recipientEmail = await lookupUserEmail(grant.principalUserId);
      } catch {
        recipientEmail = null;
      }
    }
    return {
      shareId: grant.shareId,
      grantId: grant.grantId,
      recipientUserId: grant.principalUserId,
      recipientEmail,
    };
  };

  const linkInventorySummary = async (row: SyncRelayLinkInventoryRow) => {
    const { share, grant } = row;
    const storedSelector = parseStoredAnyShareSelectorJson(share.selectorJson);
    const selector =
      storedSelector &&
      ("kind" in storedSelector
        ? isChatShareAccessValue(grant.access)
        : isShareAccessValue(grant.access))
        ? storedSelector
        : null;
    return {
      shareId: share.shareId,
      grantId: grant.grantId,
      selector,
      ...(selector
        ? {}
        : { damaged: true as const, ...storedSelectorKind(share.selectorJson) }),
      access: grant.access,
      generation: grant.generation,
      status: grant.status,
      createdAtMs: grant.createdAtMs,
      revokedAtMs: grant.revokedAtMs,
      lastUsedAtMs: row.lastUsedAtMs,
      urlIssuedAtMs: row.urlIssuedAtMs,
      automationsGeneration: row.automationsGeneration,
      dependents: await Promise.all(row.dependents.map(dependentGrantSummary)),
    };
  };

  return {
    namedBrowserInvitation,
    grantedShareSummary,
    receivedShareSummary,
    linkGrantBody,
    namedGrantTransitionBody,
    dependentGrantSummary,
    independentGrantSummary,
    linkInventorySummary,
  };
}
