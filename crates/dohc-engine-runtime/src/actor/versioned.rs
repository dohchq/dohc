use super::ActorHandle;
use super::capture::{WorkspaceRootGuard, validate_workspace_root};
use super::journal::journal_moment_outbound_in_tx;
use super::materialization::{
    PostCommitMaterializeOutcome, SelfWriteRecorder, materialize_expected_job,
    materialize_pending_job, worse_materialize_outcome,
};
use super::search::search_domain;
use super::versions::{
    ensure_mutation_version_on_store, reconcile_active_plaintext_projection_on_store,
};
use crate::error::RuntimeError;
use crate::search::{delete_file_search_index, upsert_file_search_index};
use dohc_engine_collab::{DocKey, LeaseRegistry, WriterDocCache};
use dohc_engine_domain::{
    BinaryHead, BinaryWriteResult, CompareTextFileVersions, DeleteResult, DeleteTextFile,
    DomainError, InbandBinary, InbandText, MergeTextFileFromVersion, MergeTextFileResult,
    RenameResult, RenameTextFile, ResolveTextConflict, ResolveTextConflictResult,
    RollbackTextFileMutation, TextConflict, TextSnapshot, VersionedTextComparison,
    VersionedTextStore, WriteBinary, WriteResult, WriteText, binary_delete_job_id,
    binary_rename_delete_job_id, binary_rename_write_job_id, binary_rollback_job_identity,
    enqueue_binary_delete, enqueue_binary_rename, insert_text_conflict_if_absent,
    rollback_compensating_moment_id, write_text_in_tx,
};
use dohc_engine_storage::{
    EngineStore, FaultAction, FaultInjector, FaultPoint, JobStatus, Preimage, StorageError,
    TxnOutcome, hex_sha256,
};
use dohc_engine_sync::{
    ApplyDisposition, ApplyOutcome, ConflictApplyResult, ReplicationEnvelope,
    apply_conflict_envelope, read_replayed_refusal, retain_refusal_for_direct_retry,
};
use rusqlite::{OptionalExtension, params};
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Default)]
pub struct WriteConditions {
    pub create_only: bool,
    pub expected_sha256: Option<String>,
}

impl WriteConditions {
    fn fingerprint(&self) -> String {
        serde_json::json!([self.create_only, self.expected_sha256]).to_string()
    }

