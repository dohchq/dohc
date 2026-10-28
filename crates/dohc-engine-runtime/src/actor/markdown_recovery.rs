use super::*;
use dohc_engine_collab::{CollabError, LeaseRegistry};
use dohc_engine_collab::markdown_write_obligations::{self as obligations, Kind, Obligation};
use dohc_engine_domain::{DomainError, VersionedTextStore};
use dohc_engine_storage::{NoFaults, TxnOutcome, hex_sha256};
use rusqlite::{OptionalExtension, params};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct MarkdownRecoverySignal {
    pub(super) wake: Arc<tokio::sync::Notify>,
    epoch: AtomicU64,
}
impl MarkdownRecoverySignal {
    pub(super) fn request(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.wake.notify_one();
    }
}

#[derive(Clone)]
pub struct MarkdownRecoveryCandidate {
    pub obligation: Obligation,
    pub fingerprint: String,
}

impl ActorHandle {
    pub fn markdown_recovery_wake(&self) -> Arc<tokio::sync::Notify> {
        self.markdown_recovery.wake.clone()
    }

    pub fn request_markdown_recovery(&self) { self.markdown_recovery.request(); }

    pub fn markdown_recovery_epoch(&self) -> u64 { self.markdown_recovery.epoch.load(Ordering::Acquire) }

    pub async fn complete_markdown_obligation(&self, owed: Obligation, now_ms: i64) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            match store.write_with(&NoFaults, |tx| obligations::complete_in(tx, &owed, now_ms))? {
                TxnOutcome::Committed(()) => Ok(()),
                TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
            }
        }).await
    }

    pub async fn markdown_recovery_candidates(&self, workspace: String)
        -> Result<Vec<MarkdownRecoveryCandidate>, RuntimeError> {
        self.run(move |store, cache| {
            let pending = store.read_with(|conn| obligations::pending_in(conn, &workspace))?;
            let mut candidates = Vec::new();
            for obligation in pending {
                let key = &obligation.key;
                let marker = dohc_engine_collab::read_marker(store, key)?;
                let head = store.read_with(|conn| conn.query_row(
                    "SELECT object_id,blob_sha256,binary_sha256 FROM snapshots \
                     WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
                    params![workspace, key.version_id, obligation.path],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?)))
                    .optional().map_err(dohc_engine_storage::StorageError::corrupt_public))?;
                let restore = store.read_with(|conn| dohc_engine_collab::live_update_application::restore_generation(conn, key))?;
                let resolver = cache.reader_resolver.as_ref().map(|resolver| Arc::as_ptr(resolver) as usize);
                let materialized = if obligation.kind == Kind::WitnessRefresh {
                    obligation.settled_head_sha256.as_deref().map(|sha|
                        store.read_with(|conn| super::ydoc::refresh_head_materialized_in(conn, key, &obligation.path, sha)))
                        .transpose()?
                } else { None };
                let fingerprint = hex_sha256(serde_json::json!({
                    "head": head,
                    "marker": marker.map(|marker| (marker.lineage_claim_id, marker.path, marker.head_update_seq)),
                    "restore": restore, "resolver": resolver, "inputs": obligation.retry_inputs,
                    "refreshHead": obligation.settled_head_sha256,
                    "materialized": materialized,
                }).to_string().as_bytes());
                candidates.push(MarkdownRecoveryCandidate { obligation, fingerprint });
            }
            Ok(candidates)
        }).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn recover_markdown_write(&self, owed: Obligation, root: PathBuf,
        root_guard: Arc<dyn WorkspaceRootGuard>, leases: LeaseRegistry, recorder: Arc<dyn SelfWriteRecorder>, now_ms: i64,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run_with_reader_retry(move |store, cache| {
            if token.is_cancelled() { return Err(RuntimeError::Cancelled); }
            let key = &owed.key;
            let marker = dohc_engine_collab::read_marker(store, key)?;
            if marker.as_ref().and_then(|marker| marker.lineage_claim_id.as_deref()).unwrap_or("") != owed.lineage_claim_id {
                match store.write_with(&NoFaults, |tx| obligations::complete_in(tx, &owed, now_ms))? {
                    TxnOutcome::Committed(()) => return Ok(true),
                    TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
                }
            }
            let marker = marker.ok_or(CollabError::NoMarker)?;
            if marker.path.as_deref() != Some(owed.path.as_str()) {
                return Err(DomainError::ConflictStaleTarget.into());
            }
            if owed.kind == Kind::WitnessRefresh {
                super::ydoc::refresh_markdown_witnesses_on_store(store, cache, key, now_ms)?;
                return Ok(!store.read_with(|conn| obligations::pending_in(conn, &key.workspace_id))?
                    .iter().any(|row| row.order == owed.order));
            }
            if owed.kind == Kind::AuditedSettle {
                let retry: obligations::AuditedRetry = serde_json::from_value(owed.retry_inputs.clone())
                    .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
                if store.read_with(|conn| retry.covered_in(conn))? {
                    match store.write_with(&NoFaults, |tx| obligations::complete_in(tx, &owed, now_ms))? {
                        TxnOutcome::Committed(()) => return Ok(true),
                        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
                    }
                }
                return Ok(false);
            }
            if matches!(owed.kind, Kind::CollectionAdoption | Kind::RelationCleanup) { return Ok(false); }
            let _lease = match leases.acquire_internal(key) {
                Ok(lease) => lease,
                Err(CollabError::LeaseHeld) => return Ok(false),
                Err(error) => return Err(error.into()),
            };
            if owed.kind == Kind::SyncProjection {
                let resolver = cache.reader_resolver.clone();
                match store.write_with(&NoFaults, |tx| dohc_engine_sync::retry_markdown_projection_in_tx(
                    tx, &owed, resolver.as_deref(), None, now_ms))? {
                    TxnOutcome::Committed(_) => {}
                    TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
                }
            } else {
                let current = VersionedTextStore::new(store).read_text(&key.workspace_id, &key.version_id, &owed.path)?;
                let head = current.as_ref().map(|head| head.blob_sha256.clone());
                if current.as_ref().is_some_and(|head| head.object_id != key.object_id)
                    || (head != owed.held_head_sha256
                        && head != dohc_engine_collab::read_last_settled_sha(store, key)?) {
                    return Err(DomainError::ConflictStaleTarget.into());
                }
                let restore = owed.retry_inputs.get("restoreGeneration").and_then(serde_json::Value::as_i64);
                let use_reader = owed.retry_inputs.get("useReader").and_then(serde_json::Value::as_bool).unwrap_or(false);
                super::ydoc::ydoc_settle_on_store(store, cache, &root, key, &owed.path,
                    marker.content_kind, false, marker.lineage_claim_id.as_deref(), head, None,
                    &owed.operation_id, recorder.as_ref(), now_ms, &NoFaults, &token, Some(root_guard.as_ref()), None,
                    restore, if owed.kind == Kind::CollectionAdoption { super::ydoc::SettlementKind::CollectionAdoption }
                        else { super::ydoc::SettlementKind::Document }, use_reader, None)?
                    .into_settlement_for_internal_caller()?;
                match store.write_with(&NoFaults, |tx| obligations::complete_in(tx, &owed, now_ms))? {
                    TxnOutcome::Committed(()) => {}
                    TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
                }
            }
            Ok(true)
        }).await
    }
}
