use super::{ActorHandle, Command, LifecycleState};
use crate::RuntimeError;
use dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, ApplicationError, ApplicationHandle, ApplicationHostCoordinate,
    ApplicationOwner, ApplicationResult, BootstrapResult, LiveApplicationBootstrap,
    LiveSettlementResult, LiveUpdateReceipt, NativeRestoreApplication,
    NativeRestoreApplicationReceipt, NativeRestoreFence, NativeRestoreFenceReceipt,
    NativeRestorePreparation, NativeRestoreProposal, OwnerAdoptionAck, OwnerAdoptionCut,
    adopt_owner_committed, apply_committed, bootstrap_committed, validate_application_binding,
    with_settlement,
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

/// The caller authenticates the connection, workspace, and relay namespace.
/// Dropping this owner retires every captured document handle immediately.
pub struct ActorLiveApplicationOwner {
    actor: ActorHandle,
    workspace_id: String,
    token: Token,
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
        let owner = ActorLiveApplicationOwner {
            actor: self.clone(),
            workspace_id: workspace_id.clone(),
            token: Arc::new(AtomicBool::new(true)),
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
        receive
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
        current(self, &owner.token)?;
        Ok(owner)
    }
}

impl ActorLiveApplicationOwner {
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
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::SettleRestore {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                input: Box::new(input),
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
            })))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        let result = receive
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
        current(&self.actor, &self.token)?;
        Ok(result)
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
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::ApplyRestore {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                input: Box::new(input),
                coordinate,
                max_bytes,
                max_events,
                now_ms,
                faults,
                reservation,
                observer,
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
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(
                Request::PrepareRestore {
                    workspace_id: self.workspace_id.clone(),
                    token: self.token.clone(),
                    input: Box::new(input),
                    coordinate,
                    max_bytes,
                    max_events,
                    faults,
                    reservation,
                    reply,
                },
            )))
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)?;
        let proposal = receive
            .await
            .map_err(|_| RuntimeError::ActorUnavailable)??;
        current(&self.actor, &self.token)?;
        Ok(proposal)
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

    /// Check durable binding identity before the transport retires output guards.
    pub async fn validate_binding(&self, binding: LiveObjectBinding) -> Result<(), RuntimeError> {
        current(&self.actor, &self.token)?;
        let workspace_id = self.workspace_id.clone();
        let token = self.token.clone();
        self.actor
            .run(move |store, _| {
                if !token.load(Ordering::Acquire) {
                    return Err(RuntimeError::ActorUnavailable);
                }
                validate_application_binding(store, &workspace_id, &binding).map_err(Into::into)
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
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::AdoptOwner {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                application: self.application.clone(),
                cut,
                max_bytes,
                max_events,
                faults,
                reservation,
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
    #[allow(clippy::too_many_arguments)]
    pub async fn settle(
        &self,
        terminal: Option<LiveUpdateReceipt>,
        max_applications: usize,
        root: std::path::PathBuf,
        now_ms: i64,
        faults: Arc<dyn FaultInjector>,
        token: tokio_util::sync::CancellationToken,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<LiveSettlementResult, RuntimeError> {
        current(&self.actor, &self.token)?;
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::Settle {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                application: self.application.clone(),
                terminal,
                max_applications,
                root,
                now_ms,
                faults,
                cancel: token,
                reservation,
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
        let (reply, receive) = oneshot::channel();
        self.actor
            .tx
            .send(Command::LiveApplication(Box::new(Request::Bootstrap {
                workspace_id: self.workspace_id.clone(),
                token: self.token.clone(),
                application: self.application.clone(),
                input,
                bytes,
                root,
                faults,
                reservation,
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

    /// Apply committed bytes through the actor-owned store and cache.
    /// The transport must still suppress replies after its connection closes.
    pub async fn apply(
        &self,
        event: AdmittedLiveUpdate,
        faults: Arc<dyn FaultInjector>,
        working_reserve_bytes: usize,
    ) -> Result<ApplicationResult, RuntimeError> {
        self.apply_with_reservation(event, faults, None, working_reserve_bytes)
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
pub(super) struct Registry(HashMap<String, OwnedRegistration>);
impl Registry {
    fn owner(
        &mut self,
        workspace: &str,
        token: &Token,
    ) -> Result<&mut ApplicationOwner, RuntimeError> {
        self.0
            .get_mut(workspace)
            .filter(|entry| Arc::ptr_eq(&entry.token, token) && token.load(Ordering::Acquire))
            .map(|entry| &mut entry.application)
            .ok_or(RuntimeError::ActorUnavailable)
    }
}

pub(super) enum Request {
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
        reply: Reply<LiveSettlementResult>,
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
        reply: Reply<NativeRestoreApplicationReceipt>,
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
        reply: Reply<NativeRestoreProposal>,
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
        reply: Reply<OwnerAdoptionAck>,
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
        reservation: Arc<dyn Send + Sync>,
        reply: Reply<LiveSettlementResult>,
    },
    Bootstrap {
        workspace_id: String,
        token: Token,
        application: ApplicationHandle,
        input: LiveApplicationBootstrap,
        bytes: Vec<u8>,
        root: std::path::PathBuf,
        faults: Arc<dyn FaultInjector>,
        reservation: Option<Arc<dyn Send + Sync>>,
        reply: Reply<BootstrapResult>,
    },
    Open {
        workspace_id: String,
        token: Token,
        reply: Reply<()>,
    },
    Register {
        workspace_id: String,
        token: Token,
        namespace: String,
        coordinate: ApplicationHostCoordinate,
        binding: LiveObjectBinding,
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
        reply: Reply<ApplicationResult>,
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
                reservation: _reservation,
                observer,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    if cancel.is_cancelled() {return Err(RuntimeError::Cancelled);}
                    owner.with_restore_settlement(store,*input,coordinate,max_bytes,max_events,|store,audit| {
                        let mut result = settle_audited(store,cache,&root,audit,now_ms,faults.as_ref(),&cancel)?;
                        result.materialized &= matches!(
                            dohc_engine_files::probe_projection_target(&root,&audit.binding().current_path,dohc_engine_files::ProjectionTargetKind::Plaintext),
                            dohc_engine_files::ProjectionTargetState::Text {sha256} if sha256 == result.markdown_digest
                        );
                        Ok(result)
                    })
                });
                if let (Some(observer), Ok(result)) = (&observer, &result) {
                    observer(result);
                }
                let _ = reply.send(result);
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
                reservation: _reservation,
                observer,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    owner
                        .apply_restore_with_facts(
                            store,
                            cache,
                            *input,
                            coordinate,
                            max_bytes,
                            max_events,
                            now_ms,
                            faults.as_ref(),
                        )
                        .map(|(receipt, facts)| {
                            if let (Some(observer), Some(facts)) = (&observer, &facts) {
                                observer(facts);
                            }
                            receipt
                        })
                        .map_err(Into::into)
                });
                let _ = reply.send(result);
            }
            Self::PrepareRestore {
                workspace_id,
                token,
                input,
                coordinate,
                max_bytes,
                max_events,
                faults,
                reservation: _reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    owner
                        .prepare_restore(
                            store,
                            *input,
                            coordinate,
                            max_bytes,
                            max_events,
                            faults.as_ref(),
                        )
                        .map_err(Into::into)
                });
                let _ = reply.send(result);
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
                            input,
                            coordinate,
                            now_ms,
                            faults.as_ref(),
                        )
                    } else {
                        owner.fence_restore(store, input, coordinate, now_ms, faults.as_ref())
                    }
                    .map_err(Into::into)
                });
                let _ = reply.send(result);
            }
            Self::AdoptOwner {
                workspace_id,
                token,
                application,
                cut,
                max_bytes,
                max_events,
                faults,
                reservation: _reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    adopt_owner_committed(
                        store,
                        &application,
                        cut,
                        max_bytes,
                        max_events,
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .ok()
                            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
                            .ok_or(RuntimeError::ActorUnavailable)?,
                        faults.as_ref(),
                    )
                    .map_err(Into::into)
                });
                let _ = reply.send(result);
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
                reservation: _reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    if cancel.is_cancelled() {
                        return Err(RuntimeError::ActorUnavailable);
                    }
                    with_settlement(
                        store,
                        &application,
                        terminal,
                        max_applications,
                        |store, audit| {
                            settle_audited(
                                store,
                                cache,
                                &root,
                                audit,
                                now_ms,
                                faults.as_ref(),
                                &cancel,
                            )
                        },
                    )
                });
                let _ = reply.send(result);
            }
            Self::Bootstrap {
                workspace_id,
                token,
                application,
                input,
                bytes,
                root,
                faults,
                reservation: _reservation,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    bootstrap_committed(
                        store,
                        cache,
                        &application,
                        input,
                        bytes,
                        faults.as_ref(),
                        |tx, written| {
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
                let _ = reply.send(result);
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
                    let application = ApplicationOwner::new(workspace_id.clone())?;
                    if let Some(old) = registry.0.get_mut(&workspace_id) {
                        old.token.store(false, Ordering::Release);
                        old.application.invalidate(store)?;
                    }
                    registry
                        .0
                        .insert(workspace_id, OwnedRegistration { token, application });
                    Ok(())
                })();
                let _ = reply.send(result);
            }
            Self::Register {
                workspace_id,
                token,
                namespace,
                coordinate,
                binding,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|owner| {
                    owner
                        .register(store, namespace, coordinate, binding)
                        .map_err(Into::into)
                });
                let _ = reply.send(result);
            }
            Self::Apply {
                workspace_id,
                token,
                application,
                event,
                faults,
                reservation: _reservation,
                working_reserve_bytes,
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    apply_committed(
                        store,
                        cache,
                        &application,
                        event,
                        faults.as_ref(),
                        working_reserve_bytes,
                    )
                    .map_err(Into::into)
                });
                let _ = reply.send(result);
            }
            Self::Close {
                workspace_id,
                token,
                reply,
            } => {
                let result = if let Some(entry) = registry
                    .0
                    .get_mut(&workspace_id)
                    .filter(|entry| Arc::ptr_eq(&entry.token, &token))
                {
                    entry.application.invalidate(store).map_err(Into::into)
                } else {
                    Err(RuntimeError::ActorUnavailable)
                };
                if result.is_ok() {
                    registry.0.remove(&workspace_id);
                }
                let _ = reply.send(result);
            }
        }
    }
}

fn settle_audited(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    root: &std::path::Path,
    audit: &dohc_engine_collab::live_update_application::LiveSettlementAudit,
    now_ms: i64,
    faults: &dyn FaultInjector,
    cancel: &tokio_util::sync::CancellationToken,
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
        None,
        "configured-live-application",
        &(),
        now_ms,
        faults,
        cancel,
        None,
        Some(audit),
    )?;
    let settled = outcome.into_settlement_for_internal_caller()?;
    let id = audit.stored_id(store, &settled.moment_id, &settled.sha256)?;
    let mut result = audit.result(id, settled.moment_id, settled.sha256, settled.materialized);
    result.collection_reconcile_required = settled.collection_reconcile_required;
    Ok(result)
}
