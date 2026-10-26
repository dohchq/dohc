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
    binary_write_job_id, enqueue_binary_delete, enqueue_binary_rename,
    insert_text_conflict_if_absent, rollback_compensating_moment_id, write_text_in_tx,
};
use dohc_engine_storage::text;
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
                    None,
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

    /// Whether keyed write `request_id`, whose recorded result is
    /// `moment_id`, reached disk. A committed moment alone never says so.
    pub async fn publication_applied(
        &self,
        workspace_id: String,
        request_id: String,
        moment_id: String,
    ) -> Result<bool, RuntimeError> {
        self.run(move |store, _| {
            publication_applied_on_store(store, &workspace_id, &request_id, &moment_id)
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
        expected_sha256: Option<String>,
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
                    expected_sha256.as_deref(),
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

    pub async fn resolve_files(
        &self,
        workspace_id: String,
        version_id: Option<String>,
        targets: Vec<dohc_engine_domain::FileResolveTarget>,
        token: CancellationToken,
    ) -> Result<(String, Vec<dohc_engine_domain::FileResolution>), RuntimeError> {
        self.run(move |store, _| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let result = VersionedTextStore::new(store)
                .resolve_files(&workspace_id, version_id.as_deref(), &targets)
                .map_err(RuntimeError::from);
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            result
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
        None,
        faults,
        token,
    )
}

type TextCommitHook<'a> = &'a dyn Fn(&rusqlite::Transaction<'_>) -> Result<(), RuntimeError>;

#[allow(clippy::too_many_arguments)]
pub(super) fn versioned_text_write_with_publication_on_store(
    store: &mut EngineStore,
    input: &WriteText,
    root_dir: Option<&std::path::Path>,
    restore_before_moment_id: Option<&str>,
    conditions: Option<&WriteConditions>,
    commit_hook: Option<TextCommitHook<'_>>,
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
        let replayed: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id=?1)",
                [&input.request_id],
                |row| row.get(0),
            )
            .map_err(StorageError::corrupt_public)?;
        if !replayed
            && input.metadata_origin == "restore"
            && let Some(expected) = conditions.and_then(|c| c.expected_sha256.as_deref())
        {
            check_restore_content_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &input.path,
                expected,
            )?;
        }
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
        if let Some(commit_hook) = commit_hook {
            commit_hook(tx)?;
        }
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
        if !replayed
            && input.metadata_origin == "restore"
            && let Some(expected) = conditions.and_then(|c| c.expected_sha256.as_deref())
        {
            check_restore_content_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &input.path,
                expected,
            )?;
        }
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
        &binary_write_job_id(&result.moment.moment_id),
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

pub(super) fn ensure_publication_version(
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

/// The request must have recorded this moment as its result. Without a
/// recorded outcome, only the moment's own publication job counts, once
/// complete: supersession records its outcome before the job reads complete.
fn publication_applied_on_store(
    store: &EngineStore,
    workspace_id: &str,
    request_id: &str,
    moment_id: &str,
) -> Result<bool, RuntimeError> {
    let recorded: Option<(Option<String>, bool)> = store.read_with(|conn| {
        conn.query_row(
            &format!(
                "SELECT r.publication_outcome, j.job_id IS NOT NULL FROM engine_requests r \
                 JOIN moments m ON m.moment_order = r.result_seq \
                 LEFT JOIN materialization_jobs j ON j.job_id = {job} \
                   AND j.workspace_id = m.workspace_id \
                   AND j.target_generation = m.moment_order AND j.status = 'complete' \
                 WHERE r.request_id = ?1 AND r.kind = 'versioned' \
                   AND m.workspace_id = ?2 AND m.moment_id = ?3",
                job = dohc_engine_storage::materialize::MOMENT_PUBLICATION_JOB_SQL,
            ),
            params![request_id, workspace_id, moment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::corrupt_public)
    })?;
    Ok(match recorded {
        None => false,
        Some((Some(outcome), _)) => outcome == "applied",
        Some((None, complete)) => complete,
    })
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
                    None,
                );
                let settled = !matches!(
                    result.1,
                    Outcome::Error | Outcome::Skipped | Outcome::Parked
                );
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
            Outcome::Parked => unreachable!("held publications remain pending"),
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
            None,
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
                None,
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
    expected_sha256: Option<&str>,
    confirm_absent: bool,
    root_dir: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<DeleteResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if let Some(expected) = expected_sha256 {
        return checked_delete_on_store(
            store,
            input,
            expected_object_id,
            expected,
            root_dir,
            self_writes,
            faults,
        );
    }
    if confirm_absent {
        super::capture::confirm_absent_on_disk(
            store,
            root_dir,
            &input.workspace_id,
            &input.path,
            input.now_ms,
        )?;
    }
    let outcome = store.write_with(faults, |tx| {
        let unresolved: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM share_direct_write_plan p,json_each(p.objects_json) o \
             JOIN snapshots s ON s.workspace_id=p.workspace_id AND s.object_id=json_extract(o.value,'$[0]') \
             WHERE p.workspace_id=?1 AND p.result_json IS NULL AND s.version_id=?2 AND s.path=?3)",
            rusqlite::params![input.workspace_id, input.version_id, input.path], |row| row.get(0),
        ).map_err(StorageError::corrupt_public)?;
        if unresolved {
            return Err(RuntimeError::from(dohc_engine_domain::DomainError::InvalidInput {
                reason: "record-delivery-unknown",
            }));
        }
        let result = dohc_engine_domain::delete_text_in_tx_checked(tx, input, expected_object_id, None)
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
                    None,
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
                None,
            )?;
            Ok(result)
        }
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn checked_delete_on_store(
    store: &mut EngineStore,
    input: &DeleteTextFile,
    expected_object_id: Option<&str>,
    expected: &str,
    root: &std::path::Path,
    self_writes: &dyn SelfWriteRecorder,
    faults: &dyn FaultInjector,
) -> Result<DeleteResult, RuntimeError> {
    let staged = store.write_with(faults, |tx| {
        let replayed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id=?1)", [&input.request_id], |r| r.get(0)).map_err(StorageError::corrupt_public)?;
        if !replayed {
            ensure_publication_version(tx, &input.workspace_id, &input.version_id)?;
            check_restore_content_in_tx(tx, &input.workspace_id, &input.version_id, &input.path, expected)?;
            WriteConditions {create_only: false, expected_sha256: Some(expected.to_owned())}.check(root, &input.path, true)?;
            let unresolved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM share_direct_write_plan p,json_each(p.objects_json) o JOIN snapshots s ON s.workspace_id=p.workspace_id AND s.object_id=json_extract(o.value,'$[0]') WHERE p.workspace_id=?1 AND p.result_json IS NULL AND s.version_id=?2 AND s.path=?3)",params![input.workspace_id,input.version_id,input.path],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
            if unresolved { return Err(DomainError::InvalidInput {reason: "record-delivery-unknown"}.into()); }
        }
        let result = dohc_engine_domain::prepare_checked_delete_in_tx(tx, input, expected_object_id, expected)?;
        if !result.deduped {
            dohc_engine_storage::enqueue_delete_job(tx, &dohc_engine_storage::MaterializationJobSpec {
                job_id: format!("restore-delete-mat_{}", input.moment_id), workspace_id: input.workspace_id.clone(), target_path: input.path.clone(), content_sha256: expected.into(), preimage: Preimage::Present(expected.into()), target_generation: result.moment.moment_order, now_ms: input.now_ms,
            })?;
        }
        Ok::<_,RuntimeError>(result)
    })?;
    let result = match staged {
        TxnOutcome::Committed(result) => result,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    let job_id = format!("restore-delete-mat_{}", input.moment_id);
    if store.load_materialization_job(&job_id)?.is_none() && result.deduped {
        return Ok(result);
    }
    publish_checked_delete_on_store(
        store,
        root,
        &input.workspace_id,
        &job_id,
        self_writes,
        input.now_ms,
        faults,
        false,
        result.deduped,
        None,
    )?;
    Ok(result)
}

/// The job prefix is the durable pending-publication state. Until completion,
/// the snapshot, lineage, search index and replication journal stay unchanged.
#[allow(clippy::too_many_arguments)]
pub(super) fn publish_checked_delete_on_store(
    store: &mut EngineStore,
    root: &std::path::Path,
    workspace_id: &str,
    job_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    recovery: bool,
    request_retry: bool,
    holds: Option<&dohc_engine_files::PlacementHolds>,
) -> Result<(), RuntimeError> {
    use dohc_engine_files::{
        DurabilityPolicy, JobOutcome, MaterializeOptions, StdBackoff, StdReplacer,
    };
    let Some(mut job) = store.load_materialization_job(job_id)? else {
        return Ok(());
    };
    let moment_id =
        job_id
            .strip_prefix("restore-delete-mat_")
            .ok_or(DomainError::InvalidInput {
                reason: "not a checked delete job",
            })?;
    use super::checked_deletes::{ExportedDeleteRecovery, recover_exported_on_store};
    let exported_recovery = if recovery {
        match recover_exported_on_store(
            store,
            root,
            workspace_id,
            job_id,
            moment_id,
            now_ms,
            faults,
            holds,
        )? {
            ExportedDeleteRecovery::Settled => return Ok(()),
            ExportedDeleteRecovery::Publish => {
                if job.status == JobStatus::Conflict {
                    job.status = JobStatus::Pending;
                }
                true
            }
            ExportedDeleteRecovery::NotExported => false,
        }
    } else {
        false
    };
    if recovery && holds.is_some_and(|holds| holds.blocks(&job.target_path)) {
        return Err(RuntimeError::CaptureFileHeld {
            path: job.target_path.clone(),
        });
    }
    if (recovery || request_retry)
        && job.status == JobStatus::Pending
        && dohc_engine_files::workspace_recovery_unavailable(root)
    {
        return Err(dohc_engine_files::MaterializeError::RecoveryUnavailable.into());
    }
    if recovery
        && !exported_recovery
        && job.status == JobStatus::Pending
        && !matches!(
            dohc_engine_files::materialize::probe_projection_target(
                root,
                &job.target_path,
                dohc_engine_files::materialize::ProjectionTargetKind::Plaintext
            ),
            dohc_engine_files::materialize::ProjectionTargetState::Absent
        )
    {
        let discarded = store.write_with(faults, |tx| {
            let repair_job = enqueue_discarded_delete_projection_in_tx(
                tx,
                root,
                workspace_id,
                moment_id,
                now_ms,
            )?;
            settle_checked_delete_in_tx(tx, workspace_id, moment_id, false, true)?;
            Ok::<_, RuntimeError>(repair_job)
        })?;
        return match discarded {
            TxnOutcome::Committed(repair_job) => {
                if let Some(job_id) = repair_job {
                    materialize_expected_job(
                        store,
                        root,
                        workspace_id,
                        &job_id,
                        self_writes,
                        now_ms,
                        faults,
                        holds,
                    );
                }
                Ok(())
            }
            TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
        };
    }
    self_writes.record(workspace_id, &job.target_path, &job.content_sha256);
    // A disk receipt can outlive a failed finish commit. Retries must check
    // the current snapshot even when the file has already been removed.
    let check_snapshot = matches!(job.status, JobStatus::Pending | JobStatus::Complete);
    let canonical = if check_snapshot {
        store
            .write_with(&dohc_engine_storage::NoFaults, |tx| {
                let version_id: String = tx
                    .query_row(
                        "SELECT version_id FROM moments WHERE workspace_id=?1 AND moment_id=?2",
                        params![workspace_id, moment_id],
                        |row| row.get(0),
                    )
                    .map_err(StorageError::corrupt_public)?;
                ensure_publication_version(tx, workspace_id, &version_id)?;
                check_restore_content_in_tx(
                    tx,
                    workspace_id,
                    &version_id,
                    &job.target_path,
                    &job.content_sha256,
                )?;
                // Exercise every finish check on the same actor-owned state before
                // touching disk. The savepoint rolls back indexes, assets and lineage.
                tx.execute_batch("SAVEPOINT checked_delete_finish")
                    .map_err(StorageError::persist_public)?;
                let checked = settle_checked_delete_in_tx(tx, workspace_id, moment_id, true, true);
                let rolled_back = tx
                    .execute_batch(
                        "ROLLBACK TO checked_delete_finish; RELEASE checked_delete_finish",
                    )
                    .map_err(StorageError::persist_public);
                checked?;
                rolled_back?;
                Ok::<_, RuntimeError>(())
            })
            .map(|_| ())
    } else {
        Ok(())
    };
    let outcome = match canonical {
        Err(error)
            if job.status == JobStatus::Complete
                && !matches!(
                    error,
                    RuntimeError::Domain(
                        DomainError::WritePreconditionFailed { .. } | DomainError::InvalidVersion
                    )
                ) =>
        {
            self_writes.retract(workspace_id, &job.target_path, &job.content_sha256);
            return Err(error);
        }
        Err(error) => Err(error),
        Ok(()) => match job.status {
            JobStatus::Complete => Ok(JobOutcome::AlreadyMaterialized),
            JobStatus::Conflict => Ok(JobOutcome::Conflict),
            JobStatus::Cancelled => Ok(JobOutcome::Superseded),
            JobStatus::Pending => dohc_engine_files::materialize::materialize_one_ordinary(
                store,
                root,
                &job,
                &MaterializeOptions {
                    holds,
                    policy: DurabilityPolicy::per_os(),
                    replacer: &StdReplacer,
                    backoff: &StdBackoff,
                    now_ms,
                    faults,
                },
            )
            .map_err(RuntimeError::from),
        },
    };
    if matches!(outcome, Ok(JobOutcome::Crashed(_))) {
        return Err(RuntimeError::OperationCrashed);
    }
    let applied = matches!(
        outcome,
        Ok(JobOutcome::Completed | JobOutcome::AlreadyMaterialized)
    );
    if !applied {
        self_writes.retract(workspace_id, &job.target_path, &job.content_sha256);
    }
    if matches!(outcome, Ok(JobOutcome::Parked)) {
        return Err(RuntimeError::CaptureFileHeld {
            path: job.target_path.clone(),
        });
    }
    if (recovery || request_retry)
        && matches!(
            outcome,
            Err(RuntimeError::Materialize(
                dohc_engine_files::MaterializeError::RecoveryUnavailable
                    | dohc_engine_files::MaterializeError::SymlinkTarget
            ))
        )
    {
        // The file may still be in inaccessible staging. Keep its job and
        // unjournaled moment together for the next recovery attempt.
        return outcome.map(|_| ());
    }
    if exported_recovery && !applied {
        if matches!(
            recover_exported_on_store(
                store,
                root,
                workspace_id,
                job_id,
                moment_id,
                now_ms,
                faults,
                holds
            )?,
            ExportedDeleteRecovery::Settled
        ) {
            return Ok(());
        }
        return match outcome {
            Err(error) => Err(error),
            Ok(_) => Err(DomainError::WritePreconditionFailed {
                current_sha256: None,
            }
            .into()),
        };
    }
    let finalized = store.write_with(faults, |tx| {
        let repair_job = if applied {
            None
        } else {
            enqueue_discarded_delete_projection_in_tx(tx, root, workspace_id, moment_id, now_ms)?
        };
        let asset_jobs = settle_checked_delete_in_tx(tx, workspace_id, moment_id, applied, true)?;
        Ok::<_, RuntimeError>((asset_jobs, repair_job))
    })?;
    match finalized {
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
        TxnOutcome::Committed((asset_jobs, repair_job)) => {
            if let Some(job_id) = repair_job {
                materialize_expected_job(
                    store,
                    root,
                    workspace_id,
                    &job_id,
                    self_writes,
                    now_ms,
                    faults,
                    holds,
                );
            }
            materialize_scene_asset_deletes(
                store,
                root,
                workspace_id,
                &asset_jobs,
                self_writes,
                faults,
                None,
                holds,
            )?;
        }
    }
    match outcome {
        Ok(_) if applied => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(DomainError::WritePreconditionFailed {
            current_sha256: None,
        }
        .into()),
    }
}

