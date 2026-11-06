import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";
import {decodeWorkReferenceMapping, decodeWorkTarget, type WorkReferenceMapping, type WorkTarget} from "@dohc/workspace-engine-client/daemon";
import {stableJsonStringify} from "../canonicalJson";
import {notFound} from "../errors";
import {authorizeShareGrantAction, type AuthorizedShareAction} from "../shareAuthorization";
import {createReceivedIdentity, type ReceivedRecipient} from "../receivedIdentity";
import {fileSideOf, filterOpForShare, pathVisibleThroughShare, targetVersionId, type ChatShareThreadResolver} from "../shareFilter";
import type {StorageContext} from "./context";

export const WORK_REFERENCE_BATCH = 128;
export function indexReceivedWorkTargets(storage: StorageContext, rows: readonly {
  recipient: ReceivedRecipient; workspaceId: string; objectId: string; objectToken: string; sourceHandle: string;
}[]): void {
  if (!rows.length) return;
  storage.tx(() => {
    const insert = storage.db.prepare(`INSERT OR IGNORE INTO sync_relay_received_work_targets VALUES (?,?,?,?,?,?)`);
    for (const row of rows) insert.run(...row.recipient, row.sourceHandle, row.objectToken, row.workspaceId, row.objectId);
  });
}
export type WorkReferenceReader = {kind: "user"; userId: string; grantId?: string} |
  {kind: "link"; grantId: string; generation: number; requireSession: () => void; datasetAuth?: Extract<import("../appBackendAuthority").AppBackendAuth, {kind: "link"}>};
export type WorkReferenceRead = {status: "found"; reference: string; target: WorkTarget; createdAtMs: number;
  workspaceId?: string; sourceHandle?: string} | {status: "unavailable"};
const unavailable = {status: "unavailable"} as const;
const validReference = (reference: string) => /^[A-Za-z0-9_-]{43}$/.test(reference);
const targetJson = (target: WorkTarget) => stableJsonStringify(target);

function chat(storage: StorageContext, workspaceId: string): ChatShareThreadResolver {
  return {
    channelKind: id => storage.findChannelCreateKind(workspaceId, id),
    threadChannelWireId: id => storage.findThreadCreateChannelWireId(workspaceId, id),
    threadFileBinding: id => storage.findThreadCreateFileBinding(workspaceId, id),
    objectCurrentPath: id => storage.objectCurrentPath(workspaceId, id),
    objectIdAtPath: path => storage.objectIdAtPath(workspaceId, path),
  };
}

export type DatasetReferenceAccess = ReadonlyMap<string, () => boolean>;

async function prepareDatasetAccess(storage: StorageContext, workspaceId: string, reader: WorkReferenceReader, targets: readonly WorkTarget[]): Promise<DatasetReferenceAccess> {
  const proofs = new Map<string, () => boolean>();
  if (!storage.workReferenceDatasetAccess || reader.kind === "link" && !reader.datasetAuth) return proofs;
  const owner = reader.kind === "user" && storage.workspaceIsOwnedBy(workspaceId, reader.userId);
  const candidates = owner ? [undefined] : authorizations(storage, workspaceId, reader).map(grant => grant.grant.grantId);
  for (const target of targets) {
    if (target.kind !== "transactionalCollection" && target.kind !== "transactionalRecord" || proofs.has(targetJson(target))) continue;
    for (const grantId of candidates) {
      const proof = await storage.workReferenceDatasetAccess({workspaceId, ...(reader.kind === "user" ? {userId: reader.userId} : {linkAuth: reader.datasetAuth}), grantId, target});
      if (proof) { proofs.set(targetJson(target), proof); break; }
    }
  }
  return proofs;
}

export async function prepareWorkReferenceRegistration(storage: StorageContext, input: {
  workspaceId: string; userId: string; references: readonly WorkReferenceMapping[];
}): Promise<DatasetReferenceAccess> {
  if (input.references.length > WORK_REFERENCE_BATCH || !storage.workspaceIsOwnedBy(input.workspaceId, input.userId)) throw notFound();
  return prepareDatasetAccess(storage, input.workspaceId, {kind: "user", userId: input.userId}, input.references.map(mapping => mapping.target));
}

