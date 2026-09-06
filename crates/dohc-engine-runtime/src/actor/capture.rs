use super::ActorHandle;
#[cfg(test)]
use super::Command;
use super::journal::{
    journal_moment_outbound_in_tx, journal_moment_outbound_with_batch_in_tx,
    journal_secret_delete_outbound_in_tx, journal_secret_put_outbound_in_tx,
};
use super::materialization::SelfWriteRecorder;
use super::versioned::{
    delete_owned_scene_assets_in_tx, materialize_scene_asset_deletes,
    with_local_file_mutation_cache_reset,
};
use super::versions::ensure_mutation_version_on_store;
use crate::error::RuntimeError;
use crate::search::index::update_file_search_index_for_capture;
#[cfg(test)]
use crate::search::read_engine_search_policy;
use crate::search::{SearchPolicySnapshot, delete_file_search_index, upsert_file_search_index};
use dohc_engine_collab::{DocKey, LeaseRegistry};
#[cfg(test)]
use dohc_engine_collab::{
    OwnerDeliveryReceipt, OwnerOutboxAppendInput, OwnerOutboxQuarantineInput, append_owner_outbox,
};
use dohc_engine_crypto::SecretDataKey;
use dohc_engine_domain::{
    CaptureIngest, CaptureIngestBatchContext, CaptureIngestBinary, CaptureIngestBinaryResult,
    CaptureManifestSeedEntry, CaptureRetire, CaptureRetireResult, CaptureSecret,
    CaptureSecretRetire, DomainError, SecretFileStore, SecretMomentRecord, SecretWriteResult,
    VersionedTextStore, WriteResult, capture_ingest_binary_with_admission_in_tx,
    capture_ingest_in_batch_with_admission_in_tx, capture_ingest_with_admission_in_tx,
    capture_manifest_seed, capture_retire_in_tx, capture_secret_retire_with,
    ensure_main_version_in_tx,
};
#[cfg(test)]
use dohc_engine_domain::{derive_capture_object_id, secret_file_len_keyless};
#[cfg(test)]
use dohc_engine_storage::NoFaults;
use dohc_engine_storage::{EngineStore, FaultInjector, StorageError, TxnOutcome};
use rusqlite::Transaction;
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(test)]
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Maximum work accepted by one capture batch actor command. Keeping both
/// bounds here lets the actor serve queued interactive work between chunks.
pub const MAX_CAPTURE_INGEST_BATCH_OPS: usize = 256;
pub const MAX_CAPTURE_INGEST_BATCH_BYTES: usize = 4 * 1024 * 1024;

/// Capture-owned proof that a filesystem pathname still names the workspace
/// root selected before an actor command entered the queue.
pub trait WorkspaceRootGuard: Send + Sync {
    fn validate(&self, root_dir: &std::path::Path) -> Result<(), RuntimeError>;
}

type CommandWorkspaceRoot = (PathBuf, Option<Arc<dyn WorkspaceRootGuard>>);

fn command_workspace_root_parts(
    workspace_root: Option<&CommandWorkspaceRoot>,
) -> (Option<&std::path::Path>, Option<&dyn WorkspaceRootGuard>) {
    match workspace_root {
        Some((root_dir, root_guard)) => (Some(root_dir.as_path()), root_guard.as_deref()),
        None => (None, None),
    }
}

pub(super) fn validate_workspace_root(
    root_dir: &std::path::Path,
    root_guard: Option<&dyn WorkspaceRootGuard>,
) -> Result<(), RuntimeError> {
    if let Some(root_guard) = root_guard {
        root_guard.validate(root_dir)?;
    }
    Ok(())
}

enum CaptureIndexing {
    Skip,
    ReadRoot(PathBuf),
    UseSnapshot(Arc<SearchPolicySnapshot>),
}

impl ActorHandle {
    // --- Synchronous API (must be used outside a runtime) ---

    /// Capture a text file on the actor's writer, blocking the calling thread.
    pub fn capture_ingest_blocking(
        &self,
        input: CaptureIngest,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_blocking_with_indexing(input, CaptureIndexing::Skip, leases, faults)
    }

    /// Capture and index text against one reconcile-owned policy snapshot.
    pub fn capture_ingest_with_search_policy_blocking(
        &self,
        input: CaptureIngest,
        search_policy: Arc<SearchPolicySnapshot>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_blocking_with_indexing(
            input,
            CaptureIndexing::UseSnapshot(search_policy),
            leases,
            faults,
        )
    }

