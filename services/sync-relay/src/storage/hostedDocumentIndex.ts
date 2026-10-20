import type {SqliteDb} from "./types";

/** The op kinds that name one live document, and so may belong to a hosted one. */
export const HOSTED_DOCUMENT_OP_KINDS = ["moment.append", "ydoc.update", "live.audit.application", "live.audit.settlement", "live.audit.base"] as const;
const INDEX = "idx_sync_relay_log_hosted_documents";
const KINDS = HOSTED_DOCUMENT_OP_KINDS.map(kind => `'${kind}'`).join(",");
const OBJECT = `CASE op_kind WHEN 'live.audit.settlement' THEN json_extract(payload_json, '$.record.binding.objectId')
  WHEN 'live.audit.base' THEN json_extract(payload_json, '$.record.checkpoint.binding.objectId')
  ELSE json_extract(payload_json, '$.objectId') END`;

export function initializeHostedDocumentIndex(db: SqliteDb): void {
  db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON sync_relay_log(workspace_id, ${OBJECT}, relay_seq) WHERE op_kind IN (${KINDS})`);
}

/** Every log row naming one document, through its index. `workspace` and `object` are SQL expressions. */
export function hostedDocumentRows(workspace: string, object: string): string {
  return `sync_relay_log INDEXED BY ${INDEX} WHERE workspace_id=${workspace} AND ${OBJECT}=${object} AND op_kind IN (${KINDS})`;
}
