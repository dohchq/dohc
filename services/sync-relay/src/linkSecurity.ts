import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";
import { authorizeLinkShareAction } from "./shareAuthorization";
import type { ShareSelector } from "./shareFilter";
import type {
  SyncRelayLinkSessionRow,
  SyncRelayStorage,
} from "./storage";

export const LINK_BEARER_BYTES = 32;
export const LINK_HANDOFF_CODE_BYTES = 32;
export const LINK_HANDOFF_CODE_TTL_MS = 5 * 60 * 1_000;
export const LINK_HANDOFF_CODES_PER_GRANT_LIMIT = 32;
export const LINK_SESSION_TTL_MS = 15 * 60 * 1_000;
export const LINK_SESSION_RENEWAL_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
export const LINK_SESSIONS_PER_GRANT_LIMIT = 10_000;
export const LINK_EXCHANGE_BUCKET_CAPACITY = 12;
export const LINK_EXCHANGE_REFILL_PER_SECOND = 0.2;
export const LINK_EXCHANGE_MAX_IPS = 10_000;
export const LINK_READ_BUCKET_CAPACITY = 240;
export const LINK_READ_REFILL_PER_SECOND = 4;
export const LINK_READ_MAX_CAPABILITIES = 10_000;
export const LINK_GRANT_READ_BUCKET_CAPACITY = LINK_READ_BUCKET_CAPACITY * 4;
export const LINK_GRANT_READ_REFILL_PER_SECOND = LINK_READ_REFILL_PER_SECOND * 4;
export const LINK_LOG_READ_BUCKET_CAPACITY = 2_000;
export const LINK_LOG_READ_REFILL_PER_SECOND = 8;
export const LINK_GRANT_LOG_READ_BUCKET_CAPACITY =
  LINK_LOG_READ_BUCKET_CAPACITY * 4;
export const LINK_GRANT_LOG_READ_REFILL_PER_SECOND =
  LINK_LOG_READ_REFILL_PER_SECOND * 4;
// A grant may burst through five maximum-size (20 MiB) blobs. Its refill adds
// the same allowance over 24 hours, so a sustained viewer can reopen a maximum
// blob several times per day without giving an accountless grant unlimited
// relay egress.
export const LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES = 100 * 1024 * 1024;
export const LINK_GRANT_EGRESS_REFILL_BYTES_PER_SECOND =
  LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES / (24 * 60 * 60);
export const LINK_GRANT_EGRESS_MAX_GRANTS = 10_000;

type TimingSafeComparator = (left: Uint8Array, right: Uint8Array) => boolean;

export function mintLinkBearer(random: typeof randomBytes = randomBytes): string {
  return random(LINK_BEARER_BYTES).toString("base64url");
}

export function mintLinkHandoffCode(random: typeof randomBytes = randomBytes): string {
  return random(LINK_HANDOFF_CODE_BYTES).toString("base64url");
}

export function hashLinkBearer(secret: string, key: BinaryLike): string {
  return createHmac("sha256", key).update(secret).digest("base64url");
}

export function hashLinkProfileSecret(secret: string, key: BinaryLike): string {
  return createHmac("sha256", key)
    .update("link-profile\n")
    .update(secret)
    .digest("base64url");
}

export function hashLinkHandoffCode(code: string, key: BinaryLike): string {
  return createHmac("sha256", key)
    .update("link-handoff\n")
    .update(code)
    .digest("base64url");
}

export function constantTimeHashEqual(
  computedHash: string,
  storedHash: string,
  compare: TimingSafeComparator = timingSafeEqual,
): boolean {
  const computed = Buffer.from(computedHash, "base64url");
  const stored = Buffer.from(storedHash, "base64url");
  const sameLength = computed.length === stored.length;
  const comparable = sameLength ? stored : Buffer.alloc(computed.length);
  return compare(computed, comparable) && sameLength;
}

