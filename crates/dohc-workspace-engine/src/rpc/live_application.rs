use super::error::{map_runtime, workspace_unavailable};
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
    pub(super) fn hosts_current(&self, connection: &ConnectionHandle) -> bool {
        !self.hosts.is_empty() && self.hosts.values().all(|host| host.current(connection))
    }

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
    pub(super) async fn live_application_settle(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            registration_id: u64,
            terminal_receipt:
                Option<dohc_engine_collab::live_update_application::LiveUpdateReceipt>,
        }
        if request.idempotency_key.is_some() || request.params.get("terminalReceipt").is_none() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-live-settlement",
            ));
        }
        let params: Params = serde_json::from_value(request.params)
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-live-settlement"))?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let registration = self.live_application_registration(
            connection,
            request.workspace.as_ref(),
            params.registration_id,
        )?;
        let host = registration.host.clone();
        let cancellation = super::request::OperationCancellation::new(&ctx);
        // Check synchronously too: the token's deadline bridge may not have run yet.
        let check_interruption = || {
            if ctx.cancel.is_cancelled() {
                Err(WireError::new(
                    ErrorCode::Cancelled,
                    "live settlement cancelled",
                ))
            } else if ctx.deadline.is_some_and(|end| Instant::now() >= end) {
                Err(WireError::new(
                    ErrorCode::DeadlineExceeded,
                    "live settlement deadline elapsed",
                ))
            } else {
                Ok(())
            }
        };
        check_interruption()?;
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("live settlement (queued)"));
            }
            serial = Arc::clone(&host.open.session_ops).lock_owned() => serial,
        };
        check_interruption()?;
        if !host.current(connection)
            || registration.retired.is_cancelled()
            || !Arc::ptr_eq(&self.open(request.workspace.as_ref())?, &host.open)
        {
            return Err(WireError::new(
                ErrorCode::Cancelled,
                "live-application-retired",
            ));
        }
        let (max_applications, reservation) = self.configured_settlement_admission(&ctx)?;
        let now_ms = super::request::now_ms()?;
        let token = cancellation.token();
        let guard = Arc::new(ApplicationOutputGuard {
            registration: registration.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            _reservation: reservation.clone(),
        });
        let mut retirement = RetireOnCancellation(Some(host));
        let operation = tokio::spawn(async move {
            let _serial = serial;
            registration
                .handle
                .settle(
                    params.terminal_receipt,
                    max_applications,
                    registration.host.open.root.clone(),
                    now_ms,
                    Arc::new(NoFaults),
                    token,
                    reservation,
                )
                .await
        });
        let outcome = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("live settlement"));
            }
            outcome = operation => outcome,
        };
        retirement.0 = None;
        check_interruption()?;
        let result = outcome
            .map_err(|_| WireError::new(ErrorCode::Internal, "live-application-interrupted"))?
            .map_err(map_runtime)?;
        if !guard.is_current() {
            check_interruption()?;
            return Err(WireError::new(
                ErrorCode::Cancelled,
                "live-application-retired",
            ));
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!({"status":"settled", "settlement":result}),
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }

    /// Trusted host setup. No RPC derives these fields from a caller's event.
    #[doc(hidden)]
    pub async fn provision_live_application(
        &self,
        connection: ConnectionHandle,
        config: LiveApplicationHostConfig,
    ) -> Result<(), WireError> {
        if !connection.is_current() || config.max_registrations == 0 {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-live-application-host",
            ));
        }
        let open = self.open(Some(&config.workspace))?;
        if open.mode != WorkspaceOpenMode::Full {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "workspace-read-only",
            ));
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
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-live-registration"))?;
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
        host.owner
            .validate_binding(params.binding.clone())
            .await
            .map_err(map_runtime)?;
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
            return Err(WireError::new(
                ErrorCode::Overloaded,
                "live-registration-capacity",
            ));
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
            .ok_or_else(|| WireError::new(ErrorCode::Overloaded, "live-registration-capacity"))?;
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
            return Err(WireError::new(
                ErrorCode::Cancelled,
                "live-application-retired",
            ));
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
            .map_err(|_| WireError::new(ErrorCode::Internal, "live-application-interrupted"))?
            .map_err(map_runtime)?;
        if !guard.is_current() {
            return Err(WireError::new(
                ErrorCode::Cancelled,
                "live-application-retired",
            ));
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

    async fn settle_queued_interruption(deadline: bool) {
        let (_scratch, service, owner, workspace, registration, _) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        let open = service.open(Some(&workspace)).unwrap();
        let serial = open.session_ops.lock().await;
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        if deadline {
            tokio::time::pause();
            ctx.deadline =
                Some(tokio::time::Instant::now().into_std() + std::time::Duration::from_secs(60));
        }
        let cancel = ctx.cancel.clone();
        let request = Request {
            id: 71,
            method: "liveApplication.settle".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            params: json!({"registrationId": registration, "terminalReceipt": null}),
        };
        let mut waiting = Box::pin(service.live_application_settle(ctx, request));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        if deadline {
            tokio::time::advance(std::time::Duration::from_secs(61)).await;
        } else {
            cancel.cancel();
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), waiting).await;
        if deadline {
            tokio::time::resume();
        }
        assert!(
            result.is_ok(),
            "queued settlement must stop before the serial is released"
        );
        let error = result.unwrap().unwrap_err();
        assert_eq!(
            error.code,
            if deadline {
                ErrorCode::DeadlineExceeded
            } else {
                ErrorCode::Cancelled
            }
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), registration)
                .is_ok(),
            "a request cancelled before actor submission must preserve the host"
        );
        drop(serial);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn settle_queued_cancel_does_not_wait_for_session_serialization() {
        settle_queued_interruption(false).await;
    }

    #[tokio::test]
    async fn settle_queued_deadline_does_not_wait_for_session_serialization() {
        settle_queued_interruption(true).await;
    }

    #[tokio::test]
    async fn settle_expired_deadline_preserves_the_deadline_error_before_submission() {
        let (_scratch, service, owner, workspace, registration, _) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        ctx.deadline = Some(Instant::now());
        let request = Request {
            id: 73,
            method: "liveApplication.settle".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            params: json!({"registrationId": registration, "terminalReceipt": null}),
        };
        assert_eq!(
            service
                .live_application_settle(ctx, request)
                .await
                .unwrap_err()
                .code,
            ErrorCode::DeadlineExceeded
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), registration)
                .is_ok()
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    async fn settle_actor_interruption(deadline: bool) {
        use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
        struct BlockWriter {
            started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
            release: Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl FaultInjector for BlockWriter {
            fn poll(&self, point: FaultPoint) -> FaultAction {
                if point == FaultPoint::StorageBeforePersist
                    && let Some(started) = lock(&self.started).take()
                {
                    let _ = started.send(());
                    lock(&self.release)
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                }
                FaultAction::Continue
            }
        }
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let configuration = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "cancel-test",
            "host": {"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": [{"root":scratch.path(),"workspaceId":"workspace","maxRegistrations":4}],
            "ingress": {"aggregateBytes":400_000_000,"applicationWorkingReserveBytes":1_000_000,"maxUploads":1,"uploadDeadlineMs":30_000},
            "settlement": {"maxApplicationsPerSettlement":4}
        })).unwrap();
        let (service, owner, ingress) = EngineService::configured_live_host(configuration)
            .await
            .unwrap();
        let workspace = lock(&service.handles).keys().next().unwrap().clone();
        let open = service.open(Some(&workspace)).unwrap();
        open.actor
            .ensure_main_version(
                "workspace".into(),
                0,
                Arc::new(NoFaults),
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
            .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "document".into(),
            lineage_claim_id: hex_sha256(&Ydoc::wire().encode_full_state()),
            current_path: "document.md".into(),
            selector_paths: vec!["document.md".into()],
            restore_fence_generation: 0,
        };
        let registration = service
            .live_application_register(&ctx, Some(workspace.clone()), json!({"binding": binding}))
            .await
            .unwrap()["registrationId"]
            .as_u64()
            .unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let actor = open.actor.clone();
        let blocker = tokio::spawn(async move {
            actor
                .ensure_main_version(
                    "blocking-workspace".into(),
                    0,
                    Arc::new(BlockWriter {
                        started: Mutex::new(Some(started_tx)),
                        release: Mutex::new(release_rx),
                    }),
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await
        });
        started_rx.await.unwrap();
        if deadline {
            tokio::time::pause();
            ctx.deadline =
                Some(tokio::time::Instant::now().into_std() + std::time::Duration::from_secs(60));
        }
        let cancel = ctx.cancel.clone();
        let request = Request {
            id: 72,
            method: "liveApplication.settle".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            params: json!({"registrationId":registration,"terminalReceipt":null}),
        };
        let mut waiting = Box::pin(service.live_application_settle(ctx, request));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        if deadline {
            tokio::time::advance(std::time::Duration::from_secs(61)).await;
        } else {
            cancel.cancel();
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), waiting).await;
        if deadline {
            tokio::time::resume();
        }
        let serial_held = open.session_ops.try_lock().is_err();
        let reservation_held = ingress.settlement_admission(4).unwrap().reserve().is_err();
        let host_retired = service
            .live_application_registration(&owner.handle(), Some(&workspace), registration)
            .is_err();
        release_tx.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        let serial =
            tokio::time::timeout(std::time::Duration::from_secs(1), open.session_ops.lock())
                .await
                .unwrap();
        drop(serial);
        let admission = ingress.settlement_admission(4).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while admission.reserve().is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("actor completion releases admission");
        service.workspace_close(Some(workspace)).await.unwrap();
        assert!(
            result.is_ok(),
            "cancelled settlement must return before the blocked actor is released"
        );
        assert_eq!(
            result.unwrap().unwrap_err().code,
            if deadline {
                ErrorCode::DeadlineExceeded
            } else {
                ErrorCode::Cancelled
            }
        );
        assert!(
            serial_held,
            "actor work must retain session exclusion after RPC cancellation"
        );
        assert!(
            reservation_held,
            "actor work must retain its admission charge after RPC cancellation"
        );
        assert!(
            host_retired,
            "cancelled submitted work must retire the host before a retry"
        );
    }

    #[tokio::test]
    async fn settle_actor_cancel_keeps_exclusion_and_reservation_until_completion() {
        settle_actor_interruption(false).await;
    }

    #[tokio::test]
    async fn settle_actor_deadline_keeps_exclusion_and_reservation_until_completion() {
        settle_actor_interruption(true).await;
    }

    #[tokio::test]
    async fn invalid_live_application_replacement_preserves_the_registration() {
        let (scratch, service, owner, workspace, registration, binding) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let original = service
            .live_application_registration(&owner.handle(), Some(&workspace), registration)
            .unwrap();
        let mut noncanonical = binding.clone();
        noncanonical
            .selector_paths
            .push(noncanonical.current_path.clone());
        let mut wrong_workspace = binding.clone();
        wrong_workspace.workspace_id = "another-workspace".into();
        let mut wrong_main = binding.clone();
        wrong_main.main_version_id = "another-main".into();
        for invalid in [noncanonical, wrong_workspace, wrong_main] {
            assert!(
                service
                    .live_application_register(
                        &ctx,
                        Some(workspace.clone()),
                        json!({ "binding": invalid })
                    )
                    .await
                    .is_err()
            );
            assert!(!original.retired.is_cancelled());
            assert!(
                service
                    .live_application_registration(&owner.handle(), Some(&workspace), registration)
                    .is_ok()
            );
            let db = rusqlite::Connection::open_with_flags(
                scratch.path().join(".dohc/engine/engine.db"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let available: i64 = db
                .query_row(
                    "SELECT available FROM live_device_application_bindings WHERE object_id=?1",
                    [&binding.object_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(available, 1);
        }
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn live_application_state_is_retired_when_a_closed_actor_is_evicted() {
        let (scratch, service, owner, workspace, registration_id, _) = fixture().await;
        let handle = WorkspaceHandle(workspace);
        let registration = lock(&service.live_applications)
            .registrations
            .get(&registration_id)
            .unwrap()
            .clone();
        let old_open = Arc::downgrade(&registration.host.open);
        let supervisor = service.supervisor;
        let db_path = scratch.path().join(".dohc/engine/engine.db");
        tokio::task::spawn_blocking(move || supervisor.close(&db_path))
            .await
            .unwrap()
            .unwrap();

        let reopened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({ "rootDir": scratch.path(), "workspaceId": "workspace", "captureMode": "none" }),
            )
            .await
            .unwrap();
        let rebound: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).unwrap();
        assert_ne!(rebound, handle);
        assert!(registration.retired.is_cancelled());
        assert!(!registration.host.owner.is_current());
        assert!(owner.handle().is_current());
        {
            let registry = lock(&service.live_applications);
            assert!(registry.hosts.is_empty());
            assert!(registry.registrations.is_empty());
        }
        drop(registration);
        assert!(old_open.upgrade().is_none());
        service.workspace_close(Some(rebound)).await.unwrap();
    }

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
