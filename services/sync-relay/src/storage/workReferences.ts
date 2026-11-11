import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";
import {decodeWorkReferenceMapping, decodeWorkTarget, type WorkReferenceMapping, type WorkTarget} from "@dohc/workspace-engine-client/daemon";
import {stableJsonStringify} from "../canonicalJson";
import {notFound} from "../errors";
import {authorizeShareGrantAction, type AuthorizedShareAction} from "../shareAuthorization";
import {createReceivedIdentity, type ReceivedRecipient} from "../receivedIdentity";
import {fileSideOf, filterOpForShare, pathVisibleThroughShare, targetVersionId, type ChatShareThreadResolver} from "../shareFilter";
import type {StorageContext} from "./context";

export const WORK_REFERENCE_BATCH = 128;
export const WORK_REFERENCE_SCAN_LIMIT = 1024;
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
  return prepareDatasetAccess(storage, input.workspaceId, {kind: "user", userId: input.userId}, input.references.map(mapping => mapping.target));
}

function snapshotObject(storage: StorageContext, workspaceId: string, versionId: string, field: "object_id" | "path", value: string) {
  return storage.db.prepare(`SELECT s.object_id,s.path FROM sync_relay_work_reference_snapshot_objects s
    JOIN sync_relay_current_files f ON f.workspace_id=s.workspace_id AND f.version_id=s.version_id AND f.path=s.path AND f.state_relay_seq=s.relay_seq
    WHERE s.workspace_id=? AND s.version_id=? AND s.${field}=?`).get(workspaceId, versionId, value);
}

// The first create of a chat by its channel id: its wire id and kind.
function chatCreate(storage: StorageContext, workspaceId: string, channelId: string): {wireId: string; kind: unknown} | null {
  const row = storage.db.prepare(`SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='chat.channel.create'
    AND json_extract(payload_json,'$.channelId')=? ORDER BY relay_seq LIMIT 1`).get(workspaceId, channelId);
  if (!row) return null;
  const payload = JSON.parse(String(row.payload_json)) as {wireId?: unknown; kind?: unknown};
  return {wireId: typeof payload.wireId === "string" ? payload.wireId : channelId, kind: payload.kind};
}