    fn check(
        &self,
        root: &std::path::Path,
        path: &str,
        before_present: bool,
    ) -> Result<(), RuntimeError> {
        use dohc_engine_files::materialize::{
            ProjectionTargetKind, ProjectionTargetState, probe_projection_target,
        };
        if !self.create_only && self.expected_sha256.is_none() {
            return Ok(());
        }
        if self.create_only
            && (before_present
                || !matches!(
                    probe_projection_target(root, path, ProjectionTargetKind::Plaintext),
                    ProjectionTargetState::Absent
                ))
        {
            return Err(DomainError::TargetPathExists.into());
        }
        if let Some(expected) = &self.expected_sha256 {
            let current_sha256 =
                dohc_engine_files::materialize::write_precondition_sha256(root, path)?;
            if current_sha256.as_ref() != Some(expected) {
                return Err(DomainError::WritePreconditionFailed { current_sha256 }.into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextWriteExecutionResult {
    pub write: WriteResult,
    pub materialized: bool,
    pub materialize_outcome: PostCommitMaterializeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryWriteExecutionResult {
    pub write: BinaryWriteResult,
    pub materialized: bool,
    pub materialize_outcome: PostCommitMaterializeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeExecutionResult {
    pub merge: MergeTextFileResult,
    pub materialize_enqueued: bool,
    pub materialized: bool,
    pub materialize_outcome: PostCommitMaterializeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackExecutionResult {
    pub deduped: bool,
    pub materialize_enqueued: bool,
    pub materialized: bool,
    pub materialize_outcome: PostCommitMaterializeOutcome,
    /// Automation claims the restored text's field changes inserted, for the
    /// caller to announce.
    pub automation_claims: Vec<dohc_engine_domain::AutomationClaim>,
}

impl ActorHandle {
    pub async fn ensure_no_adopted_owner_under_path(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _| {
            let path = dohc_engine_domain::validate_addressable_plaintext_path(&path)?;
            store
                .read_with(|conn| {
                    dohc_engine_sync::ensure_no_adopted_owner_under_path(
                        conn,
                        &workspace_id,
                        &version_id,
                        &path,
                    )
                })
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// Execute a versioned-text write on the actor's single writer thread.
    pub async fn versioned_text_write(
        &self,
        input: WriteText,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        let root_dir: Option<PathBuf> = None;
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                versioned_text_write_on_store(
                    store,
                    &input,
                    root_dir.as_deref(),
                    None,
                    faults.as_ref(),
                    &token,
                )
            })
        })
        .await
    }

    /// Execute an RPC text write with its FTS row in the same transaction.
    pub async fn versioned_text_write_indexed(
        &self,
        input: WriteText,
        root_dir: PathBuf,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        self.versioned_text_write_indexed_with_history(input, root_dir, None, faults, token)
            .await
    }

    pub async fn versioned_text_write_indexed_with_history(
        &self,
        input: WriteText,
        root_dir: PathBuf,
        restore_before_moment_id: Option<String>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        let root_dir: Option<PathBuf> = Some(root_dir);
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                versioned_text_write_on_store(
                    store,
                    &input,
                    root_dir.as_deref(),
                    restore_before_moment_id.as_deref(),
                    faults.as_ref(),
                    &token,
                )
            })
        })
        .await
    }

    /// Execute, index, and materialize a caller-originated binary write on the
    /// actor's sole writer thread.
    pub async fn versioned_binary_write(
        &self,
        input: WriteBinary,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<BinaryWriteExecutionResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                versioned_binary_write_on_store(
                    store,
                    &input,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                )
            })
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn versioned_text_publish(
        &self,
        input: WriteText,
        root: PathBuf,
        conditions: WriteConditions,
        restore_before_moment_id: Option<String>,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<TextWriteExecutionResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                let write = versioned_text_write_with_publication_on_store(
                    store,
                    &input,
                    Some(&root),
                    restore_before_moment_id.as_deref(),
                    Some(&conditions),
                    faults.as_ref(),
                    &token,
                )?;
                let (materialized, materialize_outcome) = publish_write_job(
                    store,
                    &root,
                    &input.workspace_id,
                    &input.version_id,
                    input.request_id.as_deref(),
                    &format!("authored-mat_{}", write.moment.moment_id),
                    self_writes.as_ref(),
                    input.now_ms,
                    faults.as_ref(),
                )?;
                Ok(TextWriteExecutionResult {
                    write,
                    materialized,
                    materialize_outcome,
                })
            })
        })
        .await
    }

    pub async fn versioned_binary_write_with_conditions(
        &self,
        input: WriteBinary,
        root: PathBuf,
        conditions: WriteConditions,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<BinaryWriteExecutionResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                versioned_binary_write_conditioned_on_store(
                    store,
                    &input,
                    &root,
                    Some(&conditions),
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                )
            })
        })
        .await
    }

    pub async fn versioned_text_rename(
        &self,
        input: RenameTextFile,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<RenameResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                versioned_text_rename_on_store(
                    store,
                    &input,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                )
            })
        })
        .await
    }

    pub async fn versioned_text_delete(
        &self,
        input: DeleteTextFile,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<DeleteResult, RuntimeError> {
        self.versioned_text_delete_expected_object(
            input,
            None,
            false,
            root_dir,
            self_writes,
            faults,
            token,
        )
        .await
    }

    /// `confirm_absent` marks a delete whose reason is that the file is gone
    /// from disk, observed off the actor. The actor confirms it on its own
    /// thread and refuses with a retryable error while anything is at the path
    /// or an unfinished replace moved it aside.
    #[allow(clippy::too_many_arguments)]
    pub async fn versioned_text_delete_expected_object(
        &self,
        input: DeleteTextFile,
        expected_object_id: Option<String>,
        confirm_absent: bool,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<DeleteResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                versioned_text_delete_on_store(
                    store,
                    &input,
                    expected_object_id.as_deref(),
                    confirm_absent,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                )
            })
        })
        .await
    }

    pub async fn versioned_text_rollback(
        &self,
        input: RollbackTextFileMutation,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<RollbackExecutionResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                versioned_text_rollback_on_store(
                    store,
                    &input,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                )
            })
        })
        .await
    }

    pub async fn versioned_text_compare(
        &self,
        input: CompareTextFileVersions,
    ) -> Result<VersionedTextComparison, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .compare_text_file_versions(&input)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn versioned_text_merge(
        &self,
        input: MergeTextFileFromVersion,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<MergeExecutionResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                versioned_text_merge_on_store(
                    store,
                    &input,
                    &root_dir,
                    self_writes.as_ref(),
                    faults.as_ref(),
                    &token,
                )
            })
        })
        .await
    }

    pub async fn read_binary(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<BinaryHead>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .read_binary(&workspace_id, &version_id, &path)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn read_binary_blob(
        &self,
        workspace_id: String,
        sha256: String,
    ) -> Result<Option<dohc_engine_domain::BinaryBlobRead>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .read_binary_blob(&workspace_id, &sha256)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn read_binary_blob_for_egress(
        &self,
        workspace_id: String,
        sha256: String,
    ) -> Result<Option<dohc_engine_domain::BinaryBlobRead>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .read_binary_blob_for_egress(&workspace_id, &sha256)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn read_text_blob(
        &self,
        workspace_id: String,
        sha256: String,
    ) -> Result<Option<dohc_engine_domain::TextBlobRead>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .read_text_blob(&workspace_id, &sha256)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn read_text_blob_for_egress(
        &self,
        workspace_id: String,
        sha256: String,
    ) -> Result<Option<dohc_engine_domain::TextBlobRead>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .read_text_blob_for_egress(&workspace_id, &sha256)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// Text head with the body hydrated only under `cap` — one actor turn.
    pub async fn read_text_inband(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
    ) -> Result<Option<InbandText>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .read_text_inband(&workspace_id, &version_id, &path, cap)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// Binary head with the bytes hydrated only under `cap` — one actor turn.
    pub async fn read_binary_inband(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        cap: usize,
    ) -> Result<Option<InbandBinary>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .read_binary_inband(&workspace_id, &version_id, &path, cap)
                .map_err(RuntimeError::from)
        })
        .await
    }

    /// Read one versioned text snapshot on the actor-owned connection.
    pub async fn versioned_text_read(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
        token: CancellationToken,
    ) -> Result<Option<TextSnapshot>, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                VersionedTextStore::new(store)
                    .read_text(&workspace_id, &version_id, &path)
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn resolve_path_object(
        &self,
        workspace_id: String,
        version_id: String,
        path: String,
    ) -> Result<Option<String>, RuntimeError> {
        self.run(move |store, _| {
            VersionedTextStore::new(store)
                .object_id_for_path(&workspace_id, &version_id, &path)
                .map_err(RuntimeError::from)
        })
        .await
    }

    pub async fn conflict_list(
        &self,
        workspace_id: String,
        status: Option<String>,
        after_conflict_id: Option<String>,
        token: CancellationToken,
    ) -> Result<Vec<TextConflict>, RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                VersionedTextStore::new(store)
                    .list_text_conflicts_page(
                        &workspace_id,
                        status.as_deref(),
                        after_conflict_id.as_deref(),
                    )
                    .map_err(RuntimeError::from)
            }
        })
        .await
    }

    pub async fn conflict_open(
        &self,
        conflict: Box<TextConflict>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| conflict_open_on_store(store, &conflict, faults.as_ref(), &token))
            .await
    }

    pub async fn conflict_resolve(
        &self,
        input: ResolveTextConflict,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ResolveTextConflictResult, RuntimeError> {
        self.conflict_resolve_with_root(input, leases, None, faults, token)
            .await
    }

    /// Resolve and index a text conflict with the workspace root owned by the
    /// calling session.
    pub async fn conflict_resolve_indexed(
        &self,
        input: ResolveTextConflict,
        leases: LeaseRegistry,
        root_dir: PathBuf,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ResolveTextConflictResult, RuntimeError> {
        self.conflict_resolve_with_root(input, leases, Some(root_dir), faults, token)
            .await
    }

    async fn conflict_resolve_with_root(
        &self,
        input: ResolveTextConflict,
        leases: LeaseRegistry,
        root_dir: Option<PathBuf>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ResolveTextConflictResult, RuntimeError> {
        self.run(move |store, cache| {
            let outcome = conflict_resolve_on_store(
                store,
                &input,
                root_dir.as_deref(),
                &leases,
                faults.as_ref(),
                &token,
            );
            // Resolution can replace or archive a lineage; the tuple probe
            // already misses on every such outcome (the claim id changes or
            // the marker is deleted), but the reset hooks are unconditional.
            cache.clear();
            outcome
        })
        .await
    }

    pub async fn conflict_apply_replicated(
        &self,
        envelope: ReplicationEnvelope,
        faults: Arc<dyn FaultInjector>,
        leases: LeaseRegistry,
        token: CancellationToken,
    ) -> Result<ApplyOutcome<ConflictApplyResult>, RuntimeError> {
        self.run(move |store, cache| {
            let outcome = if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                match apply_conflict_envelope(store, &envelope, faults.as_ref(), &leases) {
                    Ok(
                        outcome @ ApplyOutcome {
                            primary: ApplyDisposition::Refused(_),
                            ..
                        },
                    ) => retain_refusal_for_direct_retry(store, &envelope, faults.as_ref())
                        .map(|()| outcome)
                        .map_err(RuntimeError::from),
                    Ok(
                        mut outcome @ ApplyOutcome {
                            primary: ApplyDisposition::Skipped,
                            ..
                        },
                    ) => read_replayed_refusal(store, &envelope)
                        .map(|refusal| {
                            outcome.primary = refusal
                                .map_or(ApplyDisposition::Skipped, ApplyDisposition::Refused);
                            outcome
                        })
                        .map_err(RuntimeError::from),
                    outcome => outcome.map_err(RuntimeError::from),
                }
            };
            // A replicated conflict envelope can replace or archive a
            // lineage (probe-covered; reset hooks stay unconditional).
            cache.clear();
            outcome
        })
        .await
    }
}

/// Local file mutations can rewrite or retire a Y.Doc lineage inside their
/// transaction. Clear before entry so a committed crash cannot preserve an
/// entry across a probe-invisible reset. A rollback only loses cache warmth.
pub(super) fn with_local_file_mutation_cache_reset<T>(
    doc_cache: &mut WriterDocCache,
    mutation: impl FnOnce() -> T,
) -> T {
    doc_cache.clear();
    mutation()
}

pub(super) fn versioned_text_write_on_store(
    store: &mut EngineStore,
    input: &WriteText,
    root_dir: Option<&std::path::Path>,
    restore_before_moment_id: Option<&str>,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<WriteResult, RuntimeError> {
    versioned_text_write_with_publication_on_store(
        store,
        input,
        root_dir,
        restore_before_moment_id,
        None,
        faults,
        token,
    )
}

#[allow(clippy::too_many_arguments)]
fn versioned_text_write_with_publication_on_store(
    store: &mut EngineStore,
    input: &WriteText,
    root_dir: Option<&std::path::Path>,
    restore_before_moment_id: Option<&str>,
    conditions: Option<&WriteConditions>,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<WriteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    dohc_engine_domain::validate_write_input(input).map_err(RuntimeError::from)?;
    // The write's author names who changed the record's fields: an agent, an
    // automation at its chain depth, or a person.
    let (actor, attribution) =
        dohc_engine_domain::moment_author_attribution(input.author_json.as_deref());
    let outcome = store.write_with(faults, |tx| {
        let fingerprint = conditions.map(WriteConditions::fingerprint);
        let mut result = match (restore_before_moment_id, fingerprint.as_deref()) {
            (Some(source), conditions) => dohc_engine_domain::write_published_history_text_in_tx(
                tx, input, source, conditions,
            ),
            (None, Some(conditions)) => {
                dohc_engine_domain::write_published_text_in_tx(tx, input, conditions)
            }
            (None, None) => write_text_in_tx(tx, input),
        }
        .map_err(RuntimeError::from)?;
        if !result.deduped && conditions.is_some() {
            ensure_publication_version(tx, &input.workspace_id, &input.version_id)?;
        }
        if !result.deduped
            && let (Some(conditions), Some(root)) = (conditions, root_dir)
        {
            conditions.check(root, &result.snapshot.path, result.moment.before_present)?;
            let preimage = if result.moment.before_present {
                Preimage::Present(
                    result
                        .moment
                        .before_binary_sha256
                        .clone()
                        .or_else(|| result.moment.before_blob_sha256.clone())
                        .unwrap_or_default(),
                )
            } else {
                Preimage::Absent
            };
            dohc_engine_domain::enqueue_write(tx, &result, preimage, "authored")?;
        }
        if !result.deduped
            && let Some(facts) = dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                dohc_engine_sync::ResultingHead::Text {
                    path: &result.snapshot.path,
                    text: &result.snapshot.text,
                },
                actor.as_deref(),
                attribution.as_ref(),
                input.now_ms,
            )?
        {
            result.automation_claims = dohc_engine_domain::claim_automation_triggers_in_tx(
                tx,
                &input.workspace_id,
                &facts,
                input.now_ms,
            )?;
        }
        if !result.deduped
            && let Some(root_dir) = root_dir
        {
            upsert_file_search_index(
                tx,
                root_dir,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
            )
            .map_err(RuntimeError::from)?;
        }
        journal_moment_outbound_in_tx(
            tx,
            &input.workspace_id,
            &result.moment.moment_id,
            result.deduped,
        )
        .map_err(RuntimeError::from)?;
        Ok::<_, RuntimeError>(result)
    })?;
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn versioned_binary_write_on_store(
    store: &mut EngineStore,
    input: &WriteBinary,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<BinaryWriteExecutionResult, RuntimeError> {
    versioned_binary_write_conditioned_on_store(
        store,
        input,
        root_dir,
        None,
        self_writes,
        faults,
        token,
    )
}

fn versioned_binary_write_conditioned_on_store(
    store: &mut EngineStore,
    input: &WriteBinary,
    root_dir: &std::path::Path,
    conditions: Option<&WriteConditions>,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<BinaryWriteExecutionResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    ensure_mutation_version_on_store(
        store,
        &input.workspace_id,
        &input.version_id,
        input.now_ms,
        faults,
    )?;
    let outcome = store.write_with(faults, |tx| {
        let fingerprint = conditions.map(WriteConditions::fingerprint);
        let replayed: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id = ?1)",
                [&input.request_id],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)?;
        let result =
            dohc_engine_domain::write_published_binary_in_tx(tx, input, fingerprint.as_deref())
                .map_err(RuntimeError::from)?;
        if !replayed
            && conditions.is_some_and(|conditions| {
                conditions.create_only || conditions.expected_sha256.is_some()
            })
        {
            ensure_publication_version(tx, &input.workspace_id, &input.version_id)?;
        }
        if !replayed && let Some(conditions) = conditions {
            conditions.check(
                root_dir,
                &result.path,
                result.deduped || result.moment.before_present,
            )?;
        }
        if !result.deduped {
            dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object_id,
                dohc_engine_sync::ResultingHead::BinaryOrAbsent,
                None,
                None,
                input.now_ms,
            )?;
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object_id,
            )
            .map_err(RuntimeError::from)?;
        }
        journal_moment_outbound_in_tx(
            tx,
            &input.workspace_id,
            &result.moment.moment_id,
            result.deduped,
        )
        .map_err(RuntimeError::from)?;
        Ok::<_, RuntimeError>(result)
    })?;
    let result = match outcome {
        TxnOutcome::Committed(result) => result,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    let (materialized, materialize_outcome) = publish_write_job(
        store,
        root_dir,
        &input.workspace_id,
        &input.version_id,
        input.request_id.as_deref(),
        &result.moment.moment_id,
        self_writes,
        input.now_ms,
        faults,
    )?;
    Ok(BinaryWriteExecutionResult {
        write: result,
        materialized,
        materialize_outcome,
    })
}