fn enqueue_discarded_delete_projection_in_tx(
    tx: &rusqlite::Transaction<'_>,
    root: &std::path::Path,
    workspace_id: &str,
    moment_id: &str,
    now_ms: i64,
) -> Result<Option<String>, RuntimeError> {
    use dohc_engine_files::{ProjectionTargetKind, ProjectionTargetState, probe_projection_target};
    use dohc_engine_storage::{
        MaterializationJobSpec, MaterializationOperation, upsert_projection_job,
    };

    let (version_id, path): (String, String) = tx
        .query_row(
            "SELECT version_id, path FROM moments WHERE workspace_id=?1 AND moment_id=?2",
            params![workspace_id, moment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(StorageError::corrupt_public)?;
    match ensure_publication_version(tx, workspace_id, &version_id) {
        Err(RuntimeError::Domain(DomainError::InvalidVersion)) => return Ok(None),
        result => result?,
    }
    if !matches!(
        probe_projection_target(root, &path, ProjectionTargetKind::Plaintext),
        ProjectionTargetState::Absent
    ) {
        return Ok(None);
    }
    let snapshot: Option<(String, Option<String>, i64)> = tx
        .query_row(
            "SELECT CASE s.content_kind WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END, \
         b.sha256, s.updated_at_ms FROM snapshots s LEFT JOIN blobs b ON b.sha256=s.blob_sha256 \
         WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.path=?3",
            params![workspace_id, version_id, path],
            |row| {
                Ok((
                    row.get(0)?,
                    text::optional_from_row(tx, row, 1)?,
                    row.get(2)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::corrupt_public)?;
    let Some((content_sha256, text, target_generation)) = snapshot else {
        return Ok(None);
    };
    if let Some(text) = text {
        let stored_sha256 = text::put_materialization(tx, text.as_bytes())?;
        if stored_sha256 != content_sha256 {
            return Err(DomainError::StateCorrupt {
                reason: "current snapshot content does not match its digest",
            }
            .into());
        }
    }
    let job_id = super::versions::switch_projection_job_id(
        workspace_id,
        &version_id,
        &path,
        MaterializationOperation::Write,
        &content_sha256,
        false,
    );
    upsert_projection_job(
        tx,
        &MaterializationJobSpec {
            job_id: job_id.clone(),
            workspace_id: workspace_id.into(),
            target_path: path,
            content_sha256,
            preimage: Preimage::Absent,
            target_generation,
            now_ms,
        },
        MaterializationOperation::Write,
    )?;
    Ok(Some(job_id))
}

pub(super) fn settle_checked_delete_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    moment_id: &str,
    applied: bool,
    delete_scene_assets: bool,
) -> Result<Vec<(String, i64)>, RuntimeError> {
    let mut asset_jobs = Vec::new();
    if let Some(result) =
        dohc_engine_domain::finish_checked_delete_in_tx(tx, workspace_id, moment_id, applied)?
    {
        delete_file_search_index(
            tx,
            workspace_id,
            &result.moment.version_id,
            &result.object.object_id,
        )?;
        if delete_scene_assets {
            asset_jobs = delete_owned_scene_assets_in_tx(tx, &result)?;
        }
        dohc_engine_sync::retire_ydoc_lineage_in_tx(
            tx,
            workspace_id,
            &result.moment.version_id,
            &result.object.object_id,
        )?;
        let already_exported =
            dohc_engine_domain::moment_has_replication_dependents_in(tx, workspace_id, moment_id)?;
        journal_moment_outbound_in_tx(tx, workspace_id, moment_id, already_exported)?;
        tx.execute("UPDATE engine_requests SET publication_outcome='applied' WHERE result_seq=?1 AND kind='versioned'",[result.moment.moment_order]).map_err(StorageError::persist_public)?;
    }
    Ok(asset_jobs)
}

pub(super) fn check_restore_content_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    path: &str,
    expected: &str,
) -> Result<(), RuntimeError> {
    let current: Option<(String, String)> = tx.query_row(
        "SELECT object_id, CASE content_kind WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END \
         FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND path=?3",
        params![workspace_id, version_id, path], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(StorageError::corrupt_public)?;
    let Some((object_id, sha)) = current else {
        return Err(DomainError::WritePreconditionFailed {
            current_sha256: None,
        }
        .into());
    };
    let key = DocKey::new(workspace_id, version_id, &object_id)?;
    let live_matches =
        dohc_engine_sync::current_ydoc_content_matches_in_tx(tx, &key, path, expected)?;
    if sha != expected || !live_matches {
        return Err(DomainError::WritePreconditionFailed {
            current_sha256: Some(sha),
        }
        .into());
    }
    Ok(())
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
                metadata_correlation_id: Some(
                    drawing_delete
                        .moment
                        .metadata_correlation_id
                        .as_ref()
                        .filter(|id| id.starts_with(dohc_engine_domain::OPERATION_ID_PREFIX))
                        .cloned()
                        .unwrap_or_else(|| drawing_delete.moment.moment_id.clone()),
                ),
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
                 AND metadata_origin IN ('ydoc','local-file') AND (metadata_correlation_id=?4 OR metadata_correlation_id=(SELECT metadata_correlation_id FROM moments WHERE workspace_id=?1 AND moment_id=?4 AND metadata_correlation_id LIKE 'dohc-operation:%')) \
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
                 AND metadata_origin IN ('ydoc','local-file') AND (metadata_correlation_id=?4 OR metadata_correlation_id=(SELECT metadata_correlation_id FROM moments WHERE workspace_id=?1 AND moment_id=?4 AND metadata_correlation_id LIKE 'dohc-operation:%')) \
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
    holds: Option<&dohc_engine_files::PlacementHolds>,
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
            holds,
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
                None,
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
            None,
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
            None,
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
        let job_id = binary_write_job_id(&restore_moment_id);
        let materializes: bool = tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM materialization_jobs WHERE job_id = ?1)",
                [&job_id],
                |row| row.get(0),
            )
            .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
        if materializes {
            jobs.push(job_id);
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
                    None,
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
            let job_id = binary_write_job_id(&restore_moment_id);
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM moments m \
                     JOIN materialization_jobs j ON j.workspace_id = m.workspace_id \
                       AND j.job_id = ?7 \
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
                        sha256,
                        job_id
                    ],
                    |row| row.get(0),
                )
                .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
            if exists {
                jobs.push(job_id);
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

    let job_id = match &result {
        MergeTextFileResult::BinaryWrite { .. } => binary_write_job_id(moment_id),
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
        None,
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
    fn an_unacknowledged_creation_cannot_be_discarded() {
        let scratch = ScratchDir::new().unwrap();
        let mut store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
        ensure_mutation_version_on_store(&mut store, "workspace", "main", 1, &NoFaults).unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "document".into(),
                    path: "record.md".into(),
                    text: "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n".into(),
                    moment_id: "creation".into(),
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO share_direct_write_plan (workspace_id,share_id,ordinal,submit_id,changes_json,objects_json) \
                VALUES ('workspace','share',0,'same-submit','[]','[[\"document\",1]]')", [])
                .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        }).unwrap();
        let delete = DeleteTextFile {
            workspace_id: "workspace".into(),
            version_id: "main".into(),
            path: "record.md".into(),
            moment_id: "discard".into(),
            request_id: None,
            metadata_origin: "user".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 3,
        };
        let result = versioned_text_delete_on_store(
            &mut store,
            &delete,
            None,
            None,
            false,
            &scratch,
            &(),
            &NoFaults,
            &CancellationToken::new(),
        );
        assert!(matches!(
            result,
            Err(RuntimeError::Domain(DomainError::InvalidInput {
                reason: "record-delivery-unknown"
            }))
        ));
        let head: String = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT latest_moment_id FROM snapshots \
            WHERE workspace_id='workspace' AND version_id='main' AND path='record.md'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(head, "creation");
    }

    #[test]
    fn conditional_restore_delete_preserves_disk_and_snapshot_on_a_late_change() {
        struct ChangeBeforePublication(PathBuf);
        impl SelfWriteRecorder for ChangeBeforePublication {
            fn record(&self, _: &str, _: &str, _: &str) {
                std::fs::write(&self.0, "Owner text KEEP\n").unwrap();
            }
            fn retract(&self, _: &str, _: &str, _: &str) {}
        }
        let scratch = ScratchDir::new().unwrap();
        let mut store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
        ensure_mutation_version_on_store(&mut store, "workspace", "main", 1, &NoFaults).unwrap();
        let text = "recipient text\n";
        std::fs::write(scratch.join("record.md"), text).unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "document".into(),
                    path: "record.md".into(),
                    text: text.into(),
                    moment_id: "creation".into(),
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        let delete = DeleteTextFile {
            workspace_id: "workspace".into(),
            version_id: "main".into(),
            path: "record.md".into(),
            moment_id: "restore-delete".into(),
            request_id: Some("restore-request".into()),
            metadata_origin: "restore".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 3,
        };
        let result = versioned_text_delete_on_store(
            &mut store,
            &delete,
            Some("document"),
            Some(&dohc_engine_storage::hex_sha256(text.as_bytes())),
            false,
            &scratch,
            &ChangeBeforePublication(scratch.join("record.md")),
            &NoFaults,
            &CancellationToken::new(),
        );
        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(scratch.join("record.md")).unwrap(),
            "Owner text KEEP\n"
        );
        assert!(
            VersionedTextStore::new(&mut store)
                .read_text("workspace", "main", "record.md")
                .unwrap()
                .is_some()
        );
        assert_checked_delete_absent(&store);
    }

    fn checked_delete_fixture(binary: bool) -> (ScratchDir, EngineStore, DeleteTextFile, String) {
        let bytes = if binary {
            b"\0recipient bytes".as_slice()
        } else {
            b"recipient text\n".as_slice()
        };
        checked_delete_fixture_with_bytes(binary, bytes)
    }

    fn checked_delete_fixture_with_bytes(
        binary: bool,
        bytes: &[u8],
    ) -> (ScratchDir, EngineStore, DeleteTextFile, String) {
        let scratch = ScratchDir::new().unwrap();
        let mut store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
        ensure_mutation_version_on_store(&mut store, "workspace", "main", 1, &NoFaults).unwrap();
        std::fs::write(scratch.join("record.md"), bytes).unwrap();
        if binary {
            VersionedTextStore::new(&mut store)
                .write_binary(
                    &WriteBinary {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: "document".into(),
                        path: "record.md".into(),
                        bytes: bytes.to_vec(),
                        moment_id: "creation".into(),
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
        } else {
            VersionedTextStore::new(&mut store)
                .write_text(
                    &WriteText {
                        workspace_id: "workspace".into(),
                        version_id: "main".into(),
                        object_id: "document".into(),
                        path: "record.md".into(),
                        text: String::from_utf8(bytes.to_vec()).unwrap(),
                        moment_id: "creation".into(),
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                        request_id: None,
                    },
                    &NoFaults,
                )
                .unwrap();
            let key = DocKey::new("workspace", "main", "document").unwrap();
            dohc_engine_collab::record_local_update(
                &mut store,
                &mut WriterDocCache::new(),
                &key,
                &dohc_engine_collab::Ydoc::wire().plaintext_insert(0, "recipient text\n"),
                dohc_engine_collab::LocalAppend {
                    marker: Some(dohc_engine_collab::MarkerCreation {
                        path: Some("record.md"),
                        content_kind: dohc_engine_collab::ContentKind::Plaintext,
                        regime: dohc_engine_collab::Regime::LocalOnly,
                    }),
                    ensure_parent_row: true,
                    ..Default::default()
                },
                &NoFaults,
                2,
                |_tx, _outcome, _sha| Ok(()),
            )
            .unwrap();
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute(
                        "UPDATE ydoc_docs SET settled_update_seq=head_update_seq",
                        [],
                    )
                    .map_err(StorageError::persist_public)
                })
                .unwrap();
        }
        // The domain write may enqueue the initial projection; it is unrelated
        // to the checked deletion under test.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("DELETE FROM materialization_jobs", [])
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        store
            .read_with(|conn| {
                upsert_file_search_index(
                    conn,
                    &scratch,
                    "workspace",
                    "main",
                    "document",
                    "record.md",
                    "recipient searchable text",
                )
            })
            .unwrap();
        let input = DeleteTextFile {
            workspace_id: "workspace".into(),
            version_id: "main".into(),
            path: "record.md".into(),
            moment_id: "restore-delete".into(),
            request_id: Some("restore-request".into()),
            metadata_origin: "restore".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 3,
        };
        (scratch, store, input, hex_sha256(bytes))
    }

    #[test]
    fn checked_delete_backfill_waits_for_publication() {
        for binary in [false, true] {
            for direct in [false, true] {
                let (root, mut store, input, expected) = checked_delete_fixture(binary);
                crash_checked_delete(
                    &root,
                    &mut store,
                    &input,
                    &expected,
                    FaultPoint::StorageAfterCommitBeforeAck,
                );
                if direct {
                    dohc_engine_sync::adopt_join_identity(
                        &mut store,
                        "workspace",
                        "local",
                        "epoch",
                        "stream",
                        4,
                        &NoFaults,
                    )
                    .unwrap();
                    store
                        .write_with(&NoFaults, |tx| {
                            dohc_engine_sync::journal_moment_append_in_tx(
                                tx,
                                "workspace",
                                &input.moment_id,
                            )
                        })
                        .unwrap();
                }
                if !direct {
                    bootstrap_checked_delete(&mut store);
                }
                assert_eq!(
                    checked_delete_exports(&store),
                    0,
                    "unpublished delete reached peers"
                );
                publish_checked_delete_on_store(
                    &mut store,
                    &root,
                    "workspace",
                    "restore-delete-mat_restore-delete",
                    &(),
                    6,
                    &NoFaults,
                    false,
                    true,
                    None,
                )
                .unwrap();
                assert!(!root.join("record.md").exists());
                bootstrap_checked_delete(&mut store);
                assert_eq!(
                    checked_delete_exports(&store),
                    1,
                    "publication must journal once"
                );
            }
        }
    }

    #[test]
    fn checked_delete_reopen_after_backfill_finishes_or_abandons() {
        for binary in [false, true] {
            for published in [false, true] {
                let (root, mut store, input, expected) = checked_delete_fixture(binary);
                crash_checked_delete(
                    &root,
                    &mut store,
                    &input,
                    &expected,
                    if published {
                        FaultPoint::MaterializeAfterKnownCopyDeletion
                    } else {
                        FaultPoint::StorageAfterCommitBeforeAck
                    },
                );
                bootstrap_checked_delete(&mut store);
                drop(store);
                let mut store =
                    EngineStore::open(&dohc_engine_testkit::engine_db_path(&root).unwrap(), 6)
                        .unwrap();
                checked_delete_replay(&mut store, &root);
                checked_delete_replay(&mut store, &root);
                assert!(
                    store
                        .load_materialization_job("restore-delete-mat_restore-delete")
                        .unwrap()
                        .is_none(),
                    "reopening must settle the prepared delete"
                );
                assert_eq!(root.join("record.md").exists(), !published);
                assert_eq!(checked_delete_count(&store), i64::from(published));
                assert_eq!(checked_delete_exports(&store), i64::from(published));
            }
        }
    }

    fn bootstrap_checked_delete(store: &mut EngineStore) {
        dohc_engine_sync::adopt_join_identity(
            store,
            "workspace",
            "local",
            "epoch",
            "stream",
            4,
            &NoFaults,
        )
        .unwrap();
        dohc_engine_sync::commit_relay_cursor(
            store,
            "workspace",
            &dohc_engine_sync::RelayCursor {
                cursor: 1,
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                bootstrap_complete: true,
                settlement_report_id: None,
                ordinary_pull: None,
            },
            &NoFaults,
            &dohc_engine_sync::NoLiveLeases,
            5,
        )
        .unwrap();
    }

    fn checked_delete_exports(store: &EngineStore) -> i64 {
        store.read_with(|conn| conn.query_row("SELECT count(*) FROM replication_log WHERE workspace_id='workspace' AND op_kind='moment.append' AND json_extract(payload_json,'$.momentId')='restore-delete'", [], |r| r.get(0))).unwrap()
    }

    #[test]
    fn checked_delete_replay_keeps_a_held_intent_parked() {
        assert_held_checked_delete_stays_parked(false);
    }

    #[test]
    fn checked_delete_legacy_replay_keeps_a_held_intent_parked() {
        assert_held_checked_delete_stays_parked(true);
    }

    fn assert_held_checked_delete_stays_parked(exported: bool) {
        let (root, mut store, input, expected) = checked_delete_fixture(false);
        crash_checked_delete(
            &root,
            &mut store,
            &input,
            &expected,
            FaultPoint::StorageAfterCommitBeforeAck,
        );
        if exported {
            bootstrap_checked_delete(&mut store);
            seed_legacy_checked_delete_export(&mut store);
            versioned_text_rename_on_store(
                &mut store,
                &RenameTextFile {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    from_path: "record.md".into(),
                    to_path: "renamed.md".into(),
                    moment_id: "later-rename".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 6,
                    request_id: None,
                },
                &root,
                &(),
                &NoFaults,
                &CancellationToken::new(),
            )
            .unwrap();
            std::fs::rename(root.join("record.md"), root.join("renamed.md")).unwrap();
        }
        let path = if exported { "renamed.md" } else { "record.md" };
        // Matching bytes let legacy recovery settle unless the current path's hold parks it.
        let outside = if exported {
            "recipient text\n".to_owned()
        } else {
            format!("{} held outside edit\n", "> ".repeat(121))
        };
        std::fs::write(root.join(path), &outside).unwrap();
        let hold = dohc_engine_storage::capture_file_holds::CaptureFileHold {
            workspace_id: "workspace".into(),
            source_version_id: "main".into(),
            object_id: "document".into(),
            path: path.into(),
            observed_sha256: hex_sha256(outside.as_bytes()),
            observed_size: outside.len() as u64,
            reason: dohc_engine_storage::capture_file_holds::NOT_REPRESENTABLE.into(),
            observed_at_ms: 4,
            attempt_count: 1,
            retry_requested: false,
        };
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_storage::capture_file_holds::record_in(tx, &hold)
            })
            .unwrap();
        checked_delete_replay(&mut store, &root);
        assert_eq!(
            store
                .load_materialization_job("restore-delete-mat_restore-delete")
                .unwrap()
                .expect("a held checked delete must stay parked")
                .status,
            JobStatus::Pending
        );
        assert_eq!(std::fs::read_to_string(root.join(path)).unwrap(), outside);
        assert_eq!(
            store
                .read_with(|conn| {
                    dohc_engine_storage::capture_file_holds::hold_in(conn, "workspace", path)
                })
                .unwrap(),
            Some(hold)
        );
    }

    #[test]
    fn checked_delete_discard_refuses_a_moment_exported_before_disk_publication() {
        let (root, mut store, input, expected) = checked_delete_fixture(true);
        crash_checked_delete(
            &root,
            &mut store,
            &input,
            &expected,
            FaultPoint::StorageAfterCommitBeforeAck,
        );
        bootstrap_checked_delete(&mut store);
        seed_legacy_checked_delete_export(&mut store);
        assert_eq!(checked_delete_exports(&store), 1);
        assert_checked_delete_discard_retains_referenced_moment(&mut store);
    }

    #[test]
    fn checked_delete_blocked_recovery_stays_unpublished_until_retry() {
        let (root, mut store, input, expected) = checked_delete_fixture(true);
        crash_checked_delete(
            &root,
            &mut store,
            &input,
            &expected,
            FaultPoint::StorageAfterCommitBeforeAck,
        );
        let staging = root.join(".dohc/engine/displaced");
        std::fs::write(&staging, b"inaccessible staging").unwrap();
        checked_delete_replay(&mut store, &root);
        assert!(dohc_engine_files::workspace_recovery_unavailable(&root));
        bootstrap_checked_delete(&mut store);
        assert_eq!(checked_delete_exports(&store), 0);
        std::fs::remove_file(&staging).unwrap();
        drop(store);
        let mut store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&root).unwrap(), 8).unwrap();
        checked_delete_replay(&mut store, &root);
        assert!(
            store
                .load_materialization_job("restore-delete-mat_restore-delete")
                .unwrap()
                .is_none()
        );
        assert_eq!(checked_delete_exports(&store), 0);
        assert_eq!(checked_delete_count(&store), 0);
        assert_eq!(
            hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
            expected
        );
    }

    fn legacy_export_fixture(binary: bool) -> (ScratchDir, EngineStore) {
        let (root, mut store, input, expected) = checked_delete_fixture(binary);
        crash_checked_delete(
            &root,
            &mut store,
            &input,
            &expected,
            FaultPoint::StorageAfterCommitBeforeAck,
        );
        bootstrap_checked_delete(&mut store);
        seed_legacy_checked_delete_export(&mut store);
        (root, store)
    }

    fn reopen_legacy(store: EngineStore, root: &std::path::Path) -> EngineStore {
        drop(store);
        let mut store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(root).unwrap(), 7).unwrap();
        checked_delete_replay(&mut store, root);
        store
    }

    fn assert_legacy_pending(store: &EngineStore, pending: bool) {
        assert_eq!(
            store
                .load_materialization_job("restore-delete-mat_restore-delete")
                .unwrap()
                .is_some(),
            pending
        );
        assert_eq!(checked_delete_exports(store), 1);
    }

    fn capture_legacy_bytes(store: &mut EngineStore, path: &str, bytes: &[u8], binary: bool) {
        store
            .write_with(&NoFaults, |tx| {
                let (object_id, moment_id) = if binary {
                    let result = dohc_engine_domain::capture_ingest_binary_in_tx(
                        tx,
                        &dohc_engine_domain::CaptureIngestBinary {
                            workspace_id: "workspace".into(),
                            version_id: "main".into(),
                            path: path.into(),
                            bytes: bytes.to_vec(),
                            metadata_origin: "capture".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 6,
                            request_id: None,
                            claim_foreign_head: true,
                        },
                    )?;
                    (result.object_id, result.moment_id)
                } else {
                    let result = dohc_engine_domain::capture_ingest_in_tx(
                        tx,
                        &dohc_engine_domain::CaptureIngest {
                            workspace_id: "workspace".into(),
                            version_id: "main".into(),
                            path: path.into(),
                            text: std::str::from_utf8(bytes).unwrap().into(),
                            metadata_origin: "capture".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 6,
                            request_id: None,
                            claim_foreign_head: true,
                        },
                    )?;
                    (result.object.object_id, result.moment.moment_id)
                };
                dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                    tx,
                    "workspace",
                    "main",
                    &object_id,
                    if binary {
                        dohc_engine_sync::ResultingHead::BinaryOrAbsent
                    } else {
                        dohc_engine_sync::ResultingHead::Text {
                            path,
                            text: std::str::from_utf8(bytes).unwrap(),
                        }
                    },
                    None,
                    None,
                    6,
                )?;
                journal_moment_outbound_in_tx(tx, "workspace", &moment_id, false)?;
                Ok::<_, RuntimeError>(())
            })
            .unwrap();
    }

    #[test]
    fn checked_delete_legacy_uncaptured_disk_edit_stays_pending() {
        let (root, mut store) = legacy_export_fixture(false);
        std::fs::write(root.join("record.md"), b"uncaptured later text\n").unwrap();
        store = reopen_legacy(store, &root);
        assert_legacy_pending(&store, true);
        assert_eq!(
            std::fs::read_to_string(root.join("record.md")).unwrap(),
            "uncaptured later text\n"
        );
        capture_legacy_bytes(&mut store, "record.md", b"uncaptured later text\n", false);
        store = reopen_legacy(store, &root);
        assert_legacy_pending(&store, false);
        assert_eq!(
            std::fs::read_to_string(root.join("record.md")).unwrap(),
            "uncaptured later text\n"
        );
    }

    #[test]
    fn checked_delete_legacy_unsaved_live_edits_stay_pending() {
        let (root, mut store) = legacy_export_fixture(false);
        let key = DocKey::new("workspace", "main", "document").unwrap();
        let doc = store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap();
        let update = doc.plaintext_insert(0, "unsaved ");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend::default(),
            &NoFaults,
            6,
            |_tx, _outcome, _sha| Ok(()),
        )
        .unwrap();
        let store = reopen_legacy(store, &root);
        assert_legacy_pending(&store, true);
        assert_eq!(
            store
                .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
                .unwrap()
                .plaintext_string(),
            "unsaved recipient text\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("record.md")).unwrap(),
            "recipient text\n"
        );
    }

    #[test]
    fn checked_delete_legacy_committed_write_materializes_before_settlement() {
        let (root, mut store) = legacy_export_fixture(false);
        let write = versioned_text_write_on_store(
            &mut store,
            &WriteText {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                object_id: "document".into(),
                path: "record.md".into(),
                text: "committed later text\n".into(),
                moment_id: "later-write".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 6,
                request_id: None,
            },
            Some(&root),
            None,
            &NoFaults,
            &CancellationToken::new(),
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::enqueue_write(
                    tx,
                    &write,
                    Preimage::Present(hex_sha256(b"recipient text\n")),
                    "authored",
                )
            })
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("record.md")).unwrap(),
            "recipient text\n"
        );
        let mut store = reopen_legacy(store, &root);
        assert_legacy_pending(&store, false);
        assert_eq!(
            std::fs::read_to_string(root.join("record.md")).unwrap(),
            "committed later text\n"
        );
        assert_eq!(
            VersionedTextStore::new(&mut store)
                .read_text("workspace", "main", "record.md")
                .unwrap()
                .unwrap()
                .text,
            "committed later text\n"
        );
    }

    #[test]
    fn checked_delete_legacy_renamed_object_returns_to_peer() {
        let (root, mut store) = legacy_export_fixture(false);
        versioned_text_rename_on_store(
            &mut store,
            &RenameTextFile {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                from_path: "record.md".into(),
                to_path: "renamed.md".into(),
                moment_id: "later-rename".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 6,
                request_id: None,
            },
            &root,
            &(),
            &NoFaults,
            &CancellationToken::new(),
        )
        .unwrap();
        std::fs::rename(root.join("record.md"), root.join("renamed.md")).unwrap();
        let store = reopen_legacy(store, &root);
        assert_legacy_pending(&store, false);
        assert_eq!(
            std::fs::read_to_string(root.join("renamed.md")).unwrap(),
            "recipient text\n"
        );
        let aliases: Vec<String> = store.read_with(|conn| conn.prepare(
            "SELECT a.path FROM path_aliases a JOIN snapshots s USING(workspace_id,version_id,object_id) WHERE a.path=s.path"
        ).unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>()).unwrap();
        assert_eq!(aliases, vec!["renamed.md"]);
        assert_legacy_peer(&store, "renamed.md", b"recipient text\n");
    }

    fn park_unrelated_legacy_write(store: &mut EngineStore, root: &std::path::Path) -> String {
        use dohc_engine_storage::capture_file_holds::{
            CaptureFileHold, NOT_REPRESENTABLE, record_in,
        };
        std::fs::write(root.join("record.md"), b"B on disk\n").unwrap();
        let write = VersionedTextStore::new(store)
            .write_text(
                &WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "unrelated".into(),
                    path: "record.md".into(),
                    text: "B pending write\n".into(),
                    moment_id: "unrelated-write".into(),
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 6,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        let job_id = "authored-mat_unrelated-write".to_owned();
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::enqueue_write(
                    tx,
                    &write,
                    Preimage::Present(hex_sha256(b"B on disk\n")),
                    "authored",
                )?;
                record_in(
                    tx,
                    &CaptureFileHold {
                        workspace_id: "workspace".into(),
                        source_version_id: "main".into(),
                        object_id: "unrelated".into(),
                        path: "record.md".into(),
                        observed_sha256: hex_sha256(b"B on disk\n"),
                        observed_size: 10,
                        reason: NOT_REPRESENTABLE.into(),
                        observed_at_ms: 6,
                        attempt_count: 1,
                        retry_requested: false,
                    },
                )?;
                Ok::<_, RuntimeError>(())
            })
            .unwrap();
        assert_eq!(
            store
                .load_materialization_job(&job_id)
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Pending
        );
        job_id
    }

    fn assert_unrelated_legacy_write(
        store: &mut EngineStore,
        root: &std::path::Path,
        job_id: &str,
    ) {
        assert_eq!(
            store
                .load_materialization_job(job_id)
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Pending
        );
        assert_eq!(
            std::fs::read(root.join("record.md")).unwrap(),
            b"B on disk\n"
        );
        assert_eq!(
            VersionedTextStore::new(store)
                .read_text("workspace", "main", "record.md")
                .unwrap()
                .unwrap()
                .text,
            "B pending write\n"
        );
        assert!(
            store
                .read_with(|conn| dohc_engine_storage::capture_file_holds::hold_in(
                    conn,
                    "workspace",
                    "record.md"
                ))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn checked_delete_legacy_renamed_cleanup_preserves_unrelated_parked_write() {
        let (root, mut store) = legacy_export_fixture(false);
        versioned_text_rename_on_store(
            &mut store,
            &RenameTextFile {
                workspace_id: "workspace".into(),
                version_id: "main".into(),
                from_path: "record.md".into(),
                to_path: "renamed.md".into(),
                moment_id: "later-rename".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 6,
                request_id: None,
            },
            &root,
            &(),
            &NoFaults,
            &CancellationToken::new(),
        )
        .unwrap();
        std::fs::rename(root.join("record.md"), root.join("renamed.md")).unwrap();
        let job_id = park_unrelated_legacy_write(&mut store, &root);
        let mut store = reopen_legacy(store, &root);
        assert_legacy_pending(&store, false);
        assert_unrelated_legacy_write(&mut store, &root, &job_id);
        assert_eq!(
            std::fs::read(root.join("renamed.md")).unwrap(),
            b"recipient text\n"
        );
    }

    #[test]
    fn checked_delete_legacy_missing_snapshot_ignores_reused_path() {
        let (root, mut store) = legacy_export_fixture(false);
        VersionedTextStore::new(&mut store)
            .delete_text_file(
                &DeleteTextFile {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    path: "record.md".into(),
                    moment_id: "later-delete".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 5,
                },
                &NoFaults,
            )
            .unwrap();
        let job_id = park_unrelated_legacy_write(&mut store, &root);
        let mut store = reopen_legacy(store, &root);
        assert_legacy_pending(&store, false);
        assert_unrelated_legacy_write(&mut store, &root, &job_id);
        let outcome: String = store.read_with(|conn| conn.query_row("SELECT publication_outcome FROM engine_requests WHERE request_id='restore-request'", [], |row| row.get(0))).unwrap();
        assert_eq!(outcome, "applied");
    }

    #[test]
    fn checked_delete_legacy_uncapturable_preserves_blocked_write() {
        for status in ["pending", "conflict"] {
            for directory in [false, true] {
                let (root, mut store) = legacy_export_fixture(true);
                let bytes = b"\0committed later bytes";
                VersionedTextStore::new(&mut store)
                    .write_binary(
                        &WriteBinary {
                            workspace_id: "workspace".into(),
                            version_id: "main".into(),
                            object_id: "document".into(),
                            path: "record.md".into(),
                            bytes: bytes.to_vec(),
                            moment_id: "blocked-write".into(),
                            metadata_origin: "api".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 6,
                            request_id: None,
                        },
                        &NoFaults,
                    )
                    .unwrap();
                let job_id = dohc_engine_domain::binary_write_job_id("blocked-write");
                store
                    .write_with(&NoFaults, |tx| {
                        tx.execute(
                            "UPDATE materialization_jobs SET status=?1 WHERE job_id=?2",
                            params![status, job_id],
                        )
                        .map_err(StorageError::persist_public)
                    })
                    .unwrap();
                if directory {
                    std::fs::remove_file(root.join("record.md")).unwrap();
                    std::fs::create_dir(root.join("record.md")).unwrap();
                } else {
                    std::fs::write(
                        root.join("record.md"),
                        vec![0xff; dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES + 1],
                    )
                    .unwrap();
                }
                let store = reopen_legacy(store, &root);
                assert_legacy_pending(&store, true);
                assert!(matches!(
                    store
                        .load_materialization_job(&job_id)
                        .unwrap()
                        .unwrap()
                        .status,
                    JobStatus::Pending | JobStatus::Conflict
                ));
                let sha: String = store
                    .read_with(|conn| {
                        conn.query_row(
                            "SELECT binary_sha256 FROM snapshots WHERE object_id='document'",
                            [],
                            |row| row.get(0),
                        )
                    })
                    .unwrap();
                assert_eq!(sha, hex_sha256(bytes));
                assert_eq!(root.join("record.md").is_dir(), directory);
                if !directory {
                    assert_eq!(
                        std::fs::read(root.join("record.md")).unwrap(),
                        vec![0xff; dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES + 1]
                    );
                }
            }
        }
    }

    #[test]
    fn checked_delete_legacy_unchanged_large_binary_publishes() {
        let bytes = vec![0xff; dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES + 1];
        let (root, mut store, input, expected) = checked_delete_fixture_with_bytes(true, &bytes);
        crash_checked_delete(
            &root,
            &mut store,
            &input,
            &expected,
            FaultPoint::StorageAfterCommitBeforeAck,
        );
        bootstrap_checked_delete(&mut store);
        seed_legacy_checked_delete_export(&mut store);
        let store = reopen_legacy(store, &root);
        assert_legacy_pending(&store, false);
        assert!(!root.join("record.md").exists());
        let snapshots: i64 = store
            .read_with(|conn| {
                conn.query_row("SELECT count(*) FROM snapshots", [], |row| row.get(0))
            })
            .unwrap();
        assert_eq!(snapshots, 0);
    }

    #[test]
    fn checked_delete_legacy_uncapturable_targets_settle_without_capture() {
        for directory in [false, true] {
            let (root, store) = legacy_export_fixture(true);
            if directory {
                std::fs::remove_file(root.join("record.md")).unwrap();
                std::fs::create_dir(root.join("record.md")).unwrap();
            } else {
                std::fs::write(
                    root.join("record.md"),
                    vec![0xff; dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES + 1],
                )
                .unwrap();
            }
            let store = reopen_legacy(store, &root);
            assert_legacy_pending(&store, false);
            assert_eq!(root.join("record.md").is_dir(), directory);
            if !directory {
                assert_eq!(
                    std::fs::read(root.join("record.md")).unwrap(),
                    vec![0xff; dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES + 1]
                );
            }
            let snapshots: i64 = store
                .read_with(|conn| {
                    conn.query_row("SELECT count(*) FROM snapshots", [], |row| row.get(0))
                })
                .unwrap();
            assert_eq!(snapshots, 0);
        }
    }

    #[test]
    fn checked_delete_legacy_journaled_capture_before_create_keeps_one_peer_conflict() {
        for binary in [false, true] {
            let (root, mut store) = legacy_export_fixture(binary);
            let bytes = if binary {
                b"\0later bytes".as_slice()
            } else {
                b"later text\n".as_slice()
            };
            std::fs::write(root.join("record.md"), bytes).unwrap();
            capture_legacy_bytes(&mut store, "record.md", bytes, binary);
            let store = reopen_legacy(store, &root);
            assert_legacy_pending(&store, false);
            assert_legacy_peer(&store, "record.md", bytes);
        }
    }

    fn assert_legacy_peer(source: &EngineStore, path: &str, bytes: &[u8]) {
        let creation_exported: bool = source.read_with(|conn| conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.momentId')='creation')",
            [], |row| row.get(0),
        )).unwrap();
        let (_root, mut peer) = if creation_exported {
            let root = ScratchDir::new().unwrap();
            let mut peer =
                EngineStore::open(&dohc_engine_testkit::engine_db_path(&root).unwrap(), 8).unwrap();
            ensure_mutation_version_on_store(&mut peer, "workspace", "main", 8, &NoFaults).unwrap();
            (root, peer)
        } else {
            let (root, mut peer, _, _) = checked_delete_fixture(false);
            peer.write_with(&NoFaults, |tx| {
                dohc_engine_sync::retire_ydoc_lineage_in_tx(tx, "workspace", "main", "document")
            })
            .unwrap();
            (root, peer)
        };
        let blobs: Vec<String> = source
            .read_with(|conn| {
                conn.prepare("SELECT text FROM blobs")
                    .unwrap()
                    .query_map([], |r| r.get(0))
                    .unwrap()
                    .collect::<Result<_, _>>()
            })
            .unwrap();
        let binary: Vec<Vec<u8>> = source
            .read_with(|conn| {
                conn.prepare("SELECT bytes FROM binary_blobs")
                    .unwrap()
                    .query_map([], |r| r.get(0))
                    .unwrap()
                    .collect::<Result<_, _>>()
            })
            .unwrap();
        peer.write_with(&NoFaults, |tx| {
            for text in &blobs {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs(sha256,byte_length,text) VALUES(?1,?2,?3)",
                    params![hex_sha256(text.as_bytes()), text.len() as i64, text],
                )
                .map_err(StorageError::persist_public)?;
            }
            for bytes in &binary {
                dohc_engine_storage::put_binary_blob(tx, bytes)?;
            }
            Ok::<_, StorageError>(())
        })
        .unwrap();
        let origins: Vec<String> = source
            .read_with(|conn| {
                conn.prepare("SELECT DISTINCT origin_id FROM replication_log WHERE imported=0")
                    .unwrap()
                    .query_map([], |r| r.get(0))
                    .unwrap()
                    .collect::<Result<_, _>>()
            })
            .unwrap();
        let mut cache = WriterDocCache::new();
        for origin in origins {
            let ops = dohc_engine_sync::list_replication_ops(source, "workspace", &origin, -1, 500)
                .unwrap();
            let moments: Vec<_> = ops
                .iter()
                .filter(|op| op.op_kind == "moment.append")
                .collect();
            let delete = moments
                .iter()
                .position(|op| op.payload["momentId"] == "restore-delete")
                .unwrap();
            assert!(
                moments.len() > delete + 2,
                "the later mutation must already be exported before compensation"
            );
            assert_eq!(moments[delete + 1].payload["beforePresent"], "present");
            assert_eq!(moments.last().unwrap().payload["beforePresent"], "null");
            for (index, mut op) in ops.into_iter().enumerate() {
                op.relay_seq = Some(index as i64 + 1);

                let outcome = dohc_engine_sync::apply_replication_envelope(
                    &mut peer,
                    &mut cache,
                    &op,
                    &NoFaults,
                    &dohc_engine_sync::NoLiveLeases,
                )
                .unwrap_or_else(|error| panic!("{} {}: {error:?}", op.op_kind, op.payload));
                assert!(
                    matches!(
                        outcome.primary,
                        dohc_engine_sync::ApplyDisposition::Applied(_)
                    ),
                    "{}: {outcome:?}",
                    op.payload
                );
                if op.payload["momentId"] == "restore-delete" {
                    let count: i64 = peer
                        .read_with(|conn| {
                            conn.query_row(
                                "SELECT count(*) FROM snapshots WHERE object_id='document'",
                                [],
                                |row| row.get(0),
                            )
                        })
                        .unwrap();
                    assert_eq!(
                        count, 0,
                        "D must have removed the peer's file before W/R arrives"
                    );
                }
            }
        }
        let snapshots: Vec<(String, String)> = peer.read_with(|conn| conn.prepare("SELECT path,CASE content_kind WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END FROM snapshots").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>()).unwrap();
        assert_eq!(
            snapshots,
            vec![(path.into(), hex_sha256(bytes))],
            "peer must have only the intended file, with no kept copy"
        );
        let conflicts: i64 = peer
            .read_with(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM conflicts WHERE status='open'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        // W/R was already exported against the pre-delete head. Peers retain
        // that conflict when C restores the file. Exported coordinates cannot
        // be reordered by this local recovery; keep this outcome explicit.
        assert_eq!(
            conflicts, 1,
            "the already-exported mutation retains one peer conflict"
        );
    }

    #[test]
    fn checked_delete_legacy_unchanged_settles_on_open() {
        legacy_settles_on_open("unchanged");
    }

    #[test]
    fn checked_delete_legacy_changed_bytes_win_on_open() {
        legacy_settles_on_open("captured");
    }

    #[test]
    fn checked_delete_legacy_recreated_bytes_win_on_open() {
        legacy_settles_on_open("recreated");
    }

    #[test]
    fn checked_delete_legacy_unreadable_staging_waits_for_next_open() {
        legacy_settles_on_open("blocked");
    }

    #[test]
    fn checked_delete_legacy_changed_settlement_is_atomic_across_crashes() {
        for binary in [false, true] {
            for point in [
                FaultPoint::StorageBeforePersist,
                FaultPoint::StorageAfterCommitBeforeAck,
            ] {
                let (root, mut store, input, expected) = checked_delete_fixture(binary);
                crash_checked_delete(
                    &root,
                    &mut store,
                    &input,
                    &expected,
                    FaultPoint::StorageAfterCommitBeforeAck,
                );
                bootstrap_checked_delete(&mut store);
                seed_legacy_checked_delete_export(&mut store);
                let bytes = if binary {
                    b"\0\xfflater bytes".as_slice()
                } else {
                    b"later text\n".as_slice()
                };
                std::fs::write(root.join("record.md"), bytes).unwrap();
                capture_legacy_bytes(&mut store, "record.md", bytes, binary);
                let faults = dohc_engine_testkit::ScriptedFaults::crash_at(point);
                let result = publish_checked_delete_on_store(
                    &mut store,
                    &root,
                    "workspace",
                    "restore-delete-mat_restore-delete",
                    &(),
                    6,
                    faults.as_ref(),
                    true,
                    false,
                    None,
                );
                assert!(
                    matches!(result, Err(RuntimeError::OperationCrashed)),
                    "{result:?}"
                );
                assert_eq!(std::fs::read(root.join("record.md")).unwrap(), bytes);
                let pending = store
                    .load_materialization_job("restore-delete-mat_restore-delete")
                    .unwrap()
                    .is_some();
                assert_eq!(pending, point == FaultPoint::StorageBeforePersist);
                let sha: String = store.read_with(|conn| conn.query_row("SELECT CASE content_kind WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END FROM snapshots WHERE workspace_id='workspace' AND path='record.md'", [], |r| r.get(0))).unwrap();
                assert_eq!(sha, hex_sha256(bytes));
                let journal_count = |store: &EngineStore| {
                    store.read_with(|conn| conn.query_row("SELECT count(*) FROM replication_log WHERE imported=0 AND op_kind='moment.append' AND json_extract(payload_json,'$.payloadAfterPath')='record.md'", [], |r| r.get::<_, i64>(0))).unwrap()
                };
                let before = journal_count(&store);
                drop(store);
                let mut store =
                    EngineStore::open(&dohc_engine_testkit::engine_db_path(&root).unwrap(), 7)
                        .unwrap();
                checked_delete_replay(&mut store, &root);
                checked_delete_replay(&mut store, &root);
                assert!(
                    store
                        .load_materialization_job("restore-delete-mat_restore-delete")
                        .unwrap()
                        .is_none()
                );
                assert_eq!(checked_delete_exports(&store), 1);
                assert_eq!(journal_count(&store), before + i64::from(pending));
                assert_eq!(std::fs::read(root.join("record.md")).unwrap(), bytes);
            }
        }
    }

    fn legacy_settles_on_open(scenario: &str) {
        for binary in [false, true] {
            let (root, mut store, input, expected) = checked_delete_fixture(binary);
            crash_checked_delete(
                &root,
                &mut store,
                &input,
                &expected,
                FaultPoint::StorageAfterCommitBeforeAck,
            );
            bootstrap_checked_delete(&mut store);
            seed_legacy_checked_delete_export(&mut store);
            let original = std::fs::read(root.join("record.md")).unwrap();
            let changed = if binary {
                b"\0\xfflater binary bytes".to_vec()
            } else {
                b"later text bytes\n".to_vec()
            };
            if scenario == "recreated" {
                let job = store
                    .load_materialization_job("restore-delete-mat_restore-delete")
                    .unwrap()
                    .unwrap();
                dohc_engine_files::materialize::materialize_one_ordinary(
                    &store,
                    &root,
                    &job,
                    &dohc_engine_files::MaterializeOptions {
                        holds: None,
                        policy: dohc_engine_files::DurabilityPolicy::per_os(),
                        replacer: &dohc_engine_files::StdReplacer,
                        backoff: &dohc_engine_files::StdBackoff,
                        now_ms: 6,
                        faults: &NoFaults,
                    },
                )
                .unwrap();
                assert!(!root.join("record.md").exists());
                // Even identical bytes recreated after the completed receipt are later work.
                std::fs::write(root.join("record.md"), &original).unwrap();
            } else if scenario == "captured" {
                std::fs::write(root.join("record.md"), &changed).unwrap();
                capture_legacy_bytes(&mut store, "record.md", &changed, binary);
            }
            if scenario == "blocked" {
                std::fs::write(root.join(".dohc/engine/displaced"), b"unreadable staging").unwrap();
            }
            drop(store);
            let mut store =
                EngineStore::open(&dohc_engine_testkit::engine_db_path(&root).unwrap(), 7).unwrap();
            checked_delete_replay(&mut store, &root);
            if scenario == "blocked" {
                assert!(
                    store
                        .load_materialization_job("restore-delete-mat_restore-delete")
                        .unwrap()
                        .is_some()
                );
                assert_eq!(std::fs::read(root.join("record.md")).unwrap(), original);
                assert_eq!(checked_delete_exports(&store), 1);
                std::fs::remove_file(root.join(".dohc/engine/displaced")).unwrap();
                drop(store);
                store = EngineStore::open(&dohc_engine_testkit::engine_db_path(&root).unwrap(), 8)
                    .unwrap();
                checked_delete_replay(&mut store, &root);
            }
            assert!(
                store
                    .load_materialization_job("restore-delete-mat_restore-delete")
                    .unwrap()
                    .is_none(),
                "{scenario}: must settle on open"
            );
            assert_eq!(checked_delete_count(&store), 1, "D remains applied history");
            assert_eq!(
                checked_delete_exports(&store),
                1,
                "D must not be exported again"
            );
            let keep = matches!(scenario, "captured" | "recreated");
            assert_eq!(root.join("record.md").exists(), keep, "{scenario}");
            if keep {
                let bytes = if scenario == "recreated" {
                    &original
                } else {
                    &changed
                };
                assert_eq!(&std::fs::read(root.join("record.md")).unwrap(), bytes);
                let sha = hex_sha256(bytes);
                let snapshot: String = store.read_with(|conn| conn.query_row("SELECT CASE content_kind WHEN 'binary' THEN binary_sha256 ELSE blob_sha256 END FROM snapshots WHERE workspace_id='workspace' AND path='record.md'", [], |r| r.get(0))).unwrap();
                assert_eq!(snapshot, sha);
                let count_restore = |store: &EngineStore| {
                    store.read_with(|conn| conn.query_row("SELECT count(*) FROM replication_log WHERE workspace_id='workspace' AND imported=0 AND op_kind='moment.append' AND json_extract(payload_json,'$.beforePresent')='null' AND json_extract(payload_json,'$.momentId')!='creation' AND json_extract(payload_json,'$.payloadAfterPath')='record.md' AND COALESCE(json_extract(payload_json,'$.payloadAfterBinarySha256'),json_extract(payload_json,'$.payloadAfterBlobSha256'))=?1", [&sha], |r| r.get::<_,i64>(0))).unwrap()
                };
                assert_eq!(
                    count_restore(&store),
                    1,
                    "current bytes must reach peers once"
                );
                checked_delete_replay(&mut store, &root);
                bootstrap_checked_delete(&mut store);
                assert_eq!(count_restore(&store), 1, "recovery is idempotent");
                assert_eq!(&std::fs::read(root.join("record.md")).unwrap(), bytes);
            }
        }
    }

    fn seed_legacy_checked_delete_export(store: &mut EngineStore) {
        // Model an older build exporting the moment without its pending marker.
        store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE materialization_jobs SET job_id='legacy-delete' WHERE job_id='restore-delete-mat_restore-delete'", []).unwrap();
            dohc_engine_sync::journal_moment_append_in_tx(tx, "workspace", "restore-delete")?;
            tx.execute("UPDATE materialization_jobs SET job_id='restore-delete-mat_restore-delete' WHERE job_id='legacy-delete'", []).unwrap();
            Ok::<_, dohc_engine_sync::SyncError>(())
        }).unwrap();
    }

    #[test]
    fn checked_delete_discard_refuses_a_moment_pinned_by_a_pending_shadow() {
        let (root, mut store, input, expected) = checked_delete_fixture(true);
        crash_checked_delete(
            &root,
            &mut store,
            &input,
            &expected,
            FaultPoint::StorageAfterCommitBeforeAck,
        );
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO replication_pending_conflict_bundles(workspace_id,conflict_id,format_version,pre_effect_moment_order,created_at_ms) VALUES ('workspace','pin',1,0,4)", []).unwrap();
            let bundle = tx.last_insert_rowid();
            tx.execute("INSERT INTO replication_pending_conflict_ops VALUES (?1,1,'moment.append','{}',4)", [bundle]).unwrap();
            tx.execute("INSERT INTO replication_pending_conflict_moments VALUES ('workspace',?1,1,'restore-delete')", [bundle]).unwrap();
            Ok::<_, RuntimeError>(())
        }).unwrap();
        assert_checked_delete_discard_retains_referenced_moment(&mut store);
    }

    fn assert_checked_delete_discard_retains_referenced_moment(store: &mut EngineStore) {
        let before = checked_delete_state(store);
        let result = store.write_with(&NoFaults, |tx| {
            settle_checked_delete_in_tx(tx, "workspace", "restore-delete", false, true)
        });
        assert!(
            matches!(
                result,
                Err(RuntimeError::Domain(
                    DomainError::CheckedDeleteReplicationDependents
                ))
            ),
            "{result:?}"
        );
        assert_eq!(
            checked_delete_state(store),
            before,
            "refusal preserves the moment, journal, request, and pending disk intent"
        );
        assert!(store.read_with(|conn| conn.query_row("SELECT EXISTS(SELECT 1 FROM moments WHERE workspace_id='workspace' AND moment_id='restore-delete')", [], |r| r.get::<_, bool>(0))).unwrap());
    }

    fn checked_delete_state(store: &EngineStore) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
        store
            .read_with(|conn| {
                [
                    "moments",
                    "replication_log",
                    "replication_pending_conflict_bundles",
                    "replication_pending_conflict_ops",
                    "replication_pending_conflict_moments",
                    "snapshots",
                    "path_aliases",
                    "ydoc_docs",
                    "ydoc_updates",
                    "collection_field_history",
                    "automation_claims",
                    "materialization_jobs",
                    "engine_requests",
                    "engine_search_files_fts",
                ]
                .into_iter()
                .map(|table| {
                    let mut statement =
                        conn.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
                    let columns = statement.column_count();
                    statement
                        .query_map([], |row| {
                            (0..columns)
                                .map(|i| row.get(i))
                                .collect::<Result<Vec<rusqlite::types::Value>, _>>()
                        })?
                        .collect::<Result<Vec<_>, _>>()
                })
                .collect::<Result<Vec<_>, _>>()
            })
            .unwrap()
    }

    fn assert_checked_delete_absent(store: &EngineStore) {
        let counts: (i64, i64, i64) = store.read_with(|conn| conn.query_row("SELECT (SELECT count(*) FROM moments WHERE operation='delete'), (SELECT count(*) FROM materialization_jobs WHERE job_id LIKE '%restore-delete%'), (SELECT count(*) FROM engine_requests WHERE request_id='restore-request')", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
        assert_eq!(counts, (0, 0, 0));
    }

    #[test]
    fn conditional_restore_delete_publication_refusal_leaves_no_effects_text_and_binary() {
        struct LateChange(PathBuf, bool);
        impl SelfWriteRecorder for LateChange {
            fn record(&self, _: &str, _: &str, _: &str) {
                if self.1 {
                    std::fs::remove_file(&self.0).unwrap();
                    std::fs::create_dir(&self.0).unwrap();
                } else {
                    std::fs::write(&self.0, "Owner text KEEP").unwrap();
                }
            }
            fn retract(&self, _: &str, _: &str, _: &str) {}
        }
        for binary in [false, true] {
            for directory in [false, true] {
                let (root, mut store, input, expected) = checked_delete_fixture(binary);
                let before = checked_delete_state(&store);
                assert!(
                    checked_delete_on_store(
                        &mut store,
                        &input,
                        Some("document"),
                        &expected,
                        &root,
                        &LateChange(root.join("record.md"), directory),
                        &NoFaults
                    )
                    .is_err()
                );
                assert_eq!(checked_delete_state(&store), before);
                assert_checked_delete_absent(&store);
                assert!(root.join("record.md").exists());
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn conditional_restore_delete_sharing_failure_leaves_no_effects_text_and_binary() {
        use std::os::windows::fs::OpenOptionsExt;
        for binary in [false, true] {
            for sharing in [1, 1 | 2 | 4] {
                let (root, mut store, input, expected) = checked_delete_fixture(binary);
                let before = checked_delete_state(&store);
                let _locked = std::fs::OpenOptions::new()
                    .read(true)
                    .write(sharing != 1)
                    .share_mode(sharing)
                    .open(root.join("record.md"))
                    .unwrap();
                let result = checked_delete_on_store(
                    &mut store,
                    &input,
                    Some("document"),
                    &expected,
                    &root,
                    &(),
                    &NoFaults,
                );
                assert!(
                    matches!(result, Err(RuntimeError::Materialize(_))),
                    "{result:?}"
                );
                assert_eq!(checked_delete_state(&store), before);
                assert_checked_delete_absent(&store);
                assert_eq!(
                    hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
                    expected
                );
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn conditional_restore_delete_blocked_recovery_keeps_staged_moment() {
        use std::os::windows::fs::OpenOptionsExt;
        for binary in [false, true] {
            let (root, mut store, input, expected) = checked_delete_fixture(binary);
            let crash = dohc_engine_testkit::ScriptedFaults::crash_at(
                FaultPoint::MaterializeAfterRenameBeforeComplete,
            );
            assert!(matches!(
                checked_delete_on_store(
                    &mut store,
                    &input,
                    Some("document"),
                    &expected,
                    &root,
                    &(),
                    crash.as_ref()
                ),
                Err(RuntimeError::OperationCrashed)
            ));
            let staging = root.join(".dohc/engine/displaced");
            let staged = std::fs::read_dir(&staging)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            let locked = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .custom_flags(0x02000000)
                .open(&staging)
                .unwrap();
            assert!(std::fs::read_dir(&staging).is_err());
            drop(store);
            let mut store =
                EngineStore::open(&dohc_engine_testkit::engine_db_path(&root).unwrap(), 4).unwrap();
            for _ in 0..2 {
                super::super::materialization::replay_pending_materializations(
                    &mut store,
                    &root,
                    super::super::materialization::MaterializationReplayScope {
                        holds: None,
                        workspace_id: "workspace",
                        self_writes: None,
                        progress: None,
                        file_outcomes_settled: false,
                        released_hold_paths: None,
                        planned_against_active_heads: false,
                    },
                    4,
                    &NoFaults,
                    None,
                    false,
                )
                .unwrap();
                assert!(dohc_engine_files::workspace_recovery_unavailable(&root));
                assert_eq!(
                    store
                        .load_materialization_job("restore-delete-mat_restore-delete")
                        .unwrap()
                        .expect("blocked recovery must retain the job")
                        .status,
                    JobStatus::Pending
                );
                let moments: i64 = store
                    .read_with(|c| {
                        c.query_row(
                            "SELECT count(*) FROM moments WHERE moment_id='restore-delete'",
                            [],
                            |r| r.get(0),
                        )
                    })
                    .unwrap();
                assert_eq!(moments, 1, "blocked recovery must retain the staged moment");
            }
            drop(locked);
            assert_eq!(hex_sha256(&std::fs::read(&staged).unwrap()), expected);
            super::super::materialization::replay_pending_materializations(
                &mut store,
                &root,
                super::super::materialization::MaterializationReplayScope {
                    holds: None,
                    workspace_id: "workspace",
                    self_writes: None,
                    progress: None,
                    file_outcomes_settled: false,
                    released_hold_paths: None,
                    planned_against_active_heads: false,
                },
                5,
                &NoFaults,
                None,
                false,
            )
            .unwrap();
            assert!(!dohc_engine_files::workspace_recovery_unavailable(&root));
            assert!(!root.join("record.md").exists());
            assert!(!staged.exists());
            assert!(
                store
                    .load_materialization_job("restore-delete-mat_restore-delete")
                    .unwrap()
                    .is_none()
            );
            let deletes: i64 = store
                .read_with(|c| {
                    c.query_row(
                        "SELECT count(*) FROM moments WHERE operation='delete'",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            assert_eq!(deletes, 1);
        }
    }

    fn crash_checked_delete(
        root: &std::path::Path,
        store: &mut EngineStore,
        input: &DeleteTextFile,
        expected: &str,
        point: FaultPoint,
    ) {
        let crash = dohc_engine_testkit::ScriptedFaults::crash_at(point);
        assert!(matches!(
            checked_delete_on_store(
                store,
                input,
                Some("document"),
                expected,
                root,
                &(),
                crash.as_ref()
            ),
            Err(RuntimeError::OperationCrashed)
        ));
    }

    fn complete_checked_delete_materialization(store: &EngineStore, root: &std::path::Path) {
        let job = store
            .load_materialization_job("restore-delete-mat_restore-delete")
            .unwrap()
            .unwrap();
        assert_eq!(
            dohc_engine_files::materialize::materialize_one_ordinary(
                store,
                root,
                &job,
                &dohc_engine_files::MaterializeOptions {
                    holds: None,
                    policy: dohc_engine_files::DurabilityPolicy::per_os(),
                    replacer: &dohc_engine_files::StdReplacer,
                    backoff: &dohc_engine_files::NoBackoff,
                    now_ms: 4,
                    faults: &NoFaults,
                },
            )
            .unwrap(),
            dohc_engine_files::JobOutcome::AlreadyMaterialized
        );
        assert_eq!(
            store
                .load_materialization_job(&job.job_id)
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Complete
        );
        assert!(!root.join("record.md").exists());
    }

    fn checked_delete_replay(store: &mut EngineStore, root: &std::path::Path) {
        super::super::materialization::replay_pending_materializations(
            store,
            root,
            super::super::materialization::MaterializationReplayScope {
                holds: None,
                workspace_id: "workspace",
                self_writes: None,
                progress: None,
                file_outcomes_settled: false,
                released_hold_paths: None,
                planned_against_active_heads: false,
            },
            5,
            &NoFaults,
            None,
            false,
        )
        .unwrap();
    }

    fn create_checked_delete_version(store: &mut EngineStore) {
        let mut versioned = VersionedTextStore::new(store);
        versioned
            .create_named_version(
                &dohc_engine_domain::CreateNamedVersion {
                    workspace_id: "workspace".into(),
                    new_version_id: "other".into(),
                    name: "Other".into(),
                    from_version_id: "main".into(),
                    now_ms: 4,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }

    fn change_checked_delete_content(
        store: &mut EngineStore,
        root: &std::path::Path,
        binary: bool,
    ) {
        if binary {
            versioned_binary_write_on_store(
                store,
                &WriteBinary {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "document".into(),
                    path: "record.md".into(),
                    bytes: b"Owner bytes KEEP".to_vec(),
                    moment_id: "owner-edit".into(),
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4,
                    request_id: None,
                },
                root,
                &(),
                &NoFaults,
                &CancellationToken::new(),
            )
            .unwrap();
        } else {
            versioned_text_write_with_publication_on_store(
                store,
                &WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "document".into(),
                    path: "record.md".into(),
                    text: "Owner bytes KEEP".into(),
                    moment_id: "owner-edit".into(),
                    metadata_origin: "user".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4,
                    request_id: None,
                },
                Some(root),
                None,
                Some(&WriteConditions::default()),
                None,
                &NoFaults,
                &CancellationToken::new(),
            )
            .unwrap();
        }
    }

    fn assert_checked_delete_capture_keeps_file(store: &mut EngineStore, root: &std::path::Path) {
        let absent =
            super::super::capture::confirm_absent_on_disk(store, root, "workspace", "record.md", 6);
        if absent.is_ok() {
            let version = VersionedTextStore::new(store)
                .get_active_version("workspace")
                .unwrap();
            VersionedTextStore::new(store)
                .capture_retire(
                    &dohc_engine_domain::CaptureRetire {
                        workspace_id: "workspace".into(),
                        version_id: version.version_id,
                        path: "record.md".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        now_ms: 6,
                        request_id: None,
                        only_if_text_head: false,
                        only_if_capture_origin: false,
                        allow_ydoc_origin: true,
                    },
                    &NoFaults,
                )
                .unwrap();
        }
        assert_eq!(
            checked_delete_count(store),
            0,
            "capture must not record an unintended delete"
        );
        assert!(matches!(
            absent,
            Err(RuntimeError::Sync(
                dohc_engine_sync::SyncError::RetryableState {
                    reason: "path-present-on-disk"
                }
            ))
        ));
    }

    fn checked_delete_count(store: &EngineStore) -> i64 {
        store
            .read_with(|c| {
                c.query_row(
                    "SELECT count(*) FROM moments WHERE operation='delete'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap()
    }

    #[test]
    fn conditional_restore_delete_complete_recheck_error_keeps_receipt() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        for binary in [false, true] {
            for failure in ["commit", "finish"] {
                let (root, mut store, input, expected) = checked_delete_fixture(binary);
                crash_checked_delete(
                    &root,
                    &mut store,
                    &input,
                    &expected,
                    FaultPoint::MaterializeAfterKnownCopyDeletion,
                );
                complete_checked_delete_materialization(&store, &root);
                if failure == "commit" {
                    let armed = Arc::new(AtomicBool::new(true));
                    store
                        .read_with(|conn| {
                            conn.commit_hook(Some(move || armed.swap(false, Ordering::SeqCst)))
                                .unwrap();
                            Ok::<_, StorageError>(())
                        })
                        .unwrap();
                } else {
                    store.read_with(|conn| conn.execute_batch("CREATE TRIGGER fail_finish_check BEFORE DELETE ON snapshots BEGIN SELECT RAISE(FAIL, 'transient finish failure'); END")).unwrap();
                }
                let error = publish_checked_delete_on_store(
                    &mut store,
                    &root,
                    "workspace",
                    "restore-delete-mat_restore-delete",
                    &(),
                    4,
                    &NoFaults,
                    true,
                    false,
                    None,
                )
                .unwrap_err();
                if failure == "commit" {
                    assert!(matches!(error, RuntimeError::Storage(_)), "{error:?}");
                }
                assert_eq!(
                    store
                        .load_materialization_job("restore-delete-mat_restore-delete")
                        .unwrap()
                        .expect("failed recheck must retain receipt")
                        .status,
                    JobStatus::Complete
                );
                assert_eq!(checked_delete_count(&store), 1);
                store
                    .read_with(|conn| {
                        conn.commit_hook(None::<fn() -> bool>).unwrap();
                        conn.execute_batch("DROP TRIGGER IF EXISTS fail_finish_check")
                    })
                    .unwrap();
                checked_delete_replay(&mut store, &root);
                checked_delete_replay(&mut store, &root);
                assert_eq!(checked_delete_count(&store), 1);
                assert!(
                    store
                        .load_materialization_job("restore-delete-mat_restore-delete")
                        .unwrap()
                        .is_none()
                );
                assert!(
                    VersionedTextStore::new(&mut store)
                        .read_text("workspace", "main", "record.md")
                        .unwrap()
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn conditional_restore_delete_complete_version_switch_discards_publication() {
        checked_delete_version_switch_discards_publication(true);
    }

    #[cfg(unix)]
    #[test]
    fn conditional_restore_delete_pending_retained_version_switch_discards_publication() {
        checked_delete_version_switch_discards_publication(false);
    }

    #[cfg(unix)]
    fn assert_pending_retained_checked_delete(store: &EngineStore, root: &std::path::Path) {
        assert_eq!(
            store
                .load_materialization_job("restore-delete-mat_restore-delete")
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Pending
        );
        let rows = store.retained_displacements_after(0).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(root.join(&rows[0].source_path).is_file());
        assert!(!root.join("record.md").exists());
    }

    #[cfg(unix)]
    fn assert_retained_checked_delete_source(
        store: &EngineStore,
        root: &std::path::Path,
        row: &dohc_engine_storage::RetainedDisplacement,
    ) {
        use std::os::unix::fs::MetadataExt;
        // Membership in this table is the retained state; neither replay ends it.
        assert_eq!(
            store.retained_displacements_after(0).unwrap(),
            vec![row.clone()]
        );
        assert!(
            store
                .list_kept_displacements("workspace")
                .unwrap()
                .is_empty()
        );
        let staged = root.join(&row.source_path);
        let metadata = std::fs::metadata(&staged).unwrap();
        assert!(metadata.is_file());
        assert_eq!(metadata.dev().to_string(), row.device);
        assert_eq!(metadata.ino().to_string(), row.inode);
        assert_eq!(hex_sha256(&std::fs::read(staged).unwrap()), row.digest);
    }

    #[cfg(unix)]
    fn checked_delete_projection_identity(
        root: &std::path::Path,
        row: &dohc_engine_storage::RetainedDisplacement,
    ) -> (u64, u64) {
        use std::os::unix::fs::MetadataExt;
        let target = std::fs::metadata(root.join("record.md")).unwrap();
        let identity = (target.dev(), target.ino());
        assert_ne!(
            (identity.0.to_string(), identity.1.to_string()),
            (row.device.clone(), row.inode.clone()),
            "the retained original must not become the replacement projection"
        );
        identity
    }

    fn checked_delete_version_switch_discards_publication(complete: bool) {
        for binary in [false, true] {
            let (root, mut store, input, expected) = checked_delete_fixture(binary);
            crash_checked_delete(
                &root,
                &mut store,
                &input,
                &expected,
                FaultPoint::MaterializeAfterKnownCopyDeletion,
            );
            if complete {
                complete_checked_delete_materialization(&store, &root);
            } else {
                #[cfg(unix)]
                assert_pending_retained_checked_delete(&store, &root);
            }
            #[cfg(unix)]
            let retained =
                (!complete).then(|| store.retained_displacements_after(0).unwrap().remove(0));
            create_checked_delete_version(&mut store);
            let switched = super::super::versions::switch_active_version_on_store(
                &mut store,
                "workspace",
                "other",
                &root,
                &(),
                4,
                &NoFaults,
                &tokio_util::sync::CancellationToken::new(),
            )
            .unwrap();
            assert_eq!(switched.version_id, "other");
            assert_checked_delete_absent(&store);
            let snapshots: i64 = store
                .read_with(|c| {
                    c.query_row(
                        "SELECT count(*) FROM snapshots WHERE object_id='document'",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            assert_eq!(snapshots, 2);
            checked_delete_replay(&mut store, &root);
            assert_eq!(
                hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
                expected
            );
            assert_eq!(checked_delete_count(&store), 0);
            #[cfg(unix)]
            if let Some(row) = retained {
                assert_retained_checked_delete_source(&store, &root, &row);
                let identity = checked_delete_projection_identity(&root, &row);
                checked_delete_replay(&mut store, &root);
                assert_retained_checked_delete_source(&store, &root, &row);
                assert_eq!(checked_delete_projection_identity(&root, &row), identity);
                assert_eq!(
                    hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
                    expected
                );
                assert_eq!(checked_delete_count(&store), 0);
            }
        }
    }

    #[test]
    fn conditional_restore_delete_pending_discard_restores_current_snapshot_before_capture() {
        checked_delete_discard_restores_current_snapshot(
            FaultPoint::MaterializeAfterRenameBeforeComplete,
            false,
        );
    }

    #[cfg(unix)]
    #[test]
    fn conditional_restore_delete_pending_retained_discard_restores_snapshot() {
        checked_delete_discard_restores_current_snapshot(
            FaultPoint::MaterializeAfterKnownCopyDeletion,
            false,
        );
    }

    #[test]
    fn conditional_restore_delete_complete_discard_restores_current_snapshot_before_capture() {
        checked_delete_discard_restores_current_snapshot(
            FaultPoint::MaterializeAfterKnownCopyDeletion,
            true,
        );
    }

    fn checked_delete_discard_restores_current_snapshot(point: FaultPoint, complete: bool) {
        #[derive(Default)]
        struct RecordedWrites(std::sync::Mutex<Vec<String>>);
        impl SelfWriteRecorder for RecordedWrites {
            fn record(&self, _: &str, _: &str, sha: &str) {
                self.0.lock().unwrap().push(sha.into());
            }
            fn retract(&self, _: &str, _: &str, sha: &str) {
                self.0.lock().unwrap().retain(|entry| entry != sha);
            }
        }
        for binary in [false, true] {
            for crash_finish in [false, true] {
                let (root, mut store, input, expected) = checked_delete_fixture(binary);
                crash_checked_delete(&root, &mut store, &input, &expected, point);
                if complete {
                    complete_checked_delete_materialization(&store, &root);
                } else if point == FaultPoint::MaterializeAfterKnownCopyDeletion {
                    #[cfg(unix)]
                    assert_pending_retained_checked_delete(&store, &root);
                }
                #[cfg(unix)]
                let retained = (!complete
                    && point == FaultPoint::MaterializeAfterKnownCopyDeletion)
                    .then(|| store.retained_displacements_after(0).unwrap().remove(0));
                change_checked_delete_content(&mut store, &root, binary);
                dohc_engine_files::recover_displacements(
                    &store,
                    &root,
                    Some("workspace"),
                    &dohc_engine_files::MaterializeOptions {
                        holds: None,
                        policy: dohc_engine_files::DurabilityPolicy::per_os(),
                        replacer: &dohc_engine_files::StdReplacer,
                        backoff: &dohc_engine_files::NoBackoff,
                        now_ms: 5,
                        faults: &NoFaults,
                    },
                )
                .unwrap();
                let writes = RecordedWrites::default();
                let crash = dohc_engine_testkit::ScriptedFaults::crash_at(
                    FaultPoint::StorageAfterCommitBeforeAck,
                );
                let faults: &dyn FaultInjector = if crash_finish {
                    crash.as_ref()
                } else {
                    &NoFaults
                };
                let result = publish_checked_delete_on_store(
                    &mut store,
                    &root,
                    "workspace",
                    "restore-delete-mat_restore-delete",
                    &writes,
                    5,
                    faults,
                    true,
                    false,
                    None,
                );
                if crash_finish {
                    assert!(
                        matches!(result, Err(RuntimeError::OperationCrashed)),
                        "{result:?}"
                    );
                    let repair = store
                        .list_pending_materialization_jobs()
                        .unwrap()
                        .into_iter()
                        .find(|job| job.job_id.starts_with("version-switch-mat_"))
                        .expect("discard must commit a replacement write");
                    assert_eq!(repair.preimage, Preimage::Absent);
                    assert_eq!(repair.content_sha256, hex_sha256(b"Owner bytes KEEP"));
                } else {
                    assert!(result.is_err());
                    assert_eq!(
                        std::fs::read(root.join("record.md")).unwrap(),
                        b"Owner bytes KEEP"
                    );
                }
                super::super::materialization::replay_pending_materializations(
                    &mut store,
                    &root,
                    super::super::materialization::MaterializationReplayScope {
                        holds: None,
                        workspace_id: "workspace",
                        self_writes: Some(&writes),
                        progress: None,
                        file_outcomes_settled: false,
                        released_hold_paths: None,
                        planned_against_active_heads: false,
                    },
                    6,
                    &NoFaults,
                    None,
                    false,
                )
                .unwrap();
                assert_eq!(
                    std::fs::read(root.join("record.md")).unwrap(),
                    b"Owner bytes KEEP"
                );
                assert_checked_delete_capture_keeps_file(&mut store, &root);
                assert!(
                    store
                        .list_kept_displacements("workspace")
                        .unwrap()
                        .is_empty()
                );
                assert!(
                    writes
                        .0
                        .lock()
                        .unwrap()
                        .contains(&hex_sha256(b"Owner bytes KEEP"))
                );
                #[cfg(unix)]
                if let Some(row) = retained {
                    assert_retained_checked_delete_source(&store, &root, &row);
                    let identity = checked_delete_projection_identity(&root, &row);
                    checked_delete_replay(&mut store, &root);
                    assert_retained_checked_delete_source(&store, &root, &row);
                    assert_eq!(checked_delete_projection_identity(&root, &row), identity);
                    assert_eq!(
                        std::fs::read(root.join("record.md")).unwrap(),
                        b"Owner bytes KEEP"
                    );
                    assert_checked_delete_capture_keeps_file(&mut store, &root);
                }
            }
        }
    }

    #[test]
    fn conditional_restore_delete_unreadable_staging_defers_before_checks_portably() {
        for binary in [false, true] {
            for change in ["content", "version", "unchanged"] {
                for request_retry in [false, true] {
                    let (root, mut store, input, expected) = checked_delete_fixture(binary);
                    crash_checked_delete(
                        &root,
                        &mut store,
                        &input,
                        &expected,
                        FaultPoint::MaterializeAfterRenameBeforeComplete,
                    );
                    let staging = root.join(".dohc/engine/displaced");
                    let held = root.join(".dohc/engine/held-displaced");
                    std::fs::rename(&staging, &held).unwrap();
                    std::fs::write(&staging, b"staging is unavailable").unwrap();
                    checked_delete_replay(&mut store, &root);
                    assert!(dohc_engine_files::workspace_recovery_unavailable(&root));
                    if change == "content" {
                        change_checked_delete_content(&mut store, &root, binary);
                    } else if change == "version" {
                        create_checked_delete_version(&mut store);
                        let switched = super::super::versions::switch_active_version_on_store(
                            &mut store,
                            "workspace",
                            "other",
                            &root,
                            &(),
                            4,
                            &NoFaults,
                            &CancellationToken::new(),
                        )
                        .unwrap();
                        assert_eq!(switched.version_id, "other");
                        assert_eq!(
                            hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
                            expected
                        );
                    }
                    for _ in 0..2 {
                        let result = if request_retry {
                            checked_delete_on_store(
                                &mut store,
                                &input,
                                Some("document"),
                                &expected,
                                &root,
                                &(),
                                &NoFaults,
                            )
                            .map(|_| ())
                        } else {
                            publish_checked_delete_on_store(
                                &mut store,
                                &root,
                                "workspace",
                                "restore-delete-mat_restore-delete",
                                &(),
                                4,
                                &NoFaults,
                                true,
                                false,
                                None,
                            )
                        };
                        assert!(
                            matches!(
                                result,
                                Err(RuntimeError::Materialize(
                                    dohc_engine_files::MaterializeError::RecoveryUnavailable
                                ))
                            ),
                            "{result:?}"
                        );
                        assert_eq!(
                            store
                                .load_materialization_job("restore-delete-mat_restore-delete")
                                .unwrap()
                                .expect("unreadable staging must keep job")
                                .status,
                            JobStatus::Pending
                        );
                        assert_eq!(checked_delete_count(&store), 1);
                    }
                    let staged = std::fs::read_dir(&held)
                        .unwrap()
                        .next()
                        .unwrap()
                        .unwrap()
                        .path();
                    assert_eq!(hex_sha256(&std::fs::read(&staged).unwrap()), expected);
                    std::fs::remove_file(&staging).unwrap();
                    std::fs::rename(&held, &staging).unwrap();
                    checked_delete_replay(&mut store, &root);
                    checked_delete_replay(&mut store, &root);
                    assert_eq!(
                        checked_delete_count(&store),
                        i64::from(change == "unchanged")
                    );
                    assert!(
                        store
                            .load_materialization_job("restore-delete-mat_restore-delete")
                            .unwrap()
                            .is_none()
                    );
                    assert!(store.list_unsettled_displacements().unwrap().is_empty());
                    assert!(
                        store
                            .list_kept_displacements("workspace")
                            .unwrap()
                            .is_empty()
                    );
                    assert_only_retained_staged_originals(&store, &root);
                    assert!(!dohc_engine_files::workspace_recovery_unavailable(&root));
                    if change == "unchanged" {
                        assert!(!root.join("record.md").exists());
                    } else {
                        assert_checked_delete_capture_keeps_file(&mut store, &root);
                        let version = if change == "version" { "other" } else { "main" };
                        let snapshot = VersionedTextStore::new(&mut store)
                            .list_snapshot_metadata("workspace", version, None, 10)
                            .unwrap()
                            .into_iter()
                            .find(|snapshot| snapshot.path == "record.md")
                            .expect("refused deletion keeps the current snapshot");
                        let hash = if change == "content" {
                            hex_sha256(b"Owner bytes KEEP")
                        } else {
                            expected.clone()
                        };
                        assert_eq!(snapshot.sha256, hash);
                        assert_eq!(
                            hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
                            hash
                        );
                        let versioned = VersionedTextStore::new(&mut store);
                        let preserved = if binary {
                            versioned
                                .read_binary_blob("workspace", &expected)
                                .unwrap()
                                .and_then(|blob| blob.bytes)
                        } else {
                            versioned
                                .read_text_blob("workspace", &expected)
                                .unwrap()
                                .and_then(|blob| blob.text.map(String::into_bytes))
                        };
                        assert_eq!(hex_sha256(&preserved.unwrap()), expected);
                    }
                }
            }
        }
    }

    #[test]
    fn conditional_restore_delete_fresh_unreadable_staging_discards_without_touching_file() {
        let (root, mut store, input, expected) = checked_delete_fixture(false);
        let before = checked_delete_state(&store);
        std::fs::write(root.join(".dohc/engine/displaced"), b"unreadable staging").unwrap();
        checked_delete_replay(&mut store, &root);
        assert!(dohc_engine_files::workspace_recovery_unavailable(&root));
        let error = checked_delete_on_store(
            &mut store,
            &input,
            Some("document"),
            &expected,
            &root,
            &(),
            &NoFaults,
        )
        .unwrap_err();
        assert!(
            matches!(
                error,
                RuntimeError::Materialize(dohc_engine_files::MaterializeError::RecoveryUnavailable)
            ),
            "{error:?}"
        );
        assert_checked_delete_absent(&store);
        assert_eq!(checked_delete_state(&store), before);
        assert_eq!(
            hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
            expected
        );
    }

    #[test]
    fn conditional_restore_delete_symlink_block_reports_reason() {
        struct LateAlias(PathBuf);
        impl SelfWriteRecorder for LateAlias {
            fn record(&self, _: &str, _: &str, _: &str) {
                let real = self.0.join("real");
                std::fs::create_dir(&real).unwrap();
                std::fs::rename(self.0.join("record.md"), real.join("record.md")).unwrap();
                assert!(
                    dohc_engine_testkit::try_make_dir_alias(&real, &self.0.join("record.md"))
                        .unwrap()
                );
            }
            fn retract(&self, _: &str, _: &str, _: &str) {}
        }
        for binary in [false, true] {
            let (root, mut store, input, expected) = checked_delete_fixture(binary);
            let before = checked_delete_state(&store);
            let error = checked_delete_on_store(
                &mut store,
                &input,
                Some("document"),
                &expected,
                &root,
                &LateAlias(root.to_path_buf()),
                &NoFaults,
            )
            .unwrap_err();
            assert!(
                matches!(
                    error,
                    RuntimeError::Materialize(dohc_engine_files::MaterializeError::SymlinkTarget)
                ),
                "{error:?}"
            );
            assert_eq!(checked_delete_state(&store), before);
            assert_checked_delete_absent(&store);
            assert_eq!(
                hex_sha256(&std::fs::read(root.join("real/record.md")).unwrap()),
                expected
            );
        }
    }

    fn assert_only_retained_staged_originals(store: &EngineStore, root: &std::path::Path) {
        let staging = root.join(".dohc/engine/displaced");
        let files = std::fs::read_dir(&staging).unwrap().count();
        let retained = store.retained_displacements_after(0).unwrap();
        let rows: Vec<_> = retained
            .iter()
            .filter(|row| root.join(&row.source_path).parent() == Some(staging.as_path()))
            .collect();
        assert_eq!(
            files,
            rows.len(),
            "every staged original must have a retained row"
        );
        #[cfg(windows)]
        assert!(
            rows.is_empty(),
            "Windows releases known originals immediately"
        );
        for row in rows {
            let bytes = std::fs::read(root.join(&row.source_path)).unwrap();
            assert_eq!(hex_sha256(&bytes), row.digest);
            assert_eq!(bytes.len() as i64, row.size);
        }
    }

    #[test]
    fn conditional_restore_delete_finish_storage_error_rechecks_snapshot() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        for binary in [false, true] {
            for (state, request_retry) in [
                ("captured", false),
                ("changed", false),
                ("unchanged", false),
                ("captured", true),
                ("changed", true),
                ("unchanged", true),
            ] {
                let (root, mut store, input, expected) = checked_delete_fixture(binary);
                let commits = Arc::new(AtomicUsize::new(0));
                let hook_commits = commits.clone();
                let final_commit = if cfg!(unix) { 4 } else { 3 };
                store
                    .read_with(|conn| {
                        // Preparation, finish preview, disk receipt, and POSIX retention commit first.
                        // Fail the final transaction after disposing of the staged source.
                        conn.commit_hook(Some(move || {
                            hook_commits.fetch_add(1, Ordering::SeqCst) == final_commit
                        }))
                        .unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .unwrap();
                let result = checked_delete_on_store(
                    &mut store,
                    &input,
                    Some("document"),
                    &expected,
                    &root,
                    &(),
                    &NoFaults,
                );
                assert!(
                    matches!(result, Err(RuntimeError::Storage(_))),
                    "{result:?}"
                );
                assert_eq!(commits.load(Ordering::SeqCst), final_commit + 1);
                store
                    .read_with(|conn| {
                        conn.commit_hook(None::<fn() -> bool>).unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .unwrap();
                assert!(!root.join("record.md").exists());
                assert_eq!(
                    store
                        .load_materialization_job("restore-delete-mat_restore-delete")
                        .unwrap()
                        .unwrap()
                        .status,
                    JobStatus::Complete
                );
                assert_only_retained_staged_originals(&store, &root);
                store.write_with(&NoFaults, |tx| {
                    if state == "captured" {
                        let retired = dohc_engine_domain::capture_retire_in_tx(tx, &dohc_engine_domain::CaptureRetire {
                            workspace_id: "workspace".into(), version_id: "main".into(), path: "record.md".into(),
                            metadata_summary: None, metadata_correlation_id: None, now_ms: 4, request_id: None,
                            only_if_text_head: false, only_if_capture_origin: false, allow_ydoc_origin: true,
                        })?;
                        assert!(retired.retired.is_some());
                    } else if state == "changed" {
                        let hash = dohc_engine_storage::put_binary_blob(tx, b"Owner bytes KEEP")?;
                        tx.execute("INSERT INTO blobs(sha256,byte_length,text) VALUES(?1,16,'Owner bytes KEEP')", [&hash]).map_err(StorageError::persist_public)?;
                        tx.execute("UPDATE snapshots SET blob_sha256=CASE content_kind WHEN 'text' THEN ?1 ELSE NULL END,binary_sha256=CASE content_kind WHEN 'binary' THEN ?1 ELSE NULL END", [hash]).map_err(StorageError::persist_public)?;
                    }
                    Ok::<_, RuntimeError>(())
                }).unwrap();
                drop(store);
                let mut store =
                    EngineStore::open(&dohc_engine_testkit::engine_db_path(&root).unwrap(), 4)
                        .unwrap();
                if request_retry {
                    let retried = checked_delete_on_store(
                        &mut store,
                        &input,
                        Some("document"),
                        &expected,
                        &root,
                        &(),
                        &NoFaults,
                    );
                    if state == "unchanged" {
                        assert!(retried.unwrap().deduped);
                    } else {
                        assert!(
                            matches!(
                                retried,
                                Err(RuntimeError::Domain(
                                    DomainError::WritePreconditionFailed { .. }
                                ))
                            ),
                            "{retried:?}"
                        );
                    }
                }
                for _ in 0..2 {
                    super::super::materialization::replay_pending_materializations(
                        &mut store,
                        &root,
                        super::super::materialization::MaterializationReplayScope {
                            holds: None,
                            workspace_id: "workspace",
                            self_writes: None,
                            progress: None,
                            file_outcomes_settled: false,
                            released_hold_paths: None,
                            planned_against_active_heads: false,
                        },
                        4,
                        &NoFaults,
                        None,
                        false,
                    )
                    .unwrap();
                }
                let deletes: i64 = store
                    .read_with(|c| {
                        c.query_row(
                            "SELECT count(*) FROM moments WHERE operation='delete'",
                            [],
                            |r| r.get(0),
                        )
                    })
                    .unwrap();
                assert_eq!(
                    deletes,
                    i64::from(state != "changed"),
                    "replay must publish exactly one valid deletion: {state}"
                );
                let snapshots: i64 = store
                    .read_with(|c| c.query_row("SELECT count(*) FROM snapshots", [], |r| r.get(0)))
                    .unwrap();
                assert_eq!(snapshots, i64::from(state == "changed"));
                assert!(
                    store
                        .load_materialization_job("restore-delete-mat_restore-delete")
                        .unwrap()
                        .is_none()
                );
                if state == "unchanged" {
                    assert!(
                        checked_delete_on_store(
                            &mut store,
                            &input,
                            Some("document"),
                            &expected,
                            &root,
                            &(),
                            &NoFaults,
                        )
                        .unwrap()
                        .deduped
                    );
                    let retired = VersionedTextStore::new(&mut store)
                        .capture_retire(
                            &dohc_engine_domain::CaptureRetire {
                                workspace_id: "workspace".into(),
                                version_id: "main".into(),
                                path: "record.md".into(),
                                metadata_summary: None,
                                metadata_correlation_id: None,
                                now_ms: 5,
                                request_id: None,
                                only_if_text_head: false,
                                only_if_capture_origin: false,
                                allow_ydoc_origin: true,
                            },
                            &NoFaults,
                        )
                        .unwrap();
                    assert!(
                        retired.retired.is_none(),
                        "capture must not record another delete"
                    );
                }
            }
        }
    }

    #[test]
    fn conditional_restore_delete_crash_replay_finishes_or_discards_text_and_binary() {
        struct Crash(FaultPoint);
        impl FaultInjector for Crash {
            fn poll(&self, point: FaultPoint) -> FaultAction {
                if point == self.0 {
                    FaultAction::Crash
                } else {
                    FaultAction::Continue
                }
            }
        }
        for binary in [false, true] {
            for changed in [false, true] {
                for point in [
                    FaultPoint::StorageAfterCommitBeforeAck,
                    FaultPoint::MaterializeAfterJobCommit,
                    FaultPoint::MaterializeAfterRenameBeforeComplete,
                    FaultPoint::MaterializeAfterDisplacedHash,
                    FaultPoint::MaterializeAfterKnownCopyDeletion,
                ] {
                    // A changed pre-publication file exercises Conflict replay. A crash
                    // after staging exercises Applied recovery with an absent path.
                    if changed
                        && !matches!(
                            point,
                            FaultPoint::StorageAfterCommitBeforeAck
                                | FaultPoint::MaterializeAfterJobCommit
                        )
                    {
                        continue;
                    }
                    let (root, mut store, input, expected) = checked_delete_fixture(binary);
                    let before = checked_delete_state(&store);
                    assert!(matches!(
                        checked_delete_on_store(
                            &mut store,
                            &input,
                            Some("document"),
                            &expected,
                            &root,
                            &(),
                            &Crash(point)
                        ),
                        Err(RuntimeError::OperationCrashed)
                    ));
                    // Disk may already be absent, but nothing confirmed it.
                    assert!(
                        !publication_applied_on_store(
                            &store,
                            "workspace",
                            "restore-request",
                            "restore-delete"
                        )
                        .unwrap()
                    );
                    if changed {
                        std::fs::write(root.join("record.md"), "Owner text KEEP").unwrap();
                    }
                    drop(store);
                    let mut store =
                        EngineStore::open(&dohc_engine_testkit::engine_db_path(&root).unwrap(), 4)
                            .unwrap();
                    super::super::materialization::replay_pending_materializations(
                        &mut store,
                        &root,
                        super::super::materialization::MaterializationReplayScope {
                            holds: None,
                            workspace_id: "workspace",
                            self_writes: None,
                            progress: None,
                            file_outcomes_settled: false,
                            released_hold_paths: None,
                            planned_against_active_heads: false,
                        },
                        4,
                        &NoFaults,
                        None,
                        false,
                    )
                    .unwrap();
                    let before_disk = matches!(
                        point,
                        FaultPoint::StorageAfterCommitBeforeAck
                            | FaultPoint::MaterializeAfterJobCommit
                    );
                    let applied = publication_applied_on_store(
                        &store,
                        "workspace",
                        "restore-request",
                        "restore-delete",
                    )
                    .unwrap();
                    assert_eq!(applied, !changed && !before_disk);
                    if changed || before_disk {
                        assert_eq!(checked_delete_state(&store), before);
                        assert_eq!(
                            std::fs::read(root.join("record.md"))
                                .map(|bytes| hex_sha256(&bytes))
                                .unwrap(),
                            if changed {
                                hex_sha256(b"Owner text KEEP")
                            } else {
                                expected.clone()
                            }
                        );
                    } else {
                        assert!(!root.join("record.md").exists());
                        let deleted: i64 = store
                            .read_with(|c| {
                                c.query_row(
                                    "SELECT count(*) FROM moments WHERE operation='delete'",
                                    [],
                                    |r| r.get(0),
                                )
                            })
                            .unwrap();
                        assert_eq!(deleted, 1);
                        assert!(
                            checked_delete_on_store(
                                &mut store,
                                &input,
                                Some("document"),
                                &expected,
                                &root,
                                &(),
                                &NoFaults
                            )
                            .unwrap()
                            .deduped
                        );
                    }
                    assert!(
                        store
                            .load_materialization_job("restore-delete-mat_restore-delete")
                            .unwrap()
                            .is_none()
                    );
                }
            }
        }
    }

    #[test]
    fn conditional_restore_delete_refuses_closed_adoption_fence_and_finish_checks_before_disk() {
        for state in ["adopted", "fenced", "finish"] {
            let (root, mut store, input, expected) = checked_delete_fixture(false);
            store.write_with(&NoFaults, |tx| {
                match state {
                    "adopted" => {
                        let claim = dohc_engine_storage::put_binary_blob(tx, b"lineage claim").unwrap();
                        tx.execute("INSERT INTO live_owner_adoptions(relay_database_namespace,adoption_id,workspace_id,main_version_id,object_id,lineage_claim_id,binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,baseline_registered_at_ms,evidence_digest,coverage_digest,covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,host_coordinate_json,max_pending_bytes,max_pending_age_ms) VALUES('relay','adoption','workspace','main','document',?1,'{\"currentPath\":\"record.md\"}','creation',?2,15,0,1,?2,?2,0,1,0,'{}','{}',1024,1000)", params![claim, expected]).unwrap();
                    },
                    "fenced" => {tx.execute("INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES('workspace','main','document','relay','restore','{\"oldBinding\":{\"lineageClaimId\":\"claim\",\"restoreFenceGeneration\":0},\"newFence\":1}','{}')", []).unwrap();},
                    "finish" => {tx.execute_batch("CREATE TRIGGER refuse_lineage_retirement BEFORE DELETE ON ydoc_docs BEGIN SELECT RAISE(FAIL, 'retirement refused'); END").unwrap();},
                    _ => unreachable!(),
                }
                Ok::<_,StorageError>(())
            }).unwrap();
            let before = checked_delete_state(&store);
            assert!(
                checked_delete_on_store(
                    &mut store,
                    &input,
                    Some("document"),
                    &expected,
                    &root,
                    &(),
                    &NoFaults
                )
                .is_err(),
                "{state}"
            );
            assert_eq!(
                hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
                expected
            );
            assert_eq!(checked_delete_state(&store), before);
            assert_checked_delete_absent(&store);
        }
    }

    #[test]
    fn conditional_restore_delete_failed_discard_never_enters_generic_replay_or_read_only_history()
    {
        for binary in [false, true] {
            let (root, mut store, input, expected) = checked_delete_fixture(binary);
            struct Crash;
            impl FaultInjector for Crash {
                fn poll(&self, point: FaultPoint) -> FaultAction {
                    if point == FaultPoint::StorageAfterCommitBeforeAck {
                        FaultAction::Crash
                    } else {
                        FaultAction::Continue
                    }
                }
            }
            assert!(matches!(
                checked_delete_on_store(
                    &mut store,
                    &input,
                    Some("document"),
                    &expected,
                    &root,
                    &(),
                    &Crash
                ),
                Err(RuntimeError::OperationCrashed)
            ));
            store.read_with(|conn| conn.execute_batch("CREATE TRIGGER refuse_delete_discard BEFORE DELETE ON moments WHEN OLD.moment_id='restore-delete' BEGIN SELECT RAISE(FAIL, 'discard refused'); END")).unwrap();
            if !binary {
                store
                    .read_with(|conn| {
                        conn.execute("UPDATE ydoc_docs SET settled_update_seq=NULL", [])
                    })
                    .unwrap();
            } else {
                store
                    .write_with(&NoFaults, |tx| {
                        let hash =
                            dohc_engine_storage::put_binary_blob(tx, b"Owner bytes KEEP").unwrap();
                        tx.execute("UPDATE snapshots SET binary_sha256=?1", [hash])
                            .unwrap();
                        Ok::<_, StorageError>(())
                    })
                    .unwrap();
            }
            // A failed cleanup after a canonical refusal leaves the private job pending.
            assert!(
                publish_checked_delete_on_store(
                    &mut store,
                    &root,
                    "workspace",
                    "restore-delete-mat_restore-delete",
                    &(),
                    4,
                    &NoFaults,
                    false,
                    false,
                    None,
                )
                .is_err()
            );
            for _ in 0..2 {
                super::super::materialization::replay_pending_materializations(
                    &mut store,
                    &root,
                    super::super::materialization::MaterializationReplayScope {
                        holds: None,
                        workspace_id: "workspace",
                        self_writes: None,
                        progress: None,
                        file_outcomes_settled: false,
                        released_hold_paths: None,
                        planned_against_active_heads: false,
                    },
                    4,
                    &NoFaults,
                    None,
                    false,
                )
                .unwrap();
                let staged = store
                    .load_materialization_job("restore-delete-mat_restore-delete")
                    .unwrap()
                    .unwrap();
                let (materialized, reported) =
                    super::super::materialization::materialize_pending_job(
                        &store,
                        &root,
                        "workspace",
                        &staged,
                        &(),
                        4,
                        &NoFaults,
                        None,
                    );
                assert!(!materialized);
                assert!(matches!(reported, PostCommitMaterializeOutcome::Skipped));
                assert!(
                    dohc_engine_files::run_pending_jobs(
                        &store,
                        &root,
                        &dohc_engine_files::MaterializeOptions {
                            holds: None,
                            policy: dohc_engine_files::DurabilityPolicy::per_os(),
                            replacer: &dohc_engine_files::StdReplacer,
                            backoff: &dohc_engine_files::StdBackoff,
                            now_ms: 4,
                            faults: &NoFaults,
                        }
                    )
                    .unwrap()
                    .is_empty()
                );
                assert_eq!(
                    hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
                    expected
                );
                assert_eq!(
                    store
                        .load_materialization_job("restore-delete-mat_restore-delete")
                        .unwrap()
                        .unwrap()
                        .status,
                    JobStatus::Pending
                );
            }
            let mut read_only =
                EngineStore::open_read_only(&dohc_engine_testkit::engine_db_path(&root).unwrap())
                    .unwrap();
            let history = VersionedTextStore::new(&mut read_only);
            assert!(
                history
                    .get_moment("workspace", "restore-delete")
                    .unwrap()
                    .is_none()
            );
            let page = history
                .list_moments(&dohc_engine_domain::ListMomentsQuery {
                    workspace_id: "workspace".into(),
                    version_id: Some("main".into()),
                    object_id: Some("document".into()),
                    limit: 1,
                    before_moment_order: None,
                })
                .unwrap();
            assert_eq!(page.moments[0].moment_id, "creation");
            assert_eq!(page.latest_moment_order, Some(page.moments[0].moment_order));
            assert!(page.next_before_moment_order.is_none());
            drop(read_only);
            store
                .read_with(|conn| conn.execute_batch("DROP TRIGGER refuse_delete_discard"))
                .unwrap();
            publish_checked_delete_on_store(
                &mut store,
                &root,
                "workspace",
                "restore-delete-mat_restore-delete",
                &(),
                5,
                &NoFaults,
                true,
                false,
                None,
            )
            .unwrap();
            assert_checked_delete_absent(&store);
        }
    }

    #[test]
    fn conditional_restore_delete_refuses_unsettled_deferred_outbox_and_path_mismatch() {
        for state in ["unsettled", "deferred", "outbox", "path"] {
            let (root, mut store, input, expected) = checked_delete_fixture(false);
            store.write_with(&NoFaults, |tx| {
                match state {
                    "unsettled" => {tx.execute("UPDATE ydoc_docs SET settled_update_seq=NULL", []).unwrap();},
                    "path" => {tx.execute("UPDATE ydoc_docs SET path='other.md'", []).unwrap();},
                    "deferred" => {tx.execute("INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms) VALUES('workspace','main','document','origin',1,2)", []).unwrap();},
                    "outbox" => {
                        let digest = dohc_engine_storage::put_binary_blob(tx, b"base").unwrap();
                        tx.execute("INSERT INTO owner_ydoc_outboxes(outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,created_at_ms) VALUES('outbox','workspace','main','document',?1,'record.md','[\"record.md\"]',0,?2,?2,4,'active',4,2,1,2)", params!["a".repeat(64),digest]).unwrap();
                    },
                    _ => unreachable!(),
                }
                Ok::<_,StorageError>(())
            }).unwrap();
            let before = checked_delete_state(&store);
            assert!(
                checked_delete_on_store(
                    &mut store,
                    &input,
                    Some("document"),
                    &expected,
                    &root,
                    &(),
                    &NoFaults
                )
                .is_err(),
                "{state}"
            );
            assert_eq!(checked_delete_state(&store), before);
            assert_checked_delete_absent(&store);
            assert_eq!(
                hex_sha256(&std::fs::read(root.join("record.md")).unwrap()),
                expected
            );
        }
    }

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
