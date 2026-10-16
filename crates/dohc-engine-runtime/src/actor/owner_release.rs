//! Lifecycle commands for the future release runner. No RPC or startup task calls these.
use super::*;
use dohc_engine_collab::{DocKey, LiveObjectBinding, owner_outbox::prefix};
use dohc_engine_storage::TxnOutcome;
use dohc_engine_sync::{self as sync, ReleaseHold};
use tokio_util::sync::CancellationToken;

pub enum OwnerReleaseLifecycle {
    Begin {
        binding: LiveObjectBinding,
        namespace: String,
        digest: String,
    },
    Adopt(ReleaseHold),
    Unbind(ReleaseHold),
    Abandon {
        hold: ReleaseHold,
        resolved_digest: String,
    },
    CloseSession {
        hold: ReleaseHold,
        outbox: String,
    },
    CleanupSession {
        hold: ReleaseHold,
        outbox: String,
    },
    FinishCleanup(ReleaseHold),
}

impl ActorHandle {
    #[allow(clippy::too_many_arguments)]
    pub async fn owner_release_settle(
        &self,
        hold: ReleaseHold,
        root: PathBuf,
        self_writes: Arc<dyn SelfWriteRecorder>,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<YdocSettleOutcome, RuntimeError> {
        self.run(move |store, cache| {
            let b = hold.binding();
            let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
            let capability = store.read_with(|c| {
                prefix::PrefixSettlement::prepare_in(c, b).map_err(|error| match error {
                    dohc_engine_collab::OwnerOutboxError::Stopping => sync::SyncError::RetryableState { reason: "owner release is abandoned" },
                    error => sync::SyncError::Storage(StorageError::corrupt_public(error)),
                })
            })?;
            if capability.release_digest != hold.digest() {
                return Err(sync::SyncError::CoordinateDiverged.into());
            }
            let head = store.read_with(|c| c.query_row("SELECT blob_sha256 FROM snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND path=?4",rusqlite::params![b.workspace_id,b.main_version_id,b.object_id,b.current_path],|r|r.get::<_,Option<String>>(0)).map_err(StorageError::corrupt_public))?;
            super::ydoc::ydoc_settle_on_store(
                store,
                cache,
                &root,
                &key,
                &b.current_path,
                dohc_engine_collab::ContentKind::Richdoc,
                false,
                Some(&b.lineage_claim_id),
                head,
                None,
                "owner-release",
                self_writes.as_ref(),
                now_ms,
                faults.as_ref(),
                &token,
                None,
                None,
                (b.restore_fence_generation > 0).then_some(b.restore_fence_generation),
                super::ydoc::SettlementKind::OwnerPrefix(&capability),
            )
        })
        .await
    }

    /// One durable lifecycle transaction; scheduling and claim acquisition belong to callers.
    pub async fn owner_release_lifecycle(
        &self,
        action: OwnerReleaseLifecycle,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<ReleaseHold, RuntimeError> {
        self.run(move |store, cache| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let binding = match &action {
                OwnerReleaseLifecycle::Begin { binding, .. } => binding,
                OwnerReleaseLifecycle::Adopt(h)
                | OwnerReleaseLifecycle::Unbind(h)
                | OwnerReleaseLifecycle::FinishCleanup(h) => h.binding(),
                OwnerReleaseLifecycle::Abandon { hold, .. }
                | OwnerReleaseLifecycle::CloseSession { hold, .. }
                | OwnerReleaseLifecycle::CleanupSession { hold, .. } => hold.binding(),
            };
            let key = DocKey::new(
                &binding.workspace_id,
                &binding.main_version_id,
                &binding.object_id,
            )?;
            let result = store.write_with(faults.as_ref(), |tx| {
                let h = match action {
                    OwnerReleaseLifecycle::Begin {
                        binding,
                        namespace,
                        digest,
                    } => return sync::begin_release_hold_in(tx, &binding, &namespace, &digest),
                    OwnerReleaseLifecycle::Adopt(h) => {
                        sync::adopt_pending_page_in(tx, &h)?;
                        h
                    }
                    OwnerReleaseLifecycle::Unbind(h) => {
                        sync::unbind_release_in(tx, &h, now_ms)?;
                        h
                    }
                    OwnerReleaseLifecycle::Abandon {
                        hold: h,
                        resolved_digest,
                    } => {
                        sync::abandon_release_hold_in(tx, &h, &resolved_digest)?;
                        h
                    }
                    OwnerReleaseLifecycle::CloseSession { hold, outbox } => {
                        require_cleanup_hold(tx, &key, &hold)?;
                        let released: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM owner_live_stops WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND state='released')",rusqlite::params![key.workspace_id,key.version_id,key.object_id],|r|r.get(0)).map_err(StorageError::corrupt_public)?;
                        if !released { return Err(sync::SyncError::RetryableState { reason: "owner release is not released" }); }
                        prefix::close_consumed_in_tx(tx, &key, &outbox)
                            .map_err(StorageError::corrupt_public)?;
                        hold
                    }
                    OwnerReleaseLifecycle::CleanupSession { hold, outbox } => {
                        require_cleanup_hold(tx, &key, &hold)?;
                        prefix::cleanup_consumed_in_tx(tx, &key, &outbox)
                            .map_err(|error| match error {
                                dohc_engine_collab::OwnerOutboxError::StopConflict => sync::SyncError::RetryableState { reason: "owner release cleanup is waiting" },
                                error => sync::SyncError::Storage(StorageError::corrupt_public(error)),
                            })?;
                        prefix::cleanup_session_page_in_tx(tx, hold.binding())
                            .map_err(StorageError::corrupt_public)?;
                        hold
                    }
                    OwnerReleaseLifecycle::FinishCleanup(h) => {
                        require_cleanup_hold(tx, &key, &h)?;
                        prefix::finish_cleanup_in_tx(tx, h.binding(), h.digest(), now_ms)
                            .map_err(StorageError::corrupt_public)?;
                        h
                    }
                };
                Ok::<_, sync::SyncError>(h)
            })?;
            match result {
                TxnOutcome::Committed(h) => {
                    cache.remove(&key);
                    Ok(h)
                }
                TxnOutcome::Crashed { .. } => {
                    cache.remove(&key);
                    Err(sync::SyncError::FaultCrash.into())
                }
            }
        })
        .await
    }

