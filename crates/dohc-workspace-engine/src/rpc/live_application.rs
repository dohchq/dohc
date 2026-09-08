use super::error::{map_runtime, wire, workspace_unavailable};
use super::workspace::{OpenWorkspace, WorkspaceOpenMode};
use crate::{EngineService, lock};
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, ApplicationHostCoordinate, ApplicationResult, BootstrapResult,
    LiveApplicationBootstrap,
};
use dohc_engine_protocol::cancel::CancelSignal;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::{
    ConnectionHandle, ConnectionResource, OutputGuard, RequestContext, ServiceResponse,
};
use dohc_engine_protocol::wire::{Request, Response, WorkspaceHandle};
use dohc_engine_runtime::actor::{ActorLiveApplicationHandle, ActorLiveApplicationOwner};
use dohc_engine_storage::NoFaults;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

/// Explicit host provisioning for the private admitted-update path.
#[doc(hidden)]
pub struct LiveApplicationHostConfig {
    pub workspace: WorkspaceHandle,
    pub namespace: String,
    pub coordinate: ApplicationHostCoordinate,
    pub max_registrations: usize,
}

pub(crate) struct Host {
    output_fence: Mutex<Vec<Weak<Registration>>>,
    open: Arc<OpenWorkspace>,
    connection: ConnectionHandle,
    owner: ActorLiveApplicationOwner,
    namespace: String,
    coordinate: ApplicationHostCoordinate,
    max_registrations: usize,
}

impl std::fmt::Debug for Host {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveApplicationHost")
            .finish_non_exhaustive()
    }
}

impl ConnectionResource for Host {
    fn retire(&self) {
        let registrations = lock(&self.output_fence);
        for registration in registrations.iter().filter_map(Weak::upgrade) {
            registration.retired.cancel();
        }
        self.owner.retire();
    }
}

impl Host {
    fn current(&self, connection: &ConnectionHandle) -> bool {
        self.connection.same_connection(connection)
            && self.connection.is_current()
            && self.owner.is_current()
    }
}

pub(crate) struct Registration {
    host: Arc<Host>,
    handle: ActorLiveApplicationHandle,
    object_id: String,
    retired: CancelSignal,
}

#[derive(Default)]
pub(crate) struct Registry {
    hosts: HashMap<WorkspaceHandle, Arc<Host>>,
    registrations: HashMap<u64, Arc<Registration>>,
    next_registration: u64,
}

impl Registry {
    pub(crate) fn retire_workspace(&mut self, workspace: &Arc<OpenWorkspace>) {
        self.hosts.retain(|_, host| {
            if Arc::ptr_eq(&host.open, workspace) {
                host.retire();
                false
            } else {
                true
            }
        });
        self.registrations
            .retain(|_, registration| !Arc::ptr_eq(&registration.host.open, workspace));
    }
}

/// Owned input; only the provisioned ingress can construct one.
#[doc(hidden)]
pub struct LiveApplicationInput {
    pub(crate) registration: Arc<Registration>,
    pub(crate) operation: LiveApplicationOperation,
    pub(crate) reservation: Arc<dyn Send + Sync>,
}

#[derive(Clone)]
pub(crate) enum LiveApplicationOperation {
    Apply(AdmittedLiveUpdate),
    Bootstrap(LiveApplicationBootstrap, Vec<u8>),
}

struct ApplicationOutputGuard {
    registration: Arc<Registration>,
    cancel: CancelSignal,
    deadline: Option<Instant>,
    _reservation: Arc<dyn Send + Sync>,
}

struct RetireOnCancellation(Option<Arc<Host>>);
impl Drop for RetireOnCancellation {
    fn drop(&mut self) {
        if let Some(host) = &self.0 {
            host.retire();
        }
    }
}

impl std::fmt::Debug for ApplicationOutputGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApplicationOutputGuard")
            .finish_non_exhaustive()
    }
}

