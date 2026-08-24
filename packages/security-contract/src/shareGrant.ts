import { isShareAccessValue, type ShareAccess } from "./shareSelector";

export type SharePrincipal =
  | { kind: "user"; userId: string }
  | { kind: "email"; email: string }
  | { kind: "link" };

export const GRANT_STATUS_VALUES = ["active", "revoked"] as const;

export type GrantStatus = (typeof GRANT_STATUS_VALUES)[number];

export const CHAT_SHARE_ACCESS_VALUES = ["read-write", "read-only"] as const;

export type ChatShareAccess = (typeof CHAT_SHARE_ACCESS_VALUES)[number];

type ShareGrantRecordBase = {
  grantId: string;
  shareId: string;
  principal: SharePrincipal;
  generation: number;
  status: GrantStatus;
  createdAt: string;
  revokedAt: string | null;
  parentGrantId: string | null;
};

export type ShareGrantRecord = ShareGrantRecordBase &
  (
    | { kind: "file"; access: ShareAccess }
    | { kind: "chat-channel"; access: ChatShareAccess }
  );

export type LinkCredentialRecord = {
  credentialId: string;
  grantId: string;
  secretHash: string;
  generation: number;
  mintedAt: string;
  retiredAt: string | null;
};

export type GrantBinding = {
  grantId: string;
  generation: number;
  access: ShareAccess;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGrantGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isSharePrincipal(value: unknown): value is SharePrincipal {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "user":
      return typeof value.userId === "string";
    case "email":
      return typeof value.email === "string";
    case "link":
      return true;
    default:
      return false;
  }
}

export function isGrantStatusValue(value: unknown): value is GrantStatus {
  return (
    typeof value === "string" &&
    (GRANT_STATUS_VALUES as readonly string[]).includes(value)
  );
}

export function isChatShareAccessValue(value: unknown): value is ChatShareAccess {
  return (
    typeof value === "string" &&
    (CHAT_SHARE_ACCESS_VALUES as readonly string[]).includes(value)
  );
}

export function isShareGrantRecord(value: unknown): value is ShareGrantRecord {
  if (!isRecord(value)) return false;
  if (
    typeof value.grantId !== "string" ||
    typeof value.shareId !== "string" ||
    !isSharePrincipal(value.principal) ||
    !isGrantGeneration(value.generation) ||
    !isGrantStatusValue(value.status) ||
    typeof value.createdAt !== "string" ||
    !isNullableString(value.revokedAt) ||
    !isNullableString(value.parentGrantId)
  ) {
    return false;
  }
  if (value.status === "active" && value.revokedAt !== null) return false;
  if (value.status === "revoked" && value.revokedAt === null) return false;
  if (value.parentGrantId !== null && value.principal.kind !== "user") return false;
  switch (value.kind) {
    case "file":
      return isShareAccessValue(value.access);
    case "chat-channel":
      return isChatShareAccessValue(value.access);
    default:
      return false;
  }
}

export function isLinkCredentialRecord(
  value: unknown,
): value is LinkCredentialRecord {
  return (
    isRecord(value) &&
    typeof value.credentialId === "string" &&
    typeof value.grantId === "string" &&
    typeof value.secretHash === "string" &&
    isGrantGeneration(value.generation) &&
    typeof value.mintedAt === "string" &&
    isNullableString(value.retiredAt)
  );
}

export function isGrantBinding(value: unknown): value is GrantBinding {
  return (
    isRecord(value) &&
    typeof value.grantId === "string" &&
    isGrantGeneration(value.generation) &&
    isShareAccessValue(value.access)
  );
}