    /// Capture a bounded text chunk in one durable transaction. A clean chunk
    /// shares one rollback scope. If an item fails, the chunk is replayed with
    /// per-item savepoints so successful siblings still commit.
    pub fn capture_ingest_batch_blocking(
        &self,
        inputs: Vec<CaptureIngest>,
        search_policy: Arc<SearchPolicySnapshot>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        root_dir: PathBuf,
        root_guard: Arc<dyn WorkspaceRootGuard>,
    ) -> Result<Vec<Result<WriteResult, RuntimeError>>, RuntimeError> {
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                capture_ingest_batch_on_store(
                    store,
                    &inputs,
                    &search_policy,
                    &leases,
                    faults.as_ref(),
                    &token,
                    (&root_dir, root_guard.as_ref()),
                )
            })
        })
    }

    fn capture_ingest_blocking_with_indexing(
        &self,
        input: CaptureIngest,
        indexing: CaptureIndexing,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<WriteResult, RuntimeError> {
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                capture_ingest_on_store(store, &input, &indexing, &leases, faults.as_ref(), &token)
            })
        })
    }

    /// Capture a binary file on the actor's writer, blocking the caller.
    pub fn capture_ingest_binary_blocking(
        &self,
        input: CaptureIngestBinary,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<CaptureIngestBinaryResult, RuntimeError> {
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                capture_ingest_binary_on_store(store, &input, &leases, faults.as_ref(), &token)
            })
        })
    }

    /// Capture a secret file on the actor's writer, blocking the caller. The
    /// workspace data key travels with the request (the actor holds no key
    /// state; custody stays at the composition layer).
    pub fn capture_secret_blocking(
        &self,
        input: CaptureSecret,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<SecretWriteResult, RuntimeError> {
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, _cache| {
            capture_secret_on_store(store, &input, &key, faults.as_ref(), &token)
        })
    }

    /// Retire a captured secret path on the actor's writer, blocking the
    /// caller. Keyless: a delete never decrypts.
    pub fn capture_secret_retire_blocking_guarded(
        &self,
        input: CaptureSecretRetire,
        root_dir: PathBuf,
        faults: Arc<dyn FaultInjector>,
        root_guard: Arc<dyn WorkspaceRootGuard>,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        let workspace_root: Option<CommandWorkspaceRoot> = Some((root_dir, Some(root_guard)));
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, _cache| {
            let (root_dir, root_guard) = command_workspace_root_parts(workspace_root.as_ref());
            capture_secret_retire_on_store(
                store,
                &input,
                root_dir,
                root_guard,
                faults.as_ref(),
                &token,
            )
        })
    }

    /// Retire a captured path on the actor's writer, blocking the caller.
    pub fn capture_retire_blocking(
        &self,
        input: CaptureRetire,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<CaptureRetireResult, RuntimeError> {
        let workspace_root: Option<CommandWorkspaceRoot> = None;
        let self_writes: Option<Arc<dyn SelfWriteRecorder>> = None;
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, cache| {
            let (root_dir, root_guard) = command_workspace_root_parts(workspace_root.as_ref());
            with_local_file_mutation_cache_reset(cache, || {
                capture_retire_on_store(
                    store,
                    &input,
                    root_dir,
                    root_guard,
                    self_writes.as_deref(),
                    &leases,
                    faults.as_ref(),
                    &token,
                )
            })
        })
    }

    /// Retire a captured path and immediately apply any durable disk cleanup
    /// that the mutation creates.
    pub fn capture_retire_materialized_blocking_guarded(
        &self,
        input: CaptureRetire,
        root_dir: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        root_guard: Arc<dyn WorkspaceRootGuard>,
    ) -> Result<CaptureRetireResult, RuntimeError> {
        let workspace_root: Option<CommandWorkspaceRoot> = Some((root_dir, Some(root_guard)));
        let self_writes: Option<Arc<dyn SelfWriteRecorder>> = Some(self_writes);
        let token: CancellationToken = CancellationToken::new();
        self.run_blocking(move |store, cache| {
            let (root_dir, root_guard) = command_workspace_root_parts(workspace_root.as_ref());
            with_local_file_mutation_cache_reset(cache, || {
                capture_retire_on_store(
                    store,
                    &input,
                    root_dir,
                    root_guard,
                    self_writes.as_deref(),
                    &leases,
                    faults.as_ref(),
                    &token,
                )
            })
        })
    }

    /// Capture a text file on the actor's single writer thread.
    pub async fn capture_ingest(
        &self,
        input: CaptureIngest,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_with_root(input, None, leases, faults, token)
            .await
    }

    /// Capture and index a text file when the owning workspace session can
    /// supply its authoritative root.
    pub async fn capture_ingest_indexed(
        &self,
        input: CaptureIngest,
        root_dir: PathBuf,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        self.capture_ingest_with_root(input, Some(root_dir), leases, faults, token)
            .await
    }

    async fn capture_ingest_with_root(
        &self,
        input: CaptureIngest,
        root_dir: Option<PathBuf>,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<WriteResult, RuntimeError> {
        let indexing = root_dir.map_or(CaptureIndexing::Skip, CaptureIndexing::ReadRoot);
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                capture_ingest_on_store(store, &input, &indexing, &leases, faults.as_ref(), &token)
            })
        })
        .await
    }

    /// Capture a binary file on the actor's single writer thread.
    pub async fn capture_ingest_binary(
        &self,
        input: CaptureIngestBinary,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<CaptureIngestBinaryResult, RuntimeError> {
        self.run(move |store, cache| {
            with_local_file_mutation_cache_reset(cache, || {
                capture_ingest_binary_on_store(store, &input, &leases, faults.as_ref(), &token)
            })
        })
        .await
    }

    /// Every captured path with its content identity, for seeding a fresh
    /// files-layer manifest on workspace (re)open (deleted-while-closed
    /// files must retire against the seed, never survive an empty baseline).
    pub async fn capture_manifest_seed(
        &self,
        workspace_id: String,
        version_id: String,
    ) -> Result<Vec<CaptureManifestSeedEntry>, RuntimeError> {
        self.run(move |store, _| {
            capture_manifest_seed(store, &workspace_id, &version_id).map_err(RuntimeError::from)
        })
        .await
    }

    /// Capture a secret file on the actor's single writer thread.
    pub async fn capture_secret(
        &self,
        input: CaptureSecret,
        key: SecretDataKey,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<SecretWriteResult, RuntimeError> {
        self.run(move |store, _cache| {
            capture_secret_on_store(store, &input, &key, faults.as_ref(), &token)
        })
        .await
    }

    /// Retire a captured secret path on the actor's single writer thread.
    pub async fn capture_secret_retire(
        &self,
        input: CaptureSecretRetire,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Option<SecretMomentRecord>, RuntimeError> {
        let workspace_root: Option<CommandWorkspaceRoot> = None;
        self.run(move |store, _cache| {
            let (root_dir, root_guard) = command_workspace_root_parts(workspace_root.as_ref());
            capture_secret_retire_on_store(
                store,
                &input,
                root_dir,
                root_guard,
                faults.as_ref(),
                &token,
            )
        })
        .await
    }

    /// Retire a captured path on the actor's single writer thread.
    pub async fn capture_retire(
        &self,
        input: CaptureRetire,
        leases: LeaseRegistry,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<CaptureRetireResult, RuntimeError> {
        let workspace_root: Option<CommandWorkspaceRoot> = None;
        let self_writes: Option<Arc<dyn SelfWriteRecorder>> = None;
        self.run(move |store, cache| {
            let (root_dir, root_guard) = command_workspace_root_parts(workspace_root.as_ref());
            with_local_file_mutation_cache_reset(cache, || {
                capture_retire_on_store(
                    store,
                    &input,
                    root_dir,
                    root_guard,
                    self_writes.as_deref(),
                    &leases,
                    faults.as_ref(),
                    &token,
                )
            })
        })
        .await
    }
}

fn capture_agent_origin_id(author_json: Option<&str>) -> Option<String> {
    let author = serde_json::from_str::<serde_json::Value>(author_json?).ok()?;
    let object = author.as_object()?;
    if object.get("kind").and_then(serde_json::Value::as_str) != Some("agent") {
        return None;
    }
    let agent_id = object
        .get("agentId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())?;
    object
        .get("onBehalfOf")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())?;
    if object
        .get("agentRunId")
        .is_some_and(|value| value.as_str().is_none_or(str::is_empty))
    {
        return None;
    }
    Some(agent_id.to_owned())
}

fn capture_ingest_on_store(
    store: &mut EngineStore,
    input: &CaptureIngest,
    indexing: &CaptureIndexing,
    leases: &LeaseRegistry,
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
    let outcome = store.write_with(faults, |tx| {
        capture_ingest_in_tx(tx, input, indexing, leases, None)
    })?;
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

struct CaptureBatchSharedContext {
    capture: CaptureIngestBatchContext,
    has_ydoc_state: Option<bool>,
    journals_file_moments: Option<bool>,
}

fn capture_ingest_in_tx(
    tx: &Transaction<'_>,
    input: &CaptureIngest,
    indexing: &CaptureIndexing,
    leases: &LeaseRegistry,
    mut batch: Option<&mut CaptureBatchSharedContext>,
) -> Result<WriteResult, RuntimeError> {
    let actor_origin_id = capture_agent_origin_id(input.author_json.as_deref());
    let mut admitted = false;
    let result = match batch.as_deref_mut() {
        Some(batch) => capture_ingest_in_batch_with_admission_in_tx(
            tx,
            input,
            &mut batch.capture,
            |workspace_id, version_id, object_id| {
                ensure_capture_target_not_leased(leases, workspace_id, version_id, object_id)?;
                admitted = true;
                Ok::<_, RuntimeError>(())
            },
        )?,
        None => capture_ingest_with_admission_in_tx(
            tx,
            input,
            |workspace_id, version_id, object_id| {
                ensure_capture_target_not_leased(leases, workspace_id, version_id, object_id)?;
                admitted = true;
                Ok::<_, RuntimeError>(())
            },
        )?,
    };
    if admitted {
        let has_ydoc_state = match batch.as_deref_mut() {
            Some(batch) => match batch.has_ydoc_state {
                Some(has_ydoc_state) => has_ydoc_state,
                None => {
                    let has_ydoc_state = dohc_engine_sync::workspace_has_ydoc_state_in_tx(
                        tx,
                        &input.workspace_id,
                        &input.version_id,
                    )?;
                    batch.has_ydoc_state = Some(has_ydoc_state);
                    has_ydoc_state
                }
            },
            None => true,
        };
        if has_ydoc_state {
            dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                dohc_engine_sync::ResultingHead::Text {
                    path: &result.snapshot.path,
                    text: &result.snapshot.text,
                },
                actor_origin_id.as_deref(),
                input.now_ms,
            )?;
        }
    }
    if !result.deduped {
        match indexing {
            CaptureIndexing::Skip => {}
            CaptureIndexing::ReadRoot(root_dir) => upsert_file_search_index(
                tx,
                root_dir,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
            )
            .map_err(RuntimeError::from)?,
            CaptureIndexing::UseSnapshot(policy) => update_file_search_index_for_capture(
                tx,
                policy,
                &input.workspace_id,
                &input.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
                result.moment.before_present,
            )
            .map_err(RuntimeError::from)?,
        }
    }
    match batch {
        Some(batch) => journal_moment_outbound_with_batch_in_tx(
            tx,
            &input.workspace_id,
            &result.moment.moment_id,
            result.deduped,
            &mut batch.journals_file_moments,
        ),
        None => journal_moment_outbound_in_tx(
            tx,
            &input.workspace_id,
            &result.moment.moment_id,
            result.deduped,
        ),
    }
    .map_err(RuntimeError::from)?;
    Ok(result)
}

fn capture_ingest_batch_on_store(
    store: &mut EngineStore,
    inputs: &[CaptureIngest],
    search_policy: &Arc<SearchPolicySnapshot>,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
    workspace_root: (&std::path::Path, &dyn WorkspaceRootGuard),
) -> Result<Vec<Result<WriteResult, RuntimeError>>, RuntimeError> {
    let (root_dir, root_guard) = workspace_root;
    let Some(first) = inputs.first() else {
        return Ok(Vec::new());
    };
    let total_bytes = inputs
        .iter()
        .try_fold(0usize, |total, input| total.checked_add(input.text.len()))
        .ok_or(DomainError::InvalidInput {
            reason: "capture batch byte count overflowed",
        })?;
    if inputs.len() > MAX_CAPTURE_INGEST_BATCH_OPS || total_bytes > MAX_CAPTURE_INGEST_BATCH_BYTES {
        return Err(DomainError::InvalidInput {
            reason: "capture batch exceeds actor bounds",
        }
        .into());
    }
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if inputs.iter().any(|input| {
        input.workspace_id != first.workspace_id || input.version_id != first.version_id
    }) {
        return Err(DomainError::InvalidInput {
            reason: "capture batch coordinates do not match",
        }
        .into());
    }
    validate_workspace_root(root_dir, Some(root_guard))?;
    let bootstrap_main = {
        let versions = VersionedTextStore::new(store);
        let missing_main = versions.get_main_version(&first.workspace_id)?.is_none();
        if missing_main && first.version_id != "main" {
            return Err(DomainError::VersionNotFound.into());
        }
        missing_main
    };

    let outcome = store.write_with(faults, |tx| {
        if bootstrap_main {
            ensure_main_version_in_tx(tx, &first.workspace_id, &first.version_id, first.now_ms)?;
        }
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        validate_workspace_root(root_dir, Some(root_guard))?;
        let indexing = CaptureIndexing::UseSnapshot(Arc::clone(search_policy));

        // Most startup batches are clean. Keep their database and FTS work in
        // one rollback scope instead of preparing and releasing a savepoint
        // for every file. If any item needs isolation, roll the optimistic
        // attempt back and replay through the existing partial-success path.
        // Callers therefore keep the same per-item result contract while the
        // common case pays one savepoint per batch rather than one per file.
        tx.execute_batch("SAVEPOINT dohc_capture_batch_fast")
            .map_err(StorageError::persist_public)?;
        match capture_ingest_batch_all_or_none_in_tx(tx, inputs, &indexing, leases) {
            Ok(results) => {
                tx.execute_batch("RELEASE dohc_capture_batch_fast")
                    .map_err(StorageError::persist_public)?;
                Ok(results.into_iter().map(Ok).collect())
            }
            Err(_) => {
                tx.execute_batch(
                    "ROLLBACK TO dohc_capture_batch_fast; \
                     RELEASE dohc_capture_batch_fast",
                )
                .map_err(StorageError::persist_public)?;
                capture_ingest_batch_with_item_savepoints_in_tx(tx, inputs, &indexing, leases)
            }
        }
    })?;
    match outcome {
        TxnOutcome::Committed(results) => Ok(results),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn capture_ingest_batch_all_or_none_in_tx(
    tx: &Transaction<'_>,
    inputs: &[CaptureIngest],
    indexing: &CaptureIndexing,
    leases: &LeaseRegistry,
) -> Result<Vec<WriteResult>, RuntimeError> {
    let first = inputs.first().ok_or(DomainError::InvalidInput {
        reason: "capture batch is empty",
    })?;
    let mut results = Vec::with_capacity(inputs.len());
    let mut batch = CaptureBatchSharedContext {
        capture: CaptureIngestBatchContext::new(tx, &first.workspace_id, &first.version_id)?,
        has_ydoc_state: None,
        journals_file_moments: None,
    };
    for input in inputs {
        let result = capture_ingest_in_tx(tx, input, indexing, leases, Some(&mut batch))?;
        batch.capture.commit_result(&result)?;
        results.push(result);
    }
    Ok(results)
}

fn capture_ingest_batch_with_item_savepoints_in_tx(
    tx: &Transaction<'_>,
    inputs: &[CaptureIngest],
    indexing: &CaptureIndexing,
    leases: &LeaseRegistry,
) -> Result<Vec<Result<WriteResult, RuntimeError>>, RuntimeError> {
    let first = inputs.first().ok_or(DomainError::InvalidInput {
        reason: "capture batch is empty",
    })?;
    let mut results = Vec::with_capacity(inputs.len());
    let mut batch = CaptureBatchSharedContext {
        capture: CaptureIngestBatchContext::new(tx, &first.workspace_id, &first.version_id)?,
        has_ydoc_state: None,
        journals_file_moments: None,
    };
    for input in inputs {
        tx.execute_batch("SAVEPOINT dohc_capture_batch_item")
            .map_err(StorageError::persist_public)?;
        match capture_ingest_in_tx(tx, input, indexing, leases, Some(&mut batch)) {
            Ok(result) => {
                tx.execute_batch("RELEASE dohc_capture_batch_item")
                    .map_err(StorageError::persist_public)?;
                batch.capture.commit_result(&result)?;
                results.push(Ok(result));
            }
            Err(error) => {
                tx.execute_batch(
                    "ROLLBACK TO dohc_capture_batch_item; \
                     RELEASE dohc_capture_batch_item",
                )
                .map_err(StorageError::persist_public)?;
                results.push(Err(error));
            }
        }
    }
    Ok(results)
}

#[cfg(test)]
mod capture_batch_fast_path_tests {
    use super::*;
    use dohc_engine_testkit::ScratchDir;
    use rusqlite::hooks::{AuthAction, Authorization, TransactionOperation};
    use std::sync::Mutex;

    struct ExistingRootGuard;

    impl WorkspaceRootGuard for ExistingRootGuard {
        fn validate(&self, root_dir: &std::path::Path) -> Result<(), RuntimeError> {
            root_dir
                .is_dir()
                .then_some(())
                .ok_or(RuntimeError::Identity {
                    reason: "test workspace root disappeared",
                    source: None,
                })
        }
    }

    #[test]
    fn clean_capture_batch_uses_one_batch_savepoint() {
        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let begun_savepoints = Arc::new(Mutex::new(Vec::new()));
        let observed_savepoints = Arc::clone(&begun_savepoints);
        store
            .read_with(|conn| {
                conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
                    if let AuthAction::Savepoint {
                        operation: TransactionOperation::Begin,
                        savepoint_name,
                    } = context.action
                    {
                        observed_savepoints
                            .lock()
                            .expect("record begun savepoint")
                            .push(savepoint_name.to_owned());
                    }
                    Authorization::Allow
                }))
            })
            .expect("install savepoint observer");
        let inputs = (0..3)
            .map(|index| CaptureIngest {
                workspace_id: "fresh-batch-workspace".to_owned(),
                version_id: "main".to_owned(),
                path: format!("note-{index}.md"),
                text: format!("body {index}"),
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: Some("Reconciled offline edits".to_owned()),
                metadata_correlation_id: Some("fresh-batch".to_owned()),
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: false,
            })
            .collect::<Vec<_>>();
        let policy = Arc::new(read_engine_search_policy(scratch.path()));

        let results = capture_ingest_batch_on_store(
            &mut store,
            &inputs,
            &policy,
            &LeaseRegistry::new(),
            &NoFaults,
            &CancellationToken::new(),
            (scratch.path(), &ExistingRootGuard),
        )
        .expect("capture clean batch");

        assert!(results.iter().all(Result::is_ok));
        assert_eq!(
            *begun_savepoints.lock().expect("read begun savepoints"),
            vec!["dohc_capture_batch_fast"],
            "a clean batch must use one rollback scope instead of one per item"
        );
    }

    #[test]
    fn fallback_batch_commits_siblings_and_rolls_back_the_leased_item() {
        const WORKSPACE_ID: &str = "fallback-batch-workspace";
        const VERSION_ID: &str = "main";
        const FAILED_PATH: &str = "note-1.md";

        let scratch = ScratchDir::new().expect("scratch");
        let db = dohc_engine_testkit::engine_db_path(&scratch).expect("engine database path");
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let inputs = (0..3)
            .map(|index| CaptureIngest {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                path: format!("note-{index}.md"),
                text: format!("body {index}"),
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: Some("Reconciled offline edits".to_owned()),
                metadata_correlation_id: Some("fallback-batch".to_owned()),
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: false,
            })
            .collect::<Vec<_>>();
        let failed_object_id = derive_capture_object_id(WORKSPACE_ID, VERSION_ID, FAILED_PATH);
        let leases = LeaseRegistry::new();
        let failed_key =
            DocKey::new(WORKSPACE_ID, VERSION_ID, &failed_object_id).expect("failed item key");
        let _failed_lease = leases.acquire(&failed_key).expect("hold failed item lease");
        let policy = Arc::new(read_engine_search_policy(scratch.path()));

        let results = capture_ingest_batch_on_store(
            &mut store,
            &inputs,
            &policy,
            &leases,
            &NoFaults,
            &CancellationToken::new(),
            (scratch.path(), &ExistingRootGuard),
        )
        .expect("capture fallback batch");

        assert_eq!(results.len(), 3);
        assert!(results[0].is_ok(), "the first sibling must commit");
        assert!(matches!(
            &results[1],
            Err(RuntimeError::Sync(
                dohc_engine_sync::SyncError::RetryableState {
                    reason: "ydoc-session-live"
                }
            ))
        ));
        assert!(results[2].is_ok(), "the final sibling must commit");
        let first_order = results[0]
            .as_ref()
            .expect("first sibling result")
            .moment
            .moment_order;
        let final_order = results[2]
            .as_ref()
            .expect("final sibling result")
            .moment
            .moment_order;
        assert_eq!(
            final_order,
            first_order + 1,
            "the rolled-back item must not advance the shared moment cursor"
        );

        drop(store);
        let mut reopened = EngineStore::open(&db, 1).expect("reopen store");
        let versioned = VersionedTextStore::new(&mut reopened);
        assert_eq!(
            versioned
                .read_text(WORKSPACE_ID, VERSION_ID, "note-0.md")
                .expect("read first sibling")
                .expect("first sibling head")
                .text,
            "body 0"
        );
        assert_eq!(
            versioned
                .read_text(WORKSPACE_ID, VERSION_ID, "note-2.md")
                .expect("read final sibling")
                .expect("final sibling head")
                .text,
            "body 2"
        );
        assert!(
            versioned
                .read_text(WORKSPACE_ID, VERSION_ID, FAILED_PATH)
                .expect("read failed item")
                .is_none(),
            "the failed item must have no readable head"
        );
        let (snapshots, moments, search_rows): (i64, i64, i64) = reopened
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                        (WORKSPACE_ID, VERSION_ID, &failed_object_id),
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                        (WORKSPACE_ID, VERSION_ID, &failed_object_id),
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM engine_search_files_fts WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                        (WORKSPACE_ID, VERSION_ID, &failed_object_id),
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("read failed item durable rows");
        assert_eq!(
            (snapshots, moments, search_rows),
            (0, 0, 0),
            "the failed item must leave no snapshot, moment, or search row"
        );
    }
}

fn capture_ingest_binary_on_store(
    store: &mut EngineStore,
    input: &CaptureIngestBinary,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<CaptureIngestBinaryResult, RuntimeError> {
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
    let outcome = store.write_with(faults, |tx| {
        let mut admitted = false;
        let result = capture_ingest_binary_with_admission_in_tx(
            tx,
            input,
            |workspace_id, version_id, object_id| {
                ensure_capture_target_not_leased(leases, workspace_id, version_id, object_id)?;
                admitted = true;
                Ok::<_, RuntimeError>(())
            },
        )?;
        if admitted {
            dohc_engine_sync::reconcile_local_resulting_head_in_tx(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object_id,
                dohc_engine_sync::ResultingHead::BinaryOrAbsent,
                None,
                input.now_ms,
            )?;
        }
        if !result.deduped {
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &result.object_id,
            )
            .map_err(RuntimeError::from)?;
        }
        journal_moment_outbound_in_tx(tx, &input.workspace_id, &result.moment_id, result.deduped)
            .map_err(RuntimeError::from)?;
        Ok::<_, RuntimeError>(result)
    })?;
    match outcome {
        TxnOutcome::Committed(result) => Ok(result),
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

fn ensure_capture_target_not_leased(
    leases: &LeaseRegistry,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<(), RuntimeError> {
    let key = DocKey::new(workspace_id, version_id, object_id)?;
    if leases.is_held(&key) {
        return Err(RuntimeError::Sync(
            dohc_engine_sync::SyncError::RetryableState {
                reason: "ydoc-session-live",
            },
        ));
    }
    Ok(())
}

fn capture_secret_on_store(
    store: &mut EngineStore,
    input: &CaptureSecret,
    key: &SecretDataKey,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<SecretWriteResult, RuntimeError> {
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
    SecretFileStore::new(store, key)
        .capture_secret_with(input, faults, |tx, result| {
            journal_secret_put_outbound_in_tx(tx, result)
        })
        .map_err(RuntimeError::from)
}

fn capture_secret_retire_on_store(
    store: &mut EngineStore,
    input: &CaptureSecretRetire,
    root_dir: Option<&std::path::Path>,
    root_guard: Option<&dyn WorkspaceRootGuard>,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<Option<SecretMomentRecord>, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if let Some(root_dir) = root_dir {
        validate_workspace_root(root_dir, root_guard)?;
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
    capture_secret_retire_with(store, input, faults, journal_secret_delete_outbound_in_tx)
        .map_err(RuntimeError::from)
}

#[allow(clippy::too_many_arguments)]
fn capture_retire_on_store(
    store: &mut EngineStore,
    input: &CaptureRetire,
    root_dir: Option<&std::path::Path>,
    root_guard: Option<&dyn WorkspaceRootGuard>,
    self_writes: Option<&dyn SelfWriteRecorder>,
    leases: &LeaseRegistry,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<CaptureRetireResult, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if let Some(root_dir) = root_dir {
        validate_workspace_root(root_dir, root_guard)?;
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
    let outcome = store.write_with(faults, |tx| {
        let result = capture_retire_in_tx(tx, input).map_err(RuntimeError::from)?;
        let mut asset_jobs = Vec::new();
        if !result.deduped
            && let Some(retired) = result.retired.as_ref()
        {
            let key = DocKey::new(
                &input.workspace_id,
                &input.version_id,
                &retired.object.object_id,
            )?;
            if leases.is_held(&key) {
                return Err(RuntimeError::Sync(
                    dohc_engine_sync::SyncError::RetryableState {
                        reason: "ydoc-session-live",
                    },
                ));
            }
            delete_file_search_index(
                tx,
                &input.workspace_id,
                &input.version_id,
                &retired.object.object_id,
            )
            .map_err(RuntimeError::from)?;
        }
        if let Some(retired) = result.retired.as_ref() {
            if !result.deduped && !retired.deduped {
                journal_moment_outbound_in_tx(
                    tx,
                    &input.workspace_id,
                    &retired.moment.moment_id,
                    false,
                )
                .map_err(RuntimeError::from)?;
                asset_jobs = delete_owned_scene_assets_in_tx(tx, retired)?;
                dohc_engine_sync::retire_ydoc_lineage_in_tx(
                    tx,
                    &input.workspace_id,
                    &input.version_id,
                    &retired.object.object_id,
                )
                .map_err(RuntimeError::from)?;
            } else {
                journal_moment_outbound_in_tx(
                    tx,
                    &input.workspace_id,
                    &retired.moment.moment_id,
                    true,
                )
                .map_err(RuntimeError::from)?;
            }
        }
        Ok::<_, RuntimeError>((result, asset_jobs))
    })?;
    match outcome {
        TxnOutcome::Committed((result, asset_jobs)) => {
            if let (Some(root_dir), Some(self_writes)) = (root_dir, self_writes) {
                validate_workspace_root(root_dir, root_guard)?;
                materialize_scene_asset_deletes(
                    store,
                    root_dir,
                    &input.workspace_id,
                    &asset_jobs,
                    self_writes,
                    faults,
                    root_guard,
                )?;
            }
            Ok(result)
        }
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

#[cfg(test)]
mod capture_secret_root_guard_tests {
    use super::*;
    use crate::WorkspaceSupervisor;
    use dohc_engine_testkit::ScratchDir;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;

    const WORKSPACE_ID: &str = "workspace";
    const VERSION_ID: &str = "main";
    const SECRET_PATH: &str = ".env";

    struct BoundRootGuard {
        identity: file_id::FileId,
    }

    impl BoundRootGuard {
        fn bind(root: &std::path::Path) -> Self {
            Self {
                identity: file_id::get_file_id(root).expect("bind workspace root identity"),
            }
        }
    }

    impl WorkspaceRootGuard for BoundRootGuard {
        fn validate(&self, root_dir: &std::path::Path) -> Result<(), RuntimeError> {
            (file_id::get_file_id(root_dir).ok() == Some(self.identity))
                .then_some(())
                .ok_or(RuntimeError::Identity {
                    reason: "workspace root changed during capture",
                    source: None,
                })
        }
    }

    struct PausedRootGuard {
        bound: BoundRootGuard,
        reached: (Mutex<bool>, Condvar),
        released: (Mutex<bool>, Condvar),
    }

    impl PausedRootGuard {
        fn bind(root: &std::path::Path) -> Arc<Self> {
            Arc::new(Self {
                bound: BoundRootGuard::bind(root),
                reached: (Mutex::new(false), Condvar::new()),
                released: (Mutex::new(false), Condvar::new()),
            })
        }

        fn wait_until_reached(&self) {
            let reached = self.reached.0.lock().expect("lock reached state");
            let (reached, timeout) = self
                .reached
                .1
                .wait_timeout_while(reached, Duration::from_secs(10), |reached| !*reached)
                .expect("wait for actor blocker");
            assert!(*reached, "actor did not reach the blocking command");
            assert!(!timeout.timed_out(), "actor blocker timed out");
        }

        fn release(&self) {
            let mut released = self.released.0.lock().expect("lock release state");
            *released = true;
            self.released.1.notify_all();
        }
    }

    impl WorkspaceRootGuard for PausedRootGuard {
        fn validate(&self, root_dir: &std::path::Path) -> Result<(), RuntimeError> {
            {
                let mut reached = self.reached.0.lock().expect("lock reached state");
                *reached = true;
                self.reached.1.notify_all();
            }
            let released = self.released.0.lock().expect("lock release state");
            let (released, timeout) = self
                .released
                .1
                .wait_timeout_while(released, Duration::from_secs(10), |released| !*released)
                .expect("wait for root replacement");
            if timeout.timed_out() || !*released {
                return Err(RuntimeError::Identity {
                    reason: "test root guard release timed out",
                    source: None,
                });
            }
            self.bound.validate(root_dir)
        }
    }

    #[test]
    fn queued_owner_outbox_mutations_observe_cancellation_before_storage() {
        for method in ["append", "acknowledge", "quarantine"] {
            for abandon_reply in [false, true] {
                let store_scratch = ScratchDir::new().expect("store scratch");
                let root_scratch = ScratchDir::new().expect("root scratch");
                let root = root_scratch.path().to_path_buf();
                let db =
                    dohc_engine_testkit::engine_db_path(&store_scratch).expect("database path");
                let mut store = EngineStore::open(&db, 1).expect("seed store");
                VersionedTextStore::new(&mut store)
                    .ensure_main_version(WORKSPACE_ID, VERSION_ID, 1, &NoFaults)
                    .expect("main version");
                let input = OwnerOutboxAppendInput {
                    binding: dohc_engine_collab::LiveObjectBinding {
                        workspace_id: WORKSPACE_ID.to_owned(),
                        main_version_id: VERSION_ID.to_owned(),
                        object_id: "object-1".to_owned(),
                        lineage_claim_id: "lineage-1".to_owned(),
                        current_path: "owner.md".to_owned(),
                        selector_paths: vec!["owner.md".to_owned()],
                        restore_fence_generation: 0,
                    },
                    base_update: b"base".to_vec(),
                    update: b"seed".to_vec(),
                    append_key: "seed".to_owned(),
                    limits: dohc_engine_collab::OwnerOutboxLimits {
                        max_pending_bytes: 1000,
                        max_pending_age_ms: 1000,
                    },
                    created_at_ms: 1,
                };
                let appended = append_owner_outbox(&mut store, WORKSPACE_ID, input.clone())
                    .expect("seed append");
                let before = dohc_engine_collab::read_pending_owner_outbox(
                    &store,
                    WORKSPACE_ID,
                    &appended.outbox_id,
                )
                .expect("seed pending");
                drop(store);
                let supervisor = WorkspaceSupervisor::new();
                let actor = supervisor.open(&db, 1).expect("actor").actor;
                let blocker = PausedRootGuard::bind(&root);
                let blocker_guard: Arc<dyn WorkspaceRootGuard> = blocker.clone();
                let (blocker_reply, blocker_rx) = oneshot::channel();
                let blocker_input = CaptureRetire {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    path: "missing.md".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 2,
                    request_id: None,
                    only_if_text_head: false,
                    only_if_capture_origin: true,
                    allow_ydoc_origin: true,
                };
                let workspace_root: Option<CommandWorkspaceRoot> =
                    Some((root, Some(blocker_guard)));
                let leases = LeaseRegistry::new();
                let blocker_token = CancellationToken::new();
                actor
                    .tx
                    .blocking_send(Command::Run(Box::new(move |store, cache| {
                        let (root_dir, root_guard) =
                            command_workspace_root_parts(workspace_root.as_ref());
                        let outcome = with_local_file_mutation_cache_reset(cache, || {
                            capture_retire_on_store(
                                store,
                                &blocker_input,
                                root_dir,
                                root_guard,
                                None,
                                &leases,
                                &NoFaults,
                                &blocker_token,
                            )
                        });
                        let _ = blocker_reply.send(outcome);
                    })))
                    .expect("queue blocker");
                blocker.wait_until_reached();
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("runtime");
                let token = CancellationToken::new();
                let pending = async {
                    match method {
                        "append" => actor
                            .owner_ydoc_outbox_append(
                                WORKSPACE_ID.to_owned(),
                                OwnerOutboxAppendInput {
                                    append_key: "cancelled".to_owned(),
                                    update: b"cancelled update".to_vec(),
                                    ..input
                                },
                                token.clone(),
                            )
                            .await
                            .map(|outcome| outcome.map(|_| ())),
                        "acknowledge" => actor
                            .owner_ydoc_outbox_acknowledge(
                                WORKSPACE_ID.to_owned(),
                                appended.outbox_id.clone(),
                                vec![OwnerDeliveryReceipt {
                                    delivery_id: before.entries[0].delivery_id.clone(),
                                    update_digest: before.entries[0].update_digest.clone(),
                                    journal_cursor: 1,
                                    accepting_host_epoch: 1,
                                }],
                                token.clone(),
                            )
                            .await
                            .map(|outcome| outcome.map(|_| ())),
                        _ => {
                            actor
                                .owner_ydoc_outbox_quarantine(
                                    WORKSPACE_ID.to_owned(),
                                    OwnerOutboxQuarantineInput {
                                        outbox_id: appended.outbox_id.clone(),
                                        reason: "cancelled quarantine".to_owned(),
                                        observed_binding: None,
                                    },
                                    token.clone(),
                                )
                                .await
                        }
                    }
                };
                let mut pending = Some(Box::pin(pending));
                let was_pending = runtime.block_on(std::future::poll_fn(|cx| {
                    std::task::Poll::Ready(
                        std::future::Future::poll(pending.as_mut().expect("future").as_mut(), cx)
                            .is_pending(),
                    )
                }));
                // The empty actor channel accepted the command on that poll;
                // the earlier command still holds the writer. Service teardown
                // cancels this same token when its reply future is dropped.
                token.cancel();
                if abandon_reply || !was_pending {
                    drop(pending.take());
                }
                let (drained_reply, drained_rx) = oneshot::channel();
                actor
                    .tx
                    .blocking_send(Command::Run(Box::new(move |store, _cache| {
                        let outcome = capture_manifest_seed(store, WORKSPACE_ID, VERSION_ID)
                            .map_err(RuntimeError::from);
                        let _ = drained_reply.send(outcome);
                    })))
                    .expect("queue read barrier after cancelled mutation");
                blocker.release();
                let blocker_result = blocker_rx.blocking_recv();
                let result = pending.map(|pending| runtime.block_on(pending));
                let drained_result = drained_rx.blocking_recv();
                drop(actor);
                supervisor
                    .close(&db)
                    .expect("close actor after queue drains");
                let store = EngineStore::open_read_only(&db).expect("read store");
                let after = dohc_engine_collab::read_pending_owner_outbox(
                    &store,
                    WORKSPACE_ID,
                    &appended.outbox_id,
                )
                .expect("retained pending");
                assert!(was_pending, "{method} must enter the held actor queue");
                assert!(blocker_result.is_ok(), "blocker reply must complete");
                assert!(
                    drained_result.is_ok(),
                    "read barrier must run before closing the actor"
                );
                if !abandon_reply {
                    assert!(
                        matches!(result, Some(Err(RuntimeError::Cancelled))),
                        "{method}"
                    );
                }
                assert_eq!(after, before, "{method}, abandoned reply={abandon_reply}");
            }
        }
    }

    struct RejectSecondValidation {
        calls: AtomicUsize,
    }

    impl WorkspaceRootGuard for RejectSecondValidation {
        fn validate(&self, _root_dir: &std::path::Path) -> Result<(), RuntimeError> {
            if self.calls.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(RuntimeError::Identity {
                    reason: "workspace root changed during capture",
                    source: None,
                })
            }
        }
    }

    #[test]
    fn capture_batch_rolls_back_version_bootstrap_when_final_root_fence_rejects() {
        const PATH: &str = "notes/fenced.md";

        let store_scratch = ScratchDir::new().expect("store scratch");
        let root_scratch = ScratchDir::new().expect("workspace root scratch");
        let root = root_scratch.path();
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let mut store = EngineStore::open(&db, 1).expect("open store");
        let guard = RejectSecondValidation {
            calls: AtomicUsize::new(0),
        };
        let result = capture_ingest_batch_on_store(
            &mut store,
            &[CaptureIngest {
                workspace_id: WORKSPACE_ID.to_owned(),
                version_id: VERSION_ID.to_owned(),
                path: PATH.to_owned(),
                text: "fenced body".to_owned(),
                metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
                metadata_summary: Some("Reconciled offline edits".to_owned()),
                metadata_correlation_id: Some("second-root-fence".to_owned()),
                author_json: None,
                now_ms: 2,
                request_id: None,
                claim_foreign_head: false,
            }],
            &Arc::new(read_engine_search_policy(root)),
            &LeaseRegistry::new(),
            &NoFaults,
            &CancellationToken::new(),
            (root, &guard),
        );

        assert!(matches!(
            result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert_eq!(guard.calls.load(AtomicOrdering::SeqCst), 2);
        assert!(
            VersionedTextStore::new(&mut store)
                .get_main_version(WORKSPACE_ID)
                .expect("read rolled-back version")
                .is_none(),
            "the rejected transaction must roll back its version bootstrap"
        );
        let durable_rows = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM versions WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM path_aliases WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM moments WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM file_objects WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM replication_log WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM engine_search_files_fts WHERE workspace_id=?1)",
                    [WORKSPACE_ID],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("count rolled-back rows");
        assert_eq!(durable_rows, 0);
    }

    #[test]
    fn queued_capture_batch_refuses_a_replacement_workspace_root() {
        const PATH: &str = "notes/queued.md";

        let store_scratch = ScratchDir::new().expect("store scratch");
        let root_scratch = ScratchDir::new().expect("workspace root scratch");
        let moved_scratch = ScratchDir::new().expect("moved root scratch");
        let root = root_scratch.path().to_path_buf();
        let moved_root = moved_scratch.path().join("original-root");
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        std::fs::create_dir_all(root.join("notes")).expect("create original notes");
        std::fs::write(root.join(PATH), b"original body").expect("write original file");

        // Hold the writer on a command already ahead of the batch. Enqueuing
        // both commands directly proves the root replacement happens after the
        // batch entered the actor queue and before its transaction can start.
        let blocker = PausedRootGuard::bind(&root);
        let blocker_guard: Arc<dyn WorkspaceRootGuard> = blocker.clone();
        let (blocker_reply, blocker_reply_rx) = oneshot::channel();
        let input: CaptureRetire = CaptureRetire {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            path: "missing.md".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            now_ms: 2,
            request_id: None,
            only_if_text_head: false,
            only_if_capture_origin: true,
            allow_ydoc_origin: true,
        };
        let workspace_root: Option<CommandWorkspaceRoot> =
            Some((root.clone(), Some(blocker_guard)));
        let self_writes: Option<Arc<dyn SelfWriteRecorder>> = None;
        let leases: LeaseRegistry = LeaseRegistry::new();
        let faults: Arc<dyn FaultInjector> = Arc::new(NoFaults);
        let token: CancellationToken = CancellationToken::new();
        actor
            .tx
            .blocking_send(Command::Run(Box::new(move |store, cache| {
                let (root_dir, root_guard) = command_workspace_root_parts(workspace_root.as_ref());
                let outcome = with_local_file_mutation_cache_reset(cache, || {
                    capture_retire_on_store(
                        store,
                        &input,
                        root_dir,
                        root_guard,
                        self_writes.as_deref(),
                        &leases,
                        faults.as_ref(),
                        &token,
                    )
                });
                let _ = blocker_reply.send(outcome);
            })))
            .expect("queue actor blocker");
        blocker.wait_until_reached();

        let captured_guard: Arc<dyn WorkspaceRootGuard> = Arc::new(BoundRootGuard::bind(&root));
        let (batch_reply, batch_reply_rx) = oneshot::channel();
        let inputs: Vec<CaptureIngest> = vec![CaptureIngest {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            path: PATH.to_owned(),
            text: "original body".to_owned(),
            metadata_origin: dohc_engine_domain::store::CAPTURE_ORIGIN.to_owned(),
            metadata_summary: Some("Reconciled offline edits".to_owned()),
            metadata_correlation_id: Some("queued-root-swap".to_owned()),
            author_json: None,
            now_ms: 3,
            request_id: None,
            claim_foreign_head: false,
        }];
        let search_policy: Arc<SearchPolicySnapshot> = Arc::new(read_engine_search_policy(&root));
        let leases: LeaseRegistry = LeaseRegistry::new();
        let faults: Arc<dyn FaultInjector> = Arc::new(NoFaults);
        let root_dir: PathBuf = root.clone();
        let root_guard: Arc<dyn WorkspaceRootGuard> = captured_guard;
        let token: CancellationToken = CancellationToken::new();
        actor
            .tx
            .blocking_send(Command::Run(Box::new(move |store, cache| {
                let outcome = with_local_file_mutation_cache_reset(cache, || {
                    capture_ingest_batch_on_store(
                        store,
                        &inputs,
                        &search_policy,
                        &leases,
                        faults.as_ref(),
                        &token,
                        (&root_dir, root_guard.as_ref()),
                    )
                });
                let _ = batch_reply.send(outcome);
            })))
            .expect("queue capture batch behind blocker");

        std::fs::rename(&root, &moved_root).expect("move original workspace root");
        std::fs::create_dir_all(root.join("notes")).expect("create replacement notes");
        std::fs::write(root.join(PATH), b"replacement body").expect("write replacement file");
        let replacement_before = std::fs::read(root.join(PATH)).expect("read replacement file");
        blocker.release();
        let blocker_result = blocker_reply_rx
            .blocking_recv()
            .expect("receive blocker result");
        let batch_result = batch_reply_rx
            .blocking_recv()
            .expect("receive batch result");
        let replacement_after = std::fs::read(root.join(PATH)).expect("reread replacement file");

        std::fs::remove_dir_all(&root).expect("remove replacement workspace root");
        std::fs::rename(&moved_root, &root).expect("restore original workspace root");
        drop(actor);
        supervisor.close(&db).expect("close actor");
        let mut store = EngineStore::open(&db, 5).expect("reopen store");
        let main_version = VersionedTextStore::new(&mut store)
            .get_main_version(WORKSPACE_ID)
            .expect("read refused workspace version");
        let durable_rows = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT \
                       (SELECT COUNT(*) FROM path_aliases WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM snapshots WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM moments WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM file_objects WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM replication_log WHERE workspace_id=?1) + \
                       (SELECT COUNT(*) FROM engine_search_files_fts WHERE workspace_id=?1)",
                    [WORKSPACE_ID],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("count durable capture rows");

        assert!(matches!(
            blocker_result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert!(matches!(
            batch_result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert!(
            main_version.is_none(),
            "the queued batch must not create a version"
        );
        assert_eq!(
            durable_rows, 0,
            "snapshots, moments, replication, and search must remain unchanged"
        );
        assert_eq!(replacement_after, replacement_before);
    }

    #[test]
    fn queued_capture_secret_retire_refuses_a_replacement_workspace_root() {
        let store_scratch = ScratchDir::new().expect("store scratch");
        let root_scratch = ScratchDir::new().expect("workspace root scratch");
        let moved_scratch = ScratchDir::new().expect("moved root scratch");
        let root = root_scratch.path().to_path_buf();
        let moved_root = moved_scratch.path().join("original-root");
        let db = dohc_engine_testkit::engine_db_path(&store_scratch).expect("engine db path");
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 1).expect("open actor").actor;
        std::fs::write(root.join(SECRET_PATH), b"TOKEN=original").expect("write original secret");
        actor
            .capture_secret_blocking(
                CaptureSecret {
                    workspace_id: WORKSPACE_ID.to_owned(),
                    version_id: VERSION_ID.to_owned(),
                    path: SECRET_PATH.to_owned(),
                    text: "TOKEN=original".to_owned(),
                    metadata_origin: "local-file".to_owned(),
                    metadata_correlation_id: None,
                    now_ms: 2,
                    claim_foreign_head: true,
                },
                SecretDataKey::from_bytes(&[0x41; 32]).expect("secret key"),
                Arc::new(NoFaults),
            )
            .expect("seed captured secret");
        std::fs::remove_file(root.join(SECRET_PATH)).expect("observe original secret removal");

        // Hold the worker on a command already ahead of the secret retire.
        // Sending the retire below therefore proves it entered the real actor
        // queue before the pathname is rebound to a replacement directory.
        let blocker = PausedRootGuard::bind(&root);
        let blocker_guard: Arc<dyn WorkspaceRootGuard> = blocker.clone();
        let (blocker_reply, blocker_reply_rx) = oneshot::channel();
        let input: CaptureRetire = CaptureRetire {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            path: "missing.md".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            now_ms: 3,
            request_id: None,
            only_if_text_head: false,
            only_if_capture_origin: true,
            allow_ydoc_origin: true,
        };
        let workspace_root: Option<CommandWorkspaceRoot> =
            Some((root.clone(), Some(blocker_guard)));
        let self_writes: Option<Arc<dyn SelfWriteRecorder>> = None;
        let leases: LeaseRegistry = LeaseRegistry::new();
        let faults: Arc<dyn FaultInjector> = Arc::new(NoFaults);
        let token: CancellationToken = CancellationToken::new();
        actor
            .tx
            .blocking_send(Command::Run(Box::new(move |store, cache| {
                let (root_dir, root_guard) = command_workspace_root_parts(workspace_root.as_ref());
                let outcome = with_local_file_mutation_cache_reset(cache, || {
                    capture_retire_on_store(
                        store,
                        &input,
                        root_dir,
                        root_guard,
                        self_writes.as_deref(),
                        &leases,
                        faults.as_ref(),
                        &token,
                    )
                });
                let _ = blocker_reply.send(outcome);
            })))
            .expect("queue actor blocker");
        blocker.wait_until_reached();

        let captured_guard: Arc<dyn WorkspaceRootGuard> = Arc::new(BoundRootGuard::bind(&root));
        let (retire_reply, retire_reply_rx) = oneshot::channel();
        let input: CaptureSecretRetire = CaptureSecretRetire {
            workspace_id: WORKSPACE_ID.to_owned(),
            version_id: VERSION_ID.to_owned(),
            path: SECRET_PATH.to_owned(),
            metadata_origin: "local-file".to_owned(),
            metadata_correlation_id: None,
            now_ms: 4,
            only_if_own_origin: true,
        };
        let workspace_root: Option<CommandWorkspaceRoot> =
            Some((root.clone(), Some(captured_guard)));
        let faults: Arc<dyn FaultInjector> = Arc::new(NoFaults);
        let token: CancellationToken = CancellationToken::new();
        actor
            .tx
            .blocking_send(Command::Run(Box::new(move |store, _cache| {
                let (root_dir, root_guard) = command_workspace_root_parts(workspace_root.as_ref());
                let outcome = capture_secret_retire_on_store(
                    store,
                    &input,
                    root_dir,
                    root_guard,
                    faults.as_ref(),
                    &token,
                );
                let _ = retire_reply.send(outcome);
            })))
            .expect("queue secret retire behind blocker");

        std::fs::rename(&root, &moved_root).expect("move original workspace root");
        std::fs::create_dir(&root).expect("create replacement workspace root");
        std::fs::write(root.join(SECRET_PATH), b"TOKEN=replacement")
            .expect("write replacement secret");
        let replacement_before =
            std::fs::read(root.join(SECRET_PATH)).expect("read replacement secret");
        blocker.release();
        let blocker_result = blocker_reply_rx
            .blocking_recv()
            .expect("receive blocker result");
        let retire_result = retire_reply_rx
            .blocking_recv()
            .expect("receive secret retire result");
        let replacement_after =
            std::fs::read(root.join(SECRET_PATH)).expect("reread replacement secret");

        std::fs::remove_dir_all(&root).expect("remove replacement workspace root");
        std::fs::rename(&moved_root, &root).expect("restore original workspace root");
        drop(actor);
        supervisor.close(&db).expect("close actor");
        let store = EngineStore::open(&db, 5).expect("reopen store");
        let retained = secret_file_len_keyless(&store, WORKSPACE_ID, VERSION_ID, SECRET_PATH)
            .expect("read retained secret tip");

        assert!(matches!(
            blocker_result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
        assert_eq!(retained, Some(14), "the current encrypted tip must survive");
        assert_eq!(replacement_after, replacement_before);
        assert!(matches!(
            retire_result,
            Err(RuntimeError::Identity {
                reason: "workspace root changed during capture",
                ..
            })
        ));
    }
}
