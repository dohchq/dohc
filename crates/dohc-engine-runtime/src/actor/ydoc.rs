use super::ActorHandle;
use super::capture::{WorkspaceRootGuard, validate_workspace_root};
use super::journal::journal_moment_outbound_in_tx;
use super::materialization::{
    MaterializationReplayScope, SelfWriteRecorder, replay_pending_materializations,
};
use super::search::search_domain;
use super::versions::ensure_mutation_version_on_store;
use crate::error::RuntimeError;
use crate::search::upsert_file_search_index;
use dohc_engine_collab::{
    AppendOutcome, CacheStats, CloseOutcome, CollabError, ContentKind, DocKey, LineageClaimStatus,
    OwnerDeliveryReceipt, OwnerOutboxAcknowledgeResult, OwnerOutboxAppendInput,
    OwnerOutboxAppendResult, OwnerOutboxError, OwnerOutboxQuarantineInput, Projection, Regime,
    SceneAsset, WriterDocCache, Ydoc, acknowledge_owner_outbox, append_owner_outbox,
    encode_scene_asset_record, encode_scene_asset_records, import_portable_scene,
    quarantine_owner_outbox,
};
use dohc_engine_domain::{
    ChangeAttribution, DomainError, ProjectedWriteText, VersionedTextStore,
    collection_record_id_mismatch_in_tx, derive_capture_object_id, enqueue_write,
    is_collection_record_bound_in_tx, select_snapshot_by_path_in_tx,
    validate_addressable_plaintext_path, validate_plaintext_storable_path,
    write_projected_text_in_tx,
};
use dohc_engine_files::{
    DurabilityPolicy, JobOutcome, MaterializeError, MaterializeOptions, ProjectionTargetKind,
    ProjectionTargetState, StdBackoff, StdReplacer, materialize_one, probe_projection_target,
};
use dohc_engine_storage::{
    EngineStore, FaultInjector, JobStatus, NoFaults, Preimage, StorageError, TxnOutcome,
    hex_sha256, put_binary_blob,
};
use dohc_engine_sync::{SharingDeclined, ydoc_update_payload};
use rusqlite::{OptionalExtension, params};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Actor-owned snapshot used to establish one daemon Y.Doc session without
/// exposing the store connection to the protocol layer.
#[derive(Debug)]
pub struct YdocOpenState {
    pub key: DocKey,
    pub content_kind: ContentKind,
    pub regime: Regime,
    pub initial_update: Vec<u8>,
    /// The text head's blob sha at open time (None for an absent head) —
    /// the session's settle preimage expectation until its first settle.
    pub head_blob_sha256: Option<String>,
    pub owner_seed_source: Option<dohc_engine_collab::owner_base_source::OwnerSeedSource>,
    pub lineage_existing: bool,
    /// The lineage existed before this open and holds updates its workspace
    /// file may not. False for a lineage this open created or seeded.
    pub unsettled: bool,
    pub lineage_claim_id: Option<String>,
    pub restore_generation: Option<i64>,
    pub seed_content: Option<String>,
    pub artifact_assets: Vec<ArtifactAssetDescriptor>,
    pub seed_materialization_jobs: Vec<String>,
    /// Record facts the open's deferred drain committed, in drain order. The
    /// service emits them post-commit; they never claim automation
    /// triggers — drained updates are synced, and ADR 0008 gives the claim to
    /// the origin device alone.
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
}

pub type ArtifactAssetDescriptor = SceneAsset;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct YdocSeedMaterialization {
    pub materialized: bool,
    pub incomplete_jobs: usize,
    pub invalid_jobs: usize,
}

/// Actor-owned state returned when a live session refreshes its Y.Doc.
#[derive(Debug)]
pub struct YdocResyncState {
    pub initial_update: Vec<u8>,
    pub lineage_claim_id: Option<String>,
    pub recovered_paths: Vec<String>,
    pub artifact_assets: Vec<ArtifactAssetDescriptor>,
}

/// Result of the single moment+snapshot+materialization settlement path.
#[derive(Debug)]
pub struct YdocSettlement {
    pub moment_id: String,
    pub path: String,
    /// The settled artifact content, or `None` when it exceeds the in-band
    /// response cap. The cap bounds the RESPONSE, never durability: the file
    /// is written to disk and the moment committed either way.
    pub content: Option<String>,
    pub sha256: String,
    /// Whether the file on disk actually received these bytes. `false` means
    /// the settle committed durably (marker, moment, snapshot) but
    /// materialization was blocked by containment, so the write is pending a
    /// retry and the artifact on disk is still the old one. Callers must not
    /// report the document as saved on a `false`.
    pub materialized: bool,
    /// The settled rich-document head changed an engine-owned collection
    /// record id and must run through ordinary collection reconciliation.
    pub collection_reconcile_required: bool,
    pub projection: Projection,
}

/// What one settle attempt resolved to on the store thread. A settle whose
/// deferred drain lands remote content cannot settle — the client's doc is
/// behind — but the drained updates' record facts are already committed and
/// their queue rows consumed, so they must cross the mailbox with the
/// refusal or no path ever emits them.
#[derive(Debug)]
pub enum YdocSettleOutcome {
    Settled(Box<YdocSettlement>),
    /// Remote edits drained under this session's lease: the caller reports
    /// `ydoc-remote-updates-pending` after emitting the drained facts.
    RemoteUpdatesPending {
        record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    },
}

impl YdocSettleOutcome {
    /// The settlement, or `None` for the remote-updates-pending refusal.
    pub fn settled(self) -> Option<Box<YdocSettlement>> {
        match self {
            Self::Settled(settlement) => Some(settlement),
            Self::RemoteUpdatesPending { .. } => None,
        }
    }

    /// Collapse to the settlement for an engine-internal settle (collection
    /// adoption, relation cleanup). Those callers settle with
    /// `drain_deferred = false` — they have no event route for drained
    /// record facts — so the remote-updates-pending arm is defensive: it
    /// restores the refusal rather than silently dropping facts.
    pub(super) fn into_settlement_for_internal_caller(
        self,
    ) -> Result<YdocSettlement, RuntimeError> {
        match self {
            Self::Settled(settlement) => Ok(*settlement),
            Self::RemoteUpdatesPending { .. } => {
                Err(dohc_engine_domain::DomainError::InvalidInput {
                    reason: "ydoc-remote-updates-pending",
                }
                .into())
            }
        }
    }
}

/// A close's actor-side result: the collab close outcome (`None` when no
/// lineage existed) plus the record facts the close's deferred drain
/// committed, which the service emits post-commit.
#[derive(Debug)]
pub struct YdocCloseSessionOutcome {
    pub outcome: Option<CloseOutcome>,
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
}

/// The settled content as the response may carry it: `None` once past the
/// in-band cap, where the caller reads the artifact from disk instead.
fn inband_settled_content(content: String) -> Option<String> {
    (content.len() <= dohc_engine_domain::INBAND_CONTENT_CAP_BYTES).then_some(content)
}

struct YdocCloseMaterialization {
    root_dir: PathBuf,
    self_writes: Arc<dyn SelfWriteRecorder>,
}

