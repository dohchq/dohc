import { createHash } from "node:crypto";

// What a held released-lineage update binds, as the engine's
// `ReleasedLineageBinding` encodes it: keys sorted at every depth, every absent
// value an explicit null, tails in namespace order, and each tail's unproven
// work as a commitment to its contributions in their canonical order.
// `releasedLineageBindingVectors.json` pins both languages.

export type RetainedContribution =
  | { kind: "carried"; deliveryId: string; updateDigest: string; journalCursor: number }
  | { kind: "outbox"; outboxId: string; sequence: number; deliveryId: string; updateDigest: string };

/** How many contributions a tail retains without proof, and the digest of all of them. */
export interface UnprovenCommitment {
  count: number;
  digest: string;
}

export interface ProtectedTail {
  namespace: string;
  activationId: string;
  /** What the tail's release bound; null when it does not read. */
  release: { path: string; restoreGeneration: number } | null;
  /** The tail's retained work no proof covers; null when its evidence is invalid. */
  unproven: UnprovenCommitment | null;
}

export interface ReleasedLineageBinding {
  version: 2;
  workspaceId: string;
  mainVersionId: string;
  objectId: string;
  lineageClaimId: string;
  currentPath: string | null;
  restoreGeneration: number | null;
  incoming: {
    relayNamespace: string | null;
    replicationEpoch: string;
    streamIdentity: string;
    originId: string;
    originSeq: number;
    relaySeq: number;
  };
  headDigest: string;
  /** Every protected tail; null when the released window's evidence does not read. */
  tails: ProtectedTail[] | null;
}

const DIGEST_DOMAIN = "dohc:released-lineage-binding:v2\0";
const CONTRIBUTIONS_DOMAIN = "dohc:released-tail-contributions:v1\0";

const invalid = (field: string) => new TypeError(`Invalid released-lineage binding: ${field}.`);

function fields(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(field);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw invalid(field);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  // A lone surrogate has no UTF-8 encoding, so the engine can never hold one.
  if (typeof value !== "string" || value === "" || /\p{Cs}/u.test(value)) throw invalid(field);
  return value;
}

function integer(value: unknown, min: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || Object.is(value, -0)) throw invalid(field);
  return value;
}

const nullable = <T>(value: unknown, read: (value: unknown) => T): T | null => value === null ? null : read(value);

/** UTF-8 byte order, as Rust compares strings. */
const compareText = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/** The engine's `Ord` on contributions: kind, then each field in declaration order. */
function compareContribution(a: RetainedContribution, b: RetainedContribution): number {
  if (a.kind !== b.kind) return a.kind === "carried" ? -1 : 1;
  if (a.kind === "carried" && b.kind === "carried") {
    return compareText(a.deliveryId, b.deliveryId) || compareText(a.updateDigest, b.updateDigest) || a.journalCursor - b.journalCursor;
  }
  if (a.kind === "outbox" && b.kind === "outbox") {
    return compareText(a.outboxId, b.outboxId) || a.sequence - b.sequence ||
      compareText(a.deliveryId, b.deliveryId) || compareText(a.updateDigest, b.updateDigest);
  }
  return 0;
}

function contribution(value: unknown): RetainedContribution {
  const kind = typeof value === "object" && value !== null ? (value as {kind?: unknown}).kind : undefined;
  if (kind === "carried") {
    const row = fields(value, ["deliveryId", "journalCursor", "kind", "updateDigest"], "carried contribution");
    return {kind, deliveryId: text(row.deliveryId, "deliveryId"), updateDigest: text(row.updateDigest, "updateDigest"),
      journalCursor: integer(row.journalCursor, 0, "journalCursor")};
  }
  if (kind === "outbox") {
    const row = fields(value, ["deliveryId", "kind", "outboxId", "sequence", "updateDigest"], "outbox contribution");
    return {kind, outboxId: text(row.outboxId, "outboxId"), sequence: integer(row.sequence, 0, "sequence"),
      deliveryId: text(row.deliveryId, "deliveryId"), updateDigest: text(row.updateDigest, "updateDigest")};
  }
  throw invalid("contribution kind");
}

