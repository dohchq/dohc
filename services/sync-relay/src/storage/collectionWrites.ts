import { createHash, randomUUID } from "node:crypto";
import { parseLiveAuthorSnapshot, parseLiveUpdateIdentifier } from "@dohc/live-session-contract";
import { datasetBaseFolder, DATASET_METADATA_MAX_BYTES, parseDatasetDefinition, parseDatasetRevision } from "@dohc/security-contract/dataset";
import {
  MAX_AUTOMATIONS_FILE_BYTES,
  parseAutomationsFile,
  type Automation,
  type AutomationsFileParseResult,
} from "@dohc/workspace-contracts/automations";
import { pathCollisionKey } from "../pathCollisionKey";
import { parseCollectionRecordIdentity, parseCollectionRecordFields, parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { collectionVersionError } from "@dohc/workspace-contracts/collection";
import { stableJsonStringify } from "../canonicalJson";
import { notFound, relayError, RelayError } from "../errors";
import { proposalBase, proposalMomentPayload, type DirectWriteMomentAuthor } from "../recipientMoments";
import { COLLECTION_FILE_ORIGIN_PREFIX, personalCollectionOrigin } from "../relayLogInputs";
import { currentCollectionEditGrant } from "../collectionEditGrant";
import { authorizeLinkShareAction, type AuthorizedShareAction } from "../shareAuthorization";
import {
  COLLECTION_AUTOMATIONS_FILE,
  COLLECTION_SCHEMA_FILE,
  filterCollectionWriteForShare,
  filterPersonalCollectionWrite,
  MAIN_VERSION_ID,
  type CollectionWrite,
  type ProposedChange,
} from "../shareFilter";
import type { StorageContext } from "./context";
import { SyncRelayBlobMissingError } from "./errors";
import {
  commitLinkEnrollment,
  linkPrincipalLimitReached,
  linkPrincipalStorageBytes,
  linkWriteRefusal,
  readLinkEnrollment,
  type LinkEnrollment,
} from "./linkEnrollment";
import { agentName, agentWriteAuthorityInTransaction, recordAgentConnectionActionInTransaction, type AgentConnectionRow } from "./agentConnections";
import { appendLogBatchInTransaction, maxOriginSeq } from "./log";
import type { PersonalCredential } from "./personalAgentChat";
import { personalReachIn, readPersonalAuthority, type PersonalConnectionRow } from "./personalAgents";
import type { SqliteDb } from "./types";
import { assertWorkspaceQuota } from "./workspaces";

// The same bound the relay puts on a schema it reads for an app Collection.
const MAX_COLLECTION_SCHEMA_BYTES = 65_536;
// A record a new Collection brings, frontmatter and body together.
const MAX_COLLECTION_RECORD_BYTES = 1024 * 1024;
const PERSONAL_STEP = "wake-agent";

const COLLECTION_WRITE_AUTHORS_MIGRATION = "collection-write-authors-v1";

// The relay's record of every direct write, by grant and the client's
// submit id. It answers a retried submit, and the owner's stop-and-restore
// reads it, so it outlives the grant. Its author is the named recipient's
// user or the Edit link's principal, never both and never a stand-in.
const COLLECTION_WRITES_TABLE = `
  CREATE TABLE sync_relay_collection_writes (
    grant_id TEXT NOT NULL,
    submit_id TEXT NOT NULL CHECK (length(submit_id) BETWEEN 1 AND 128),
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    share_id TEXT NOT NULL,
    grant_generation INTEGER NOT NULL CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('named', 'link')),
    user_id TEXT CHECK (length(user_id) >= 1),
    principal_id TEXT CHECK (length(principal_id) >= 1),
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
    origin_id TEXT NOT NULL,
    first_origin_seq INTEGER NOT NULL CHECK (first_origin_seq >= 0),
    last_origin_seq INTEGER NOT NULL CHECK (last_origin_seq >= first_origin_seq),
    paths_json TEXT NOT NULL CHECK (json_valid(paths_json)),
    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
    PRIMARY KEY (grant_id, submit_id),
    CHECK ((author_kind = 'named') = (user_id IS NOT NULL)),
    CHECK ((author_kind = 'link') = (principal_id IS NOT NULL))
  ) STRICT;
`;

// Runs inside the relay's schema transaction. An earlier build kept only a
// user id for each write, so its rows are named recipients' and move over
// unchanged, with the bytes they already count against the quota.
export function initializeCollectionWriteSchema(db: SqliteDb): void {
  const migrated = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?")
    .get(COLLECTION_WRITE_AUTHORS_MIGRATION) !== undefined;
  if (!migrated) {
    const earlier = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sync_relay_collection_writes'")
      .get() !== undefined;
    if (earlier) db.exec("ALTER TABLE sync_relay_collection_writes RENAME TO sync_relay_collection_writes_named");
    db.exec(COLLECTION_WRITES_TABLE);
    if (earlier) {
      // Dropping the earlier table drops its usage triggers before its rows,
      // and the new table has none yet, so the copy moves no quota.
      db.exec(`
        INSERT INTO sync_relay_collection_writes (
          grant_id, submit_id, workspace_id, share_id, grant_generation, author_kind, user_id, principal_id,
          payload_sha256, origin_id, first_origin_seq, last_origin_seq, paths_json, receipt_json, created_at_ms,
          storage_bytes
        )
        SELECT grant_id, submit_id, workspace_id, share_id, grant_generation, 'named', user_id, NULL,
          payload_sha256, origin_id, first_origin_seq, last_origin_seq, paths_json, receipt_json, created_at_ms,
          storage_bytes
        FROM sync_relay_collection_writes_named;
        DROP TABLE sync_relay_collection_writes_named;
      `);
    }
    db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)")
      .run(COLLECTION_WRITE_AUTHORS_MIGRATION, Date.now());
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sync_relay_collection_writes_grant_seq
      ON sync_relay_collection_writes(grant_id, first_origin_seq);
    CREATE TRIGGER IF NOT EXISTS sync_relay_collection_writes_usage_insert
      AFTER INSERT ON sync_relay_collection_writes BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes + NEW.storage_bytes
      WHERE workspace_id = NEW.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS sync_relay_collection_writes_usage_delete
      AFTER DELETE ON sync_relay_collection_writes BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes - OLD.storage_bytes
      WHERE workspace_id = OLD.workspace_id; END;

    -- A personal agent's direct writes, by agent, workspace, and submit id.
    -- It answers a retried submit. A personal agent holds no share grant.
    CREATE TABLE IF NOT EXISTS sync_relay_personal_collection_writes (
      agent_id TEXT NOT NULL CHECK (length(agent_id) = 28 AND agent_id GLOB 'p-*'),
      workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
      submit_id TEXT NOT NULL CHECK (length(submit_id) BETWEEN 1 AND 128),
      connection_id TEXT NOT NULL CHECK (length(connection_id) >= 1),
      payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
      origin_id TEXT NOT NULL,
      first_origin_seq INTEGER NOT NULL CHECK (first_origin_seq >= 0),
      last_origin_seq INTEGER NOT NULL CHECK (last_origin_seq >= first_origin_seq),
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
      storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
      PRIMARY KEY (agent_id, workspace_id, submit_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS sync_relay_personal_collection_writes_usage_insert
      AFTER INSERT ON sync_relay_personal_collection_writes BEGIN
      UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes + NEW.storage_bytes
      WHERE workspace_id = NEW.workspace_id; END;
    CREATE TRIGGER IF NOT EXISTS sync_relay_personal_collection_writes_usage_delete
      AFTER DELETE ON sync_relay_personal_collection_writes BEGIN
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

/**
 * Who writes, as the route authenticated them. A named recipient's content
 * is already stored, uploaded blob by blob. An Edit link carries its content
 * in the request, hashed by the relay, and is authorized again inside the
 * write from its capability and profile, never from anything it claims.
 */
export type CollectionWriter =
  | { kind: "named"; userId: string; humanName: string }
  | {
      kind: "link";
      capabilityHash: string;
      profileTokenHash: string;
      /** The bytes of every file the write names, by the hash the relay computed. */
      content: ReadonlyMap<string, Uint8Array>;
      /** The relay's clock, read inside the write, so a session that expired while it waited writes nothing. */
      now(): number;
    }
  | {
      // An agent connected through an Edit link, authorized again inside the
      // write from its access token and MCP address, under its own principal.
      kind: "agent";
      accessTokenHash: string;
      resourceHash: string;
      content: ReadonlyMap<string, Uint8Array>;
      /** The relay's clock, read inside the write, so a token that expired or was ended while it waited writes nothing. */
      now(): number;
    };

export interface CommitCollectionWriteInput {
  shareId: string;
  // Pinned when the route found the grant; a grant that changed since
  // refuses the write.
  grantId: string;
  grantGeneration: number;
  writer: CollectionWriter;
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
 * owner's moments under `relay:collection-file:<grantId>` with a named or
 * link author, in one transaction with the ledger row, and for a link with
 * its new blobs and its principal's enrollment. Content is checked before
 * the transaction. Inside it, the writer's authority comes first, then the
 * decision, then a submit id the ledger holds, which returns its receipt or
 * `conflict` for another write, then every file's base. A revocation,
 * rotation, downgrade, pause, or block that commits first refuses the write,
 * a retry included.
 */
export function commitCollectionWrite(
  storage: StorageContext,
  input: CommitCollectionWriteInput,
): CommittedCollectionWrite {
  const payloadSha256 = writeDigest(input.shareId, input.write);
  const workspaceId = storage.getShare(input.shareId)?.workspaceId;
  if (workspaceId === undefined) throw notFound();
  const { writer } = input;
  // The writer's authority first, so content checks answer nobody who may
  // not write. The transaction checks it again, and decides.
  storage.readTx(() => currentWriter(storage, input));
  const unchecked = validateContent(storage, workspaceId, input.write, writer.kind !== "named"
    ? suppliedBytes(writer.content)
    : storedBytes(storage, workspaceId, input.write));

  return storage.tx(() => {
    const current = currentWriter(storage, input);
    const decision = filterCollectionWriteForShare(current.authorized.effectiveSelector, input.rawChanges, {
      channelKind: (wireId) => storage.findChannelCreateKind(workspaceId, wireId),
    });
    if (!decision.allowed || writeDigest(input.shareId, decision.write) !== payloadSha256) {
      throw relayError("share_op_rejected");
    }
    const again = replayed(storage, input, current, payloadSha256);
    if (again) return { receipt: again, created: false };
    // An automations file whose base was not the current file when its
    // content was checked had no personal steps compared. It is stale now,
    // answered only after the writer's authority passed.
    for (const path of unchecked) {
      throw new CollectionWriteStaleError(path, currentFile(storage, workspaceId, path)?.blobSha256 ?? null);
    }
    checkBases(storage, workspaceId, decision.write);
    if (decision.write.kind === "new-record") {
      checkRecordCreation(storage, workspaceId, decision.write, writer.kind !== "named"
        ? suppliedBytes(writer.content) : storedBytes(storage, workspaceId, decision.write));
    }

    let addedBytes = 0;
    let principalId: string | null = null;
    let linkAuthor: {kind: "link"; publicPrincipalId: string; label: string} | undefined;
    if (current.kind === "link") {
      if (linkPrincipalLimitReached(storage, current.enrollment)) {
        throw relayError("quota_exceeded", "This link has as many browsers as it can hold.");
      }
      principalId = current.enrollment.principal?.principalId ?? randomUUID();
      if (!current.enrollment.principal) {
        addedBytes += linkPrincipalStorageBytes(principalId, input.grantId, current.profileTokenHash);
      }
      addedBytes += newBlobBytes(storage, workspaceId, current.content);
      assertWorkspaceQuota(storage, workspaceId, addedBytes);
      const principal = commitLinkEnrollment(storage, {
        capabilityHash: current.capabilityHash,
        profileTokenHash: current.profileTokenHash,
        enrollment: current.enrollment,
        principalId,
        displayName: null,
        createdAtMs: input.nowMs,
        discussionRevision: Number(current.enrollment.authority.discussion_revision),
      });
      insertNewBlobs(storage, workspaceId, current.content, input.nowMs);
      linkAuthor = {kind: "link", publicPrincipalId: collectionLinkPublicPrincipal(storage,
        current.authorized.share.workspaceId, input.grantId, principal.principalId),
        label: principal.displayName ?? "Anonymous"};
    } else if (current.kind === "agent") {
      // The connection's principal, enrolled when the agent signed in.
      principalId = current.connection.principalId;
      addedBytes += newBlobBytes(storage, workspaceId, current.content);
      assertWorkspaceQuota(storage, workspaceId, addedBytes);
      insertNewBlobs(storage, workspaceId, current.content, input.nowMs);
      linkAuthor = {kind: "link", publicPrincipalId: collectionLinkPublicPrincipal(storage,
        current.authorized.share.workspaceId, input.grantId, principalId),
        label: agentName(current.connection.reportedName)};
    }
    const agentConnectionId = current.kind === "agent" ? current.connection.connectionId : null;
    const author: DirectWriteMomentAuthor = current.kind === "named"
      ? { kind: "named", userId: current.userId, grantId: input.grantId, grantGeneration: input.grantGeneration }
      : { kind: "link", grantId: input.grantId, grantGeneration: input.grantGeneration, principalId: principalId! };
    const admittedAuthorSnapshot = parseLiveAuthorSnapshot(writer.kind === "named"
      ? [{kind: "human", humanId: writer.userId, humanName: writer.humanName}]
      : [linkAuthor!]);
    const originId = `${COLLECTION_FILE_ORIGIN_PREFIX}${input.grantId}`;
    const firstOriginSeq = maxOriginSeq(storage, workspaceId, originId) + 1;
    const ops = changesOf(decision.write).map((change, index) => ({
      originSeq: firstOriginSeq + index,
      opKind: "moment.append",
      payloadJson: stableJsonStringify(momentFor(storage, workspaceId, change, index, author, input)),
      recordedAtMs: input.nowMs,
      admittedAuthorSnapshot,
    }));
    const paths = changesOf(decision.write).map((change) => change.afterPath!);
    const receipt: CollectionWriteReceipt = { submitId: input.submitId, paths, committedAtMs: input.nowMs };
    const pathsJson = JSON.stringify(paths);
    const receiptJson = JSON.stringify(receipt);
    const authorId = author.kind === "named" ? author.userId : author.principalId;
    const storageBytes = Buffer.byteLength(pathsJson) + Buffer.byteLength(receiptJson) +
      Buffer.byteLength(input.grantId) + Buffer.byteLength(authorId) + Buffer.byteLength(originId) +
      Buffer.byteLength(agentConnectionId ?? "") + 256;
    // The ledger row goes first, so the append's quota check counts it.
    storage.db.prepare(
      `INSERT INTO sync_relay_collection_writes (
         grant_id, submit_id, workspace_id, share_id, grant_generation, author_kind, user_id, principal_id,
         payload_sha256, origin_id, first_origin_seq, last_origin_seq, paths_json, receipt_json, created_at_ms,
         storage_bytes, agent_connection_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.grantId, input.submitId, workspaceId, input.shareId, input.grantGeneration, author.kind,
      author.kind === "named" ? author.userId : null, author.kind === "link" ? author.principalId : null,
      payloadSha256, originId, firstOriginSeq, firstOriginSeq + ops.length - 1, pathsJson, receiptJson,
      input.nowMs, storageBytes, agentConnectionId,
    );
    appendLogBatchInTransaction(storage, { workspaceId, originId, ops });
    if (agentConnectionId !== null) recordAgentConnectionActionInTransaction(storage, agentConnectionId, input.nowMs);
    return { receipt, created: true };
  });
}

export interface CommitPersonalCollectionWriteInput extends PersonalCredential {
  workspaceId: string;
  submitId: string;
  /** The changes as the agent sent them, each naming the hash of content it sent. */
  rawChanges: unknown;
  /** The bytes of every file the write names, by the hash the relay computed. */
  content: ReadonlyMap<string, Uint8Array>;
  /** The relay's clock, read inside the write, so access that ended while it waited writes nothing. */
  now(): number;
  newId: () => string;
}

/**
 * Commits one personal agent's direct write to a Collection's own files on
 * its owner's main version. The relay mints the moments under
 * `relay:personal-collection:<agentId>`, with the agent on behalf of its
 * account as their one author and its current name in the admitted author
 * snapshot. Content is checked before the transaction. Inside it, the
 * agent's authority at the fence its request read, the account's ownership
 * of the workspace, and Edit reach there are read again first, so a sign-out,
 * a password change, or narrowed reach that commits first refuses the write,
 * a retry included. Then the submit id, every file's base, and the quota, as
 * for a share.
 */
export function commitPersonalCollectionWrite(
  storage: StorageContext,
  input: CommitPersonalCollectionWriteInput,
): CommittedCollectionWrite {
  const { workspaceId } = input;
  // The agent's authority first, so content checks answer nobody who may not write.
  storage.readTx(() => personalWriter(storage, input, input.now()));
  const decision = filterPersonalCollectionWrite(input.rawChanges);
  if (!decision.allowed) throw relayError("personal_agent_not_collection");
  const { write } = decision;
  const bytesOf = suppliedBytes(input.content);
  const unchecked = validateContent(storage, workspaceId, write, bytesOf);

  return storage.tx(() => {
    const nowMs = Math.trunc(input.now());
    const { connection, name } = personalWriter(storage, input, nowMs);
    const { agentId, ownerUserId } = connection;
    const payloadSha256 = writeDigest(`personal:${agentId}`, write);
    const prior = storage.db.prepare(`SELECT payload_sha256, receipt_json FROM sync_relay_personal_collection_writes
      WHERE agent_id = ? AND workspace_id = ? AND submit_id = ?`).get(agentId, workspaceId, input.submitId);
    if (prior) {
      if (prior.payload_sha256 !== payloadSha256) throw relayError("conflict", "this submitId already names another write");
      return { receipt: JSON.parse(String(prior.receipt_json)) as CollectionWriteReceipt, created: false };
    }
    for (const path of unchecked) {
      throw new CollectionWriteStaleError(path, currentFile(storage, workspaceId, path)?.blobSha256 ?? null);
    }
    // A new file in a folder that is not a Collection is another file write, and says so.
    if ((write.kind === "new-record" || write.kind === "automations") &&
        !automationSwitchableFolder(storage, workspaceId, write.collectionPath)) {
      throw relayError("personal_agent_not_collection");
    }
    checkBases(storage, workspaceId, write);
    if (write.kind === "new-record") checkRecordCreation(storage, workspaceId, write, bytesOf);
    assertWorkspaceQuota(storage, workspaceId, newBlobBytes(storage, workspaceId, input.content));
    insertNewBlobs(storage, workspaceId, input.content, nowMs);

    const author: DirectWriteMomentAuthor = { kind: "agent", agentId, onBehalfOf: ownerUserId };
    const admittedAuthorSnapshot = parseLiveAuthorSnapshot([{ kind: "agent", agentId, agentName: name, onBehalfOf: ownerUserId }]);
    const originId = personalCollectionOrigin(agentId);
    const firstOriginSeq = maxOriginSeq(storage, workspaceId, originId) + 1;
    const ops = changesOf(write).map((change, index) => ({
      originSeq: firstOriginSeq + index,
      opKind: "moment.append",
      payloadJson: stableJsonStringify(momentFor(storage, workspaceId, change, index, author, { nowMs, newId: input.newId })),
      recordedAtMs: nowMs,
      admittedAuthorSnapshot,
    }));
    const receipt: CollectionWriteReceipt = {
      submitId: input.submitId, paths: changesOf(write).map((change) => change.afterPath!), committedAtMs: nowMs,
    };
    const receiptJson = JSON.stringify(receipt);
    const storageBytes = Buffer.byteLength(receiptJson) + Buffer.byteLength(originId) +
      Buffer.byteLength(connection.connectionId) + 256;
    // The ledger row goes first, so the append's quota check counts it.
    storage.db.prepare(
      `INSERT INTO sync_relay_personal_collection_writes (
         agent_id, workspace_id, submit_id, connection_id, payload_sha256, origin_id, first_origin_seq, last_origin_seq,
         receipt_json, created_at_ms, storage_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(agentId, workspaceId, input.submitId, connection.connectionId, payloadSha256, originId, firstOriginSeq,
      firstOriginSeq + ops.length - 1, receiptJson, nowMs, storageBytes);
    appendLogBatchInTransaction(storage, { workspaceId, originId, ops });
    storage.db.prepare(`UPDATE sync_relay_personal_agents SET last_action_at_ms = MAX(COALESCE(last_action_at_ms, 0), ?)
      WHERE agent_id = ?`).run(nowMs, agentId);
    return { receipt, created: true };
  });
}

// The personal agent as the transaction finds it now: its token, connection,
// epoch, and the account's fence, then the workspace in reach, owned by the
// account, at Edit. Its current name comes with it.
function personalWriter(
  storage: StorageContext,
  input: CommitPersonalCollectionWriteInput,
  nowMs: number,
): { connection: PersonalConnectionRow; name: string } {
  const connection = readPersonalAuthority(storage, input.check, input.fenceEpoch, nowMs);
  if (!connection || connection.connectionId !== input.connectionId) throw notFound();
  const reach = personalReachIn(storage, connection, input.workspaceId);
  if (!reach) throw relayError("personal_agent_out_of_reach");
  if (reach.level !== "edit") throw relayError("personal_agent_edit_needed");
  const agent = storage.db.prepare("SELECT name FROM sync_relay_personal_agents WHERE agent_id = ?").get(connection.agentId);
  return { connection, name: parseLiveUpdateIdentifier(agent?.name) };
}

const publicPrincipalStatements = new WeakMap<SqliteDb, {
  find: ReturnType<SqliteDb["prepare"]>;
  insert: ReturnType<SqliteDb["prepare"]>;
}>();

/** The write transaction has already authenticated and enrolled this principal. */
function collectionLinkPublicPrincipal(storage: StorageContext, workspaceId: string, grantId: string, principalId: string): string {
  let statements = publicPrincipalStatements.get(storage.db);
  if (!statements) {
    statements = {
      find: storage.db.prepare("SELECT workspace_id,public_principal_id FROM sync_relay_app_public_principals WHERE grant_id=? AND principal_id=?"),
      insert: storage.db.prepare("INSERT INTO sync_relay_app_public_principals(workspace_id,grant_id,principal_id,public_principal_id,storage_bytes) VALUES(?,?,?,?,?)"),
    };
    publicPrincipalStatements.set(storage.db, statements);
  }
  const mapping = statements.find.get(grantId, principalId);
  if (mapping) {
    if (mapping.workspace_id !== workspaceId) throw new Error("The public link principal mapping is damaged.");
    return parseLiveUpdateIdentifier(mapping.public_principal_id);
  }
  const publicId = `public_${randomUUID()}`;
  const storageBytes = Buffer.byteLength(JSON.stringify([workspaceId, grantId, principalId, publicId])) + 128;
  assertWorkspaceQuota(storage, workspaceId, storageBytes);
  statements.insert.run(workspaceId, grantId, principalId, publicId, storageBytes);
  return publicId;
}

function changesOf(write: CollectionWrite): ProposedChange[] {
  return write.kind === "new-collection" ? write.changes : [write.change];
}

function checkRecordCreation(
  storage: StorageContext, workspaceId: string,
  write: Extract<CollectionWrite, { kind: "new-record" }>, bytesOf: ContentBytes,
): void {
  const schema = currentFile(storage, workspaceId, `${write.collectionPath}/${COLLECTION_SCHEMA_FILE}`);
  const schemaText = schema && priorText(storage, workspaceId, schema.blobSha256);
  if (!schemaText || schemaText === "unreadable" || parseCollectionSchema(schemaText).status !== "valid") {
    throw refusal("This Collection does not have a current document schema.");
  }
  const bytes = bytesOf(write.change.afterBlobSha256!, write.change.afterByteLength!);
  const id = bytes && parseCollectionRecordIdentity(utf8(bytes) ?? "");
  if (!id) throw refusal("This record needs a valid record ID.");
  if (storage.db.prepare(`SELECT 1 FROM sync_relay_current_record_ids
    WHERE workspace_id = ? AND version_id = ? AND record_id = ? LIMIT 1`).get(workspaceId, MAIN_VERSION_ID, id)) {
    throw refusal("The sync relay could not create this record. Choose a new name and record ID, then try again.");
  }
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

// The writer as the transaction finds them now. A named recipient's grant
// is checked as before. A link's session, grant, generation, Edit access,
// pause, and block are read again from its capability and profile.
type CurrentWriter =
  | { kind: "named"; userId: string; authorized: AuthorizedShareAction }
  | {
      kind: "link";
      authorized: AuthorizedShareAction;
      enrollment: LinkEnrollment;
      capabilityHash: string;
      profileTokenHash: string;
      content: ReadonlyMap<string, Uint8Array>;
    }
  | {
      kind: "agent";
      authorized: AuthorizedShareAction;
      enrollment: LinkEnrollment;
      connection: AgentConnectionRow;
      content: ReadonlyMap<string, Uint8Array>;
    };

function currentWriter(storage: StorageContext, input: CommitCollectionWriteInput): CurrentWriter {
  const { writer } = input;
  if (writer.kind === "named") {
    const authorized = currentCollectionEditGrant(storage, { ...input, userId: writer.userId });
    return { kind: "named", userId: writer.userId, authorized };
  }
  if (writer.kind === "agent") {
    return { kind: "agent", content: writer.content, ...authorizeAgentCollectionWrite(storage, { ...input, ...writer, nowMs: writer.now() }) };
  }
  return { ...writer, ...authorizeLinkCollectionWrite(storage, {
    ...input, ...writer, nowMs: writer.now(),
  }) };
}

export function authorizeLinkCollectionWrite(storage: StorageContext, input: {
  shareId: string;
  grantId: string;
  grantGeneration: number;
  capabilityHash: string;
  profileTokenHash: string;
  nowMs: number;
}) {
  const enrollment = readLinkEnrollment(storage, input, input.nowMs);
  const authority = enrollment?.authority;
  if (
    !enrollment || linkWriteRefusal(enrollment) ||
    authority!.grant_id !== input.grantId || authority!.share_id !== input.shareId ||
    Number(authority!.grant_generation) !== input.grantGeneration
  ) {
    throw notFound();
  }
  const authorized = authorizeLinkShareAction({ storage, grantId: input.grantId, action: "direct-write" });
  if (!authorized.ok || authorized.grant.generation !== input.grantGeneration) throw notFound();
  return { authorized, enrollment };
}

// The same checks for an agent: its token is an unexpired access token of
// an active connection at this address, on this link at this generation,
// with Edit access, not paused, and its principal not blocked.
export function authorizeAgentCollectionWrite(storage: StorageContext, input: {
  shareId: string;
  grantId: string;
  grantGeneration: number;
  accessTokenHash: string;
  resourceHash: string;
  nowMs: number;
}) {
  const agent = agentWriteAuthorityInTransaction(storage, input, input.nowMs);
  if (
    !agent || linkWriteRefusal(agent.enrollment) || agent.connection.grantId !== input.grantId ||
    agent.connection.shareId !== input.shareId || agent.connection.generation !== input.grantGeneration
  ) {
    throw notFound();
  }
  const authorized = authorizeLinkShareAction({ storage, grantId: input.grantId, action: "direct-write" });
  if (!authorized.ok || authorized.grant.generation !== input.grantGeneration) throw notFound();
  return { authorized, enrollment: agent.enrollment, connection: agent.connection };
}

// A submit id names one write by one author under one grant. A named
// recipient's retry matches their user and payload; a link's matches its
// principal, generation, and payload, so another browser holding the link,
// or the link after a rotation, gets a conflict and learns nothing.
function replayed(
  storage: StorageContext,
  input: CommitCollectionWriteInput,
  current: CurrentWriter,
  payloadSha256: string,
): CollectionWriteReceipt | null {
  const row = storage.db.prepare(
    `SELECT author_kind, user_id, principal_id, grant_generation, payload_sha256, receipt_json
     FROM sync_relay_collection_writes WHERE grant_id = ? AND submit_id = ?`,
  ).get(input.grantId, input.submitId);
  if (!row) return null;
  const same = row.payload_sha256 === payloadSha256 && (current.kind === "named"
    ? row.author_kind === "named" && row.user_id === current.userId
    : row.author_kind === "link" && current.enrollment.principal !== null &&
      row.principal_id === current.enrollment.principal.principalId &&
      Number(row.grant_generation) === input.grantGeneration);
  if (!same) throw relayError("conflict", "this submitId already names another write");
  return JSON.parse(String(row.receipt_json)) as CollectionWriteReceipt;
}

// The bytes a link sent that the workspace does not hold yet.
function newBlobBytes(storage: StorageContext, workspaceId: string, content: ReadonlyMap<string, Uint8Array>): number {
  const missing = new Set(storage.missingBlobs(workspaceId, [...content.keys()]));
  let bytes = 0;
  for (const [sha256, body] of content) if (missing.has(sha256)) bytes += body.byteLength;
  return bytes;
}

// Stores a link's content inside the write's transaction, so a refused or
// rolled-back write leaves no blob behind. A blob the workspace holds under
// that hash already is the same bytes: the relay computed the hash.
function insertNewBlobs(
  storage: StorageContext,
  workspaceId: string,
  content: ReadonlyMap<string, Uint8Array>,
  nowMs: number,
): void {
  const insert = storage.db.prepare(
    `INSERT INTO sync_relay_blobs (workspace_id, sha256, byte_length, content, created_at_ms)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id, sha256) DO NOTHING`,
  );
  for (const [sha256, body] of content) {
    insert.run(workspaceId, sha256, body.byteLength, Buffer.from(body), Math.trunc(nowMs));
  }
}

function currentFile(
  storage: StorageContext,
  workspaceId: string,
  path: string,
): { blobSha256: string } | null {
  const row = storage.db.prepare(
    `SELECT blob_sha256 FROM sync_relay_current_files
     WHERE workspace_id = ? AND version_id = ? AND path = ?`,
  ).get(workspaceId, MAIN_VERSION_ID, path);
  return row ? { blobSha256: String(row.blob_sha256) } : null;
}

// Compare-and-swap against the owner's current files: an edit's base is
// the current content, and a create finds nothing at its path under any
// spelling a disk would take for it. A new Collection's folder holds
// nothing under any spelling either.
function checkBases(storage: StorageContext, workspaceId: string, write: CollectionWrite): void {
  const schemaPath = `${write.collectionPath}/${COLLECTION_SCHEMA_FILE}`;
  if (write.kind === "new-collection") {
    if (spellingTaken(storage, workspaceId, write.collectionPath)) {
      throw new CollectionWriteStaleError(write.collectionPath, null);
    }
    return;
  }
  const schema = currentFile(storage, workspaceId, schemaPath);
  // A folder that stopped being a Collection takes no direct write. A
  // schema stored as binary is still the Collection's schema.
  if (schema === null && !(write.kind === "automations" && approvedDatasetFolder(storage, workspaceId, write.collectionPath))) {
    if (write.kind === "schema") throw new CollectionWriteStaleError(schemaPath, null);
    throw relayError("share_op_rejected");
  }
  const change = write.change;
  const current = currentFile(storage, workspaceId, change.afterPath!);
  // The base is the bytes, whatever their kind. A file the owner stored as
  // binary before dohc read it as text takes an edit and becomes text.
  if ((current?.blobSha256 ?? null) !== change.basedOnBlobSha256) {
    throw new CollectionWriteStaleError(change.afterPath!, current?.blobSha256 ?? null);
  }
  if (current === null && spellingTaken(storage, workspaceId, change.afterPath!)) {
    throw new CollectionWriteStaleError(change.afterPath!, null);
  }
}

/** Only automations may use a dataset folder. Rule files keep their approval lane. */
export function automationSwitchableFolder(storage: StorageContext, workspaceId: string, folder: string): boolean {
  return currentFile(storage, workspaceId, `${folder}/${COLLECTION_SCHEMA_FILE}`) !== null
    || approvedDatasetFolder(storage, workspaceId, folder);
}

const DATASET_PREFLIGHT_CACHE_MS = 2_000;
const DATASET_PREFLIGHT_CACHE_ENTRIES = 256;
type CachedDatasetDescriptor = {
  blobSha256: string;
  expiresAtMs: number;
  datasetId: string;
  approval?: { revisionSha256: string; canSwitch: boolean };
};
const datasetDescriptors = new WeakMap<StorageContext, Map<string, CachedDatasetDescriptor>>();

function datasetDescriptor(storage: StorageContext, workspaceId: string, folder: string): CachedDatasetDescriptor | null {
  const descriptor = currentFile(storage, workspaceId, `${folder}/dataset.json`);
  if (!descriptor) return null;
  let cache = datasetDescriptors.get(storage);
  if (!cache) {
    cache = new Map();
    datasetDescriptors.set(storage, cache);
  }
  const key = JSON.stringify([workspaceId, folder]);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached?.blobSha256 === descriptor.blobSha256 && cached.expiresAtMs > now) return cached;
  const row = storage.db.prepare("SELECT byte_length FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?").get(workspaceId, descriptor.blobSha256);
  const size = Number(row?.byte_length);
  if (!Number.isSafeInteger(size) || size < 0 || size > DATASET_METADATA_MAX_BYTES) return null;
  const bytes = storedBlob(storage, workspaceId, descriptor.blobSha256, size);
  const text = bytes && utf8(bytes);
  if (text === null) return null;
  const definition = parseDatasetDefinition(JSON.parse(text));
  const result = {
    blobSha256: descriptor.blobSha256,
    expiresAtMs: now + DATASET_PREFLIGHT_CACHE_MS,
    datasetId: definition.datasetId,
  };
  cache.delete(key);
  if (cache.size >= DATASET_PREFLIGHT_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, result);
  return result;
}

function approvedDatasetFolder(storage: StorageContext, workspaceId: string, folder: string): boolean {
  try {
    const descriptor = datasetDescriptor(storage, workspaceId, folder);
    if (!descriptor) return false;
    const catalog = storage.db.prepare("SELECT revision_json FROM dohc_dataset_catalog WHERE workspace_id=? AND dataset_id=?").get(workspaceId, descriptor.datasetId);
    if (!catalog) return false;
    const revisionJson = String(catalog.revision_json);
    const revisionSha256 = createHash("sha256").update(revisionJson).digest("hex");
    if (descriptor.approval?.revisionSha256 === revisionSha256) return descriptor.approval.canSwitch;
    const approved = parseDatasetRevision(JSON.parse(revisionJson));
    const canSwitch = approved.datasetId === descriptor.datasetId && datasetBaseFolder(approved.definition) === folder;
    descriptor.approval = { revisionSha256, canSwitch };
    return canSwitch;
  } catch { return false; }
}

// Whether the owner has a file at `path`, under it, or at one of its
// folders, under any spelling that shares a collision key. A file where a
// folder must go would keep the new file from ever reaching a disk. Index
// lookups only: "/" sorts just before "0", so the keys under `key/` fall
// in [`key/`, `key0`).
function spellingTaken(storage: StorageContext, workspaceId: string, path: string): boolean {
  const key = pathCollisionKey(path);
  const parts = key.split("/");
  const atOrAbove = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  const row = storage.db.prepare(
    `SELECT EXISTS (SELECT 1 FROM sync_relay_current_file_keys
         WHERE workspace_id = ? AND version_id = ? AND collision_key IN (${atOrAbove.map(() => "?").join(", ")}))
       OR EXISTS (SELECT 1 FROM sync_relay_current_file_keys
         WHERE workspace_id = ? AND version_id = ? AND collision_key >= ? AND collision_key < ?) AS taken`,
  ).get(workspaceId, MAIN_VERSION_ID, ...atOrAbove, workspaceId, MAIN_VERSION_ID, `${key}/`, `${key}0`);
  return Number(row?.taken) === 1;
}

// The owner's moment for one change: an edit builds on the owner's own
// head, which the compare-and-swap proved holds the base the recipient
// read, and a create mints a new object. Both carry the named author.
function momentFor(
  storage: StorageContext,
  workspaceId: string,
  change: ProposedChange,
  index: number,
  author: DirectWriteMomentAuthor,
  input: Pick<CommitCollectionWriteInput, "nowMs" | "newId">,
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

/** The bytes of one file a write names, of exactly its stated size, or null. */
type ContentBytes = (sha256: string, byteLength: number) => Uint8Array | null;

// A named recipient's content: blobs they uploaded before the write.
function storedBytes(storage: StorageContext, workspaceId: string, write: CollectionWrite): ContentBytes {
  const missing = storage.missingBlobs(workspaceId, [...new Set(changesOf(write).map((change) => change.afterBlobSha256!))]);
  if (missing.length > 0) {
    throw new SyncRelayBlobMissingError(
      `this write references ${missing.length} blob(s) not stored on the relay (first: ${missing[0]}); upload and retry`,
    );
  }
  return (sha256, byteLength) => storedBlob(storage, workspaceId, sha256, byteLength);
}

// A link's content: the bytes it sent, hashed by the relay. A hash it did
// not send is never read from the workspace, so a link cannot name, and so
// publish, content it does not hold.
function suppliedBytes(content: ReadonlyMap<string, Uint8Array>): ContentBytes {
  return (sha256, byteLength) => {
    const bytes = content.get(sha256);
    return bytes !== undefined && bytes.byteLength === byteLength ? bytes : null;
  };
}

// Content checks with the shared parsers, before the write's transaction.
// Content is named by its hash, so what is read here is what the moments
// will name. Each blob is read and each record checked once, however many
// files name it, so a write reads at most the bytes the decision allows.
/**
 * Returns the automations files whose base was not the current file, so
 * their personal steps could not be compared. The prior content is read
 * only as the file is now, so a base hash names no other content.
 */
function validateContent(storage: StorageContext, workspaceId: string, write: CollectionWrite, bytesOf: ContentBytes): string[] {
  const unchecked: string[] = [];
  const changes = changesOf(write);
  const texts = new Map<string, { text: string; byteLength: number }>();
  const text = (change: ProposedChange, limit: number): string => {
    if (change.afterByteLength! > limit) throw refusal(`${change.afterPath} is larger than ${limit} bytes`);
    const sha256 = change.afterBlobSha256!;
    let read = texts.get(sha256);
    if (read === undefined) {
      const bytes = bytesOf(sha256, change.afterByteLength!);
      if (bytes === null) throw refusal(`${change.afterPath} does not match its stated size`);
      const decoded = utf8(bytes);
      if (decoded === null) throw refusal(`${change.afterPath} is not UTF-8 text`);
      read = { text: decoded, byteLength: bytes.byteLength };
      texts.set(sha256, read);
    } else if (read.byteLength !== change.afterByteLength) {
      throw refusal(`${change.afterPath} does not match its stated size`);
    }
    return read.text;
  };
  const records = new Set<string>();
  for (const change of changes) {
    const file = change.afterPath!.slice(change.afterPath!.lastIndexOf("/") + 1);
    if (file === COLLECTION_SCHEMA_FILE) {
      const parsed = parseCollectionSchema(text(change, MAX_COLLECTION_SCHEMA_BYTES));
      const versionError = collectionVersionError(parsed.reasons, change.afterPath ?? undefined, "sync service");
      if (versionError) throw refusal(versionError);
      if (parsed.status !== "valid") throw refusal(`${change.afterPath} is not a valid collection.yaml`);
    } else if (file === COLLECTION_AUTOMATIONS_FILE) {
      const after = parseAutomationsFile(text(change, MAX_AUTOMATIONS_FILE_BYTES));
      if (after.status !== "read" || after.entries.some((entry) => entry.status !== "valid")) {
        throw refusal(`${change.afterPath} has an automation that is not valid`);
      }
      if (
        change.basedOnBlobSha256 !== null &&
        currentFile(storage, workspaceId, change.afterPath!)?.blobSha256 !== change.basedOnBlobSha256
      ) {
        unchecked.push(change.afterPath!);
        continue;
      }
      const before = change.basedOnBlobSha256 === null
        ? null
        : texts.get(change.basedOnBlobSha256)?.text ?? priorText(storage, workspaceId, change.basedOnBlobSha256);
      if (changesPersonalStep(before, after)) {
        throw refusal(`${change.afterPath} changes an automation with a personal step`);
      }
    } else {
      const record = text(change, MAX_COLLECTION_RECORD_BYTES);
      if (records.has(change.afterBlobSha256!)) continue;
      if (!frontmatterParses(record)) throw refusal(`${change.afterPath} has frontmatter that does not parse`);
      records.add(change.afterBlobSha256!);
    }
  }
  return unchecked;
}

// The direct lane will not take this write. The recipient can send it as
// a proposal instead.
function refusal(reason: string): RelayError {
  return relayError("share_op_rejected", reason);
}

// The owner's current automations.yaml, which the compare-and-swap proves
// is still current when the write commits. "unreadable" when it is too
// large or not text: nothing about its automations can then be proven.
function priorText(storage: StorageContext, workspaceId: string, sha256: string): string | "unreadable" {
  const row = storage.db.prepare("SELECT byte_length FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?")
    .get(workspaceId, sha256);
  const byteLength = Number(row?.byte_length);
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_AUTOMATIONS_FILE_BYTES) return "unreadable";
  const bytes = storedBlob(storage, workspaceId, sha256, byteLength);
  return (bytes && utf8(bytes)) ?? "unreadable";
}

// A stored blob of exactly `byteLength` bytes, read only once its stored
// length matches. Uploads verify each blob's hash, so it is not computed
// again here.
function storedBlob(storage: StorageContext, workspaceId: string, sha256: string, byteLength: number): Uint8Array | null {
  const row = storage.db.prepare("SELECT byte_length FROM sync_relay_blobs WHERE workspace_id = ? AND sha256 = ?")
    .get(workspaceId, sha256);
  if (!row || Number(row.byte_length) !== byteLength) return null;
  const blob = storage.getBlob(workspaceId, sha256);
  return blob && blob.byteLength === byteLength ? blob : null;
}

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// A direct write may not add, change, or remove an automation with a
// personal step (ADR 0012). Both files must read with every entry valid,
// because an entry that is not valid could hide a personal step. The
// automations with a personal step must then be the same before and after,
// compared as the parser's model.
function changesPersonalStep(before: string | "unreadable" | null, after: AutomationsFileParseResult): boolean {
  try {
    const personalAfter = personalAutomations(after);
    if (personalAfter === null) return true;
    if (before === null) return personalAfter.length > 0;
    if (before === "unreadable") return true;
    const personalBefore = personalAutomations(parseAutomationsFile(before));
    return personalBefore === null ||
      personalBefore.length !== personalAfter.length ||
      personalBefore.some((text, index) => text !== personalAfter[index]);
  } catch {
    return true;
  }
}

// The automations with a personal step, each as the JSON of its model, in
// sorted order, or null when the file does not read with every entry
// valid. In that JSON a quote inside a string is escaped, so the text
// `"kind":"wake-agent"` appears only where some object's kind is that
// step, at any depth.
function personalAutomations(result: AutomationsFileParseResult): string[] | null {
  if (result.status !== "read") return null;
  const texts: string[] = [];
  for (const entry of result.entries) {
    if (entry.status !== "valid") return null;
    const text = modelJson(entry.automation);
    if (text.includes(`"kind":"${PERSONAL_STEP}"`)) texts.push(text);
  }
  return texts.sort();
}

// The model as JSON. A value JSON would not show in full, such as a Map,
// throws instead, so it can never make two different automations compare
// equal.
function modelJson(automation: Automation): string {
  return JSON.stringify(automation, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("an automation holds a value that cannot be compared");
      }
    }
    return value;
  });
}

// A record without frontmatter has no fields; one with frontmatter must
// parse to fields. Only the frontmatter is parsed, so a long body is fine.
function frontmatterParses(markdown: string): boolean {
  if (!/^---\r?\n/u.test(markdown) || /^---\r?\n---(?:\r?\n|$)/u.test(markdown)) return true;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  return match !== null && parseCollectionRecordFields(`---\n${match[1]}\n---\n`) !== null;
}