fn ensure_publication_version(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    version_id: &str,
) -> Result<(), RuntimeError> {
    let active: Option<String> = conn
        .query_row(
            "SELECT version_id FROM active_versions WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::corrupt_public)?;
    if version_id != active.as_deref().unwrap_or("main") {
        return Err(DomainError::InvalidVersion.into());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn publish_write_job(
    store: &EngineStore,
    root: &std::path::Path,
    workspace_id: &str,
    version_id: &str,
    request_id: Option<&str>,
    job_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<(bool, PostCommitMaterializeOutcome), RuntimeError> {
    use PostCommitMaterializeOutcome as Outcome;
    let recorded: Option<String> = store.read_with(|conn| {
        conn.query_row(
            "SELECT publication_outcome FROM engine_requests WHERE request_id = ?1",
            [request_id],
            |row| row.get(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(StorageError::corrupt_public)
    })?;
    if let Some(recorded) = recorded {
        let outcome = match recorded.as_str() {
            "applied" => Outcome::Applied,
            "skipped" => Outcome::Skipped,
            "conflict" => Outcome::Conflict,
            "superseded" => Outcome::Superseded,
            _ => {
                return Err(DomainError::StateCorrupt {
                    reason: "invalid recorded publication outcome",
                }
                .into());
            }
        };
        return Ok((outcome == Outcome::Applied, outcome));
    }
    let (result, settled) = match store.load_materialization_job(job_id)? {
        None => ((false, Outcome::Skipped), true),
        Some(job) => match job.status {
            JobStatus::Complete => ((true, Outcome::Applied), true),
            JobStatus::Conflict => ((false, Outcome::Conflict), true),
            JobStatus::Cancelled => ((false, Outcome::Superseded), true),
            JobStatus::Pending => {
                store
                    .read_with(|conn| ensure_publication_version(conn, workspace_id, version_id))?;
                let result = materialize_pending_job(
                    store,
                    root,
                    workspace_id,
                    &job,
                    self_writes,
                    now_ms,
                    faults,
                );
                let settled = !matches!(result.1, Outcome::Error | Outcome::Skipped);
                (result, settled)
            }
        },
    };
    if settled {
        let name = match result.1 {
            Outcome::Applied => "applied",
            Outcome::Skipped => "skipped",
            Outcome::Conflict => "conflict",
            Outcome::Superseded => "superseded",
            Outcome::Error => unreachable!("transient errors are not settled"),
        };
        store.read_with(|conn| {
            conn.execute(
                "UPDATE engine_requests SET publication_outcome = ?2 WHERE request_id = ?1",
                params![request_id, name],
            )
            .map_err(StorageError::persist_public)
        })?;
    }
    Ok(result)
}

fn versioned_text_rename_on_store(
    store: &mut EngineStore,
    input: &RenameTextFile,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<RenameResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let result = VersionedTextStore::new(store)
        .rename_text_file_with(input, faults, |tx, result| {
            if !result.deduped {
                let resulting = if result.moment.after_content_kind == "text" {
                    dohc_engine_sync::ResultingHead::Text {
                        path: &result.after.path,
                        text: &result.after.text,
                    }
                } else {
                    dohc_engine_sync::ResultingHead::BinaryOrAbsent
                };
                dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                    tx,
                    &input.workspace_id,
                    &input.version_id,
                    &result.object.object_id,
                    resulting,
                    None,
                    None,
                    input.now_ms,
                )
                .map_err(map_fold_error)?;
            }
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object.object_id,
            )
            .map_err(search_domain)?;
            if result.moment.after_content_kind == "text" {
                upsert_file_search_index(
                    tx,
                    root_dir,
                    &input.workspace_id,
                    &input.version_id,
                    &result.object.object_id,
                    &result.after.path,
                    &result.after.text,
                )
                .map_err(search_domain)?;
            }
            enqueue_binary_rename(tx, result)?;
            journal_moment_outbound_in_tx(
                tx,
                &input.workspace_id,
                &result.moment.moment_id,
                result.deduped,
            )?;
            Ok(())
        })
        .map_err(RuntimeError::from)?;
    if result.moment.after_content_kind == "binary" {
        let write_ready = materialize_expected_job(
            store,
            root_dir,
            &input.workspace_id,
            &binary_rename_write_job_id(&result.moment.moment_id),
            self_writes,
            result.moment.recorded_at_ms,
            faults,
        );
        if write_ready {
            materialize_expected_job(
                store,
                root_dir,
                &input.workspace_id,
                &binary_rename_delete_job_id(&result.moment.moment_id),
                self_writes,
                result.moment.recorded_at_ms,
                faults,
            );
        }
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn versioned_text_delete_on_store(
    store: &mut EngineStore,
    input: &DeleteTextFile,
    expected_object_id: Option<&str>,
    confirm_absent: bool,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<DeleteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if confirm_absent {
        super::capture::confirm_absent_on_disk(
            store,
            Some(root_dir),
            &input.workspace_id,
            &input.path,
            input.now_ms,
        )?;
    }
    let outcome = store.write_with(faults, |tx| {
        let result = dohc_engine_domain::delete_text_in_tx_checked(tx, input, expected_object_id)
            .map_err(RuntimeError::from)?;
        let asset_jobs = if !result.deduped {
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object.object_id,
            )
            .map_err(RuntimeError::from)?;
            enqueue_binary_delete(tx, &result).map_err(RuntimeError::from)?;
            journal_moment_outbound_in_tx(tx, &input.workspace_id, &result.moment.moment_id, false)
                .map_err(RuntimeError::from)?;
            let asset_jobs = delete_owned_scene_assets_in_tx(tx, &result)?;
            dohc_engine_sync::retire_ydoc_lineage_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object.object_id,
            )
            .map_err(RuntimeError::from)?;
            asset_jobs
        } else {
            journal_moment_outbound_in_tx(tx, &input.workspace_id, &result.moment.moment_id, true)
                .map_err(RuntimeError::from)?;
            scene_asset_delete_jobs_in_tx(tx, &result)?
        };
        Ok::<_, RuntimeError>((result, asset_jobs))
    })?;
    match outcome {
        TxnOutcome::Committed((result, asset_jobs)) => {
            if result.moment.before_content_kind == "binary" {
                materialize_expected_job(
                    store,
                    root_dir,
                    &input.workspace_id,
                    &binary_delete_job_id(&result.moment.moment_id),
                    self_writes,
                    result.moment.recorded_at_ms,
                    faults,
                );
            }
            materialize_scene_asset_deletes(
                store,
                root_dir,
                &input.workspace_id,
                &asset_jobs,
                self_writes,
                faults,
                None,
            )?;
            Ok(result)
        }
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

pub(super) fn delete_owned_scene_assets_in_tx(
    tx: &rusqlite::Transaction<'_>,
    drawing_delete: &DeleteResult,
) -> Result<Vec<(String, i64)>, RuntimeError> {
    if drawing_delete.moment.before_content_kind != "text" {
        return Ok(Vec::new());
    }
    let is_scene = drawing_delete
        .before
        .path
        .to_ascii_lowercase()
        .ends_with(".excalidraw")
        || tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM ydoc_docs WHERE workspace_id = ?1 \
                 AND version_id = ?2 AND object_id = ?3 AND content_kind = 'scene')",
                params![
                    drawing_delete.before.workspace_id,
                    drawing_delete.before.version_id,
                    drawing_delete.object.object_id
                ],
                |row| row.get(0),
            )
            .map_err(|error| {
                RuntimeError::Domain(DomainError::Storage(StorageError::corrupt_public(error)))
            })?;
    if !is_scene {
        return Ok(Vec::new());
    }
    let key = DocKey::new(
        &drawing_delete.before.workspace_id,
        &drawing_delete.before.version_id,
        &drawing_delete.object.object_id,
    )?;
    let candidates = dohc_engine_collab::freeze_scene_asset_delete_authority_in_tx(
        tx,
        &key,
        &drawing_delete.moment.moment_id,
    )?;
    let mut jobs = Vec::new();
    for candidate in candidates {
        let asset_delete = dohc_engine_domain::delete_text_in_tx(
            tx,
            &DeleteTextFile {
                workspace_id: drawing_delete.before.workspace_id.clone(),
                version_id: drawing_delete.before.version_id.clone(),
                path: candidate.path,
                moment_id: candidate.asset_delete_moment_id,
                request_id: None,
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: Some("Deleted drawing asset".to_owned()),
                metadata_correlation_id: Some(drawing_delete.moment.moment_id.clone()),
                author_json: drawing_delete.moment.author_json.clone(),
                now_ms: drawing_delete.moment.recorded_at_ms,
            },
        )
        .map_err(RuntimeError::from)?;
        delete_file_search_index(
            tx,
            &asset_delete.before.workspace_id,
            &asset_delete.before.version_id,
            &asset_delete.object.object_id,
        )
        .map_err(search_domain)?;
        if enqueue_binary_delete(tx, &asset_delete).map_err(RuntimeError::from)? {
            jobs.push((
                binary_delete_job_id(&asset_delete.moment.moment_id),
                asset_delete.moment.recorded_at_ms,
            ));
        }
        journal_moment_outbound_in_tx(
            tx,
            &asset_delete.before.workspace_id,
            &asset_delete.moment.moment_id,
            false,
        )
        .map_err(RuntimeError::from)?;
    }
    Ok(jobs)
}

fn scene_asset_restore_identity(
    workspace_id: &str,
    version_id: &str,
    drawing_rollback_moment_id: &str,
    asset_delete_moment_id: &str,
) -> String {
    format!("{workspace_id}\0{version_id}\0{drawing_rollback_moment_id}\0{asset_delete_moment_id}")
}

fn scene_asset_restore_moment_id(
    workspace_id: &str,
    version_id: &str,
    drawing_rollback_moment_id: &str,
    asset_delete_moment_id: &str,
) -> String {
    format!(
        "moment-scene-asset-rollback-{}",
        hex_sha256(
            scene_asset_restore_identity(
                workspace_id,
                version_id,
                drawing_rollback_moment_id,
                asset_delete_moment_id,
            )
            .as_bytes()
        )
    )
}

fn scene_asset_delete_moments(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    version_id: &str,
    drawing_delete_moment_id: &str,
    drawing_object_id: &str,
) -> Result<Vec<(String, String, String, i64)>, DomainError> {
    let key = DocKey::new(workspace_id, version_id, drawing_object_id)
        .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
    let authorities =
        dohc_engine_collab::read_scene_asset_delete_authority(conn, &key, drawing_delete_moment_id)
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
    let mut moments = Vec::with_capacity(authorities.len());
    for authority in authorities {
        let recorded_at_ms = conn
            .query_row(
                "SELECT recorded_at_ms FROM moments WHERE workspace_id=?1 AND version_id=?2 \
                 AND moment_id=?3 AND operation='delete' AND before_content_kind='binary' \
                 AND metadata_origin IN ('ydoc','local-file') AND metadata_correlation_id=?4 \
                 AND path=?5 AND before_binary_sha256=?6",
                params![
                    workspace_id,
                    version_id,
                    authority.asset_delete_moment_id,
                    drawing_delete_moment_id,
                    authority.path,
                    authority.sha256
                ],
                |row| row.get(0),
            )
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
        moments.push((
            authority.asset_delete_moment_id,
            authority.path,
            authority.sha256,
            recorded_at_ms,
        ));
    }
    Ok(moments)
}

fn scene_asset_deletes_ready_for_rollback(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    version_id: &str,
    drawing_delete_moment_id: &str,
) -> Result<bool, DomainError> {
    let drawing_object_id = conn
        .query_row(
            "SELECT drawing_object_id FROM scene_asset_delete_authorities \
             WHERE workspace_id=?1 AND version_id=?2 AND drawing_delete_moment_id=?3",
            params![workspace_id, version_id, drawing_delete_moment_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
    let Some(drawing_object_id) = drawing_object_id else {
        return Ok(true);
    };
    let key = DocKey::new(workspace_id, version_id, &drawing_object_id)
        .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
    let authorities =
        dohc_engine_collab::read_scene_asset_delete_authority(conn, &key, drawing_delete_moment_id)
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
    for authority in authorities {
        let exact: bool = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM moments WHERE workspace_id=?1 AND version_id=?2 \
                 AND moment_id=?3 AND operation='delete' AND before_content_kind='binary' \
                 AND metadata_origin IN ('ydoc','local-file') AND metadata_correlation_id=?4 \
                 AND path=?5 AND before_binary_sha256=?6)",
                params![
                    workspace_id,
                    version_id,
                    authority.asset_delete_moment_id,
                    drawing_delete_moment_id,
                    authority.path,
                    authority.sha256
                ],
                |row| row.get(0),
            )
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
        if exact {
            continue;
        }
        let collides: bool = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM moments WHERE workspace_id=?1 AND moment_id=?2)",
                params![workspace_id, authority.asset_delete_moment_id],
                |row| row.get(0),
            )
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
        if collides {
            return Err(DomainError::StateCorrupt {
                reason: "scene asset delete moment id belongs to different history",
            });
        }
        return Ok(false);
    }
    Ok(true)
}

fn consume_scene_asset_delete_authority_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    drawing_delete_moment_id: &str,
    drawing_object_id: &str,
) -> Result<(), DomainError> {
    let deleted = tx
        .execute(
            "DELETE FROM scene_asset_delete_authorities WHERE workspace_id=?1 \
             AND version_id=?2 AND drawing_delete_moment_id=?3 AND drawing_object_id=?4",
            params![
                workspace_id,
                version_id,
                drawing_delete_moment_id,
                drawing_object_id
            ],
        )
        .map_err(|error| DomainError::Storage(StorageError::persist_public(error)))?;
    if deleted != 1 {
        return Err(DomainError::StateCorrupt {
            reason: "scene asset delete authority was not consumed exactly once",
        });
    }
    Ok(())
}

fn scene_asset_delete_jobs_in_tx(
    tx: &rusqlite::Transaction<'_>,
    drawing_delete: &DeleteResult,
) -> Result<Vec<(String, i64)>, RuntimeError> {
    let moments = scene_asset_delete_moments(
        tx,
        &drawing_delete.before.workspace_id,
        &drawing_delete.before.version_id,
        &drawing_delete.moment.moment_id,
        &drawing_delete.object.object_id,
    )?;
    let mut jobs = Vec::with_capacity(moments.len());
    for (moment_id, path, sha256, recorded_at_ms) in moments {
        let job_id = binary_delete_job_id(&moment_id);
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM materialization_jobs \
                 WHERE workspace_id = ?1 AND job_id = ?2 AND operation = 'delete' \
                   AND target_path = ?3 AND content_sha256 = ?4)",
                params![drawing_delete.before.workspace_id, job_id, path, sha256],
                |row| row.get(0),
            )
            .map_err(|error| {
                RuntimeError::Domain(DomainError::Storage(StorageError::corrupt_public(error)))
            })?;
        if exists {
            jobs.push((job_id, recorded_at_ms));
        }
    }
    jobs.sort();
    Ok(jobs)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn materialize_scene_asset_deletes(
    store: &EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    jobs: &[(String, i64)],
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    root_guard: Option<&dyn WorkspaceRootGuard>,
) -> Result<(), RuntimeError> {
    for (job_id, recorded_at_ms) in jobs {
        validate_workspace_root(root_dir, root_guard)?;
        materialize_expected_job(
            store,
            root_dir,
            workspace_id,
            job_id,
            self_writes,
            *recorded_at_ms,
            faults,
        );
    }
    Ok(())
}