type Scope = {versionId: string | null; objectId: string | null; path: string | null; live: boolean};
function scope(storage: StorageContext, workspaceId: string, target: WorkTarget, datasetAccess?: DatasetReferenceAccess): Scope | null {
  if (target.kind === "chat") {
    return chatCreate(storage, workspaceId, target.channelId) ? {versionId: null, objectId: null, path: null, live: true} : null;
  }
  if (target.kind === "message" || target.kind === "thread") {
    if (target.kind === "message") {
      const row = storage.db.prepare(`SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='chat.message.append'
        AND json_extract(payload_json,'$.messageId')=? ORDER BY relay_seq LIMIT 1`).get(workspaceId, target.messageId);
      if (!row) return null;
      const message = JSON.parse(String(row.payload_json)) as {threadId?: string};
      if (message.threadId !== target.threadId) return null;
    }
    const wire = storage.findThreadCreateChannelWireId(workspaceId, target.threadId);
    // Engine channel ids are local. Only the admitted thread's wire id crosses the relay.
    if (wire === undefined) return null;
    const channelId = target.channelId ?? null;
    if (channelId !== null) {
      const channel = storage.db.prepare(`SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='chat.channel.create'
        AND json_extract(payload_json,'$.wireId')=? ORDER BY relay_seq LIMIT 1`).get(workspaceId, wire);
      if (!channel || JSON.parse(String(channel.payload_json)).channelId !== channelId) return null;
    } else if (wire !== null) return null;
    return {versionId: null, objectId: null, path: null, live: true};
  }
  if (target.kind === "transactionalCollection" || target.kind === "transactionalRecord") {
    const proof = datasetAccess?.get(targetJson(target));
    return {versionId: null, objectId: null, path: null, live: proof?.() ?? false};
  }
  let objectId: string;
  if (target.kind === "documentRecord") {
    const records = storage.db.prepare(`SELECT path FROM sync_relay_current_record_ids WHERE workspace_id=? AND version_id=? AND record_id=? LIMIT 2`)
      .all(workspaceId, target.versionId, target.recordId);
    if (records.length !== 1) {
      const deleted = storage.db.prepare(`SELECT object_id,last_path FROM sync_relay_work_reference_record_objects
        WHERE workspace_id=? AND version_id=? AND record_id=? LIMIT 2`).all(workspaceId,target.versionId,target.recordId);
      return records.length === 0 && deleted.length === 1 ? {versionId: target.versionId,
        objectId: String(deleted[0]!.object_id), path: String(deleted[0]!.last_path), live: false} : null;
    }
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
  const lastPath = path ?? storage.db.prepare(`SELECT path FROM sync_relay_object_moments
    WHERE workspace_id=? AND object_id=? AND version_id=? AND path IS NOT NULL ORDER BY relay_seq DESC LIMIT 1`)
    .get(workspaceId,objectId,target.versionId)?.path;
  return {versionId: target.versionId, objectId, path: lastPath == null ? null : String(lastPath), live};
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
  // A thread reads as its messages do.
  if (target.kind === "message" || target.kind === "thread") {
    return filterOpForShare(grant.effectiveSelector, "chat.message.append", JSON.stringify({
      messageId: target.kind === "message" ? target.messageId : "reference", threadId: target.threadId, body: "",
      authorKind: "human", authorId: "reference", createdAtMs: 0,
    }), chat(storage, workspaceId)).allowed;
  }
  // A chat reads only through a share of that chat.
  if (target.kind === "chat") {
    const created = chatCreate(storage, workspaceId, target.channelId);
    return !!created && filterOpForShare(grant.effectiveSelector, "chat.channel.create", JSON.stringify({
      channelId: target.channelId, wireId: created.wireId, kind: created.kind, name: "", slug: "", createdAtMs: 0,
    }), chat(storage, workspaceId), "chat").allowed;
  }
  if (target.kind === "transactionalCollection" || target.kind === "transactionalRecord") return current.live;
  const files = fileSideOf(grant.effectiveSelector);
  return !!files && targetVersionId(files) === current.versionId && current.path !== null && pathVisibleThroughShare(files, current.path);
}

function insert(storage: StorageContext, workspaceId: string, mapping: WorkReferenceMapping, actor: string, current: Scope): void {
  const binding = targetJson(mapping.target);
  storage.db.prepare("INSERT INTO sync_relay_work_references(reference,workspace_id,target_json,created_at_ms,registered_by) VALUES (?,?,?,?,?)")
    .run(mapping.reference, workspaceId, binding, mapping.createdAtMs, actor);
  storage.db.prepare("INSERT INTO sync_relay_work_reference_scopes VALUES (?,?,?,?,?,?)")
    .run(mapping.reference, workspaceId, current.versionId, current.objectId, current.path, current.live ? 0 : 1);
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
        const current = scope(storage, input.workspaceId, mapping.target, input.datasetAccess);
        if (current) refreshScope(storage, mapping.reference, current);
        registered.push(mapping.reference);
        continue;
      }
      const current = scope(storage, input.workspaceId, mapping.target, input.datasetAccess);
      if (!current && input.deferMissing) continue;
      if (!current) throw notFound();
      insert(storage, input.workspaceId, mapping, input.userId, current);
      registered.push(mapping.reference);
    }
    return registered;
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
    if (!owner && (target.kind === "message" || target.kind === "thread")) {
      const wire = storage.findThreadCreateChannelWireId(input.workspaceId, target.threadId);
      const channel = wire && storage.db.prepare(`SELECT payload_json FROM sync_relay_log WHERE workspace_id=? AND op_kind='chat.channel.create'
        AND json_extract(payload_json,'$.wireId')=? ORDER BY relay_seq LIMIT 1`).get(input.workspaceId, wire);
      target = {...target, channelId: channel ? JSON.parse(String(channel.payload_json)).channelId : null};
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
  // Message, thread, and record ids match the share's other read paths.
  let projected = "objectId" in target ? {...target, objectId: identity.object(recipient, workspaceId, target.objectId)!} : target;
  if ((projected.kind === "message" || projected.kind === "thread") && (input.reader.kind === "link" || fileSideOf(grant.effectiveSelector))) {
    const {channelId: _channelId, ...chatTarget} = projected;
    projected = chatTarget;
  }
  if (input.reader.kind === "link") input.reader.requireSession();
  if ("objectId" in target && "objectId" in projected) {
    observed.push({recipient, workspaceId, objectId: target.objectId, objectToken: projected.objectId, sourceHandle});
  }
  return {status: "found", reference: input.reference, sourceHandle, target: projected, createdAtMs: Number(row.created_at_ms)};
}