impl OutputGuard for ApplicationOutputGuard {
    fn cancel_signal(&self) -> CancelSignal {
        self.cancel.clone()
    }
    fn retirement_signal(&self) -> CancelSignal {
        self.registration.retired.clone()
    }
    fn with_current(&self, action: &mut dyn FnMut()) -> bool {
        let _fence = lock(&self.registration.host.output_fence);
        if !self.is_current() {
            return false;
        }
        action();
        true
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn is_current(&self) -> bool {
        self.registration
            .host
            .current(&self.registration.host.connection)
            && !self.registration.retired.is_cancelled()
            && !self.cancel.is_cancelled()
            && self
                .deadline
                .is_none_or(|deadline| Instant::now() < deadline)
    }
}

impl EngineService {
    /// Trusted host setup. No RPC derives these fields from a caller's event.
    #[doc(hidden)]
    pub async fn provision_live_application(
        &self,
        connection: ConnectionHandle,
        config: LiveApplicationHostConfig,
    ) -> Result<(), WireError> {
        if !connection.is_current() || config.max_registrations == 0 {
            return Err(wire(
                ErrorCode::InvalidParams,
                "invalid-live-application-host",
            ));
        }
        let open = self.open(Some(&config.workspace))?;
        if open.mode != WorkspaceOpenMode::Full {
            return Err(wire(ErrorCode::InvalidParams, "workspace-read-only"));
        }
        let _serial = Arc::clone(&open.session_ops).lock_owned().await;
        if !Arc::ptr_eq(&self.open(Some(&config.workspace))?, &open) {
            return Err(workspace_unavailable());
        }
        let owner = open
            .actor
            .live_application_owner(open.workspace_id.clone())
            .await
            .map_err(map_runtime)?;
        let host = Arc::new(Host {
            output_fence: Mutex::new(Vec::new()),
            open,
            connection: connection.clone(),
            owner,
            namespace: config.namespace,
            coordinate: config.coordinate,
            max_registrations: config.max_registrations,
        });
        if !connection.retain(&(host.clone() as Arc<dyn ConnectionResource>)) {
            return Err(workspace_unavailable());
        }
        self.install_live_application_host(config.workspace, host)
    }

    fn install_live_application_host(
        &self,
        workspace: WorkspaceHandle,
        host: Arc<Host>,
    ) -> Result<(), WireError> {
        let mut registry = lock(&self.live_applications);
        if !self
            .open(Some(&workspace))
            .is_ok_and(|open| Arc::ptr_eq(&open, &host.open))
            || !host.current(&host.connection)
        {
            host.retire();
            return Err(workspace_unavailable());
        }
        if let Some(old) = registry.hosts.insert(workspace, host) {
            old.retire();
            registry
                .registrations
                .retain(|_, registration| !Arc::ptr_eq(&registration.host, &old));
        }
        Ok(())
    }

    pub(super) async fn live_application_register(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Params {
            binding: LiveObjectBinding,
        }
        let params: Params = serde_json::from_value(params)
            .map_err(|_| wire(ErrorCode::InvalidParams, "invalid-live-registration"))?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let workspace = workspace.ok_or_else(workspace_unavailable)?;
        let host = lock(&self.live_applications)
            .hosts
            .get(&workspace)
            .cloned()
            .ok_or_else(workspace_unavailable)?;
        let _serial = Arc::clone(&host.open.session_ops).lock_owned().await;
        if !host.current(connection) || !Arc::ptr_eq(&self.open(Some(&workspace))?, &host.open) {
            return Err(workspace_unavailable());
        }
        // Re-registering an object retires its queued acknowledgements under the
        // same fence as output polling, before the replacement writer command.
        {
            let mut registry = lock(&self.live_applications);
            let _fence = lock(&host.output_fence);
            registry.registrations.retain(|_, registration| {
                if Arc::ptr_eq(&registration.host, &host)
                    && registration.object_id == params.binding.object_id
                {
                    registration.retired.cancel();
                    false
                } else {
                    true
                }
            });
        }
        if lock(&self.live_applications)
            .registrations
            .values()
            .filter(|registration| Arc::ptr_eq(&registration.host, &host))
            .count()
            >= host.max_registrations
        {
            return Err(wire(ErrorCode::Overloaded, "live-registration-capacity"));
        }
        let object_id = params.binding.object_id.clone();
        let handle = host
            .owner
            .register(
                host.namespace.clone(),
                host.coordinate.clone(),
                params.binding,
            )
            .await
            .map_err(map_runtime)?;
        let mut registry = lock(&self.live_applications);
        if !host.current(connection) || !Arc::ptr_eq(&self.open(Some(&workspace))?, &host.open) {
            return Err(workspace_unavailable());
        }
        let id = registry
            .next_registration
            .checked_add(1)
            .filter(|id| *id <= 9_007_199_254_740_991)
            .ok_or_else(|| wire(ErrorCode::Overloaded, "live-registration-capacity"))?;
        registry.next_registration = id;
        let registration = Arc::new(Registration {
            host: host.clone(),
            handle,
            object_id,
            retired: CancelSignal::new(),
        });
        {
            let mut registrations = lock(&host.output_fence);
            registrations.retain(|registration| registration.strong_count() > 0);
            registrations.push(Arc::downgrade(&registration));
        }
        registry.registrations.insert(id, registration);
        Ok(json!({ "registrationId": id }))
    }

