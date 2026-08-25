import {
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
export const LINK_SESSION_TTL_MS = 15 * 60 * 1_000;
export const LINK_SESSIONS_PER_GRANT_LIMIT = 10_000;
export const LINK_EXCHANGE_BUCKET_CAPACITY = 12;
export const LINK_EXCHANGE_REFILL_PER_SECOND = 0.2;
export const LINK_EXCHANGE_MAX_IPS = 10_000;

type TimingSafeComparator = (left: Uint8Array, right: Uint8Array) => boolean;

export function mintLinkBearer(random: typeof randomBytes = randomBytes): string {
  return random(LINK_BEARER_BYTES).toString("base64url");
}

export function hashLinkBearer(secret: string, key: BinaryLike): string {
  return createHmac("sha256", key).update(secret).digest("base64url");
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

type Bucket = {
  tokens: number;
  updatedAtMs: number;
};

export class LinkExchangeRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity = LINK_EXCHANGE_BUCKET_CAPACITY,
    private readonly refillPerSecond = LINK_EXCHANGE_REFILL_PER_SECOND,
    private readonly maxIps = LINK_EXCHANGE_MAX_IPS,
  ) {
    if (capacity <= 0 || refillPerSecond <= 0 || maxIps <= 0) {
      throw new Error("link exchange rate limits must be positive");
    }
  }

  allow(ip: string, nowMs: number): boolean {
    const key = ip || "unknown";
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxIps) this.evictOldest();
      bucket = { tokens: this.capacity, updatedAtMs: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAtMs) / 1_000;
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsedSeconds * this.refillPerSecond,
    );
    bucket.updatedAtMs = nowMs;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAtMs < oldestMs) {
        oldestKey = key;
        oldestMs = bucket.updatedAtMs;
      }
    }
    if (oldestKey !== null) this.buckets.delete(oldestKey);
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
  storage: SyncRelayStorage;
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
