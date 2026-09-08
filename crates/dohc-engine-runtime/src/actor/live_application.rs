use super::{ActorHandle, Command, LifecycleState};
use crate::RuntimeError;
use dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, ApplicationError, ApplicationHandle, ApplicationHostCoordinate,
    ApplicationOwner, ApplicationResult, apply_committed,
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
    /// Retire handles synchronously at the transport's close boundary.
    pub fn retire(&self) {
        self.token.store(false, Ordering::Release);
    }

    pub fn is_current(&self) -> bool {
        current(&self.actor, &self.token).is_ok()
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
    /// Apply committed bytes through the actor-owned store and cache.
    /// The transport must still suppress replies after its connection closes.
    pub async fn apply(
        &self,
        event: AdmittedLiveUpdate,
        faults: Arc<dyn FaultInjector>,
    ) -> Result<ApplicationResult, RuntimeError> {
        self.apply_with_reservation(event, faults, None).await
    }

    /// Keep input memory charged while its command remains on the writer queue,
    /// even when the caller stops awaiting the result.
    pub async fn apply_with_reservation(
        &self,
        event: AdmittedLiveUpdate,
        faults: Arc<dyn FaultInjector>,
        reservation: Option<Arc<dyn Send + Sync>>,
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
                reply,
            } => {
                let result = registry.owner(&workspace_id, &token).and_then(|_| {
                    apply_committed(store, cache, &application, event, faults.as_ref())
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