export async function listWorkReferences(storage: StorageContext, input: {
  workspaceId: string; reader: WorkReferenceReader; after?: string; identityKey?: string | Uint8Array;
}): Promise<{references: WorkReferenceMapping[]; nextAfter: string; hasMore: boolean}> {
  const observed: Parameters<typeof indexReceivedWorkTargets>[1][number][] = [];
  const owner = input.reader.kind === "user" && storage.workspaceIsOwnedBy(input.workspaceId, input.reader.userId);
  const identity = JSON.stringify([input.workspaceId, input.reader.kind, input.reader.kind === "user" ? input.reader.userId : input.reader.grantId,
    input.reader.grantId ?? null]);
  const key = input.identityKey && createHash("sha256").update(input.identityKey).digest();
  const authorize = () => {
    if (owner) {
      if (!(input.reader.kind === "user" && storage.workspaceIsOwnedBy(input.workspaceId, input.reader.userId))) throw notFound();
      return "";
    }
    const grants = authorizations(storage, input.workspaceId, input.reader);
    if (!key || !grants.length) throw notFound();
    return createHash("sha256").update(stableJsonStringify(grants.map(grant => [
      grant.grant.grantId, grant.grant.generation, grant.effectiveSelector,
    ]))).digest("hex");
  };
  const shareVersion = storage.readLiveAuthority(authorize);
  let after = input.after ?? "0";
  if (!owner && input.after) {
    try {
      if (after.length !== 144) throw notFound();
      const bytes = Buffer.from(after, "base64url");
      if (bytes.length !== 108) throw notFound();
      const decipher = createDecipheriv("aes-256-gcm", key!, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(identity));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const cursor = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
      after = cursor.slice(16) === shareVersion ? cursor.slice(0, 16) : "0";
    } catch { throw notFound(); }
  }
  if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw notFound();
  let scanAfter = Number(after), scanned = 0, exhausted = false;
  const proofs = new Map<string, () => boolean>();
  const admitted: {seq: number; mapping: WorkReferenceMapping}[] = [];
  const mappingAt = (row: {reference: unknown; target_json: unknown; created_at_ms: unknown}, datasetAccess: DatasetReferenceAccess): WorkReferenceMapping | null => {
    const target = decodeWorkTarget(JSON.parse(String(row.target_json)));
    if (owner) return {reference: String(row.reference), target, createdAtMs: Number(row.created_at_ms)};
    const resolved = resolveIn(storage, {...input, reference: String(row.reference)}, observed, datasetAccess);
    return resolved.status === "found" ? {reference: resolved.reference, target: resolved.target, createdAtMs: resolved.createdAtMs} : null;
  };
  const checkAuthority = () => { if (authorize() !== shareVersion) throw notFound(); };
  while (admitted.length <= WORK_REFERENCE_BATCH && scanned < WORK_REFERENCE_SCAN_LIMIT) {
    const limit = Math.min(WORK_REFERENCE_BATCH, WORK_REFERENCE_SCAN_LIMIT - scanned);
    const rows = storage.readLiveAuthority(() => {
      checkAuthority();
      return storage.db.prepare(`SELECT seq,reference,target_json,created_at_ms FROM sync_relay_work_references WHERE workspace_id=? AND seq>?
        ORDER BY seq LIMIT ?`).all(input.workspaceId, scanAfter, limit);
    });
    scanned += rows.length;
    if (!rows.length) { exhausted = true; break; }
    const datasetAccess = owner ? proofs : await prepareDatasetAccess(storage, input.workspaceId, input.reader,
      rows.map(row => decodeWorkTarget(JSON.parse(String(row.target_json)))));
    storage.readLiveAuthority(() => {
      checkAuthority();
      for (const row of rows) {
        scanAfter = Number(row.seq);
        const mapping = mappingAt(row as Parameters<typeof mappingAt>[0], datasetAccess);
        if (mapping) {
          const proof = datasetAccess.get(String(row.target_json));
          if (proof) proofs.set(String(row.target_json), proof);
          admitted.push({seq: scanAfter, mapping});
        }
        if (admitted.length > WORK_REFERENCE_BATCH) break;
      }
    });
    if (rows.length < limit) { exhausted = true; break; }
  }
  const page = storage.readLiveAuthority(() => {
    checkAuthority();
    const authorized = admitted.flatMap(row => {
      const stored = storage.db.prepare(`SELECT reference,target_json,created_at_ms FROM sync_relay_work_references WHERE reference=?`).get(row.mapping.reference);
      const mapping = stored && mappingAt(stored as Parameters<typeof mappingAt>[0], proofs);
      return mapping ? [{seq: row.seq, mapping}] : [];
    });
    const visible = authorized.slice(0, WORK_REFERENCE_BATCH);
    const lookahead = authorized.length > WORK_REFERENCE_BATCH;
    const hasMore = lookahead || !exhausted && scanned === WORK_REFERENCE_SCAN_LIMIT;
    const position = String(lookahead ? visible.at(-1)!.seq : scanAfter);
    let nextAfter = position;
    if (!owner) {
      const plaintext = position.padStart(16, "0") + shareVersion;
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key!, nonce);
      cipher.setAAD(Buffer.from(identity));
      const bytes = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      nextAfter = Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64url");
    }
    return {references: visible.map(row => row.mapping), nextAfter, hasMore};
  });
  indexReceivedWorkTargets(storage, observed);
  return page;
}