impl ActorHandle {
    pub async fn owner_ydoc_prepare_enrollment(
        &self,
        binding: dohc_engine_collab::LiveObjectBinding,
        namespace: String,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<
        Result<
            dohc_engine_collab::owner_outbox::enrollment::OwnerEnrollmentPreparation,
            OwnerOutboxError,
        >,
        RuntimeError,
    > {
        self.run(move |store, _cache| {
            let _reservation = reservation;
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            Ok(store.read_with(|conn| {
                dohc_engine_collab::owner_outbox::enrollment::prepare_in(conn, &binding, &namespace)
            }))
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn owner_ydoc_enroll(
        &self,
        workspace_id: String,
        input: dohc_engine_collab::owner_outbox::enrollment::OwnerEnrollmentInput,
        limits: dohc_engine_collab::OwnerOutboxLimits,
        now_ms: i64,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<
        Result<dohc_engine_collab::owner_outbox::draft::OwnerDraftDescriptor, OwnerOutboxError>,
        RuntimeError,
    > {
        self.run(move |store, cache| {
            let _reservation = reservation;
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let key = DocKey::new(
                &input.binding.workspace_id,
                &input.binding.main_version_id,
                &input.binding.object_id,
            )?;
            cache.remove(&key);
            Ok(
                match store.write_with(&NoFaults, |tx| {
                    dohc_engine_collab::owner_outbox::enrollment::enroll_in_tx(
                        tx,
                        &workspace_id,
                        &input,
                        &limits,
                        now_ms,
                    )
                }) {
                    Ok(TxnOutcome::Committed(result)) => Ok(result),
                    Ok(TxnOutcome::Crashed { .. }) => Err(OwnerOutboxError::Corrupt),
                    Err(error) => Err(error),
                },
            )
        })
        .await
    }

    pub async fn owner_ydoc_draft_for_key(
        &self,
        key: DocKey,
        token: CancellationToken,
    ) -> Result<
        Result<
            Option<dohc_engine_collab::owner_outbox::draft::OwnerDraftDescriptor>,
            OwnerOutboxError,
        >,
        RuntimeError,
    > {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            Ok(store.read_with(|conn| {
                dohc_engine_collab::owner_outbox::draft::descriptor_for_key_in(conn, &key)
            }))
        })
        .await
    }

    pub async fn owner_ydoc_list_drafts(
        &self,
        workspace_id: String,
        after: Option<dohc_engine_collab::owner_outbox::draft::OwnerDraftCursor>,
        limit: usize,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<
        Result<
            Vec<dohc_engine_collab::owner_outbox::draft::OwnerDraftDescriptor>,
            OwnerOutboxError,
        >,
        RuntimeError,
    > {
        self.run(move |store, _cache| {
            let _reservation = reservation;
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            Ok(store.read_with(|conn| {
                dohc_engine_collab::owner_outbox::draft::list_drafts_in(
                    conn,
                    &workspace_id,
                    after.as_ref(),
                    limit,
                )
            }))
        })
        .await
    }

    pub async fn owner_ydoc_open_draft(
        &self,
        binding: dohc_engine_collab::LiveObjectBinding,
        revision: i64,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<
        Result<dohc_engine_collab::owner_outbox::draft::OwnerDraftSnapshot, OwnerOutboxError>,
        RuntimeError,
    > {
        self.run(move |store, cache| {
            let _reservation = reservation;
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            Ok(dohc_engine_collab::owner_outbox::draft::open_draft_cached(
                store, cache, &binding, revision,
            ))
        })
        .await
    }

    pub async fn owner_ydoc_append_draft(
        &self,
        workspace_id: String,
        input: dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<Result<OwnerOutboxAppendResult, OwnerOutboxError>, RuntimeError> {
        self.run(move |store, cache| {
            let _reservation = reservation;
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            Ok(
                dohc_engine_collab::owner_outbox::draft::append_draft_cached(
                    store,
                    cache,
                    &workspace_id,
                    input,
                    &NoFaults,
                ),
            )
        })
        .await
    }

    /// Main-owned authenticated feed only. A delivery ACK never calls this method.
    pub async fn owner_ydoc_apply_accepted(
        &self,
        workspace_id: String,
        input: dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput,
        now_ms: i64,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<
        Result<
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameResult,
            OwnerOutboxError,
        >,
        RuntimeError,
    > {
        self.owner_ydoc_apply_ordered(workspace_id, input, None, now_ms, token, reservation)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn owner_ydoc_apply_initial_sync(
        &self,
        workspace_id: String,
        input: dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput,
        host_vector: Vec<u8>,
        now_ms: i64,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<
        Result<
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameResult,
            OwnerOutboxError,
        >,
        RuntimeError,
    > {
        self.owner_ydoc_apply_ordered(
            workspace_id,
            input,
            Some(host_vector),
            now_ms,
            token,
            reservation,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn owner_ydoc_apply_ordered(
        &self,
        workspace_id: String,
        input: dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput,
        host_vector: Option<Vec<u8>>,
        now_ms: i64,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<
        Result<
            dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameResult,
            OwnerOutboxError,
        >,
        RuntimeError,
    > {
        self.run(move |store, cache| {
            let _reservation = reservation;
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let key = DocKey::new(
                &input.binding.workspace_id,
                &input.binding.main_version_id,
                &input.binding.object_id,
            )?;
            cache.remove(&key);
            let result = store.write_with(&NoFaults, |tx| {
                if let Some(vector) = &host_vector {
                    dohc_engine_collab::owner_outbox::accepted::apply_sync_in_tx(
                        tx,
                        &workspace_id,
                        &input,
                        vector,
                        now_ms,
                    )
                } else {
                    dohc_engine_collab::owner_outbox::accepted::apply_frame_in_tx(
                        tx,
                        &workspace_id,
                        &input,
                        now_ms,
                    )
                }
            });
            let result = match result {
                Ok(TxnOutcome::Committed(result)) => Ok(result),
                Ok(TxnOutcome::Crashed { .. }) => Err(OwnerOutboxError::Corrupt),
                Err(error) => Err(error),
            };
            if result.is_ok() {
                dohc_engine_collab::maybe_compact(
                    store,
                    &key,
                    dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD,
                    &NoFaults,
                    now_ms,
                )?;
            }
            Ok(result)
        })
        .await
    }

    /// Main-owned accepted position used to resume the ordered native feed.
    pub async fn owner_ydoc_accepted_state(
        &self,
        binding: dohc_engine_collab::LiveObjectBinding,
        relay_database_namespace: String,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<
        Result<dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedState, OwnerOutboxError>,
        RuntimeError,
    > {
        self.run(move |store, _cache| {
            let _reservation = reservation;
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            Ok(store.read_with(|conn| {
                dohc_engine_collab::owner_outbox::accepted::read_state_in(
                    conn,
                    &binding,
                    &relay_database_namespace,
                )
            }))
        })
        .await
    }

    /// Local containment check for the current observed binding, never host authority.
    pub async fn owner_ydoc_is_receipt_applied(
        &self,
        binding: dohc_engine_collab::LiveObjectBinding,
        relay_database_namespace: String,
        receipt: OwnerDeliveryReceipt,
        token: CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<Result<bool, OwnerOutboxError>, RuntimeError> {
        self.run(move |store, _cache| {
            let _reservation = reservation;
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            Ok(store.read_with(|conn| {
                dohc_engine_collab::owner_outbox::accepted::is_receipt_applied_in(
                    conn,
                    &binding,
                    &relay_database_namespace,
                    &receipt,
                )
            }))
        })
        .await
    }

    pub async fn owner_ydoc_outbox_append(
        &self,
        workspace_id: String,
        input: OwnerOutboxAppendInput,
        token: CancellationToken,
    ) -> Result<Result<OwnerOutboxAppendResult, OwnerOutboxError>, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                Ok(append_owner_outbox(store, &workspace_id, input))
            }
        })
        .await
    }

    pub async fn owner_ydoc_outbox_acknowledge(
        &self,
        workspace_id: String,
        outbox_id: String,
        receipts: Vec<OwnerDeliveryReceipt>,
        token: CancellationToken,
    ) -> Result<Result<OwnerOutboxAcknowledgeResult, OwnerOutboxError>, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                Ok(acknowledge_owner_outbox(
                    store,
                    &workspace_id,
                    &outbox_id,
                    &receipts,
                ))
            }
        })
        .await
    }

    pub async fn owner_ydoc_outbox_quarantine(
        &self,
        workspace_id: String,
        input: OwnerOutboxQuarantineInput,
        token: CancellationToken,
    ) -> Result<Result<(), OwnerOutboxError>, RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                Ok(quarantine_owner_outbox(store, &workspace_id, input))
            }
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_open_state(
        &self,
        workspace_id: String,
        now_ms: i64,
        drain_deferred: bool,
        expected_key: Option<DocKey>,
        version_id: String,
        path: String,
        content_kind: Option<ContentKind>,
        token: CancellationToken,
    ) -> Result<YdocOpenState, RuntimeError> {
        self.ydoc_open_state_with_artifact_seed(
            workspace_id,
            now_ms,
            drain_deferred,
            expected_key,
            version_id,
            path,
            content_kind,
            false,
            token,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_open_state_with_artifact_seed(
        &self,
        workspace_id: String,
        now_ms: i64,
        drain_deferred: bool,
        expected_key: Option<DocKey>,
        version_id: String,
        path: String,
        content_kind: Option<ContentKind>,
        seed_from_artifact: bool,
        token: CancellationToken,
    ) -> Result<YdocOpenState, RuntimeError> {
        self.run(move |store, cache| {
            ydoc_open_state_on_store(
                store,
                cache,
                &workspace_id,
                now_ms,
                drain_deferred,
                expected_key.as_ref(),
                &version_id,
                &path,
                content_kind,
                seed_from_artifact,
                &token,
            )
        })
        .await
    }

    /// Report the content kind of durable Y.Doc state whose current CRDT
    /// projection is not the materialized version snapshot.
    pub async fn ydoc_version_unsettled_content_kind(
        &self,
        workspace_id: String,
        version_id: String,
        ignored_object_ids: Vec<String>,
        token: CancellationToken,
    ) -> Result<Option<ContentKind>, RuntimeError> {
        self.run(move |store, _| {
            ydoc_version_unsettled_content_kind_on_store(
                store,
                &workspace_id,
                &version_id,
                &ignored_object_ids,
                &token,
            )
        })
        .await
    }

    pub async fn ydoc_materialize_scene_seed_assets(
        &self,
        root_dir: PathBuf,
        workspace_id: String,
        job_ids: Vec<String>,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
    ) -> Result<YdocSeedMaterialization, RuntimeError> {
        self.run(move |store, _cache| {
            let selected: HashSet<String> = job_ids.into_iter().collect();
            reconcile_scene_asset_materialization_conflicts(store, &root_dir, &selected, now_ms)
                .and_then(|invalid_jobs| {
                    replay_pending_materializations(
                        store,
                        &root_dir,
                        MaterializationReplayScope {
                            workspace_id: &workspace_id,
                            self_writes: Some(self_writes.as_ref()),
                        },
                        now_ms,
                        &NoFaults,
                        Some(&selected),
                        false,
                    )?;
                    let completed = selected.iter().try_fold(0_usize, |count, job_id| {
                        store.load_materialization_job(job_id).map(|job| {
                            count
                                + usize::from(
                                    job.is_some_and(|job| job.status == JobStatus::Complete),
                                )
                        })
                    })?;
                    let incomplete_jobs = selected.len().saturating_sub(completed);
                    Ok(YdocSeedMaterialization {
                        materialized: invalid_jobs == 0 && incomplete_jobs == 0,
                        incomplete_jobs,
                        invalid_jobs,
                    })
                })
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_record_update(
        &self,
        key: DocKey,
        path: String,
        content_kind: ContentKind,
        regime: Regime,
        update: Vec<u8>,
        actor_origin_id: Option<String>,
        attribution: Option<ChangeAttribution>,
        expected_lineage_claim_id: Option<String>,
        require_empty_lineage: bool,
        seed_source: Option<dohc_engine_collab::owner_base_source::OwnerSeedSource>,
        request_id: Option<String>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        restore_generation: Option<i64>,
    ) -> Result<YdocAppend, RuntimeError> {
        self.run(move |store, cache| {
            ydoc_record_update_on_store(
                store,
                cache,
                &key,
                &path,
                content_kind,
                regime,
                &update,
                actor_origin_id,
                attribution,
                expected_lineage_claim_id,
                require_empty_lineage,
                seed_source,
                request_id,
                true,
                now_ms,
                faults.as_ref(),
                &token,
                restore_generation,
            )
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn ydoc_settle(
        &self,
        root_dir: PathBuf,
        key: DocKey,
        path: String,
        content_kind: ContentKind,
        expected_lineage_claim_id: Option<String>,
        expected_head_sha: Option<String>,
        session_id: String,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
        restore_generation: Option<i64>,
    ) -> Result<YdocSettleOutcome, RuntimeError> {
        self.run(move |store, cache| {
            ydoc_settle_on_store(
                store,
                cache,
                &root_dir,
                &key,
                &path,
                content_kind,
                true,
                expected_lineage_claim_id.as_deref(),
                expected_head_sha,
                None,
                &session_id,
                self_writes.as_ref(),
                now_ms,
                faults.as_ref(),
                &token,
                None,
                None,
                restore_generation,
                SettlementKind::Document,
            )
        })
        .await
    }

    pub async fn ydoc_resync(
        &self,
        key: DocKey,
        expected_lineage_claim_id: Option<String>,
        token: CancellationToken,
        restore_generation: Option<i64>,
    ) -> Result<YdocResyncState, RuntimeError> {
        self.run(move |store, cache| {
            ydoc_resync_on_store(
                store,
                cache,
                &key,
                expected_lineage_claim_id.as_deref(),
                &token,
                restore_generation,
            )
        })
        .await
    }

    /// Test evidence seam: observe the actor-local writer cache without
    /// exposing it through the product protocol.
    #[doc(hidden)]
    pub async fn ydoc_cache_stats_for_test(&self) -> Result<CacheStats, RuntimeError> {
        self.run(move |_store, cache| Ok(cache.stats())).await
    }

    /// Test evidence seam: force the next consumer down the cold path.
    #[doc(hidden)]
    pub async fn ydoc_cache_clear_for_test(&self) -> Result<CacheStats, RuntimeError> {
        self.run(move |_store, cache| {
            cache.clear();
            Ok(cache.stats())
        })
        .await
    }

    pub async fn ydoc_close_session(
        &self,
        key: DocKey,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<YdocCloseSessionOutcome, RuntimeError> {
        self.ydoc_close_session_inner(key, None, now_ms, faults, token)
            .await
    }

    /// Close a live Y.Doc and materialize only the projection jobs created by
    /// deferred updates that the close releases.
    pub async fn ydoc_close_session_materialized(
        &self,
        root_dir: PathBuf,
        key: DocKey,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<YdocCloseSessionOutcome, RuntimeError> {
        self.ydoc_close_session_inner(
            key,
            Some(YdocCloseMaterialization {
                root_dir,
                self_writes,
            }),
            now_ms,
            faults,
            token,
        )
        .await
    }

    async fn ydoc_close_session_inner(
        &self,
        key: DocKey,
        materialization: Option<YdocCloseMaterialization>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<YdocCloseSessionOutcome, RuntimeError> {
        self.run(move |store, cache| {
            ydoc_close_session_on_store(
                store,
                cache,
                &key,
                materialization.as_ref(),
                now_ms,
                faults.as_ref(),
                &token,
            )
        })
        .await
    }

    /// Move disk-conflicted Y.Doc recovery artifacts to deterministic free
    /// paths after capture has ingested the unexpected occupants.
    pub async fn repair_conflicted_ydoc_recoveries(
        &self,
        workspace_id: String,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<Vec<dohc_engine_sync::YdocRecoveryMaterialization>, RuntimeError> {
        self.run(move |store, cache| {
            let outcome = if token.is_cancelled() {
                Err(RuntimeError::Cancelled)
            } else {
                dohc_engine_sync::repair_conflicted_ydoc_recoveries(
                    store,
                    &workspace_id,
                    faults.as_ref(),
                )
                .map_err(RuntimeError::from)
            };
            // A proven-empty scan performed no lineage transaction, so it
            // must not invalidate an unrelated active writer session. Any
            // materialization or error can have changed lineage state.
            if !matches!(&outcome, Ok(recoveries) if recoveries.is_empty()) {
                cache.clear();
            }
            outcome
        })
        .await
    }
}

fn reconcile_scene_asset_materialization_conflicts(
    store: &EngineStore,
    root_dir: &std::path::Path,
    selected: &HashSet<String>,
    now_ms: i64,
) -> Result<usize, RuntimeError> {
    let mut invalid_jobs = 0;
    for job_id in selected {
        let Some(job) = store.load_materialization_job(job_id)? else {
            invalid_jobs += 1;
            continue;
        };
        if job.status != JobStatus::Conflict {
            continue;
        }
        match probe_projection_target(root_dir, &job.target_path, ProjectionTargetKind::Plaintext) {
            ProjectionTargetState::Absent => {
                if !store.requeue_materialization_conflict(job_id)? {
                    invalid_jobs += 1;
                }
            }
            ProjectionTargetState::Binary { sha256 } if sha256 == job.content_sha256 => {
                store.mark_materialization_complete(job_id, now_ms)?;
            }
            _ => invalid_jobs += 1,
        }
    }
    Ok(invalid_jobs)
}

/// Durable Y.Doc state exists when the lineage holds updates OR snapshots.
/// A pruned local-only marker (both zero) has NO durable state: opens report
/// it absent and settles refuse it (an empty projection must never clobber
/// the artifact).
fn ydoc_marker_has_durable_state(marker: &dohc_engine_collab::Marker) -> bool {
    // The claim status covers the replicated base-only lineage: claim_base inserts
    // the base snapshot at up_to_seq 0 without advancing head_snapshot_seq, so
    // the seq pair alone would misread a claimed base as absent (double-seed +
    // NoMarker settle refusals on a valid lineage).
    marker.head_update_seq > 0
        || marker.head_snapshot_seq > 0
        || marker.lineage_claim_status.has_claimed_base()
}

fn ydoc_version_unsettled_content_kind_on_store(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
    ignored_object_ids: &[String],
    token: &CancellationToken,
) -> Result<Option<ContentKind>, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let raw_lineages: Vec<(String, String, bool)> = store.read_with(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT docs.object_id, docs.content_kind, EXISTS ( \
                     SELECT 1 FROM ydoc_deferred_updates AS deferred \
                     WHERE deferred.workspace_id = docs.workspace_id \
                       AND deferred.version_id = docs.version_id \
                       AND deferred.object_id = docs.object_id \
                  ) \
                  FROM ydoc_docs AS docs \
                  WHERE docs.workspace_id = ?1 AND docs.version_id = ?2 \
                    AND (docs.head_update_seq > 0 OR docs.head_snapshot_seq > 0 \
                         OR docs.lineage_claim_status <> 'unclaimed' OR EXISTS ( \
                            SELECT 1 FROM ydoc_deferred_updates AS deferred \
                            WHERE deferred.workspace_id = docs.workspace_id \
                              AND deferred.version_id = docs.version_id \
                              AND deferred.object_id = docs.object_id \
                        ))",
            )
            .map_err(StorageError::corrupt_public)?;
        let rows = statement
            .query_map(params![workspace_id, version_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(StorageError::corrupt_public)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::corrupt_public)
    })?;
    let lineages = raw_lineages
        .into_iter()
        .map(|(object_id, content_kind, has_deferred_updates)| {
            Ok((
                object_id,
                ContentKind::parse(&content_kind)?,
                has_deferred_updates,
            ))
        })
        .collect::<Result<Vec<_>, CollabError>>()?;

    for (object_id, content_kind, has_deferred_updates) in lineages {
        if token.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if ignored_object_ids
            .iter()
            .any(|ignored| ignored == &object_id)
        {
            continue;
        }
        // Deferred updates are source-version state too, and a fork clones
        // neither them nor the Y.Doc lineage. Refuse even when the currently
        // integrated projection still happens to match its snapshot.
        if has_deferred_updates {
            return Ok(Some(content_kind));
        }
        let key = DocKey::new(workspace_id, version_id, object_id)?;
        let Some(persisted) = dohc_engine_collab::load_persisted(store, &key)? else {
            // The row predicate above says durable state exists. A missing
            // load is inconsistent and must fail closed for the fork.
            return Ok(Some(content_kind));
        };
        if persisted.doc.has_pending_dependencies() {
            return Ok(Some(content_kind));
        }
        let content_kind = persisted.marker.content_kind;
        let projected = project_ydoc_on_store(store, &key, &persisted.doc, content_kind)?;
        let projected_sha = hex_sha256(projected.content.as_bytes());
        let materialized_sha: Option<String> = store.read_with(|conn| {
            conn.query_row(
                "SELECT blob_sha256 FROM snapshots \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![workspace_id, version_id, key.object_id],
                // NULL for a binary head (schema v10). It matches no text
                // projection, and reading it as a plain String would raise
                // InvalidColumnType instead — `.optional()` absorbs only
                // QueryReturnedNoRows.
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(StorageError::corrupt_public)
            .map(Option::flatten)
        })?;
        let seed_source = dohc_engine_collab::read_seed_only_lineage_source(store, &key)?;
        let covered_by_seed = seed_source
            .as_deref()
            .is_some_and(|source| materialized_sha.as_deref() == Some(source));
        if materialized_sha.as_deref() != Some(projected_sha.as_str()) && !covered_by_seed {
            return Ok(Some(content_kind));
        }
    }
    Ok(None)
}

#[derive(Debug)]
struct SceneSeedAsset {
    descriptor: ArtifactAssetDescriptor,
    bytes: Vec<u8>,
    object_id: String,
    moment_id: String,
}

fn plan_scene_seed_assets(
    key: &DocKey,
    drawing_path: &str,
    drawing_moment_id: &str,
    files: BTreeMap<String, dohc_engine_collab::ImportedSceneFile>,
) -> Result<Vec<SceneSeedAsset>, RuntimeError> {
    files
        .into_values()
        .map(|file| {
            if file.bytes.len() > dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES {
                return Err(DomainError::PayloadTooLarge {
                    constraint: "MAX_CAPTURE_BINARY_FILE_BYTES",
                    limit_bytes: dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES,
                    observed_bytes: file.bytes.len(),
                }
                .into());
            }
            let sha256 = hex_sha256(&file.bytes);
            let path = validate_plaintext_storable_path(
                &dohc_engine_collab::scene_asset_ref(
                    &key.workspace_id,
                    &key.version_id,
                    &key.object_id,
                    &sha256,
                    &file.mime_type,
                )
                .map_err(|error| DomainError::InvalidInput {
                    reason: match error {
                        dohc_engine_collab::SceneImportError::Invalid { reason } => reason,
                    },
                })?,
            )?;
            let descriptor = ArtifactAssetDescriptor {
                id: file.id,
                mime_type: file.mime_type,
                created: file.created,
                path: path.clone(),
                sha256: sha256.clone(),
                last_retrieved: file.last_retrieved,
                version: file.version,
            };
            let identity = format!(
                "{}\0{}\0{}\0{}\0{}",
                key.workspace_id, key.version_id, drawing_path, drawing_moment_id, descriptor.id
            );
            Ok(SceneSeedAsset {
                descriptor,
                bytes: file.bytes,
                object_id: format!(
                    "scene-asset-object-{}",
                    hex_sha256(
                        format!(
                            "{}\0{}\0{}\0{}",
                            key.workspace_id, key.version_id, path, drawing_moment_id
                        )
                        .as_bytes()
                    )
                ),
                moment_id: format!("moment-scene-asset-{}", hex_sha256(identity.as_bytes())),
            })
        })
        .collect()
}

fn scene_asset_records(
    assets: &[SceneSeedAsset],
) -> Result<BTreeMap<String, String>, RuntimeError> {
    assets
        .iter()
        .map(|asset| {
            let descriptor = &asset.descriptor;
            encode_scene_asset_record(descriptor)
                .map(|record| (descriptor.id.clone(), record))
                .map_err(|error| {
                    let dohc_engine_collab::SceneImportError::Invalid { reason } = error;
                    RuntimeError::Domain(DomainError::InvalidInput { reason })
                })
        })
        .collect()
}

fn map_scene_asset_validation_error(error: dohc_engine_sync::SyncError) -> RuntimeError {
    match error {
        dohc_engine_sync::SyncError::RetryableState { .. } => {
            RuntimeError::YdocArtifactAssetsPending
        }
        error @ dohc_engine_sync::SyncError::ProjectionTooLarge { .. } => RuntimeError::Sync(error),
        dohc_engine_sync::SyncError::Storage(storage) => RuntimeError::Storage(storage),
        dohc_engine_sync::SyncError::FaultCrash => RuntimeError::OperationCrashed,
        _ => RuntimeError::YdocArtifactAssetsInvalid,
    }
}

fn validate_scene_artifact_assets_on_store(
    store: &EngineStore,
    key: &DocKey,
    doc: &Ydoc,
    assets: &[ArtifactAssetDescriptor],
) -> Result<Vec<String>, RuntimeError> {
    store.read_with(|conn| {
        dohc_engine_sync::project_ydoc_with_store(conn, key, doc, ContentKind::Scene)
            .map_err(map_scene_asset_validation_error)?;
        let folded = doc.fold_scene();
        let live_asset_ids: HashSet<&str> = folded
            .elements
            .iter()
            .filter(|element| {
                element.get("type").and_then(serde_json::Value::as_str) == Some("image")
            })
            .filter_map(|element| element.get("fileId").and_then(serde_json::Value::as_str))
            .collect();
        for asset in assets {
            if live_asset_ids.contains(asset.id.as_str()) {
                continue;
            }
            let folded_asset = folded
                .assets
                .get(&asset.id)
                .ok_or(RuntimeError::YdocArtifactAssetsInvalid)?;
            dohc_engine_sync::validate_scene_asset_with_store(conn, key, folded_asset)
                .map_err(map_scene_asset_validation_error)?;
        }
        let mut pending_jobs = Vec::new();
        for asset in assets {
            let mut statement = conn
                .prepare(
                    "SELECT job_id,status FROM materialization_jobs \
                     WHERE workspace_id = ?1 AND target_path = ?2 \
                       AND content_sha256 = ?3 AND operation = 'write' \
                       AND status != 'complete' \
                     ORDER BY job_id",
                )
                .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
            let jobs = statement
                .query_map(params![key.workspace_id, asset.path, asset.sha256], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
            for job in jobs {
                let (job_id, status) =
                    job.map_err(|error| DomainError::Storage(StorageError::corrupt_public(error)))?;
                if status == "cancelled" {
                    return Err(RuntimeError::YdocArtifactAssetsInvalid);
                }
                pending_jobs.push(job_id);
            }
        }
        Ok::<_, RuntimeError>(pending_jobs)
    })
}

fn scene_asset_descriptors_for_open(doc: &Ydoc) -> Vec<ArtifactAssetDescriptor> {
    let folded = doc.fold_scene();
    folded
        .referenced_asset_ids
        .iter()
        .filter_map(|id| folded.assets.get(id))
        .cloned()
        .collect()
}

fn project_ydoc_on_store(
    store: &EngineStore,
    key: &DocKey,
    doc: &Ydoc,
    content_kind: ContentKind,
) -> Result<Projection, RuntimeError> {
    store.read_with(|conn| {
        dohc_engine_sync::project_ydoc_with_store(conn, key, doc, content_kind)
            .map_err(RuntimeError::from)
    })
}

#[allow(clippy::too_many_arguments)]
fn seed_scene_from_artifact_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    key: &DocKey,
    path: &str,
    artifact: &str,
    artifact_moment_id: &str,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<Vec<String>, RuntimeError> {
    const EMPTY_SCENE: &str = r#"{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[],"appState":{},"files":{}}"#;
    let imported = import_portable_scene(if artifact.trim().is_empty() {
        EMPTY_SCENE
    } else {
        artifact
    })
    .map_err(|error| match error {
        dohc_engine_collab::SceneImportError::Invalid { reason } => {
            RuntimeError::Domain(DomainError::InvalidInput { reason })
        }
    })?;
    let assets = plan_scene_seed_assets(key, path, artifact_moment_id, imported.files)?;
    let asset_update = encode_scene_asset_records(&scene_asset_records(&assets)?).map_err(
        |error| match error {
            dohc_engine_collab::SceneImportError::Invalid { reason } => {
                RuntimeError::Domain(DomainError::InvalidInput { reason })
            }
        },
    )?;
    let seed_update = dohc_engine_collab::merge_updates(&[imported.initial_update, asset_update])?;
    let request_id = format!(
        "ydoc-scene-seed-{}",
        hex_sha256(
            format!(
                "{}\0{}\0{}\0{}\0{}",
                key.workspace_id,
                key.version_id,
                key.object_id,
                artifact_moment_id,
                hex_sha256(artifact.as_bytes())
            )
            .as_bytes()
        )
    );
    // Only the moment ids whose head writes were actually enqueued: a planned
    // asset whose content-addressed path already holds matching content takes
    // the `continue` below and creates no moment, and counting it as a
    // materialization job would reject the open as pending forever. The
    // guarded closure can run again after a crash retry, so it rebuilds the
    // list from scratch each attempt.
    let mut created_moment_ids: Vec<String> = Vec::new();
    let outcome = dohc_engine_collab::record_local_update(
        store,
        doc_cache,
        key,
        &seed_update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some(path),
                content_kind: ContentKind::Scene,
                regime: Regime::LocalOnly,
            }),
            ensure_parent_row: true,
            require_empty_lineage: true,
            request_id: Some(&request_id),
            ..Default::default()
        },
        faults,
        now_ms,
        |tx, _, _update_sha| {
            created_moment_ids.clear();
            let version_is_active: bool = tx
                .query_row(
                    "SELECT ?2 = COALESCE( \
                         (SELECT version_id FROM active_versions WHERE workspace_id = ?1), \
                         (SELECT main_version_id FROM versioned_workspaces WHERE workspace_id = ?1))",
                    params![key.workspace_id, key.version_id],
                    |row| row.get(0),
                )
                .map_err(|error| CollabError::Corrupt {
                    reason: format!("scene asset active-version lookup failed: {error}"),
                })?;
            for asset in &assets {
                let existing: Option<(String, Option<String>)> = tx
                    .query_row(
                        "SELECT COALESCE(s.content_kind, 'text'), s.binary_sha256 \
                         FROM path_aliases a JOIN snapshots s \
                           ON s.workspace_id = a.workspace_id \
                          AND s.version_id = a.version_id AND s.object_id = a.object_id \
                         WHERE a.workspace_id = ?1 AND a.version_id = ?2 AND a.path = ?3",
                        params![key.workspace_id, key.version_id, asset.descriptor.path],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|error| CollabError::Corrupt {
                        reason: format!("scene asset head lookup failed: {error}"),
                    })?;
                if let Some((kind, sha256)) = existing {
                    if kind == "binary" && sha256.as_deref() == Some(&asset.descriptor.sha256) {
                        continue;
                    }
                    return Err(CollabError::Corrupt {
                        reason: "scene asset path is already bound to different content".to_owned(),
                    });
                }
                let stored_sha = put_binary_blob(tx, &asset.bytes)?;
                if stored_sha != asset.descriptor.sha256 {
                    return Err(CollabError::Corrupt {
                        reason: "scene asset content address changed while storing bytes"
                            .to_owned(),
                    });
                }
                dohc_engine_domain::write_binary_file_in_tx(
                    tx,
                    &dohc_engine_domain::WriteBinaryFile {
                        workspace_id: key.workspace_id.clone(),
                        version_id: key.version_id.clone(),
                        object_id: asset.object_id.clone(),
                        path: asset.descriptor.path.clone(),
                        binary_sha256: asset.descriptor.sha256.clone(),
                        moment_id: asset.moment_id.clone(),
                        metadata_origin: "ydoc".to_owned(),
                        metadata_summary: Some("Imported drawing asset".to_owned()),
                        metadata_correlation_id: Some(request_id.clone()),
                        author_json: None,
                        materialize: version_is_active.then_some(Preimage::Absent),
                        now_ms,
                    },
                )
                .map_err(|error| CollabError::Corrupt {
                    reason: format!("scene asset head write failed: {error}"),
                })?;
                journal_moment_outbound_in_tx(tx, &key.workspace_id, &asset.moment_id, false)
                    .map_err(|error| CollabError::Corrupt {
                        reason: format!("scene asset outbound journal failed: {error}"),
                    })?;
                created_moment_ids.push(asset.moment_id.clone());
            }
            Ok(())
        },
    )?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RuntimeError::OperationCrashed);
    }
    Ok(created_moment_ids)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn ydoc_open_state_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    workspace_id: &str,
    now_ms: i64,
    drain_deferred: bool,
    expected_key: Option<&DocKey>,
    version_id: &str,
    path: &str,
    requested_content_kind: Option<ContentKind>,
    seed_from_artifact: bool,
    token: &CancellationToken,
) -> Result<YdocOpenState, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    let canonical_path = validate_addressable_plaintext_path(path)?;
    // Bootstrap: the first live doc in an empty workspace must be creatable —
    // without this, read_text errors VersionNotFound before the absent-path
    // flow can run (capture normally creates main, but nothing has captured).
    ensure_mutation_version_on_store(store, workspace_id, version_id, now_ms, &NoFaults)?;
    let head =
        VersionedTextStore::new(store).read_text(workspace_id, version_id, &canonical_path)?;
    let head_sha = head.as_ref().map(|snapshot| snapshot.blob_sha256.clone());
    let object_id = match head.as_ref() {
        Some(snapshot) => snapshot.object_id.clone(),
        None => {
            // NO HEAD: the entered version does not contain this path. The
            // daemon still binds an empty doc, because that is how a file the
            // user just created (written to disk, not yet captured) becomes
            // editable. The open reports `head: "absent"` and the consumer
            // decides whether that is a creation or a path the version does
            // not have — the contract it applies is stated on
            // `WorkspaceEngineCapture.openYDocSession`
            // (apps/desktop/src/workspaces/workspaceEngineCapture.ts).
            let derived = derive_capture_object_id(workspace_id, version_id, &canonical_path);
            // A derived id still live at another alias means this path's
            // former file was renamed away: capture's locked resolution mints
            // an order-disambiguated id for that case, which open-time cannot
            // reserve pre-commit. Reusing the derived id would graft the new
            // document onto the renamed file's lineage, so refuse; a capture
            // or local write creates the path and reopening resumes normally.
            let collides = store.read_with(|conn| {
                dohc_engine_domain::object_has_live_alias(conn, workspace_id, &derived)
            })?;
            if collides {
                return Err(RuntimeError::Collab(
                    dohc_engine_collab::CollabError::ObjectAliasCollision,
                ));
            }
            derived
        }
    };
    let key = DocKey::new(workspace_id, version_id, object_id)?;
    let expected_key_matches = expected_key.is_none_or(|expected| *expected == key);
    let restore_generation = store.read_with(|conn| {
        dohc_engine_collab::live_update_application::restore_generation(conn, &key)
    })?;
    // An open sync conflict on this object freezes the open as well as the
    // settle: the claimed lineage may be a peer's unreviewed base, and
    // serving it would put the editor on the very side the conflict
    // preserves the head against — the user types into unreviewed content
    // and resolution rewrites the lineage under the live client. Refuse
    // with the same reason the settle freeze uses; resolution lifts both.
    // The check runs before the lineage clear and the deferred drain below:
    // both mutate durable state, and a drain whose open then refuses would
    // consume the parked rows — and the record facts persisted on them —
    // with no caller left to emit their events.
    if expected_key_matches
        && store
            .read_with(|conn| {
                dohc_engine_sync::open_sync_conflict_for_object(
                    conn,
                    &key.workspace_id,
                    &key.version_id,
                    &key.object_id,
                )
            })?
            .is_some()
    {
        return Err(dohc_engine_domain::DomainError::InvalidInput {
            reason: "ydoc-conflict-open",
        }
        .into());
    }
    // Retired artifact: the path has NO head (deleted on disk, capture
    // retired the snapshot/alias) but a LOCAL-ONLY lineage that claims a
    // settled artifact survived (workspace teardown skips the prune).
    // Markdown-is-the-artifact: the user deleted the document, so reopening
    // must not resurrect the stale cache — and its retained last_settled_sha
    // would wedge the next settle in ConflictStaleTarget (head None vs a
    // settled expectation). Clear the lineage; the open proceeds as absent.
    // A crashed never-settled draft (last_settled NULL) still resurrects —
    // its CRDT rows are the only copy of the user's edits. Replicated
    // lineages are durable canonical and never clear here.
    // POST-LEASE only (same gating as the drain): the pre-lease probe must
    // stay side-effect-free — a second opener's probe running this clear
    // while the first session still holds the lease would delete the live
    // session's unmaterialized CRDT state out from under it.
    if drain_deferred
        && expected_key_matches
        && head.is_none()
        && dohc_engine_collab::read_marker(store, &key)?
            .is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::LocalOnly)
        && dohc_engine_collab::read_last_settled_sha(store, &key)?.is_some()
    {
        // Invalidate before the reset. A committed crash returns before the
        // actor can run any post-transaction hook.
        doc_cache.remove(&key);
        let cleared = store.write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM ydoc_updates                  WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "DELETE FROM ydoc_snapshots                  WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "UPDATE ydoc_docs SET head_update_seq = 0, head_snapshot_seq = 0,                  last_settled_sha = NULL, settled_update_seq = NULL, seed_source_sha256 = NULL, updated_at_ms = ?4                  WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![key.workspace_id, key.version_id, key.object_id, now_ms],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })?;
        if matches!(cleared, TxnOutcome::Crashed { .. }) {
            return Err(RuntimeError::OperationCrashed);
        }
    }
    // Re-converge before loading state: an envelope acked-but-deferred while
    // a previous session held the lease is only guaranteed to drain on that
    // session's ydoc.close — workspace.close, stale-handle eviction, and a
    // crash all skip it. The imported replication log is the durable pending
    // queue, and replaying an already-applied row is content-deduped, so
    // draining on every open makes the parked update land on the next use
    // of the doc no matter how the previous session ended.
    // The drain only runs for the key the CALLER'S LEASE covers: if the
    // path's owner changed between the RPC's probe and this post-lease read,
    // the derived key belongs to a different object — possibly one a live
    // session already holds — and draining it here would mutate that doc
    // behind its active editor with no event or resync signal. The RPC layer
    // rejects the mismatched open right after; skipping the drain keeps this
    // read side-effect-free for the foreign key.
    let mut record_facts = Vec::new();
    if drain_deferred
        && restore_generation.is_none()
        && expected_key_matches
        && dohc_engine_collab::read_marker(store, &key)?
            .is_some_and(|marker| marker.regime == Regime::Replicated)
    {
        // Only the POST-LEASE read drains: a pre-lease probe mutating the
        // lineage while another session holds the lease would advance state
        // behind the active editor with no event or resync signal.
        let drained = drain_deferred_ydoc_for_local_rpc(store, doc_cache, &key, &NoFaults)?;
        record_facts = drained.record_facts;
    }
    // A post-lease open starts a live session on this doc: prefer keeping its
    // cache entry resident (eviction order only; a leaked pin never affects
    // correctness).
    if drain_deferred && expected_key_matches {
        doc_cache.pin(&key);
    }
    let mut persisted = dohc_engine_collab::load_persisted(store, &key)?;
    // "Existing" means durable DOC STATE, not a bare marker: a local-only
    // close prunes every CRDT row and leaves head_update_seq == 0
    // (the workspace file is the artifact). Reporting it as existing would
    // hand the client an empty doc with no seedContent — its next settle
    // would clobber the settled file. A pruned marker is seed-eligible
    // (the recordUpdate guard checks head_update_seq > 0), so the artifact
    // re-seeds the cache exactly like a first open. "Durable doc state"
    // means updates OR snapshots: a replicated lineage holding only its
    // base snapshot (head_update_seq == 0, head_snapshot_seq > 0) is
    // existing — reporting it absent would hand the client the base state
    // and a content seed, duplicating the artifact on the first seed apply.
    let mut lineage_existing = persisted
        .as_ref()
        .is_some_and(|persisted| ydoc_marker_has_durable_state(&persisted.marker));
    // Read before a scene seed below: a lineage this open seeds from its file
    // is not ahead of it.
    let unsettled = lineage_existing && !ydoc_file_holds_head(store, &key, head.as_ref())?;
    let mut seed_materialization_jobs = Vec::new();
    if drain_deferred
        && expected_key_matches
        && seed_from_artifact
        && requested_content_kind == Some(ContentKind::Scene)
        && !lineage_existing
        && let Some(artifact) = head.as_ref()
    {
        seed_materialization_jobs = seed_scene_from_artifact_on_store(
            store,
            doc_cache,
            &key,
            path,
            &artifact.text,
            &artifact.latest_moment_id,
            now_ms,
            &NoFaults,
        )?;
        persisted = dohc_engine_collab::load_persisted(store, &key)?;
        lineage_existing = persisted
            .as_ref()
            .is_some_and(|persisted| ydoc_marker_has_durable_state(&persisted.marker));
        if !lineage_existing {
            return Err(DomainError::StateCorrupt {
                reason: "scene artifact seed committed without durable Y.Doc state",
            }
            .into());
        }
    }
    let (
        content_kind,
        regime,
        initial_update,
        lineage_claim_id,
        artifact_assets,
        pending_asset_jobs,
    ) = match persisted {
        Some(persisted) => {
            let marker = &persisted.marker;
            let mut kind = marker.content_kind;
            // A bare local marker is a remembered default, not a lineage:
            // honor an explicit caller kind and rewrite the row (re-proved
            // bare inside the write transaction). Without this, a stale
            // default — e.g. the plaintext markers the dead editor path
            // minted for rich .md files — permanently overrides every later
            // richdoc open: empty doc over a non-empty file, typed edits
            // discarded at the pruning close.
            if let Some(requested) = requested_content_kind
                && requested != marker.content_kind
                && !lineage_existing
                && marker.regime == Regime::LocalOnly
                && marker.lineage_claim_status == LineageClaimStatus::Unclaimed
            {
                match dohc_engine_collab::rewrite_bare_marker_content_kind(
                    store, &key, requested, &NoFaults, now_ms,
                )? {
                    TxnOutcome::Committed(true) => kind = requested,
                    // A raced update/seed made the marker non-bare between
                    // the read and the write: the lineage owns its kind.
                    TxnOutcome::Committed(false) => {}
                    TxnOutcome::Crashed { .. } => {
                        return Err(RuntimeError::OperationCrashed);
                    }
                }
            }
            let artifact_assets = if kind == ContentKind::Scene {
                scene_asset_descriptors_for_open(&persisted.doc)
            } else {
                Vec::new()
            };
            let pending_asset_jobs = if kind == ContentKind::Scene {
                validate_scene_artifact_assets_on_store(
                    store,
                    &key,
                    &persisted.doc,
                    &artifact_assets,
                )?
            } else {
                Vec::new()
            };
            (
                kind,
                marker.regime,
                persisted.doc.encode_full_state(),
                marker.lineage_claim_id.clone(),
                artifact_assets,
                pending_asset_jobs,
            )
        }
        None => {
            let doc = Ydoc::wire();
            (
                // PLAINTEXT default when the caller does not specify: the
                // plaintext surfaces open without a contentKind; richdoc
                // callers (the desktop's rich-doc IPC path) pass the kind
                // explicitly.
                requested_content_kind.unwrap_or(ContentKind::Plaintext),
                Regime::LocalOnly,
                doc.encode_full_state(),
                None,
                Vec::new(),
                Vec::new(),
            )
        }
    };
    let seed_materialization_jobs = if content_kind == ContentKind::Scene {
        if !seed_materialization_jobs.is_empty() {
            let expected: HashSet<&str> = seed_materialization_jobs
                .iter()
                .map(String::as_str)
                .collect();
            if !pending_asset_jobs
                .iter()
                .all(|job| expected.contains(job.as_str()))
            {
                return Err(DomainError::StateCorrupt {
                    reason: "a seeded scene asset has an unexpected pending materialization",
                }
                .into());
            }
        }
        pending_asset_jobs
    } else {
        Vec::new()
    };
    Ok(YdocOpenState {
        owner_seed_source: head.as_ref().map(|snapshot| {
            dohc_engine_collab::owner_base_source::OwnerSeedSource {
                moment_id: snapshot.latest_moment_id.clone(),
                blob_sha256: snapshot.blob_sha256.clone(),
            }
        }),
        head_blob_sha256: head_sha,
        key,
        content_kind,
        regime,
        initial_update,
        lineage_existing,
        unsettled,
        lineage_claim_id,
        restore_generation,
        seed_content: (content_kind != ContentKind::Scene && !lineage_existing)
            .then(|| head.map(|snapshot| snapshot.text))
            .flatten(),
        artifact_assets,
        seed_materialization_jobs,
        record_facts,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn ydoc_record_update_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    key: &DocKey,
    path: &str,
    content_kind: ContentKind,
    regime: Regime,
    update: &[u8],
    actor_origin_id: Option<String>,
    attribution: Option<ChangeAttribution>,
    expected_lineage_claim_id: Option<String>,
    require_empty_lineage: bool,
    seed_source: Option<dohc_engine_collab::owner_base_source::OwnerSeedSource>,
    request_id: Option<String>,
    claim_triggers: bool,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
    restore_generation: Option<i64>,
) -> Result<YdocAppend, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    // Validation happens once, in the durable layer's `validate_update_bytes`,
    // inside the append transaction. The rows the transaction writes before it
    // (the path stamp, the ensured file_objects parent) roll back with the
    // rejection, so a malformed first seed cannot strand a bare file_objects
    // row for the deterministic object id (which regular writes then treat as
    // already existing).
    //
    // The origination decision is made inside the append transaction and read
    // after it commits, so a decline reported to the caller is one that
    // actually survived the commit.
    let mut sharing_declined: Option<SharingDeclined> = None;
    let mut automation_claims: Vec<dohc_engine_domain::AutomationClaim> = Vec::new();
    // An exact replicated lineage journals the ydoc.update delta in the same
    // transaction as the append. This keeps blob-before-log order and TS
    // parity. Local-only lineages journal nothing; their workspace file is the
    // artifact.
    let journal_key = key.clone();
    let journal_path = path.to_owned();
    let journal_kind = content_kind;
    match dohc_engine_collab::record_local_update(
        store,
        doc_cache,
        key,
        update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some(path),
                content_kind,
                regime,
            }),
            actor_origin_id: actor_origin_id.as_deref(),
            attribution: attribution.as_ref(),
            lineage_guard: dohc_engine_collab::LineageGuard::Expect(
                expected_lineage_claim_id.as_deref(),
            ),
            // Parent row, seed guard, marker, append, and outbound journal all
            // commit in one transaction — no bare-parent crash window, and a
            // timed-out-commit seed retry dedupes inside the guard instead of
            // refusing seed-onto-existing-lineage.
            ensure_parent_row: true,
            restore_generation,
            require_empty_lineage,
            seed_source_sha256: seed_source
                .as_ref()
                .map(|source| source.blob_sha256.as_str()),
            request_id: request_id.as_deref(),
        },
        faults,
        now_ms,
        |tx, outcome, update_sha| {
            dohc_engine_collab::owner_outbox::append_adopted_local_update_in_tx(
                tx,
                &journal_key,
                &journal_path,
                outcome.seq,
                update,
                now_ms,
            )?;
            if dohc_engine_collab::owner_outbox::has_adopted_owner_in(tx, &journal_key)? {
                outcome.emit_outbound = false;
                return Ok(());
            }
            // Origination is asked first and owns the base-once decision: it
            // originates only a lineage that has no base yet. The base is a
            // full state, so it already carries this append and every row the
            // lineage held before it — a delta beside it would be redundant.
            // Everything else journals its delta.
            let base_originated = match dohc_engine_sync::originate_ydoc_base_in_tx(
                tx,
                &journal_key,
                &journal_path,
                actor_origin_id.as_deref(),
                attribution.as_ref(),
                now_ms,
            )
            .map_err(|error| dohc_engine_collab::CollabError::Corrupt {
                reason: format!("outbound ydoc.update base origination failed: {error}"),
            })? {
                dohc_engine_sync::BaseOrigination::Originated { base_snapshot_sha } => {
                    if let Some(source) = &seed_source {
                        dohc_engine_collab::owner_base_source::retain_owner_base_source_in_tx(
                            tx,
                            &journal_key,
                            &journal_path,
                            &base_snapshot_sha,
                            source,
                        )?;
                    }
                    true
                }
                dohc_engine_sync::BaseOrigination::Declined(reason) => {
                    sharing_declined = Some(reason);
                    false
                }
                dohc_engine_sync::BaseOrigination::NothingToDo => false,
            };
            if !base_originated && outcome.emit_outbound {
                let lineage_claim_id = dohc_engine_collab::read_marker_in(tx, &journal_key)?
                    .and_then(|marker| marker.lineage_claim_id)
                    .ok_or_else(|| dohc_engine_collab::CollabError::Corrupt {
                        reason: "exact Y.Doc lineage has no claim id".to_owned(),
                    })?;
                let origin_seq = dohc_engine_sync::journal_local_op_in_tx(
                    tx,
                    &journal_key.workspace_id,
                    "ydoc.update",
                    &ydoc_update_payload(
                        &journal_key,
                        &journal_path,
                        journal_kind,
                        update_sha,
                        &lineage_claim_id,
                        actor_origin_id.as_deref(),
                        attribution.as_ref(),
                        false,
                    ),
                    now_ms,
                )
                .map_err(|error| dohc_engine_collab::CollabError::Corrupt {
                    // Named explicitly: an exact replicated lineage
                    // with NO sync identity is a half-initialized state
                    // (every real replicated flow runs sync init first —
                    // pulls require the identity and the TS driver creates
                    // it when journaling the base). Fail closed with a
                    // diagnosable reason rather than a generic failure; an
                    // identity cannot be seeded down here (origin identity
                    // is minted by sync init, not the collab layer).
                    reason: format!("outbound ydoc.update journal append failed: {error}"),
                })?;
                // The op's replication coordinate exists only now, after the
                // journal assigned it. Thread it into the facts so record
                // events and the automation trigger key see the same
                // coordinate every peer derives from the envelope. A
                // base-originated or never-synced apply keeps `None`; its
                // per-change key is the history row id.
                if let Some(facts) = outcome.record_facts.as_mut() {
                    let origin_id: String = tx
                        .query_row(
                            "SELECT origin_id FROM sync_identity WHERE workspace_id=?1",
                            [&journal_key.workspace_id],
                            |row| row.get(0),
                        )
                        .map_err(|error| dohc_engine_collab::CollabError::Corrupt {
                            reason: format!("journaled ydoc.update has no sync identity: {error}"),
                        })?;
                    facts.source = Some((origin_id, origin_seq));
                }
            }
            // The origin-device automation trigger (ADR 0008). This hook runs
            // only for ops this device journals — the sync apply path never
            // reaches it — so claiming here is origin-device execution by
            // construction. Same transaction as the append: a claim exists
            // exactly when the change it triggers on committed.
            // An engine-maintenance write (record id adoption, relation
            // cleanup) carries no attribution and is not a change anyone
            // authored: claiming on it would restart every chain at depth
            // zero and wake nothing, so those callers pass false.
            if let (true, Some(facts)) = (claim_triggers, outcome.record_facts.as_ref()) {
                automation_claims = dohc_engine_domain::claim_automation_triggers_in_tx(
                    tx,
                    &journal_key.workspace_id,
                    facts,
                    now_ms,
                )
                .map_err(|error| dohc_engine_collab::CollabError::Corrupt {
                    reason: format!("automation claim insert failed: {error}"),
                })?;
            }
            Ok(())
        },
    )? {
        TxnOutcome::Committed(outcome) => {
            let lineage_claim_id = dohc_engine_collab::read_marker(store, key)?
                .and_then(|marker| marker.lineage_claim_id);
            Ok(YdocAppend {
                outcome,
                sharing_declined,
                lineage_claim_id,
                automation_claims,
            })
        }
        TxnOutcome::Crashed { .. } => Err(RuntimeError::OperationCrashed),
    }
}

/// One recorded Y.Doc append, and what its origination attempt decided.
///
/// The append itself is [`AppendOutcome`]. `sharing_declined` is `Some` only
/// when this edit could have originated the lineage and did not — the edit
/// committed either way. The four ordinary reasons a lineage does not
/// originate stay silent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YdocAppend {
    pub outcome: AppendOutcome,
    pub sharing_declined: Option<dohc_engine_sync::SharingDeclined>,
    pub lineage_claim_id: Option<String>,
    /// Pending automation claims this append inserted (ADR 0008): one per
    /// subscribed automation, committed in the append's own transaction. The
    /// service emits `automation.claimed` for each, post-commit.
    pub automation_claims: Vec<dohc_engine_domain::AutomationClaim>,
}

/// Whether the workspace file holds every update in this lineage, so an open
/// can leave it alone. Every condition must hold, and any doubt answers no:
/// a settle recorded the current head, the version head is what that settle
/// (or the seed it imported) produced, and no write of that head is pending.
fn ydoc_file_holds_head(
    store: &EngineStore,
    key: &DocKey,
    head: Option<&dohc_engine_domain::TextSnapshot>,
) -> Result<bool, RuntimeError> {
    let Some(head) = head else {
        return Ok(false);
    };
    let settled: Option<bool> = store.read_with(|conn| {
        conn.query_row(
            "SELECT settled_update_seq IS head_update_seq \
                    AND COALESCE(last_settled_sha, seed_source_sha256) IS ?4 \
             FROM ydoc_docs WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                head.blob_sha256
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::persist_public)
    })?;
    if settled != Some(true) {
        return Ok(false);
    }
    for prefix in ["ydoc-mat_", "resolve-mat_"] {
        let pending = store
            .load_materialization_job(&format!("{prefix}{}", head.latest_moment_id))?
            .is_some_and(|job| job.status == JobStatus::Pending);
        if pending {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Record that the workspace file holds this lineage up to its current head,
/// for a settle that proved it without writing. An open that finds the two
/// still equal knows the lineage is not ahead of its file.
fn record_file_holds_head(
    store: &mut EngineStore,
    key: &DocKey,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    let (head, settled): (i64, Option<i64>) = store.read_with(|conn| {
        conn.query_row(
            "SELECT head_update_seq, settled_update_seq FROM ydoc_docs \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(StorageError::persist_public)
    })?;
    if settled == Some(head) {
        return Ok(());
    }
    let recorded = store.write_with(faults, |tx| {
        tx.execute(
            "UPDATE ydoc_docs SET settled_update_seq = head_update_seq \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![key.workspace_id, key.version_id, key.object_id],
        )
        .map_err(StorageError::persist_public)?;
        Ok::<_, StorageError>(())
    })?;
    if matches!(recorded, TxnOutcome::Crashed { .. }) {
        return Err(RuntimeError::OperationCrashed);
    }
    Ok(())
}

fn ydoc_settle_disk_preimage(
    root_dir: &std::path::Path,
    path: &str,
    expected_sha256: Option<&str>,
    projected_sha256: &str,
) -> Result<Option<Preimage>, RuntimeError> {
    let state = probe_projection_target(root_dir, path, ProjectionTargetKind::Plaintext);
    match state {
        ProjectionTargetState::Absent if expected_sha256.is_none() => Ok(Some(Preimage::Absent)),
        ProjectionTargetState::Text { sha256 }
            if sha256 == projected_sha256 || expected_sha256 == Some(sha256.as_str()) =>
        {
            Ok(Some(Preimage::Present(sha256)))
        }
        // New File creates an empty artifact without a domain head. It is the
        // only untracked file a headless session can adopt without losing data.
        ProjectionTargetState::Text { sha256 }
            if expected_sha256.is_none() && sha256 == dohc_engine_storage::hex_sha256(b"") =>
        {
            Ok(Some(Preimage::Present(sha256)))
        }
        // Containment and transient-read failures retain the durable pending
        // job contract. Materialization classifies them without following an
        // unsafe path; a later settle replays the same committed job.
        ProjectionTargetState::UntrackedContent | ProjectionTargetState::Unreadable => Ok(None),
        ProjectionTargetState::Absent
        | ProjectionTargetState::Text { .. }
        | ProjectionTargetState::Binary { .. } => {
            Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into())
        }
    }
}

fn restore_live_settlement_marker(
    store: &mut EngineStore,
    root: &std::path::Path,
    audit: &dohc_engine_collab::live_update_application::LiveSettlementAudit,
    moment: &str,
    markdown: &str,
    faults: &dyn FaultInjector,
    now_ms: i64,
) -> Result<(), RuntimeError> {
    let b = audit.binding();
    if !store.read_with(|conn| audit.covers_projection_in(conn, moment, markdown))? {
        return Ok(());
    }
    let Some(job) = store.load_materialization_job(&format!("ydoc-mat_{moment}"))? else {
        return Ok(());
    };
    if job.workspace_id != b.workspace_id
        || job.target_path != b.current_path
        || job.content_sha256 != markdown
        || job.operation != dohc_engine_storage::MaterializationOperation::Write
        || !matches!(job.status, JobStatus::Conflict | JobStatus::Complete)
    {
        return Ok(());
    }
    let permitted_disk =
        || match probe_projection_target(root, &b.current_path, ProjectionTargetKind::Plaintext) {
            ProjectionTargetState::Absent => job.preimage == Preimage::Absent,
            ProjectionTargetState::Text { sha256 } => {
                sha256 == markdown || job.preimage == Preimage::Present(sha256)
            }
            _ => false,
        };
    if !permitted_disk() {
        return Err(DomainError::ConflictStaleTarget.into());
    }
    let outcome=store.write_with(faults,|tx| -> Result<(),RuntimeError> {
        if !audit.covers_projection_in(tx,moment,markdown)? {return Err(DomainError::ConflictStaleTarget.into());}
        let matches:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM snapshots s JOIN moments m ON m.workspace_id=s.workspace_id AND m.version_id=s.version_id AND m.object_id=s.object_id AND m.moment_id=s.latest_moment_id WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.path=?4 AND s.latest_moment_id=?5 AND s.blob_sha256=?6 AND m.moment_order=?7) AND NOT EXISTS(SELECT 1 FROM materialization_jobs WHERE (workspace_id=?1 OR workspace_id='') AND target_path=?4 AND status='complete' AND job_id NOT LIKE 'version-switch-%' AND target_generation>?7)",params![b.workspace_id,b.main_version_id,b.object_id,b.current_path,moment,markdown,job.target_generation],|row|row.get(0)).map_err(StorageError::persist_public)?;
        if !matches || !permitted_disk() {return Err(DomainError::ConflictStaleTarget.into());}
        let changed=tx.execute("UPDATE materialization_jobs SET status='pending',completed_at_ms=NULL WHERE job_id=?1 AND workspace_id=?2 AND target_path=?3 AND content_sha256=?4 AND target_generation=?5 AND status IN ('conflict','complete')",params![job.job_id,b.workspace_id,b.current_path,markdown,job.target_generation]).map_err(StorageError::persist_public)?;
        if changed!=1 {return Err(DomainError::ConflictStaleTarget.into());}
        tx.execute("UPDATE ydoc_docs SET settle_seq=?4,last_settled_sha=?5,updated_at_ms=?6 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?7 AND path=?8",params![b.workspace_id,b.main_version_id,b.object_id,job.target_generation,markdown,now_ms,b.lineage_claim_id,b.current_path]).map_err(StorageError::persist_public)?;
        Ok(())
    })?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RuntimeError::OperationCrashed);
    }
    Ok(())
}

fn settled_collection_record_id_mismatch(
    store: &EngineStore,
    key: &DocKey,
    path: &str,
) -> Result<bool, RuntimeError> {
    store
        .read_with(|conn| {
            if !is_collection_record_bound_in_tx(
                conn,
                &key.workspace_id,
                &key.version_id,
                &key.object_id,
            )? {
                return Ok(false);
            }
            collection_record_id_mismatch_in_tx(
                conn,
                &key.workspace_id,
                &key.version_id,
                &[path.to_owned()],
            )
        })
        .map_err(RuntimeError::from)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SettlementKind {
    Document,
    CollectionAdoption,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn ydoc_settle_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    root_dir: &std::path::Path,
    key: &DocKey,
    path: &str,
    content_kind: ContentKind,
    drain_deferred: bool,
    expected_lineage_claim_id: Option<&str>,
    expected_head_sha: Option<String>,
    settled_content_override: Option<String>,
    session_id: &str,
    self_writes: &dyn SelfWriteRecorder,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
    root_guard: Option<&dyn WorkspaceRootGuard>,
    live_audit: Option<&dohc_engine_collab::live_update_application::LiveSettlementAudit>,
    restore_generation: Option<i64>,
    kind: SettlementKind,
) -> Result<YdocSettleOutcome, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    if live_audit.is_none() {
        store.read_with(|conn| {
            dohc_engine_collab::owner_outbox::require_ordinary_settlement(conn, key)?;
            dohc_engine_collab::live_update_application::require_restore_generation(
                conn,
                key,
                restore_generation,
            )
        })?;
    }
    // Refuse to settle a lineage that has no durable state: projecting a
    // fresh doc would be the empty string, and the projected write below
    // would clobber the existing file with it. Mirrors collab settle()'s
    // NoMarker refusal — and a pruned bare marker (local-only close) is the
    // same hazard: load_persisted returns Some with an empty doc, so the
    // durable-state predicate (updates OR snapshots) gates it, matching
    // ydoc.open's lineage-absent treatment.
    match dohc_engine_collab::read_marker(store, key)? {
        None => return Err(dohc_engine_collab::CollabError::NoMarker.into()),
        Some(marker) => {
            if !ydoc_marker_has_durable_state(&marker) {
                return Err(dohc_engine_collab::CollabError::NoMarker.into());
            }
            if marker.lineage_claim_id.as_deref() != expected_lineage_claim_id {
                return Err(dohc_engine_collab::CollabError::LineageWriteStale {
                    expected: expected_lineage_claim_id.map(ToOwned::to_owned),
                    observed: marker.lineage_claim_id,
                }
                .into());
            }
            // An open sync conflict on this object freezes the settle: the
            // lineage may hold a peer's base the user has not reviewed, and
            // settling would materialize it over the preserved head — the
            // clobbering settle #338 refuses. Resolution folds the choice
            // into the lineage (`fold_resolution_into_ydoc_in_tx`) and lifts
            // the freeze.
            if store
                .read_with(|conn| {
                    dohc_engine_sync::open_sync_conflict_for_object(
                        conn,
                        &key.workspace_id,
                        &key.version_id,
                        &key.object_id,
                    )
                })?
                .is_some()
            {
                return Err(dohc_engine_domain::DomainError::InvalidInput {
                    reason: "ydoc-conflict-open",
                }
                .into());
            }
            // Acked-but-deferred remote envelopes must land before the
            // projection — but if any actually apply, the CLIENT's doc has
            // not seen them: settling would materialize content the user
            // never saw while they keep editing stale state. Refuse; the
            // client resyncs (which also drains) and settles again.
            // Engine-internal settles (collection adoption, relation
            // cleanup) pass `drain_deferred = false` and skip this drain,
            // like their opens: their refusal path has no event route, so a
            // parked update they drained would fire no record events. The
            // rows stay queued for the next pull, open, settle, or close,
            // which all emit; the later drain applies and projects the
            // remote content over whatever the pass settled.
            if drain_deferred && restore_generation.is_none() && marker.regime == Regime::Replicated
            {
                let drained = drain_deferred_ydoc_for_live_session_rpc(
                    store,
                    doc_cache,
                    key,
                    expected_lineage_claim_id,
                    faults,
                )?;
                if drained.drained > 0 {
                    // The drained facts ride the refusal: the drain committed
                    // them and consumed their queue rows, so this is their
                    // only crossing.
                    return Ok(YdocSettleOutcome::RemoteUpdatesPending {
                        record_facts: drained.record_facts,
                    });
                }
            }
        }
    }
    let cold_doc;
    let doc = match store.read_with(|conn| doc_cache.doc_for_consumer(conn, key))? {
        Some(cached) => cached,
        None => {
            cold_doc = match dohc_engine_collab::load_persisted(store, key)? {
                Some(persisted) => persisted.doc,
                None => return Err(dohc_engine_collab::CollabError::NoMarker.into()),
            };
            &cold_doc
        }
    };
    // A doc holding unintegrated remote updates (missing cross-origin
    // dependency) must not settle: the projection would omit pending remote
    // content and last_settled_sha would record that incomplete artifact as
    // settled — the CRDT then advances past a stale file.
    if doc.has_pending_dependencies() {
        return Err(dohc_engine_collab::CollabError::MissingDependencies.into());
    }
    let projection = project_ydoc_on_store(store, key, doc, content_kind)?;
    // The in-band cap bounds only what the RESPONSE can carry as one wire
    // string — it must never gate the settle itself. Materialization writes
    // the file from `projection.content` down here, so an over-cap doc
    // settles and lands on disk exactly like any other; the response reports
    // `content: None` and the caller reads the file. (Refusing here instead
    // left the user's content in the CRDT and the workspace file at zero bytes.)
    //
    // The stale-head guard runs before the idempotent no-op: an external
    // capture ingest (or any same-object writer) must surface as
    // ConflictStaleTarget even when the projection itself is unchanged —
    // otherwise settle reports success and a close can prune without the
    // client ever resyncing over the divergence.
    //
    // The expectation derives from durable state (the lineage's last settle
    // sha) falling back to the caller-supplied OPEN-TIME head sha — never
    // from RPC-side session fields mutated after awaits, which a dropped
    // future (deadline firing after the actor committed a settle) leaves
    // stale and would turn every retry into a false conflict.
    let head_probe =
        VersionedTextStore::new(store).read_text(&key.workspace_id, &key.version_id, path)?;
    if let (Some(audit), Some(head)) = (live_audit, head_probe.as_ref())
        && dohc_engine_collab::read_last_settled_sha(store, key)?.as_deref()
            != Some(head.blob_sha256.as_str())
    {
        restore_live_settlement_marker(
            store,
            root_dir,
            audit,
            &head.latest_moment_id,
            &head.blob_sha256,
            faults,
            now_ms,
        )?;
    }
    let expected_head_sha =
        dohc_engine_collab::read_last_settled_sha(store, key)?.or(expected_head_sha);
    let probe_sha = head_probe
        .as_ref()
        .map(|snapshot| snapshot.blob_sha256.clone());
    // Adopt an empty head when this lineage has no durable settle and the
    // session saw no head at open. What the types cannot show: an empty
    // artifact holds no bytes, so adopting one can destroy nothing, while
    // refusing it wedges the session — a refused settle records no
    // expectation, so every later settle refuses the same way. Capture mints
    // such a head from the 0-byte artifact the desktop's New File leaves on
    // disk. A head with content still refuses.
    let expected_head_sha = match head_probe.as_ref() {
        Some(snapshot)
            if expected_head_sha.is_none()
                && snapshot.blob_sha256 == dohc_engine_storage::hex_sha256(b"") =>
        {
            probe_sha.clone()
        }
        _ => expected_head_sha,
    };
    if probe_sha != expected_head_sha {
        return Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into());
    }
    if let Some(current) = head_probe.as_ref() {
        // Ownership must hold even when the content matches the expectation:
        // a path rebound to another object whose blob happens to equal this
        // session's expected sha would otherwise pass the stale guard and be
        // answered (or replayed) as if this session still owned it — and a
        // later close could prune this object's CRDT while the artifact
        // belongs to the other owner. Mirror the fresh path's in-tx check.
        if current.object_id != key.object_id {
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into());
        }
        // The marker may have committed while the prior settle's
        // materialization failed transiently before the file replace: the
        // head and last_settled_sha are advanced, the job is still pending,
        // and the disk holds the old preimage. That job must replay before
        // any settle answer — the idempotent no-op (or close could prune
        // over stale disk bytes) and a changed-projection settle (whose new
        // job's preimage is the unmaterialized head; skipping the replay
        // would strand it in a permanent materialization conflict).
        // The head's pending job can be a settle job or a conflict-RESOLUTION
        // job: a resolution write on this object enqueues `resolve-mat_<id>`
        // and the fold advances last_settled_sha in the same transaction, so
        // skipping it here would leave the disk pre-resolution while every
        // marker reports the choice as settled.
        let mut pending_job = None;
        for prefix in ["ydoc-mat_", "resolve-mat_"] {
            let candidate = format!("{prefix}{}", current.latest_moment_id);
            if let Some(job) = store
                .load_materialization_job(&candidate)?
                .filter(|job| job.status == dohc_engine_storage::JobStatus::Pending)
            {
                pending_job = Some(job);
                break;
            }
        }
        // Pending only: a completed/conflicted job must not replay here — a
        // completed one would re-read the target on every settle (and fail
        // the whole settle pre-commit on a transient read error), and a
        // conflicted one already ran its compensation.
        if let Some(job) = pending_job {
            validate_workspace_root(root_dir, root_guard)?;
            // Suppression before the replace, exactly like the fresh path —
            // the watcher can observe the replayed bytes the instant they
            // land; retract on a conflicted job.
            self_writes.record(&key.workspace_id, &current.path, &current.blob_sha256);
            let replay_outcome = materialize_one(
                store,
                root_dir,
                &job,
                &MaterializeOptions {
                    policy: DurabilityPolicy::per_os(),
                    replacer: &StdReplacer,
                    backoff: &StdBackoff,
                    now_ms,
                    faults,
                },
            );
            let replay_outcome = match replay_outcome {
                Ok(outcome) => outcome,
                Err(error) => {
                    // Same crash posture as the fresh settle's transient-Err
                    // arm: the job stays pending for startup replay and the
                    // committed marker keeps a retry on this idempotent
                    // branch; only the in-memory suppression is retracted
                    // (re-recorded before the next replay attempt).
                    self_writes.retract(&key.workspace_id, &current.path, &current.blob_sha256);
                    return Err(error.into());
                }
            };
            match replay_outcome {
                JobOutcome::Completed | JobOutcome::AlreadyMaterialized => {}
                JobOutcome::Blocked => {
                    // Disk did not move and the committed marker still
                    // describes the durable pending job. Preserve it so the
                    // next settle can retry this replay after containment is
                    // restored.
                    self_writes.retract(&key.workspace_id, &current.path, &current.blob_sha256);
                    return Err(MaterializeError::SymlinkTarget.into());
                }
                JobOutcome::Conflict | JobOutcome::Superseded => {
                    self_writes.retract(&key.workspace_id, &current.path, &current.blob_sha256);
                    // The disk moved past the prior settle before its job
                    // replayed: last_settled_sha no longer describes a
                    // materialized artifact. NULL it so close(settle:false)
                    // refuses UnsettledClose instead of pruning.
                    let cleared = store.write_with(faults, |tx| {
                        tx.execute(
                            "UPDATE ydoc_docs SET last_settled_sha = NULL, settled_update_seq = NULL, updated_at_ms = ?4                              WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                            params![key.workspace_id, key.version_id, key.object_id, now_ms],
                        )
                        .map_err(StorageError::persist_public)?;
                        Ok::<_, StorageError>(())
                    })?;
                    if matches!(cleared, TxnOutcome::Crashed { .. }) {
                        return Err(RuntimeError::OperationCrashed);
                    }
                    return Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into());
                }
                JobOutcome::Crashed(_) => return Err(RuntimeError::OperationCrashed),
            }
        }
    }
    let projected_sha = dohc_engine_storage::hex_sha256(
        settled_content_override
            .as_deref()
            .unwrap_or(&projection.content)
            .as_bytes(),
    );
    // Classify the exact disk preimage through the same contained projection
    // probe that materialization uses. This must precede the settle transaction:
    // compensating only the marker after a rival is found would leave the new
    // head, moment, search row, and materialization job committed.
    let bootstrap_absent = live_audit.is_some_and(|audit| {
        head_probe.as_ref().is_some_and(|head| {
            audit.permits_absent_bootstrap(&head.latest_moment_id, &head.blob_sha256)
        })
    }) && matches!(
        probe_projection_target(root_dir, path, ProjectionTargetKind::Plaintext),
        ProjectionTargetState::Absent
    );
    let disk_preimage = if bootstrap_absent {
        Some(Preimage::Absent)
    } else {
        ydoc_settle_disk_preimage(root_dir, path, expected_head_sha.as_deref(), &projected_sha)?
    };
    // Idempotent no-op: when the lineage's last settled content is exactly
    // this projection, re-settling would mint a duplicate moment (the
    // fingerprint's previous-moment input changed) and a redundant
    // materialization job — the TS driver only settles when the projection
    // differs. Answer with the current head instead (its pending job, if
    // any, was replayed above).
    if dohc_engine_collab::read_last_settled_sha(store, key)?.as_deref()
        == Some(projected_sha.as_str())
    {
        let current = head_probe.ok_or(dohc_engine_domain::DomainError::FileNotFound)?;
        if matches!(&disk_preimage, Some(Preimage::Present(disk_sha)) if *disk_sha == projected_sha)
        {
            record_file_holds_head(store, key, faults)?;
        }
        if let Some(audit) = live_audit {
            let recorded = store.write_with(faults, |tx| {
                let id = audit.record_in_tx(
                    tx,
                    &current.latest_moment_id,
                    &current.blob_sha256,
                    &projection.source_state_vector_sha256,
                    now_ms,
                )?;
                dohc_engine_sync::journal_live_settlement_in_tx(
                    tx,
                    &audit.binding().workspace_id,
                    &id,
                    now_ms,
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(id)
            })?;
            if matches!(recorded, TxnOutcome::Crashed { .. }) {
                return Err(RuntimeError::OperationCrashed);
            }
        }
        return Ok(YdocSettleOutcome::Settled(Box::new(YdocSettlement {
            moment_id: current.latest_moment_id,
            path: current.path,
            content: inband_settled_content(current.text),
            sha256: current.blob_sha256,
            // Any pending job for this head was replayed above, and a Blocked
            // replay returns Err rather than reaching here.
            materialized: true,
            collection_reconcile_required: settled_collection_record_id_mismatch(store, key, path)?,
            projection,
        })));
    }
    // A session with no edits settles without writing. The lineage's
    // durable history is exactly one client-declared seed importing the
    // captured head — and the head guard above proved the store still holds
    // that head, while the disk probe proved the file still holds its bytes.
    // The live Y.Doc is canonical, and an unedited doc's canonical content IS
    // the imported file's content, so the file already holds this settlement;
    // writing would only re-encode it through the projection's normalization
    // (mint a moment, churn the mtime, trip every watcher). Answer with the
    // current head, like the idempotent no-op above. Any doubt — a second
    // update, a snapshot, a prior settle, no recorded seed source, a moved
    // head or disk — falls through to the write below.
    if live_audit.is_none()
        && let Some(seed_source) = dohc_engine_collab::read_seed_only_lineage_source(store, key)?
        && Some(&seed_source) == probe_sha.as_ref()
        && matches!(
            &disk_preimage,
            Some(Preimage::Present(disk_sha)) if Some(disk_sha) == probe_sha.as_ref()
        )
    {
        let current = head_probe.ok_or(dohc_engine_domain::DomainError::FileNotFound)?;
        record_file_holds_head(store, key, faults)?;
        return Ok(YdocSettleOutcome::Settled(Box::new(YdocSettlement {
            moment_id: current.latest_moment_id,
            path: current.path,
            content: inband_settled_content(current.text),
            sha256: current.blob_sha256,
            materialized: true,
            collection_reconcile_required: settled_collection_record_id_mismatch(store, key, path)?,
            projection,
        })));
    }
    let Projection {
        content: ydoc_projected_text,
        content_kind: projected_content_kind,
        source_state_vector_sha256,
        destructive: projection_destructive,
    } = projection;
    let projected_text = settled_content_override.unwrap_or(ydoc_projected_text);
    let outcome = store.write_with(faults, |tx| {
        if live_audit.is_none() {
            dohc_engine_collab::owner_outbox::require_ordinary_settlement(tx, key).map_err(
                |_| DomainError::InvalidInput {
                    reason: "owner-outbox-frozen",
                },
            )?;
            dohc_engine_collab::live_update_application::require_restore_generation(
                tx,
                key,
                restore_generation,
            )
            .map_err(|_| DomainError::InvalidInput {
                reason: "live-restore-fenced",
            })?;
        }
        let current = select_snapshot_by_path_in_tx(tx, &key.workspace_id, &key.version_id, path)?;
        if current.binary_sha256.is_some() {
            return Err(dohc_engine_domain::DomainError::BinaryHeadNotText);
        }
        // The path may have changed owners since ydoc.open (another write
        // claimed it with a different object). Settling anyway would overwrite
        // the other object's head with this session's stale projection while
        // marking this lineage settled — refuse as a stale target instead.
        if let Some(snapshot) = current.snapshot.as_ref()
            && snapshot.object_id != key.object_id
        {
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget);
        }
        // SAME-object divergence: capture (an external disk edit) or another
        // writer may have advanced this object's head since the session's
        // expectation (the open-time head, or its own last settle). Settling
        // anyway would overwrite those newer bytes with a projection the
        // user never saw — refuse; the client resyncs/merges.
        let current_sha = current
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.blob_sha256.clone());
        if current_sha != expected_head_sha {
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget);
        }
        let preimage = if bootstrap_absent {
            Preimage::Absent
        } else {
            current.snapshot.as_ref().map_or_else(
                || disk_preimage.clone().unwrap_or(Preimage::Absent),
                |snapshot| Preimage::Present(snapshot.blob_sha256.clone()),
            )
        };
        let previous_moment = current
            .snapshot
            .as_ref()
            .map_or("absent", |snapshot| snapshot.latest_moment_id.as_str());
        let fingerprint = format!(
            "{}\0{}\0{}\0{}\0{}\0{}\0{}",
            key.workspace_id,
            key.version_id,
            key.object_id,
            path,
            session_id,
            previous_moment,
            source_state_vector_sha256,
        );
        let moment_id = format!(
            "moment-ydoc-{}",
            dohc_engine_storage::hex_sha256(fingerprint.as_bytes())
        );
        let result = write_projected_text_in_tx(
            tx,
            ProjectedWriteText {
                workspace_id: &key.workspace_id,
                version_id: &key.version_id,
                object_id: &key.object_id,
                path: Cow::Borrowed(path),
                text: Cow::Owned(projected_text),
                moment_id: &moment_id,
                metadata_origin: "ydoc",
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: None,
            },
        )?;
        if !result.deduped {
            upsert_file_search_index(
                tx,
                root_dir,
                &key.workspace_id,
                &key.version_id,
                &result.snapshot.object_id,
                &result.snapshot.path,
                &result.snapshot.text,
            )
            .map_err(search_domain)?;
        }
        enqueue_write(tx, &result, preimage, "ydoc")?;
        // The settle marker commits atomically with the moment: a crash can
        // never leave a minted settlement moment whose lineage still reads
        // as unsettled (which would force a non-idempotent re-settle — the
        // moment fingerprint includes the per-open session_id). The prior
        // marker values ride along so a materialization conflict below can
        // compensate — an errored settle must not leave a marker that lets
        // close(settle:false) prune the CRDT with no artifact on disk.
        //
        // settle_seq namespace: the daemon settle path owns this column and
        // writes moment_order into it; collab settle()'s +1 generation
        // counter is never invoked on daemon-settled lineages (C1 has no
        // collab-settle caller). The close guard reads last_settled_sha only.
        let prior_marker: (i64, Option<String>) = tx
            .query_row(
                "SELECT settle_seq, last_settled_sha FROM ydoc_docs \
                 WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                params![key.workspace_id, key.version_id, key.object_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| {
                dohc_engine_domain::DomainError::Storage(StorageError::persist_public(error))
            })?;
        // The projection was taken from the doc at the current head, and this
        // actor is the store's only writer, so the head has not moved since.
        tx.execute(
            "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, updated_at_ms = ?6, \
             settled_update_seq = head_update_seq \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                result.moment.moment_order,
                result.snapshot.blob_sha256,
                now_ms,
            ],
        )
        .map_err(|error| {
            dohc_engine_domain::DomainError::Storage(StorageError::persist_public(error))
        })?;
        if let Some(audit) = live_audit {
            let id = audit.record_in_tx(
                tx,
                &result.moment.moment_id,
                &result.snapshot.blob_sha256,
                &source_state_vector_sha256,
                now_ms,
            )?;
            dohc_engine_sync::journal_live_settlement_in_tx(
                tx,
                &audit.binding().workspace_id,
                &id,
                now_ms,
            )
            .map_err(StorageError::persist_public)?;
        }
        // Live settlement export owns its companion moment, including when
        // enrollment defers the pair until earlier audit events are exported.
        if kind == SettlementKind::CollectionAdoption && live_audit.is_none() {
            journal_moment_outbound_in_tx(
                tx,
                &key.workspace_id,
                &result.moment.moment_id,
                result.deduped,
            )?;
        }
        Ok((result, prior_marker))
    })?;
    let (write, prior_marker) = match outcome {
        TxnOutcome::Committed(write) => write,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    // NO cancellation checks past this point: the settle marker committed
    // with the moment above, so a Cancelled return here would report failure
    // for a settle the lineage already records — and close(settle:false)
    // could then prune the CRDT with the artifact never materialized or
    // suppressed. Once committed, the settle runs to completion.
    //
    let job_id = format!("ydoc-mat_{}", write.moment.moment_id);
    let job = store.load_materialization_job(&job_id)?.ok_or_else(|| {
        RuntimeError::Domain(dohc_engine_domain::DomainError::StateCorrupt {
            reason: "Y.Doc settle materialization job is missing",
        })
    })?;
    validate_workspace_root(root_dir, root_guard)?;
    // The suppression identity registers before the file replace: the watcher
    // can observe the materialized bytes the instant they land, and a
    // record-after-replace left a window where capture queued an ingest that
    // would claim the settle as an external edit. Root validation comes first
    // so a refused replacement cannot leave an identity for a write that never
    // happened.
    self_writes.record(
        &key.workspace_id,
        &write.snapshot.path,
        &write.snapshot.blob_sha256,
    );
    let job_outcome = materialize_one(
        store,
        root_dir,
        &job,
        &MaterializeOptions {
            policy: DurabilityPolicy::per_os(),
            replacer: &StdReplacer,
            backoff: &StdBackoff,
            now_ms,
            faults,
        },
    );
    let job_outcome = match job_outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            // A transient materialization ERROR (sharing violation, IO)
            // leaves the crash-consistent state on purpose: the settle
            // committed durably (marker, moment, snapshot) and the job stays
            // pending for startup replay, exactly as if the process had died
            // between the commit and the replace. Rolling the marker back to
            // the prior head would make every retry compare the advanced
            // head against a stale expectation — permanent
            // ConflictStaleTarget — while the committed marker routes a
            // retry through the idempotent no-op branch, which replays the
            // pending job. Only the in-memory suppression identity is
            // retracted; the no-op replay re-records it before the replace.
            let _ = prior_marker;
            self_writes.retract(
                &key.workspace_id,
                &write.snapshot.path,
                &write.snapshot.blob_sha256,
            );
            return Err(error.into());
        }
    };
    let mut materialized = true;
    match job_outcome {
        JobOutcome::Completed | JobOutcome::AlreadyMaterialized => {}
        JobOutcome::Blocked => {
            // This is the same crash-consistent state as dying after the
            // marker/job commit: the write is durably pending and will land
            // once containment is restored. Keep both the advanced marker and
            // the self-write registration, and report the committed settle —
            // but say plainly that disk did not move, so no caller reports the
            // document as saved over an artifact that never changed.
            materialized = false;
        }
        JobOutcome::Conflict | JobOutcome::Superseded => {
            // The target changed on disk and the job left it untouched: this
            // settle failed, so the marker committed above must not stand —
            // it would let close(settle:false) pass the settled check and
            // prune the CRDT while the artifact was never materialized.
            // (A crash before this compensation is the pending-job case: the
            // job itself is durable and drains on reopen.)
            let compensated = store.write_with(faults, |tx| {
                tx.execute(
                    "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, \
                     settled_update_seq = NULL, updated_at_ms = ?6 \
                     WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
                    params![
                        key.workspace_id,
                        key.version_id,
                        key.object_id,
                        prior_marker.0,
                        prior_marker.1,
                        now_ms,
                    ],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })?;
            if matches!(compensated, TxnOutcome::Crashed { .. }) {
                return Err(RuntimeError::OperationCrashed);
            }
            self_writes.retract(
                &key.workspace_id,
                &write.snapshot.path,
                &write.snapshot.blob_sha256,
            );
            return Err(dohc_engine_domain::DomainError::ConflictStaleTarget.into());
        }
        JobOutcome::Crashed(_) => return Err(RuntimeError::OperationCrashed),
    }
    let projection = Projection {
        content: write.snapshot.text,
        content_kind: projected_content_kind,
        source_state_vector_sha256,
        destructive: projection_destructive,
    };
    let content = (projection.content.len() <= dohc_engine_domain::INBAND_CONTENT_CAP_BYTES)
        .then(|| projection.content.clone());
    Ok(YdocSettleOutcome::Settled(Box::new(YdocSettlement {
        moment_id: write.moment.moment_id,
        path: write.snapshot.path,
        content,
        sha256: write.snapshot.blob_sha256,
        materialized,
        collection_reconcile_required: settled_collection_record_id_mismatch(store, key, path)?,
        projection,
    })))
}

