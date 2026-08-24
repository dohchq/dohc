import type { ChatShareAccess } from "@dohc/security-contract/share-grant";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import {
  effectiveShareSelector,
  isChatChannelSelector,
  parseStoredAnyShareSelectorJson,
  type AnyShareSelector,
} from "./shareFilter";
import type {
  SyncRelayShareGrantRow,
  SyncRelayShareRow,
  SyncRelayStorage,
} from "./storage";

export type ShareAction =
  | "read"
  | "append"
  | "propose"
  | "presence"
  | "list-own-proposals"
  | "withdraw-proposal";

type ShareAuthorizationStorage = Pick<
  SyncRelayStorage,
  | "findChannelCreateKind"
  | "getShare"
  | "getShareGrantForRecipient"
  | "workspaceIsOwnedBy"
>;

export interface AuthorizedShareAction {
  share: SyncRelayShareRow;
  grant: SyncRelayShareGrantRow;
  effectiveSelector: AnyShareSelector;
  access: ShareAccess | ChatShareAccess;
}

export function authorizeShareAction(input: {
  storage: ShareAuthorizationStorage;
  actorUserId: string;
  shareId: string;
  action: ShareAction;
}): AuthorizedShareAction | null {
  const share = input.storage.getShare(input.shareId);
  if (!share) return null;
  const grant = input.storage.getShareGrantForRecipient(input.shareId, input.actorUserId);
  if (
    !grant ||
    grant.shareId !== share.shareId ||
    grant.principalKind !== "user" ||
    grant.principalUserId !== input.actorUserId ||
    grant.principalEmail !== null ||
    grant.status !== "active" ||
    grant.revokedAtMs !== null ||
    !Number.isInteger(grant.generation) ||
    grant.generation < 1
  ) {
    return null;
  }
  if (!input.storage.workspaceIsOwnedBy(share.workspaceId, share.granterUserId)) {
    return null;
  }

  const storedSelector = parseStoredAnyShareSelectorJson(share.selectorJson);
  if (!storedSelector) return null;

  if ("kind" in storedSelector) {
    const channelKind = input.storage.findChannelCreateKind(
      share.workspaceId,
      storedSelector.channelWireId,
    );
    if (channelKind === "agent" || channelKind === null) return null;
  }
  const effectiveSelector = effectiveShareSelector(storedSelector, grant.access);
  if (!effectiveSelector) return null;
  const access: ShareAccess | ChatShareAccess = effectiveSelector.access;

  const allowed = (() => {
    switch (input.action) {
      case "read":
      case "presence":
      case "list-own-proposals":
      case "withdraw-proposal":
        return true;
      case "append":
        return isChatChannelSelector(effectiveSelector)
          ? effectiveSelector.access === "read-write"
          : effectiveSelector.paths.length > 0 &&
              (effectiveSelector.access === "comment" || effectiveSelector.access === "edit");
      case "propose":
        return (
          !isChatChannelSelector(effectiveSelector) &&
          effectiveSelector.paths.length > 0 &&
          effectiveSelector.access === "edit"
        );
    }
  })();

  return allowed ? { share, grant, effectiveSelector, access } : null;
}