function snapshotObject(storage: StorageContext, workspaceId: string, versionId: string, field: "object_id" | "path", value: string) {
  return storage.db.prepare(`SELECT s.object_id,s.path FROM sync_relay_work_reference_snapshot_objects s
    JOIN sync_relay_current_files f ON f.workspace_id=s.workspace_id AND f.version_id=s.version_id AND f.path=s.path AND f.state_relay_seq=s.relay_seq
    WHERE s.workspace_id=? AND s.version_id=? AND s.${field}=?`).get(workspaceId, versionId, value);
}

type Scope = {versionId: string | null; objectId: string | null; path: string | null; live: boolean};
function scope(storage: StorageContext, workspaceId: string, target: WorkTarget, datasetAccess?: DatasetReferenceAccess): Scope | null {
  if (target.kind === "message") {
    const row = storage.db.prepare(`SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='chat.message.append'
      AND json_extract(payload_json,'$.messageId')=? ORDER BY relay_seq LIMIT 1`).get(workspaceId, target.messageId);
    if (!row) return null;
    const message = JSON.parse(String(row.payload_json)) as {threadId?: string};
    if (message.threadId !== target.threadId) return null;
    const wire = storage.findThreadCreateChannelWireId(workspaceId, target.threadId);
    // Engine channel ids are local. Only the admitted thread's wire id crosses the relay.
    if (wire === undefined) return null;
    if (target.channelId !== null) {
      const channel = storage.db.prepare(`SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='chat.channel.create'
        AND json_extract(payload_json,'$.wireId')=? ORDER BY relay_seq LIMIT 1`).get(workspaceId, wire);
      if (!channel || JSON.parse(String(channel.payload_json)).channelId !== target.channelId) return null;
    } else if (wire !== null) return null;
    return {versionId: null, objectId: null, path: null, live: true};
  }
  if (target.kind === "transactionalCollection" || target.kind === "transactionalRecord") {
    return {versionId: null, objectId: null, path: null, live: datasetAccess?.get(targetJson(target))?.() ?? false};
  }
  let objectId: string;
  if (target.kind === "documentRecord") {
    const records = storage.db.prepare(`SELECT path FROM sync_relay_current_record_ids WHERE workspace_id=? AND version_id=? AND record_id=? LIMIT 2`)
      .all(workspaceId, target.versionId, target.recordId);
    if (records.length !== 1) return null;
    const path = String(records[0]!.path);
    const object = storage.currentFileObjectId({workspaceId, versionId: target.versionId, path}) ?? snapshotObject(storage, workspaceId, target.versionId, "path", path)?.object_id;
    if (!object) return null;
    objectId = String(object);
  } else objectId = target.objectId;
  const moment = storage.objectMoment({workspaceId, versionId: target.versionId, objectId});
  const snapshot = moment ? null : snapshotObject(storage, workspaceId, target.versionId, "object_id", objectId);
  if (!moment && !snapshot) return null;
  const path = moment ? moment.path : String(snapshot!.path);
  const live = path !== null && (moment ? storage.currentFileObjectId({workspaceId, versionId: target.versionId, path}) === objectId : !!snapshot);
  if (target.kind === "documentCollection" && path && !path.endsWith("/collection.yaml")) return null;
  return {versionId: target.versionId, objectId, path, live};
}

function authorizations(storage: StorageContext, workspaceId: string, reader: WorkReferenceReader): AuthorizedShareAction[] {
  if (reader.kind === "link") reader.requireSession();
  const grants = reader.grantId ? [reader.grantId] : storage.db.prepare(`SELECT g.grant_id FROM sync_relay_share_grants g
    JOIN sync_relay_shares s ON s.share_id=g.share_id WHERE s.workspace_id=? AND g.principal_user_id=? AND g.status='active'
    ORDER BY g.grant_id LIMIT 256`).all(workspaceId, reader.kind === "user" ? reader.userId : "").map(row => String(row.grant_id));
  return grants.flatMap(grantId => {
    const result = authorizeShareGrantAction({storage, grantId, action: "read",
      principal: reader.kind === "user" ? {kind: "user", userId: reader.userId} : {kind: "link"},
      ...(reader.kind === "link" ? {generation: reader.generation} : {})});
    return result.ok && result.share.workspaceId === workspaceId ? [result] : [];
  });
}

