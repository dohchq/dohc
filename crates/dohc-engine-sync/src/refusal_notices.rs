use dohc_engine_storage::{EngineStore, FaultInjector, TxnOutcome, hex_sha256};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::SyncError;

// Retained-update refusals share invalid-input; their messages distinguish the retained mutation.
pub(crate) enum RetainedUpdateRefusal {
    ProjectionTooLarge(dohc_engine_collab::ContentKind),
    ContentKindMismatch,
    InvalidContentKind,
}

impl RetainedUpdateRefusal {
    pub(crate) const fn message_prefix(&self) -> &'static str {
        use dohc_engine_collab::ContentKind;
        match self {
            Self::ProjectionTooLarge(ContentKind::Plaintext) => "plaintext projection exceeds ",
            Self::ProjectionTooLarge(ContentKind::Richdoc) => "richdoc projection exceeds ",
            Self::ProjectionTooLarge(ContentKind::Scene) => "scene projection exceeds ",
            Self::ContentKindMismatch => {
                "ydoc.update content kind does not match the established lineage"
            }
            Self::InvalidContentKind => {
                "ydoc.update content kind must be `plaintext`, `richdoc`, or `scene`"
            }
        }
    }
}

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
    pub refusal_coordinates: Vec<RefusalCoordinate>,
    pub origin_id: Option<String>,
    pub origin_seq: Option<i64>,
    pub reason: String,
    pub document: Option<RefusalDocument>,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum RefusalCoordinate {
    Replication {
        #[serde(rename = "originId")]
        origin_id: String,
        #[serde(rename = "originSeq")]
        origin_seq: i64,
    },
    LocalObligation {
        #[serde(rename = "obligationOrder")]
        obligation_order: i64,
        #[serde(rename = "checkpointSha256")]
        checkpoint_sha256: String,
        #[serde(rename = "headSha256")]
        head_sha256: Option<String>,
    },
}

