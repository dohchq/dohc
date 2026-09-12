import {badRequest, notFound} from "../errors";
import type {StorageContext} from "./context";
import type {AppCollectionReceipt} from "./appCollections";

export interface OwnerAppCollectionAcceptancesInput {
  workspaceId: string;
  ownerUserId: string;
  grantId: string;
  publicPrincipalId?: string;
  afterAcceptanceId?: string;
  limit: number;
}
export interface OwnerAppCollectionAcceptance extends AppCollectionReceipt {
  publicPrincipalId: string;
  versionId: string;
  collectionPath: string;
}
export interface OwnerAppCollectionAcceptancesPage {
  acceptances: OwnerAppCollectionAcceptance[];
  nextAcceptanceId: string | null;
}

const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512;
function damaged(): never {throw new Error("Stored collection acceptance is damaged.");}

/** Owner moderation uses immutable acceptances, never editable response fields. */
export function readOwnerAppCollectionAcceptances(storage: StorageContext, input: OwnerAppCollectionAcceptancesInput): OwnerAppCollectionAcceptancesPage {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
      !identifier(input.workspaceId) || !identifier(input.ownerUserId) || !identifier(input.grantId) ||
      (input.publicPrincipalId !== undefined && !identifier(input.publicPrincipalId)) ||
      (input.afterAcceptanceId !== undefined && !identifier(input.afterAcceptanceId))) throw badRequest("Invalid collection moderation page.");
  return storage.readTx(() => {
    if (!storage.workspaceIsOwnedBy(input.workspaceId,input.ownerUserId)) throw notFound();
    const grant = storage.getShareGrant(input.grantId), share = grant && storage.getShare(grant.shareId);
    if (!share || share.workspaceId !== input.workspaceId || share.granterUserId !== input.ownerUserId) throw notFound();
    const selected = input.publicPrincipalId === undefined ? null : storage.db.prepare(`SELECT principal_id FROM sync_relay_app_public_principals
      WHERE public_principal_id=? AND workspace_id=? AND grant_id=?`).get(input.publicPrincipalId,input.workspaceId,input.grantId);
    if (input.publicPrincipalId !== undefined && !selected) return {acceptances:[],nextAcceptanceId:null};
    // Revoked grants remain selectable so their owner can remove accepted responses.
    const rows = storage.db.prepare(`SELECT r.acceptance_id,
      CASE WHEN length(CAST(r.receipt_json AS BLOB))<=8192 THEN r.receipt_json END AS receipt_json,
      p.public_principal_id
      FROM sync_relay_app_collection_receipts r
      LEFT JOIN sync_relay_app_public_principals p ON p.workspace_id=r.workspace_id AND p.grant_id=r.grant_id AND p.principal_id=r.principal_id
      WHERE r.workspace_id=? AND r.grant_id=? AND r.acceptance_id>?
        ${selected ? "AND r.principal_id=?" : ""}
      ORDER BY r.acceptance_id LIMIT ?`).all(input.workspaceId,input.grantId,input.afterAcceptanceId ?? "",
        ...(selected ? [String(selected.principal_id)] : []),input.limit+1);
    const acceptances: OwnerAppCollectionAcceptance[] = [];
    let pageBytes = 0;
    const firstMoment = storage.db.prepare(`SELECT m.moment_id,m.version_id,m.path,l.origin_id,l.op_kind,
      json_extract(l.payload_json,'$.author.kind') AS author_kind,
      json_extract(l.payload_json,'$.author.principalId') AS public_id,
      json_extract(l.payload_json,'$.author.grantId') AS grant_id,
      json_extract(l.payload_json,'$.operation') AS operation
      FROM sync_relay_object_moments m JOIN sync_relay_log l ON l.relay_seq=m.relay_seq AND l.workspace_id=m.workspace_id
      WHERE m.workspace_id=? AND m.object_id=? ORDER BY m.relay_seq LIMIT 1`);
    for (const row of rows.slice(0,input.limit)) {
      if (typeof row.receipt_json !== "string" || !identifier(row.public_principal_id)) damaged();
      let receipt: AppCollectionReceipt;
      try { receipt = JSON.parse(row.receipt_json) as AppCollectionReceipt; } catch { damaged(); }
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) damaged();
      if (receipt.kind !== "accepted" || receipt.acceptanceId !== row.acceptance_id ||
          !identifier(receipt.objectId) || !identifier(receipt.momentId) || typeof receipt.path !== "string" ||
          Buffer.byteLength(receipt.path)>4096 || !Number.isSafeInteger(receipt.acceptedAtMs) || receipt.acceptedAtMs<0) damaged();
      const original = firstMoment.get(input.workspaceId,receipt.objectId);
      if (!original || original.moment_id !== receipt.momentId || !identifier(original.version_id) || original.path !== receipt.path ||
          original.origin_id !== `relay:collection-create:${input.grantId}` || original.op_kind !== "moment.append" ||
          original.operation !== "write" || original.author_kind !== "public" || original.public_id !== row.public_principal_id ||
          original.grant_id !== input.grantId) damaged();
      const slash = receipt.path.lastIndexOf("/");
      if (slash < 1 || receipt.path.slice(slash+1) !== `${receipt.acceptanceId}.md`) damaged();
      const item = {kind: "accepted" as const, acceptanceId: receipt.acceptanceId, objectId: receipt.objectId,
        path: receipt.path, momentId: receipt.momentId, acceptedAtMs: receipt.acceptedAtMs,
        publicPrincipalId: row.public_principal_id, versionId: original.version_id, collectionPath: receipt.path.slice(0,slash)};
      const size = Buffer.byteLength(JSON.stringify(item));
      if (pageBytes+size>65_536 && acceptances.length) return {acceptances,nextAcceptanceId:acceptances.at(-1)!.acceptanceId};
      pageBytes+=size; acceptances.push(item);
    }
    return {acceptances,nextAcceptanceId:rows.length>input.limit ? acceptances.at(-1)!.acceptanceId : null};
  });
}
