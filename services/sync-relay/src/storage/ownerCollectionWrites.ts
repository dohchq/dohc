import { badRequest, notFound } from "../errors";
import { COLLECTION_FILE_ORIGIN_PREFIX } from "../relayLogInputs";
import type { StorageContext } from "./context";

export interface OwnerCollectionWritesInput {
  workspaceId: string;
  ownerUserId: string;
  grantId: string;
  afterOriginSeq?: number;
  limit: number;
}

/** One file a direct write changed, as the owner's moment names it. */
export interface OwnerCollectionWriteFile {
  path: string;
  objectId: string;
  momentId: string;
  /** The write created the file. */
  created: boolean;
}

export interface OwnerCollectionWrite {
  submitId: string;
  grantGeneration: number;
  committedAtMs: number;
  firstOriginSeq: number;
  files: OwnerCollectionWriteFile[];
}

export interface OwnerCollectionWritesPage {
  writes: OwnerCollectionWrite[];
  /** Pass back as `afterOriginSeq` for the next page, or null at the end. */
  nextAfterOriginSeq: number | null;
}

// A page stops past this many bytes of answer, after its first write.
const MAX_PAGE_BYTES = 256 * 1024;

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512;

function damaged(): never {
  throw new Error("Stored collection write is damaged.");
}

/**
 * The owner's read of one grant's direct writes (ADR 0013), oldest first,
 * from the ledger and the moments it names. A revoked grant stays readable,
 * so its owner can restore what the person changed. Only the workspace's
 * owner, and only a grant on one of their shares of that workspace.
 */
export function readOwnerCollectionWrites(
  storage: StorageContext,
  input: OwnerCollectionWritesInput,
): OwnerCollectionWritesPage {
  if (
    !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
    !identifier(input.workspaceId) || !identifier(input.ownerUserId) || !identifier(input.grantId) ||
    (input.afterOriginSeq !== undefined && (!Number.isSafeInteger(input.afterOriginSeq) || input.afterOriginSeq < -1))
  ) {
    throw badRequest("Invalid collection write page.");
  }
  return storage.readTx(() => {
    if (!storage.workspaceIsOwnedBy(input.workspaceId, input.ownerUserId)) throw notFound();
    const grant = storage.getShareGrant(input.grantId);
    const share = grant && storage.getShare(grant.shareId);
    if (!share || share.workspaceId !== input.workspaceId || share.granterUserId !== input.ownerUserId) throw notFound();
    const rows = storage.db.prepare(
      `SELECT submit_id, grant_generation, created_at_ms, origin_id, first_origin_seq, last_origin_seq, paths_json
       FROM sync_relay_collection_writes
       WHERE grant_id = ? AND workspace_id = ? AND first_origin_seq > ?
       ORDER BY first_origin_seq LIMIT ?`,
    ).all(input.grantId, input.workspaceId, input.afterOriginSeq ?? -1, input.limit + 1);
    const moments = storage.db.prepare(
      `SELECT origin_seq, op_kind,
         json_extract(payload_json, '$.momentId') AS moment_id,
         json_extract(payload_json, '$.objectId') AS object_id,
         json_extract(payload_json, '$.path') AS path,
         json_extract(payload_json, '$.operation') AS operation,
         json_extract(payload_json, '$.beforePresent') AS before_present,
         json_extract(payload_json, '$.author.kind') AS author_kind,
         json_extract(payload_json, '$.author.grantId') AS author_grant_id
       FROM sync_relay_log
       WHERE workspace_id = ? AND origin_id = ? AND origin_seq BETWEEN ? AND ?
       ORDER BY origin_seq`,
    );
    const origin = `${COLLECTION_FILE_ORIGIN_PREFIX}${input.grantId}`;
    const writes: OwnerCollectionWrite[] = [];
    let pageBytes = 0;
    for (const row of rows.slice(0, input.limit)) {
      const first = Number(row.first_origin_seq);
      const last = Number(row.last_origin_seq);
      if (row.origin_id !== origin || !identifier(row.submit_id)) damaged();
      let paths: unknown;
      try { paths = JSON.parse(String(row.paths_json)); } catch { damaged(); }
      if (!Array.isArray(paths) || paths.length !== last - first + 1) damaged();
      const logged = moments.all(input.workspaceId, origin, first, last);
      if (logged.length !== paths.length) damaged();
      const files = logged.map((moment, index): OwnerCollectionWriteFile => {
        if (
          Number(moment.origin_seq) !== first + index || moment.op_kind !== "moment.append" ||
          moment.operation !== "write" || moment.author_kind !== "named" || moment.author_grant_id !== input.grantId ||
          !identifier(moment.moment_id) || !identifier(moment.object_id) || moment.path !== paths[index] ||
          (moment.before_present !== "present" && moment.before_present !== "null")
        ) {
          damaged();
        }
        return {
          path: String(moment.path),
          objectId: moment.object_id,
          momentId: moment.moment_id,
          created: moment.before_present === "null",
        };
      });
      const write: OwnerCollectionWrite = {
        submitId: row.submit_id,
        grantGeneration: Number(row.grant_generation),
        committedAtMs: Number(row.created_at_ms),
        firstOriginSeq: first,
        files,
      };
      const size = Buffer.byteLength(JSON.stringify(write));
      if (pageBytes + size > MAX_PAGE_BYTES && writes.length > 0) {
        return { writes, nextAfterOriginSeq: writes.at(-1)!.firstOriginSeq };
      }
      pageBytes += size;
      writes.push(write);
    }
    return { writes, nextAfterOriginSeq: rows.length > input.limit ? writes.at(-1)!.firstOriginSeq : null };
  });
}