fn ydoc_resync_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    key: &DocKey,
    expected_lineage_claim_id: Option<&str>,
    token: &CancellationToken,
    restore_generation: Option<i64>,
) -> Result<YdocResyncState, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    store.read_with(|conn| {
        dohc_engine_collab::live_update_application::require_restore_generation(
            conn,
            key,
            restore_generation,
        )
    })?;
    // Resync is the staleness recovery path: an envelope acked-but-deferred
    // because this session held the lease may be the very edit that made the
    // client stale — drain it first or the recovery response still misses it.
    let marker = dohc_engine_collab::read_marker(store, key)?;
    let observed_lineage_claim_id = marker
        .as_ref()
        .and_then(|marker| marker.lineage_claim_id.as_deref());
    // A claim mismatch means arbitration already replaced the generation the
    // session opened. Resync is the explicit replacement handshake: return
    // the winner below, but do not consume any queued foreign coordinate while
    // the old session still owns its lease.
    let drained = if marker
        .as_ref()
        .is_some_and(|marker| marker.regime == Regime::Replicated)
        && observed_lineage_claim_id == expected_lineage_claim_id
        && restore_generation.is_none()
    {
        drain_deferred_ydoc_for_live_session_rpc(
            store,
            doc_cache,
            key,
            expected_lineage_claim_id,
            &NoFaults,
        )?
    } else {
        dohc_engine_sync::YdocDrainResult::default()
    };
    // Marker metadata is always read durably after the drain; CacheTuple proves
    // document replay identity, not content-kind/regime/claim metadata.
    let marker = dohc_engine_collab::read_marker(store, key)?;
    let lineage_claim_id = marker
        .as_ref()
        .and_then(|marker| marker.lineage_claim_id.clone());
    let cached_doc = if marker.is_some() {
        store.read_with(|conn| doc_cache.doc_for_consumer(conn, key))?
    } else {
        None
    };
    let cold_doc = if marker.is_some() && cached_doc.is_none() {
        dohc_engine_collab::load_persisted(store, key)?.map(|persisted| persisted.doc)
    } else {
        None
    };
    let doc = cached_doc.or(cold_doc.as_ref());
    let artifact_assets = doc
        .filter(|_| {
            marker
                .as_ref()
                .is_some_and(|marker| marker.content_kind == ContentKind::Scene)
        })
        .map(scene_asset_descriptors_for_open)
        .unwrap_or_default();
    if let Some(doc) = doc
        && marker
            .as_ref()
            .is_some_and(|marker| marker.content_kind == ContentKind::Scene)
    {
        validate_scene_artifact_assets_on_store(store, key, doc, &artifact_assets)?;
    }
    let initial_update =
        doc.map_or_else(|| Ydoc::wire().encode_full_state(), Ydoc::encode_full_state);
    let recovered_paths = drained
        .lineage_replacements
        .into_iter()
        .flat_map(|replacement| replacement.recovered_paths)
        .collect();
    Ok(YdocResyncState {
        initial_update,
        lineage_claim_id,
        recovered_paths,
        artifact_assets,
    })
}