fn document(payload: &Value) -> Option<RefusalDocument> {
    let object = payload["objectId"]
        .as_str()
        .or(payload["transition"]["result"]["objectId"].as_str())
        .or(payload["transition"]["current"]["objectId"].as_str())?;
    let lineage = payload["lineageClaimId"]
        .as_str()
        .or(payload["settlementReference"]["record"]["binding"]["lineageClaimId"].as_str())
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
            "SELECT p.origin_id,p.origin_seq,p.reason_message,r.payload_json,p.reason_code \
         FROM replication_pending_refusals p JOIN replication_log r \
         USING(workspace_id,origin_id,origin_seq) WHERE p.workspace_id=?1 AND COALESCE(p.report_id,'') != ?2 \
         AND r.op_kind NOT LIKE 'live.audit.%' ORDER BY r.rowid",
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
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    let mut notices = rows.into_iter()
        .map(|(origin_id, origin_seq, reason, payload, code)| {
            let payload: Value = serde_json::from_str(&payload).map_err(SyncError::corrupt)?;
            let mut document = document(&payload);
            if reason == crate::moment_apply::pending::BINDING_CHANGED {
                // The audit retains the held lineage after its queue row clears.
                // Resolve its current path without falling back to the old name.
                document = conn.query_row(
                    "SELECT json_extract(a.record_json,'$.binding.mainVersionId'),\
                            json_extract(a.record_json,'$.binding.objectId'),\
                            json_extract(a.record_json,'$.binding.lineageClaimId'),\
                            json_extract(b.binding_json,'$.currentPath') \
                     FROM live_audit_settlements a LEFT JOIN ydoc_owner_bindings b \
                       ON b.workspace_id=a.workspace_id \
                       AND b.main_version_id=json_extract(a.record_json,'$.binding.mainVersionId') \
                       AND b.object_id=json_extract(a.record_json,'$.binding.objectId') \
                       AND b.lineage_claim_id=json_extract(a.record_json,'$.binding.lineageClaimId') \
                       AND b.relay_database_namespace=json_extract(a.record_json,'$.relayDatabaseNamespace') \
                     WHERE a.workspace_id=?1 AND json_extract(a.record_json,'$.momentId')=?2 \
                       AND a.markdown_digest=?3 \
                       AND json_extract(a.record_json,'$.binding.mainVersionId')=?4 \
                       AND json_extract(a.record_json,'$.binding.objectId')=?5 \
                       AND (?6 IS NULL OR json_extract(a.record_json,'$.binding.lineageClaimId')=?6) \
                     ORDER BY json_extract(a.record_json,'$.terminalCursor') DESC LIMIT 1",
                    params![workspace_id, payload["momentId"].as_str(), payload["payloadAfterBlobSha256"].as_str(), payload["versionId"].as_str(), payload["objectId"].as_str(), document.as_ref().map(|doc| doc.lineage_claim_id.as_str())],
                    |row| Ok(RefusalDocument { version_id: row.get(0)?, object_id: row.get(1)?, lineage_claim_id: row.get(2)?, path: row.get(3)?, conflict_id: None }),
                ).optional().map_err(SyncError::corrupt)?;
            }
            if document.is_none() && code==crate::moment_apply::open_artifacts::RECOVERY_FAILURE_CODE {
                document=conn.query_row("SELECT p.version_id,p.object_id,p.lineage_claim_id,d.path FROM ydoc_pending_artifacts p JOIN ydoc_docs d USING(workspace_id,version_id,object_id) WHERE p.workspace_id=?1 AND p.origin_id=?2 AND p.origin_seq=?3",
                    params![workspace_id,origin_id,origin_seq],|row|Ok(RefusalDocument {version_id:row.get(0)?,object_id:row.get(1)?,lineage_claim_id:row.get(2)?,path:row.get(3)?,conflict_id:None})).optional().map_err(SyncError::corrupt)?;
            }

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
                refusal_coordinates: vec![RefusalCoordinate::Replication {
                    origin_id: origin_id.clone(),
                    origin_seq,
                }],
                notice_id: format!(
                    "sync-refusal-{}",
                    hex_sha256(identity.to_string().as_bytes())
                ),
                origin_id: Some(origin_id),
                origin_seq: Some(origin_seq),
                reason,
                document,
            })
        })
        .collect::<Result<Vec<_>, SyncError>>()?;
    for owed in dohc_engine_collab::markdown_write_obligations::pending_in(conn, workspace_id)
        .map_err(crate::ydoc_apply::map_collab_hard_error)?
    {
        let Some(checkpoint) = owed.held_checkpoint_sha256 else {
            continue;
        };
        let dismissed: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM markdown_write_obligation_notice_dismissals \
             WHERE obligation_order=?1 AND checkpoint_sha256=?2 AND head_sha256 IS ?3)",
                params![owed.order, checkpoint, owed.held_head_sha256],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if dismissed {
            continue;
        }
        let identity = serde_json::json!([
            workspace_id,
            "lineage",
            owed.key.version_id,
            owed.key.object_id,
            owed.lineage_claim_id
        ]);
        notices.push(RefusalNotice {
            notice_id: format!(
                "sync-refusal-{}",
                hex_sha256(identity.to_string().as_bytes())
            ),
            refusal_coordinates: vec![RefusalCoordinate::LocalObligation {
                obligation_order: owed.order,
                checkpoint_sha256: checkpoint,
                head_sha256: owed.held_head_sha256,
            }],
            origin_id: None,
            origin_seq: None,
            reason: "markdown-write-held".into(),
            document: Some(RefusalDocument {
                version_id: Some(owed.key.version_id),
                object_id: owed.key.object_id,
                lineage_claim_id: owed.lineage_claim_id,
                path: Some(owed.path),
                conflict_id: None,
            }),
        });
    }
    Ok(notices)
}

