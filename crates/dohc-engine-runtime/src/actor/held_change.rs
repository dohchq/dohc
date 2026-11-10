use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{ContentKind, DocKey, Ydoc, markdown_write_obligations as obligations};
use dohc_engine_domain::{DomainError, VersionedTextStore};
use dohc_engine_files::{ProjectionTargetKind, ProjectionTargetState, probe_projection_target};
use dohc_engine_storage::{NoFaults, TxnOutcome, hex_sha256};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum HeldChangeAction {
    Review,
    Drop { token: String },
    Undo { token: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldChangeResult {
    pub path: String,
    pub token: String,
    pub authors: serde_json::Value,
    pub held: bool,
    pub history_moment_id: Option<String>,
}

fn refusal(reason: &'static str) -> RuntimeError {
    DomainError::InvalidInput { reason }.into()
}

fn fingerprint(
    marker: &dohc_engine_collab::Marker,
    head: &str,
    checkpoint: &str,
    restore: Option<i64>,
) -> String {
    hex_sha256(
        serde_json::json!([
            marker.lineage_claim_id,
            marker.head_update_seq,
            head,
            checkpoint,
            restore
        ])
        .to_string()
        .as_bytes(),
    )
}

fn document_fingerprint(doc: &Ydoc) -> String {
    hex_sha256(
        serde_json::json!([
            doc.encode_state_vector(),
            doc.encode_delete_set(),
            doc.canonical_content_sha256(),
        ])
        .to_string()
        .as_bytes(),
    )
}

impl ActorHandle {
    pub async fn held_note_change(
        &self,
        key: DocKey,
        path: String,
        root: PathBuf,
        action: HeldChangeAction,
        now_ms: i64,
    ) -> Result<HeldChangeResult, RuntimeError> {
        self.run(move |store, cache| {
            if VersionedTextStore::new(store).get_active_version(&key.workspace_id)?.version_id != key.version_id {
                return Err(refusal("held-change-stale"));
            }
            let marker = dohc_engine_collab::read_marker(store, &key)?.ok_or_else(|| refusal("held-change-missing"))?;
            if marker.path.as_deref() != Some(path.as_str()) || marker.content_kind != ContentKind::Richdoc {
                return Err(refusal("held-change-stale"));
            }
            let restore = store.read_with(|conn| {
                dohc_engine_collab::owner_outbox::require_ordinary_settlement(conn, &key)?;
                dohc_engine_collab::live_update_application::restore_generation(conn, &key)
            })?;
            if store.read_with(|conn| conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM conflicts WHERE workspace_id=?1 AND target_version_id=?2 AND path=?3 AND status='open')",
                params![key.workspace_id,key.version_id,path], |row| row.get::<_, bool>(0))
                .map_err(StorageError::corrupt_public))? {
                return Err(refusal("held-change-conflict"));
            }
            let head = VersionedTextStore::new(store).read_text(&key.workspace_id, &key.version_id, &path)?
                .filter(|head| head.object_id == key.object_id)
                .ok_or_else(|| refusal("held-change-stale"))?;
            if !matches!(probe_projection_target(&root, &path, ProjectionTargetKind::Plaintext),
                ProjectionTargetState::Text { sha256 } if sha256 == head.blob_sha256) {
                return Err(refusal("held-change-stale"));
            }
            let persisted = dohc_engine_collab::load_persisted(store, &key)?.ok_or_else(|| refusal("held-change-missing"))?;
            let doc = persisted.doc;
            if doc.has_pending_dependencies() { return Err(refusal("held-change-conflict")); }
            let checkpoint_sha = document_fingerprint(&doc);
            let current_token = fingerprint(&marker, &head.blob_sha256, &checkpoint_sha, restore);
            let owed = store.read_with(|conn| obligations::pending_in(conn, &key.workspace_id))?
                .into_iter().filter(|row| row.key == key && row.lineage_claim_id == marker.lineage_claim_id.clone().unwrap_or_default()
                    && row.kind != obligations::Kind::WitnessRefresh).collect::<Vec<_>>();
            let authors = store.read_with(|conn| dohc_engine_collab::author_coverage::interval_in(conn, &key, i64::MAX))?.json();
            let authors: serde_json::Value = serde_json::from_str(&authors).map_err(StorageError::corrupt_public)?;
            if matches!(action, HeldChangeAction::Review) {
                if !owed.iter().any(|row| row.held_checkpoint_sha256.is_some()) { return Err(refusal("held-change-missing")); }
                return Ok(HeldChangeResult {path, token: current_token, authors, held: true, history_moment_id: None});
            }
            let preparations = cache.retirement_preparations();
            cache.remove(&key);
            let result = store.write_with(&NoFaults, |tx| -> Result<HeldChangeResult, RuntimeError> {
                if !matches!(probe_projection_target(&root, &path, ProjectionTargetKind::Plaintext),
                    ProjectionTargetState::Text { sha256 } if sha256 == head.blob_sha256) {
                    return Err(refusal("held-change-stale"));
                }
                let (delta, token, history_moment_id, held, result_authors) = match &action {
                    HeldChangeAction::Drop { token } => {
                        if token != &current_token || !owed.iter().any(|row| row.held_checkpoint_sha256.is_some())
                            || owed.iter().filter(|row| row.held_checkpoint_sha256.is_some()).any(|row| row.held_head_sha256.as_deref() != Some(head.blob_sha256.as_str())) {
                            return Err(refusal("held-change-stale"));
                        }
                        let checkpoint = doc.encode_full_state();
                        let text = doc.project(ContentKind::Richdoc)?.content;
                        let moment = format!("moment-held-drop-{current_token}");
                        dohc_engine_domain::store::record_keyed_capture_recovery_in_tx(tx, &key.workspace_id, &head,
                            &text, &moment, Some(&authors.to_string()), now_ms)?;
                        dohc_engine_domain::clear_capture_recovery_in(tx, &key.workspace_id, &moment)?;
                        tx.execute("UPDATE moments SET metadata_summary='Dropped held change' WHERE workspace_id=?1 AND moment_id=?2",
                            params![key.workspace_id,moment]).map_err(StorageError::persist_public)?;
                        let delta = doc.reset_held_content_to_file(ContentKind::Richdoc, &head.text)?;
                        let after_sha = document_fingerprint(&doc);
                        let first = owed.first().ok_or_else(|| refusal("held-change-missing"))?;
                        let saved = serde_json::json!({"heldDrop": {
                            "token": current_token, "waitingCheckpoint": STANDARD.encode(&checkpoint),
                            "droppedCheckpointSha256": after_sha, "headSha256": head.blob_sha256,
                            "restoreGeneration": restore, "authors": authors, "historyMomentId": moment,
                        }});
                        for row in &owed { obligations::complete_in(tx, row, now_ms)?; }
                        tx.execute("UPDATE markdown_write_obligations SET retry_inputs_json=?2 WHERE obligation_order=?1",
                            params![first.order, saved.to_string()]).map_err(StorageError::persist_public)?;
                        (delta, current_token.clone(), Some(moment), false, authors.clone())
                    }
                    HeldChangeAction::Undo { token } => {
                        let saved: Option<String> = tx.query_row("SELECT retry_inputs_json FROM markdown_write_obligations \
                            WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND completed=1 \
                            AND json_extract(retry_inputs_json,'$.heldDrop.token')=?5 ORDER BY obligation_order DESC LIMIT 1",
                            params![key.workspace_id,key.version_id,key.object_id,marker.lineage_claim_id,token], |row| row.get(0))
                            .optional().map_err(StorageError::corrupt_public)?;
                        let saved: serde_json::Value = serde_json::from_str(&saved.ok_or_else(|| refusal("held-change-undo-stale"))?)
                            .map_err(StorageError::corrupt_public)?;
                        let drop = &saved["heldDrop"];
                        if drop["headSha256"].as_str() != Some(head.blob_sha256.as_str())
                            || drop["droppedCheckpointSha256"].as_str() != Some(&checkpoint_sha)
                            || drop["restoreGeneration"] != serde_json::json!(restore) {
                            return Err(refusal("held-change-undo-stale"));
                        }
                        let bytes = STANDARD.decode(drop["waitingCheckpoint"].as_str().ok_or_else(|| refusal("held-change-undo-stale"))?)
                            .map_err(StorageError::corrupt_public)?;
                        let waiting = Ydoc::wire(); waiting.apply(&bytes)?;
                        let delta = doc.restore_held_content(ContentKind::Richdoc, &waiting)?;
                        let moment = drop["historyMomentId"].as_str().map(str::to_owned);
                        (delta, token.clone(), moment, true, drop["authors"].clone())
                    }
                    HeldChangeAction::Review => unreachable!(),
                };
                let mut appended = dohc_engine_collab::record_update_in_tx(tx, &key, &delta, None, None, now_ms)?;
                super::ydoc::journal_recovery_append_in_tx(tx, &key, &path, ContentKind::Richdoc, &delta,
                    None, None, &preparations, &mut appended, now_ms)?;
                if held {
                    tx.execute("UPDATE ydoc_docs SET pending_authors_json=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                        params![key.workspace_id,key.version_id,key.object_id,result_authors.to_string()]).map_err(StorageError::persist_public)?;
                    obligations::record_in(tx, &obligations::Obligation {
                        order: 0, key: key.clone(), lineage_claim_id: marker.lineage_claim_id.clone().unwrap_or_default(),
                        operation_id: format!("undo-held-drop:{token}"), kind: obligations::Kind::Session, path: path.clone(),
                        retry_inputs: serde_json::json!({"expectedHeadSha256":head.blob_sha256,"restoreGeneration":restore,"useReader":true}),
                        held_checkpoint_sha256: Some(hex_sha256(&doc.encode_full_state())), held_head_sha256: Some(head.blob_sha256.clone()),
                        source_sha256: None, settled_head_sha256: None,
                    }, now_ms)?;
                    dohc_engine_domain::synchronize_collection_frontmatter_index_in_tx(tx,
                        &key.workspace_id, &key.version_id, &key.object_id, &doc.frontmatter_json())?;
                } else {
                    dohc_engine_collab::author_coverage::advance_in(tx, &key, false)?;
                    tx.execute("UPDATE ydoc_docs SET last_settled_sha=?4 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                        params![key.workspace_id,key.version_id,key.object_id,head.blob_sha256]).map_err(StorageError::persist_public)?;
                    super::collections::synchronize_collection_index_from_head_in_tx(tx, &key, &path)?;
                }
                Ok(HeldChangeResult {path: path.clone(), token, authors: result_authors, held, history_moment_id})
            })?;
            match result { TxnOutcome::Committed(result) => Ok(result), TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed) }
        }).await
    }
}
