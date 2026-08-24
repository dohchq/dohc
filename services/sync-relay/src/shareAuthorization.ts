import {
  effectiveShareSelector,
  isChatChannelSelector,
  parseStoredAnyShareSelectorJson,
  type AnyShareSelector,
  type ShareSelector,
  type StoredAnyShareSelector,
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

export interface AuthorizedShareAction<Selector extends AnyShareSelector = AnyShareSelector> {
  ok: true;
  share: SyncRelayShareRow;
  grant: SyncRelayShareGrantRow;
  effectiveSelector: Selector;
}

export type ShareAuthorizationResult<Selector extends AnyShareSelector = AnyShareSelector> =
  | AuthorizedShareAction<Selector>
  | { ok: false; reason: "gauntlet" | "denied" };

type ShareAuthorizationInput = {
  storage: ShareAuthorizationStorage;
  actorUserId: string;
  shareId: string;
  action: ShareAction;
};

export function selectorTargetsBlockedChannel(
  storage: Pick<SyncRelayStorage, "findChannelCreateKind">,
  workspaceId: string,
  selector: StoredAnyShareSelector,
): boolean {
  if (!("kind" in selector) || selector.kind !== "chat-channel") return false;
  const channelKind = storage.findChannelCreateKind(workspaceId, selector.channelWireId);
  return channelKind === "agent" || channelKind === null;
}

export function authorizeShareAction(
  input: ShareAuthorizationInput & { action: "propose" },
): ShareAuthorizationResult<ShareSelector>;
export function authorizeShareAction(input: ShareAuthorizationInput): ShareAuthorizationResult;
export function authorizeShareAction(input: ShareAuthorizationInput): ShareAuthorizationResult {
  const share = input.storage.getShare(input.shareId);
  if (!share) return { ok: false, reason: "gauntlet" };
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
    return { ok: false, reason: "gauntlet" };
  }
  if (!input.storage.workspaceIsOwnedBy(share.workspaceId, share.granterUserId)) {
    return { ok: false, reason: "gauntlet" };
  }

  const storedSelector = parseStoredAnyShareSelectorJson(share.selectorJson);
  if (!storedSelector) return { ok: false, reason: "gauntlet" };

  if (selectorTargetsBlockedChannel(input.storage, share.workspaceId, storedSelector)) {
    return { ok: false, reason: "gauntlet" };
  }
  const effectiveSelector = effectiveShareSelector(storedSelector, grant.access);
  if (!effectiveSelector) return { ok: false, reason: "gauntlet" };

  switch (input.action) {
    case "read":
    case "presence":
    case "list-own-proposals":
    case "withdraw-proposal":
      return { ok: true, share, grant, effectiveSelector };
    case "append":
      if (
        isChatChannelSelector(effectiveSelector)
          ? effectiveSelector.access === "read-write"
          : effectiveSelector.paths.length > 0 &&
            (effectiveSelector.access === "comment" || effectiveSelector.access === "edit")
      ) {
        return { ok: true, share, grant, effectiveSelector };
      }
      return { ok: false, reason: "denied" };
    case "propose":
      if (
        !isChatChannelSelector(effectiveSelector) &&
        effectiveSelector.paths.length > 0 &&
        effectiveSelector.access === "edit"
      ) {
        return { ok: true, share, grant, effectiveSelector };
      }
      return { ok: false, reason: "denied" };
  }
}
