use super::*;
use dohc_engine_storage::TxnOutcome;

pub(crate) fn queue_history_in_tx(tx: &Transaction<'_>, workspace: &str) -> Result<(), SyncError> {
    tx.execute("INSERT OR IGNORE INTO live_audit_pending_exports(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,after_event_count)
      SELECT c.relay_database_namespace,c.workspace_id,c.main_version_id,c.object_id,c.lineage_claim_id,
        coalesce((SELECT max(p.event_count) FROM live_audit_event_publications p WHERE p.relay_database_namespace=c.relay_database_namespace AND p.workspace_id=c.workspace_id AND p.main_version_id=c.main_version_id AND p.object_id=c.object_id AND p.lineage_claim_id=c.lineage_claim_id),0)
      FROM live_accepted_checkpoints c WHERE c.workspace_id=?1 AND c.event_count=0",[workspace]).map_err(SyncError::persist)?;
    Ok(())
}

/// Whether an export stream still holds back the workspace's other history. A
/// held stream keeps its pending row, which defers its own lineage only.
pub(crate) fn pending_in_tx(tx: &Connection, workspace: &str) -> Result<bool, SyncError> {
    tx.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM live_audit_pending_exports e WHERE e.workspace_id=?1 AND NOT {HELD})"),
        [workspace],
        |r| r.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// Whether pending export `e` is held.
const HELD: &str = "EXISTS(SELECT 1 FROM live_audit_held_exports h WHERE h.workspace_id=e.workspace_id AND h.relay_database_namespace=e.relay_database_namespace AND h.main_version_id=e.main_version_id AND h.object_id=e.object_id AND h.lineage_claim_id=e.lineage_claim_id)";

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
/// A stream whose next record this store refuses is held: it keeps its
/// position and defers its lineage, stops holding back the workspace, and
/// gets one retry a pass, in the order its streams were last tried.
pub(crate) fn prepare_exports(
    store: &mut EngineStore,
    workspace: &str,
    faults: &dyn FaultInjector,
    leases: &dyn crate::LeaseProbe,
    now_ms: i64,
    writer_cache_reset_required: &mut bool,
) -> Result<Vec<crate::SharingDeclined>, SyncError> {
    let queued: bool = store.read_with(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM live_audit_pending_exports WHERE workspace_id=?1)",
            [workspace],
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)
    })?;
    if !queued {
        return Ok(Vec::new());
    }
    prepare_pending_exports(
        store,
        workspace,
        faults,
        leases,
        now_ms,
        writer_cache_reset_required,
    )
}

enum Step {
    Exported(usize),
    /// The stream cannot yet build its next record and waits for the next pass.
    Skipped([String; 4]),
    /// The stream is held; the line reports a stream held for the first time.
    Held(Option<String>),
}