function commitment(value: unknown): UnprovenCommitment {
  const row = fields(value, ["count", "digest"], "unproven");
  if (typeof row.digest !== "string" || !/^[0-9a-f]{64}$/.test(row.digest)) throw invalid("unproven digest");
  return {count: integer(row.count, 1, "unproven count"), digest: row.digest};
}

function tail(value: unknown): ProtectedTail {
  const row = fields(value, ["activationId", "namespace", "release", "unproven"], "tail");
  const release = nullable(row.release, value => {
    const bound = fields(value, ["path", "restoreGeneration"], "release");
    return {path: text(bound.path, "release path"), restoreGeneration: integer(bound.restoreGeneration, 0, "release restoreGeneration")};
  });
  return {namespace: text(row.namespace, "namespace"), activationId: text(row.activationId, "activationId"), release,
    unproven: nullable(row.unproven, commitment)};
}

/** The binding `value` holds, with exactly the contract's fields. */
export function decodeReleasedLineageBinding(value: unknown): ReleasedLineageBinding {
  const row = fields(value, ["currentPath", "headDigest", "incoming", "lineageClaimId", "mainVersionId", "objectId",
    "restoreGeneration", "tails", "version", "workspaceId"], "binding");
  if (row.version !== 2) throw invalid("version");
  const incoming = fields(row.incoming, ["originId", "originSeq", "relayNamespace", "relaySeq", "replicationEpoch", "streamIdentity"], "incoming");
  const tails = nullable(row.tails, value => {
    if (!Array.isArray(value) || value.length === 0) throw invalid("tails");
    const list = value.map(tail);
    if (list.some((item, index) => index > 0 && compareText(list[index - 1]!.namespace, item.namespace) >= 0)) throw invalid("tail order");
    return list;
  });
  return {
    version: 2,
    workspaceId: text(row.workspaceId, "workspaceId"),
    mainVersionId: text(row.mainVersionId, "mainVersionId"),
    objectId: text(row.objectId, "objectId"),
    lineageClaimId: text(row.lineageClaimId, "lineageClaimId"),
    currentPath: nullable(row.currentPath, value => text(value, "currentPath")),
    restoreGeneration: nullable(row.restoreGeneration, value => integer(value, 0, "restoreGeneration")),
    incoming: {
      relayNamespace: nullable(incoming.relayNamespace, value => text(value, "relayNamespace")),
      replicationEpoch: text(incoming.replicationEpoch, "replicationEpoch"),
      streamIdentity: text(incoming.streamIdentity, "streamIdentity"),
      originId: text(incoming.originId, "originId"),
      originSeq: integer(incoming.originSeq, 0, "originSeq"),
      relaySeq: integer(incoming.relaySeq, 1, "relaySeq"),
    },
    headDigest: text(row.headDigest, "headDigest"),
    tails,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => compareText(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The commitment a tail's unproven work names: how many contributions there
 * are, and `SHA256(UTF8("dohc:released-tail-contributions:v1\0") || canonical
 * JSON of all of them in canonical order)`, in lowercase hex.
 */
export function releasedTailContributionsCommitment(contributions: readonly unknown[]): UnprovenCommitment {
  if (contributions.length === 0) throw invalid("unproven");
  const list = contributions.map(contribution).sort(compareContribution);
  return {count: list.length, digest: createHash("sha256").update(CONTRIBUTIONS_DOMAIN, "utf8").update(canonical(list), "utf8").digest("hex")};
}

/** The binding's canonical JSON. */
export function canonicalReleasedLineageBinding(binding: ReleasedLineageBinding): string {
  return canonical(decodeReleasedLineageBinding(binding));
}

/** The binding `text` encodes, refusing anything but its canonical JSON. */
export function releasedLineageBindingFromCanonical(text: string): ReleasedLineageBinding {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw invalid("JSON"); }
  const binding = decodeReleasedLineageBinding(parsed);
  if (canonicalReleasedLineageBinding(binding) !== text) throw invalid("canonical form");
  return binding;
}

/** `SHA256(UTF8("dohc:released-lineage-binding:v2\0") || canonical bytes)`, in lowercase hex. */
export function releasedLineageBindingDigest(binding: ReleasedLineageBinding): string {
  return createHash("sha256").update(DIGEST_DOMAIN, "utf8").update(canonicalReleasedLineageBinding(binding), "utf8").digest("hex");
}