function readable(storage: StorageContext, workspaceId: string, target: WorkTarget, current: Scope, grant: AuthorizedShareAction): boolean {
  if (target.kind === "message") {
    return filterOpForShare(grant.effectiveSelector, "chat.message.append", JSON.stringify({
      messageId: target.messageId, threadId: target.threadId, body: "", authorKind: "human", authorId: "reference",
      createdAtMs: 0,
    }), chat(storage, workspaceId)).allowed;
  }
  if (target.kind === "transactionalCollection" || target.kind === "transactionalRecord") return current.live;
  const files = fileSideOf(grant.effectiveSelector);
  return !!files && targetVersionId(files) === current.versionId && current.path !== null && pathVisibleThroughShare(files, current.path);
}

function insert(storage: StorageContext, workspaceId: string, mapping: WorkReferenceMapping, actor: string, current: Scope): void {
  const binding = targetJson(mapping.target);
  const known = storage.db.prepare("SELECT workspace_id,target_json FROM sync_relay_work_references WHERE reference=?").get(mapping.reference);
  if (known) {
    if (known.workspace_id !== workspaceId || known.target_json !== binding) throw notFound();
    return;
  }
  storage.db.prepare("INSERT INTO sync_relay_work_references VALUES (?,?,?,?,?)")
    .run(mapping.reference, workspaceId, binding, mapping.createdAtMs, actor);
  storage.db.prepare("INSERT INTO sync_relay_work_reference_scopes VALUES (?,?,?,?,?)")
    .run(mapping.reference, current.versionId, current.objectId, current.path, current.live ? 0 : 1);
}

export async function registerWorkReferences(storage: StorageContext, input: {
  workspaceId: string; userId: string; references: readonly WorkReferenceMapping[];
}): Promise<string[]> {
  if (input.references.length > WORK_REFERENCE_BATCH) throw notFound();
  const datasetAccess = await prepareWorkReferenceRegistration(storage, input);
  return storage.tx(() => registerWorkReferencesInTransaction(storage, {...input, datasetAccess}));
}

export function registerWorkReferencesInTransaction(storage: StorageContext, input: {
  workspaceId: string; userId: string; references: readonly WorkReferenceMapping[]; deferMissing?: boolean; datasetAccess?: DatasetReferenceAccess;
}): string[] {
    if (input.references.length > WORK_REFERENCE_BATCH) throw notFound();
    if (!storage.workspaceIsOwnedBy(input.workspaceId, input.userId)) throw notFound();
    const registered: string[] = [];
    for (const raw of input.references) {
      const mapping = decodeWorkReferenceMapping(raw);
      const known = storage.db.prepare("SELECT workspace_id,target_json FROM sync_relay_work_references WHERE reference=?").get(mapping.reference);
      if (known) {
        if (known.workspace_id !== input.workspaceId || known.target_json !== targetJson(mapping.target)) throw notFound();
        registered.push(mapping.reference);
        continue;
      }
      const current = scope(storage, input.workspaceId, mapping.target, input.datasetAccess);
      if (!current?.live && input.deferMissing) continue;
      if (!current?.live) throw notFound();
      insert(storage, input.workspaceId, mapping, input.userId, current);
      registered.push(mapping.reference);
    }
    return registered;
}