    pub async fn owner_release_deferred_wakes(
        &self,
        workspace: String,
        after: Option<DocKey>,
    ) -> Result<Vec<DocKey>, RuntimeError> {
        self.run(move |store, _| {
            Ok(store
                .read_with(|c| sync::release_deferred_wakes_in(c, &workspace, after.as_ref()))?)
        })
        .await
    }

    /// Transfer and wake dependencies in one actor command. Durable rows cover interrupted commands.
    pub async fn owner_release_replay(
        &self,
        hold: ReleaseHold,
        op: sync::ReplicationEnvelope,
        leases: Arc<dyn sync::LeaseProbe>,
        faults: Arc<dyn FaultInjector>,
        token: CancellationToken,
    ) -> Result<(sync::ApplyOutcome<sync::RoutedApply>, sync::YdocDrainResult), RuntimeError> {
        self.run(move |store, cache| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let b = hold.binding();
            let key = DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id)?;
            let outcome = sync::replay_release_held_envelope(
                store,
                cache,
                &op,
                faults.as_ref(),
                leases.as_ref(),
                &hold,
            )?;
            let drain = if matches!(outcome.primary, sync::ApplyDisposition::Applied(_))
                && op.op_kind == "ydoc.update"
                && op.payload["isBaseState"] != true
                && !leases.is_live(&key)
            {
                sync::drain_deferred_ydoc_for_ended_session(
                    store,
                    cache,
                    &key,
                    leases.as_ref(),
                    faults.as_ref(),
                )?
            } else {
                sync::YdocDrainResult::default()
            };
            Ok((outcome, drain))
        })
        .await
    }
}

fn require_cleanup_hold(
    conn: &rusqlite::Connection,
    key: &DocKey,
    hold: &ReleaseHold,
) -> Result<(), sync::SyncError> {
    if prefix::progress_in(conn, key)
        .map_err(StorageError::corrupt_public)?
        .is_some_and(|p| p.release_digest == hold.digest())
    {
        return Ok(());
    }
    Err(sync::SyncError::CoordinateDiverged)
}