#[cold]
fn prepare_pending_exports(
    store: &mut EngineStore,
    workspace: &str,
    faults: &dyn FaultInjector,
    leases: &dyn crate::LeaseProbe,
    now_ms: i64,
    writer_cache_reset_required: &mut bool,
) -> Result<Vec<crate::SharingDeclined>, SyncError> {
    let mut bytes = 0usize;
    let mut declined = Vec::new();
    // Streams before this key wait for the next pass.
    let mut skipped = [String::new(), String::new(), String::new(), String::new()];
    let mut retried = false;
    for _ in 0..crate::MAX_PUSH_OPS_PER_BATCH {
        let result=store.write_with(faults,|tx|{
            let mut stream:Option<(String,String,String,String,i64)>=tx.query_row(&format!("SELECT e.relay_database_namespace,e.main_version_id,e.object_id,e.lineage_claim_id,e.after_event_count FROM live_audit_pending_exports e WHERE e.workspace_id=?1 AND (e.relay_database_namespace,e.main_version_id,e.object_id,e.lineage_claim_id)>(?2,?3,?4,?5) AND NOT {HELD} ORDER BY e.relay_database_namespace,e.main_version_id,e.object_id,e.lineage_claim_id LIMIT 1"),params![workspace,skipped[0],skipped[1],skipped[2],skipped[3]],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(SyncError::corrupt)?;
            let retry = stream.is_none() && !retried;
            if retry {
                stream=tx.query_row("SELECT e.relay_database_namespace,e.main_version_id,e.object_id,e.lineage_claim_id,e.after_event_count FROM live_audit_held_exports h JOIN live_audit_pending_exports e USING(workspace_id,relay_database_namespace,main_version_id,object_id,lineage_claim_id) WHERE h.workspace_id=?1 ORDER BY h.retry_order LIMIT 1",[workspace],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(SyncError::corrupt)?;
                retried = true;
            }
            let Some((namespace,version,object,lineage,after))=stream else{return Ok::<_,SyncError>(None);};
            let p = [namespace.as_str(), workspace, &version, &object, &lineage];
            tx.execute_batch("SAVEPOINT dohc_audit_export").map_err(SyncError::persist)?;
            let step = match export_next(tx, p, after, now_ms) {
                Ok(written) => {
                    tx.execute_batch("RELEASE dohc_audit_export").map_err(SyncError::persist)?;
                    tx.execute(&format!("DELETE FROM live_audit_held_exports WHERE {SCOPE}"), p).map_err(SyncError::persist)?;
                    Step::Exported(written)
                }
                Err(error) => {
                    let refused = crate::apply::refusal_reason(&error).is_some();
                    if !refused && !matches!(error.original(), SyncError::RetryableState { .. }) {
                        return Err(error);
                    }
                    tx.execute_batch("ROLLBACK TO dohc_audit_export; RELEASE dohc_audit_export").map_err(SyncError::persist)?;
                    if refused || retry {
                        let first = tx.execute("INSERT OR IGNORE INTO live_audit_held_exports(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,retry_order) VALUES (?1,?2,?3,?4,?5,0)", p).map_err(SyncError::persist)? == 1;
                        tx.execute(&format!("UPDATE live_audit_held_exports SET retry_order=(SELECT coalesce(max(retry_order),0)+1 FROM live_audit_held_exports WHERE workspace_id=?2) WHERE {SCOPE}"), p).map_err(SyncError::persist)?;
                        Step::Held(first.then(|| format!("engine: live audit export of document {object}, version {version}, lineage {lineage} is held: {error}")))
                    } else {
                        Step::Skipped([namespace.clone(), version.clone(), object.clone(), lineage.clone()])
                    }
                }
            };
            // A finished or newly held stream can be the last one holding
            // back the workspace's other history.
            let finished = match step {
                Step::Exported(_) | Step::Held(Some(_)) if !pending_in_tx(tx, workspace)? => Some(
                    crate::enrolment::finish_live_history_enrolment_in_tx(tx, workspace, leases, now_ms)?,
                ),
                _ => None,
            };
            Ok(Some((step, finished)))
        })?;
        let (step, finished) = match result {
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
            TxnOutcome::Committed(None) => break,
            TxnOutcome::Committed(Some(step)) => step,
        };
        if let Some(finished) = finished {
            // Finishing native history can claim bases.
            *writer_cache_reset_required = true;
            declined.extend(finished);
        }
        match step {
            Step::Skipped(stream) => skipped = stream,
            // Reported after commit, so a rolled-back hold reports nothing.
            Step::Held(line) => line.into_iter().for_each(|line| eprintln!("{line}")),
            Step::Exported(written) => {
                *writer_cache_reset_required = true;
                bytes = bytes.saturating_add(written);
                if bytes >= dohc_engine_storage::limits::MAX_BLOB_BYTES {
                    break;
                }
            }
        }
    }
    Ok(declined)
}

/// Journal one stream's next record, or finish the stream.
fn export_next(
    tx: &Transaction<'_>,
    p: [&str; 5],
    after: i64,
    now_ms: i64,
) -> Result<usize, SyncError> {
    let [namespace, workspace, ..] = p;
    let json: String = tx
        .query_row(
            &format!(
                "SELECT binding_json FROM live_accepted_checkpoints WHERE {SCOPE} AND event_count=0"
            ),
            p,
            |r| r.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let binding: LiveObjectBinding = serde_json::from_str(&json).map_err(SyncError::corrupt)?;
    let next:Option<(i64,i64)>=tx.query_row(&format!("SELECT event_count,length(CAST(metadata_json AS BLOB)) FROM live_accepted_updates WHERE {SCOPE} AND event_count>?6 ORDER BY event_count LIMIT 1"),params![p[0],p[1],p[2],p[3],p[4],after],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(SyncError::corrupt)?;
    if let Some((count, length)) = next {
        journal_live_event_in_tx(tx, namespace, &binding, count, now_ms)?
            .ok_or_else(|| invalid("native audit export has no relay position"))?;
        tx.execute(
            &format!("UPDATE live_audit_pending_exports SET after_event_count=?6 WHERE {SCOPE}"),
            params![p[0], p[1], p[2], p[3], p[4], count],
        )
        .map_err(SyncError::persist)?;
        return usize::try_from(length).map_err(SyncError::corrupt);
    }
    journal_live_base_in_tx(tx, namespace, &binding, now_ms)?
        .ok_or_else(|| invalid("native audit export has no relay position"))?;
    let next_settlement:Option<(String,i64)>=tx.query_row(&format!("SELECT s.settlement_id,s.terminal_cursor FROM live_device_settlements s WHERE {SCOPE} AND s.terminal_cursor>(SELECT after_settlement_cursor FROM live_audit_pending_exports WHERE {SCOPE}) ORDER BY s.terminal_cursor LIMIT 1"),p,|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(SyncError::corrupt)?;
    if let Some((id, cursor)) = next_settlement {
        settlement_record::journal_ready_in_tx(tx, workspace, &id, now_ms)?
            .ok_or_else(|| invalid("native settlement export has no relay position"))?;
        tx.execute(
            &format!(
                "UPDATE live_audit_pending_exports SET after_settlement_cursor=?6 WHERE {SCOPE}"
            ),
            params![p[0], p[1], p[2], p[3], p[4], cursor],
        )
        .map_err(SyncError::persist)?;
        return Ok(crate::MAX_PAYLOAD_JSON_BYTES);
    }
    tx.execute(
        &format!("DELETE FROM live_audit_pending_exports WHERE {SCOPE}"),
        p,
    )
    .map_err(SyncError::persist)?;
    Ok(0)
}
