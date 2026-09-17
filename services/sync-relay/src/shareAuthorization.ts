import { shareAccessRank } from "@dohc/security-contract/share-selector";
import {
  effectiveShareSelector,
  chatSideOf,
  fileSideOf,
  isChatChannelSelector,
  isLiveEditShareSelector,
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
  | "live-edit"
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
  storage: Omit<ShareAuthorizationStorage, "listActiveShareGrantsForRecipient">;
  grantId: string;
  action: ShareAction;
  principalKind: "user" | "link";
  principalUserId?: string;
};

export type NamedLiveEditShareGrantResult =
  | AuthorizedShareAction<ShareSelector>
  | { ok: false; reason: "not-authorized" | "stale-selector" };

export function authorizeNamedLiveEditShareGrant(input: {
  storage: ShareGrantAuthorizationInput["storage"];
  actorUserId: string;
  grantId: string;
}): NamedLiveEditShareGrantResult {
  const current = resolveCurrentShareGrant({
    storage: input.storage,
    grantId: input.grantId,
    principalKind: "user",
    principalUserId: input.actorUserId,
  });
  if (!current) return { ok: false, reason: "not-authorized" };
  const validated = validateCurrentShareGrant(input.storage, current);
  if (!validated.ok || !isLiveEditShareSelector(validated.effectiveSelector)) {
    return { ok: false, reason: "stale-selector" };
  }
  return { ...validated, effectiveSelector: validated.effectiveSelector };
}

export function selectorTargetsBlockedChannel(
  storage: Pick<SyncRelayStorage, "findChannelCreateKind">,
  workspaceId: string,
  selector: StoredAnyShareSelector,
): boolean {
  if (!("kind" in selector)) return false;
  const channelKind = storage.findChannelCreateKind(workspaceId, selector.channelWireId);
  // A group is a grant on an ordinary channel and its folder. Whatever the
  // channel later resolves as, anything else authorizes nothing: a direct
  // message has no folder, and a grant minted before the log named the
  // channel must not follow it into one.
  if (selector.kind === "group") return channelKind !== "channel";
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
  if (!result.ok || "kind" in result.effectiveSelector) {
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
  storage: ShareGrantAuthorizationInput["storage"],
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
    case "append": {
      if (authorized.grant.parentGrantId !== null) return false;
      const chat = chatSideOf(authorized.effectiveSelector);
      if (chat) return chat.access === "read-write";
      const files = fileSideOf(authorized.effectiveSelector);
      return (
        files !== null &&
        files.paths.length > 0 &&
        (files.access === "comment" || files.access === "edit")
      );
    }
    case "propose": {
      const files = fileSideOf(authorized.effectiveSelector);
      return files !== null && files.paths.length > 0 && files.access === "edit";
    }
    case "live-edit":
      return (authorized.grant.principalKind === "user" || authorized.grant.principalKind === "link")
        && isLiveEditShareSelector(authorized.effectiveSelector);
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
  if ("kind" in selector) {
    return selector.access === "read-write" ? 1 : 0;
  }
  return shareAccessRank(selector.access);
}
