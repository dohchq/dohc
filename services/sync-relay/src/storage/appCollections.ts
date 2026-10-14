import { visibleSharePath } from "@dohc/security-contract/share-selector";
import { parseLiveAuthorSnapshot } from "@dohc/live-session-contract";
import { createHash, randomUUID } from "node:crypto";
import { parseAppPublicationCandidate, parseAppCollectionCapability, APP_COLLECTION_CURSOR_BYTES, type AppCollectionCapability } from "@dohc/security-contract/app-publication";
import { APP_COLLECTION_MAX_SCHEMA_BYTES, APP_COLLECTION_MAX_RECORD_BYTES, narrowsAppCollectionCapability, exposesAppCollectionSubmittedFields, validateAppCollectionSchema, validateAppCollectionCreateFields, isAppCollectionPageRequest, isAppCollectionRecordTooLarge, projectAppCollectionRecord, pageAppCollectionRecords } from "@dohc/security-contract/app-collection";
import type { CollectionSchema } from "@dohc/workspace-contracts/collection";
import { notFound, badRequest, relayError } from "../errors";
import { effectiveShareSelector, parseStoredAnyShareSelectorJson, targetVersionId } from "../shareFilter";
import type { StorageContext } from "./context";
import { requireLinkAppPublication, type LinkAppPublicationInput, type ReadAppPublicationInput } from "./publications";
import { appendLogBatchInTransaction, maxOriginSeq } from "./log";
import { assertWorkspaceQuota } from "./workspaces";
import { commitLinkEnrollment, linkPrincipalLimitReached, linkPrincipalStorageBytes, linkWriteRefusal, readLinkEnrollment } from "./linkEnrollment";
import { readCurrentShareGrant } from "./currentShareGrant";
import type {AppCollectionReceipt,AppCollectionPage} from "@dohc/security-contract/app-publication";
export type {AppCollectionReceipt,AppCollectionPage} from "@dohc/security-contract/app-publication";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export interface AppCollectionAcceptancePolicy { maxCreatesPerGrant: number }
export interface ApproveAppCollectionInput extends ReadAppPublicationInput {
  expectedAuthorityRevision: number;
  capability: unknown | null;
}
export interface AcceptAppCollectionInput extends LinkAppPublicationInput {
  expectedAuthorityRevision: number;
  idempotencyKey: string;
  fields: unknown;
}
function containment(storage: StorageContext, shareId: string, grantId: string, versionId: string, capability: AppCollectionCapability): void {
  const share = storage.getShare(shareId), grant = storage.getShareGrant(grantId);
  const parsed = share && parseStoredAnyShareSelectorJson(share.selectorJson);
  const selector = parsed && grant && effectiveShareSelector(parsed, grant.access);
  if (!selector || "kind" in selector || targetVersionId(selector) !== versionId ||
      visibleSharePath(selector, capability.collectionPath) !== capability.collectionPath ||
      visibleSharePath(selector, `${capability.collectionPath}/collection.yaml`) !== `${capability.collectionPath}/collection.yaml`) throw notFound();
}
function schema(storage: StorageContext, workspaceId: string, versionId: string, capability: AppCollectionCapability): CollectionSchema {
  const row = storage.db.prepare(`SELECT blob_sha256,content_kind FROM sync_relay_current_files WHERE workspace_id=? AND version_id=? AND path=?`)
    .get(workspaceId, versionId, `${capability.collectionPath}/collection.yaml`);
  if (!row || row.blob_sha256 !== capability.schemaSha256 || row.content_kind !== "text") throw notFound();
  const blob = boundedBlob(storage,workspaceId,capability.schemaSha256,APP_COLLECTION_MAX_SCHEMA_BYTES);
  const checked = validateAppCollectionSchema(new TextDecoder("utf-8", {fatal: true}).decode(blob), capability, "sync service");
  if (!checked.ok) throw badRequest(checked.message);
  return checked.value;
}
function boundedBlob(storage: StorageContext, workspaceId: string, hash: string, limit: number): Uint8Array {
  const row = storage.db.prepare("SELECT byte_length,length(content) AS actual FROM sync_relay_blobs WHERE workspace_id=? AND sha256=?").get(workspaceId,hash);
  if (!row || !Number.isSafeInteger(Number(row.byte_length)) || Number(row.byte_length) < 0 || Number(row.byte_length) > limit || row.byte_length !== row.actual) throw notFound();
  const blob = storage.getBlob(workspaceId,hash);
  if (!blob || blob.byteLength !== row.byte_length || sha(blob) !== hash) throw notFound();
  return blob;
}
/** Owner approval and revocation both invalidate existing launch revisions. */
export function approveAppCollection(storage: StorageContext, input: ApproveAppCollectionInput) {
  const capability = input.capability === null ? null : parseAppCollectionCapability(input.capability);
  return storage.tx(() => {
    const row = storage.db.prepare("SELECT * FROM sync_relay_app_publications WHERE publication_id=?").get(input.publicationId);
    if (!row || row.workspace_id !== input.workspaceId || row.owner_user_id !== input.ownerUserId || !storage.workspaceIsOwnedBy(input.workspaceId,input.ownerUserId)) throw notFound();
    const revision = Number(row.authority_revision);
    if (revision !== input.expectedAuthorityRevision || revision >= Number.MAX_SAFE_INTEGER) throw relayError("conflict", "Publication authority changed.");
    if (capability) {
      if (!exposesAppCollectionSubmittedFields(capability)) throw badRequest("Collection responses are shared files. Approve reading every submitted field, or use an app backend for private responses.");
      const current = row.active === 1 ? readCurrentShareGrant(storage, {grantId: String(row.grant_id), generation: Number(row.grant_generation)}) : null;
      if (!current || current.share.shareId !== String(row.share_id) || current.share.workspaceId !== input.workspaceId || current.share.granterUserId !== input.ownerUserId) throw notFound();
      const {share, grant} = current;
      const manifest = boundedBlob(storage,input.workspaceId,String(row.manifest_sha256),input.limits.maxMetadataBytes);
      const candidate = parseAppPublicationCandidate(JSON.parse(Buffer.from(manifest).toString("utf8")),input.limits);
      const requested = candidate.capabilities?.[0] && parseAppCollectionCapability(candidate.capabilities[0]);
      if (!requested || !narrowsAppCollectionCapability(requested, capability)) throw badRequest("Collection approval exceeds the publication request.");
      containment(storage,share.shareId,grant.grantId,candidate.versionId,capability);
      schema(storage,input.workspaceId,candidate.versionId,capability);
    }
    const capabilityJson = JSON.stringify(capability);
    const storageBytes = bytes([input.publicationId,input.workspaceId,capabilityJson])+64;
    const previous = storage.db.prepare("SELECT storage_bytes FROM sync_relay_app_collection_approvals WHERE publication_id=?").get(input.publicationId);
    assertWorkspaceQuota(storage,input.workspaceId,storageBytes-Number(previous?.storage_bytes??0));
    storage.db.prepare(`INSERT INTO sync_relay_app_collection_approvals(publication_id,workspace_id,capability_json,active,storage_bytes) VALUES(?,?,?,?,?)
      ON CONFLICT(publication_id) DO UPDATE SET capability_json=excluded.capability_json,active=excluded.active,storage_bytes=excluded.storage_bytes`)
      .run(input.publicationId, input.workspaceId, capabilityJson, capability ? 1 : 0, storageBytes);
    storage.db.prepare("UPDATE sync_relay_app_publications SET authority_revision=authority_revision+1 WHERE publication_id=?").run(input.publicationId);
    return {publicationId: input.publicationId, authorityRevision: revision + 1, capability};
  });
}
function approved(storage: StorageContext, input: LinkAppPublicationInput) {
  const authority = requireLinkAppPublication(storage,input);
  const row = storage.db.prepare("SELECT capability_json FROM sync_relay_app_collection_approvals WHERE publication_id=? AND active=1").get(input.publicationId);
  if (!row) throw notFound();
  const capability = parseAppCollectionCapability(JSON.parse(String(row.capability_json)));
  if (!exposesAppCollectionSubmittedFields(capability)) throw notFound();
  const requested = authority.candidate.capabilities[0];
  if (!requested || requested.kind !== "collection-create" || !narrowsAppCollectionCapability(requested,capability)) throw notFound();
  containment(storage,authority.result.shareId,authority.result.grantId,authority.candidate.versionId,capability);
  return {...authority, capability, schema: schema(storage,authority.workspaceId,authority.candidate.versionId,capability)};
}
/** The caller must opt into collection acceptance; public activation remains gated. */
export function acceptAppCollection(storage: StorageContext, input: AcceptAppCollectionInput, policy: AppCollectionAcceptancePolicy): AppCollectionReceipt {
  if (!Number.isSafeInteger(policy.maxCreatesPerGrant) || policy.maxCreatesPerGrant < 1) throw new Error("Invalid collection acceptance quota.");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) throw badRequest("Invalid collection idempotency key.");
  return storage.tx(() => {
    const authority = approved(storage,input), {workspaceId, candidate, capability} = authority;
    const enrollment = readLinkEnrollment(storage,input,input.nowMs);
    if (!enrollment || linkWriteRefusal(enrollment)) throw notFound();
    const checkedFields = validateAppCollectionCreateFields(input.fields,capability,authority.schema);
    if (!checkedFields.ok) throw badRequest(checkedFields.message);
    const response = checkedFields.value;
    const payloadHash = sha(JSON.stringify(["dohc-app-collection-create-v1", input.publicationId, candidate.versionId, capability.collectionPath, capability.schemaSha256, response]));
    const prior = enrollment.principal && storage.db.prepare(`SELECT payload_sha256,receipt_json FROM sync_relay_app_collection_receipts WHERE grant_id=? AND principal_id=? AND idempotency_key=?`)
      .get(authority.result.grantId,enrollment.principal.principalId,input.idempotencyKey);
    if (prior) {
      if (prior.payload_sha256 !== payloadHash) throw relayError("conflict","Collection idempotency key already has another payload.");
      return JSON.parse(String(prior.receipt_json)) as AppCollectionReceipt;
    }
    const count = Number(storage.db.prepare("SELECT COUNT(*) AS n FROM sync_relay_app_collection_receipts WHERE grant_id=?").get(authority.result.grantId)?.n);
    if (count >= policy.maxCreatesPerGrant || linkPrincipalLimitReached(storage,enrollment)) throw relayError("quota_exceeded","Collection create quota reached.");
    const privateId = enrollment.principal?.principalId ?? randomUUID();
    const mapping = storage.db.prepare("SELECT public_principal_id FROM sync_relay_app_public_principals WHERE grant_id=? AND principal_id=?").get(authority.result.grantId,privateId);
    const publicId = mapping ? String(mapping.public_principal_id) : `public_${randomUUID()}`;
    const acceptanceId = `accepted_${randomUUID()}`, objectId = randomUUID(), momentId = randomUUID(), path = `${capability.collectionPath}/${acceptanceId}.md`;
    const receipt: AppCollectionReceipt = {kind:"accepted",acceptanceId,objectId,path,momentId,acceptedAtMs:input.nowMs};
    const document = Buffer.from(`---\n${JSON.stringify({...response,created_at:input.nowMs,created_by:publicId,acceptance_id:acceptanceId})}\n---\n`);
    if (isAppCollectionRecordTooLarge(document.byteLength)) throw badRequest("Collection response is too large.");
    const blobHash = sha(document);
    const receiptJson = JSON.stringify(receipt), receiptBytes = bytes([workspaceId,authority.result.grantId,privateId,input.idempotencyKey,payloadHash,receiptJson])+256;
    const mappingBytes = mapping ? 0 : bytes([workspaceId,authority.result.grantId,privateId,publicId])+128;
    const principalBytes = enrollment.principal ? 0 : linkPrincipalStorageBytes(privateId,authority.result.grantId,input.profileTokenHash);
    assertWorkspaceQuota(storage,workspaceId,receiptBytes+mappingBytes+principalBytes+document.byteLength);
    const principal = commitLinkEnrollment(storage,{...input,enrollment,principalId:privateId,displayName:null,createdAtMs:input.nowMs,discussionRevision:Number(enrollment.authority.discussion_revision)});
    const admittedAuthorSnapshot = parseLiveAuthorSnapshot([{kind:"link",publicPrincipalId:publicId,label:principal.displayName??"Anonymous"}]);
    if (!mapping) storage.db.prepare(`INSERT INTO sync_relay_app_public_principals(workspace_id,grant_id,principal_id,public_principal_id,storage_bytes) VALUES(?,?,?,?,?)`)
      .run(workspaceId,authority.result.grantId,principal.principalId,publicId,mappingBytes);
    const existing = storage.getBlob(workspaceId,blobHash);
    if (existing && (existing.byteLength !== document.byteLength || sha(existing) !== blobHash)) throw badRequest("Stored collection blob is corrupt.");
    if (!existing) storage.db.prepare("INSERT INTO sync_relay_blobs(workspace_id,sha256,byte_length,content,created_at_ms) VALUES(?,?,?,?,?)").run(workspaceId,blobHash,document.byteLength,document,input.nowMs);
    const originId = `relay:collection-create:${authority.result.grantId}`;
    const payload = {momentId,versionId:candidate.versionId,objectId,path,recordedAtMs:input.nowMs,operation:"write",beforePresent:"null",
      payloadBeforeBlobSha256:null,payloadBeforePath:null,payloadBeforeContentKind:null,payloadBeforeByteLength:null,
      payloadAfterBlobSha256:blobHash,payloadAfterPath:path,payloadAfterContentKind:"text",payloadAfterByteLength:document.byteLength,
      metadata:{origin:"sync"},authors:[{kind:"public",principalId:publicId,grantId:authority.result.grantId}]};
    // Insert the receipt before append so the append's quota check includes its durable charge.
    storage.db.prepare(`INSERT INTO sync_relay_app_collection_receipts(workspace_id,grant_id,principal_id,idempotency_key,payload_sha256,receipt_json,acceptance_id,storage_bytes) VALUES(?,?,?,?,?,?,?,?)`)
      .run(workspaceId,authority.result.grantId,principal.principalId,input.idempotencyKey,payloadHash,receiptJson,acceptanceId,receiptBytes);
    appendLogBatchInTransaction(storage,{workspaceId,originId,ops:[{originSeq:maxOriginSeq(storage,workspaceId,originId)+1,opKind:"moment.append",payloadJson:JSON.stringify(payload),recordedAtMs:input.nowMs,admittedAuthorSnapshot}]});
    return receipt;
  });
}

