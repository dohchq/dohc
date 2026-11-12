import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";
import { authorizeLinkShareAction } from "./shareAuthorization";
import { isLiveEditShareSelector, type ShareSelector } from "./shareFilter";
import type { PublicEditRelease } from "@dohc/security-contract";
import type {
  SyncRelayLinkSessionRow,
  SyncRelayStorage,
  SyncRelayLinkCredentialRow,
  SyncRelayShareGrantRow,
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
// Credential probes still do a bounded HMAC and indexed lookup before their
// validity is known. Keep that work bounded across the relay as well as per IP.
// These values match the existing global app admission budget.
export const LINK_EXCHANGE_GLOBAL_BUCKET_CAPACITY = 2_400;
export const LINK_EXCHANGE_GLOBAL_REFILL_PER_SECOND = 40;
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

function linkSealingKey(key: string | Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "dohc-link-url-seal-v1", 32));
}

export function sealLinkBearer(secret: string, key: string | Uint8Array, credentialId: string, grantId: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", linkSealingKey(key), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([credentialId, grantId])));
  const sealed = Buffer.concat([cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${nonce.toString("base64url")}.${sealed.toString("base64url")}`;
}

export function unsealLinkBearer(sealed: string, key: string | Uint8Array, credentialId: string, grantId: string): string | null {
  try {
    const parts = sealed.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts.slice(1).every(part => /^[A-Za-z0-9_-]+$/u.test(part))) return null;
    const nonce = Buffer.from(parts[1]!, "base64url");
    const encrypted = Buffer.from(parts[2]!, "base64url");
    if (nonce.length !== 12 || encrypted.length <= 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", linkSealingKey(key), nonce);
    decipher.setAAD(Buffer.from(JSON.stringify([credentialId, grantId])));
    decipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function composePublicLinkUrl(shareWebOrigin: string, secret: string): string {
  return `${shareWebOrigin}/s/#${secret}`;
}

export function recoverPublicLinkUrl(grant: SyncRelayShareGrantRow | null, credential: SyncRelayLinkCredentialRow | null, key: string | Uint8Array | undefined, shareWebOrigin: string | undefined): string | null {
  if (!key || !shareWebOrigin || !grant || grant.principalKind !== "link" || grant.status !== "active" || grant.revokedAtMs !== null ||
    !credential || credential.grantId !== grant.grantId || credential.generation !== grant.generation || credential.retiredAtMs !== null || !credential.secretSealed) return null;
  const secret = unsealLinkBearer(credential.secretSealed, key, credential.credentialId, grant.grantId);
  return secret === null ? null : composePublicLinkUrl(shareWebOrigin, secret);
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

// Each kind of agent sign-in value hashes in its own domain, so one kind can
// never stand in for another.
export type AgentCredentialKind = "request" | "code" | "access" | "refresh" | "resource" | "profile";

export function hashAgentCredential(kind: AgentCredentialKind, value: string, key: BinaryLike): string {
  return createHmac("sha256", key)
    .update(`agent-${kind}\n`)
    .update(value)
    .digest("base64url");
}

// RFC 7636 S256: the challenge is the verifier's SHA-256 in base64url.
export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
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
  // The link's files. On a Group share, its folder.
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
  publicEditRelease: PublicEditRelease | undefined;
}): ValidatedLinkCapability | null {
  const capabilityHash = hashLinkBearer(input.capabilityToken, input.linkKey);
  const session = input.storage.findLinkSessionByCapabilityHash(capabilityHash);
  const matches = constantTimeHashEqual(capabilityHash, session?.capabilityHash ?? hashLinkBearer("", input.linkKey));
  if (!session || !matches) return null;
  const authorized = authorizeLinkSession(input.storage, session, input.nowMs, input.publicEditRelease);
  if (!authorized) return null;
  return {
    session,
    shareId: authorized.share.shareId,
    grantId: authorized.grant.grantId,
    generation: authorized.grant.generation,
    access: authorized.effectiveSelector.access,
    effectiveSelector: authorized.effectiveSelector,
  };
}

// What a link session may read now. Link requests and an app published through
// the link both admit the session through this check.
export function authorizeLinkSession(
  storage: Parameters<typeof authorizeLinkShareAction>[0]["storage"],
  session: SyncRelayLinkSessionRow,
  nowMs: number,
  publicEditRelease: PublicEditRelease | undefined,
) {
  if (session.expiresAtMs <= nowMs) return null;
  const authorized = authorizeLinkShareAction({ storage, grantId: session.grantId, action: "read" });
  return authorized.ok && authorized.grant.generation === session.generation &&
    servableFiles(authorized.effectiveSelector, publicEditRelease) ? authorized : null;
}

// A link serves the access its files carry: its own, or a Group folder's.
export function servableFiles(selector: ShareSelector, release?: PublicEditRelease): boolean {
  return isPublicLinkAccess(selector.access, release) &&
    (selector.access !== "edit" || isLiveEditShareSelector(selector));
}

export function isPublicLinkAccess(value: string, release?: import("@dohc/security-contract").PublicEditRelease): value is "view" | "comment" | "edit" {
  return value === "view" || value === "comment" || (release?.version === 1 && value === "edit");
}
