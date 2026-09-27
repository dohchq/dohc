use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome, hex_sha256};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;
use serde_json::Value;

use crate::SyncError;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusalDocument {
    pub version_id: Option<String>,
    pub object_id: String,
    pub lineage_claim_id: String,
    pub path: Option<String>,
    pub conflict_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusalNotice {
    pub notice_id: String,
    pub origin_id: String,
    pub origin_seq: i64,
    pub reason: String,
    pub document: Option<RefusalDocument>,
}

fn document(payload: &Value) -> Option<RefusalDocument> {
    let object = payload["objectId"]
        .as_str()
        .or(payload["transition"]["result"]["objectId"].as_str())
        .or(payload["transition"]["current"]["objectId"].as_str())?;
    let lineage = payload["lineageClaimId"]
        .as_str()
        .or(payload["lineageTransition"]["successor"]["lineageClaimId"].as_str())?;
    let path = payload["path"].as_str().or_else(|| {
        payload["transition"]["result"]["pathRef"]
            .as_u64()
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| payload["paths"][index].as_str())
    });
    Some(RefusalDocument {
        version_id: payload["versionId"]
            .as_str()
            .or(payload["targetVersionId"].as_str())
            .map(str::to_owned),
        object_id: object.to_owned(),
        lineage_claim_id: lineage.to_owned(),
        path: path.map(str::to_owned),
        conflict_id: payload["conflictId"].as_str().map(str::to_owned),
    })
}