export function assertMessageWorkReferences(storage: StorageContext, workspaceId: string, ops: readonly {opKind: string; payloadJson: string}[]): void {
  const known = storage.db.prepare("SELECT 1 FROM sync_relay_work_references WHERE workspace_id=? AND reference=?");
  for (const op of ops) {
    if (op.opKind !== "chat.message.append") continue;
    const payload = JSON.parse(op.payloadJson) as {body?: unknown};
    if (typeof payload.body !== "string") continue;
    for (const match of payload.body.matchAll(/@\[work:([A-Za-z0-9_-]{43})(?:#[^\]]*)?\]/g)) {
      if (!known.get(workspaceId, match[1])) throw notFound();
    }
  }
}

export async function makeWorkReference(storage: StorageContext, input: {
  workspaceId: string; reader: WorkReferenceReader; target: WorkTarget; createdAtMs: number; identityKey?: string | Uint8Array;
}): Promise<WorkReferenceMapping> {
  const datasetAccess = await prepareDatasetAccess(storage, input.workspaceId, input.reader, [input.target]);
  return storage.tx(() => {
    let target = decodeWorkTarget(input.target);
    const owner = input.reader.kind === "user" && storage.workspaceIsOwnedBy(input.workspaceId, input.reader.userId);
    const grants = owner ? [] : authorizations(storage, input.workspaceId, input.reader);
    if (!owner && !grants.length) throw notFound();
    if (!owner && "objectId" in target) {
      const recipient: ReceivedRecipient = input.reader.kind === "user" ? ["user", input.reader.userId] : ["link", input.reader.grantId];
      const identity = createReceivedIdentity(input.identityKey);
      const source = identity.source(recipient, input.workspaceId);
      const row = storage.db.prepare(`SELECT object_id FROM sync_relay_received_work_targets
        WHERE recipient_kind=? AND recipient_id=? AND source_handle=? AND object_token=?`)
        .get(...recipient, source ?? "", target.objectId);
      if (!row) throw notFound();
      target = {...target, objectId: String(row.object_id)};
    }
    const current = scope(storage, input.workspaceId, target, datasetAccess);
    if (!current?.live || !owner && !grants.some(grant => readable(storage, input.workspaceId, target, current, grant))) throw notFound();
    const existing = storage.db.prepare(`SELECT reference,created_at_ms FROM sync_relay_work_references
      WHERE workspace_id=? AND target_json=? ORDER BY reference LIMIT 1`).get(input.workspaceId, targetJson(target));
    const mapping = {reference: existing ? String(existing.reference) : randomBytes(32).toString("base64url"),
      target, createdAtMs: existing ? Number(existing.created_at_ms) : input.createdAtMs};
    if (!existing) insert(storage, input.workspaceId, mapping, "server", current);
    // A caller with a received identity never gets the private binding back.
    return {...mapping, target: input.target};
  });
}

export async function resolveWorkReference(storage: StorageContext, input: {
  reference: string; reader: WorkReferenceReader; identityKey?: string | Uint8Array;
}): Promise<WorkReferenceRead> {
  const row = storage.db.prepare("SELECT workspace_id,target_json FROM sync_relay_work_references WHERE reference=?").get(input.reference);
  const datasetAccess = row ? await prepareDatasetAccess(storage, String(row.workspace_id), input.reader, [decodeWorkTarget(JSON.parse(String(row.target_json)))]) : new Map<string, () => boolean>();
  const observed: Parameters<typeof indexReceivedWorkTargets>[1][number][] = [];
  const resolved = storage.readLiveAuthority(() => resolveIn(storage, input, observed, datasetAccess));
  indexReceivedWorkTargets(storage, observed);
  return resolved;
}

function resolveIn(storage: StorageContext, input: Parameters<typeof resolveWorkReference>[1], observed: Parameters<typeof indexReceivedWorkTargets>[1][number][] = [], datasetAccess?: DatasetReferenceAccess): WorkReferenceRead {
  if (!validReference(input.reference)) return unavailable;
  const row = storage.db.prepare("SELECT * FROM sync_relay_work_references WHERE reference=?").get(input.reference);
  if (!row) return unavailable;
  const workspaceId = String(row.workspace_id), target = decodeWorkTarget(JSON.parse(String(row.target_json)));
  const current = scope(storage, workspaceId, target, datasetAccess);
  // Tombstones retain the last scope internally; all public failures stay identical.
  if (!current?.live) return unavailable;
  if (input.reader.kind === "user" && storage.workspaceIsOwnedBy(workspaceId, input.reader.userId)) {
    return {status: "found", reference: input.reference, target, workspaceId, createdAtMs: Number(row.created_at_ms)};
  }
  const grant = authorizations(storage, workspaceId, input.reader).find(grant => readable(storage, workspaceId, target, current, grant));
  if (!grant) return unavailable;
  const recipient: ReceivedRecipient = input.reader.kind === "user" ? ["user", input.reader.userId] : ["link", input.reader.grantId];
  const identity = createReceivedIdentity(input.identityKey), sourceHandle = identity.source(recipient, workspaceId);
  if (!sourceHandle) return unavailable;
  const projected = "objectId" in target ? {...target, objectId: identity.object(recipient, workspaceId, target.objectId)!} : target;
  if (input.reader.kind === "link") input.reader.requireSession();
  if ("objectId" in target && "objectId" in projected) {
    observed.push({recipient, workspaceId, objectId: target.objectId, objectToken: projected.objectId, sourceHandle});
  }
  return {status: "found", reference: input.reference, sourceHandle, target: projected, createdAtMs: Number(row.created_at_ms)};
}

export async function listWorkReferences(storage: StorageContext, input: {
  workspaceId: string; reader: WorkReferenceReader; after?: string; identityKey?: string | Uint8Array;
}): Promise<{references: WorkReferenceMapping[]; nextAfter: string | null}> {
  const observed: Parameters<typeof indexReceivedWorkTargets>[1][number][] = [];
  const candidates = storage.readLiveAuthority(() => {
    const owner = input.reader.kind === "user" && storage.workspaceIsOwnedBy(input.workspaceId, input.reader.userId);
    if (!owner && !authorizations(storage, input.workspaceId, input.reader).length) throw notFound();
    const identity = JSON.stringify([input.workspaceId, input.reader.kind, input.reader.kind === "user" ? input.reader.userId : input.reader.grantId,
      input.reader.grantId ?? null]);
    const key = input.identityKey && createHash("sha256").update(input.identityKey).digest();
    if (!owner && !key) throw notFound();
    let after = input.after ?? "";
    if (!owner && after) {
      try {
        if (after.length > 2048) throw notFound();
        const bytes = Buffer.from(after, "base64url"), decipher = createDecipheriv("aes-256-gcm", key!, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(identity));
        decipher.setAuthTag(bytes.subarray(12, 28));
        after = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
      } catch { throw notFound(); }
    }
    const rows = storage.db.prepare(`SELECT reference,target_json FROM sync_relay_work_references WHERE workspace_id=? AND reference>?
      ORDER BY reference LIMIT ?`).all(input.workspaceId, after, WORK_REFERENCE_BATCH);
    return {rows, owner, key, identity};
  });
  const datasetAccess = await prepareDatasetAccess(storage, input.workspaceId, input.reader,
    candidates.rows.map(row => decodeWorkTarget(JSON.parse(String(row.target_json)))));
  const page = storage.readLiveAuthority(() => {
    const {rows, owner, key, identity} = candidates;
    if (!owner && !authorizations(storage, input.workspaceId, input.reader).length || owner &&
        !(input.reader.kind === "user" && storage.workspaceIsOwnedBy(input.workspaceId, input.reader.userId))) throw notFound();
    const references = rows.flatMap(row => {
      const resolved = resolveIn(storage, {...input, reference: String(row.reference)}, observed, datasetAccess);
      return resolved.status === "found" ? [{reference: resolved.reference, target: resolved.target, createdAtMs: resolved.createdAtMs}] : [];
    });
    let nextAfter = rows.length === WORK_REFERENCE_BATCH ? String(rows.at(-1)!.reference) : null;
    if (nextAfter && !owner) {
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key!, nonce);
      cipher.setAAD(Buffer.from(identity));
      const bytes = Buffer.concat([cipher.update(nextAfter, "utf8"), cipher.final()]);
      nextAfter = Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64url");
    }
    return {references, nextAfter};
  });
  indexReceivedWorkTargets(storage, observed);
  return page;
}

export function updateWorkReferenceScopes(storage: StorageContext, workspaceId: string, objectId: string, versionId: string, path: string | null): void {
  storage.db.prepare(`UPDATE sync_relay_work_reference_scopes SET last_path=coalesce(?,last_path),deleted=?
    WHERE object_id=? AND version_id=? AND reference IN (SELECT reference FROM sync_relay_work_references WHERE workspace_id=?)`)
    .run(path, path === null ? 1 : 0, objectId, versionId, workspaceId);
}