export interface ReadAppCollectionInput extends LinkAppPublicationInput {
  expectedAuthorityRevision: number;
  afterPath?: string;
  limit: number;
}
export function authorizeLinkAppCollection(storage: StorageContext,input:LinkAppPublicationInput) {
  return storage.readTx(()=>approved(storage,input).result);
}
/** Reads the current workspace projection, so owner edits and deletions take effect. */
export function readAppCollection(storage: StorageContext, input: ReadAppCollectionInput): AppCollectionPage {
  if (!isAppCollectionPageRequest(input.limit,input.afterPath)) throw badRequest("Invalid collection page.");
  return storage.readTx(() => {
    const authority = approved(storage,input), prefix = `${authority.capability.collectionPath}/`;
    if (!authority.capability.readFields.length) throw notFound();
    const rows = storage.db.prepare(`SELECT file.path,file.blob_sha256,file.content_kind,blob.byte_length,length(blob.content) AS actual
      FROM sync_relay_current_files file LEFT JOIN sync_relay_blobs blob ON blob.workspace_id=file.workspace_id AND blob.sha256=file.blob_sha256
      WHERE file.workspace_id=? AND file.version_id=? AND file.path>? AND file.path>=? AND file.path<?
      AND length(CAST(file.path AS BLOB))<=${APP_COLLECTION_CURSOR_BYTES} AND instr(substr(file.path,length(?)+1),'/')=0 AND file.path LIKE '%.md' ORDER BY file.path LIMIT ?`)
      .all(authority.workspaceId,authority.candidate.versionId,input.afterPath ?? "",prefix,`${authority.capability.collectionPath}0`,prefix,input.limit+1);
    function* projectedRows() {
      for (const row of rows.slice(0,input.limit)) {
        if (row.byte_length === null || row.byte_length !== row.actual) throw notFound();
        const path = String(row.path);
        if (row.content_kind !== "text" || isAppCollectionRecordTooLarge(Number(row.byte_length))) {
          yield {path,record:null};continue;
        }
        const blob = boundedBlob(storage,authority.workspaceId,String(row.blob_sha256),APP_COLLECTION_MAX_RECORD_BYTES);
        yield {path,record:projectAppCollectionRecord(path,blob,authority.capability,authority.schema)};
      }
    }
    return pageAppCollectionRecords(projectedRows(),rows.length > input.limit);
  });
}
