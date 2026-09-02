import { shareAccessRank } from "@dohc/security-contract/share-selector";
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
  SyncRelayShareWithGrantRow,
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
  | "getShareGrant"
  | "listActiveShareGrantsForRecipient"
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

export type ReceivedShareAuthorityResult =
  | (AuthorizedShareAction & { genericChatWritable: boolean })
  | {
      ok: false;
      reason: "gauntlet";
      genericChatWritable: false;
      fallback: SyncRelayShareWithGrantRow | null;
    };

type ShareAuthorizationInput = {
  storage: ShareAuthorizationStorage;
  actorUserId: string;
  shareId: string;
  action: ShareAction;
};

type ShareGrantAuthorizationInput = {
  storage: ShareAuthorizationStorage;
  grantId: string;
  action: ShareAction;
  principalKind: "user" | "link";
  principalUserId?: string;
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
  const grants = input.storage.listActiveShareGrantsForRecipient(
    input.shareId,
    input.actorUserId,
  );
  let authorized: AuthorizedShareAction | null = null;
  let denied = false;
  for (const grant of grants) {
    const result = authorizeShareGrantAction({
      storage: input.storage,
      grantId: grant.grantId,
      action: input.action,
      principalKind: "user",
      principalUserId: input.actorUserId,
    });
    if (!result.ok) {
      denied ||= result.reason === "denied";
      continue;
    }
    if (
      authorized === null ||
      effectiveAccessRank(result.effectiveSelector) >
        effectiveAccessRank(authorized.effectiveSelector)
    ) {
      authorized = result;
    }
  }
  return authorized ?? { ok: false, reason: denied ? "denied" : "gauntlet" };
}

export function resolveReceivedShareAuthority(
  input: Omit<ShareAuthorizationInput, "action">,
): ReceivedShareAuthorityResult {
  const grants = input.storage.listActiveShareGrantsForRecipient(
    input.shareId,
    input.actorUserId,
  );
  let readable: AuthorizedShareAction | null = null;
  let genericChatWritable = false;
  let fallback: SyncRelayShareWithGrantRow | null = null;
  for (const grant of grants) {
    const current = resolveCurrentShareGrant({
      storage: input.storage,
      grantId: grant.grantId,
      principalKind: "user",
      principalUserId: input.actorUserId,
    });
    if (!current) continue;
    fallback ??= current;
    const validated = validateCurrentShareGrant(input.storage, current);
    if (!validated.ok) continue;
    if (
      readable === null ||
      effectiveAccessRank(validated.effectiveSelector) >
        effectiveAccessRank(readable.effectiveSelector)
    ) {
      readable = validated;
    }
    genericChatWritable ||= actionAllowed(validated, "append");
  }
  return readable
    ? { ...readable, genericChatWritable }
    : { ok: false, reason: "gauntlet", genericChatWritable: false, fallback };
}

export function authorizeLinkShareAction(
  input: Omit<ShareGrantAuthorizationInput, "principalKind" | "principalUserId">,
): ShareAuthorizationResult<ShareSelector> {
  const result = authorizeShareGrantAction({ ...input, principalKind: "link" });
  if (!result.ok || isChatChannelSelector(result.effectiveSelector)) {
    return { ok: false, reason: "gauntlet" };
  }
  return result as AuthorizedShareAction<ShareSelector>;
}

function authorizeShareGrantAction(
  input: ShareGrantAuthorizationInput,
): ShareAuthorizationResult {
  const validated = validateShareGrant(input);
  if (!validated.ok) return validated;
  return actionAllowed(validated, input.action)
    ? validated
    : { ok: false, reason: "denied" };
}

function validateShareGrant(
  input: Omit<ShareGrantAuthorizationInput, "action">,
): ShareAuthorizationResult {
  const current = resolveCurrentShareGrant(input);
  return current
    ? validateCurrentShareGrant(input.storage, current)
    : { ok: false, reason: "gauntlet" };
}

function resolveCurrentShareGrant(
  input: Omit<ShareGrantAuthorizationInput, "action">,
): SyncRelayShareWithGrantRow | null {
  const grant = input.storage.getShareGrant(input.grantId);
  if (
    !grant ||
    grant.principalKind !== input.principalKind ||
    grant.status !== "active" ||
    grant.revokedAtMs !== null ||
    !Number.isInteger(grant.generation) ||
    grant.generation < 1 ||
    !validStoredPrincipal(grant) ||
    (input.principalKind === "user" && grant.principalUserId !== input.principalUserId)
  ) {
    return null;
  }
  const share = input.storage.getShare(grant.shareId);
  if (!share || !input.storage.workspaceIsOwnedBy(share.workspaceId, share.granterUserId)) {
    return null;
  }
  if (grant.parentGrantId !== null) {
    const parent = input.storage.getShareGrant(grant.parentGrantId);
    if (
      grant.principalKind !== "user" ||
      !parent ||
      parent.shareId !== share.shareId ||
      parent.principalKind !== "link" ||
      parent.status !== "active" ||
      parent.revokedAtMs !== null ||
      !accessAtMost(grant.access, parent.access)
    ) {
      return null;
    }
  }

  return { share, grant };
}

function validateCurrentShareGrant(
  storage: ShareAuthorizationStorage,
  current: SyncRelayShareWithGrantRow,
): ShareAuthorizationResult {
  const { share, grant } = current;
  const storedSelector = parseStoredAnyShareSelectorJson(share.selectorJson);
  if (!storedSelector) return { ok: false, reason: "gauntlet" };

  if (selectorTargetsBlockedChannel(storage, share.workspaceId, storedSelector)) {
    return { ok: false, reason: "gauntlet" };
  }
  const effectiveSelector = effectiveShareSelector(storedSelector, grant.access);
  if (!effectiveSelector) return { ok: false, reason: "gauntlet" };

  return { ok: true, share, grant, effectiveSelector };
}

function actionAllowed(authorized: AuthorizedShareAction, action: ShareAction): boolean {
  switch (action) {
    case "read":
    case "presence":
    case "list-own-proposals":
    case "withdraw-proposal":
      return true;
    case "append":
      if (authorized.grant.parentGrantId !== null) return false;
      if (
        isChatChannelSelector(authorized.effectiveSelector)
          ? authorized.effectiveSelector.access === "read-write"
          : authorized.effectiveSelector.paths.length > 0 &&
            (authorized.effectiveSelector.access === "comment" ||
              authorized.effectiveSelector.access === "edit")
      ) {
        return true;
      }
      return false;
    case "propose":
      if (
        !isChatChannelSelector(authorized.effectiveSelector) &&
        authorized.effectiveSelector.paths.length > 0 &&
        authorized.effectiveSelector.access === "edit"
      ) {
        return true;
      }
      return false;
  }
}

function validStoredPrincipal(grant: SyncRelayShareGrantRow): boolean {
  switch (grant.principalKind) {
    case "user":
      return grant.principalUserId !== null && grant.principalEmail === null;
    case "email":
      return grant.principalUserId === null && grant.principalEmail !== null;
    case "link":
      return grant.principalUserId === null && grant.principalEmail === null;
  }
}

function accessAtMost(access: string, ceiling: string): boolean {
  const accessIndex = shareAccessRank(access);
  const ceilingIndex = shareAccessRank(ceiling);
  return accessIndex >= 0 && ceilingIndex >= 0 && accessIndex <= ceilingIndex;
}

function effectiveAccessRank(selector: AnyShareSelector): number {
  if (isChatChannelSelector(selector)) {
    return selector.access === "read-write" ? 1 : 0;
  }
  return shareAccessRank(selector.access);
}
