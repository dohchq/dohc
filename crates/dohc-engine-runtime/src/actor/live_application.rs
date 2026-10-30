use super::{ActorHandle, Command, LifecycleState};
use crate::RuntimeError;
use dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, AdmittedNativeHistoryReconstruction, ApplicationError, ApplicationHandle,
    ApplicationHostCoordinate, ApplicationOwner, ApplicationResult, BootstrapResult,
    JournalEvidence, LiveApplicationAckIdentity, LiveApplicationBootstrap, LiveSettlementResult,
    LiveUpdateHostApplicationAck, LiveUpdateReceipt, NativeRestoreApplication,
    NativeRestoreApplicationReceipt, NativeRestoreFence, NativeRestoreFenceReceipt,
    NativeRestorePreparation, NativeRestoreProposal, NativeRestoreResume,
    NativeRestoreResumeReceipt, OwnerAdoptionAck, OwnerAdoptionCut, PreparationKey,
    PreparationPending, Reconciliation, Release, RetiredActivations, RetirementKey,
    RetirementScope, RetirementTarget, UnloadPending, adopt_owner_committed, apply_committed_with_settlement_limit,
    begin_retirement, bootstrap_committed, prepare_retirement, read_application_ack,
    reconcile_activation, release_activation, unload_pending, validate_application_binding,
    validate_registration_activation, with_retirement_settlement, with_settlement,
};
use dohc_engine_collab::live_update_application::{
    AppliedPosition, AppliedSyncCut, AppliedSyncPolicy, NextAppliedUpdate,
};
use dohc_engine_collab::{CollabError, WriterDocCache};
use dohc_engine_storage::{EngineStore, FaultInjector};
use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::oneshot;

type Reply<T> = oneshot::Sender<Result<T, RuntimeError>>;
type Token = Arc<AtomicBool>;
pub type RestoreApplyObserver =
    Arc<dyn Fn(&dohc_engine_domain::CollectionRecordApplyFacts) + Send + Sync>;
pub type RestoreSettlementObserver = Arc<dyn Fn(&LiveSettlementResult) + Send + Sync>;

/// A reply that carries the actor's share of its request's reservation. Fields
/// drop in declaration order, so a reply that nobody takes frees its result
/// before the capacity that covered it.
pub(super) struct Reserved<T> {
    result: Result<T, RuntimeError>,
    reservation: Option<Arc<dyn Send + Sync>>,
}
type ReservedReply<T> = oneshot::Sender<Reserved<T>>;

fn reply_reserved<T>(
    store: &EngineStore,
    reply: ReservedReply<T>,
    reservation: impl Into<Option<Arc<dyn Send + Sync>>>,
    result: Result<T, RuntimeError>,
) {
    let _ = reply.send(Reserved {
        result: super::drained(store, result),
        reservation: reservation.into(),
    });
}

/// Release the actor's share before the caller sees the result, so a caller
/// that drops the result finds that capacity free again.
async fn receive_reserved<T>(receive: oneshot::Receiver<Reserved<T>>) -> Result<T, RuntimeError> {
    let Reserved {
        result,
        reservation,
    } = receive.await.map_err(|_| RuntimeError::ActorUnavailable)?;
    drop(reservation);
    result
}

/// The caller authenticates the connection, workspace, and relay namespace.
/// Dropping this owner retires every captured document handle immediately.
pub struct ActorLiveApplicationOwner {
    actor: ActorHandle,
    workspace_id: String,
    token: Token,
    retired: RetiredActivations,
}

impl Drop for ActorLiveApplicationOwner {
    fn drop(&mut self) {
        self.token.store(false, Ordering::Release);
    }
}

/// A document registered on one exact worker incarnation and connection owner.
/// This handle cannot be redirected to a replacement actor after restart.
#[derive(Clone)]
pub struct ActorLiveApplicationHandle {
    actor: ActorHandle,
    workspace_id: String,
    token: Token,
    application: ApplicationHandle,
}

fn current(actor: &ActorHandle, token: &Token) -> Result<(), RuntimeError> {
    if token.load(Ordering::Acquire) && actor.lifecycle() == LifecycleState::Ready {
        Ok(())
    } else {
        Err(RuntimeError::ActorUnavailable)
    }
}

