import type {StorageContext} from "./context";
import {hostedDocumentRows} from "./serviceHostFeed";
import {ORDINARY_ACTIVATION_BASES} from "./ordinaryActivationBasis";
import {SERVICE_ACTIVATIONS} from "./serviceActivationSchema";
import {LIVE_RESTORE_OPERATIONS} from "./liveRestoreOperationSchema";

/**
 * What a document's durable history says about giving it a first live base.
 * `prior-authority`: it has had live-document authority before.
 * `deletion`: it was deleted at some point, even if it was restored since.
 */
export type FirstOpenEligibility = "eligible" | "prior-authority" | "deletion";

const target = (table: string) => `${table} WHERE workspace_id=t.workspace_id AND main_version_id='main' AND object_id=t.object_id`;
const rows = hostedDocumentRows("t.workspace_id", "t.object_id");
// The object's whole history: no path, scope, epoch-floor, stream, lineage or
// version filter, and departed publications count. A relay refusal is stored
// as `relay.refused`, so it never matches; a refused settlement is not a deletion.
// One statement, so it reads one snapshot inside or outside the relay writer.
// Stop/restore operations are indexed under their namespace first, and rows
// from every namespace count, so `n` steps through the namespaces present.
const QUERY = `WITH RECURSIVE t(workspace_id,object_id) AS (SELECT ?,?),
  n(namespace) AS (SELECT min(relay_database_namespace) FROM ${LIVE_RESTORE_OPERATIONS} UNION ALL
    SELECT (SELECT min(relay_database_namespace) FROM ${LIVE_RESTORE_OPERATIONS} WHERE relay_database_namespace>n.namespace) FROM n WHERE n.namespace IS NOT NULL)
SELECT EXISTS(SELECT 1 FROM ${rows} AND op_kind='ydoc.update')
    OR EXISTS(SELECT 1 FROM ${target("sync_relay_live_documents")})
    OR EXISTS(SELECT 1 FROM ${target(ORDINARY_ACTIVATION_BASES)})
    OR EXISTS(SELECT 1 FROM ${target(SERVICE_ACTIVATIONS)})
    OR EXISTS(SELECT 1 FROM n JOIN ${target(LIVE_RESTORE_OPERATIONS)} AND relay_database_namespace=n.namespace) AS prior_authority,
  EXISTS(SELECT 1 FROM ${rows} AND op_kind='moment.append' AND json_extract(payload_json,'$.operation')='delete'
    AND COALESCE(json_extract(settlement_admission_json,'$.status'),'')<>'refused') AS deletion
FROM t JOIN sync_relay_workspaces w ON w.workspace_id=t.workspace_id`;

/** Throws, never answers `eligible`, when the relay holds no history for the workspace. */
export function readFirstOpenEligibility(storage: StorageContext, input: {workspaceId: string; objectId: string}): FirstOpenEligibility {
  const row = storage.db.prepare(QUERY).get(input.workspaceId, input.objectId);
  if (!row) throw new Error("The relay holds no history for this workspace.");
  return Number(row.prior_authority) ? "prior-authority" : Number(row.deletion) ? "deletion" : "eligible";
}