fn rows(conn: &Connection, workspace_id: &str) -> Result<Vec<RefusalNotice>, SyncError> {
    let mut statement = conn
        .prepare(
            "SELECT p.origin_id,p.origin_seq,p.reason_message,r.payload_json \
         FROM replication_pending_refusals p JOIN replication_log r \
         USING(workspace_id,origin_id,origin_seq) WHERE p.workspace_id=?1 AND COALESCE(p.report_id,'') != ?2 \
         ORDER BY r.rowid",
        )
        .map_err(SyncError::corrupt)?;
    let rows = statement
        .query_map(
            params![workspace_id, crate::apply::DIRECT_RPC_REFUSAL_REPORT_ID],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    rows.into_iter()
        .map(|(origin_id, origin_seq, reason, payload)| {
            let payload: Value = serde_json::from_str(&payload).map_err(SyncError::corrupt)?;
            let mut document = document(&payload);
            let identity = if let Some(doc) = &mut document {
                let conflict: Option<String> = conn
                    .query_row(
                        "SELECT open_conflict_id FROM ydoc_inactive_lineages \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
                        params![
                            workspace_id,
                            doc.version_id,
                            doc.object_id,
                            doc.lineage_claim_id
                        ],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(SyncError::corrupt)?
                    .flatten();
                doc.conflict_id = conflict.or(doc.conflict_id.take());
                if doc.conflict_id.is_none() {
                    doc.conflict_id = conn
                        .query_row(
                            "SELECT c.conflict_id FROM conflicts c JOIN ydoc_docs d \
                         ON d.workspace_id=c.workspace_id AND d.version_id=c.target_version_id \
                         WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3 \
                         AND d.lineage_claim_id=?4 AND c.status='open' \
                         AND (c.current_object_id=d.object_id OR c.incoming_object_id=d.object_id) \
                         ORDER BY c.created_at_ms,c.conflict_id LIMIT 1",
                            params![
                                workspace_id,
                                doc.version_id,
                                doc.object_id,
                                doc.lineage_claim_id
                            ],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(SyncError::corrupt)?;
                }
                serde_json::json!([
                    workspace_id,
                    "lineage",
                    doc.version_id,
                    doc.object_id,
                    doc.lineage_claim_id
                ])
            } else {
                serde_json::json!([workspace_id, "coordinate", origin_id, origin_seq])
            };
            Ok(RefusalNotice {
                notice_id: format!(
                    "sync-refusal-{}",
                    hex_sha256(identity.to_string().as_bytes())
                ),
                origin_id,
                origin_seq,
                reason,
                document,
            })
        })
        .collect()
}

pub fn list_refusal_notices(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<RefusalNotice>, SyncError> {
    store.read_with(|conn| {
        let mut notices = std::collections::BTreeMap::new();
        for mut row in rows(conn, workspace_id)? {
            if let Some(doc) = &mut row.document
                && let Some(conflict) = &doc.conflict_id
            {
                let open: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM conflicts WHERE workspace_id=?1 AND conflict_id=?2 AND status='open')",
                    params![workspace_id, conflict], |row| row.get(0),
                ).map_err(SyncError::corrupt)?;
                if !open { doc.conflict_id = None; }
            }
            notices.insert(row.notice_id.clone(), row);
        }
        Ok(notices.into_values().collect())
    })
}

fn delete_row(
    tx: &Transaction<'_>,
    workspace_id: &str,
    row: &RefusalNotice,
) -> Result<(), SyncError> {
    tx.execute("DELETE FROM replication_pending_refusals WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![workspace_id, row.origin_id, row.origin_seq]).map_err(SyncError::persist)?;
    Ok(())
}

pub fn dismiss_refusal_notice(
    store: &mut EngineStore,
    workspace_id: &str,
    notice_id: &str,
    faults: &dyn FaultInjector,
) -> Result<(), SyncError> {
    match store.write_with(faults, |tx| {
        for row in rows(tx, workspace_id)? {
            if row.notice_id == notice_id {
                delete_row(tx, workspace_id, &row)?;
            }
        }
        Ok::<_, SyncError>(())
    })? {
        TxnOutcome::Committed(()) => Ok(()),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

pub(crate) fn clear_lineage_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    lineage_claim_id: &str,
) -> Result<(), SyncError> {
    tx.execute(
        "DELETE FROM replication_pending_refusals AS p WHERE p.workspace_id=?1 AND COALESCE(p.report_id,'') != ?4 \
         AND (p.reason_message GLOB 'plaintext projection exceeds *' \
           OR p.reason_message GLOB 'richdoc projection exceeds *' \
           OR p.reason_message GLOB 'scene projection exceeds *' \
           OR p.reason_message IN ('ydoc.update content kind does not match the established lineage', \
             'ydoc.update content kind must be `plaintext`, `richdoc`, or `scene`')) AND EXISTS( \
         SELECT 1 FROM replication_log r WHERE r.workspace_id=p.workspace_id \
         AND r.origin_id=p.origin_id AND r.origin_seq=p.origin_seq \
         AND COALESCE(json_extract(r.payload_json,'$.objectId'), \
           json_extract(r.payload_json,'$.transition.result.objectId'), \
           json_extract(r.payload_json,'$.transition.current.objectId'))=?2 \
         AND COALESCE(json_extract(r.payload_json,'$.lineageClaimId'), \
           json_extract(r.payload_json,'$.lineageTransition.successor.lineageClaimId'))=?3 \
         AND COALESCE(json_extract(r.payload_json,'$.versionId'), \
           json_extract(r.payload_json,'$.targetVersionId'))=?5)",
        params![workspace_id, object_id, lineage_claim_id, crate::apply::DIRECT_RPC_REFUSAL_REPORT_ID, version_id],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

pub(crate) fn clear_conflict_in_tx(
    tx: &Transaction<'_>,
    workspace_id: &str,
    conflict_id: &str,
) -> Result<(), SyncError> {
    for row in rows(tx, workspace_id)? {
        let Some(doc) = &row.document else {
            continue;
        };
        let active_review: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM conflicts c JOIN ydoc_docs d \
             ON d.workspace_id=c.workspace_id AND d.version_id=c.target_version_id \
             WHERE c.workspace_id=?1 AND c.conflict_id=?2 AND d.version_id=?3 \
             AND d.object_id=?4 AND d.lineage_claim_id=?5 \
             AND (c.current_object_id=d.object_id OR c.incoming_object_id=d.object_id))",
                params![
                    workspace_id,
                    conflict_id,
                    doc.version_id,
                    doc.object_id,
                    doc.lineage_claim_id
                ],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if doc.conflict_id.as_deref() == Some(conflict_id) || active_review {
            delete_row(tx, workspace_id, &row)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ApplyDisposition, NoLiveLeases, RelayCursor, ReplicationEnvelope, apply_envelope_with,
        commit_relay_cursor,
    };
    use dohc_engine_storage::NoFaults;
    use dohc_engine_testkit::{ScratchDir, engine_db_path};
    use serde_json::json;

    fn refuse(store: &mut EngineStore, workspace: &str, object: &str, lineage: &str, seq: i64) {
        refuse_in_version(store, workspace, "main", object, lineage, seq);
    }

    fn refuse_in_version(
        store: &mut EngineStore,
        workspace: &str,
        version: &str,
        object: &str,
        lineage: &str,
        seq: i64,
    ) {
        let envelope = ReplicationEnvelope {
            workspace_id: workspace.into(),
            origin_id: "peer".into(),
            origin_seq: seq,
            relay_seq: Some(seq),
            op_kind: "ydoc.update".into(),
            recorded_at_ms: seq,
            payload: json!({"versionId":version,"objectId":object,"lineageClaimId":lineage,"path":"same.md","conflictId":"review"}),
        };
        let outcome = apply_envelope_with(store, &envelope, &NoFaults, |_, _| {
            Err::<(), _>(SyncError::InvalidInput {
                reason: "plaintext projection exceeds MAX_TEXT_BYTES: limit 10 bytes, observed at least 11 bytes",
            })
        })
        .unwrap();
        assert!(matches!(outcome.primary, ApplyDisposition::Refused(_)));
    }

    #[test]
    fn lineage_cleanup_and_dismissal_are_scoped_to_version() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        refuse(&mut store, "ws", "object", "lineage", 0);
        refuse_in_version(&mut store, "ws", "branch", "object", "lineage", 1);
        let notices = list_refusal_notices(&store, "ws").unwrap();
        assert_eq!(notices.len(), 2);
        let main_id = notices
            .iter()
            .find(|notice| notice.document.as_ref().unwrap().version_id.as_deref() == Some("main"))
            .unwrap()
            .notice_id
            .clone();
        dismiss_refusal_notice(&mut store, "ws", &main_id, &NoFaults).unwrap();
        let remaining = list_refusal_notices(&store, "ws").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0]
                .document
                .as_ref()
                .unwrap()
                .version_id
                .as_deref(),
            Some("branch")
        );

        refuse(&mut store, "ws", "object", "lineage", 2);
        store
            .write_with(&NoFaults, |tx| {
                clear_lineage_in_tx(tx, "ws", "main", "object", "lineage")
            })
            .unwrap();
        let remaining = list_refusal_notices(&store, "ws").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0]
                .document
                .as_ref()
                .unwrap()
                .version_id
                .as_deref(),
            Some("branch")
        );
    }

    #[test]
    fn successful_projection_keeps_replay_validation_refusals() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        refuse(&mut store, "ws", "object", "lineage", 0);
        refuse(&mut store, "ws", "object", "lineage", 1);
        store.write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_pending_refusals SET reason_message='inactive Y.Doc update fails replay validation' WHERE origin_seq=0",
                [],
            ).unwrap();
            clear_lineage_in_tx(tx, "ws", "main", "object", "lineage")
        }).unwrap();
        let remaining = list_refusal_notices(&store, "ws").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].origin_seq, 0);
    }

    #[test]
    fn cursor_restart_identity_resolution_and_dismissal() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        refuse(&mut store, "ws", "object-a", "inactive", 0);
        refuse(&mut store, "ws", "object-a", "inactive", 1);
        refuse(&mut store, "other", "object-a", "inactive", 0);
        let id = list_refusal_notices(&store, "ws").unwrap()[0]
            .notice_id
            .clone();
        assert_eq!(list_refusal_notices(&store, "ws").unwrap().len(), 1);
        commit_relay_cursor(
            &mut store,
            "ws",
            &RelayCursor {
                cursor: 2,
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                bootstrap_complete: true,
                settlement_report_id: None,
            },
            &NoFaults,
            &NoLiveLeases,
            2,
        )
        .unwrap();
        drop(store);
        let mut store = EngineStore::open(&db, 3).unwrap();
        assert_eq!(list_refusal_notices(&store, "ws").unwrap()[0].notice_id, id);
        store
            .write_with(&NoFaults, |tx| {
                clear_lineage_in_tx(tx, "ws", "main", "object-b", "inactive")?;
                clear_lineage_in_tx(tx, "ws", "main", "object-a", "active")?;
                clear_conflict_in_tx(tx, "ws", "unrelated")
            })
            .unwrap();
        assert_eq!(list_refusal_notices(&store, "ws").unwrap().len(), 1);
        store
            .write_with(&NoFaults, |tx| clear_conflict_in_tx(tx, "ws", "review"))
            .unwrap();
        assert!(list_refusal_notices(&store, "ws").unwrap().is_empty());
        assert_eq!(list_refusal_notices(&store, "other").unwrap().len(), 1);
        refuse(&mut store, "ws", "object-a", "inactive", 2);
        assert_eq!(list_refusal_notices(&store, "ws").unwrap().len(), 1);
        dismiss_refusal_notice(&mut store, "other", &id, &NoFaults).unwrap();
        assert_eq!(list_refusal_notices(&store, "ws").unwrap().len(), 1);
        dismiss_refusal_notice(&mut store, "ws", &id, &NoFaults).unwrap();
        drop(store);
        let mut store = EngineStore::open(&db, 4).unwrap();
        assert!(list_refusal_notices(&store, "ws").unwrap().is_empty());
        refuse(&mut store, "ws", "object-a", "inactive", 3);
        store
            .write_with(&NoFaults, |tx| {
                clear_lineage_in_tx(tx, "ws", "main", "object-a", "inactive")
            })
            .unwrap();
        assert!(list_refusal_notices(&store, "ws").unwrap().is_empty());
    }
}