impl ActorHandle {
    /// Open the sole trusted live application owner for a workspace on this actor.
    /// A new owner retires the previous owner through the actor's writer queue.
    pub async fn live_application_owner(
        &self,
        workspace_id: String,
    ) -> Result<ActorLiveApplicationOwner, RuntimeError> {
        let mut owner = ActorLiveApplicationOwner {
            actor: self.clone(),
            workspace_id: workspace_id.clone(),
            token: Arc::new(AtomicBool::new(true)),
            retired: RetiredActivations::default(),
        };
        current(self, &owner.token)?;
        let (reply, receive) = oneshot::channel();
        self.tx
            .send(Command::LiveApplication(Box::new(Request::Open {
                workspace_id,
                token: owner.token.clone(),
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        owner.retired = receive
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
        current(self, &owner.token)?;
        Ok(owner)
    }
}

impl ActorLiveApplicationOwner {
    #[allow(clippy::too_many_arguments)]
    pub async fn resume_restore(
        &self,
        input: NativeRestoreResume,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        cancel: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<NativeRestoreResumeReceipt, RuntimeError> {
        current(&self.actor, &self.token)?;
        input.validate_budget(max_bytes, max_events)?;
        // A cold reader point uses all three attempts; eviction holds until the next call.
        for attempt in 0..=2 {
            let (reply, receive) = oneshot::channel();
            self.actor
                .tx
                .send(Command::LiveApplication(Box::new(Request::ResumeRestore {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    input: Box::new(input.clone()),
                    coordinate: coordinate.clone(),
                    max_bytes,
                    max_events,
                    root: root.clone(),
                    now_ms,
                    faults: faults.clone(),
                    cancel: cancel.clone(),
                    reservation: reservation.clone(),
                    reply,
                })))
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            let result = receive_reserved(receive).await;
            if !super::wait_for_reader(&result, attempt, self.actor.markdown_recovery.clone()).await
            {
                let result = result?;
                current(&self.actor, &self.token)?;
                return Ok(result);
            }
            current(&self.actor, &self.token)?;
        }
        unreachable!()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn settle_restore(
        &self,
        input: NativeRestoreApplication,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        cancel: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        self.settle_restore_observed(
            input,
            coordinate,
            max_bytes,
            max_events,
            root,
            now_ms,
            faults,
            cancel,
            reservation,
            None,
        )
        .await
    }

    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub async fn settle_restore_observed(
        &self,
        input: NativeRestoreApplication,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        cancel: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
        observer: Option<RestoreSettlementObserver>,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        current(&self.actor, &self.token)?;
        input.validate_budget(max_bytes, max_events)?;
        // A cold reader point uses all three attempts; eviction holds until the next call.
        for attempt in 0..=2 {
            let (reply, receive) = oneshot::channel();
            self.actor
                .tx
                .send(Command::LiveApplication(Box::new(Request::SettleRestore {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    input: Box::new(input.clone()),
                    coordinate: coordinate.clone(),
                    max_bytes,
                    max_events,
                    root: root.clone(),
                    now_ms,
                    faults: faults.clone(),
                    cancel: cancel.clone(),
                    reservation: reservation.clone(),
                    observer: observer.clone(),
                    reply,
                })))
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            let result = receive_reserved(receive).await;
            if !super::wait_for_reader(&result, attempt, self.actor.markdown_recovery.clone()).await
            {
                let result = result?;
                current(&self.actor, &self.token)?;
                return Ok(result);
            }
            current(&self.actor, &self.token)?;
        }
        unreachable!()
    }

    /// Apply one saved proposal through the current actor owner.
    #[allow(clippy::too_many_arguments)]
    pub async fn apply_restore(
        &self,
        input: NativeRestoreApplication,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<NativeRestoreApplicationReceipt, RuntimeError> {
        self.apply_restore_observed(
            input,
            coordinate,
            max_bytes,
            max_events,
            now_ms,
            faults,
            reservation,
            None,
        )
        .await
    }

    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub async fn apply_restore_observed(
        &self,
        input: NativeRestoreApplication,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        reservation: Arc<dyn Send + Sync>,
        observer: Option<RestoreApplyObserver>,
    ) -> Result<NativeRestoreApplicationReceipt, RuntimeError> {
        current(&self.actor, &self.token)?;
        input.validate_budget(max_bytes, max_events)?;
        // A cold reader point uses all three attempts; eviction holds until the next call.
        for attempt in 0..=2 {
            let (reply, receive) = oneshot::channel();
            self.actor
                .tx
                .send(Command::LiveApplication(Box::new(Request::ApplyRestore {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    input: Box::new(input.clone()),
                    coordinate: coordinate.clone(),
                    max_bytes,
                    max_events,
                    now_ms,
                    faults: faults.clone(),
                    reservation: reservation.clone(),
                    observer: observer.clone(),
                    reply,
                })))
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            let result = receive_reserved(receive).await;
            if !super::wait_for_reader(&result, attempt, self.actor.markdown_recovery.clone()).await
            {
                let result = result?;
                current(&self.actor, &self.token)?;
                return Ok(result);
            }
            current(&self.actor, &self.token)?;
        }
        unreachable!()
    }

    /// The authenticated caller keeps proof memory reserved through queued preparation.
    pub async fn prepare_restore(
        &self,
        input: NativeRestorePreparation,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        faults: Arc<dyn FaultInjector>,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<NativeRestoreProposal, RuntimeError> {
        current(&self.actor, &self.token)?;
        input.validate_budget(max_bytes, max_events)?;
        // A cold reader point uses all three attempts; eviction holds until the next call.
        for attempt in 0..=2 {
            let (reply, receive) = oneshot::channel();
            self.actor
                .tx
                .send(Command::LiveApplication(Box::new(
                    Request::PrepareRestore {
                        workspace_id: self.workspace_id.clone(),
                        token: self.token.clone(),
                        input: Box::new(input.clone()),
                        coordinate: coordinate.clone(),
                        max_bytes,
                        max_events,
                        faults: faults.clone(),
                        reservation: reservation.clone(),
                        reply,
                    },
                )))
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            let result = receive_reserved(receive).await;
            if !super::wait_for_reader(&result, attempt, self.actor.markdown_recovery.clone()).await
            {
                let result = result?;
                current(&self.actor, &self.token)?;
                return Ok(result);
            }
            current(&self.actor, &self.token)?;
        }
        unreachable!()
    }

    /// Fence through the same writer queue as local and committed updates.
    pub async fn fence_restore(
        &self,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<NativeRestoreFenceReceipt, RuntimeError> {
        self.fence_restore_inner(input, coordinate, now_ms, faults, false)
            .await
    }

    /// Trusted transport recovery under its authenticated current host guard.
    pub async fn fence_restore_after_reconnect(
        &self,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<NativeRestoreFenceReceipt, RuntimeError> {
        self.fence_restore_inner(input, coordinate, now_ms, faults, true)
            .await
    }

    async fn fence_restore_inner(
        &self,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        after_reconnect: bool,
    ) -> Result<NativeRestoreFenceReceipt, RuntimeError> {
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::FenceRestore {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                input,
                coordinate,
                after_reconnect,
                now_ms,
                faults,
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        let receipt = receive
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
        current(&self.actor, &self.token)?;
        Ok(receipt)
    }

    /// Retire handles synchronously at the transport's close boundary.
    pub fn retire(&self) {
        self.token.store(false, Ordering::Release);
    }

    pub fn is_current(&self) -> bool {
        current(&self.actor, &self.token).is_ok()
    }

    /// Check durable binding identity, and the activation the registration
    /// would serve, before the transport retires output guards.
    pub async fn validate_binding(
        &self,
        namespace: String,
        binding: LiveObjectBinding,
        activation_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        current(&self.actor, &self.token)?;
        let workspace_id = self.workspace_id.clone();
        let token = self.token.clone();
        let retired = self.retired.clone();
        self.actor
            .run(move |store, _| {
                if !token.load(Ordering::Acquire) {
                    return Err(RuntimeError::ActorUnavailable);
                }
                validate_application_binding(store, &workspace_id, &binding)?;
                validate_registration_activation(
                    store,
                    &namespace,
                    &binding,
                    activation_id.as_deref(),
                    &retired,
                )?;
                Ok(())
            })
            .await?;
        current(&self.actor, &self.token)
    }

    /// Register an authenticated coordinate and prepared document binding.
    pub async fn register(
        &self,
        namespace: String,
        coordinate: ApplicationHostCoordinate,
        binding: LiveObjectBinding,
    ) -> Result<ActorLiveApplicationHandle, RuntimeError> {
        self.register_with(namespace, coordinate, binding, None)
            .await
    }

    /// Register a session host for one activation; see
    /// [`ApplicationOwner::register_activation`].
    pub async fn register_activation(
        &self,
        namespace: String,
        coordinate: ApplicationHostCoordinate,
        binding: LiveObjectBinding,
        activation_id: String,
    ) -> Result<ActorLiveApplicationHandle, RuntimeError> {
        self.register_with(namespace, coordinate, binding, Some(activation_id))
            .await
    }

    async fn register_with(
        &self,
        namespace: String,
        coordinate: ApplicationHostCoordinate,
        binding: LiveObjectBinding,
        activation_id: Option<String>,
    ) -> Result<ActorLiveApplicationHandle, RuntimeError> {
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::Register {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                namespace,
                coordinate,
                binding,
                activation_id,
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        let application = receive
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
        current(&self.actor, &self.token)?;
        Ok(ActorLiveApplicationHandle {
            actor: self.actor.clone(),
            workspace_id: self.workspace_id.clone(),
            token: self.token.clone(),
            application,
        })
    }

    /// Release one document's registration and cached state on the writer queue.
    /// Returns the incomplete work instead, with nothing released. Work is
    /// complete once every applied update is settled and `root` holds the head.
    /// A registration serving an activation other than `activation_id`
    /// refuses the unload before anything is read or released.
    pub async fn unload(
        &self,
        object_id: String,
        activation_id: Option<String>,
        keys: Vec<dohc_engine_collab::DocKey>,
        root: std::path::PathBuf,
        now_ms: i64,
    ) -> Result<Option<UnloadPending>, RuntimeError> {
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::Unload {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                object_id,
                activation_id,
                keys,
                root,
                now_ms,
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        receive.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// The activations this owner retired; see [`RetiredActivations`].
    pub fn retired_activations(&self) -> RetiredActivations {
        self.retired.clone()
    }

    /// Validate a retirement's key and record its intent, then run its Phase
    /// A on the writer queue: see [`begin_retirement`] and
    /// [`ApplicationOwner::retire_activation`]. An invalid key, and a
    /// released activation's replay, tear nothing down. A `release` also
    /// validates that its document left the scope.
    pub async fn begin_retirement(
        &self,
        scope: OwnedRetirementScope,
        coordinate: ApplicationHostCoordinate,
        key: RetirementKey,
        release: bool,
    ) -> Result<RetirementTarget, RuntimeError> {
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(
                Request::BeginRetirement {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    scope,
                    coordinate,
                    key,
                    release,
                    reply,
                },
            )))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        receive.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// See [`prepare_retirement`]. The block lasts while this owner does.
    pub async fn prepare_retirement(
        &self,
        scope: OwnedRetirementScope,
        key: PreparationKey,
    ) -> Result<Option<PreparationPending>, RuntimeError> {
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(
                Request::PrepareRetirement {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    scope,
                    key,
                    reply,
                },
            )))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        receive.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// End this owner's preparation of `key`; see
    /// [`dohc_engine_collab::live_update_application::RetirementPreparations::release`].
    pub async fn release_retirement_preparation(
        &self,
        key: PreparationKey,
    ) -> Result<bool, RuntimeError> {
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(
                Request::ReleasePreparation {
                    token: self.token.clone(),
                    key,
                    reply,
                },
            )))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        receive.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// See [`reconcile_activation`].
    pub async fn reconcile_activation(
        &self,
        scope: OwnedRetirementScope,
        key: RetirementKey,
        after: Option<LiveUpdateReceipt>,
        journal: Option<JournalEvidence>,
    ) -> Result<Reconciliation, RuntimeError> {
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::Reconcile {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                scope,
                key,
                after,
                journal,
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        receive.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// See [`release_activation`].
    pub async fn release_activation(
        &self,
        scope: OwnedRetirementScope,
        coordinate: ApplicationHostCoordinate,
        key: RetirementKey,
        now_ms: i64,
    ) -> Result<Release, RuntimeError> {
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::Release {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                scope,
                coordinate,
                key,
                now_ms,
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        receive.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Settle a retiring activation through its durable binding; see
    /// [`with_retirement_settlement`].
    #[allow(clippy::too_many_arguments)]
    pub async fn settle_retirement(
        &self,
        scope: OwnedRetirementScope,
        coordinate: ApplicationHostCoordinate,
        key: RetirementKey,
        terminal: Option<LiveUpdateReceipt>,
        max_applications: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        cancel: tokio_util::sync::CancellationToken,
        reconstruction: AdmittedNativeHistoryReconstruction,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(
                Request::SettleRetirement {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    scope,
                    coordinate,
                    key,
                    terminal,
                    max_applications,
                    root,
                    now_ms,
                    faults,
                    cancel,
                    reconstruction,
                    reply,
                },
            )))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        receive.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }

    /// Retire captured handles immediately and await durable invalidation.
    pub async fn close(self) -> Result<(), RuntimeError> {
        self.token.store(false, Ordering::Release);
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::Close {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        receive.await.map_err(|_| RuntimeError::ActorUnavailable)?
    }
}

impl ActorLiveApplicationHandle {
    /// The activation this registration serves; see
    /// [`ApplicationHandle::activation_id`].
    pub fn activation_id(&self) -> Option<String> {
        self.application.activation_id()
    }

    pub async fn sync_open(
        &self,
        client_vector: Vec<u8>,
        policy: AppliedSyncPolicy,
        cancel: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<AppliedSyncCut, RuntimeError> {
        policy.validate()?;
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::SyncOpen {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                application: self.application.clone(),
                client_vector,
                policy,
                cancel,
                reservation,
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        let result = receive_reserved(receive).await?;
        current(&self.actor, &self.token)?;
        Ok(result)
    }
    pub async fn read_next_applied(
        &self,
        after: AppliedPosition,
        policy: AppliedSyncPolicy,
        cancel: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<Option<NextAppliedUpdate>, RuntimeError> {
        policy.validate()?;
        after.validate()?;
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(
                Request::ReadNextApplied {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    application: self.application.clone(),
                    after,
                    policy,
                    cancel,
                    reservation,
                    reply,
                },
            )))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        let result = receive_reserved(receive).await?;
        current(&self.actor, &self.token)?;
        Ok(result)
    }
    pub async fn read_ack(
        &self,
        identity: LiveApplicationAckIdentity,
    ) -> Result<Option<LiveUpdateHostApplicationAck>, RuntimeError> {
        identity.validate()?;
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::ReadAck {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                application: self.application.clone(),
                identity,
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        let result = receive
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
        current(&self.actor, &self.token)?;
        Ok(result)
    }
    /// Adopt on the captured workspace actor. The reservation remains owned by
    /// the queued operation when its caller drops the response future.
    pub async fn adopt_owner(
        &self,
        cut: OwnerAdoptionCut,
        max_bytes: usize,
        max_events: usize,
        faults: Arc<dyn FaultInjector>,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<OwnerAdoptionAck, RuntimeError> {
        current(&self.actor, &self.token)?;
        for attempt in 0..=2 {
            let (reply, receive) = oneshot::channel();
            self.actor
                .tx
                .send(Command::LiveApplication(Box::new(Request::AdoptOwner {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    application: self.application.clone(),
                    cut: cut.clone(),
                    max_bytes,
                    max_events,
                    faults: faults.clone(),
                    reservation: reservation.clone(),
                    reply,
                })))
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            let result = receive_reserved(receive).await;
            if !super::wait_for_reader(&result, attempt, self.actor.markdown_recovery.clone()).await
            {
                let result = result?;
                current(&self.actor, &self.token)?;
                return Ok(result);
            }
            current(&self.actor, &self.token)?;
        }
        unreachable!()
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn settle(
        &self,
        terminal: Option<LiveUpdateReceipt>,
        max_applications: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: tokio_util::sync::CancellationToken,
        reconstruction: AdmittedNativeHistoryReconstruction,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        self.settle_with_consent(
            terminal,
            max_applications,
            root,
            now_ms,
            faults,
            token,
            reconstruction,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn settle_with_consent(
        &self,
        terminal: Option<LiveUpdateReceipt>,
        max_applications: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: tokio_util::sync::CancellationToken,
        reconstruction: AdmittedNativeHistoryReconstruction,
        conversion_consent: Option<
            Arc<dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent>,
        >,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        current(&self.actor, &self.token)?;
        for attempt in 0..=2 {
            let (reply, receive) = oneshot::channel();
            self.actor
                .tx
                .send(Command::LiveApplication(Box::new(Request::Settle {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    application: self.application.clone(),
                    terminal: terminal.clone(),
                    max_applications,
                    root: root.clone(),
                    now_ms,
                    faults: faults.clone(),
                    cancel: token.clone(),
                    reconstruction: reconstruction.clone(),
                    conversion_consent: conversion_consent.clone(),
                    reply,
                })))
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            let result = receive_reserved(receive).await;
            if !super::wait_for_reader(&result, attempt, self.actor.markdown_recovery.clone()).await
            {
                current(&self.actor, &self.token)?;
                return result;
            }
        }
        unreachable!()
    }
    /// Install an original baseline through the same captured actor and owner.
    pub async fn bootstrap(
        &self,
        input: LiveApplicationBootstrap,
        bytes: Vec<u8>,
        root: std::path::PathBuf,
        faults: Arc<dyn FaultInjector>,
        reservation: Option<Arc<dyn Send + Sync>>,
    ) -> Result<BootstrapResult, RuntimeError> {
        current(&self.actor, &self.token)?;
        input.validate()?;
        if bytes.len() > MAX_YDOC_UPDATE_BYTES {
            return Err(ApplicationError::Collab(CollabError::UpdateTooLarge {
                actual: bytes.len(),
                max: MAX_YDOC_UPDATE_BYTES,
            })
            .into());
        }
        let bytes = Arc::new(bytes);
        for attempt in 0..=2 {
            let (reply, receive) = oneshot::channel();
            self.actor
                .tx
                .send(Command::LiveApplication(Box::new(Request::Bootstrap {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    application: self.application.clone(),
                    input: input.clone(),
                    bytes: bytes.clone(),
                    root: root.clone(),
                    faults: faults.clone(),
                    reservation: reservation.clone(),
                    reply,
                })))
                .await
                .map_err(|_| RuntimeError::ActorUnavailable)?;
            let result = receive_reserved(receive).await;
            if !super::wait_for_reader(&result, attempt, self.actor.markdown_recovery.clone()).await
            {
                let result = result?;
                current(&self.actor, &self.token)?;
                return Ok(result);
            }
            current(&self.actor, &self.token)?;
        }
        unreachable!()
    }

    /// Apply committed bytes through the actor-owned store and cache.
    /// The transport must still suppress replies after its connection closes.
    pub async fn apply(
        &self,
        event: AdmittedLiveUpdate,
        faults: Arc<dyn FaultInjector>,
        working_reserve_bytes: usize,
    ) -> Result<ApplicationResult, RuntimeError> {
        self.apply_with_reservation(event, faults, None, working_reserve_bytes, None)
            .await
    }

    /// Keep input memory charged while its command remains on the writer queue,
    /// even when the caller stops awaiting the result.
    pub async fn apply_with_reservation(
        &self,
        event: AdmittedLiveUpdate,
        faults: Arc<dyn FaultInjector>,
        reservation: Option<Arc<dyn Send + Sync>>,
        working_reserve_bytes: usize,
        max_applications: Option<usize>,
    ) -> Result<ApplicationResult, RuntimeError> {
        current(&self.actor, &self.token)?;
        if event.update_bytes.len() > MAX_YDOC_UPDATE_BYTES {
            return Err(ApplicationError::Collab(CollabError::UpdateTooLarge {
                actual: event.update_bytes.len(),
                max: MAX_YDOC_UPDATE_BYTES,
            })
            .into());
        }
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::Apply {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                application: self.application.clone(),
                event,
                faults,
                reservation,
                working_reserve_bytes,
                max_applications,
                reply,
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        let result = receive_reserved(receive).await?;
        current(&self.actor, &self.token)?;
        Ok(result)
    }
}

/// [`RetirementScope`] as the writer queue carries it.
#[derive(Debug, Clone)]
pub struct OwnedRetirementScope {
    pub namespace: String,
    pub max_deliveries: usize,
    pub max_applications: usize,
}

impl OwnedRetirementScope {
    fn scope<'a>(&'a self, workspace_id: &'a str) -> RetirementScope<'a> {
        RetirementScope {
            namespace: &self.namespace,
            workspace_id,
            max_deliveries: self.max_deliveries,
            max_applications: self.max_applications,
        }
    }
}

struct OwnedRegistration {
    token: Token,
    application: ApplicationOwner,
}
impl Drop for OwnedRegistration {
    fn drop(&mut self) {
        self.token.store(false, Ordering::Release);
    }
}

#[derive(Default)]
pub(super) struct Registry {
    owners: HashMap<String, OwnedRegistration>,
    /// Each workspace's retired activations. They outlast its owners, so a
    /// host that reconnects mid-Stop still refuses them.
    retired: HashMap<String, RetiredActivations>,
}
impl Registry {
    fn owner(
        &mut self,
        workspace: &str,
        token: &Token,
    ) -> Result<&mut ApplicationOwner, RuntimeError> {
        self.owners
            .get_mut(workspace)
            .filter(|entry| Arc::ptr_eq(&entry.token, token) && token.load(Ordering::Acquire))
            .map(|entry| &mut entry.application)
            .ok_or(RuntimeError::ActorUnavailable)
    }

    /// Release every registration of `object_ids` in `workspace_id`, whichever
    /// owner holds it, in memory only. Their durable application state stays.
    pub(super) fn release(&mut self, workspace_id: &str, object_ids: &[String]) {
        if let Some(entry) = self.owners.get_mut(workspace_id) {
            for object_id in object_ids {
                entry.application.release(object_id);
            }
        }
    }
}

pub(super) enum Request {
    SyncOpen {
        workspace_id: String,
        token: Token,
        application: ApplicationHandle,
        client_vector: Vec<u8>,
        policy: AppliedSyncPolicy,
        cancel: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
        reply: ReservedReply<AppliedSyncCut>,
    },
    ReadNextApplied {
        workspace_id: String,
        token: Token,
        application: ApplicationHandle,
        after: AppliedPosition,
        policy: AppliedSyncPolicy,
        cancel: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
        reply: ReservedReply<Option<NextAppliedUpdate>>,
    },
    ReadAck {
        workspace_id: String,
        token: Token,
        application: ApplicationHandle,
        identity: LiveApplicationAckIdentity,
        reply: Reply<Option<LiveUpdateHostApplicationAck>>,
    },
    ResumeRestore {
        workspace_id: String,
        token: Token,
        input: Box<NativeRestoreResume>,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        cancel: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
        reply: ReservedReply<NativeRestoreResumeReceipt>,
    },
    SettleRestore {
        workspace_id: String,
        token: Token,
        input: Box<NativeRestoreApplication>,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        cancel: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
        observer: Option<RestoreSettlementObserver>,
        reply: ReservedReply<LiveSettlementResult>,
    },
    ApplyRestore {
        workspace_id: String,
        token: Token,
        input: Box<NativeRestoreApplication>,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        reservation: Arc<dyn Send + Sync>,
        observer: Option<RestoreApplyObserver>,
        reply: ReservedReply<NativeRestoreApplicationReceipt>,
    },
    PrepareRestore {
        workspace_id: String,
        token: Token,
        input: Box<NativeRestorePreparation>,
        coordinate: ApplicationHostCoordinate,
        max_bytes: usize,
        max_events: usize,
        faults: Arc<dyn FaultInjector>,
        reservation: Arc<dyn Send + Sync>,
        reply: ReservedReply<NativeRestoreProposal>,
    },
    FenceRestore {
        workspace_id: String,
        token: Token,
        input: NativeRestoreFence,
        coordinate: ApplicationHostCoordinate,
        after_reconnect: bool,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        reply: Reply<NativeRestoreFenceReceipt>,
    },
    AdoptOwner {
        workspace_id: String,
        token: Token,
        application: ApplicationHandle,
        cut: OwnerAdoptionCut,
        max_bytes: usize,
        max_events: usize,
        faults: Arc<dyn FaultInjector>,
        reservation: Arc<dyn Send + Sync>,
        reply: ReservedReply<OwnerAdoptionAck>,
    },
    Settle {
        workspace_id: String,
        token: Token,
        application: ApplicationHandle,
        terminal: Option<LiveUpdateReceipt>,
        max_applications: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        cancel: tokio_util::sync::CancellationToken,
        reconstruction: AdmittedNativeHistoryReconstruction,
        conversion_consent:
            Option<Arc<dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent>>,
        reply: ReservedReply<LiveSettlementResult>,
    },
    Bootstrap {
        workspace_id: String,
        token: Token,
        application: ApplicationHandle,
        input: LiveApplicationBootstrap,
        bytes: Arc<Vec<u8>>,
        root: std::path::PathBuf,
        faults: Arc<dyn FaultInjector>,
        reservation: Option<Arc<dyn Send + Sync>>,
        reply: ReservedReply<BootstrapResult>,
    },
    Open {
        workspace_id: String,
        token: Token,
        reply: Reply<RetiredActivations>,
    },
    BeginRetirement {
        workspace_id: String,
        token: Token,
        scope: OwnedRetirementScope,
        coordinate: ApplicationHostCoordinate,
        key: RetirementKey,
        release: bool,
        reply: Reply<RetirementTarget>,
    },
    PrepareRetirement {
        workspace_id: String,
        token: Token,
        scope: OwnedRetirementScope,
        key: PreparationKey,
        reply: Reply<Option<PreparationPending>>,
    },
    ReleasePreparation {
        token: Token,
        key: PreparationKey,
        reply: Reply<bool>,
    },
    Reconcile {
        workspace_id: String,
        token: Token,
        scope: OwnedRetirementScope,
        key: RetirementKey,
        after: Option<LiveUpdateReceipt>,
        journal: Option<JournalEvidence>,
        reply: Reply<Reconciliation>,
    },
    Release {
        workspace_id: String,
        token: Token,
        scope: OwnedRetirementScope,
        coordinate: ApplicationHostCoordinate,
        key: RetirementKey,
        now_ms: i64,
        reply: Reply<Release>,
    },
    SettleRetirement {
        workspace_id: String,
        token: Token,
        scope: OwnedRetirementScope,
        coordinate: ApplicationHostCoordinate,
        key: RetirementKey,
        terminal: Option<LiveUpdateReceipt>,
        max_applications: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        cancel: tokio_util::sync::CancellationToken,
        reconstruction: AdmittedNativeHistoryReconstruction,
        reply: Reply<LiveSettlementResult>,
    },
    Register {
        workspace_id: String,
        token: Token,
        namespace: String,
        coordinate: ApplicationHostCoordinate,
        binding: LiveObjectBinding,
        activation_id: Option<String>,
        reply: Reply<ApplicationHandle>,
    },
    Apply {
        workspace_id: String,
        token: Token,
        application: ApplicationHandle,
        event: AdmittedLiveUpdate,
        faults: Arc<dyn FaultInjector>,
        reservation: Option<Arc<dyn Send + Sync>>,
        working_reserve_bytes: usize,
        max_applications: Option<usize>,
        reply: ReservedReply<ApplicationResult>,
    },
    Unload {
        workspace_id: String,
        token: Token,
        object_id: String,
        activation_id: Option<String>,
        keys: Vec<dohc_engine_collab::DocKey>,
        root: std::path::PathBuf,
        now_ms: i64,
        reply: Reply<Option<UnloadPending>>,
    },
    Close {
        workspace_id: String,
        token: Token,
        reply: Reply<()>,
    },
}

impl Request {
    pub(super) fn execute(
        self,
        registry: &mut Registry,
        store: &mut EngineStore,
        cache: &mut WriterDocCache,
    ) {
        match self {
            Self::SyncOpen {
                workspace_id,
                token,
                application,
                client_vector,
                policy,
                cancel,
                reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    dohc_engine_collab::live_update_application::read_applied_sync(
                        store,
                        &application,
                        &client_vector,
                        policy,
                        || {
                            !cancel.is_cancelled()
                                && token.load(Ordering::Acquire)
                                && !reply.is_closed()
                        },
                    )
                    .map_err(Into::into)
                });
                reply_reserved(store, reply, reservation, result);
            }
            Self::ReadNextApplied {
                workspace_id,
                token,
                application,
                after,
                policy,
                cancel,
                reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    dohc_engine_collab::live_update_application::read_next_applied(
                        store,
                        &application,
                        &after,
                        policy,
                        || {
                            !cancel.is_cancelled()
                                && token.load(Ordering::Acquire)
                                && !reply.is_closed()
                        },
                    )
                    .map_err(Into::into)
                });
                reply_reserved(store, reply, reservation, result);
            }
            Self::ReadAck {
                workspace_id,
                token,
                application,
                identity,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    read_application_ack(store, &application, &identity).map_err(Into::into)
                });
                let _ = reply.send(super::drained(store, result));
            }
            Self::ResumeRestore {
                workspace_id,
                token,
                input,
                coordinate,
                max_bytes,
                max_events,
                root,
                now_ms,
                faults,
                cancel,
                reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    let resolver = cache.reader_resolver.clone();
                    if cancel.is_cancelled() { return Err(RuntimeError::Cancelled); }
                    owner.resume_restore(store, resolver.as_ref(), *input, coordinate, max_bytes, max_events,
                        now_ms, faults.as_ref(), |conn, binding, moment, markdown| {
                            if cancel.is_cancelled() { return Err(ApplicationError::Interrupted); }
                            let job = dohc_engine_storage::materialize::load_job(conn, &format!("ydoc-mat_{moment}"))?
                                .ok_or(ApplicationError::Conflict)?;
                            if job.workspace_id != binding.workspace_id
                                || job.target_path != binding.current_path
                                || job.content_sha256 != markdown
                                || job.operation != dohc_engine_storage::MaterializationOperation::Write
                                || job.status != dohc_engine_storage::JobStatus::Complete {
                                return Err(ApplicationError::Conflict);
                            }
                            if !matches!(
                                dohc_engine_files::probe_projection_target(&root, &binding.current_path,
                                    dohc_engine_files::ProjectionTargetKind::Plaintext),
                                dohc_engine_files::ProjectionTargetState::Text { sha256 } if sha256 == markdown
                            ) { return Err(ApplicationError::Conflict); }
                            Ok(())
                        }).map_err(Into::into)
                });
                reply_reserved(store, reply, reservation, result);
            }
            Self::SettleRestore {
                workspace_id,
                token,
                input,
                coordinate,
                max_bytes,
                max_events,
                root,
                now_ms,
                faults,
                cancel,
                reservation,
                observer,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    let resolver = cache.reader_resolver.clone();
                    if cancel.is_cancelled() {return Err(RuntimeError::Cancelled);}
                    owner.with_restore_settlement(store, resolver.as_ref(),*input,coordinate,max_bytes,max_events,|store,audit| {
                        let mut result = settle_audited(store,cache,&root,audit,now_ms,faults.as_ref(),&cancel,None)?;
                        result.materialized &= matches!(
                            dohc_engine_files::probe_projection_target(&root,&audit.binding().current_path,dohc_engine_files::ProjectionTargetKind::Plaintext),
                            dohc_engine_files::ProjectionTargetState::Text {sha256} if sha256 == result.markdown_digest
                        );
                        Ok(result)
                    })
                });
                let result = super::drained(store, result);
                if let (Some(observer), Ok(result)) = (&observer, &result) {
                    observer(result);
                }
                reply_reserved(store, reply, reservation, result);
            }
            Self::ApplyRestore {
                workspace_id,
                token,
                input,
                coordinate,
                max_bytes,
                max_events,
                now_ms,
                faults,
                reservation,
                observer,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    let resolver = cache.reader_resolver.clone();
                    owner
                        .apply_restore_with_facts(
                            store,
                            resolver.as_ref(),
                            cache,
                            *input,
                            coordinate,
                            max_bytes,
                            max_events,
                            now_ms,
                            faults.as_ref(),
                            |tx, namespace, binding, count| {
                                dohc_engine_sync::journal_live_event_or_defer_in_tx(
                                    tx, namespace, binding, count, now_ms,
                                )
                                .map(|_| ())
                                .map_err(|error| {
                                    ApplicationError::Storage(
                                        dohc_engine_storage::StorageError::persist_public(error),
                                    )
                                })
                            },
                        )
                        .map(|(receipt, facts)| {
                            if let (Some(observer), Some(facts)) = (&observer, &facts) {
                                observer(facts);
                            }
                            receipt
                        })
                        .map_err(Into::into)
                });
                reply_reserved(store, reply, reservation, result);
            }
            Self::PrepareRestore {
                workspace_id,
                token,
                input,
                coordinate,
                max_bytes,
                max_events,
                faults,
                reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    let resolver = cache.reader_resolver.clone();
                    owner
                        .prepare_restore(
                            store,
                            resolver.as_ref(),
                            *input,
                            coordinate,
                            max_bytes,
                            max_events,
                            faults.as_ref(),
                        )
                        .map_err(Into::into)
                });
                reply_reserved(store, reply, reservation, result);
            }
            Self::FenceRestore {
                workspace_id,
                token,
                input,
                coordinate,
                after_reconnect,
                now_ms,
                faults,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    if after_reconnect {
                        owner.fence_restore_after_reconnect(
                            store,
                            cache.reader_resolver.as_ref(),
                            input,
                            coordinate,
                            now_ms,
                            faults.as_ref(),
                        )
                    } else {
                        owner.fence_restore(
                            store,
                            cache.reader_resolver.as_ref(),
                            input,
                            coordinate,
                            now_ms,
                            faults.as_ref(),
                        )
                    }
                    .map_err(Into::into)
                });
                let _ = reply.send(super::drained(store, result));
            }
            Self::AdoptOwner {
                workspace_id,
                token,
                application,
                cut,
                max_bytes,
                max_events,
                faults,
                reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .ok()
                        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
                        .ok_or(RuntimeError::ActorUnavailable)?;
                    adopt_owner_committed(
                        store,
                        &application,
                        cut,
                        max_bytes,
                        max_events,
                        now_ms,
                        faults.as_ref(), cache.reader_resolver.as_deref(),
                        |tx, namespace, binding, count| {
                            dohc_engine_sync::journal_live_base_in_tx(tx, namespace, binding, now_ms)
                                .map_err(|error| dohc_engine_collab::live_update_application::ApplicationError::Storage(
                                    dohc_engine_storage::StorageError::persist_public(error)))?;
                            for event_count in 1..=count {
                                dohc_engine_sync::journal_live_event_or_defer_in_tx(tx, namespace, binding, event_count, now_ms)
                                    .map_err(|error| dohc_engine_collab::live_update_application::ApplicationError::Storage(
                                        dohc_engine_storage::StorageError::persist_public(error)))?;
                            }
                            Ok(())
                        },
                    )
                    .map_err(Into::into)
                });
                reply_reserved(store, reply, reservation, result);
            }
            Self::Settle {
                workspace_id,
                token,
                application,
                terminal,
                max_applications,
                root,
                now_ms,
                faults,
                cancel,
                reconstruction,
                conversion_consent,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    if cancel.is_cancelled() {
                        return Err(RuntimeError::Cancelled);
                    }
                    with_settlement(
                        store,
                        &application,
                        terminal,
                        max_applications,
                        reconstruction.policy,
                        |store, audit| {
                            settle_audited(
                                store,
                                cache,
                                &root,
                                audit,
                                now_ms,
                                faults.as_ref(),
                                &cancel,
                                conversion_consent.as_deref(),
                            )
                        },
                    )
                });
                reply_reserved(store, reply, reconstruction.reservation, result);
            }
            Self::Bootstrap {
                workspace_id,
                token,
                application,
                input,
                bytes,
                root,
                faults,
                reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    let now_ms = input.baseline_registered_at_ms;
                    bootstrap_committed(
                        store,
                        cache,
                        &application,
                        input,
                        bytes.as_slice(),
                        faults.as_ref(),
                        |tx, written, namespace, binding| {
                            dohc_engine_sync::journal_live_base_in_tx(
                                tx, namespace, binding, now_ms,
                            )?;
                            crate::search::upsert_file_search_index(
                                tx,
                                &root,
                                &workspace_id,
                                &written.snapshot.version_id,
                                &written.snapshot.object_id,
                                &written.snapshot.path,
                                &written.snapshot.text,
                            )
                            .map_err(RuntimeError::from)
                        },
                    )
                });
                reply_reserved(store, reply, reservation, result);
            }
            Self::Open {
                workspace_id,
                token,
                reply,
            } => {
                let result = (|| {
                    if !token.load(Ordering::Acquire) {
                        return Err(RuntimeError::ActorUnavailable);
                    }
                    let retired = registry
                        .retired
                        .entry(workspace_id.clone())
                        .or_default()
                        .clone();
                    let application =
                        ApplicationOwner::with_retired(workspace_id.clone(), retired.clone())?;
                    if let Some(old) = registry.owners.get_mut(&workspace_id) {
                        old.token.store(false, Ordering::Release);
                        old.application.invalidate(store)?;
                    }
                    registry
                        .owners
                        .insert(workspace_id, OwnedRegistration { token, application });
                    Ok(retired)
                })();
                let _ = reply.send(super::drained(store, result));
            }
            Self::BeginRetirement {
                workspace_id,
                token,
                scope,
                coordinate,
                key,
                release,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    let target = begin_retirement(
                        store,
                        &scope.scope(&workspace_id),
                        &key,
                        release,
                        &dohc_engine_storage::NoFaults,
                    )?;
                    cache.retirement_preparations().end(&key.activation_id);
                    if !target.released {
                        owner.retire_activation(
                            cache,
                            &scope.namespace,
                            &coordinate,
                            &target.doc,
                            &key.activation_id,
                        );
                    }
                    Ok(target)
                });
                let _ = reply.send(result);
            }
            Self::PrepareRetirement {
                workspace_id,
                token,
                scope,
                key,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    prepare_retirement(
                        store,
                        &scope.scope(&workspace_id),
                        &key,
                        &cache.retirement_preparations(),
                        &token,
                    )
                    .map_err(Into::into)
                });
                let _ = reply.send(result);
            }
            // An owner that ended blocks nothing, so its release needs no current owner.
            Self::ReleasePreparation { token, key, reply } => {
                let _ = reply.send(Ok(cache.retirement_preparations().release(&key, &token)));
            }
            Self::Reconcile {
                workspace_id,
                token,
                scope,
                key,
                after,
                journal,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    reconcile_activation(
                        store,
                        &scope.scope(&workspace_id),
                        &key,
                        after.as_ref(),
                        journal.as_ref(),
                        &dohc_engine_storage::NoFaults,
                    )
                    .map_err(Into::into)
                });
                let _ = reply.send(result);
            }
            Self::Release {
                workspace_id,
                token,
                scope,
                coordinate,
                key,
                now_ms,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    release_activation(
                        store,
                        cache,
                        &scope.scope(&workspace_id),
                        &key,
                        &coordinate,
                        now_ms,
                        &dohc_engine_storage::NoFaults,
                    )
                    .map_err(Into::into)
                });
                let _ = reply.send(result);
            }
            Self::SettleRetirement {
                workspace_id,
                token,
                scope,
                coordinate,
                key,
                terminal,
                max_applications,
                root,
                now_ms,
                faults,
                cancel,
                reconstruction,
                reply,
            } => {
                let _reservation = reconstruction.reservation;
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    if cancel.is_cancelled() {
                        return Err(RuntimeError::Cancelled);
                    }
                    with_retirement_settlement(
                        store,
                        &scope.scope(&workspace_id),
                        &key,
                        &coordinate,
                        terminal,
                        max_applications,
                        reconstruction.policy,
                        |store, audit| {
                            settle_audited(
                                store,
                                cache,
                                &root,
                                audit,
                                now_ms,
                                faults.as_ref(),
                                &cancel,
                                None,
                            )
                        },
                    )
                });
                let _ = reply.send(result);
            }
            Self::Register {
                workspace_id,
                token,
                namespace,
                coordinate,
                binding,
                activation_id,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    match activation_id {
                        Some(activation_id) => owner.register_activation(
                            store,
                            namespace,
                            coordinate,
                            binding,
                            activation_id,
                        ),
                        None => owner.register(store, namespace, coordinate, binding),
                    }
                    .map_err(Into::into)
                });
                let _ = reply.send(super::drained(store, result));
            }
            Self::Apply {
                workspace_id,
                token,
                application,
                event,
                faults,
                reservation,
                working_reserve_bytes,
                max_applications,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    let now_ms=event.metadata.accepted.received_at_ms;
                    apply_committed_with_settlement_limit(
                        store,
                        cache,
                        &application,
                        event,
                        faults.as_ref(),
                        working_reserve_bytes,
                        max_applications,
                        |tx,namespace,binding,count| {
                            dohc_engine_sync::journal_live_event_or_defer_in_tx(tx,namespace,binding,count,now_ms)
                                .map(|_|())
                                .map_err(|error|dohc_engine_collab::live_update_application::ApplicationError::Storage(dohc_engine_storage::StorageError::persist_public(error)))
                        },
                    )
                    .map_err(Into::into)
                });
                reply_reserved(store, reply, reservation, result);
            }
            Self::Unload {
                workspace_id,
                token,
                object_id,
                activation_id,
                keys,
                root,
                now_ms,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    owner.require_unload_activation(&object_id, activation_id.as_deref())?;
                    let mut pending =
                        store.read_with(|conn| unload_pending(conn, &workspace_id, &object_id))?;
                    for key in &keys {
                        if pending.is_some() {
                            break;
                        }
                        pending = super::ydoc::ydoc_unload_pending(store, key, &root, now_ms)?;
                    }
                    if pending.is_some() {
                        return Ok(pending);
                    }
                    owner.unregister(store, &object_id, activation_id.as_deref())?;
                    for key in &keys {
                        cache.remove(key);
                        cache.unpin(key);
                    }
                    Ok(None)
                });
                let _ = reply.send(super::drained(store, result));
            }
            Self::Close {
                workspace_id,
                token,
                reply,
            } => {
                let result = if let Some(entry) = registry
                    .owners
                    .get_mut(&workspace_id)
                    .filter(|entry| Arc::ptr_eq(&entry.token, &token))
                {
                    entry.application.invalidate(store).map_err(Into::into)
                } else {
                    Err(RuntimeError::ActorUnavailable)
                };
                if result.is_ok() {
                    registry.owners.remove(&workspace_id);
                }
                let _ = reply.send(super::drained(store, result));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn settle_audited(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    root: &std::path::Path,
    audit: &dohc_engine_collab::live_update_application::LiveSettlementAudit,
    now_ms: i64,
    faults: &dyn FaultInjector,
    cancel: &tokio_util::sync::CancellationToken,
    conversion_consent: Option<
        &dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent,
    >,
) -> Result<LiveSettlementResult, RuntimeError> {
    let binding = audit.binding();
    let key = dohc_engine_collab::DocKey::new(
        &binding.workspace_id,
        &binding.main_version_id,
        &binding.object_id,
    )?;
    let outcome = super::ydoc::ydoc_settle_on_store(
        store,
        cache,
        root,
        &key,
        &binding.current_path,
        dohc_engine_collab::ContentKind::Richdoc,
        false,
        Some(&binding.lineage_claim_id),
        Some(audit.expected_head().to_owned()),
        audit.restored_source().map(ToOwned::to_owned),
        &audit.markdown_operation_id(),
        &(),
        now_ms,
        faults,
        cancel,
        None,
        Some(audit),
        None,
        super::ydoc::SettlementKind::Document,
        false,
        conversion_consent,
    )?;
    let settled = outcome.into_settlement_for_internal_caller()?;
    let id = if audit.is_empty() {
        None
    } else {
        Some(audit.stored_id(store, &settled.moment_id, &settled.sha256)?)
    };
    match store.write_with(faults, |tx| {
        dohc_engine_collab::markdown_write_obligations::complete_covered_audited_in(
            tx, &key, now_ms,
        )
    })? {
        dohc_engine_storage::TxnOutcome::Committed(()) => {}
        dohc_engine_storage::TxnOutcome::Crashed { .. } => {
            return Err(RuntimeError::OperationCrashed);
        }
    }
    let mut result = audit.result(id, settled.moment_id, settled.sha256, settled.materialized);
    result.collection_reconcile_required = settled.collection_reconcile_required;
    Ok(result)
}

impl ActorHandle {
    pub async fn release_imported_owner_activation(
        &self,
        namespace: String,
        workspace_id: String,
        activation_id: String,
        session: Option<(dohc_engine_collab::DocKey, String)>,
        token: tokio_util::sync::CancellationToken,
    ) -> Result<(), RuntimeError> {
        self.run(move |store, _cache| {
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            dohc_engine_collab::live_update_application::release_imported_owner_activation(
                store,
                &namespace,
                &workspace_id,
                &activation_id,
                session
                    .as_ref()
                    .map(|(key, lineage)| (key, lineage.as_str())),
                &dohc_engine_storage::NoFaults,
            )?;
            Ok(())
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn capture_imported_owner_activation(
        &self,
        namespace: String,
        key: dohc_engine_collab::DocKey,
        path: String,
        max_bytes: usize,
        activation_id: Option<String>,
        token: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<dohc_engine_collab::live_update_application::ImportedOwnerActivation, RuntimeError>
    {
        self.run_with_reader_retry(move |store, cache| {
            let _reservation = reservation.clone();
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
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
            let result = if let Some(activation_id) = activation_id.as_ref() {
                dohc_engine_collab::live_update_application::resume_imported_owner_activation(
                    store,
                    &namespace,
                    &key,
                    &path,
                    activation_id,
                    max_bytes,
                    cache.reader_resolver.as_deref(),
                )?
            } else {
                dohc_engine_collab::live_update_application::capture_imported_owner_activation(
                    store,
                    &namespace,
                    &key,
                    &path,
                    max_bytes,
                    &dohc_engine_storage::NoFaults,
                    cache.reader_resolver.as_deref(),
                )?
            };
            if token.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            Ok(result)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    async fn native_error_precedes_stale_token(bootstrap: bool) {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &dohc_engine_storage::NoFaults)
            .unwrap();
        let mut owner = ApplicationOwner::new("workspace".into()).unwrap();
        let bytes = vec![0, 0];
        let digest = dohc_engine_storage::hex_sha256(&bytes);
        let application = owner
            .register(
                &mut store,
                "relay".into(),
                ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                LiveObjectBinding {
                    workspace_id: "workspace".into(),
                    main_version_id: "main".into(),
                    object_id: "object".into(),
                    lineage_claim_id: digest.clone(),
                    current_path: "note.md".into(),
                    selector_paths: vec!["note.md".into()],
                    restore_fence_generation: 0,
                },
            )
            .unwrap();
        drop(store);
        let actor = super::super::WorkspaceActor::spawn(
            db.clone(),
            crate::EngineDbIdentity::of_existing(&db).unwrap(),
            1,
            0,
            None,
            Default::default(),
        )
        .unwrap();
        let mut actor_handle = actor.handle();
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        actor_handle.tx = tx;
        let token = Arc::new(AtomicBool::new(true));
        let handle = ActorLiveApplicationHandle {
            actor: actor_handle,
            workspace_id: "workspace".into(),
            token: token.clone(),
            application,
        };
        let respond = tokio::spawn(async move {
            // Retire the token after enqueue, before delivering the actor error.
            let Command::LiveApplication(request) = rx.recv().await.unwrap() else {
                panic!("request")
            };
            token.store(false, Ordering::Release);
            match *request {
                Request::AdoptOwner { reply, .. } => {
                    let _ = reply.send(Reserved {
                        result: Err(ApplicationError::Conflict.into()),
                        reservation: None,
                    });
                }
                Request::Bootstrap { reply, .. } => {
                    let _ = reply.send(Reserved {
                        result: Err(ApplicationError::Conflict.into()),
                        reservation: None,
                    });
                }
                _ => panic!("unexpected request"),
            }
        });
        let result = if bootstrap {
            handle
                .bootstrap(
                    LiveApplicationBootstrap {
                        bootstrap_id: "bootstrap".into(),
                        bootstrap_moment_id: "moment".into(),
                        baseline_moment_relay_sequence: 0,
                        baseline_registered_at_ms: 0,
                        baseline_digest: digest.clone(),
                        baseline_byte_length: 2,
                        projected_markdown_digest: dohc_engine_storage::hex_sha256(b""),
                        projected_markdown_byte_length: 0,
                    },
                    bytes,
                    scratch.path().into(),
                    Arc::new(dohc_engine_storage::NoFaults),
                    None,
                )
                .await
                .map(|_| ())
        } else {
            handle
                .adopt_owner(
                    OwnerAdoptionCut {
                        relay_database_namespace: "relay".into(),
                        adoption_id: "adopt".into(),
                        source_moment_id: "moment".into(),
                        source_digest: digest,
                        source_byte_length: 0,
                        baseline_moment_relay_sequence: 0,
                        baseline_registered_at_ms: 0,
                        baseline_bytes: bytes,
                        expected_local_sequence: 0,
                        events: vec![],
                        terminal_receipt: None,
                        retained_prefix: None,
                        outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
                            max_pending_bytes: 1_000_000,
                            max_pending_age_ms: 100_000,
                        },
                        reconstruction:
                            dohc_engine_collab::live_update_application::NativeHistoryReconstruction {
                                working_reserve_bytes: 8 * 1024 * 1024,
                            },
                    },
                    1_000_000,
                    100,
                    Arc::new(dohc_engine_storage::NoFaults),
                    Arc::new(()),
                )
                .await
                .map(|_| ())
        };
        respond.await.unwrap();
        assert!(
            matches!(
                result,
                Err(RuntimeError::LiveApplication(ApplicationError::Conflict))
            ),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn native_adoption_error_precedes_stale_token() {
        native_error_precedes_stale_token(false).await;
    }

    #[tokio::test]
    async fn native_bootstrap_error_precedes_stale_token() {
        native_error_precedes_stale_token(true).await;
    }

    type Order = Arc<Mutex<Vec<&'static str>>>;

    struct Dropped(&'static str, Order);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.1.lock().unwrap().push(self.0);
        }
    }

    fn send(reply: ReservedReply<Dropped>, order: &Order) {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
        let reservation: Arc<dyn Send + Sync> = Arc::new(Dropped("reservation", order.clone()));
        reply_reserved(
            &store,
            reply,
            reservation,
            Ok(Dropped("result", order.clone())),
        );
    }

    /// Live document replies leave the actor without passing `run`, so they
    /// pay the owed drain themselves.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn a_live_application_reply_pays_the_owed_drain() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
        let note = scratch.join("note.md");
        std::fs::write(&note, b"settled").unwrap();
        store
            .flush_before_commits(&std::fs::File::open(&note).unwrap())
            .unwrap();
        let (reply, receive) = oneshot::channel();
        reply_reserved(&store, reply, None, Ok(()));
        assert!(receive.blocking_recv().unwrap().result.is_ok());
        let kinds: Vec<_> = store
            .take_flush_trace()
            .into_iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(
            kinds,
            [
                dohc_engine_storage::FlushKind::Barrier,
                dohc_engine_storage::FlushKind::Drain
            ]
        );
    }

    #[test]
    fn a_reply_nobody_takes_frees_its_result_before_its_reservation() {
        // The caller gave up before the actor replied, so the send fails.
        let order = Order::default();
        let (reply, receive) = oneshot::channel();
        drop(receive);
        send(reply, &order);
        assert_eq!(*order.lock().unwrap(), ["result", "reservation"]);

        // The caller gave up after the reply arrived but before taking it.
        let order = Order::default();
        let (reply, receive) = oneshot::channel();
        send(reply, &order);
        assert!(order.lock().unwrap().is_empty());
        drop(receive);
        assert_eq!(*order.lock().unwrap(), ["result", "reservation"]);
    }

    #[tokio::test]
    async fn a_taken_reply_frees_its_reservation_before_the_caller_sees_the_result() {
        let order = Order::default();
        let (reply, receive) = oneshot::channel();
        send(reply, &order);
        let result = receive_reserved(receive).await.unwrap();
        assert_eq!(*order.lock().unwrap(), ["reservation"]);
        drop(result);
        assert_eq!(*order.lock().unwrap(), ["reservation", "result"]);
    }
}
