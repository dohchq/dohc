import {parseReleasePublicationTag, type ReleasePublicationTag, type ReleasePublicationAdmission} from "@dohc/live-session-contract/release-claim";
import type {StorageContext} from "./context";
import type {SyncRelayLogInput} from "./types";
import {RELEASE_TOMBSTONES} from "./releaseClaimSchema";
import {LIVE_RESTORE_OPERATIONS} from "./liveRestoreOperationSchema";
import {badRequest} from "../errors";
import {validateUserWritePath} from "@dohc/workspace-core";

const tags = new WeakMap<SyncRelayLogInput,ReleasePublicationTag | null>();
export function releasePublicationTag(op: SyncRelayLogInput): ReleasePublicationTag | null {
  const retained = tags.get(op); if (retained !== undefined) return retained;
  if (op.opKind !== "ydoc.update" && op.opKind !== "moment.append") {tags.set(op,null); return null;}
  if (!op.payloadJson.includes('"release"')) {tags.set(op,null); return null;}
  const payload = JSON.parse(op.payloadJson) as Record<string,unknown>;
  if (!Object.hasOwn(payload,"release")) {tags.set(op,null); return null;}
  try {
    const tag = parseReleasePublicationTag(payload.release);
    const path = typeof payload.path === "string" ? validateUserWritePath(payload.path) : null;
    const sha = op.opKind === "ydoc.update" ? payload.updateBlobSha256 : payload.payloadAfterBlobSha256;
    if (!["ydoc.update","moment.append"].includes(op.opKind) || payload.versionId !== tag.document.mainVersionId ||
      payload.objectId !== tag.document.objectId || !path?.ok || path.normalized !== payload.path ||
      typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha) ||
      (op.opKind === "ydoc.update" && (payload.lineageClaimId !== tag.document.lineageClaimId || payload.contentKind !== "richdoc" || typeof payload.isBaseState !== "boolean")) ||
      (op.opKind === "moment.append" && (typeof payload.momentId !== "string" || !payload.momentId || payload.operation !== "write" || payload.payloadAfterContentKind !== "text" ||
        Object.hasOwn(payload,"authors") || !Number.isSafeInteger(payload.payloadAfterByteLength) || Number(payload.payloadAfterByteLength) < 0 || payload.payloadAfterPath !== payload.path))) throw Error();
    tags.set(op,tag); return tag;
  } catch {throw badRequest("Invalid release publication envelope.");}
}
/** Called only inside the ordinary append transaction, after the workspace guard. */
export function admitReleasePublication(storage: StorageContext, op: SyncRelayLogInput, workspaceId: string): void {
  const tag = releasePublicationTag(op); if (!tag) return;
  const current = storage.db.prepare("SELECT lineage_claim_id,restore_fence_generation FROM sync_relay_live_documents WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND lineage_state='current'")
    .get(workspaceId,tag.document.objectId);
  let reason: ReleasePublicationAdmission["reason"] | undefined;
  if (storage.db.prepare(`SELECT 1 FROM ${RELEASE_TOMBSTONES} WHERE workspace_id=? AND object_id=? AND release_digest=? AND publication_fenced=1`)
    .get(workspaceId,tag.document.objectId,tag.releaseDigest)) reason = "release-publication-fenced";
  else if (storage.db.prepare(`SELECT 1 FROM ${LIVE_RESTORE_OPERATIONS} WHERE workspace_id=? AND main_version_id='main' AND object_id=? AND phase<>'resumed'`)
    .get(workspaceId,tag.document.objectId)) reason = "release-restore-in-progress";
  else if (!current || current.lineage_claim_id !== tag.document.lineageClaimId) reason = "release-document-changed";
  else if (current.restore_fence_generation !== tag.restoreFenceGeneration) reason = "release-generation-fenced";
  if (reason) {
    op.settlementAdmission = {status:"refused",kind:"release-publication",releaseDigest:tag.releaseDigest,reason};
  }
}