    pub(crate) fn live_application_registration(
        &self,
        connection: &ConnectionHandle,
        workspace: Option<&WorkspaceHandle>,
        registration_id: u64,
    ) -> Result<Arc<Registration>, WireError> {
        let open = self.open(workspace)?;
        let registration = lock(&self.live_applications)
            .registrations
            .get(&registration_id)
            .cloned()
            .ok_or_else(workspace_unavailable)?;
        if !registration.host.current(connection)
            || registration.retired.is_cancelled()
            || !Arc::ptr_eq(&registration.host.open, &open)
        {
            return Err(workspace_unavailable());
        }
        Ok(registration)
    }

    pub(crate) async fn live_application_apply(
        &self,
        ctx: RequestContext,
        request: Request,
        input: LiveApplicationInput,
    ) -> Result<ServiceResponse, WireError> {
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let method = match &input.operation {
            LiveApplicationOperation::Apply(_) => "liveApplication.apply",
            LiveApplicationOperation::Bootstrap(..) => "liveApplication.bootstrap",
        };
        if request.method != method
            || !input.registration.host.current(connection)
            || input.registration.retired.is_cancelled()
            || !Arc::ptr_eq(
                &self.open(request.workspace.as_ref())?,
                &input.registration.host.open,
            )
        {
            return Err(workspace_unavailable());
        }
        let host = input.registration.host.clone();
        let serial = Arc::clone(&host.open.session_ops).lock_owned().await;
        if !host.current(connection)
            || input.registration.retired.is_cancelled()
            || ctx.cancel.is_cancelled()
            || ctx.deadline.is_some_and(|end| Instant::now() >= end)
        {
            return Err(wire(ErrorCode::Cancelled, "live-application-retired"));
        }
        // The writer command holds the permit independently of this future.
        let guard = Arc::new(ApplicationOutputGuard {
            registration: input.registration.clone(),
            cancel: ctx.cancel,
            deadline: ctx.deadline,
            _reservation: input.reservation.clone(),
        });
        // Keep the workspace fence until the writer is terminal if the RPC is cancelled.
        let mut retirement = RetireOnCancellation(Some(host.clone()));
        let operation = tokio::spawn(async move {
            let _serial = serial;
            match input.operation {
                LiveApplicationOperation::Apply(event) => input
                    .registration
                    .handle
                    .apply_with_reservation(event, Arc::new(NoFaults), Some(input.reservation))
                    .await
                    .map(|result| match result {
                        ApplicationResult::Applied(ack) => {
                            json!({ "status": "applied", "ack": ack })
                        }
                        ApplicationResult::Pending(reason) => pending_result(reason),
                    }),
                LiveApplicationOperation::Bootstrap(metadata, bytes) => input
                    .registration
                    .handle
                    .bootstrap(
                        metadata,
                        bytes,
                        input.registration.host.open.root.clone(),
                        Arc::new(NoFaults),
                        Some(input.reservation),
                    )
                    .await
                    .map(|result| match result {
                        BootstrapResult::Bootstrapped(ack) => {
                            json!({ "status": "bootstrapped", "ack": ack })
                        }
                        BootstrapResult::Pending(reason) => pending_result(reason),
                    }),
            }
        });
        let outcome = operation.await;
        retirement.0 = None;
        let outcome = outcome
            .map_err(|_| wire(ErrorCode::Internal, "live-application-interrupted"))?
            .map_err(map_runtime)?;
        if !guard.is_current() {
            return Err(wire(ErrorCode::Cancelled, "live-application-retired"));
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: outcome,
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }
}

fn pending_result(
    reason: dohc_engine_collab::live_update_application::ApplicationPending,
) -> Value {
    use dohc_engine_collab::live_update_application::ApplicationPending;
    json!({ "status": "pending", "reason": match reason {
        ApplicationPending::DependenciesUnresolved => "dependencies-unresolved",
        ApplicationPending::BaselineUnavailable => "baseline-unavailable",
        ApplicationPending::ApplicabilityUnavailable => "applicability-unavailable",
        ApplicationPending::BindingMismatch => "binding-mismatch",
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_application_ingress::{
        LiveApplicationIngress,
        tests::{config, fixture, request},
    };
    use dohc_engine_collab::Ydoc;
    use dohc_engine_protocol::transport::EngineService as _;
    use dohc_engine_protocol::wire::BlobStart;
    use dohc_engine_storage::hex_sha256;

    #[tokio::test]
    async fn provisioning_completed_after_workspace_close_cannot_install_a_host() {
        let (_scratch, service, _owner, workspace, _, _) = fixture().await;
        let handle = WorkspaceHandle(workspace);
        let host = {
            let mut registry = lock(&service.live_applications);
            registry.registrations.clear();
            registry.hosts.remove(&handle).unwrap()
        };
        assert!(host.owner.is_current());
        service.workspace_close(Some(handle.clone())).await.unwrap();
        assert!(
            service
                .install_live_application_host(handle.clone(), host.clone())
                .is_err()
        );
        assert!(!host.owner.is_current());
        assert!(!lock(&service.live_applications).hosts.contains_key(&handle));
    }
    #[tokio::test]
    async fn dropping_an_apply_waiting_for_session_serialization_preserves_the_host() {
        let (_scratch, service, owner, workspace, registration, binding) = fixture().await;
        let mut ingress = LiveApplicationIngress::new(service.clone(), config()).unwrap();
        let bytes = Ydoc::wire().plaintext_insert(0, "queued");
        ingress
            .begin(
                request(&workspace, registration, &binding, &bytes, &[]),
                &owner.handle(),
            )
            .unwrap();
        for (id, contents) in [(1, bytes.as_slice()), (2, &[][..])] {
            ingress
                .start(BlobStart {
                    request_id: 3,
                    stream_id: id,
                    total_bytes: Some(contents.len() as u64),
                    sha256: Some(hex_sha256(contents)),
                })
                .unwrap();
        }
        ingress.chunk(1, true, &bytes).unwrap();
        let (request, input) = ingress.chunk(2, true, &[]).unwrap().unwrap();
        let retry = LiveApplicationInput {
            registration: input.registration.clone(),
            operation: input.operation.clone(),
            reservation: input.reservation.clone(),
        };
        let handle = dohc_engine_protocol::wire::WorkspaceHandle(workspace);
        let open = service.open(Some(&handle)).unwrap();
        let serial = open.session_ops.lock().await;
        let context = || {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            ctx
        };
        let mut operation =
            Box::pin(service.call_with_input(context(), request.clone(), Some(input)));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(operation.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        drop(operation);
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&handle), registration)
                .is_ok()
        );
        drop(serial);
        let response = service
            .call_with_input(context(), request, Some(retry))
            .await
            .unwrap();
        assert_eq!(response.response.result["status"], "applied");
    }
}
