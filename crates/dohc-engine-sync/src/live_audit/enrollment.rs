use super::*;
use dohc_engine_storage::TxnOutcome;

pub(crate) fn queue_history_in_tx(tx: &Transaction<'_>, workspace: &str) -> Result<(), SyncError> {
    tx.execute("INSERT OR IGNORE INTO live_audit_pending_exports(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,after_event_count)
      SELECT c.relay_database_namespace,c.workspace_id,c.main_version_id,c.object_id,c.lineage_claim_id,
        coalesce((SELECT max(p.event_count) FROM live_audit_event_publications p WHERE p.relay_database_namespace=c.relay_database_namespace AND p.workspace_id=c.workspace_id AND p.main_version_id=c.main_version_id AND p.object_id=c.object_id AND p.lineage_claim_id=c.lineage_claim_id),0)
      FROM live_accepted_checkpoints c WHERE c.workspace_id=?1 AND c.event_count=0",[workspace]).map_err(SyncError::persist)?;
    Ok(())
}

pub(crate) fn pending_in_tx(tx: &Connection, workspace: &str) -> Result<bool, SyncError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_audit_pending_exports WHERE workspace_id=?1)",
        [workspace],
        |r| r.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// New native edits join an in-progress enrollment stream. Once it catches up,
/// the ordinary application callback publishes in its mutation transaction.
pub fn journal_live_event_or_defer_in_tx(
    tx: &Transaction<'_>,
    namespace: &str,
    binding: &LiveObjectBinding,
    count: i64,
    now_ms: i64,
) -> Result<Option<i64>, SyncError> {
    let pending: bool = tx
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM live_audit_pending_exports WHERE {SCOPE})"),
            scope(namespace, binding),
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if pending {
        return Ok(None);
    }
    journal_live_event_in_tx(tx, namespace, binding, count, now_ms)
}

/// Each write transaction publishes at most one source event. A pass prepares
/// at most the existing push batch count and stops after a blob-sized batch.
/// Large individual records remain eligible; this is scheduling, not admission.
pub(crate) fn prepare_exports(
    store: &mut EngineStore,
    workspace: &str,
    faults: &dyn FaultInjector,
    leases: &dyn crate::LeaseProbe,
    now_ms: i64,
) -> Result<Vec<crate::SharingDeclined>, SyncError> {
    if !store.read_with(|conn| pending_in_tx(conn, workspace))? {
        return Ok(Vec::new());
    }
    let mut bytes = 0usize;
    let mut declined = Vec::new();
    for _ in 0..crate::MAX_PUSH_OPS_PER_BATCH {
        let result=store.write_with(faults,|tx|{
            let stream:Option<(String,String,String,String,i64)>=tx.query_row("SELECT relay_database_namespace,main_version_id,object_id,lineage_claim_id,after_event_count FROM live_audit_pending_exports WHERE workspace_id=?1 ORDER BY relay_database_namespace,main_version_id,object_id,lineage_claim_id LIMIT 1",[workspace],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(SyncError::corrupt)?;
            let Some((namespace,version,object,lineage,after))=stream else{return Ok::<_,SyncError>(None);};
            let p=[namespace.as_str(),workspace,version.as_str(),object.as_str(),lineage.as_str()];
            let json:String=tx.query_row(&format!("SELECT binding_json FROM live_accepted_checkpoints WHERE {SCOPE} AND event_count=0"),p,|r|r.get(0)).map_err(SyncError::corrupt)?;
            let binding:LiveObjectBinding=serde_json::from_str(&json).map_err(SyncError::corrupt)?;
            let next:Option<(i64,i64)>=tx.query_row(&format!("SELECT event_count,length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE {SCOPE} AND event_count>?6 ORDER BY event_count LIMIT 1"),params![p[0],p[1],p[2],p[3],p[4],after],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
            if let Some((count,length))=next {
                journal_live_event_in_tx(tx,&namespace,&binding,count,now_ms)?.ok_or_else(||invalid("native audit export has no relay position"))?;
                tx.execute(&format!("UPDATE live_audit_pending_exports SET after_event_count=?6 WHERE {SCOPE}"),params![p[0],p[1],p[2],p[3],p[4],count]).map_err(SyncError::persist)?;
                return Ok(Some((usize::try_from(length).map_err(SyncError::corrupt)?,Vec::new())));
            }
            journal_live_base_in_tx(tx,&namespace,&binding,now_ms)?.ok_or_else(||invalid("native audit export has no relay position"))?;
            let next_settlement:Option<(String,i64)>=tx.query_row(&format!("SELECT s.settlement_id,s.terminal_cursor FROM live_device_settlements s WHERE {SCOPE} AND s.terminal_cursor>(SELECT after_settlement_cursor FROM live_audit_pending_exports WHERE {SCOPE}) ORDER BY s.terminal_cursor LIMIT 1"),p,|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(SyncError::corrupt)?;
            if let Some((id,cursor))=next_settlement {
                settlement_record::journal_ready_in_tx(tx,workspace,&id,now_ms)?.ok_or_else(||invalid("native settlement export has no relay position"))?;
                tx.execute(&format!("UPDATE live_audit_pending_exports SET after_settlement_cursor=?6 WHERE {SCOPE}"),params![p[0],p[1],p[2],p[3],p[4],cursor]).map_err(SyncError::persist)?;
                return Ok(Some((crate::MAX_PAYLOAD_JSON_BYTES,Vec::new())));
            }
            tx.execute(&format!("DELETE FROM live_audit_pending_exports WHERE {SCOPE}"),p).map_err(SyncError::persist)?;
            let declined=if !pending_in_tx(tx,workspace)? {
                crate::enrolment::finish_live_history_enrolment_in_tx(tx,workspace,leases,now_ms)?
            }else{Vec::new()};
            Ok(Some((0,declined)))
        })?;
        match result {
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
            TxnOutcome::Committed(None) => break,
            TxnOutcome::Committed(Some((written, finished_declines))) => {
                declined.extend(finished_declines);
                bytes = bytes.saturating_add(written);
                if bytes >= dohc_engine_storage::limits::MAX_BLOB_BYTES {
                    break;
                }
            }
        }
    }
    Ok(declined)
}