fn ydoc_close_session_on_store(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    key: &DocKey,
    materialization: Option<&YdocCloseMaterialization>,
    now_ms: i64,
    faults: &dyn FaultInjector,
    token: &CancellationToken,
) -> Result<YdocCloseSessionOutcome, RuntimeError> {
    if token.is_cancelled() {
        return Err(RuntimeError::Cancelled);
    }
    // Close is a lineage reset (the local-only branch prunes to the bare
    // marker — a head-rewind the cache's tuple probe cannot see if the same
    // head coordinates are later re-appended). Remove before any branch so
    // every outcome, including a mid-close crash, leaves no entry behind.
    doc_cache.remove(key);
    doc_cache.unpin(key);
    let restore_generation = match store.read_with(|conn| {
        dohc_engine_collab::live_update_application::restore_generation(conn, key)
    }) {
        Ok(generation) => generation,
        Err(dohc_engine_collab::CollabError::RestoreFenced) => {
            return Ok(YdocCloseSessionOutcome {
                outcome: None,
                record_facts: Vec::new(),
            });
        }
        Err(error) => return Err(error.into()),
    };
    let Some(marker) = dohc_engine_collab::read_marker(store, key)? else {
        return Ok(YdocCloseSessionOutcome {
            outcome: None,
            record_facts: Vec::new(),
        });
    };
    // Richdoc settles like plaintext now, so the local-only close follows the
    // same workspace-file artifact rule (close_session refuses a dirty local
    // prune either way, and persists every replicated lineage internally).
    // Keeping the closed CRDT authoritative here would shadow external file
    // edits on reopen: existing lineage, no seedContent, stale document.
    let persist_closed_state = false;
    let authoritative_projection = if marker.regime == Regime::LocalOnly
        && marker.head_update_seq > 0
    {
        let persisted = dohc_engine_collab::load_persisted(store, key)?
            .ok_or(dohc_engine_collab::CollabError::NoMarker)?;
        let projection = project_ydoc_on_store(store, key, &persisted.doc, marker.content_kind)?;
        // A reopened seed can import an engine-written head whose earlier
        // close cleared last_settled_sha. Prove these source bytes still
        // belong to this object and are on disk before allowing its prune.
        let materialized_seed_source_sha256 = if let Some(materialization) = materialization
            && let Some(path) = marker.path.as_deref()
            && let Some(seed_source) =
                dohc_engine_collab::read_seed_only_lineage_source(store, key)?
            && store.read_with(|conn| -> Result<bool, StorageError> {
                conn.query_row(
                    "SELECT EXISTS (SELECT 1 FROM snapshots \
                         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3 \
                           AND path = ?4 AND blob_sha256 = ?5 AND binary_sha256 IS NULL \
                           AND metadata_origin <> ?6)",
                    params![
                        key.workspace_id,
                        key.version_id,
                        key.object_id,
                        path,
                        seed_source,
                        dohc_engine_domain::store::CAPTURE_ORIGIN
                    ],
                    |row| row.get(0),
                )
                .map_err(StorageError::persist_public)
            })?
            && matches!(
                probe_projection_target(&materialization.root_dir, path, ProjectionTargetKind::Plaintext),
                ProjectionTargetState::Text { sha256 } if sha256 == seed_source
            ) {
            Some(seed_source)
        } else {
            None
        };
        Some(dohc_engine_collab::CloseProjection {
            sha256: hex_sha256(projection.content.as_bytes()),
            materialized_seed_source_sha256,
        })
    } else {
        None
    };
    let outcome = match dohc_engine_collab::close_session(
        store,
        key,
        persist_closed_state,
        authoritative_projection.as_ref(),
        faults,
        now_ms,
    )? {
        TxnOutcome::Committed(outcome) => outcome,
        TxnOutcome::Crashed { .. } => return Err(RuntimeError::OperationCrashed),
    };
    let mut record_facts = Vec::new();
    if marker.regime == Regime::Replicated && restore_generation.is_none() {
        // The drain projects internally now (idempotent-by-sha, dependency-
        // gated): drained remote content reaches the visible head with no
        // session left to settle it. The drain holds its queue-row cleanup
        // until materialization succeeded: a failed materialization would
        // otherwise error out of this close after the rows — and the record
        // facts persisted on them — were already deleted, and no retry could
        // ever emit the events. With the rows kept, the retried
        // close re-drains content-deduped and reads the facts back.
        let (drained, cleanup) = dohc_engine_sync::drain_deferred_ydoc_for_key_holding_cleanup(
            store, doc_cache, key, faults,
        )?;
        for declined in &drained.sharing_declined {
            eprintln!("engine: {declined}");
        }
        if let Some(materialization) = materialization {
            materialize_ydoc_drain(store, key, &drained, materialization, now_ms, faults)?;
        }
        let _ = dohc_engine_sync::complete_deferred_ydoc_drain_cleanup(store, cleanup, faults)?;
        record_facts = drained.record_facts;
    }
    Ok(YdocCloseSessionOutcome {
        outcome: Some(outcome),
        record_facts,
    })
}

