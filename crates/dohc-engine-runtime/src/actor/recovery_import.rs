use super::ActorHandle;
use crate::RuntimeError;
use dohc_engine_collab::DocKey;
use dohc_engine_domain::{ChangeActorKind, ChangeAttribution};
use dohc_engine_files::{ProjectionTargetKind, ProjectionTargetState, probe_projection_target};
use dohc_engine_storage::{FaultInjector, StorageError, TxnOutcome, hex_sha256};
use rusqlite::{OptionalExtension, params};
use std::{path::PathBuf, sync::Arc};

pub struct RecoveryUpdate {
    pub request_id: String,
    pub update: Vec<u8>,
    pub actor_origin_id: Option<String>,
    pub attribution: Option<ChangeAttribution>,
}

pub struct RecoveryImport {
    pub key: DocKey,
    pub path: String,
    pub expected_claim_id: Option<String>,
    pub expected_state_vector_sha256: String,
    pub expected_disk_sha256: Option<String>,
    pub admitted_base: Vec<u8>,
    pub updates: Vec<RecoveryUpdate>,
    pub text: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryImportOutcome {
    Replayed,
    Imported { moment_id: String },
    Covered,
}

pub struct RecoveryImportResult {
    pub outcome: RecoveryImportOutcome,
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    pub automation_claims: Vec<dohc_engine_domain::AutomationClaim>,
}

fn refused(reason: &'static str) -> RuntimeError {
    RuntimeError::RecoveryImportRefused { reason }
}

impl ActorHandle {
    /// Capture, the disk probe, author admission and replay share one writer turn.
    pub async fn capture_import_recovery(
        &self,
        root: PathBuf,
        input: RecoveryImport,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<RecoveryImportResult, RuntimeError> {
        self.run(move |store, cache| {
            let key = &input.key;
            let digest = hex_sha256(serde_json::json!([
                key.workspace_id, key.version_id, key.object_id,
                input.expected_claim_id, input.expected_state_vector_sha256,
                hex_sha256(input.text.as_bytes())
            ]).to_string().as_bytes());
            let moment_id = format!("moment-import-recovery-{digest}");
            let receipt_id = format!("import-recovery-{digest}");
            let mut record_facts = Vec::new();
            let mut automation_claims = Vec::new();
            let preparations = cache.retirement_preparations();
            let result = store.write_with(faults.as_ref(), |tx| -> Result<_, RuntimeError> {
                dohc_engine_domain::validate_addressable_plaintext_path(&input.path)?;
                if input.admitted_base.len() > 32 * 1024 * 1024 || input.updates.len() > 4096 || input.text.len() > 16 * 1024 * 1024 ||
                    input.updates.iter().map(|u| u.update.len()).sum::<usize>() > 32 * 1024 * 1024 {
                    return Err(refused("checkpoint-too-large"));
                }
                let marker = dohc_engine_collab::read_marker_in(tx, key)?;
                let mut authors = dohc_engine_collab::author_coverage::Authors::default();
                for update in &input.updates {
                    if update.request_id.is_empty() || update.request_id.len() > 1024 {
                        return Err(refused("invalid-request-id"));
                    }
                    if let Some(actor) = update.actor_origin_id.as_deref() {
                        dohc_engine_collab::validate_actor_origin_id(actor)?;
                    }
                    if let Some(attribution) = &update.attribution {
                        attribution.validate().map_err(|_| refused("invalid-author"))?;
                        // A human append names its local person, never another human.
                        if attribution.actor_kind == ChangeActorKind::Human &&
                            update.actor_origin_id.as_deref() != attribution.on_behalf_of.as_deref() {
                            return Err(refused("remote-human-author"));
                        }
                    }
                    dohc_engine_collab::Ydoc::validate_update(&update.update)?;
                    if let Some(json) = dohc_engine_domain::moment_author_json(
                        update.actor_origin_id.as_deref(), update.attribution.as_ref()) {
                        if marker.is_some() {
                            dohc_engine_collab::author_coverage::check_admission_in(tx, key,
                                update.actor_origin_id.as_deref(), update.attribution.as_ref())?;
                        }
                        authors.union_json(&json)?;
                    }
                }
                if authors.len() > dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHORS ||
                    authors.journal_bytes() > dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHOR_BYTES {
                    return Err(refused("author-capacity"));
                }
                // A committed reply may have been lost before main retired its file.
                // The moment lookup includes dismissed moments; no resurrection.
                let imported: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id=?1 AND moment_id=?2
                     AND metadata_origin IN ('capture-recovery','capture-recovery-cleared'))",
                    params![key.workspace_id, moment_id], |r| r.get(0))
                    .map_err(StorageError::corrupt_public)?;
                if imported { return Ok(RecoveryImportOutcome::Imported { moment_id: moment_id.clone() }); }
                let receipt: Option<i64> = tx.query_row(
                    "SELECT result_seq FROM engine_requests WHERE request_id=?1 AND payload_hash=?2",
                    params![receipt_id, digest], |r| r.get(0)).optional().map_err(StorageError::corrupt_public)?;
                if let Some(receipt) = receipt {
                    return Ok(if receipt == -1 { RecoveryImportOutcome::Replayed } else { RecoveryImportOutcome::Covered });
                }
                let prepared = dohc_engine_sync::prepare_local_ydoc_lineage_in_tx(tx, key)?;
                let projection = prepared.projection();
                let covered = projection.is_some_and(|p| p.content == input.text);
                // Deleted objects keep a recovery preimage in their existing History.
                let snapshot = dohc_engine_domain::store::recovery_snapshot_in(tx,
                    &key.workspace_id, &key.version_id, &key.object_id)?
                    ;
                let Some(snapshot) = snapshot else {
                    let history_covered: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM (SELECT operation,payload_before_blob_sha256 FROM moments
                         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
                         AND metadata_origin NOT IN ('capture-recovery','capture-recovery-cleared')
                         ORDER BY moment_order DESC LIMIT 1) m WHERE m.operation='delete' AND m.payload_before_blob_sha256=?4)",
                        params![key.workspace_id,key.version_id,key.object_id,hex_sha256(input.text.as_bytes())], |r|r.get(0))
                        .map_err(StorageError::corrupt_public)?;
                    if covered || history_covered {
                        tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,-2,?3,'ydoc')",
                            params![receipt_id,digest,now_ms]).map_err(StorageError::persist_public)?;
                        return Ok(RecoveryImportOutcome::Covered);
                    }
                    if !dohc_engine_domain::store::record_deleted_capture_recovery_in_tx(tx, &key.workspace_id, &key.version_id, &key.object_id, &input.text, &moment_id, authors.moment_json().as_deref(), now_ms)? { return Err(refused("object-history-missing")); }
                    return Ok(RecoveryImportOutcome::Imported {moment_id:moment_id.clone()});
                };
                let same_claim = marker.as_ref().is_some_and(|m| m.lineage_claim_id == input.expected_claim_id);
                let base = dohc_engine_collab::Ydoc::wire();
                base.apply(&input.admitted_base)?;
                if hex_sha256(&base.encode_state_vector()) != input.expected_state_vector_sha256 { return Err(refused("invalid-admitted-base")); }
                if same_claim {
                    for update in &input.updates {
                        if dohc_engine_collab::durable::recovery_update_is_recorded_in(tx,key,&input.path,&update.request_id,&update.update,update.actor_origin_id.as_deref(),update.attribution.as_ref())? {base.apply(&update.update)?;}
                    }
                }
                let same_lineage = same_claim && projection.is_some_and(|p| p.source_state_vector_sha256 == hex_sha256(&base.encode_state_vector()));
                let same_disk = match probe_projection_target(&root, &snapshot.path, ProjectionTargetKind::Plaintext) {
                    ProjectionTargetState::Text { sha256 } => input.expected_disk_sha256.as_deref() == Some(sha256.as_str()),
                    ProjectionTargetState::Absent => input.expected_disk_sha256.is_none(),
                    _ => false,
                };
                let outcome = if covered {
                    RecoveryImportOutcome::Covered
                } else if same_lineage && same_disk {
                    dohc_engine_collab::durable::require_recovery_write_in(tx,key)?;
                    let marker = marker.as_ref().expect("unchanged lineage has a marker");
                    for update in &input.updates {
                        let before = dohc_engine_collab::load_doc_in(tx, key)?;
                        let after = dohc_engine_collab::validate_replay_parity_with_scratch(&before, &update.update)?;
                        // Includes deletion sets and compacted acknowledged updates.
                        if before.encode_full_state() == after.encode_full_state() { continue; }
                        let mut append = dohc_engine_collab::durable::record_recovery_update_in_tx(tx, key, &input.path, &update.request_id, &update.update,
                            update.actor_origin_id.as_deref(), update.attribution.as_ref(), now_ms)?;
                        let local_append = super::ydoc::journal_recovery_append_in_tx(tx, key, &snapshot.path,
                            marker.content_kind, &update.update, update.actor_origin_id.as_deref(),
                            update.attribution.as_ref(), &preparations, &mut append, now_ms)?;
                        if !append.deduped && let Some(facts) = append.record_facts.take() {
                            if local_append {
                                automation_claims.extend(dohc_engine_domain::claim_automation_triggers_in_tx(tx, &key.workspace_id, &facts, now_ms)
                                    .map_err(|_| refused("automation-claim-failed"))?);
                            }
                            record_facts.push(facts);
                        }
                    }
                    // Retirement requires the entire checkpoint text to be durable.
                    let actual = dohc_engine_sync::prepare_local_ydoc_lineage_in_tx(tx, key)?;
                    if actual.projection().is_none_or(|p| p.content != input.text) {
                        return Err(refused("acknowledged-state-missing"));
                    }
                    RecoveryImportOutcome::Replayed
                } else {
                    dohc_engine_domain::store::record_keyed_capture_recovery_in_tx(tx,
                        &key.workspace_id, &snapshot, &input.text, &moment_id,
                        authors.moment_json().as_deref(), now_ms)?;
                    RecoveryImportOutcome::Imported { moment_id: moment_id.clone() }
                };
                if !matches!(outcome, RecoveryImportOutcome::Imported { .. }) {
                    tx.execute("INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) VALUES(?1,?2,?3,?4,'ydoc')",
                        params![receipt_id, digest, if matches!(outcome, RecoveryImportOutcome::Replayed) { -1 } else { -2 }, now_ms])
                        .map_err(StorageError::persist_public)?;
                }
                Ok(outcome)
            })?;
            cache.remove(key);
            match result {
                TxnOutcome::Committed(outcome) => Ok(RecoveryImportResult {outcome, record_facts, automation_claims}),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        }).await
    }
}
