import type {StorageContext} from "./context";
import {hostedDocumentRows} from "./serviceHostFeed";
import {ORDINARY_ACTIVATION_BASES} from "./ordinaryActivationBasis";
import {SERVICE_ACTIVATIONS} from "./serviceActivationSchema";
import {LIVE_RESTORE_OPERATIONS} from "./liveRestoreOperationSchema";

/**
 * What a document's durable history says about giving it a first live base.
 * `prior-authority`: it has had live-document authority before.
 * `deletion`: it was deleted or replaced at some point, even if it was restored since.
 */
export type FirstOpenEligibility = "eligible" | "prior-authority" | "deletion";

const target = (table: string) => `${table} WHERE workspace_id=t.workspace_id AND main_version_id='main' AND object_id=t.object_id`;
const settled = "COALESCE(json_extract(settlement_admission_json,'$.status'),'')<>'refused'";
// The object's whole history: no path, scope, epoch-floor, stream, lineage or
// version filter, and departed publications count. A relay refusal is stored
// as `relay.refused`, so it never matches; a refused settlement is not a deletion.
// `h` reads the object's own rows once: 2 when one is a Y.Doc update or live
// audit, 1 when one is a deletion. A replacement names the displaced object
// only as `beforeObjectId`, so it is found by scanning the workspace's log.
// One statement, so it reads one snapshot inside or outside the relay writer.
// Stop/restore operations are indexed under their namespace first, and rows
// from every namespace count, so `n` steps through the namespaces present.
const QUERY = `WITH RECURSIVE t(workspace_id,object_id) AS (SELECT ?,?),
  n(namespace) AS (SELECT min(relay_database_namespace) FROM ${LIVE_RESTORE_OPERATIONS} UNION ALL
    SELECT (SELECT min(relay_database_namespace) FROM ${LIVE_RESTORE_OPERATIONS} WHERE relay_database_namespace>n.namespace) FROM n WHERE n.namespace IS NOT NULL),
  h(history) AS MATERIALIZED (SELECT (SELECT max(CASE WHEN op_kind<>'moment.append' THEN 2
    WHEN json_extract(payload_json,'$.operation')='delete' AND ${settled} THEN 1 ELSE 0 END) FROM ${hostedDocumentRows("t.workspace_id", "t.object_id")}) FROM t)
SELECT CASE WHEN h.history=2
    OR EXISTS(SELECT 1 FROM ${target("sync_relay_live_documents")})
    OR EXISTS(SELECT 1 FROM ${target(ORDINARY_ACTIVATION_BASES)})
    OR EXISTS(SELECT 1 FROM ${target(SERVICE_ACTIVATIONS)})
    OR EXISTS(SELECT 1 FROM n JOIN ${target(LIVE_RESTORE_OPERATIONS)} AND relay_database_namespace=n.namespace) THEN 'prior-authority'
  WHEN h.history=1
    OR EXISTS(SELECT 1 FROM sync_relay_log INDEXED BY idx_sync_relay_log_page WHERE workspace_id=t.workspace_id AND op_kind='moment.append'
      AND json_extract(payload_json,'$.beforeObjectId')=t.object_id AND json_extract(payload_json,'$.objectId') NOT IN (t.object_id,'') AND ${settled})
    THEN 'deletion' ELSE 'eligible' END AS eligibility
FROM t JOIN sync_relay_workspaces w ON w.workspace_id=t.workspace_id, h`;

/** Throws, never answers `eligible`, when the relay holds no history for the workspace. */
export function readFirstOpenEligibility(storage: StorageContext, input: {workspaceId: string; objectId: string}): FirstOpenEligibility {
  const row = storage.db.prepare(QUERY).get(input.workspaceId, input.objectId);
  if (!row) throw new Error("The relay holds no history for this workspace.");
  return row.eligibility as FirstOpenEligibility;
}