fn materialize_ydoc_drain(
    store: &mut EngineStore,
    key: &DocKey,
    drained: &dohc_engine_sync::YdocDrainResult,
    materialization: &YdocCloseMaterialization,
    now_ms: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RuntimeError> {
    if drained.drained == 0 {
        return Ok(());
    }
    let selected = store.read_with(|conn| {
        let mut selected = HashSet::new();
        let winner_job: Option<String> = conn
            .query_row(
                "SELECT job.job_id FROM snapshots AS snapshot \
                 JOIN materialization_jobs AS job \
                   ON job.job_id='ydoc-mat_' || snapshot.latest_moment_id \
                  AND job.workspace_id=snapshot.workspace_id \
                  AND job.status='pending' \
                 WHERE snapshot.workspace_id=?1 AND snapshot.version_id=?2 \
                   AND snapshot.object_id=?3",
                params![key.workspace_id, key.version_id, key.object_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::corrupt_public)?;
        selected.extend(winner_job);
        for recovered_path in drained
            .lineage_replacements
            .iter()
            .flat_map(|replacement| &replacement.recovered_paths)
        {
            let recovery_job: Option<String> = conn
                .query_row(
                    "SELECT job.job_id FROM snapshots AS snapshot \
                     JOIN materialization_jobs AS job \
                       ON job.job_id='sync-mat_' || snapshot.latest_moment_id \
                      AND job.workspace_id=snapshot.workspace_id \
                      AND job.status='pending' \
                     WHERE snapshot.workspace_id=?1 AND snapshot.version_id=?2 \
                       AND snapshot.path=?3",
                    params![key.workspace_id, key.version_id, recovered_path],
                    |row| row.get(0),
                )
                .optional()
                .map_err(StorageError::corrupt_public)?;
            selected.extend(recovery_job);
        }
        Ok::<_, StorageError>(selected)
    })?;
    if selected.is_empty() {
        return Ok(());
    }
    let replay = replay_pending_materializations(
        store,
        &materialization.root_dir,
        MaterializationReplayScope {
            workspace_id: &key.workspace_id,
            self_writes: Some(materialization.self_writes.as_ref()),
        },
        now_ms,
        faults,
        Some(&selected),
        false,
    )?;
    let failed_jobs = replay.failed + selected.len().saturating_sub(replay.selected_seen);
    if failed_jobs == 0 {
        Ok(())
    } else {
        Err(RuntimeError::ActiveVersionMaterializationIncomplete { failed_jobs })
    }
}

/// Local Y.Doc RPCs have no sync-pass result. Keep an actionable origination
/// decline visible at this boundary, matching the existing #632 diagnostic.
/// The caller owns the drained record facts: the open, settle, and close
/// RPC results carry them to the service, which emits them post-commit like
/// the pull pass.
fn drain_deferred_ydoc_for_local_rpc(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    key: &DocKey,
    faults: &dyn FaultInjector,
) -> Result<dohc_engine_sync::YdocDrainResult, RuntimeError> {
    let drained = dohc_engine_sync::drain_deferred_ydoc_for_key(store, doc_cache, key, faults)?;
    for declined in &drained.sharing_declined {
        eprintln!("engine: {declined}");
    }
    Ok(drained)
}

/// Live sessions can consume only coordinates for the lineage they opened.
/// A foreign base and every row behind it stay queued until close releases the
/// lease, so resync cannot replace the lineage behind the active editor.
fn drain_deferred_ydoc_for_live_session_rpc(
    store: &mut EngineStore,
    doc_cache: &mut WriterDocCache,
    key: &DocKey,
    expected_lineage_claim_id: Option<&str>,
    faults: &dyn FaultInjector,
) -> Result<dohc_engine_sync::YdocDrainResult, RuntimeError> {
    let drained = dohc_engine_sync::drain_deferred_ydoc_for_live_session(
        store,
        doc_cache,
        key,
        expected_lineage_claim_id,
        faults,
    )?;
    for declined in &drained.sharing_declined {
        eprintln!("engine: {declined}");
    }
    Ok(drained)
}

#[cfg(test)]
mod scene_seed_transaction_tests {
    use super::super::materialization::{PostCommitMaterializeOutcome, worse_materialize_outcome};
    use super::*;
    use dohc_engine_storage::FaultPoint;
    use dohc_engine_testkit::{ScratchDir, ScriptedFaults};

    #[test]
    fn scene_seed_asset_records_use_the_canonical_scene_encoding() {
        let records = scene_asset_records(&[SceneSeedAsset {
            descriptor: ArtifactAssetDescriptor {
                id: "image-file".to_owned(),
                mime_type: "image/png".to_owned(),
                created: 12,
                path: "assets/excalidraw/owner/hash.png".to_owned(),
                sha256: "a".repeat(64),
                last_retrieved: Some(13),
                version: Some(2),
            },
            bytes: Vec::new(),
            object_id: "asset-object".to_owned(),
            moment_id: "asset-moment".to_owned(),
        }])
        .expect("encode asset record");

        assert_eq!(
            records.get("image-file").map(String::as_str),
            Some(
                r#"{"created":12,"id":"image-file","lastRetrieved":13,"mimeType":"image/png","ref":"assets/excalidraw/owner/hash.png","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":2}"#
            )
        );
        encode_scene_asset_records(&records).expect("canonical record remains codec-valid");
    }

    #[test]
    fn scene_asset_validation_keeps_projection_limit_measurements() {
        let error =
            map_scene_asset_validation_error(dohc_engine_sync::SyncError::ProjectionTooLarge {
                constraint: "MAX_PROJECTION_BYTES",
                actual_bytes: dohc_engine_collab::limits::MAX_PROJECTION_BYTES + 1,
                limit_bytes: dohc_engine_collab::limits::MAX_PROJECTION_BYTES,
            });

        assert!(matches!(
            error,
            RuntimeError::Sync(dohc_engine_sync::SyncError::ProjectionTooLarge {
                constraint: "MAX_PROJECTION_BYTES",
                actual_bytes,
                limit_bytes,
            }) if actual_bytes == limit_bytes + 1
        ));
    }

    #[test]
    fn scene_asset_validation_preserves_storage_and_crash_failures() {
        let storage = map_scene_asset_validation_error(dohc_engine_sync::SyncError::Storage(
            StorageError::StateCorrupt { source: None },
        ));
        assert_eq!(storage.code(), "state-corrupt");
        assert!(matches!(
            storage,
            RuntimeError::Storage(StorageError::StateCorrupt { .. })
        ));

        let crash = map_scene_asset_validation_error(dohc_engine_sync::SyncError::FaultCrash);
        assert_eq!(crash.code(), "operation-crashed");
        assert!(matches!(crash, RuntimeError::OperationCrashed));
    }

    #[test]
    fn scene_asset_validation_keeps_asset_state_taxonomy() {
        assert!(matches!(
            map_scene_asset_validation_error(dohc_engine_sync::SyncError::RetryableState {
                reason: "asset pending",
            }),
            RuntimeError::YdocArtifactAssetsPending
        ));
        assert!(matches!(
            map_scene_asset_validation_error(dohc_engine_sync::SyncError::InvalidInput {
                reason: "asset invalid",
            }),
            RuntimeError::YdocArtifactAssetsInvalid
        ));
    }

    #[test]
    fn restored_asset_outcomes_keep_the_worst_failure_in_any_order() {
        for outcomes in [
            [
                PostCommitMaterializeOutcome::Conflict,
                PostCommitMaterializeOutcome::Skipped,
            ],
            [
                PostCommitMaterializeOutcome::Skipped,
                PostCommitMaterializeOutcome::Conflict,
            ],
        ] {
            assert_eq!(
                outcomes.into_iter().fold(
                    PostCommitMaterializeOutcome::Applied,
                    worse_materialize_outcome,
                ),
                PostCommitMaterializeOutcome::Conflict
            );
        }
        assert_eq!(
            [
                PostCommitMaterializeOutcome::Error,
                PostCommitMaterializeOutcome::Skipped,
                PostCommitMaterializeOutcome::Conflict,
            ]
            .into_iter()
            .fold(
                PostCommitMaterializeOutcome::Applied,
                worse_materialize_outcome,
            ),
            PostCommitMaterializeOutcome::Error
        );
    }

    #[test]
    fn scene_seed_rolls_back_lineage_assets_and_outbound_work_as_one_unit() {
        let scratch = ScratchDir::new().expect("scratch directory");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("engine database"),
            1,
        )
        .expect("open engine store");
        ensure_mutation_version_on_store(&mut store, "workspace", "main", 1, &NoFaults)
            .expect("ensure main version");
        let key = DocKey::new("workspace", "main", "drawing-object").expect("document key");
        let artifact = serde_json::json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": [{
                "id": "image-element",
                "type": "image",
                "x": 0,
                "y": 0,
                "width": 10,
                "height": 10,
                "angle": 0,
                "strokeColor": "transparent",
                "backgroundColor": "transparent",
                "fillStyle": "solid",
                "strokeWidth": 1,
                "strokeStyle": "solid",
                "roughness": 0,
                "opacity": 100,
                "groupIds": [],
                "frameId": null,
                "index": "a0",
                "roundness": null,
                "seed": 1,
                "version": 1,
                "versionNonce": 1,
                "isDeleted": false,
                "boundElements": null,
                "updated": 1,
                "link": null,
                "locked": false,
                "status": "saved",
                "fileId": "image-file",
                "scale": [1, 1],
                "crop": null
            }],
            "appState": {},
            "files": {
                "image-file": {
                    "id": "image-file",
                    "mimeType": "image/png",
                    "created": 1,
                    "dataURL": "data:image/png;base64,AQIDBA=="
                }
            }
        })
        .to_string();
        let faults = ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist);

        let result = seed_scene_from_artifact_on_store(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            "drawing.excalidraw",
            &artifact,
            "drawing-write",
            2,
            faults.as_ref(),
        );
        assert!(matches!(result, Err(RuntimeError::OperationCrashed)));
        assert!(faults.fired());

        store
            .read_with(|conn| {
                for table in [
                    "ydoc_docs",
                    "ydoc_updates",
                    "snapshots",
                    "moments",
                    "materialization_jobs",
                    "replication_log",
                ] {
                    let count: i64 = conn
                        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                            row.get(0)
                        })
                        .map_err(StorageError::corrupt_public)?;
                    assert_eq!(count, 0, "{table} must roll back with the scene seed");
                }
                Ok::<_, StorageError>(())
            })
            .expect("inspect rolled-back transaction");
    }

    #[test]
    fn duplicate_content_scene_assets_return_only_created_jobs() {
        let scratch = ScratchDir::new().expect("scratch directory");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("engine database"),
            1,
        )
        .expect("open engine store");
        ensure_mutation_version_on_store(&mut store, "workspace", "main", 1, &NoFaults)
            .expect("ensure main version");
        let key = DocKey::new("workspace", "main", "drawing-object").expect("document key");
        // Two file ids with identical bytes and mime type resolve to one
        // content-addressed path. Counting the skipped duplicate as a
        // materialization job would reject the first open as
        // ydoc-artifact-assets-pending forever.
        let artifact = serde_json::json!({
            "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
            "elements": [
                {
                    "id": "first-image", "type": "image", "version": 1,
                    "versionNonce": 1, "isDeleted": false, "index": "a0",
                    "fileId": "image-a"
                },
                {
                    "id": "second-image", "type": "image", "version": 1,
                    "versionNonce": 2, "isDeleted": false, "index": "a1",
                    "fileId": "image-b"
                }
            ],
            "appState": {},
            "files": {
                "image-a": {
                    "id": "image-a", "mimeType": "image/png", "created": 1,
                    "dataURL": "data:image/png;base64,AQIDBA=="
                },
                "image-b": {
                    "id": "image-b", "mimeType": "image/png", "created": 2,
                    "dataURL": "data:image/png;base64,AQIDBA=="
                }
            }
        })
        .to_string();
        let jobs = seed_scene_from_artifact_on_store(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            "drawing.excalidraw",
            &artifact,
            "drawing-write",
            2,
            &NoFaults,
        )
        .expect("seed scene");
        // Every returned moment id must name a job that actually exists.
        for job_id in &jobs {
            assert!(
                store
                    .load_materialization_job(job_id)
                    .expect("load job")
                    .is_some(),
                "returned moment id {job_id} has no materialization job",
            );
        }
    }

    #[test]
    fn scene_asset_materialization_conflict_stays_closed_until_disk_is_resolved() {
        let scratch = ScratchDir::new().expect("scratch directory");
        let mut store = EngineStore::open(
            &dohc_engine_testkit::engine_db_path(&scratch).expect("engine database"),
            1,
        )
        .expect("open engine store");
        ensure_mutation_version_on_store(&mut store, "workspace", "main", 1, &NoFaults)
            .expect("ensure main version");
        let key = DocKey::new("workspace", "main", "drawing-object").expect("document key");
        let artifact = serde_json::json!({
            "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
            "elements": [{
                "id": "image-element", "type": "image", "version": 1,
                "versionNonce": 1, "isDeleted": false, "index": "a0",
                "fileId": "image-file"
            }],
            "appState": {},
            "files": {
                "image-file": {
                    "id": "image-file", "mimeType": "image/png", "created": 1,
                    "dataURL": "data:image/png;base64,AQIDBA=="
                }
            }
        })
        .to_string();
        let jobs = seed_scene_from_artifact_on_store(
            &mut store,
            &mut WriterDocCache::new(),
            &key,
            "drawing.excalidraw",
            &artifact,
            "drawing-write",
            2,
            &NoFaults,
        )
        .expect("seed scene");
        let selected: HashSet<String> = jobs.into_iter().collect();
        let job = store
            .load_materialization_job(selected.iter().next().expect("job id"))
            .expect("load job")
            .expect("seed materialization job");
        let target = scratch.path().join(&job.target_path);
        std::fs::create_dir_all(target.parent().expect("asset parent")).expect("create parent");
        std::fs::write(&target, b"foreign bytes").expect("write conflict");

        let first = replay_pending_materializations(
            &mut store,
            scratch.path(),
            MaterializationReplayScope {
                workspace_id: "workspace",
                self_writes: None,
            },
            3,
            &NoFaults,
            Some(&selected),
            false,
        )
        .expect("first replay");
        assert_eq!(first.failed, 1);
        assert_eq!(
            store
                .load_materialization_job(&job.job_id)
                .expect("load conflict")
                .expect("conflict job")
                .status,
            JobStatus::Conflict
        );
        assert_eq!(
            reconcile_scene_asset_materialization_conflicts(&store, scratch.path(), &selected, 4)
                .expect("first refusal"),
            1
        );
        assert_eq!(
            reconcile_scene_asset_materialization_conflicts(&store, scratch.path(), &selected, 5)
                .expect("repeated refusal"),
            1,
            "repeated opens must not clear a live disk conflict"
        );

        std::fs::remove_file(&target).expect("remove conflicting disk file");
        assert_eq!(
            reconcile_scene_asset_materialization_conflicts(&store, scratch.path(), &selected, 6)
                .expect("recover conflict"),
            0
        );
        let recovered = replay_pending_materializations(
            &mut store,
            scratch.path(),
            MaterializationReplayScope {
                workspace_id: "workspace",
                self_writes: None,
            },
            7,
            &NoFaults,
            Some(&selected),
            false,
        )
        .expect("recovery replay");
        assert_eq!(recovered.completed, 1);
        assert_eq!(
            std::fs::read(target).expect("materialized asset"),
            [1, 2, 3, 4]
        );
    }
}
