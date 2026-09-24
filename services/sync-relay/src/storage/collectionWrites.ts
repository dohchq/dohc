import { createHash } from "node:crypto";
import {
  MAX_AUTOMATIONS_FILE_BYTES,
  parseAutomationsFile,
  type Automation,
  type AutomationsFileParseResult,
} from "@dohc/workspace-contracts/automations";
import { parseCollectionRecordFields, parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { stableJsonStringify } from "../canonicalJson";
import { notFound, relayError, RelayError } from "../errors";
import { proposalBase, proposalMomentPayload, type NamedMomentAuthor } from "../recipientMoments";
import { COLLECTION_FILE_ORIGIN_PREFIX } from "../relayLogInputs";
import { authorizeShareGrantAction } from "../shareAuthorization";
import {
  COLLECTION_AUTOMATIONS_FILE,
  COLLECTION_SCHEMA_FILE,
  filterCollectionWriteForShare,
  MAIN_VERSION_ID,
  type CollectionWrite,
  type ProposedChange,
} from "../shareFilter";
import type { StorageContext } from "./context";
import { readCurrentShareGrant } from "./currentShareGrant";
import { SyncRelayBlobMissingError } from "./errors";
import { appendLogBatchInTransaction, maxOriginSeq } from "./log";
import type { SqliteDb } from "./types";

// The same bound the relay puts on a schema it reads for an app Collection.
const MAX_COLLECTION_SCHEMA_BYTES = 65_536;
// A record a new Collection brings, frontmatter and body together.
const MAX_COLLECTION_RECORD_BYTES = 1024 * 1024;
const PERSONAL_STEP = "wake-agent";

// The relay's record of every direct write, by grant and the client's
// submit id. It answers a retried submit, and the owner's stop-and-restore
// reads it, so it outlives the grant.
export function initializeCollectionWriteSchema(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_relay_collection_writes (
      grant_id TEXT NOT NULL,
      submit_id TEXT NOT NULL CHECK (length(submit_id) BETWEEN 1 AND 128),
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      share_id TEXT NOT NULL,
      grant_generation INTEGER NOT NULL CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
      user_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
      origin_id TEXT NOT NULL,
      first_origin_seq INTEGER NOT NULL CHECK (first_origin_seq >= 0),
      last_origin_seq INTEGER NOT NULL CHECK (last_origin_seq >= first_origin_seq),
      paths_json TEXT NOT NULL CHECK (json_valid(paths_json)),
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
      storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
      PRIMARY KEY (grant_id, submit_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_sync_relay_collection_writes_grant
      ON sync_relay_collection_writes(workspace_id, grant_id, created_at_ms);
    CREATE TRIGGER IF NOT EXISTS sync_relay_collection_writes_usage_insert
      AFTER INSERT ON sync_relay_collection_writes BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes + NEW.storage_bytes
      WHERE workspace_id = NEW.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS sync_relay_collection_writes_usage_delete
      AFTER DELETE ON sync_relay_collection_writes BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes - OLD.storage_bytes
      WHERE workspace_id = OLD.workspace_id; END;
  `);
}

// What the recipient learns when a write commits. No moment or object id:
// a recipient never learns the owner's.
export interface CollectionWriteReceipt {
  submitId: string;
  paths: string[];
  committedAtMs: number;
}

// The file changed since the recipient read it, or a new Collection's
// folder is taken. The recipient pulls the current file and tries again. A
// taken folder names the folder and no hash, never the file that took it.
export class CollectionWriteStaleError extends RelayError {
  constructor(readonly path: string, readonly currentBlobSha256: string | null) {
    super("stale");
  }
}

export interface CommitCollectionWriteInput {
  shareId: string;
  // Pinned when the route found the grant; a grant that changed since
  // refuses the write.
  grantId: string;
  grantGeneration: number;
  // Derived from the authenticated caller.
  userId: string;
  submitId: string;
  // The changes as the recipient sent them, decided again inside the write.
  rawChanges: unknown;
  write: CollectionWrite;
  nowMs: number;
  newId: () => string;
}

export interface CommittedCollectionWrite {
  receipt: CollectionWriteReceipt;
  // False when the submit id was already committed and this answers a retry.
  created: boolean;
}

/**
 * Commits one direct write to a Collection's own files: the relay mints the
 * owner's moments under `relay:collection-file:<grantId>` with a named
 * author, in one transaction with the ledger row. The grant, the decision,
 * and every file's base are checked again inside that transaction. A submit
 * id the ledger holds returns its receipt, or `conflict` for another write.
 */
export function commitCollectionWrite(
  storage: StorageContext,
  input: CommitCollectionWriteInput,
): CommittedCollectionWrite {
  const payloadSha256 = writeDigest(input.shareId, input.write);
  const workspaceId = storage.getShare(input.shareId)?.workspaceId;
  if (workspaceId === undefined) throw notFound();
  const prior = () => replayed(storage, input, payloadSha256);
  const replay = storage.readTx(prior);
  if (replay) return { receipt: replay, created: false };
  validateContent(storage, workspaceId, input.write);

  return storage.tx(() => {
    const again = prior();
    if (again) return { receipt: again, created: false };
    const current = readCurrentShareGrant(storage, {
      grantId: input.grantId,
      principal: { kind: "user", userId: input.userId },
      generation: input.grantGeneration,
    });
    if (!current || current.share.shareId !== input.shareId || current.grant.parentGrantId !== null) {
      throw notFound();
    }
    // Edit on files, as a proposal needs; the decision then narrows it.
    const authorized = authorizeShareGrantAction({
      storage,
      grantId: input.grantId,
      action: "propose",
      principal: { kind: "user", userId: input.userId },
    });
    if (!authorized.ok) throw authorized.reason === "denied" ? relayError("share_read_only") : notFound();
    const decision = filterCollectionWriteForShare(authorized.effectiveSelector, input.rawChanges, {
      channelKind: (wireId) => storage.findChannelCreateKind(workspaceId, wireId),
    });
    if (!decision.allowed || writeDigest(input.shareId, decision.write) !== payloadSha256) {
      throw relayError("share_op_rejected");
    }
    checkBases(storage, workspaceId, decision.write);

    const author: NamedMomentAuthor = {
      kind: "named",
      userId: input.userId,
      grantId: input.grantId,
      grantGeneration: input.grantGeneration,
    };
    const originId = `${COLLECTION_FILE_ORIGIN_PREFIX}${input.grantId}`;
    const firstOriginSeq = maxOriginSeq(storage, workspaceId, originId) + 1;
    const ops = changesOf(decision.write).map((change, index) => ({
      originSeq: firstOriginSeq + index,
      opKind: "moment.append",
      payloadJson: stableJsonStringify(momentFor(storage, workspaceId, change, index, author, input)),
      recordedAtMs: input.nowMs,
    }));
    const paths = changesOf(decision.write).map((change) => change.afterPath!);
    const receipt: CollectionWriteReceipt = { submitId: input.submitId, paths, committedAtMs: input.nowMs };
    const pathsJson = JSON.stringify(paths);
    const receiptJson = JSON.stringify(receipt);
    const storageBytes = Buffer.byteLength(pathsJson) + Buffer.byteLength(receiptJson) +
      Buffer.byteLength(input.grantId) + Buffer.byteLength(input.userId) + Buffer.byteLength(originId) + 256;
    // The ledger row goes first, so the append's quota check counts it.
    storage.db.prepare(
      `INSERT INTO sync_relay_collection_writes (
         grant_id, submit_id, workspace_id, share_id, grant_generation, user_id, payload_sha256,
         origin_id, first_origin_seq, last_origin_seq, paths_json, receipt_json, created_at_ms, storage_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.grantId, input.submitId, workspaceId, input.shareId, input.grantGeneration, input.userId,
      payloadSha256, originId, firstOriginSeq, firstOriginSeq + ops.length - 1, pathsJson, receiptJson,
      input.nowMs, storageBytes,
    );
    appendLogBatchInTransaction(storage, { workspaceId, originId, ops });
    return { receipt, created: true };
  });
}

function changesOf(write: CollectionWrite): ProposedChange[] {
  return write.kind === "new-collection" ? write.changes : [write.change];
}

// What a submit id stands for. The client's own clock is left out: the
// relay stamps every moment with its own.
function writeDigest(shareId: string, write: CollectionWrite): string {
  const changes = changesOf(write).map((change) => ({
    basedOnPath: change.basedOnPath,
    basedOnBlobSha256: change.basedOnBlobSha256,
    afterPath: change.afterPath,
    afterBlobSha256: change.afterBlobSha256,
    afterByteLength: change.afterByteLength,
  }));
  return createHash("sha256")
    .update(stableJsonStringify(["dohc-collection-write-v1", shareId, write.kind, write.collectionPath, changes]))
    .digest("hex");
}

function replayed(
  storage: StorageContext,
  input: CommitCollectionWriteInput,
  payloadSha256: string,
): CollectionWriteReceipt | null {
  const row = storage.db.prepare(
    `SELECT user_id, payload_sha256, receipt_json FROM sync_relay_collection_writes
     WHERE grant_id = ? AND submit_id = ?`,
  ).get(input.grantId, input.submitId);
  if (!row) return null;
  if (row.user_id !== input.userId || row.payload_sha256 !== payloadSha256) {
    throw relayError("conflict", "this submitId already names another write");
  }
  return JSON.parse(String(row.receipt_json)) as CollectionWriteReceipt;
}

function currentFile(
  storage: StorageContext,
  workspaceId: string,
  path: string,
): { blobSha256: string; contentKind: string } | null {
  const row = storage.db.prepare(
    `SELECT blob_sha256, content_kind FROM sync_relay_current_files
     WHERE workspace_id = ? AND version_id = ? AND path = ?`,
  ).get(workspaceId, MAIN_VERSION_ID, path);
  return row ? { blobSha256: String(row.blob_sha256), contentKind: String(row.content_kind) } : null;
}

// Compare-and-swap against the owner's current files: an edit's base is
// the current content, a create finds nothing, and a new Collection's folder
// holds nothing under any case or Unicode spelling.
function checkBases(storage: StorageContext, workspaceId: string, write: CollectionWrite): void {
  const schemaPath = `${write.collectionPath}/${COLLECTION_SCHEMA_FILE}`;
  if (write.kind === "new-collection") {
    // Only the parent folder's files are read: "/" sorts just before "0".
    const slash = write.collectionPath.lastIndexOf("/");
    const parent = write.collectionPath.slice(0, slash + 1);
    const name = folded(write.collectionPath.slice(slash + 1));
    const taken = storage.db.prepare(
      `SELECT path FROM sync_relay_current_files
       WHERE workspace_id = ? AND version_id = ? AND path >= ? AND path < ?`,
    ).iterate(workspaceId, MAIN_VERSION_ID, parent, `${parent.slice(0, -1)}0`);
    for (const row of taken) {
      const inside = folded(String(row.path).slice(parent.length));
      if (inside === name || inside.startsWith(`${name}/`)) {
        throw new CollectionWriteStaleError(write.collectionPath, null);
      }
    }
    return;
  }
  const schema = currentFile(storage, workspaceId, schemaPath);
  // A folder that stopped being a Collection takes no direct write.
  if (schema === null || schema.contentKind !== "text") {
    if (write.kind === "schema") throw new CollectionWriteStaleError(schemaPath, null);
    throw relayError("share_op_rejected");
  }
  const change = write.change;
  const current = currentFile(storage, workspaceId, change.afterPath!);
  if ((current?.blobSha256 ?? null) !== change.basedOnBlobSha256 || (current !== null && current.contentKind !== "text")) {
    throw new CollectionWriteStaleError(change.afterPath!, current?.blobSha256 ?? null);
  }
}

// Case and Unicode differences that name the same folder on a
// case-insensitive disk.
function folded(path: string): string {
  return path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

// The owner's moment for one change: an edit builds on the owner's own
// head, which the compare-and-swap proved holds the base the recipient
// read, and a create mints a new object. Both carry the named author.
function momentFor(
  storage: StorageContext,
  workspaceId: string,
  change: ProposedChange,
  index: number,
  author: NamedMomentAuthor,
  input: CommitCollectionWriteInput,
): Record<string, unknown> {
  const stale = () => new CollectionWriteStaleError(change.afterPath!, currentFile(storage, workspaceId, change.afterPath!)?.blobSha256 ?? null);
  const objectId = change.basedOnPath === null
    ? null
    : storage.objectIdAtPathInVersion({ workspaceId, versionId: MAIN_VERSION_ID, path: change.basedOnPath }) ?? null;
  if (change.basedOnPath !== null && objectId === null) throw stale();
  const op = { opIndex: index, basedOnObjectId: objectId, ...change, recordedAtMs: input.nowMs };
  const { head } = proposalBase(storage, workspaceId, MAIN_VERSION_ID, op);
  if (
    change.basedOnPath !== null &&
    (head === null || head.path !== change.afterPath || head.blobSha256 !== change.basedOnBlobSha256)
  ) {
    throw stale();
  }
  const built = proposalMomentPayload(op, {
    versionId: MAIN_VERSION_ID,
    objectId: objectId ?? input.newId(),
    objectCreatedAtMs: input.nowMs,
    base: head,
    currentPath: head?.path ?? null,
    momentId: input.newId(),
    summary: null,
    author,
  });
  if (!built.ok || built.payload.operation !== "write" || built.payload.path !== change.afterPath) throw stale();
  return built.payload;
}

// Content checks with the shared parsers, before the write's transaction.
// Blobs are named by their hash, so what is read here is what the moments
// will name.
function validateContent(storage: StorageContext, workspaceId: string, write: CollectionWrite): void {
  const changes = changesOf(write);
  const missing = storage.missingBlobs(workspaceId, changes.map((change) => change.afterBlobSha256!));
  if (missing.length > 0) {
    throw new SyncRelayBlobMissingError(
      `this write references ${missing.length} blob(s) not stored on the relay (first: ${missing[0]}); upload and retry`,
    );
  }
  for (const change of changes) {
    const file = change.afterPath!.slice(change.afterPath!.lastIndexOf("/") + 1);
    if (file === COLLECTION_SCHEMA_FILE) {
      const parsed = parseCollectionSchema(text(storage, workspaceId, change, MAX_COLLECTION_SCHEMA_BYTES));
      if (parsed.status !== "valid") throw refusal(`${change.afterPath} is not a valid collection.yaml`);
    } else if (file === COLLECTION_AUTOMATIONS_FILE) {
      const after = parseAutomationsFile(text(storage, workspaceId, change, MAX_AUTOMATIONS_FILE_BYTES));
      if (after.status !== "read" || after.entries.some((entry) => entry.status !== "valid")) {
        throw refusal(`${change.afterPath} has an automation that is not valid`);
      }
      const before = change.basedOnBlobSha256 === null ? null : priorText(storage, workspaceId, change.basedOnBlobSha256);
      if (changesPersonalStep(before, after)) {
        throw refusal(`${change.afterPath} changes an automation with a personal step; send it as a proposal`);
      }
    } else {
      const record = text(storage, workspaceId, change, MAX_COLLECTION_RECORD_BYTES);
      if (!frontmatterParses(record)) throw refusal(`${change.afterPath} has frontmatter that does not parse`);
    }
  }
}

// The direct lane will not take this write. The recipient can send it as
// a proposal instead.
function refusal(reason: string): RelayError {
  return relayError("share_op_rejected", reason);
}

function text(storage: StorageContext, workspaceId: string, change: ProposedChange, limit: number): string {
  if (change.afterByteLength === null || change.afterByteLength > limit) {
    throw refusal(`${change.afterPath} is larger than ${limit} bytes`);
  }
  let bytes: Uint8Array;
  try {
    bytes = boundedBlob(storage, workspaceId, change.afterBlobSha256!, limit);
  } catch {
    throw refusal(`${change.afterPath} does not match its stated size`);
  }
  if (bytes.byteLength !== change.afterByteLength) throw refusal(`${change.afterPath} does not match its stated size`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw refusal(`${change.afterPath} is not UTF-8 text`);
  }
}

// The owner's current automations.yaml, which the compare-and-swap proves
// is still current when the write commits. "unreadable" when it is too
// large or not text: nothing about its automations can then be proven.
function priorText(storage: StorageContext, workspaceId: string, sha256: string): string | "unreadable" {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(boundedBlob(storage, workspaceId, sha256, MAX_AUTOMATIONS_FILE_BYTES));
  } catch (error) {
    if (error instanceof RelayError && error.code !== "not_found") throw error;
    return "unreadable";
  }
}

function boundedBlob(storage: StorageContext, workspaceId: string, sha256: string, limit: number): Uint8Array {
  const row = storage.db.prepare("SELECT byte_length FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?")
    .get(workspaceId, sha256);
  if (!row || Number(row.byte_length) > limit) throw notFound();
  const blob = storage.getBlob(workspaceId, sha256);
  if (!blob || createHash("sha256").update(blob).digest("hex") !== sha256) throw notFound();
  return blob;
}

function hasPersonalStep(steps: readonly Automation["do"][number][]): boolean {
  return steps.some((step) =>
    step.kind === PERSONAL_STEP || (step.kind === "if" && (hasPersonalStep(step.do) || hasPersonalStep(step.otherwise))));
}

// A direct write may not add, change, or remove an automation with a
// personal step (ADR 0012): each such automation reads the same before and
// after. An entry the old file could not read that mentions a personal step
// cannot be proven unchanged, and neither can an unreadable old file.
function changesPersonalStep(before: string | "unreadable" | null, after: AutomationsFileParseResult): boolean {
  if (after.status !== "read") return true;
  const afterById = new Map<string, string>();
  for (const entry of after.entries) {
    if (entry.status === "valid") afterById.set(entry.automation.id, JSON.stringify(entry.automation));
  }
  const personalAfter = after.entries.flatMap((entry) =>
    entry.status === "valid" && hasPersonalStep(entry.automation.do) ? [entry.automation.id] : []);
  if (before === null) return personalAfter.length > 0;
  if (before === "unreadable") return true;
  const parsedBefore = parseAutomationsFile(before);
  if (parsedBefore.status !== "read") return before.includes(PERSONAL_STEP) || personalAfter.length > 0;
  const beforeById = new Map<string, string>();
  for (const entry of parsedBefore.entries) {
    if (entry.status !== "valid") {
      if (JSON.stringify(entry.raw).includes(PERSONAL_STEP)) return true;
      continue;
    }
    const automation = JSON.stringify(entry.automation);
    beforeById.set(entry.automation.id, automation);
    if (hasPersonalStep(entry.automation.do) && afterById.get(entry.automation.id) !== automation) return true;
  }
  return personalAfter.some((id) => beforeById.get(id) !== afterById.get(id));
}

// A record without frontmatter has no fields; one with frontmatter must
// parse to fields. Only the frontmatter is parsed, so a long body is fine.
function frontmatterParses(markdown: string): boolean {
  if (!/^---\r?\n/u.test(markdown) || /^---\r?\n---(?:\r?\n|$)/u.test(markdown)) return true;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  return match !== null && parseCollectionRecordFields(`---\n${match[1]}\n---\n`) !== null;
}
