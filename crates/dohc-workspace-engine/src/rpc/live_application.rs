use super::error::{map_runtime, wire, workspace_unavailable};
use super::workspace::{OpenWorkspace, WorkspaceOpenMode};
use crate::{EngineService, lock};
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, ApplicationHostCoordinate, ApplicationResult,
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
    pub(crate) event: AdmittedLiveUpdate,
    pub(crate) reservation: Arc<dyn Send + Sync>,
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
        let mut registry = lock(&self.live_applications);
        if let Some(old) = registry.hosts.insert(config.workspace, host) {
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
        if !host.current(connection) {
            return Err(workspace_unavailable());
        }
        let mut registry = lock(&self.live_applications);
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
        if request.method != "liveApplication.apply"
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
        let mut retirement = RetireOnCancellation(Some(host.clone()));
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
        let operation = tokio::spawn(async move {
            let _serial = serial;
            input
                .registration
                .handle
                .apply_with_reservation(input.event, Arc::new(NoFaults), Some(input.reservation))
                .await
        });
        let outcome = operation.await;
        retirement.0 = None;
        let outcome = outcome
            .map_err(|_| wire(ErrorCode::Internal, "live-application-interrupted"))?
            .map_err(map_runtime)?;
        if !guard.is_current() {
            return Err(wire(ErrorCode::Cancelled, "live-application-retired"));
        }
        let result = match outcome {
            ApplicationResult::Applied(ack) => json!({ "status": "applied", "ack": ack }),
            ApplicationResult::Pending(reason) => {
                json!({ "status": "pending", "reason": match reason {
                    dohc_engine_collab::live_update_application::ApplicationPending::DependenciesUnresolved => "dependencies-unresolved",
                    dohc_engine_collab::live_update_application::ApplicationPending::BaselineUnavailable => "baseline-unavailable",
                    dohc_engine_collab::live_update_application::ApplicationPending::ApplicabilityUnavailable => "applicability-unavailable",
                    dohc_engine_collab::live_update_application::ApplicationPending::BindingMismatch => "binding-mismatch",
                }})
            }
        };
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result,
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }
}