function refreshScope(storage: StorageContext, reference: string, current: Scope): void {
  const stored = storage.db.prepare(`SELECT version_id,object_id,last_path,deleted FROM sync_relay_work_reference_scopes WHERE reference=?`).get(reference);
  if (!stored) throw notFound();
  const path = current.path ?? stored.last_path;
  if (stored.version_id === current.versionId && stored.object_id === current.objectId && stored.last_path === path && stored.deleted === (current.live ? 0 : 1)) return;
  storage.db.prepare(`UPDATE sync_relay_work_reference_scopes SET version_id=?,object_id=?,last_path=?,deleted=? WHERE reference=?`)
    .run(current.versionId,current.objectId,path,current.live ? 0 : 1,reference);
  storage.db.prepare(`UPDATE sync_relay_work_references SET seq=(SELECT coalesce(max(seq),0)+1 FROM sync_relay_work_references) WHERE reference=?`).run(reference);
}

export function updateWorkReferenceScopes(storage: StorageContext, workspaceId: string, objectId: string, versionId: string, path: string | null): void {
  const rows = storage.db.prepare(`SELECT reference FROM sync_relay_work_reference_scopes WHERE workspace_id=? AND version_id=? AND object_id=?`)
    .all(workspaceId, versionId, objectId);
  for (const row of rows) refreshScope(storage, String(row.reference), {versionId,objectId,path,live:path !== null});
}