fn versioned_text_rollback_on_store(
    store: &mut EngineStore,
    input: &RollbackTextFileMutation,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<RollbackExecutionResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let scene_asset_deletes_ready = store.read_with(|conn| {
        scene_asset_deletes_ready_for_rollback(
            conn,
            &input.workspace_id,
            &input.version_id,
            &input.mutation_moment_id,
        )
    })?;
    if !scene_asset_deletes_ready {
        return Err(RuntimeError::SceneAssetDeletePending);
    }
    let mut restored_asset_jobs = Vec::new();
    let mut automation_claims = Vec::new();
    let (actor, attribution) =
        dohc_engine_domain::moment_author_attribution(input.author_json.as_deref());
    let deduped = VersionedTextStore::new(store).rollback_text_file_mutation_with(
        input,
        faults,
        |tx, moment| {
            let key = DocKey {
                workspace_id: input.workspace_id.clone(),
                version_id: moment.version_id.clone(),
                object_id: moment.object_id.clone(),
            };
            let owns_attempt = tx
                .query_row(
                    "SELECT settle_prior_update_seq IS NOT NULL AND settle_seq=?4 FROM ydoc_docs \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![
                        key.workspace_id,
                        key.version_id,
                        key.object_id,
                        moment.moment_order
                    ],
                    |row| row.get::<_, bool>(0),
                )
                .optional()
                .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?
                .unwrap_or(false);
            let job_id = format!("ydoc-mat_{}", moment.moment_id);
            let matches_moment: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM materialization_jobs WHERE job_id=?1 \
                     AND workspace_id=?2 AND target_path=?3 AND target_generation=?4 \
                     AND content_sha256=?5 AND operation='write')",
                    params![
                        job_id,
                        key.workspace_id,
                        moment.path,
                        moment.moment_order,
                        moment.after_blob_sha256
                    ],
                    |row| row.get(0),
                )
                .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
            if owns_attempt && !matches_moment {
                return Err(DomainError::StateCorrupt {
                    reason: "rolled-back settlement has no matching materialization job",
                });
            }
            if matches_moment {
                tx.execute(
                    "UPDATE materialization_jobs SET status='cancelled',completed_at_ms=?2 \
                     WHERE job_id=?1 AND status='pending'",
                    params![job_id, moment.recorded_at_ms],
                )
                .map_err(|error| DomainError::Storage(StorageError::persist_public(error)))?;
            }
            if owns_attempt {
                // Recredit the reserved authors while the original moment still exists.
                dohc_engine_collab::author_coverage::reconcile_in(tx, &key, moment.recorded_at_ms)
                    .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
            }
            Ok(())
        },
        |tx, object_id, restored_text, compensating_moment_id, recorded_at_ms| {
            restored_asset_jobs = restore_deleted_scene_assets_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &input.mutation_moment_id,
                object_id,
                compensating_moment_id,
                input.author_json.as_deref(),
            )?;
            let resulting = restored_text.map_or(
                dohc_engine_sync::ResultingHead::BinaryOrAbsent,
                |(path, text)| dohc_engine_sync::ResultingHead::Text { path, text },
            );
            // Restoring older text is a change on this computer: its field
            // changes claim like any other write.
            if let Some(facts) = dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                object_id,
                resulting,
                actor.as_deref(),
                attribution.as_ref(),
                recorded_at_ms,
            )
            .map_err(map_fold_error)?
            {
                automation_claims = dohc_engine_domain::claim_automation_triggers_in_tx(
                    tx,
                    &input.workspace_id,
                    &facts,
                    recorded_at_ms,
                )?;
            }
            delete_file_search_index(tx, &input.workspace_id, &input.version_id, object_id)
                .map_err(search_domain)?;
            if let Some((path, text)) = restored_text {
                upsert_file_search_index(
                    tx,
                    root_dir,
                    &input.workspace_id,
                    &input.version_id,
                    object_id,
                    path,
                    text,
                )
                .map_err(search_domain)?;
            }
            journal_moment_outbound_in_tx(tx, &input.workspace_id, compensating_moment_id, false)?;
            Ok(())
        },
    )?;
    if deduped && restored_asset_jobs.is_empty() {
        restored_asset_jobs = match restored_scene_asset_jobs_on_store(
            store,
            &input.workspace_id,
            &input.version_id,
            &input.mutation_moment_id,
            &rollback_compensating_moment_id(
                &input.workspace_id,
                &input.version_id,
                &input.mutation_moment_id,
            ),
        ) {
            Ok(jobs) => jobs,
            Err(error) => {
                eprintln!(
                    "engine: rollback committed but loading its drawing asset restore jobs failed: \
                     {error}"
                );
                return Ok(RollbackExecutionResult {
                    automation_claims: automation_claims.clone(),
                    deduped,
                    materialize_enqueued: true,
                    materialized: false,
                    materialize_outcome: PostCommitMaterializeOutcome::Error,
                });
            }
        };
    }
    let job_id = binary_rollback_job_identity(
        &input.workspace_id,
        &input.version_id,
        &input.mutation_moment_id,
    );
    let rename_write_job_id = binary_rename_write_job_id(&job_id);
    let rename_delete_job_id = binary_rename_delete_job_id(&job_id);
    // The rollback tx is already committed: a failed job load must not turn
    // into an RPC refusal — the caller would believe a durable rollback
    // failed. Mirror the binary-write seam and self-describe the outcome.
    let (job, rename_write_job, rename_delete_job) = match (
        store.load_materialization_job(&job_id),
        store.load_materialization_job(&rename_write_job_id),
        store.load_materialization_job(&rename_delete_job_id),
    ) {
        (Ok(job), Ok(rename_write_job), Ok(rename_delete_job)) => {
            (job, rename_write_job, rename_delete_job)
        }
        _ => {
            eprintln!("engine: rollback committed but loading its restore job(s) failed");
            return Ok(RollbackExecutionResult {
                automation_claims: automation_claims.clone(),
                deduped,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
    };
    let has_jobs = job.is_some() || rename_write_job.is_some() || rename_delete_job.is_some();

    let active_version =
        if faults.poll(FaultPoint::RollbackBeforeActiveVersionLookup) == FaultAction::Crash {
            Err(RuntimeError::from(StorageError::corrupt_public(
                rusqlite::Error::InvalidQuery,
            )))
        } else {
            VersionedTextStore::new(store)
                .get_active_version(&input.workspace_id)
                .map_err(RuntimeError::from)
        };
    let active_version = match active_version {
        Ok(active_version) => active_version,
        Err(error) => {
            eprintln!(
                "engine: rollback committed but active-version lookup failed; \
                 restore remains pending for normal replay: {error}"
            );
            return Ok(RollbackExecutionResult {
                automation_claims: automation_claims.clone(),
                deduped,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
    };
    let target_is_active = active_version.version_id == input.version_id;
    if !target_is_active {
        let reconcile_now_ms = job
            .as_ref()
            .or(rename_write_job.as_ref())
            .or(rename_delete_job.as_ref())
            .map_or(0, |job| job.created_at_ms);
        let reconcile_generation = job
            .as_ref()
            .or(rename_write_job.as_ref())
            .or(rename_delete_job.as_ref())
            .map_or(0, |job| job.target_generation);
        let rollback_paths = [(input.path.as_str(), reconcile_generation)];
        if let Err(error) = reconcile_active_plaintext_projection_on_store(
            store,
            &input.workspace_id,
            &active_version.version_id,
            &input.version_id,
            &rollback_paths,
            root_dir,
            self_writes,
            reconcile_now_ms,
            faults,
            token,
        ) {
            eprintln!(
                "engine: rollback committed but reconciling the active disk projection failed: \
                 {error}"
            );
            return Ok(RollbackExecutionResult {
                automation_claims: automation_claims.clone(),
                deduped,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
        return Ok(RollbackExecutionResult {
            automation_claims: automation_claims.clone(),
            deduped,
            materialize_enqueued: has_jobs || !restored_asset_jobs.is_empty(),
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }
    let asset_materialize_outcome = materialize_restored_scene_assets(
        store,
        root_dir,
        &input.workspace_id,
        &restored_asset_jobs,
        self_writes,
        faults,
    );
    if asset_materialize_outcome != PostCommitMaterializeOutcome::Applied
        && !restored_asset_jobs.is_empty()
    {
        return Ok(RollbackExecutionResult {
            automation_claims: automation_claims.clone(),
            deduped,
            materialize_enqueued: true,
            materialized: false,
            materialize_outcome: asset_materialize_outcome,
        });
    }
    if !has_jobs {
        return Ok(RollbackExecutionResult {
            automation_claims: automation_claims.clone(),
            deduped,
            materialize_enqueued: !restored_asset_jobs.is_empty(),
            materialized: !restored_asset_jobs.is_empty(),
            materialize_outcome: if restored_asset_jobs.is_empty() {
                PostCommitMaterializeOutcome::Skipped
            } else {
                PostCommitMaterializeOutcome::Applied
            },
        });
    }

    if let Some(job) = job {
        if deduped && job.status != JobStatus::Pending {
            return Ok(RollbackExecutionResult {
                automation_claims: automation_claims.clone(),
                deduped: true,
                materialize_enqueued: false,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Skipped,
            });
        }
        let (materialized, materialize_outcome) = match job.status {
            JobStatus::Complete => (true, PostCommitMaterializeOutcome::Applied),
            JobStatus::Pending => materialize_pending_job(
                store,
                root_dir,
                &input.workspace_id,
                &job,
                self_writes,
                job.created_at_ms,
                faults,
            ),
            JobStatus::Conflict | JobStatus::Cancelled => {
                (false, PostCommitMaterializeOutcome::Conflict)
            }
        };
        return Ok(RollbackExecutionResult {
            automation_claims: automation_claims.clone(),
            deduped,
            materialize_enqueued: true,
            materialized,
            materialize_outcome,
        });
    }

    let (Some(write_job), Some(delete_job)) = (rename_write_job, rename_delete_job) else {
        eprintln!("engine: rollback committed with an incomplete rename restore job pair");
        return Ok(RollbackExecutionResult {
            automation_claims: automation_claims.clone(),
            deduped,
            materialize_enqueued: true,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Error,
        });
    };
    if deduped && write_job.status != JobStatus::Pending && delete_job.status != JobStatus::Pending
    {
        return Ok(RollbackExecutionResult {
            automation_claims: automation_claims.clone(),
            deduped: true,
            materialize_enqueued: false,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }
    let (write_materialized, write_outcome) = match write_job.status {
        JobStatus::Complete => (true, PostCommitMaterializeOutcome::Applied),
        JobStatus::Pending => materialize_pending_job(
            store,
            root_dir,
            &input.workspace_id,
            &write_job,
            self_writes,
            write_job.created_at_ms,
            faults,
        ),
        // Follow-up: same pairing rule as the startup replay's
        // "binary-rename-1-delete-mat_" case — a cancelled write means its
        // destination was explicitly deleted, already resolving it, so the
        // paired delete below (the rename's old path) must still run rather
        // than being stranded.
        JobStatus::Cancelled => (true, PostCommitMaterializeOutcome::Skipped),
        JobStatus::Conflict => (false, PostCommitMaterializeOutcome::Conflict),
    };
    if !write_materialized {
        if write_outcome == PostCommitMaterializeOutcome::Conflict
            && let Err(error) =
                store.mark_materialization_conflict(&delete_job.job_id, write_job.created_at_ms)
        {
            eprintln!(
                "engine: rollback rename write conflicted but terminalizing its paired delete \
                 failed: {error}"
            );
        }
        return Ok(RollbackExecutionResult {
            automation_claims: automation_claims.clone(),
            deduped,
            materialize_enqueued: true,
            materialized: false,
            materialize_outcome: write_outcome,
        });
    }
    let delete_job = match store.load_materialization_job(&delete_job.job_id) {
        Ok(Some(job)) => job,
        Ok(None) | Err(_) => {
            return Ok(RollbackExecutionResult {
                automation_claims: automation_claims.clone(),
                deduped,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
    };
    let (materialized, materialize_outcome) = match delete_job.status {
        JobStatus::Complete => (true, PostCommitMaterializeOutcome::Applied),
        JobStatus::Pending => materialize_pending_job(
            store,
            root_dir,
            &input.workspace_id,
            &delete_job,
            self_writes,
            delete_job.created_at_ms,
            faults,
        ),
        JobStatus::Conflict | JobStatus::Cancelled => {
            (false, PostCommitMaterializeOutcome::Conflict)
        }
    };
    Ok(RollbackExecutionResult {
        automation_claims: automation_claims.clone(),
        deduped,
        materialize_enqueued: true,
        materialized,
        materialize_outcome,
    })
}

fn restore_deleted_scene_assets_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    drawing_delete_moment_id: &str,
    drawing_object_id: &str,
    drawing_rollback_moment_id: &str,
    author_json: Option<&str>,
) -> Result<Vec<String>, DomainError> {
    let has_authority: bool = tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM scene_asset_delete_authorities \
             WHERE workspace_id=?1 AND version_id=?2 AND drawing_delete_moment_id=?3 \
               AND drawing_object_id=?4)",
            params![
                workspace_id,
                version_id,
                drawing_delete_moment_id,
                drawing_object_id
            ],
            |row| row.get(0),
        )
        .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
    if !has_authority {
        return Ok(Vec::new());
    }
    let deleted_assets = scene_asset_delete_moments(
        tx,
        workspace_id,
        version_id,
        drawing_delete_moment_id,
        drawing_object_id,
    )?;
    // Materialization jobs write into the active workspace directory. A
    // rollback in a version the user has switched away from must restore the
    // heads without enqueueing jobs, or the general pending replay would
    // write the inactive version's asset files into the active tree and a
    // later capture would adopt them into the wrong version.
    let version_is_active: bool = tx
        .query_row(
            "SELECT ?2 = COALESCE(                  (SELECT version_id FROM active_versions WHERE workspace_id = ?1),                  (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id = ?1))",
            params![workspace_id, version_id],
            |row| row.get(0),
        )
        .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
    let mut jobs = Vec::with_capacity(deleted_assets.len());
    for (delete_moment_id, path, sha256, recorded_at_ms) in deleted_assets {
        let occupied: bool = tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM path_aliases \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND path = ?3)",
                params![workspace_id, version_id, path],
                |row| row.get(0),
            )
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
        if occupied {
            return Err(DomainError::TargetPathExists);
        }
        let identity = scene_asset_restore_identity(
            workspace_id,
            version_id,
            drawing_rollback_moment_id,
            &delete_moment_id,
        );
        let restore_moment_id = scene_asset_restore_moment_id(
            workspace_id,
            version_id,
            drawing_rollback_moment_id,
            &delete_moment_id,
        );
        // The retained delete moment owns the old object id. The compensating
        // head needs a new stable id because object ids are globally unique.
        let restore_object_id = format!(
            "scene-asset-rollback-object-{}",
            hex_sha256(format!("{identity}\0{path}").as_bytes())
        );
        dohc_engine_domain::write_binary_file_in_tx(
            tx,
            &dohc_engine_domain::WriteBinaryFile {
                workspace_id: workspace_id.to_owned(),
                version_id: version_id.to_owned(),
                object_id: restore_object_id,
                path: path.clone(),
                binary_sha256: sha256.clone(),
                moment_id: restore_moment_id.clone(),
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: Some("Restored drawing asset".to_owned()),
                metadata_correlation_id: Some(drawing_rollback_moment_id.to_owned()),
                author_json: author_json.map(str::to_owned),
                materialize: version_is_active.then_some(Preimage::Absent),
                now_ms: recorded_at_ms,
            },
        )?;
        tx.execute(
            "DELETE FROM materialization_jobs WHERE job_id = ?1 AND operation = 'delete' \
             AND workspace_id = ?2 AND target_path = ?3 AND content_sha256 = ?4 \
             AND status = 'pending'",
            params![
                binary_delete_job_id(&delete_moment_id),
                workspace_id,
                path,
                sha256
            ],
        )
        .map_err(|error| DomainError::Storage(StorageError::persist_public(error)))?;
        journal_moment_outbound_in_tx(tx, workspace_id, &restore_moment_id, false)?;
        let materializes: bool = tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM materialization_jobs WHERE job_id = ?1)",
                [&restore_moment_id],
                |row| row.get(0),
            )
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
        if materializes {
            jobs.push(restore_moment_id);
        }
    }
    consume_scene_asset_delete_authority_in_tx(
        tx,
        workspace_id,
        version_id,
        drawing_delete_moment_id,
        drawing_object_id,
    )?;
    Ok(jobs)
}

fn materialize_restored_scene_assets(
    store: &EngineStore,
    root_dir: &std::path::Path,
    workspace_id: &str,
    job_ids: &[String],
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
) -> PostCommitMaterializeOutcome {
    let mut outcome = PostCommitMaterializeOutcome::Applied;
    for job_id in job_ids {
        let Some(job) = store.load_materialization_job(job_id).ok().flatten() else {
            return PostCommitMaterializeOutcome::Error;
        };
        let current = match job.status {
            JobStatus::Complete => PostCommitMaterializeOutcome::Applied,
            JobStatus::Pending => {
                materialize_pending_job(
                    store,
                    root_dir,
                    workspace_id,
                    &job,
                    self_writes,
                    job.created_at_ms,
                    faults,
                )
                .1
            }
            JobStatus::Conflict | JobStatus::Cancelled => PostCommitMaterializeOutcome::Conflict,
        };
        outcome = worse_materialize_outcome(outcome, current);
    }
    outcome
}

fn restored_scene_asset_jobs_on_store(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
    drawing_delete_moment_id: &str,
    rollback_moment_id: &str,
) -> Result<Vec<String>, DomainError> {
    store.read_with(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT moment_id,object_id,path,after_binary_sha256 FROM moments WHERE workspace_id=?1 \
                 AND version_id=?2 AND object_id LIKE 'scene-asset-rollback-object-%' \
                 AND operation='write' AND after_content_kind='binary' \
                 AND metadata_origin='ydoc' AND metadata_correlation_id=?3 ORDER BY path",
            )
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
        let rows = statement
            .query_map(
                params![workspace_id, version_id, rollback_moment_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
        let restores = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
        let mut jobs = Vec::with_capacity(restores.len());
        for (actual_restore_moment_id, actual_restore_object_id, path, sha256) in restores {
            let delete_moment_id = dohc_engine_collab::scene_asset_delete_moment_id(
                workspace_id,
                version_id,
                drawing_delete_moment_id,
                &path,
            );
            let restore_moment_id = scene_asset_restore_moment_id(
                workspace_id,
                version_id,
                rollback_moment_id,
                &delete_moment_id,
            );
            let identity = scene_asset_restore_identity(
                workspace_id,
                version_id,
                rollback_moment_id,
                &delete_moment_id,
            );
            let restore_object_id = format!(
                "scene-asset-rollback-object-{}",
                hex_sha256(format!("{identity}\0{path}").as_bytes())
            );
            if actual_restore_moment_id != restore_moment_id
                || actual_restore_object_id != restore_object_id
            {
                continue;
            }
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM moments m \
                     JOIN materialization_jobs j ON j.workspace_id = m.workspace_id \
                       AND j.job_id = m.moment_id \
                     WHERE m.workspace_id = ?1 AND m.version_id = ?2 \
                       AND m.moment_id = ?3 AND m.metadata_correlation_id = ?4 \
                       AND m.operation = 'write' AND m.after_content_kind = 'binary' \
                       AND m.metadata_origin = 'ydoc' AND m.path = ?5 \
                       AND m.after_binary_sha256 = ?6 AND j.operation = 'write' \
                       AND j.target_path = ?5 AND j.content_sha256 = ?6)",
                    params![
                        workspace_id,
                        version_id,
                        restore_moment_id,
                        rollback_moment_id,
                        path,
                        sha256
                    ],
                    |row| row.get(0),
                )
                .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
            if exists {
                jobs.push(restore_moment_id);
            }
        }
        jobs.sort();
        Ok(jobs)
    })
}

fn versioned_text_merge_on_store(
    store: &mut EngineStore,
    input: &MergeTextFileFromVersion,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<MergeExecutionResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let target_is_active = VersionedTextStore::new(store)
        .get_active_version(&input.workspace_id)
        .map_err(RuntimeError::from)?
        .version_id
        == input.target_version_id;
    let result = VersionedTextStore::new(store)
        .merge_text_file_from_version_with(input, faults, |tx, result| {
            match result {
                MergeTextFileResult::Write { write, .. } => {
                    if !write.deduped {
                        // A merge replays changes made on another version,
                        // which claimed when they were made: it indexes the
                        // record and claims nothing.
                        dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                            tx,
                            &input.workspace_id,
                            &input.target_version_id,
                            &write.object.object_id,
                            dohc_engine_sync::ResultingHead::Text {
                                path: &write.snapshot.path,
                                text: &write.snapshot.text,
                            },
                            None,
                            None,
                            input.now_ms,
                        )
                        .map_err(map_fold_error)?;
                    }
                    upsert_file_search_index(
                        tx,
                        root_dir,
                        &input.workspace_id,
                        &input.target_version_id,
                        &write.object.object_id,
                        &write.snapshot.path,
                        &write.snapshot.text,
                    )
                    .map_err(search_domain)?;
                }
                MergeTextFileResult::Delete { delete, .. } => {
                    delete_file_search_index(
                        tx,
                        &input.workspace_id,
                        &input.target_version_id,
                        &delete.object.object_id,
                    )
                    .map_err(search_domain)?;
                    if !delete.deduped {
                        dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                            tx,
                            &input.workspace_id,
                            &input.target_version_id,
                            &delete.object.object_id,
                            dohc_engine_sync::ResultingHead::BinaryOrAbsent,
                            None,
                            None,
                            input.now_ms,
                        )
                        .map_err(map_fold_error)?;
                    }
                }
                // A fast-forwarded binary head needs no index work: the file
                // search reader drops any candidate whose live head is binary
                // (`search::query::live_head_is_binary`), so the text this path
                // used to hold is already unreachable.
                MergeTextFileResult::BinaryWrite { write, .. } => {
                    if !write.deduped {
                        dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                            tx,
                            &input.workspace_id,
                            &input.target_version_id,
                            &write.object.object_id,
                            dohc_engine_sync::ResultingHead::BinaryOrAbsent,
                            None,
                            None,
                            input.now_ms,
                        )
                        .map_err(map_fold_error)?;
                    }
                }
                MergeTextFileResult::Unchanged { .. } | MergeTextFileResult::Conflict { .. } => {}
            }
            let Some((moment_id, deduped)) = merge_moment_outbound_identity(result) else {
                return Ok(());
            };
            journal_moment_outbound_in_tx(tx, &input.workspace_id, moment_id, deduped)?;
            Ok(())
        })
        .map_err(RuntimeError::from)?;
    let Some((moment_id, deduped)) = merge_moment_outbound_identity(&result) else {
        return Ok(MergeExecutionResult {
            merge: result,
            materialize_enqueued: false,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    };
    if !target_is_active {
        return Ok(MergeExecutionResult {
            merge: result,
            materialize_enqueued: false,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }

    // A binary write's job id IS its moment id (the moment/job generation-
    // sharing contract in `write_binary_file_in_tx`); the text seams prefix it.
    let job_id = match &result {
        MergeTextFileResult::BinaryWrite { .. } => moment_id.to_owned(),
        _ => format!("merge-mat_{moment_id}"),
    };
    let job = match store.load_materialization_job(&job_id) {
        Ok(Some(job)) => job,
        Ok(None) if deduped => {
            return Ok(MergeExecutionResult {
                merge: result,
                materialize_enqueued: false,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Skipped,
            });
        }
        Ok(None) => {
            return Ok(MergeExecutionResult {
                merge: result,
                materialize_enqueued: true,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
        Err(error) => {
            eprintln!(
                "engine: merge committed but loading its materialization job failed: {error}"
            );
            return Ok(MergeExecutionResult {
                merge: result,
                materialize_enqueued: !deduped,
                materialized: false,
                materialize_outcome: PostCommitMaterializeOutcome::Error,
            });
        }
    };
    if deduped && job.status != JobStatus::Pending {
        return Ok(MergeExecutionResult {
            merge: result,
            materialize_enqueued: false,
            materialized: false,
            materialize_outcome: PostCommitMaterializeOutcome::Skipped,
        });
    }
    let (materialized, materialize_outcome) = materialize_pending_job(
        store,
        root_dir,
        &input.workspace_id,
        &job,
        self_writes,
        input.now_ms,
        faults,
    );
    Ok(MergeExecutionResult {
        merge: result,
        materialize_enqueued: !deduped,
        materialized,
        materialize_outcome,
    })
}

fn merge_moment_outbound_identity(result: &MergeTextFileResult) -> Option<(&str, bool)> {
    match result {
        MergeTextFileResult::Write { write, .. } => {
            Some((write.moment.moment_id.as_str(), write.deduped))
        }
        MergeTextFileResult::BinaryWrite { write, .. } => {
            Some((write.moment.moment_id.as_str(), write.deduped))
        }
        MergeTextFileResult::Delete { delete, .. } => {
            Some((delete.moment.moment_id.as_str(), delete.deduped))
        }
        MergeTextFileResult::Unchanged { .. } | MergeTextFileResult::Conflict { .. } => None,
    }
}

fn conflict_open_on_store(
    store: &mut EngineStore,
    conflict: &TextConflict,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<bool, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let outcome = store.write_with(faults, |tx| {
        let inserted = insert_text_conflict_if_absent(tx, conflict)?;
        Ok::<_, dohc_engine_domain::DomainError>(inserted)
    })?;
    match outcome {
        TxnOutcome::Committed(inserted) => Ok(inserted),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn conflict_resolve_on_store(
    store: &mut EngineStore,
    input: &ResolveTextConflict,
    root_dir: Option<&std::path::Path>,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<ResolveTextConflictResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    VersionedTextStore::new(store)
        .resolve_text_conflict_with(
            input,
            faults,
            |tx, conflict, _live| {
                let prepared =
                    dohc_engine_sync::prepare_local_conflict_resolve_v1_in_tx(tx, input, conflict)
                        .map_err(map_fold_error)?;
                prepared
                    .ensure_no_live_ydoc_session(leases)
                    .map_err(map_fold_error)?;
                Ok(prepared)
            },
            |tx, result, plan| {
                if let Some(delete) = result.delete.as_ref() {
                    delete_file_search_index(
                        tx,
                        &input.workspace_id,
                        &delete.before.version_id,
                        &delete.object.object_id,
                    )
                    .map_err(search_domain)?;
                }
                if let Some(write) = result.write.as_ref()
                    && let Some(root_dir) = root_dir
                {
                    upsert_file_search_index(
                        tx,
                        root_dir,
                        &input.workspace_id,
                        &write.snapshot.version_id,
                        &write.snapshot.object_id,
                        &write.snapshot.path,
                        &write.snapshot.text,
                    )
                    .map_err(search_domain)?;
                }
                dohc_engine_sync::commit_local_conflict_resolve_v1_in_tx(tx, &plan, result)
                    .map_err(map_fold_error)?;
                Ok(())
            },
        )
        .map_err(RuntimeError::from)
}

/// Map a resolution-fold failure into the resolving transaction's error
/// domain: payload-shaped refusals stay refusals, storage stays storage.
fn map_fold_error(error: dohc_engine_sync::SyncError) -> dohc_engine_domain::DomainError {
    match error {
        dohc_engine_sync::SyncError::LiveDocumentBindingActive => {
            dohc_engine_domain::DomainError::LiveDocumentBindingActive
        }
        dohc_engine_sync::SyncError::InvalidInput { reason } => {
            dohc_engine_domain::DomainError::InvalidInput { reason }
        }
        dohc_engine_sync::SyncError::InputTooLarge {
            constraint,
            limit_bytes,
            observed_bytes,
        } => dohc_engine_domain::DomainError::PayloadTooLarge {
            constraint,
            limit_bytes,
            observed_bytes,
        },
        // The fold's size refusal carries its measurements; wrapping it as
        // state-corrupt would throw them away and misreport a bounded input
        // as corruption.
        dohc_engine_sync::SyncError::BlobTooLarge {
            constraint,
            limit_bytes,
            observed_bytes,
        } => dohc_engine_domain::DomainError::PayloadTooLarge {
            constraint,
            limit_bytes,
            observed_bytes,
        },
        dohc_engine_sync::SyncError::Storage(storage) => {
            dohc_engine_domain::DomainError::Storage(storage)
        }
        dohc_engine_sync::SyncError::RetryableState { reason } => {
            dohc_engine_domain::DomainError::InvalidInput { reason }
        }
        other => dohc_engine_domain::DomainError::Storage(
            dohc_engine_storage::StorageError::corrupt_public(other),
        ),
    }
}

#[cfg(test)]
mod doc_cache_reset_tests {
    use super::*;
    use dohc_engine_collab::{ContentKind, Regime, Ydoc};
    use dohc_engine_storage::NoFaults;
    use dohc_engine_testkit::ScratchDir;

    #[test]
    fn local_file_retire_removes_a_poisoned_warm_entry_immediately() {
        let scratch = ScratchDir::new().expect("scratch directory");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("engine database"),
            1,
        )
        .expect("open engine store");
        ensure_mutation_version_on_store(&mut store, "workspace", "main", 1, &NoFaults)
            .expect("ensure main version");
        let key = DocKey::new("workspace", "main", "document").expect("document key");
        let update = Ydoc::wire().plaintext_insert(0, "cached");
        let mut cache = WriterDocCache::new();
        let appended = dohc_engine_collab::record_local_update(
            &mut store,
            &mut cache,
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("document.md"),
                    content_kind: ContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                ensure_parent_row: true,
                ..Default::default()
            },
            &NoFaults,
            2,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("append update");
        assert!(matches!(appended, TxnOutcome::Committed(_)));
        assert!(cache.contains_for_test(&key), "the entry must be warm");
        cache.poison_doc_for_test(&key, Ydoc::wire());

        let retired = with_local_file_mutation_cache_reset(&mut cache, || {
            store.write_with(&NoFaults, |tx| -> Result<(), RuntimeError> {
                dohc_engine_sync::retire_ydoc_lineage_in_tx(
                    tx,
                    &key.workspace_id,
                    &key.version_id,
                    &key.object_id,
                )
                .map_err(RuntimeError::from)
            })
        })
        .expect("retire lineage");
        assert!(matches!(retired, TxnOutcome::Committed(())));
        assert!(
            !cache.contains_for_test(&key),
            "retire must remove the entry before any healing append"
        );
        assert!(
            dohc_engine_collab::read_marker(&store, &key)
                .expect("read retired marker")
                .is_none(),
            "the lineage must be retired"
        );
    }
}