pub fn list_refusal_notices(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<RefusalNotice>, SyncError> {
    store.read_with(|conn| {
        let mut notices = std::collections::BTreeMap::<String, RefusalNotice>::new();
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
            if let Some(mut previous) = notices.remove(&row.notice_id) {
                previous.refusal_coordinates.append(&mut row.refusal_coordinates);
                row.refusal_coordinates = previous.refusal_coordinates;
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
    for coordinate in &row.refusal_coordinates {
        if let RefusalCoordinate::LocalObligation {
            obligation_order,
            checkpoint_sha256,
            head_sha256,
        } = coordinate
        {
            tx.execute("INSERT INTO markdown_write_obligation_notice_dismissals \
                (obligation_order,checkpoint_sha256,head_sha256) VALUES (?1,?2,?3) \
                ON CONFLICT(obligation_order) DO UPDATE SET checkpoint_sha256=excluded.checkpoint_sha256,head_sha256=excluded.head_sha256",
                params![obligation_order,checkpoint_sha256,head_sha256]).map_err(SyncError::persist)?;
        }
    }
    tx.execute("DELETE FROM replication_pending_refusals WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
        params![workspace_id, row.origin_id, row.origin_seq]).map_err(SyncError::persist)?;
    Ok(())
}

pub fn dismiss_refusal_notice(
    store: &mut EngineStore,
    workspace_id: &str,
    notice_id: &str,
    refusal_coordinates: &[RefusalCoordinate],
    faults: &dyn FaultInjector,
) -> Result<(), SyncError> {
    let shown: std::collections::HashSet<_> = refusal_coordinates.iter().collect();
    match store.write_with(faults, |tx| {
        for row in rows(tx, workspace_id)? {
            if row.notice_id == notice_id && shown.contains(&row.refusal_coordinates[0]) {
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
         AND (substr(p.reason_message,1,length(?6))=?6 \
           OR substr(p.reason_message,1,length(?7))=?7 \
           OR substr(p.reason_message,1,length(?8))=?8 \
            OR p.reason_message IN (?9,?10,?11)) \
          AND (p.reason_message != ?11 OR NOT EXISTS(SELECT 1 FROM markdown_write_obligations o \
            WHERE o.workspace_id=?1 AND o.version_id=?5 AND o.object_id=?2 AND o.lineage_claim_id=?3 \
              AND o.completed=0 AND o.held_checkpoint_sha256 IS NOT NULL)) AND EXISTS( \
         SELECT 1 FROM replication_log r WHERE r.workspace_id=p.workspace_id \
         AND r.origin_id=p.origin_id AND r.origin_seq=p.origin_seq \
         AND COALESCE(json_extract(r.payload_json,'$.objectId'), \
           json_extract(r.payload_json,'$.transition.result.objectId'), \
           json_extract(r.payload_json,'$.transition.current.objectId'))=?2 \
         AND COALESCE(json_extract(r.payload_json,'$.lineageClaimId'), \
           json_extract(r.payload_json,'$.lineageTransition.successor.lineageClaimId'))=?3 \
         AND COALESCE(json_extract(r.payload_json,'$.versionId'), \
           json_extract(r.payload_json,'$.targetVersionId'))=?5)",
        params![
            workspace_id, object_id, lineage_claim_id,
            crate::apply::DIRECT_RPC_REFUSAL_REPORT_ID, version_id,
            RetainedUpdateRefusal::ProjectionTooLarge(dohc_engine_collab::ContentKind::Plaintext).message_prefix(),
            RetainedUpdateRefusal::ProjectionTooLarge(dohc_engine_collab::ContentKind::Richdoc).message_prefix(),
            RetainedUpdateRefusal::ProjectionTooLarge(dohc_engine_collab::ContentKind::Scene).message_prefix(),
            RetainedUpdateRefusal::ContentKindMismatch.message_prefix(),
            RetainedUpdateRefusal::InvalidContentKind.message_prefix(),
            "markdown-write-held",
        ],
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

    #[test]
    fn markdown_hold_notice_dismissal_preserves_debt_and_new_checkpoints() {
        use dohc_engine_collab::markdown_write_obligations::{
            self as obligations, Kind, Obligation,
        };
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE versions(workspace_id TEXT,version_id TEXT,PRIMARY KEY(workspace_id,version_id));
             INSERT INTO versions VALUES ('ws','main');",
        )
        .unwrap();
        conn.execute_batch(include_str!(
            "../../dohc-engine-storage/src/markdown_write_obligations.sql"
        ))
        .unwrap();
        conn.execute_batch("CREATE TABLE replication_pending_refusals(workspace_id TEXT,origin_id TEXT,origin_seq INTEGER,\
            reason_message TEXT,reason_code TEXT,report_id TEXT);\
            CREATE TABLE replication_log(workspace_id TEXT,origin_id TEXT,origin_seq INTEGER,op_kind TEXT,payload_json TEXT)").unwrap();
        let mut owed = Obligation {
            order: 0,
            key: dohc_engine_collab::DocKey::new("ws", "main", "note").unwrap(),
            lineage_claim_id: "claim".into(),
            operation_id: "session".into(),
            kind: Kind::Session,
            path: "note.md".into(),
            retry_inputs: json!({}),
            held_checkpoint_sha256: Some("first".into()),
            held_head_sha256: None,
            source_sha256: None,
            settled_head_sha256: None,
        };
        obligations::record_in(&conn, &owed, 1).unwrap();
        let shown = rows(&conn, "ws").unwrap().remove(0);
        assert!(matches!(
            &shown.refusal_coordinates[0],
            RefusalCoordinate::LocalObligation {
                head_sha256: None,
                ..
            }
        ));
        let tx = conn.transaction().unwrap();
        delete_row(&tx, "ws", &shown).unwrap();
        tx.commit().unwrap();
        assert!(rows(&conn, "ws").unwrap().is_empty());
        assert_eq!(obligations::pending_in(&conn, "ws").unwrap().len(), 1);
        owed.held_checkpoint_sha256 = Some("next".into());
        obligations::record_in(&conn, &owed, 2).unwrap();
        let next = rows(&conn, "ws").unwrap().remove(0);
        assert_eq!(shown.notice_id, next.notice_id);
        assert_ne!(shown.refusal_coordinates, next.refusal_coordinates);
        assert!(rows(&conn, "other-workspace").unwrap().is_empty());
        obligations::complete_in(&conn, &owed, 3).unwrap();
        assert!(rows(&conn, "ws").unwrap().is_empty());
    }

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
            settlement_admission: None,
            admitted_author_snapshot: None,
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
        let coordinates = &notices
            .iter()
            .find(|notice| notice.notice_id == main_id)
            .unwrap()
            .refusal_coordinates;
        dismiss_refusal_notice(&mut store, "ws", &main_id, coordinates, &NoFaults).unwrap();
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
    fn dismissal_preserves_refusals_arriving_after_list() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        refuse(&mut store, "ws", "object", "lineage", 0);
        refuse(&mut store, "ws", "object", "lineage", 1);
        let shown = list_refusal_notices(&store, "ws").unwrap().remove(0);
        assert_eq!(shown.refusal_coordinates.len(), 2);
        refuse(&mut store, "ws", "object", "lineage", 2);
        // A different origin can use a lower sequence on the same lineage.
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO replication_log (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) SELECT workspace_id,'another-peer',0,op_kind,payload_json,recorded_at_ms,imported FROM replication_log WHERE workspace_id='ws' AND origin_id='peer' AND origin_seq=2", []).unwrap();
            tx.execute("INSERT INTO replication_pending_refusals (workspace_id,origin_id,origin_seq,op_kind,reason_code,reason_message) SELECT workspace_id,'another-peer',0,op_kind,reason_code,reason_message FROM replication_pending_refusals WHERE workspace_id='ws' AND origin_id='peer' AND origin_seq=2", []).unwrap();
            Ok::<_, SyncError>(())
        }).unwrap();
        for _ in 0..2 {
            dismiss_refusal_notice(
                &mut store,
                "ws",
                &shown.notice_id,
                &shown.refusal_coordinates,
                &NoFaults,
            )
            .unwrap();
            let remaining = list_refusal_notices(&store, "ws").unwrap();
            assert_eq!(remaining.len(), 1);
            assert_eq!(remaining[0].notice_id, shown.notice_id);
            assert_eq!(
                remaining[0].refusal_coordinates,
                vec![
                    RefusalCoordinate::Replication {
                        origin_id: "peer".into(),
                        origin_seq: 2
                    },
                    RefusalCoordinate::Replication {
                        origin_id: "another-peer".into(),
                        origin_seq: 0
                    },
                ]
            );
        }
    }

    #[test]
    fn successful_projection_clears_each_retained_update_reason() {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        let reasons = [
            "plaintext projection exceeds MAX_TEXT_BYTES: limit 10 bytes, observed at least 11 bytes",
            "richdoc projection exceeds MAX_PROJECTION_BYTES: limit 10 bytes, observed at least 11 bytes",
            "scene projection exceeds MAX_PROJECTION_BYTES: limit 10 bytes, observed at least 11 bytes",
            "ydoc.update content kind does not match the established lineage",
            "ydoc.update content kind must be `plaintext`, `richdoc`, or `scene`",
        ];
        for (seq, reason) in reasons.into_iter().enumerate() {
            let seq = seq as i64;
            refuse(&mut store, "ws", "object", "lineage", seq);
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE replication_pending_refusals SET reason_message=?1 WHERE origin_seq=?2",
                        params![reason, seq],
                    )
                    .map_err(SyncError::persist)?;
                    Ok::<_, SyncError>(())
                })
                .unwrap();
        }
        store
            .write_with(&NoFaults, |tx| {
                clear_lineage_in_tx(tx, "ws", "main", "object", "lineage")
            })
            .unwrap();
        assert!(list_refusal_notices(&store, "ws").unwrap().is_empty());
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
        assert_eq!(remaining[0].origin_seq, Some(0));
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
                ordinary_pull: None,
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
        let shown = list_refusal_notices(&store, "ws").unwrap().remove(0);
        dismiss_refusal_notice(
            &mut store,
            "other",
            &id,
            &shown.refusal_coordinates,
            &NoFaults,
        )
        .unwrap();
        assert_eq!(list_refusal_notices(&store, "ws").unwrap().len(), 1);
        dismiss_refusal_notice(&mut store, "ws", &id, &shown.refusal_coordinates, &NoFaults)
            .unwrap();
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