export function hashRelayExchangeKey(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function verifyRelayExchangeKey(
  presented: string | null,
  expectedHash: string,
): boolean {
  const presentedHash = hashRelayExchangeKey(presented ?? "");
  return presented !== null && constantTimeHashEqual(presentedHash, expectedHash);
}

type Bucket = {
  tokens: number;
  updatedAtMs: number;
};

export class LinkEgressRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacityBytes = LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES,
    private readonly refillBytesPerSecond =
      LINK_GRANT_EGRESS_REFILL_BYTES_PER_SECOND,
    private readonly maxGrants = LINK_GRANT_EGRESS_MAX_GRANTS,
  ) {
    if (capacityBytes <= 0 || refillBytesPerSecond <= 0 || maxGrants <= 0) {
      throw new Error("link egress limits must be positive");
    }
  }

  reserve(
    grantId: string,
    byteLength: number,
    nowMs: number,
  ): ((emittedByteLength: number, settledAtMs: number) => void) | null {
    const bucket = this.take(grantId, byteLength, nowMs);
    if (!bucket) return null;
    let settled = false;
    return (emittedByteLength, settledAtMs) => {
      if (settled) return;
      if (
        !Number.isSafeInteger(emittedByteLength) ||
        emittedByteLength < 0 ||
        emittedByteLength > byteLength
      ) {
        throw new Error("link egress emitted byte length is outside the reservation");
      }
      settled = true;
      if (this.buckets.get(grantId) !== bucket) return;
      this.refill(bucket, settledAtMs);
      bucket.tokens = Math.min(
        this.capacityBytes,
        bucket.tokens + byteLength - emittedByteLength,
      );
    };
  }

  private take(grantId: string, byteLength: number, nowMs: number): Bucket | null {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error("link egress byte length must be a non-negative integer");
    }
    let bucket = this.buckets.get(grantId);
    if (!bucket) {
      if (
        this.buckets.size >= this.maxGrants &&
        !this.evictRefilled(nowMs)
      ) {
        return null;
      }
      bucket = { tokens: this.capacityBytes, updatedAtMs: nowMs };
      this.buckets.set(grantId, bucket);
    }
    this.refill(bucket, nowMs);
    if (bucket.tokens < byteLength) return null;
    bucket.tokens -= byteLength;
    return bucket;
  }

  private refill(bucket: Bucket, nowMs: number): void {
    const nextUpdatedAtMs = Math.max(bucket.updatedAtMs, nowMs);
    const elapsedSeconds = (nextUpdatedAtMs - bucket.updatedAtMs) / 1_000;
    bucket.tokens = Math.min(
      this.capacityBytes,
      bucket.tokens + elapsedSeconds * this.refillBytesPerSecond,
    );
    bucket.updatedAtMs = nextUpdatedAtMs;
  }

  private evictRefilled(nowMs: number): boolean {
    for (const [key, bucket] of this.buckets) {
      const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAtMs) / 1_000;
      if (
        bucket.tokens + elapsedSeconds * this.refillBytesPerSecond >=
        this.capacityBytes
      ) {
        this.buckets.delete(key);
        return true;
      }
    }
    return false;
  }
}

export interface ValidatedLinkCapability {
  session: SyncRelayLinkSessionRow;
  shareId: string;
  grantId: string;
  generation: number;
  access: ShareSelector["access"];
  effectiveSelector: ShareSelector;
}

export function validateLinkCapability(input: {
  storage: Pick<
    SyncRelayStorage,
    | "findLinkSessionByCapabilityHash"
    | "getShare"
    | "getShareGrant"
    | "workspaceIsOwnedBy"
    | "findChannelCreateKind"
  >;
  capabilityToken: string;
  linkKey: BinaryLike;
  nowMs: number;
}): ValidatedLinkCapability | null {
  const capabilityHash = hashLinkBearer(input.capabilityToken, input.linkKey);
  const session = input.storage.findLinkSessionByCapabilityHash(capabilityHash);
  if (
    !session ||
    !constantTimeHashEqual(capabilityHash, session.capabilityHash) ||
    session.expiresAtMs <= input.nowMs
  ) {
    return null;
  }
  const authorized = authorizeLinkShareAction({
    storage: input.storage,
    grantId: session.grantId,
    action: "read",
  });
  if (!authorized.ok || authorized.grant.generation !== session.generation) {
    return null;
  }
  return {
    session,
    shareId: authorized.share.shareId,
    grantId: authorized.grant.grantId,
    generation: authorized.grant.generation,
    access: authorized.effectiveSelector.access,
    effectiveSelector: authorized.effectiveSelector,
  };
}

export function isPublicLinkAccess(value: string, release?: import("@dohc/security-contract").PublicEditRelease): value is "view" | "comment" | "edit" {
  return value === "view" || value === "comment" || (release?.version === 1 && value === "edit");
}
