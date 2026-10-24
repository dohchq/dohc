use super::error::{map_runtime, workspace_unavailable};
use super::workspace::{OpenWorkspace, WorkspaceOpenMode};
use crate::{EngineService, lock};
use dohc_engine_collab::DocKey;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, ApplicationError, ApplicationHostCoordinate, ApplicationResult,
    BootstrapResult, LiveApplicationBootstrap, NativeRestoreFence, RetiredActivations,
    UnloadPending,
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
pub(crate) mod restore;
pub(crate) mod sync;

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
    retired: CancelSignal,
    open: Arc<OpenWorkspace>,
    connection: ConnectionHandle,
    owner: ActorLiveApplicationOwner,
    /// The activations a retirement tore down; shared with `owner`.
    retired_activations: RetiredActivations,
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
        self.retired.cancel();
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

    fn retired_activations(&self) -> RetiredActivations {
        self.retired_activations.clone()
    }
}

pub(crate) struct Registration {
    host: Arc<Host>,
    handle: ActorLiveApplicationHandle,
    object_id: String,
    binding: LiveObjectBinding,
    retired: CancelSignal,
}

impl Registration {
    /// The activation this registration serves, as its native registration
    /// resolved it, including one its adoption made.
    pub(crate) fn activation_id(&self) -> Option<String> {
        self.handle.activation_id()
    }
}

#[derive(Default)]
pub(crate) struct Registry {
    hosts: HashMap<WorkspaceHandle, Arc<Host>>,
    registrations: HashMap<u64, Arc<Registration>>,
    next_registration: u64,
}

impl Registry {
    /// True for an empty registry: a configured host may run with no workspace.
    pub(super) fn hosts_current(&self, connection: &ConnectionHandle) -> bool {
        self.hosts.values().all(|host| host.current(connection))
    }

    pub(super) fn has_host(&self, workspace: &WorkspaceHandle) -> bool {
        self.hosts.contains_key(workspace)
    }

    /// The activations the workspace's host retired, once it has a host.
    pub(super) fn retired_activations(
        &self,
        workspace: &WorkspaceHandle,
    ) -> Option<RetiredActivations> {
        self.hosts
            .get(workspace)
            .map(|host| host.retired_activations())
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
#[derive(Clone)]
pub enum LiveApplicationInput {
    Replica(Box<super::replica::ReplicaInput>),
    Admitted(Box<AdmittedApplicationInput>),
    Restore(Box<restore::RestoreInput>),
    Owner(Box<super::owner_delivery::OwnerInput>),
}

#[doc(hidden)]
#[derive(Clone)]
pub struct AdmittedApplicationInput {
    pub(crate) registration: Arc<Registration>,
    pub(crate) operation: LiveApplicationOperation,
    pub(crate) reservation: Arc<dyn Send + Sync>,
    pub(crate) working_reserve_bytes: usize,
}

#[derive(Clone)]
pub(crate) enum LiveApplicationOperation {
    SyncOpen(
        Vec<u8>,
        dohc_engine_collab::live_update_application::AppliedSyncPolicy,
    ),
    Apply(AdmittedLiveUpdate),
    Bootstrap(LiveApplicationBootstrap, Vec<u8>),
    AdoptOwner {
        registration_id: u64,
        session_id: String,
        cut: dohc_engine_collab::live_update_application::OwnerAdoptionCut,
        max_bytes: usize,
        max_events: usize,
    },
}

struct ApplicationOutputGuard {
    registration: Arc<Registration>,
    /// The activation the guarded output belongs to.
    activation_id: Option<String>,
    cancel: CancelSignal,
    deadline: Option<Instant>,
    reservation: Mutex<Option<Arc<dyn Send + Sync>>>,
}

struct RetireOnCancellation(Option<Arc<Host>>);
impl Drop for RetireOnCancellation {
    fn drop(&mut self) {
        if let Some(host) = &self.0 {
            host.retire();
        }
    }
}

/// Output a workspace's live host answers, withheld once the host retires:
/// its connection ends or its workspace detaches.
#[derive(Debug)]
struct HostOutputGuard {
    host: Arc<Host>,
    cancel: CancelSignal,
    deadline: Option<Instant>,
    /// A read's answer, which has no side effect, so its caller is told
    /// when it is cancelled, expires, or its host retires, rather than left
    /// waiting, for as long as its connection lasts.
    read: bool,
}

impl OutputGuard for HostOutputGuard {
    fn cancel_signal(&self) -> CancelSignal {
        self.cancel.clone()
    }
    fn retirement_signal(&self) -> CancelSignal {
        self.host.retired.clone()
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn is_current_ignoring_cancel(&self) -> bool {
        self.host.current(&self.host.connection)
            && self
                .deadline
                .is_none_or(|deadline| Instant::now() < deadline)
    }
    fn with_current(&self, cancellable: bool, action: &mut dyn FnMut()) -> bool {
        let _fence = lock(&self.host.output_fence);
        if !self.is_current_ignoring_cancel() || (cancellable && self.cancel.is_cancelled()) {
            return false;
        }
        action();
        true
    }
    fn with_unretired(&self, action: &mut dyn FnMut()) -> bool {
        let _fence = lock(&self.host.output_fence);
        if !self.host.current(&self.host.connection) {
            return false;
        }
        action();
        true
    }
    fn withheld_error(&self) -> Option<WireError> {
        if !self.read || !self.host.connection.is_current() {
            return None;
        }
        // `retire` cancels `retired` before it retires the owner, so check both.
        if self.host.retired.is_cancelled() || !self.host.current(&self.host.connection) {
            return Some(WireError::new(
                ErrorCode::WorkspaceUnavailable,
                "held document answer retired",
            ));
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Some(WireError::new(
                ErrorCode::DeadlineExceeded,
                "held document answer deadline elapsed",
            ));
        }
        self.cancel
            .is_cancelled()
            .then(|| WireError::new(ErrorCode::Cancelled, "held document answer cancelled"))
    }
}

impl std::fmt::Debug for ApplicationOutputGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApplicationOutputGuard")
            .field("activation_id", &self.activation_id)
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
    fn with_current(&self, cancellable: bool, action: &mut dyn FnMut()) -> bool {
        let _fence = lock(&self.registration.host.output_fence);
        if !self.is_current_ignoring_cancel() || (cancellable && self.cancel.is_cancelled()) {
            return false;
        }
        action();
        true
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn is_current_ignoring_cancel(&self) -> bool {
        let host = &self.registration.host;
        host.current(&host.connection)
            && !self.registration.retired.is_cancelled()
            && !self
                .activation_id
                .as_deref()
                .is_some_and(|id| host.retired_activations.contains(id))
            && self
                .deadline
                .is_none_or(|deadline| Instant::now() < deadline)
    }
    fn release(&self) {
        lock(&self.reservation).take();
    }
}

fn map_application_read(error: dohc_engine_runtime::RuntimeError) -> WireError {
    match error {
        dohc_engine_runtime::RuntimeError::LiveApplication(
            dohc_engine_collab::live_update_application::ApplicationError::Interrupted,
        ) => workspace_unavailable(),
        other => map_runtime(other),
    }
}

/// A settlement or fence that is stopped after it lands has its answer
/// withheld, so only the caller's own deadline can end the caller's wait.
fn require_caller_deadline(request: &Request) -> Result<(), WireError> {
    if request.deadline_ms.is_none() {
        return Err(WireError::new(
            ErrorCode::InvalidParams,
            "live-deadline-required",
        ));
    }
    Ok(())
}

/// The outbox at the registration's exact binding. A succession leaves
/// retired outboxes at earlier paths of the same generation, so path and
/// selectors decide which one owner deliveries come from.
fn read_owner_outbox(
    conn: &rusqlite::Connection,
    binding: &LiveObjectBinding,
) -> Result<Option<(String, i64, String)>, dohc_engine_storage::StorageError> {
    use rusqlite::OptionalExtension;
    let selectors = serde_json::to_string(&binding.selector_paths)
        .map_err(dohc_engine_storage::StorageError::persist_public)?;
    conn.query_row(
        "SELECT outbox_id,pending_bytes,state FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND current_path=?5 AND selector_paths_json=?6 AND restore_fence_generation=?7",
        rusqlite::params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.current_path,selectors,binding.restore_fence_generation],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(dohc_engine_storage::StorageError::persist_public)
}

impl EngineService {
    /// A guard for a read `workspace`'s live host answers on `ctx`'s behalf.
    pub(super) fn live_host_read_guard(
        &self,
        ctx: &RequestContext,
        workspace: &WorkspaceHandle,
    ) -> Result<Arc<dyn OutputGuard>, WireError> {
        let host = lock(&self.live_applications)
            .hosts
            .get(workspace)
            .cloned()
            .ok_or_else(workspace_unavailable)?;
        let guard = HostOutputGuard {
            host,
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            read: true,
        };
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        Ok(Arc::new(guard))
    }

    pub(super) async fn live_application_ack(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            registration_id: u64,
            delivery_id: String,
            update_digest: String,
        }
        let params: Params = serde_json::from_value(request.params).map_err(|_| {
            WireError::new(ErrorCode::InvalidParams, "invalid application ACK request")
        })?;
        let identity = dohc_engine_collab::live_update_application::LiveApplicationAckIdentity {
            delivery_id: params.delivery_id,
            update_digest: params.update_digest,
        };
        identity.validate().map_err(|_| {
            WireError::new(ErrorCode::InvalidParams, "invalid application ACK identity")
        })?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let registration = self.live_application_registration(
            connection,
            request.workspace.as_ref(),
            params.registration_id,
        )?;
        let cancellation = super::request::OperationCancellation::new(&ctx);
        if ctx.cancel.is_cancelled() {
            return Err(cancellation.interruption("application ACK read"));
        }
        if ctx.deadline.is_some_and(|end| Instant::now() >= end) {
            return Err(WireError::new(
                ErrorCode::DeadlineExceeded,
                "application ACK read deadline elapsed",
            ));
        }
        let guard = Arc::new(ApplicationOutputGuard {
            activation_id: registration.activation_id(),
            registration: registration.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            reservation: Mutex::new(Some(Arc::new(()))),
        });
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        let ack = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => return Err(cancellation.interruption("application ACK read")),
            () = registration.retired.cancelled() => return Err(workspace_unavailable()),
            ack = registration.handle.read_ack(identity) => ack.map_err(map_application_read)?,
        };
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: match ack {
                    Some(ack) => json!({"status":"applied", "ack":ack}),
                    None => json!({"status":"missing"}),
                },
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }

    pub(super) async fn live_owner_state(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            registration_id: u64,
            session_id: String,
        }
        let params: Params = serde_json::from_value(params)
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid owner state request"))?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        self.owner_adoption_config(connection, workspace.as_ref())?;
        let registration = self.live_application_registration(
            connection,
            workspace.as_ref(),
            params.registration_id,
        )?;
        let serial = Arc::clone(&registration.host.open.session_ops)
            .lock_owned()
            .await;
        let (open, session) = self.ydoc_session(workspace.as_ref(), &params.session_id)?;
        let b = &registration.binding;
        if !Arc::ptr_eq(&open, &registration.host.open)
            || session.key.workspace_id != b.workspace_id
            || session.key.version_id != b.main_version_id
            || session.key.object_id != b.object_id
            || session.path != b.current_path
            || session.lineage_claim_id.as_deref() != Some(&b.lineage_claim_id)
            || session.first_update_pending
            || !registration.host.current(connection)
            || registration.retired.is_cancelled()
        {
            return Err(workspace_unavailable());
        }
        let read_registration = registration.clone();
        let state = tokio::task::spawn_blocking(move || {
            let _serial = serial;
            let registration = read_registration;
            let b = &registration.binding;
            let store = dohc_engine_storage::EngineStore::open_read_only(open.actor.database_path())
                .map_err(|_| workspace_unavailable())?;
            let state = store.read_with(|conn| -> Result<Value,dohc_engine_storage::StorageError> {
                use rusqlite::OptionalExtension;
                let prior: Option<(String,i64,i64)> = conn.query_row(&format!("SELECT activation_id,local_ydoc_sequence,terminal_cursor FROM {} WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5",
                    dohc_engine_collab::live_update_application::owner_activations::CURRENT_ACTIVATIONS),
                    rusqlite::params![registration.host.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(dohc_engine_storage::StorageError::persist_public)?;
                let (outbox_id,pending_bytes,outbox_state) = read_owner_outbox(conn,b)?.map_or((None,0,None),|(id,bytes,state)|(Some(id),bytes,Some(state)));
                if let Some((id,sequence,cursor)) = prior { return Ok(json!({"adoptionId":id,"expectedLocalSequence":sequence,"throughCursor":cursor,"outboxId":outbox_id,"pendingBytes":pending_bytes,"outboxState":outbox_state})); }
                let sequence: i64 = conn.query_row("SELECT head_update_seq FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",rusqlite::params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|r|r.get(0)).map_err(dohc_engine_storage::StorageError::persist_public)?;
                let identity = serde_json::to_vec(&(&registration.host.namespace,&b.workspace_id,&b.main_version_id,&b.object_id,&b.lineage_claim_id)).map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok(json!({"adoptionId":format!("owner-adoption-{}",dohc_engine_storage::hex_sha256(&identity)),"expectedLocalSequence":sequence,"throughCursor":Value::Null,"outboxId":outbox_id,"pendingBytes":pending_bytes,"outboxState":outbox_state}))
            }).map_err(|_|workspace_unavailable())?;
            Ok::<_, WireError>(state)
            }).await.map_err(|_| workspace_unavailable())??;
        if !registration.host.current(connection) || registration.retired.is_cancelled() {
            return Err(workspace_unavailable());
        }
        Ok(state)
    }

    /// Trusted owner transport entry. Evidence and budgets come from the
    /// authenticated journal reader, never from an ordinary renderer RPC.
    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub async fn adopt_live_application_owner(
        &self,
        ctx: RequestContext,
        request_id: u64,
        workspace: WorkspaceHandle,
        registration_id: u64,
        session_id: String,
        cut: dohc_engine_collab::live_update_application::OwnerAdoptionCut,
        max_bytes: usize,
        max_events: usize,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<ServiceResponse, WireError> {
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let registration =
            self.live_application_registration(connection, Some(&workspace), registration_id)?;
        let host = registration.host.clone();
        let cancellation = super::request::OperationCancellation::new(&ctx);
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => return Err(cancellation.interruption("owner adoption (queued)")),
            serial = Arc::clone(&host.open.session_ops).lock_owned() => serial,
        };
        let (open, session) = self.ydoc_session(Some(&workspace), &session_id)?;
        let b = &registration.binding;
        if !host.current(connection)
            || registration.retired.is_cancelled()
            || !Arc::ptr_eq(&open, &host.open)
            || session.key.workspace_id != b.workspace_id
            || session.key.version_id != b.main_version_id
            || session.key.object_id != b.object_id
            || session.path != b.current_path
            || session.lineage_claim_id.as_deref() != Some(&b.lineage_claim_id)
            || session.content_kind != dohc_engine_collab::ContentKind::Richdoc
            || session.first_update_pending
        {
            return Err(workspace_unavailable());
        }
        let mut guard = ApplicationOutputGuard {
            activation_id: registration.activation_id(),
            registration: registration.clone(),
            cancel: ctx.cancel,
            deadline: ctx.deadline,
            reservation: Mutex::new(Some(reservation.clone())),
        };
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        let mut retirement = RetireOnCancellation(Some(host));
        let operation = tokio::spawn(async move {
            let _serial = serial;
            registration
                .handle
                .adopt_owner(cut, max_bytes, max_events, Arc::new(NoFaults), reservation)
                .await
        });
        let outcome = operation.await;
        retirement.0 = None;
        let result = outcome
            .map_err(|_| WireError::new(ErrorCode::Internal, "owner-adoption-interrupted"))?
            .map_err(map_runtime)?;
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        // The answer belongs to the activation this adoption made.
        guard.activation_id = guard.registration.activation_id();
        Ok(ServiceResponse {
            response: Response {
                id: request_id,
                result: json!({"status":"adopted","adoption":result}),
            },
            blob_egress: None,
            output_guard: Some(Arc::new(guard)),
        })
    }
    pub(super) async fn live_application_settle(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        /// A registration's settlement, or a retirement's, never both.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            registration_id: Option<u64>,
            retirement: Option<dohc_engine_collab::live_update_application::RetirementKey>,
            terminal_receipt:
                Option<dohc_engine_collab::live_update_application::LiveUpdateReceipt>,
        }
        let invalid = || WireError::new(ErrorCode::InvalidParams, "invalid-live-settlement");
        if request.idempotency_key.is_some() || request.params.get("terminalReceipt").is_none() {
            return Err(invalid());
        }
        require_caller_deadline(&request)?;
        let params: Params =
            serde_json::from_value(request.params.clone()).map_err(|_| invalid())?;
        let registration_id = match (params.registration_id, params.retirement) {
            (Some(id), None) => id,
            (None, Some(key)) => {
                self.configured_host_caller(&ctx)?;
                return self
                    .live_application_settle_retirement(ctx, request, key, params.terminal_receipt)
                    .await;
            }
            _ => return Err(invalid()),
        };
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let registration = self.live_application_registration(
            connection,
            request.workspace.as_ref(),
            registration_id,
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
        let (max_applications, reconstruction) = self.configured_settlement_admission(&ctx)?;
        let now_ms = super::request::now_ms()?;
        let token = cancellation.token();
        let guard = Arc::new(ApplicationOutputGuard {
            activation_id: registration.activation_id(),
            registration: registration.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            reservation: Mutex::new(Some(reconstruction.reservation.clone())),
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
                    reconstruction,
                )
                .await
        });
        let outcome = operation.await;
        retirement.0 = None;
        // A settlement that ran answers as settled; the writer withholds the
        // answer when its guard is no longer current.
        let result = outcome
            .map_err(|_| WireError::new(ErrorCode::Internal, "live-application-interrupted"))?
            .map_err(|error| match error {
                dohc_engine_runtime::RuntimeError::Cancelled => {
                    cancellation.interruption("live settlement")
                }
                error => map_runtime(error),
            })?;
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!({"status":"settled", "settlement":result}),
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }

    pub(super) async fn live_application_fence_restore(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Params {
            operation: NativeRestoreFence,
        }
        if request.idempotency_key.is_some()
            || request
                .params
                .get("operation")
                .and_then(|value| value.get("terminal"))
                .is_none()
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-native-restore-fence",
            ));
        }
        require_caller_deadline(&request)?;
        let params: Params = serde_json::from_value(request.params).map_err(|_| {
            WireError::new(ErrorCode::InvalidParams, "invalid-native-restore-fence")
        })?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let workspace = request
            .workspace
            .as_ref()
            .ok_or_else(workspace_unavailable)?;
        let host = lock(&self.live_applications)
            .hosts
            .get(workspace)
            .cloned()
            .ok_or_else(workspace_unavailable)?;
        if !host.current(connection)
            || params.operation.relay_database_namespace != host.namespace
            || params.operation.host_id != host.coordinate.host_id
            || params.operation.old_binding.workspace_id != host.open.workspace_id
        {
            return Err(workspace_unavailable());
        }
        let cancellation = super::request::OperationCancellation::new(&ctx);
        let check_interruption = || {
            if ctx.cancel.is_cancelled() {
                Err(WireError::new(
                    ErrorCode::Cancelled,
                    "native restore fence cancelled",
                ))
            } else if ctx.deadline.is_some_and(|end| Instant::now() >= end) {
                Err(WireError::new(
                    ErrorCode::DeadlineExceeded,
                    "native restore fence deadline elapsed",
                ))
            } else {
                Ok(())
            }
        };
        check_interruption()?;
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("native restore fence (queued)"));
            }
            serial = Arc::clone(&host.open.session_ops).lock_owned() => serial,
        };
        check_interruption()?;
        if !host.current(connection) || !Arc::ptr_eq(&self.open(Some(workspace))?, &host.open) {
            return Err(workspace_unavailable());
        }
        let now_ms = super::request::now_ms()?;
        let object_id = params.operation.old_binding.object_id.clone();
        let old_binding = params.operation.old_binding.clone();
        let retired_binding = old_binding.clone();
        let sessions = Arc::clone(&self.sessions);
        let guard = Arc::new(HostOutputGuard {
            host: host.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            read: false,
        });
        let mut retirement = RetireOnCancellation(Some(host.clone()));
        let worker_host = host.clone();
        let operation = tokio::spawn(async move {
            let _serial = serial;
            let receipt = worker_host
                .owner
                .fence_restore_after_reconnect(
                    params.operation,
                    worker_host.coordinate.clone(),
                    now_ms,
                    Arc::new(NoFaults),
                )
                .await?;
            // Retire sessions before releasing session_ops, including when the caller
            // has stopped awaiting the committed fence. Historical retries spare new generations.
            lock(&sessions).retain(|_, session| {
                session.key.workspace_id != retired_binding.workspace_id
                    || session.key.version_id != retired_binding.main_version_id
                    || session.key.object_id != retired_binding.object_id
                    || session.restore_generation.is_some_and(|generation| {
                        generation > retired_binding.restore_fence_generation
                    })
            });
            for registration in lock(&worker_host.output_fence)
                .iter()
                .filter_map(Weak::upgrade)
            {
                if registration.binding.main_version_id == retired_binding.main_version_id
                    && registration.object_id == retired_binding.object_id
                    && registration.binding.restore_fence_generation
                        <= retired_binding.restore_fence_generation
                {
                    registration.retired.cancel();
                }
            }
            Ok::<_, dohc_engine_runtime::RuntimeError>(receipt)
        });
        let outcome = operation.await;
        retirement.0 = None;
        let receipt = match outcome
            .map_err(|_| WireError::new(ErrorCode::Internal, "live-application-interrupted"))?
        {
            Ok(receipt) => receipt,
            // Nothing committed. The host publishes ordinary work and asks again.
            Err(dohc_engine_runtime::RuntimeError::LiveApplication(
                dohc_engine_collab::live_update_application::ApplicationError::PublicationPending,
            )) => {
                return Ok(ServiceResponse {
                    response: Response {
                        id: request.id,
                        result: json!({"status":"pending", "reason":"publication-pending"}),
                    },
                    blob_egress: None,
                    output_guard: Some(guard),
                });
            }
            Err(error) => return Err(map_runtime(error)),
        };
        {
            let mut registry = lock(&self.live_applications);
            let _fence = lock(&host.output_fence);
            registry.registrations.retain(|_, registration| {
                if Arc::ptr_eq(&registration.host, &host)
                    && registration.object_id == object_id
                    && registration.binding.main_version_id == old_binding.main_version_id
                    && registration.binding.restore_fence_generation
                        <= old_binding.restore_fence_generation
                {
                    registration.retired.cancel();
                    false
                } else {
                    true
                }
            });
        }
        // The fence committed: answer it, and let the writer withhold the
        // answer when its guard is no longer current.
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!({"status":"fenced", "receipt":receipt}),
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }

    /// `liveApplication.cancelRestoreFence`: end a restore the relay fenced
    /// before its admission. The params name the operation's fence:
    /// `{operationId, objectId, lineageClaimId, hostId, newFence}`. `hostId`
    /// is the host that fenced it and must be this one. The current host
    /// fixes the namespace and workspace; no param names them. The answer is
    /// durable before it is sent, and names the generation and binding the
    /// relay's retirement key takes:
    /// - `{"status":"cancelled","hostId":...,"generation":newFence-1,"binding":...}`:
    ///   no fence of the operation committed, and none ever will, even one
    ///   in flight or replayed. `generation` is the base of the cancelled
    ///   operation. `binding` is the document's binding at that generation;
    ///   null means the document holds none there now, released or moved on
    ///   by a later restore, and the relay must not record it.
    /// - `{"status":"fenceCancelled","hostId":...,"generation":newFence,"binding":...,"receipt":...}`:
    ///   the fence committed and this cancellation ended it before any
    ///   application. The document stays at `newFence`, live application
    ///   unavailable, under `binding`, the fence's stopped binding; its
    ///   content and accepted endpoint are as the fence left them.
    ///   `receipt` is the terminal cancellation the relay journal carries to
    ///   passive replicas. Prepare, apply and fence of the operation refuse
    ///   from then on.
    ///
    /// A replay answers the same. Another key for the operation, another
    /// host, a key the document's generation has passed or does not hold, or
    /// a restore already admitted answers `CONFLICT`.
    pub(super) async fn live_application_cancel_restore_fence(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        use dohc_engine_collab::live_update_application::{
            RestoreFenceCancellation, RestoreFenceCancellationOutcome,
        };
        let input: RestoreFenceCancellation = serde_json::from_value(params).map_err(|_| {
            WireError::new(
                ErrorCode::InvalidParams,
                "invalid-restore-fence-cancellation",
            )
        })?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let workspace = workspace.ok_or_else(workspace_unavailable)?;
        let host = lock(&self.live_applications)
            .hosts
            .get(&workspace)
            .cloned()
            .ok_or_else(workspace_unavailable)?;
        if !host.current(connection) || !Arc::ptr_eq(&self.open(Some(&workspace))?, &host.open) {
            return Err(workspace_unavailable());
        }
        let now_ms = super::request::now_ms()?;
        let host_id = input.host_id.clone();
        let outcome = host
            .owner
            .cancel_restore_fence(
                host.namespace.clone(),
                host.coordinate.host_id.clone(),
                input,
                now_ms,
            )
            .await
            .map_err(map_runtime)?;
        Ok(match outcome {
            RestoreFenceCancellationOutcome::Cancelled {
                generation,
                binding,
            } => {
                json!({"status":"cancelled","hostId":host_id,"generation":generation,"binding":binding})
            }
            RestoreFenceCancellationOutcome::FenceCancelled(receipt) => {
                json!({"status":"fenceCancelled","hostId":host_id,
                    "generation":receipt.binding.restore_fence_generation,
                    "binding":receipt.binding,"receipt":receipt})
            }
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
        self.ensure_handle_allows_method(
            Some(&config.workspace),
            "liveApplication.provisionOwner",
        )?;
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
            retired: CancelSignal::new(),
            open,
            connection: connection.clone(),
            retired_activations: owner.retired_activations(),
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
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            binding: LiveObjectBinding,
            /// Only the configured session host names the activation it serves.
            activation_id: Option<String>,
        }
        let params: Params = serde_json::from_value(params)
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-live-registration"))?;
        if params.activation_id.is_some() {
            self.configured_host_caller(ctx)?;
        }
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let workspace = workspace.ok_or_else(workspace_unavailable)?;
        let host = lock(&self.live_applications)
            .hosts
            .get(&workspace)
            .cloned()
            .ok_or_else(workspace_unavailable)?;
        let cancellation = super::request::OperationCancellation::new(ctx);
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("live registration (queued)"));
            }
            serial = Arc::clone(&host.open.session_ops).lock_owned() => serial,
        };
        if !host.current(connection) || !Arc::ptr_eq(&self.open(Some(&workspace))?, &host.open) {
            return Err(workspace_unavailable());
        }
        host.owner
            .validate_binding(
                host.namespace.clone(),
                params.binding.clone(),
                params.activation_id.clone(),
            )
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
        let binding = params.binding.clone();
        let handle = match params.activation_id {
            Some(activation_id) => {
                host.owner
                    .register_activation(
                        host.namespace.clone(),
                        host.coordinate.clone(),
                        params.binding,
                        activation_id,
                    )
                    .await
            }
            None => {
                host.owner
                    .register(
                        host.namespace.clone(),
                        host.coordinate.clone(),
                        params.binding,
                    )
                    .await
            }
        }
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
            binding,
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

    /// Release one document's registrations, sessions, leases, and cache.
    /// Durable CRDT, adoption, and history stay, so the next capture reloads it.
    /// The unload names the activation it ends: state serving another one,
    /// or any while it names none, refuses it before anything is released.
    pub(super) async fn live_application_unload(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            object_id: String,
            activation_id: Option<String>,
        }
        self.configured_host_caller(ctx)?;
        let params: Params = serde_json::from_value(params)
            .ok()
            .filter(|params: &Params| {
                params
                    .activation_id
                    .as_ref()
                    .is_none_or(|id| (1..=1024).contains(&id.len()))
            })
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "invalid-live-unload"))?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let workspace = workspace.ok_or_else(workspace_unavailable)?;
        let host = lock(&self.live_applications)
            .hosts
            .get(&workspace)
            .cloned()
            .ok_or_else(workspace_unavailable)?;
        let cancellation = super::request::OperationCancellation::new(ctx);
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("live document unload (queued)"));
            }
            serial = Arc::clone(&host.open.session_ops).lock_owned() => serial,
        };
        if !host.current(connection) || !Arc::ptr_eq(&self.open(Some(&workspace))?, &host.open) {
            return Err(workspace_unavailable());
        }
        let object_id = params.object_id;
        let activation_id = params.activation_id;
        // Untagged state is ordinary and goes with any unload of its document.
        let ends = |tag: Option<&str>| tag.is_none_or(|tag| Some(tag) == activation_id.as_deref());
        let mut keys = Vec::new();
        for session in lock(&self.sessions).values() {
            if session.workspace == workspace && session.key.object_id == object_id {
                if !ends(session.activation_id.as_deref()) {
                    return Err(map_runtime(ApplicationError::Conflict.into()));
                }
                keys.push(session.key.clone());
            }
        }
        for registration in lock(&self.live_applications).registrations.values() {
            if Arc::ptr_eq(&registration.host, &host) && registration.object_id == object_id {
                if !ends(registration.activation_id().as_deref()) {
                    return Err(map_runtime(ApplicationError::Conflict.into()));
                }
                let b = &registration.binding;
                keys.push(
                    DocKey::new(&b.workspace_id, &b.main_version_id, &b.object_id).map_err(
                        |error| map_runtime(dohc_engine_runtime::RuntimeError::Collab(error)),
                    )?,
                );
            }
        }
        if keys.is_empty() {
            return Err(workspace_unavailable());
        }
        let root = host.open.root.clone();
        let now_ms = super::request::now_ms()?;
        // A dropped caller cannot strand a released registration with its
        // session still leased: the task finishes every step it starts, and
        // the request answers with what it did.
        let registry = Arc::clone(&self.live_applications);
        let sessions = Arc::clone(&self.sessions);
        let task_host = host.clone();
        let operation = tokio::spawn(async move {
            let _serial = serial;
            let ends =
                |tag: Option<&str>| tag.is_none_or(|tag| Some(tag) == activation_id.as_deref());
            let pending = task_host
                .owner
                .unload(object_id.clone(), activation_id.clone(), keys, root, now_ms)
                .await?;
            if pending.is_none() {
                {
                    let mut registry = lock(&registry);
                    let _fence = lock(&task_host.output_fence);
                    registry.registrations.retain(|_, registration| {
                        if Arc::ptr_eq(&registration.host, &task_host)
                            && registration.object_id == object_id
                            && ends(registration.activation_id().as_deref())
                        {
                            registration.retired.cancel();
                            false
                        } else {
                            true
                        }
                    });
                }
                lock(&sessions).retain(|_, session| {
                    session.workspace != workspace
                        || session.key.object_id != object_id
                        || !ends(session.activation_id.as_deref())
                });
            }
            Ok::<_, dohc_engine_runtime::RuntimeError>(pending)
        });
        let pending = operation
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "live-unload-interrupted"))?
            .map_err(map_runtime)?;
        Ok(match pending {
            None => json!({"status": "unloaded"}),
            Some(reason) => json!({"status": "pending", "reason": match reason {
                UnloadPending::Restore => "restore-pending",
                UnloadPending::Delivery => "delivery-pending",
                UnloadPending::Settlement => "settlement-pending",
                UnloadPending::Materialization => "materialization-pending",
            }}),
        })
    }

    /// `liveApplication.reconcileActivation`: prove what one activation the
    /// relay fenced delivered and applied, so Stop can retire it exactly.
    /// Its key validates first; an invalid one, and a released activation's
    /// replay, tear nothing down. Otherwise Phase A ends the activation here
    /// before the durable pass: its registrations, sessions, leases and cache
    /// go, and nothing registers or answers for it again. Its binding and
    /// retained input stay. One task runs both, so a caller that stops
    /// waiting cannot leave Phase A half done, and a retry answers the same.
    pub(super) async fn live_application_reconcile(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        use dohc_engine_collab::live_update_application::{
            JournalEvidence, LiveUpdateReceipt, Reconciliation, RetirementKey,
        };
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            object_id: String,
            lineage_claim_id: String,
            activation_id: String,
            restore_fence_generation: i64,
            accepted_through: i64,
            after_receipt: Option<LiveUpdateReceipt>,
            max_applications: usize,
            journal: Option<JournalEvidence>,
        }
        self.configured_host_caller(ctx)?;
        let invalid = || WireError::new(ErrorCode::InvalidParams, "invalid-live-reconciliation");
        if params.get("afterReceipt").is_none() {
            return Err(invalid());
        }
        let params: Params = serde_json::from_value(params).map_err(|_| invalid())?;
        let scope = self.configured_retirement_scope(ctx, params.max_applications)?;
        let key = RetirementKey {
            object_id: params.object_id,
            lineage_claim_id: params.lineage_claim_id,
            activation_id: params.activation_id,
            restore_fence_generation: params.restore_fence_generation,
            accepted_through: params.accepted_through,
        };
        let reconciliation = self
            .run_retirement(
                ctx,
                workspace,
                scope,
                key,
                false,
                "live reconciliation",
                move |host, scope, key| async move {
                    host.owner
                        .reconcile_activation(scope, key, params.after_receipt, params.journal)
                        .await
                },
            )
            .await?
            .map_err(map_runtime)?;
        Ok(match reconciliation {
            Reconciliation::PendingDelivery(deliveries) => {
                json!({"status":"pending","reason":"delivery","deliveries":deliveries})
            }
            Reconciliation::SeedQuarantined(deliveries) => {
                json!({"status":"pending","reason":"seed-quarantined","deliveries":deliveries})
            }
            Reconciliation::Reconciled {
                adoption,
                applications,
                has_more_applications,
                settle,
            } => json!({"status":"reconciled","adoption":adoption,"applications":applications,
                "hasMoreApplications":has_more_applications,"settle":settle}),
        })
    }

    /// `liveApplication.releaseActivation`: release the activation the relay
    /// fenced once its document parked, proving its delivery, application
    /// and settlement again in the release's own transaction. A never-adopted
    /// source may release before parking. A released activation answers
    /// from its stored release.
    pub(super) async fn live_application_release(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        use dohc_engine_collab::live_update_application::{Release, ReleasePending, RetirementKey};
        self.configured_host_caller(ctx)?;
        let key: RetirementKey = serde_json::from_value(params)
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-live-release"))?;
        let scope = self.configured_retirement_scope(ctx, 1)?;
        let now_ms = super::request::now_ms()?;
        let release = self
            .run_retirement(
                ctx,
                workspace,
                scope,
                key,
                true,
                "live release",
                move |host, scope, key| async move {
                    host.owner
                        .release_activation(scope, host.coordinate.clone(), key, now_ms)
                        .await
                },
            )
            .await?
            .map_err(map_runtime)?;
        Ok(match release {
            Release::Released { replayed, boundary } => {
                json!({"status":"released","replayed":replayed,"boundary":boundary})
            }
            Release::Pending(reason) => json!({"status":"pending","reason":match reason {
                ReleasePending::Parking => "parking",
                ReleasePending::Reconciliation => "reconciliation",
            }}),
        })
    }

    /// The retirement form of `liveApplication.settle`: settle the activation
    /// a retirement names through its durable binding. It needs no live
    /// registration and opens no session.
    async fn live_application_settle_retirement(
        &self,
        ctx: RequestContext,
        request: Request,
        key: dohc_engine_collab::live_update_application::RetirementKey,
        terminal: Option<dohc_engine_collab::live_update_application::LiveUpdateReceipt>,
    ) -> Result<ServiceResponse, WireError> {
        let (max_applications, reconstruction) = self.configured_settlement_admission(&ctx)?;
        let scope = self.configured_retirement_scope(&ctx, max_applications)?;
        let now_ms = super::request::now_ms()?;
        let cancellation = super::request::OperationCancellation::new(&ctx);
        let token = cancellation.token();
        let settled = self
            .run_retirement(
                &ctx,
                request.workspace.clone(),
                scope,
                key,
                false,
                "live settlement",
                move |host, scope, key| async move {
                    host.owner
                        .settle_retirement(
                            scope,
                            host.coordinate.clone(),
                            key,
                            terminal,
                            max_applications,
                            host.open.root.clone(),
                            now_ms,
                            Arc::new(NoFaults),
                            token,
                            reconstruction,
                        )
                        .await
                },
            )
            .await?
            .map_err(|error| match error {
                dohc_engine_runtime::RuntimeError::Cancelled => {
                    cancellation.interruption("live settlement")
                }
                error => map_runtime(error),
            })?;
        Ok(ServiceResponse::response(Response {
            id: request.id,
            result: json!({"status":"settled", "settlement":settled}),
        }))
    }

    /// One retirement step for the configured host. Its key validates, then,
    /// unless its activation is released, Phase A ends only this document's
    /// state tagged with that activation on this host: its registrations and
    /// their output, its sessions and leases, and its cache entry. Then
    /// `step` runs the durable pass. One task holding `session_ops` runs all
    /// of it, so a caller that stops waiting cannot leave Phase A half done,
    /// and a retry answers the same. An invalid key tears nothing down, nor
    /// does a `release` whose document is still in the scope.
    #[allow(clippy::too_many_arguments)]
    async fn run_retirement<T, F>(
        &self,
        ctx: &RequestContext,
        workspace: Option<WorkspaceHandle>,
        scope: dohc_engine_runtime::actor::OwnedRetirementScope,
        key: dohc_engine_collab::live_update_application::RetirementKey,
        release: bool,
        label: &'static str,
        step: impl FnOnce(
            Arc<Host>,
            dohc_engine_runtime::actor::OwnedRetirementScope,
            dohc_engine_collab::live_update_application::RetirementKey,
        ) -> F
        + Send
        + 'static,
    ) -> Result<Result<T, dohc_engine_runtime::RuntimeError>, WireError>
    where
        T: Send + 'static,
        F: std::future::Future<Output = Result<T, dohc_engine_runtime::RuntimeError>>
            + Send
            + 'static,
    {
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let workspace = workspace.ok_or_else(workspace_unavailable)?;
        let host = lock(&self.live_applications)
            .hosts
            .get(&workspace)
            .cloned()
            .ok_or_else(workspace_unavailable)?;
        let cancellation = super::request::OperationCancellation::new(ctx);
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption(&format!("{label} (queued)")));
            }
            serial = Arc::clone(&host.open.session_ops).lock_owned() => serial,
        };
        if !host.current(connection) || !Arc::ptr_eq(&self.open(Some(&workspace))?, &host.open) {
            return Err(workspace_unavailable());
        }
        let registry = Arc::clone(&self.live_applications);
        let sessions = Arc::clone(&self.sessions);
        let operation = tokio::spawn(async move {
            let _serial = serial;
            let target = host
                .owner
                .begin_retirement(scope.clone(), host.coordinate.clone(), key.clone(), release)
                .await?;
            if !target.released {
                let serves = |tag: Option<&str>| tag == Some(key.activation_id.as_str());
                {
                    let mut registry = lock(&registry);
                    let _fence = lock(&host.output_fence);
                    registry.registrations.retain(|_, registration| {
                        if Arc::ptr_eq(&registration.host, &host)
                            && registration.object_id == key.object_id
                            && serves(registration.activation_id().as_deref())
                        {
                            registration.retired.cancel();
                            false
                        } else {
                            true
                        }
                    });
                }
                lock(&sessions).retain(|_, session| {
                    session.workspace != workspace
                        || session.key.object_id != key.object_id
                        || !serves(session.activation_id.as_deref())
                });
            }
            step(host, scope, key).await
        });
        operation
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "live-retirement-interrupted"))
    }

    /// Run a hosted pull or commit, then drop the registrations and editor
    /// sessions of each document it left unready, whose native registrations
    /// the writer released in the same step. Durable work stays. One task
    /// runs both, so a caller that stops waiting cannot keep them open. The
    /// close waits on `session_ops`, so a registration in flight is dropped
    /// here or refused natively. Only the relay observes cancellation, before
    /// a step runs or while it waits on the network, so a step that landed is
    /// answered after its close and never reported as failed.
    pub(super) async fn hosted_execute(
        &self,
        ctx: &RequestContext,
        open: &Arc<OpenWorkspace>,
        configuration: dohc_engine_runtime::RelayConfiguration,
        operation: dohc_engine_runtime::RelayOperation,
        label: &str,
    ) -> Result<dohc_engine_runtime::RelayOperationOutcome, WireError> {
        use dohc_engine_runtime::RelayOperationOutcome as Outcome;
        let cancellation = super::request::OperationCancellation::new(ctx);
        let handles: Vec<WorkspaceHandle> = lock(&self.handles)
            .iter()
            .filter(|(_, candidate)| Arc::ptr_eq(candidate, open))
            .map(|(handle, _)| handle.clone())
            .collect();
        let registry = Arc::clone(&self.live_applications);
        let sessions = Arc::clone(&self.sessions);
        let leases = self.leases.scoped(&open.root);
        let token = cancellation.token();
        let open = Arc::clone(open);
        let task = tokio::spawn(async move {
            let outcome = open
                .actor
                .relay(configuration, operation, leases, token, None)
                .await?;
            let unready: &[String] = match &outcome {
                Outcome::HostedPass { unready, .. }
                | Outcome::HostedCursorCommitted {
                    unready: Ok(unready),
                    ..
                } => unready,
                _ => &[],
            };
            if !unready.is_empty() {
                let _serial = Arc::clone(&open.session_ops).lock_owned().await;
                lock(&registry).registrations.retain(|_, registration| {
                    if Arc::ptr_eq(&registration.host.open, &open)
                        && unready.contains(&registration.object_id)
                    {
                        let _fence = lock(&registration.host.output_fence);
                        registration.retired.cancel();
                        false
                    } else {
                        true
                    }
                });
                lock(&sessions).retain(|_, session| {
                    !handles.contains(&session.workspace)
                        || !unready.contains(&session.key.object_id)
                });
            }
            Ok::<_, dohc_engine_runtime::RuntimeError>(outcome)
        });
        task.await
            .map_err(|_| WireError::new(ErrorCode::Internal, "hosted-sync-interrupted"))?
            .map_err(|error| match error {
                dohc_engine_runtime::RuntimeError::Cancelled => cancellation.interruption(label),
                error => map_runtime(error),
            })
    }

    /// Hold the workspace's session lock, as an editor or registration step
    /// in flight holds it.
    #[cfg(feature = "harness")]
    #[doc(hidden)]
    pub async fn session_ops_for_harness(
        &self,
        handle: &WorkspaceHandle,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, WireError> {
        Ok(Arc::clone(&self.open(Some(handle))?.session_ops)
            .lock_owned()
            .await)
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
        input: AdmittedApplicationInput,
    ) -> Result<ServiceResponse, WireError> {
        if let LiveApplicationOperation::AdoptOwner {
            registration_id,
            session_id,
            cut,
            max_bytes,
            max_events,
        } = input.operation
        {
            if request.method != "liveApplication.adoptOwner" {
                return Err(workspace_unavailable());
            }
            let workspace = request.workspace.ok_or_else(workspace_unavailable)?;
            return self
                .adopt_live_application_owner(
                    ctx,
                    request.id,
                    workspace,
                    registration_id,
                    session_id,
                    cut,
                    max_bytes,
                    max_events,
                    input.reservation,
                )
                .await;
        }
        if let LiveApplicationOperation::SyncOpen(vector, policy) = input.operation {
            if request.method != "liveApplication.syncOpen" {
                return Err(workspace_unavailable());
            }
            return self
                .live_application_sync(
                    ctx,
                    request,
                    input.registration,
                    Some(vector),
                    None,
                    policy,
                    input.reservation,
                )
                .await;
        }
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let method = match &input.operation {
            LiveApplicationOperation::Apply(_) => "liveApplication.apply",
            LiveApplicationOperation::Bootstrap(..) => "liveApplication.bootstrap",
            LiveApplicationOperation::SyncOpen(..) => unreachable!("sync dispatched above"),
            LiveApplicationOperation::AdoptOwner { .. } => {
                unreachable!("adoption dispatched above")
            }
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
        let cancellation = super::request::OperationCancellation::new(&ctx);
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("live application (queued)"));
            }
            serial = Arc::clone(&host.open.session_ops).lock_owned() => serial,
        };
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
            activation_id: input.registration.activation_id(),
            registration: input.registration.clone(),
            cancel: ctx.cancel,
            deadline: ctx.deadline,
            reservation: Mutex::new(Some(input.reservation.clone())),
        });
        // Keep the workspace fence until the writer is terminal if the RPC is cancelled.
        let mut retirement = RetireOnCancellation(Some(host.clone()));
        let claim_events = self.events.clone();
        let claim_workspace = host.open.workspace_id.clone();
        let operation = tokio::spawn(async move {
            let _serial = serial;
            match input.operation {
                LiveApplicationOperation::SyncOpen(..) => unreachable!("sync dispatched above"),
                LiveApplicationOperation::AdoptOwner { .. } => {
                    unreachable!("adoption dispatched above")
                }
                LiveApplicationOperation::Apply(event) => input
                    .registration
                    .handle
                    .apply_with_reservation(
                        event,
                        Arc::new(NoFaults),
                        Some(input.reservation),
                        input.working_reserve_bytes,
                    )
                    .await
                    .map(|result| match result {
                        ApplicationResult::Applied(ack, claims) => {
                            crate::events::emit_automation_claimed(
                                &claim_events,
                                &claim_workspace,
                                &claims,
                            );
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
        // The writer withholds a stale acknowledgement; withheld means unknown.
        let outcome = outcome
            .map_err(|_| WireError::new(ErrorCode::Internal, "live-application-interrupted"))?
            .map_err(map_runtime)?;
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
        ApplicationPending::SettlementRequired => "settlement-required",
        ApplicationPending::DeliveryPending => "delivery-pending",
        ApplicationPending::SeedQuarantined => "seed-quarantined",
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

    fn fence_request(
        workspace: &WorkspaceHandle,
        binding: &LiveObjectBinding,
        namespace: &str,
    ) -> Request {
        Request {
            id: 81,
            method: "liveApplication.fenceRestore".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: Some(60_000),
            idempotency_key: None,
            progress: false,
            params: json!({"operation":{"operationId":"restore-rpc","relayDatabaseNamespace":namespace,"oldBinding":binding,"hostId":"host","newFence":binding.restore_fence_generation+1,"origin":{"kind":"bootstrap","id":"bootstrap"},"terminal":null,"appliedSequence":0}}),
        }
    }

    /// Owner deliveries come from the outbox at the registration's exact
    /// binding: not one at an earlier restore generation, nor one a
    /// succession retired at an earlier path, nor one at its path with other
    /// selectors, whichever sorts first.
    #[tokio::test]
    async fn owner_state_reads_only_the_registered_binding() {
        use dohc_engine_storage::{EngineStore, StorageError};
        let (_scratch, service, _owner, workspace, _registration, mut binding) = fixture().await;
        let open = service.open(Some(&WorkspaceHandle(workspace))).unwrap();
        let mut store = EngineStore::open(open.actor.database_path(), 0).unwrap();
        let selectors = serde_json::to_string(&binding.selector_paths).unwrap();
        let wider = serde_json::to_string(&[binding.current_path.as_str(), "zz-other.md"]).unwrap();
        store.write_with(&NoFaults, |tx| {
            for (id, path, selectors, generation, state, reason, bytes) in [
                ("old", binding.current_path.as_str(), selectors.as_str(), 0, "quarantined", Some("restore-fenced"), 64),
                ("a-retired", "a-earlier.md", "[\"a-earlier.md\"]", 1, "quarantined", Some("succession-retired"), 3),
                ("b-selectors", binding.current_path.as_str(), wider.as_str(), 1, "active", None, 7),
                ("current", binding.current_path.as_str(), selectors.as_str(), 1, "active", None, 61),
            ] {
                tx.execute(
                    "INSERT INTO owner_ydoc_outboxes(outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,quarantine_reason,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?5,?5,2,?9,?10,0,2,?11,0)",
                    rusqlite::params![id,binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,path,selectors,generation,state,bytes,reason],
                ).unwrap();
            }
            Ok::<_, StorageError>(())
        }).unwrap();
        store
            .read_with(|conn| {
                assert_eq!(
                    read_owner_outbox(conn, &binding)?,
                    Some(("old".into(), 64, "quarantined".into()))
                );
                binding.restore_fence_generation = 1;
                assert_eq!(
                    read_owner_outbox(conn, &binding)?,
                    Some(("current".into(), 61, "active".into()))
                );
                let mut earlier = binding.clone();
                earlier.current_path = "a-earlier.md".into();
                earlier.selector_paths = vec!["a-earlier.md".into()];
                assert_eq!(
                    read_owner_outbox(conn, &earlier)?,
                    Some(("a-retired".into(), 3, "quarantined".into()))
                );
                binding.restore_fence_generation = 2;
                assert_eq!(read_owner_outbox(conn, &binding)?, None);
                let old: (String, i64) = conn
                    .query_row(
                        "SELECT state,pending_bytes FROM owner_ydoc_outboxes WHERE outbox_id='old'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .unwrap();
                assert_eq!(old, ("quarantined".into(), 64));
                Ok::<_, StorageError>(())
            })
            .unwrap();
    }

    #[tokio::test]
    async fn ack_read_rpc_requires_owned_registration_and_fences_pending_output() {
        let (_scratch, service, owner, workspace, registration, binding) = fixture().await;
        let bytes = Ydoc::wire().plaintext_insert(0, "applied");
        let mut ingress = LiveApplicationIngress::new(service.clone(), config()).unwrap();
        ingress
            .begin(
                request(&workspace, registration, &binding, &bytes, &[]),
                &owner.handle(),
            )
            .unwrap();
        for (stream_id, content) in [(1, bytes.as_slice()), (2, &[][..])] {
            ingress
                .start(BlobStart {
                    request_id: 3,
                    stream_id,
                    total_bytes: Some(content.len() as u64),
                    sha256: Some(hex_sha256(content)),
                })
                .unwrap();
        }
        ingress.chunk(1, true, &bytes).unwrap();
        let crate::live_application_ingress::UploadCompletion::Admitted(apply_request, input) =
            ingress.chunk(2, true, &[]).unwrap().unwrap()
        else {
            panic!("unexpected refusal")
        };
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let applied = service
            .call_with_input(ctx, apply_request, Some(input))
            .await
            .unwrap();
        let workspace = WorkspaceHandle(workspace);
        let request = || Request {
            id: 92,
            method: "liveApplication.ack".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({"registrationId":registration,"deliveryId":"missing","updateDigest":"00".repeat(32)}),
        };
        assert!(
            service
                .call(RequestContext::unbounded(), request())
                .await
                .is_err()
        );
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let result = service.call(ctx, request()).await.unwrap();
        assert_eq!(result.response.result, json!({"status":"missing"}));
        assert!(result.output_guard.as_ref().unwrap().is_current());
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let mut exact = request();
        exact.params["deliveryId"] = json!("delivery");
        exact.params["updateDigest"] = json!(hex_sha256(&bytes));
        let found = service.call(ctx, exact).await.unwrap();
        let mut expected = applied.response.result["ack"].clone();
        expected["applicationReplayed"] = json!(true);
        assert_eq!(
            found.response.result,
            json!({"status":"applied","ack":expected})
        );
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let mut malformed = request();
        malformed.params["extra"] = json!(true);
        assert!(service.call(ctx, malformed).await.is_err());
        lock(&service.live_applications)
            .hosts
            .get(&workspace)
            .unwrap()
            .retire();
        assert!(!result.output_guard.as_ref().unwrap().is_current());
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        assert!(service.call(ctx, request()).await.is_err());
    }

    #[tokio::test]
    async fn ack_read_cancelled_while_waiting_preserves_the_registration() {
        let (_scratch, service, owner, workspace, registration, _) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        let open = service.open(Some(&workspace)).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let actor = open.actor.clone();
        let blocker = tokio::spawn(async move {
            actor
                .ensure_main_version(
                    "ack-blocker".into(),
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
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let cancel = ctx.cancel.clone();
        let mut operation = Box::pin(service.call(ctx, Request { id: 93, method: "liveApplication.ack".into(), workspace: Some(workspace.clone()),
            deadline_ms: None, idempotency_key: None, progress: false, params: json!({"registrationId":registration,"deliveryId":"missing","updateDigest":"00".repeat(32)}) }));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(operation.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        cancel.cancel();
        let error = tokio::time::timeout(std::time::Duration::from_secs(1), operation)
            .await
            .unwrap()
            .unwrap_err();
        release_tx.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), registration)
                .is_ok()
        );
    }

    #[tokio::test]
    async fn ack_read_expired_deadline_is_not_reported_as_cancellation() {
        let (_scratch, service, owner, workspace, registration, _) = fixture().await;
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        ctx.deadline = Some(Instant::now() - std::time::Duration::from_secs(1));
        let result = service.call(ctx, Request { id: 94, method: "liveApplication.ack".into(), workspace: Some(WorkspaceHandle(workspace)),
            deadline_ms: None, idempotency_key: None, progress: false, params: json!({"registrationId":registration,"deliveryId":"missing","updateDigest":"00".repeat(32)}) }).await;
        assert_eq!(result.unwrap_err().code, ErrorCode::DeadlineExceeded);
    }

    #[tokio::test]
    async fn ack_read_completes_while_session_operations_are_held() {
        let (_scratch, service, owner, workspace, registration, _) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        let open = service.open(Some(&workspace)).unwrap();
        let serial = open.session_ops.lock().await;
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let request = Request {
            id: 95,
            method: "liveApplication.ack".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({"registrationId":registration,"deliveryId":"missing","updateDigest":"00".repeat(32)}),
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            service.call(ctx, request),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.response.result["status"], "missing");
        drop(serial);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[test]
    fn ack_read_maps_interrupted_standing_to_unavailable() {
        let error = map_application_read(dohc_engine_runtime::RuntimeError::LiveApplication(
            dohc_engine_collab::live_update_application::ApplicationError::Interrupted,
        ));
        assert_eq!(error.code, workspace_unavailable().code);
        assert_eq!(error.message, workspace_unavailable().message);
    }

    async fn fence_queued_interruption(deadline: bool) {
        let (_scratch, service, owner, workspace, registration, binding) = fixture().await;
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
        let mut waiting =
            Box::pin(service.call(ctx, fence_request(&workspace, &binding, "relay-history")));
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
        assert_eq!(
            result.unwrap().unwrap_err().code,
            if deadline {
                ErrorCode::DeadlineExceeded
            } else {
                ErrorCode::Cancelled
            }
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), registration)
                .is_ok()
        );
        drop(serial);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn fence_queued_cancel_preserves_host() {
        fence_queued_interruption(false).await;
    }
    #[tokio::test]
    async fn fence_queued_deadline_preserves_host() {
        fence_queued_interruption(true).await;
    }

    #[tokio::test]
    async fn fence_wire_refuses_missing_terminal_extra_fields_and_foreign_host() {
        let (_scratch, service, owner, workspace, registration, binding) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        assert!(
            service
                .call(
                    RequestContext::unbounded(),
                    fence_request(&workspace, &binding, "relay-history")
                )
                .await
                .is_err()
        );
        for variant in 0..5 {
            let mut request = fence_request(&workspace, &binding, "relay-history");
            match variant {
                0 => {
                    request.params["operation"]
                        .as_object_mut()
                        .unwrap()
                        .remove("terminal");
                }
                1 => request.params["operation"]["extra"] = json!(true),
                2 => request.params["operation"]["hostId"] = json!("foreign"),
                3 => request.params["operation"]["relayDatabaseNamespace"] = json!("foreign"),
                _ => request.idempotency_key = Some("unexpected".into()),
            }
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            assert!(
                service.call(ctx, request).await.is_err(),
                "variant {variant}"
            );
            assert!(
                service
                    .live_application_registration(&owner.handle(), Some(&workspace), registration)
                    .is_ok()
            );
        }
        let host = lock(&service.live_applications)
            .hosts
            .get(&workspace)
            .unwrap()
            .clone();
        let guard = HostOutputGuard {
            host: host.clone(),
            cancel: RequestContext::unbounded().cancel,
            deadline: None,
            read: false,
        };
        assert!(guard.is_current());
        host.retire();
        assert!(!guard.is_current());
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        assert!(
            service
                .call(ctx, fence_request(&workspace, &binding, "relay-history"))
                .await
                .is_err()
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// A held read whose host retires while its connection lasts is told its
    /// workspace is unavailable, so its caller's slot frees at once rather
    /// than at its deadline. Once the connection is gone, nothing answers, and
    /// an acknowledgement is withheld either way.
    #[tokio::test]
    async fn held_read_on_a_retired_host_answers_while_its_connection_lasts() {
        let (_scratch, service, owner, workspace, _registration, _) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        let read = service
            .live_host_read_guard(&RequestContext::unbounded(), &workspace)
            .unwrap();
        let acknowledgement = HostOutputGuard {
            host: lock(&service.live_applications)
                .hosts
                .get(&workspace)
                .unwrap()
                .clone(),
            cancel: RequestContext::unbounded().cancel,
            deadline: None,
            read: false,
        };
        assert!(read.withheld_error().is_none());
        service.workspace_close(Some(workspace)).await.unwrap();
        assert!(!read.is_current());
        assert!(owner.handle().is_current());
        assert_eq!(
            read.withheld_error().map(|error| error.code),
            Some(ErrorCode::WorkspaceUnavailable)
        );
        assert!(acknowledgement.withheld_error().is_none());
        drop(owner);
        assert!(read.withheld_error().is_none());
        assert!(acknowledgement.withheld_error().is_none());
    }

    /// `Host::retire` cancels `retired` before it retires the owner. A held
    /// read the writer withholds in that gap is still answered.
    #[tokio::test]
    async fn held_read_answers_once_its_host_starts_retiring() {
        let (_scratch, service, owner, workspace, _registration, _) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        let read = service
            .live_host_read_guard(&RequestContext::unbounded(), &workspace)
            .unwrap();
        let host = lock(&service.live_applications)
            .hosts
            .get(&workspace)
            .unwrap()
            .clone();
        host.retired.cancel();
        assert!(owner.handle().is_current());
        assert!(host.current(&host.connection));
        assert_eq!(
            read.withheld_error().map(|error| error.code),
            Some(ErrorCode::WorkspaceUnavailable)
        );
    }

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
            deadline_ms: Some(60_000),
            idempotency_key: None,
            progress: false,
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
            deadline_ms: Some(60_000),
            idempotency_key: None,
            progress: false,
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

    /// A stopped settlement or fence that landed has its answer withheld, so
    /// a caller without its own deadline would wait forever.
    #[tokio::test]
    async fn settle_and_fence_require_the_callers_deadline() {
        let (_scratch, service, owner, workspace, registration, _) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let request = |id, method: &str, params| Request {
            id,
            method: method.into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params,
        };
        let settled = service
            .live_application_settle(
                ctx.clone(),
                request(
                    75,
                    "liveApplication.settle",
                    json!({"registrationId": registration, "terminalReceipt": null}),
                ),
            )
            .await;
        let fenced = service
            .live_application_fence_restore(
                ctx.clone(),
                request(
                    76,
                    "liveApplication.fenceRestore",
                    json!({"operation": {"terminal": null}}),
                ),
            )
            .await;
        for refused in [settled.err(), fenced.err()] {
            let refused = refused.expect("a call without a deadline is refused");
            assert_eq!(refused.code, ErrorCode::InvalidParams);
            assert_eq!(refused.message, "live-deadline-required");
        }
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// The bootstrap fixture's baseline and its projected Markdown.
    fn fixture_baseline() -> (Vec<u8>, String) {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json"
        ))
        .unwrap();
        (
            serde_json::from_value(vectors[1]["bytes"].clone()).unwrap(),
            vectors[1]["markdown"].as_str().unwrap().to_owned(),
        )
    }

    /// Install the fixture baseline through `registration`, as a host does
    /// before it settles or fences the document.
    async fn bootstrap_baseline(
        service: &Arc<EngineService>,
        owner: &dohc_engine_protocol::transport::ConnectionOwner,
        workspace: &WorkspaceHandle,
        registration: u64,
    ) -> ServiceResponse {
        let (baseline, markdown) = fixture_baseline();
        let mut upload = LiveApplicationIngress::new(service.clone(), config()).unwrap();
        upload.begin(Request {
            id: 73,
            method: "liveApplication.bootstrap".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({"registrationId":registration,"baselineStreamId":1,"baseline":{
                "bootstrapId":"bootstrap","bootstrapMomentId":"bootstrap-moment","baselineMomentRelaySequence":0,"baselineRegisteredAtMs":100,
                "baselineDigest":hex_sha256(&baseline),"baselineByteLength":baseline.len(),"projectedMarkdownDigest":hex_sha256(markdown.as_bytes()),"projectedMarkdownByteLength":markdown.len()
            }}),
        }, &owner.handle()).unwrap();
        upload
            .start(BlobStart {
                request_id: 73,
                stream_id: 1,
                total_bytes: Some(baseline.len() as u64),
                sha256: Some(hex_sha256(&baseline)),
            })
            .unwrap();
        let crate::live_application_ingress::UploadCompletion::Admitted(request, input) =
            upload.chunk(1, true, &baseline).unwrap().unwrap()
        else {
            panic!("unexpected refusal")
        };
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let response = service
            .call_with_input(ctx, request, Some(input))
            .await
            .unwrap();
        assert_eq!(response.response.result["status"], "bootstrapped");
        response
    }

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

    async fn actor_interruption(deadline: bool, restore_fence: bool) {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let configuration = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "cancel-test",
            "host": {"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": [{"root":scratch.path(),"workspaceId":"workspace","maxRegistrations":4}],
            "ingress": {"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":1,"uploadDeadlineMs":30_000},
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
            lineage_claim_id: hex_sha256(&fixture_baseline().0),
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
        bootstrap_baseline(&service, &owner, &workspace, registration).await;
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
        let request = if restore_fence {
            fence_request(&workspace, &binding, "cancel-test")
        } else {
            Request {
                id: 72,
                method: "liveApplication.settle".into(),
                workspace: Some(workspace.clone()),
                deadline_ms: Some(60_000),
                idempotency_key: None,
                progress: false,
                params: json!({"registrationId":registration,"terminalReceipt":null}),
            }
        };
        let mut waiting = Box::pin(service.call(ctx, request));
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
        tokio::task::yield_now().await;
        std::future::poll_fn(|cx| {
            assert!(
                std::future::Future::poll(waiting.as_mut(), cx).is_pending(),
                "submitted actor work is awaited, not answered for"
            );
            std::task::Poll::Ready(())
        })
        .await;
        if deadline {
            tokio::time::resume();
        }
        assert!(
            open.session_ops.try_lock().is_err(),
            "actor work keeps session exclusion while it runs"
        );
        assert!(
            restore_fence || ingress.settlement_admission(4).unwrap().reserve().is_err(),
            "actor work keeps its admission charge while it runs"
        );
        release_tx.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("the request answers once its actor work ends");
        if restore_fence {
            // The fence takes no token, so it ran: the answer is its own.
            let fenced = result.expect("a fence that ran answers fenced");
            assert_eq!(fenced.response.result["status"], "fenced");
            // Paused time does not move the clock the guard reads.
            assert!(
                deadline || !fenced.output_guard.as_ref().unwrap().is_current(),
                "the writer withholds an answer its caller stopped waiting for"
            );
        } else {
            assert_eq!(
                result.unwrap_err().code,
                if deadline {
                    ErrorCode::DeadlineExceeded
                } else {
                    ErrorCode::Cancelled
                },
                "a settlement stopped before it ran answers as interrupted"
            );
            assert!(
                service
                    .live_application_registration(&owner.handle(), Some(&workspace), registration)
                    .is_ok(),
                "a settlement that never ran keeps the host"
            );
        }
        assert!(open.session_ops.try_lock().is_ok());
        assert!(ingress.settlement_admission(4).unwrap().reserve().is_ok());
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn settle_actor_cancel_answers_cancelled_once_its_actor_work_ends() {
        actor_interruption(false, false).await;
    }

    #[tokio::test]
    async fn fence_actor_cancel_answers_with_the_fence_outcome() {
        actor_interruption(false, true).await;
    }

    #[tokio::test]
    async fn fence_actor_deadline_answers_with_the_fence_outcome() {
        actor_interruption(true, true).await;
    }

    async fn completed_operation_survives_late_cancel(restore_fence: bool) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct CountWake(AtomicUsize);
        impl std::task::Wake for CountWake {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let configuration = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "completion-test",
            "host": {"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": [{"root":scratch.path(),"workspaceId":"workspace","maxRegistrations":4}],
            "ingress": {"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":1,"uploadDeadlineMs":30_000},
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
            lineage_claim_id: hex_sha256(&fixture_baseline().0),
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
        let bootstrap = bootstrap_baseline(&service, &owner, &workspace, registration).await;
        assert!(bootstrap.output_guard.as_ref().unwrap().is_current());
        let cancel = ctx.cancel.clone();
        let request = if restore_fence {
            fence_request(&workspace, &binding, "completion-test")
        } else {
            Request {
                id: 74,
                method: "liveApplication.settle".into(),
                workspace: Some(workspace.clone()),
                deadline_ms: Some(60_000),
                idempotency_key: None,
                progress: false,
                params: json!({"registrationId":registration,"terminalReceipt":null}),
            }
        };
        let mut waiting = Box::pin(service.call(ctx, request));
        let wakes = Arc::new(CountWake(AtomicUsize::new(0)));
        let waker = std::task::Waker::from(wakes.clone());
        assert!(
            std::future::Future::poll(
                waiting.as_mut(),
                &mut std::task::Context::from_waker(&waker),
            )
            .is_pending()
        );
        // The spawned operation owns this lock until its terminal poll. Keep the
        // RPC unpolled until that operation finishes, then cancel it.
        let serial =
            tokio::time::timeout(std::time::Duration::from_secs(5), open.session_ops.lock())
                .await
                .unwrap();
        drop(serial);
        cancel.cancel();
        let answered = waiting
            .await
            .expect("a completed operation answers with its own outcome");
        assert_eq!(
            answered.response.result["status"],
            if restore_fence { "fenced" } else { "settled" }
        );
        assert!(
            !answered.output_guard.as_ref().unwrap().is_current(),
            "the writer withholds an answer its caller stopped waiting for"
        );
        // The answer holds its admission until the writer drops it.
        drop(answered);
        assert!(ingress.settlement_admission(4).unwrap().reserve().is_ok());
        if restore_fence {
            let db = rusqlite::Connection::open_with_flags(
                scratch.path().join(".dohc/engine/engine.db"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let fenced: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM live_restore_fences WHERE operation_id='restore-rpc'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(fenced, 1, "the native fence committed before cancellation");
            assert!(
                !bootstrap.output_guard.as_ref().unwrap().is_current(),
                "a committed fence must retire queued output even when its reply is cancelled"
            );
            assert!(
                service
                    .live_application_registration(&owner.handle(), Some(&workspace), registration)
                    .is_err()
            );
            assert!(
                lock(&service.live_applications)
                    .hosts
                    .get(&workspace)
                    .unwrap()
                    .current(&owner.handle())
            );
        } else {
            assert!(
                service
                    .live_application_registration(&owner.handle(), Some(&workspace), registration)
                    .is_ok(),
                "a terminal settlement must preserve the host when cancellation is also ready"
            );
        }
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn a_registration_cancelled_at_the_session_lock_registers_nothing() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let configuration = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "register-lock-test",
            "host": {"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": [{"root":scratch.path(),"workspaceId":"workspace","maxRegistrations":4}],
            "ingress": {"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":1,"uploadDeadlineMs":30_000},
            "settlement": {"maxApplicationsPerSettlement":4}
        })).unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(configuration)
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
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "document".into(),
            lineage_claim_id: hex_sha256(&fixture_baseline().0),
            current_path: "document.md".into(),
            selector_paths: vec!["document.md".into()],
            restore_fence_generation: 0,
        };
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let serial = open.session_ops.lock().await;
        let mut waiting = Box::pin(service.live_application_register(
            &ctx,
            Some(workspace.clone()),
            json!({"binding": binding}),
        ));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        ctx.cancel.cancel();
        let error = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("a queued registration stops waiting for the session lock")
            .expect_err("nothing ran");
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(lock(&service.live_applications).registrations.is_empty());
        drop(serial);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn an_application_cancelled_at_the_session_lock_answers_cancelled() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let configuration = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "lock-test",
            "host": {"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": [{"root":scratch.path(),"workspaceId":"workspace","maxRegistrations":4}],
            "ingress": {"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":1,"uploadDeadlineMs":30_000},
            "settlement": {"maxApplicationsPerSettlement":4}
        })).unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(configuration)
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
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json"
        ))
        .unwrap();
        let baseline: Vec<u8> = serde_json::from_value(vectors[1]["bytes"].clone()).unwrap();
        let markdown = vectors[1]["markdown"].as_str().unwrap();
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "document".into(),
            lineage_claim_id: hex_sha256(&baseline),
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
        let mut upload = LiveApplicationIngress::new(service.clone(), config()).unwrap();
        upload.begin(Request {
            id: 75,
            method: "liveApplication.bootstrap".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({"registrationId":registration,"baselineStreamId":1,"baseline":{
                "bootstrapId":"bootstrap","bootstrapMomentId":"bootstrap-moment","baselineMomentRelaySequence":0,"baselineRegisteredAtMs":100,
                "baselineDigest":hex_sha256(&baseline),"baselineByteLength":baseline.len(),"projectedMarkdownDigest":hex_sha256(markdown.as_bytes()),"projectedMarkdownByteLength":markdown.len()
            }}),
        }, &owner.handle()).unwrap();
        upload
            .start(BlobStart {
                request_id: 75,
                stream_id: 1,
                total_bytes: Some(baseline.len() as u64),
                sha256: Some(hex_sha256(&baseline)),
            })
            .unwrap();
        let crate::live_application_ingress::UploadCompletion::Admitted(request, input) =
            upload.chunk(1, true, &baseline).unwrap().unwrap()
        else {
            panic!("unexpected refusal")
        };
        let serial = open.session_ops.lock().await;
        let cancel = ctx.cancel.clone();
        let mut waiting = Box::pin(service.call_with_input(ctx, request, Some(input)));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        cancel.cancel();
        let error = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("a queued application stops waiting for the session lock")
            .expect_err("nothing ran");
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), registration)
                .is_ok()
        );
        drop(serial);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn settle_completed_operation_survives_late_cancel() {
        completed_operation_survives_late_cancel(false).await;
    }

    #[tokio::test]
    async fn fence_completed_operation_survives_late_cancel() {
        completed_operation_survives_late_cancel(true).await;
    }

    #[tokio::test]
    async fn settle_actor_deadline_answers_deadline_once_its_actor_work_ends() {
        actor_interruption(true, false).await;
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
        let crate::live_application_ingress::UploadCompletion::Admitted(request, input) =
            ingress.chunk(2, true, &[]).unwrap().unwrap()
        else {
            panic!("unexpected refusal")
        };
        let retry = input.clone();
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

    fn unload_binding(object_id: &str) -> LiveObjectBinding {
        LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: object_id.into(),
            lineage_claim_id: hex_sha256(&Ydoc::wire().encode_full_state()),
            current_path: format!("{object_id}.md"),
            selector_paths: vec![format!("{object_id}.md")],
            restore_fence_generation: 0,
        }
    }

    /// What a capture of `object_id` for `activation_id` retains.
    fn captured(
        object_id: &str,
        activation_id: &str,
    ) -> dohc_engine_collab::live_update_application::ImportedOwnerActivation {
        let lineage = hex_sha256(&Ydoc::wire().encode_full_state());
        dohc_engine_collab::live_update_application::ImportedOwnerActivation {
            activation_id: activation_id.into(),
            source: dohc_engine_collab::live_update_application::ImportedOwnerSource {
                version: 1,
                reader_source: false,
                relay_database_namespace: "unload-test".into(),
                workspace_id: "workspace".into(),
                main_version_id: "main".into(),
                object_id: object_id.into(),
                lineage_claim_id: lineage.clone(),
                current_path: format!("{object_id}.md"),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                committed_cursor: 0,
                base_origin_id: "origin".into(),
                base_origin_seq: 0,
                base_relay_seq: 0,
                source_moment_id: "moment".into(),
                source_digest: lineage.clone(),
                source_byte_length: 0,
                native_head_sequence: 0,
                full_state_digest: lineage,
                full_state_byte_length: 0,
                predecessor_activation_id: None,
            },
            baseline_bytes: Vec::new(),
            full_state: Vec::new(),
            restore_generation: None,
        }
    }

    /// An imported session `ydoc-unload-<object_id>` serving `activation_id`,
    /// holding the document's lease.
    fn install_session(
        service: &EngineService,
        workspace: &WorkspaceHandle,
        object_id: &str,
        activation_id: &str,
    ) {
        let open = service.open(Some(workspace)).unwrap();
        let key = DocKey::new("workspace", "main", object_id).unwrap();
        let lease = service.leases.scoped(&open.root).acquire(&key).unwrap();
        let session = super::super::ydoc::YdocSession::imported_owner(
            workspace.clone(),
            key,
            &captured(object_id, activation_id),
            lease,
        )
        .unwrap();
        lock(&service.sessions).insert(format!("ydoc-unload-{object_id}"), session);
    }

    /// A configured host with "document" and "sibling" registered, and an
    /// imported session holding the lease on "document".
    async fn unload_fixture() -> (
        dohc_engine_testkit::ScratchDir,
        Arc<EngineService>,
        dohc_engine_protocol::transport::ConnectionOwner,
        WorkspaceHandle,
        u64,
        u64,
    ) {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let configuration = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "unload-test",
            "host": {"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": [{"root":scratch.path(),"workspaceId":"workspace","maxRegistrations":4}],
            "ingress": {"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":1,"uploadDeadlineMs":30_000},
            "settlement": {"maxApplicationsPerSettlement":4}
        }))
        .unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(configuration)
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
        let mut registrations = Vec::new();
        for object_id in ["document", "sibling"] {
            let registered = service
                .live_application_register(
                    &ctx,
                    Some(workspace.clone()),
                    json!({"binding": unload_binding(object_id)}),
                )
                .await
                .unwrap();
            registrations.push(registered["registrationId"].as_u64().unwrap());
        }
        install_session(&service, &workspace, "document", "activation");
        (
            scratch,
            service,
            owner,
            workspace,
            registrations[0],
            registrations[1],
        )
    }

    /// An unload of `object_id` that names `activation_id`.
    fn unload_naming(
        workspace: &WorkspaceHandle,
        object_id: &str,
        activation_id: Option<&str>,
    ) -> Request {
        let mut params = json!({"objectId": object_id});
        if let Some(activation_id) = activation_id {
            params["activationId"] = json!(activation_id);
        }
        Request {
            id: 96,
            method: "liveApplication.unloadDocument".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params,
        }
    }

    /// An unload of `object_id` as the fixture's imported session serves it.
    fn unload_request(workspace: &WorkspaceHandle, object_id: &str) -> Request {
        unload_naming(workspace, object_id, Some("activation"))
    }

    #[tokio::test]
    async fn an_activation_registration_is_refused_before_the_existing_one_retires() {
        let (_scratch, service, owner, workspace, document, _sibling) = unload_fixture().await;
        let params = json!({"binding": unload_binding("document"), "activationId": "unknown"});
        let stranger = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        let mut foreign = RequestContext::unbounded();
        foreign.connection = Some(stranger.handle());
        assert_eq!(
            service
                .live_application_register(&foreign, Some(workspace.clone()), params.clone())
                .await
                .unwrap_err()
                .code,
            ErrorCode::SessionExpired,
            "only the configured session host names an activation"
        );
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        assert!(
            service
                .live_application_register(&ctx, Some(workspace.clone()), params)
                .await
                .is_err()
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), document)
                .is_ok()
        );
        let open = service.open(Some(&workspace)).unwrap();
        let store =
            dohc_engine_storage::EngineStore::open_read_only(open.actor.database_path()).unwrap();
        let available: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT available FROM live_device_application_bindings WHERE object_id='document'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(available, 1);
    }

    #[tokio::test]
    async fn unload_releases_one_document_and_keeps_its_sibling() {
        let (_scratch, service, owner, workspace, document, sibling) = unload_fixture().await;
        let context = || {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            ctx
        };
        let open = service.open(Some(&workspace)).unwrap();
        let key = DocKey::new("workspace", "main", "document").unwrap();
        assert!(service.leases.scoped(&open.root).acquire(&key).is_err());
        let stranger = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        let mut foreign = RequestContext::unbounded();
        foreign.connection = Some(stranger.handle());
        assert_eq!(
            service
                .call(foreign, unload_request(&workspace, "document"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::SessionExpired
        );
        let unloaded = service
            .call(context(), unload_request(&workspace, "document"))
            .await
            .unwrap();
        assert_eq!(unloaded.response.result, json!({"status":"unloaded"}));
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), document)
                .is_err()
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), sibling)
                .is_ok()
        );
        assert!(!lock(&service.sessions).contains_key("ydoc-unload-document"));
        drop(service.leases.scoped(&open.root).acquire(&key).unwrap());
        let store =
            dohc_engine_storage::EngineStore::open_read_only(open.actor.database_path()).unwrap();
        let available: Vec<(String, i64)> = store
            .read_with(|conn| {
                conn.prepare("SELECT object_id,available FROM live_device_application_bindings ORDER BY object_id")?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap();
        assert_eq!(
            available,
            [("document".to_owned(), 0), ("sibling".to_owned(), 1)]
        );
        // Stale callers fail cleanly; the document registers again on its next open.
        let stale = service
            .call(
                context(),
                Request {
                    id: 97,
                    method: "liveApplication.settle".into(),
                    workspace: Some(workspace.clone()),
                    deadline_ms: Some(60_000),
                    idempotency_key: None,
                    progress: false,
                    params: json!({"registrationId":document,"terminalReceipt":null}),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(stale.code, workspace_unavailable().code);
        assert_eq!(
            service
                .call(context(), unload_request(&workspace, "document"))
                .await
                .unwrap_err()
                .code,
            workspace_unavailable().code
        );
        let again = service
            .live_application_register(
                &context(),
                Some(workspace.clone()),
                json!({"binding": unload_binding("document")}),
            )
            .await
            .unwrap();
        assert!(again["registrationId"].as_u64().unwrap() > sibling);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn unload_refuses_incomplete_delivery_and_releases_nothing() {
        let (_scratch, service, owner, workspace, document, _) = unload_fixture().await;
        let context = || {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            ctx
        };
        let open = service.open(Some(&workspace)).unwrap();
        let mut store =
            dohc_engine_storage::EngineStore::open(open.actor.database_path(), 0).unwrap();
        let deferred = |sql: &'static str, store: &mut dohc_engine_storage::EngineStore| {
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute_batch(sql).unwrap();
                    Ok::<_, dohc_engine_storage::StorageError>(())
                })
                .unwrap();
        };
        deferred(
            "INSERT OR IGNORE INTO file_objects(workspace_id,object_id,created_at_ms) VALUES ('workspace','document',0);
             INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms)
             VALUES ('workspace','main','document','origin',1,0);",
            &mut store,
        );
        let refused = service
            .call(context(), unload_request(&workspace, "document"))
            .await
            .unwrap();
        assert_eq!(
            refused.response.result,
            json!({"status":"pending","reason":"delivery-pending"})
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), document)
                .is_ok()
        );
        assert!(lock(&service.sessions).contains_key("ydoc-unload-document"));
        deferred(
            "DELETE FROM ydoc_deferred_updates WHERE object_id='document';",
            &mut store,
        );
        drop(store);
        let unloaded = service
            .call(context(), unload_request(&workspace, "document"))
            .await
            .unwrap();
        assert_eq!(unloaded.response.result, json!({"status":"unloaded"}));
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn unload_waits_only_for_applications_on_the_current_lineage() {
        let (_scratch, service, owner, workspace, _, _) = unload_fixture().await;
        let context = || {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            ctx
        };
        let open = service.open(Some(&workspace)).unwrap();
        let mut store =
            dohc_engine_storage::EngineStore::open(open.actor.database_path(), 0).unwrap();
        let execute = |sql: &str, store: &mut dohc_engine_storage::EngineStore| {
            store
                .write_with(&NoFaults, |tx| {
                    tx.execute_batch(sql).unwrap();
                    Ok::<_, dohc_engine_storage::StorageError>(())
                })
                .unwrap();
        };
        let digest = hex_sha256(&[0, 0]);
        execute(
            &format!(
                "INSERT OR IGNORE INTO binary_blobs(sha256,byte_length,bytes) VALUES ('{digest}',2,x'0000');
                 INSERT INTO live_device_update_applications(relay_database_namespace,workspace_id,
                    delivery_id,main_version_id,object_id,lineage_claim_id,current_path,
                    selector_paths_json,restore_fence_generation,update_digest,update_byte_length,
                    journal_cursor,accepting_host_epoch,principal_kind,principal_id,grant_id,
                    grant_generation,received_at_ms,first_seen_count,local_ydoc_sequence,
                    applied_host_id,applied_host_epoch,applied_instance_id,applied_connection_id)
                 SELECT relay_database_namespace,workspace_id,'unsettled',main_version_id,object_id,
                    lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,
                    '{digest}',2,1,1,'owner','person',NULL,NULL,0,0,1,
                    host_id,host_epoch,instance_id,connection_id
                 FROM live_device_application_bindings WHERE object_id='document';"
            ),
            &mut store,
        );
        let refused = service
            .call(context(), unload_request(&workspace, "document"))
            .await
            .unwrap();
        assert_eq!(
            refused.response.result,
            json!({"status":"pending","reason":"settlement-pending"})
        );
        // A restore replaced that lineage; its applications never settle.
        execute(
            "UPDATE live_device_update_applications SET lineage_claim_id=printf('%064d',0);",
            &mut store,
        );
        drop(store);
        let unloaded = service
            .call(context(), unload_request(&workspace, "document"))
            .await
            .unwrap();
        assert_eq!(unloaded.response.result, json!({"status":"unloaded"}));
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_unload_answers_with_the_unload_its_actor_work_completed() {
        let (_scratch, service, owner, workspace, document, sibling) = unload_fixture().await;
        let open = service.open(Some(&workspace)).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let actor = open.actor.clone();
        let blocker = tokio::spawn(async move {
            actor
                .ensure_main_version(
                    "unload-blocker".into(),
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
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let cancel = ctx.cancel.clone();
        let mut waiting = Box::pin(service.call(ctx, unload_request(&workspace, "document")));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        cancel.cancel();
        tokio::task::yield_now().await;
        std::future::poll_fn(|cx| {
            assert!(
                std::future::Future::poll(waiting.as_mut(), cx).is_pending(),
                "a started unload is awaited, not answered for"
            );
            std::task::Poll::Ready(())
        })
        .await;
        assert!(open.session_ops.try_lock().is_err());
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), document)
                .is_ok()
        );
        assert!(lock(&service.sessions).contains_key("ydoc-unload-document"));
        release_tx.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        let unloaded = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("the unload answers once its actor work ends")
            .expect("the unload ran");
        assert_eq!(unloaded.response.result, json!({"status": "unloaded"}));
        assert!(open.session_ops.try_lock().is_ok());
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), document)
                .is_err()
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), sibling)
                .is_ok()
        );
        assert!(!lock(&service.sessions).contains_key("ydoc-unload-document"));
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    fn host_context(owner: &dohc_engine_protocol::transport::ConnectionOwner) -> RequestContext {
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        ctx
    }

    /// Shape rows no engine path writes yet, as foreign keys allow none.
    fn shape(service: &EngineService, workspace: &WorkspaceHandle, sql: &str) {
        let open = service.open(Some(workspace)).unwrap();
        let conn = rusqlite::Connection::open(open.actor.database_path()).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        conn.execute_batch(sql).unwrap();
    }

    fn lineage() -> String {
        hex_sha256(&Ydoc::wire().encode_full_state())
    }

    /// Retain the document's captured source, as its capture did.
    fn retain_source(service: &EngineService, workspace: &WorkspaceHandle) {
        let source = captured("document", "activation").source;
        let descriptor = serde_json::to_string(&source).unwrap();
        let lineage = lineage();
        shape(
            service,
            workspace,
            &format!(
                "INSERT INTO ydoc_owner_activation_sources VALUES ('activation','unload-test','workspace',
                 'main','document','{lineage}','moment','{lineage}','{lineage}','{descriptor}');
                 INSERT OR IGNORE INTO binary_blobs VALUES ('{lineage}',1,x'00');
                 INSERT OR IGNORE INTO blobs VALUES ('{lineage}',0,'')"
            ),
        );
    }

    /// An activation row of the document's lineage, as an adoption, or a
    /// release after one that never adopted, leaves it.
    fn record_activation(
        service: &EngineService,
        workspace: &WorkspaceHandle,
        activation: &str,
        predecessor: Option<&str>,
        released: bool,
    ) {
        let lineage = lineage();
        let binding = serde_json::to_string(&unload_binding("document")).unwrap();
        let predecessor = predecessor.map_or("NULL".to_owned(), |id| format!("'{id}'"));
        shape(
            service,
            workspace,
            &if released {
                format!(
                "INSERT INTO live_owner_activations(relay_database_namespace,activation_id,workspace_id,
                    main_version_id,object_id,lineage_claim_id,predecessor_activation_id,binding_json,
                    source_moment_id,source_digest,source_byte_length,host_coordinate_json,released_at_ms,
                    released_restore_generation,released_accepted_cursor,released_boundary_json,carried_manifest_json)
                 VALUES ('unload-test','{activation}','workspace','main','document','{lineage}',{predecessor},
                    '{binding}','moment','{lineage}',0,'{{}}',1,0,5,'null','[]')"
            )
            } else {
                format!(
                "INSERT INTO live_owner_activations(relay_database_namespace,activation_id,workspace_id,
                    main_version_id,object_id,lineage_claim_id,origin_adoption_id,predecessor_activation_id,
                    binding_json,source_moment_id,source_digest,source_byte_length,baseline_moment_relay_sequence,
                    baseline_registered_at_ms,host_coordinate_json,evidence_digest,coverage_digest,
                    covered_outbox_sequence,local_ydoc_sequence,terminal_cursor,terminal_receipt_json,
                    max_pending_bytes,max_pending_age_ms)
                 VALUES ('unload-test','{activation}','workspace','main','document','{lineage}','activation',
                    {predecessor},'{binding}','moment','{lineage}',0,0,0,'{{}}','{lineage}','{lineage}',0,0,0,
                    'null',1,1)"
            )
            },
        );
    }

    /// Register the document again, naming `activation` as the relay does,
    /// or else taking the activation that now holds its lineage.
    async fn register_document(
        service: &EngineService,
        owner: &dohc_engine_protocol::transport::ConnectionOwner,
        workspace: &WorkspaceHandle,
        activation: Option<&str>,
    ) -> Result<u64, WireError> {
        let mut params = json!({"binding": unload_binding("document")});
        if let Some(activation) = activation {
            params["activationId"] = json!(activation);
        }
        Ok(service
            .live_application_register(&host_context(owner), Some(workspace.clone()), params)
            .await?["registrationId"]
            .as_u64()
            .unwrap())
    }

    /// The fixture with the document's source retained and its registration
    /// naming that activation, as the relay registers, and, when `adopted`,
    /// the activation adopted.
    async fn retirement_fixture(
        adopted: bool,
    ) -> (
        dohc_engine_testkit::ScratchDir,
        Arc<EngineService>,
        dohc_engine_protocol::transport::ConnectionOwner,
        WorkspaceHandle,
        u64,
        u64,
    ) {
        let (scratch, service, owner, workspace, _, sibling) = unload_fixture().await;
        retain_source(&service, &workspace);
        if adopted {
            record_activation(&service, &workspace, "activation", None, false);
        }
        let document = register_document(&service, &owner, &workspace, Some("activation"))
            .await
            .unwrap();
        assert_eq!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), document)
                .unwrap()
                .activation_id()
                .as_deref(),
            Some("activation")
        );
        (scratch, service, owner, workspace, document, sibling)
    }

    /// What a retirement could tear down: whether the registration stays,
    /// the document session's activation, its binding row, and whether the
    /// host retired the activation.
    type Teardown = (bool, Option<Option<String>>, (i64, Option<String>), bool);

    fn teardown(
        service: &EngineService,
        owner: &dohc_engine_protocol::transport::ConnectionOwner,
        workspace: &WorkspaceHandle,
        registration: u64,
    ) -> Teardown {
        let registered = service
            .live_application_registration(&owner.handle(), Some(workspace), registration)
            .is_ok();
        let session = lock(&service.sessions)
            .get("ydoc-unload-document")
            .map(|session| session.activation_id.clone());
        let open = service.open(Some(workspace)).unwrap();
        let store =
            dohc_engine_storage::EngineStore::open_read_only(open.actor.database_path()).unwrap();
        let binding = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT available,activation_id FROM live_device_application_bindings WHERE object_id='document'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        let retired = lock(&service.live_applications)
            .retired_activations(workspace)
            .unwrap()
            .contains("activation");
        (registered, session, binding, retired)
    }

    fn retirement_key(activation: &str) -> Value {
        json!({"objectId":"document","lineageClaimId":lineage(),"activationId":activation,
            "restoreFenceGeneration":0,"acceptedThrough":5,"afterReceipt":null,"maxApplications":4})
    }

    fn reconcile_request(workspace: &WorkspaceHandle, params: Value) -> Request {
        Request {
            id: 98,
            method: "liveApplication.reconcileActivation".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params,
        }
    }

    #[tokio::test]
    async fn reconciliation_is_only_for_the_configured_host_and_its_budget() {
        let (_scratch, service, owner, workspace, document, _) = retirement_fixture(true).await;
        let before = teardown(&service, &owner, &workspace, document);
        let stranger = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        let request = || reconcile_request(&workspace, retirement_key("activation"));
        assert_eq!(
            service
                .call(host_context(&stranger), request())
                .await
                .unwrap_err()
                .code,
            ErrorCode::SessionExpired
        );
        let ordinary = EngineService::new();
        let mut unbound = request();
        unbound.workspace = None;
        assert_eq!(
            ordinary
                .call(host_context(&stranger), unbound)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Forbidden,
            "an engine with no configured host has no retirement"
        );
        for budget in [0, 5] {
            let mut key = retirement_key("activation");
            key["maxApplications"] = json!(budget);
            assert_eq!(
                service
                    .call(host_context(&owner), reconcile_request(&workspace, key))
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidParams,
                "budget {budget}"
            );
        }
        assert_eq!(teardown(&service, &owner, &workspace, document), before);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// Every shared guard refuses before Phase A, for an adopted activation
    /// and a never-adopted source alike: nothing it would tear down goes.
    #[tokio::test]
    async fn an_invalid_reconciliation_tears_nothing_down() {
        let lineage = lineage();
        for adopted in [false, true] {
            let (_scratch, service, owner, workspace, document, _) =
                retirement_fixture(adopted).await;
            let before = teardown(&service, &owner, &workspace, document);
            assert_eq!((before.0, before.3), (true, false));
            let refused = |key: Value| {
                let service = service.clone();
                let request = reconcile_request(&workspace, key);
                let ctx = host_context(&owner);
                async move { service.call(ctx, request).await.unwrap_err().code }
            };
            for (case, field, value) in [
                ("document", "objectId", json!("sibling")),
                ("lineage", "lineageClaimId", json!("f".repeat(64))),
                ("activation", "activationId", json!("unknown")),
                ("generation", "restoreFenceGeneration", json!(1)),
            ] {
                let mut key = retirement_key("activation");
                key[field] = value;
                assert_eq!(
                    refused(key).await,
                    ErrorCode::Conflict,
                    "{case} adopted={adopted}"
                );
                assert_eq!(
                    teardown(&service, &owner, &workspace, document),
                    before,
                    "{case}"
                );
            }
            let named = before
                .2
                .1
                .as_ref()
                .map_or("NULL".to_owned(), |id| format!("'{id}'"));
            let table = if adopted {
                "live_owner_activations"
            } else {
                "ydoc_owner_activation_sources"
            };
            let mut shaped = vec![
                (
                    "binding",
                    "UPDATE live_device_application_bindings SET activation_id='elsewhere' WHERE object_id='document'".to_owned(),
                    format!("UPDATE live_device_application_bindings SET activation_id={named} WHERE object_id='document'"),
                ),
                (
                    "namespace",
                    format!("UPDATE {table} SET relay_database_namespace='elsewhere'"),
                    format!("UPDATE {table} SET relay_database_namespace='unload-test'"),
                ),
                (
                    "active restore",
                    format!(
                        "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,
                            operation_id,input_json,receipt_json)
                         VALUES ('workspace','main','document','unload-test','restore',
                            json_object('oldBinding',json_object('lineageClaimId','{lineage}','restoreFenceGeneration',0),'newFence',1),'{{}}')"
                    ),
                    "DELETE FROM live_restore_fences".to_owned(),
                ),
                (
                    "successor",
                    String::new(),
                    "DELETE FROM live_owner_activations WHERE activation_id='successor'".to_owned(),
                ),
            ];
            if !adopted {
                shaped.push((
                    "another current activation",
                    String::new(),
                    "DELETE FROM live_owner_activations WHERE activation_id='other'".to_owned(),
                ));
            }
            for (case, damage, repair) in shaped {
                match case {
                    "successor" => record_activation(
                        &service,
                        &workspace,
                        "successor",
                        Some("activation"),
                        true,
                    ),
                    "another current activation" => {
                        record_activation(&service, &workspace, "other", None, false)
                    }
                    _ => shape(&service, &workspace, &damage),
                }
                assert_eq!(
                    refused(retirement_key("activation")).await,
                    ErrorCode::Conflict,
                    "{case} adopted={adopted}"
                );
                shape(&service, &workspace, &repair);
                assert_eq!(
                    teardown(&service, &owner, &workspace, document),
                    before,
                    "{case}"
                );
            }
            // The same key, intact, retires the activation.
            let reconciled = service
                .call(
                    host_context(&owner),
                    reconcile_request(&workspace, retirement_key("activation")),
                )
                .await
                .unwrap()
                .response
                .result;
            assert_eq!(reconciled["status"], "reconciled", "adopted={adopted}");
            assert_eq!(
                reconciled["adoption"]["adoptionId"].as_str(),
                adopted.then_some("activation")
            );
            let after = teardown(&service, &owner, &workspace, document);
            assert_eq!(after, (false, None, before.2, true), "adopted={adopted}");
            service.workspace_close(Some(workspace)).await.unwrap();
        }
    }

    /// A released activation's replay tears nothing down, and a wrong F for
    /// it is refused: its successor keeps its registration, session, cache
    /// and binding.
    #[tokio::test]
    async fn a_released_replay_leaves_its_successor_alone() {
        let (_scratch, service, owner, workspace, _, _) = retirement_fixture(true).await;
        shape(
            &service,
            &workspace,
            &format!("UPDATE live_owner_activations SET released_at_ms=1,released_restore_generation=0,
                released_accepted_cursor=5,released_boundary_json='{RELEASED_BOUNDARY}',carried_manifest_json='[]'"),
        );
        record_activation(&service, &workspace, "successor", Some("activation"), false);
        let successor = register_document(&service, &owner, &workspace, None)
            .await
            .unwrap();
        lock(&service.sessions)
            .get_mut("ydoc-unload-document")
            .unwrap()
            .activation_id = Some("successor".into());
        let open = service.open(Some(&workspace)).unwrap();
        let cache = open.actor.ydoc_cache_stats_for_test().await.unwrap();
        let before = teardown(&service, &owner, &workspace, successor);
        assert_eq!(
            before,
            (
                true,
                Some(Some("successor".into())),
                (1, Some("successor".into())),
                false
            )
        );
        let mut wrong = retirement_key("activation");
        wrong["acceptedThrough"] = json!(4);
        assert_eq!(
            service
                .call(host_context(&owner), reconcile_request(&workspace, wrong))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let replayed = service
            .call(
                host_context(&owner),
                reconcile_request(&workspace, retirement_key("activation")),
            )
            .await
            .unwrap()
            .response
            .result;
        assert_eq!(replayed["status"], "reconciled");
        assert_eq!(teardown(&service, &owner, &workspace, successor), before);
        assert_eq!(
            open.actor
                .ydoc_cache_stats_for_test()
                .await
                .unwrap()
                .removes,
            cache.removes,
            "no cache entry was evicted"
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// Phase A ends only the reconciled activation: its registration, output,
    /// session and lease go; another document's registration, output and a
    /// session serving another activation stay, and so does its binding.
    /// Nothing registers for it again.
    #[tokio::test]
    async fn phase_a_ends_only_the_reconciled_activation() {
        let (_scratch, service, owner, workspace, document, sibling) =
            retirement_fixture(true).await;
        install_session(&service, &workspace, "sibling", "sibling-activation");
        let guard = |registration: u64| {
            let registration = service
                .live_application_registration(&owner.handle(), Some(&workspace), registration)
                .unwrap();
            ApplicationOutputGuard {
                activation_id: registration.activation_id(),
                registration,
                cancel: CancelSignal::new(),
                deadline: None,
                reservation: Mutex::new(Some(Arc::new(()))),
            }
        };
        let (document_output, sibling_output) = (guard(document), guard(sibling));
        assert!(document_output.is_current() && sibling_output.is_current());
        let reconciled = service
            .call(
                host_context(&owner),
                reconcile_request(&workspace, retirement_key("activation")),
            )
            .await
            .unwrap()
            .response
            .result;
        assert_eq!(
            reconciled,
            json!({"status":"reconciled","adoption":{"adoptionId":"activation","localYDocSequence":0,
                "terminalCursor":0,"adoptionReplayed":true},"applications":[],"hasMoreApplications":false,"settle":false})
        );
        assert_eq!(
            teardown(&service, &owner, &workspace, document),
            (false, None, (1, Some("activation".into())), true)
        );
        assert!(!document_output.is_current());
        assert!(sibling_output.is_current());
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), sibling)
                .is_ok()
        );
        assert_eq!(
            lock(&service.sessions)["ydoc-unload-sibling"]
                .activation_id
                .as_deref(),
            Some("sibling-activation")
        );
        let open = service.open(Some(&workspace)).unwrap();
        let key = DocKey::new("workspace", "main", "document").unwrap();
        drop(service.leases.scoped(&open.root).acquire(&key).unwrap());
        let registered = lock(&service.live_applications).registrations.len();
        assert_eq!(
            service
                .live_application_register(
                    &host_context(&owner),
                    Some(workspace.clone()),
                    json!({"binding": unload_binding("document")}),
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict,
            "the barrier refuses its registration"
        );
        assert_eq!(
            lock(&service.live_applications).registrations.len(),
            registered
        );
        assert_eq!(
            teardown(&service, &owner, &workspace, document).2,
            (1, Some("activation".into()))
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// Sol's round 3a blocker: the relay names the activation it captured
    /// when it registers, so retiring a never-adopted activation ends that
    /// registration too. Its old handle is refused, the activation cannot
    /// register again, and an ordinary registration naming none stays.
    #[tokio::test]
    async fn a_never_adopted_retirement_ends_its_named_registration() {
        let (_scratch, service, owner, workspace, document, sibling) =
            retirement_fixture(false).await;
        let held = |registration| {
            service
                .live_application_registration(&owner.handle(), Some(&workspace), registration)
                .unwrap()
        };
        let (old, ordinary) = (held(document), held(sibling));
        assert_eq!(ordinary.activation_id(), None);
        let output = |registration: &Arc<Registration>| ApplicationOutputGuard {
            activation_id: registration.activation_id(),
            registration: registration.clone(),
            cancel: CancelSignal::new(),
            deadline: None,
            reservation: Mutex::new(Some(Arc::new(()))),
        };
        let (old_output, ordinary_output) = (output(&old), output(&ordinary));
        let identity = || dohc_engine_collab::live_update_application::LiveApplicationAckIdentity {
            delivery_id: "missing".into(),
            update_digest: "00".repeat(32),
        };
        assert_eq!(old.handle.read_ack(identity()).await.unwrap(), None);
        let reconciled = service
            .call(
                host_context(&owner),
                reconcile_request(&workspace, retirement_key("activation")),
            )
            .await
            .unwrap()
            .response
            .result;
        assert_eq!(
            (&reconciled["status"], &reconciled["adoption"]),
            (&json!("reconciled"), &Value::Null)
        );
        assert_eq!(
            teardown(&service, &owner, &workspace, document),
            (false, None, (1, Some("activation".into())), true)
        );
        assert!(old.handle.read_ack(identity()).await.is_err());
        assert!(!old_output.is_current());
        assert_eq!(
            register_document(&service, &owner, &workspace, Some("activation"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), sibling)
                .is_ok()
        );
        assert!(ordinary_output.is_current());
        assert_eq!(ordinary.handle.read_ack(identity()).await.unwrap(), None);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// Opus's round 3a note: a host that reconnects mid-Stop gets a new
    /// native owner. The retired set outlasts the old one, so the
    /// reconnected host still refuses the retired activation.
    #[tokio::test]
    async fn a_reconnected_host_still_refuses_a_retired_activation() {
        let (_scratch, service, owner, workspace, _, _) = retirement_fixture(true).await;
        let reconciled = service
            .call(
                host_context(&owner),
                reconcile_request(&workspace, retirement_key("activation")),
            )
            .await
            .unwrap();
        assert_eq!(reconciled.response.result["status"], "reconciled");
        let reconnected = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        service
            .provision_live_application(
                reconnected.handle(),
                LiveApplicationHostConfig {
                    workspace: workspace.clone(),
                    namespace: "unload-test".into(),
                    coordinate: ApplicationHostCoordinate {
                        host_id: "host".into(),
                        host_epoch: 1,
                        instance_id: "instance".into(),
                        connection_id: "reconnected".into(),
                    },
                    max_registrations: 4,
                },
            )
            .await
            .unwrap();
        assert!(
            lock(&service.live_applications)
                .retired_activations(&workspace)
                .unwrap()
                .contains("activation")
        );
        assert_eq!(
            register_document(&service, &reconnected, &workspace, None)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict,
            "the registration would serve the retired activation"
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// Phase A over RPC evicts the reconciled document's writer cache entry,
    /// and only that one: the next write to it misses, and one to its
    /// sibling still hits. The activation never adopted, so neither document
    /// is an owner's and both take local writes.
    #[tokio::test]
    async fn phase_a_evicts_only_the_reconciled_documents_cache_entry() {
        let (_scratch, service, owner, workspace, _, _) = retirement_fixture(false).await;
        let open = service.open(Some(&workspace)).unwrap();
        let docs = [("document", Ydoc::wire()), ("sibling", Ydoc::wire())];
        let record = |object: &str, update: Vec<u8>| {
            open.actor.ydoc_record_update(
                DocKey::new("workspace", "main", object).unwrap(),
                format!("{object}.md"),
                dohc_engine_collab::ContentKind::Plaintext,
                dohc_engine_collab::Regime::LocalOnly,
                update,
                None,
                None,
                None,
                false,
                None,
                None,
                10,
                Arc::new(NoFaults),
                dohc_engine_runtime::CancellationToken::new(),
                None,
            )
        };
        for (object, doc) in &docs {
            record(object, doc.plaintext_insert(0, "cached"))
                .await
                .unwrap();
        }
        let before = open.actor.ydoc_cache_stats_for_test().await.unwrap();
        let reconciled = service
            .call(
                host_context(&owner),
                reconcile_request(&workspace, retirement_key("activation")),
            )
            .await
            .unwrap();
        assert_eq!(reconciled.response.result["status"], "reconciled");
        let evicted = open.actor.ydoc_cache_stats_for_test().await.unwrap();
        assert_eq!(evicted.removes, before.removes + 1, "one entry went");
        let (_, sibling) = &docs[1];
        record("sibling", sibling.plaintext_insert(0, "warm "))
            .await
            .unwrap();
        assert_eq!(
            open.actor.ydoc_cache_stats_for_test().await.unwrap().misses,
            evicted.misses,
            "the sibling's entry stayed"
        );
        let (_, document) = &docs[0];
        record("document", document.plaintext_insert(0, "cold "))
            .await
            .unwrap();
        assert_eq!(
            open.actor.ydoc_cache_stats_for_test().await.unwrap().misses,
            evicted.misses + 1,
            "the reconciled document's entry went"
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// Phase A ends only the reconciled document's state: another
    /// document's session carrying the same activation tag stays.
    #[tokio::test]
    async fn phase_a_leaves_another_documents_state() {
        let (_scratch, service, owner, workspace, _, sibling) = retirement_fixture(true).await;
        install_session(&service, &workspace, "sibling", "activation");
        let reconciled = service
            .call(
                host_context(&owner),
                reconcile_request(&workspace, retirement_key("activation")),
            )
            .await
            .unwrap();
        assert_eq!(reconciled.response.result["status"], "reconciled");
        assert!(!lock(&service.sessions).contains_key("ydoc-unload-document"));
        assert_eq!(
            lock(&service.sessions)["ydoc-unload-sibling"]
                .activation_id
                .as_deref(),
            Some("activation")
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), sibling)
                .is_ok()
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// A caller that drops a reconciliation once it started still gets its
    /// Phase A and durable pass completed, and a retry, as after a reply
    /// lost past the commit, answers the same.
    #[tokio::test]
    async fn a_dropped_reconciliation_finishes_and_a_retry_answers_the_same() {
        let (_scratch, service, owner, workspace, document, _) = retirement_fixture(true).await;
        let open = service.open(Some(&workspace)).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let actor = open.actor.clone();
        let blocker = tokio::spawn(async move {
            actor
                .ensure_main_version(
                    "reconcile-blocker".into(),
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
        let mut waiting = Box::pin(service.call(
            host_context(&owner),
            reconcile_request(&workspace, retirement_key("activation")),
        ));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        assert!(
            open.session_ops.try_lock().is_err(),
            "it holds the session lock"
        );
        drop(waiting);
        release_tx.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        drop(Arc::clone(&open.session_ops).lock_owned().await);
        assert_eq!(
            teardown(&service, &owner, &workspace, document),
            (false, None, (1, Some("activation".into())), true)
        );
        let mut answers = Vec::new();
        for _ in 0..2 {
            answers.push(
                service
                    .call(
                        host_context(&owner),
                        reconcile_request(&workspace, retirement_key("activation")),
                    )
                    .await
                    .unwrap()
                    .response
                    .result,
            );
        }
        assert_eq!(answers[0]["status"], "reconciled");
        assert_eq!(answers[0], answers[1]);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// N8: an unload names the activation it ends. Naming another, or none,
    /// against state that serves one changes nothing.
    #[tokio::test]
    async fn an_unload_ends_only_the_activation_it_names() {
        for adopted in [false, true] {
            let (_scratch, service, owner, workspace, document, _) =
                retirement_fixture(adopted).await;
            let before = teardown(&service, &owner, &workspace, document);
            for named in [None, Some("successor")] {
                assert_eq!(
                    service
                        .call(
                            host_context(&owner),
                            unload_naming(&workspace, "document", named)
                        )
                        .await
                        .unwrap_err()
                        .code,
                    ErrorCode::Conflict,
                    "{named:?} adopted={adopted}"
                );
                assert_eq!(teardown(&service, &owner, &workspace, document), before);
            }
            let unloaded = service
                .call(
                    host_context(&owner),
                    unload_naming(&workspace, "document", Some("activation")),
                )
                .await
                .unwrap();
            assert_eq!(unloaded.response.result, json!({"status":"unloaded"}));
            let after = teardown(&service, &owner, &workspace, document);
            assert_eq!((after.0, after.1, after.2.0), (false, None, 0));
            service.workspace_close(Some(workspace)).await.unwrap();
        }
    }

    /// N8: an unload queued for a predecessor before its successor took the
    /// document reads the activation only once it holds the session lock,
    /// and cannot end the successor.
    #[tokio::test]
    async fn a_stale_predecessor_unload_cannot_end_its_successor() {
        let (_scratch, service, owner, workspace, document, _) = unload_fixture().await;
        let open = service.open(Some(&workspace)).unwrap();
        let serial = Arc::clone(&open.session_ops).lock_owned().await;
        let mut waiting = Box::pin(service.call(
            host_context(&owner),
            unload_naming(&workspace, "document", Some("activation")),
        ));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(waiting.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        // The successor's capture takes the session while the unload waits.
        lock(&service.sessions)
            .get_mut("ydoc-unload-document")
            .unwrap()
            .activation_id = Some("successor".into());
        let before = teardown(&service, &owner, &workspace, document);
        drop(serial);
        assert_eq!(waiting.await.unwrap_err().code, ErrorCode::Conflict);
        assert_eq!(teardown(&service, &owner, &workspace, document), before);
        assert_eq!(before.1, Some(Some("successor".into())));
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    fn cancel_fence_request(workspace: &WorkspaceHandle, params: Value) -> Request {
        Request {
            id: 98,
            method: "liveApplication.cancelRestoreFence".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params,
        }
    }

    /// Only the current host cancels a restore fence, and it fixes the
    /// namespace and workspace: a param naming either refuses, and so does a
    /// fence another host holds. A fence that never landed answers cancelled
    /// at the generation before it, on replay too. One that committed ends
    /// only while its document still holds what the fence left.
    #[tokio::test]
    async fn a_restore_fence_cancellation_names_the_generation_the_relay_keeps() {
        use dohc_engine_collab::live_update_application::{
            NativeRestoreFence, NativeRestoreFenceReceipt, RestoreDeliveryOrigin,
        };
        let (_scratch, service, owner, workspace, _, _) = unload_fixture().await;
        let params = json!({"operationId":"restore","objectId":"document","lineageClaimId":lineage(),"hostId":"host","newFence":1});
        let mut unnamed = params.clone();
        unnamed.as_object_mut().unwrap().remove("hostId");
        assert_eq!(
            service
                .call(
                    host_context(&owner),
                    cancel_fence_request(&workspace, unnamed)
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams
        );
        let mut elsewhere = params.clone();
        elsewhere["hostId"] = json!("elsewhere");
        assert_eq!(
            service
                .call(
                    host_context(&owner),
                    cancel_fence_request(&workspace, elsewhere)
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let stranger = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        assert_eq!(
            service
                .call(
                    host_context(&stranger),
                    cancel_fence_request(&workspace, params.clone())
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceUnavailable
        );
        for (field, value) in [
            ("relayDatabaseNamespace", "unload-test"),
            ("workspaceId", "workspace"),
        ] {
            let mut named = params.clone();
            named[field] = json!(value);
            assert_eq!(
                service
                    .call(
                        host_context(&owner),
                        cancel_fence_request(&workspace, named)
                    )
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidParams,
                "{field}"
            );
        }
        let cancelled = json!({"status":"cancelled","hostId":"host","generation":0,
            "binding":unload_binding("document")});
        for _ in 0..2 {
            let answered = service
                .call(
                    host_context(&owner),
                    cancel_fence_request(&workspace, params.clone()),
                )
                .await
                .unwrap();
            assert_eq!(answered.response.result, cancelled);
        }
        let mut wrong = params.clone();
        wrong["newFence"] = json!(2);
        assert_eq!(
            service
                .call(
                    host_context(&owner),
                    cancel_fence_request(&workspace, wrong)
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        // A fence of the sibling that committed before its reply was lost.
        let fence = NativeRestoreFence {
            operation_id: "fenced".into(),
            relay_database_namespace: "unload-test".into(),
            old_binding: unload_binding("sibling"),
            host_id: "host".into(),
            new_fence: 1,
            origin: RestoreDeliveryOrigin::Owner {
                id: "activation".into(),
            },
            terminal: None,
            applied_sequence: 0,
        };
        let receipt = NativeRestoreFenceReceipt {
            operation: fence.clone(),
            local_head_sequence: 0,
            recorded_at_ms: 1,
        };
        shape(
            &service,
            &workspace,
            &format!(
                "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,
                   operation_id,input_json,receipt_json) VALUES ('workspace','main','sibling','unload-test','fenced','{}','{}')",
                serde_json::to_string(&fence).unwrap(),
                serde_json::to_string(&receipt).unwrap()
            ),
        );
        // The sibling still holds its live binding at generation 0, not the
        // stopped one the fence left, so nothing proves the fence's terminal
        // binding: the cancellation refuses and records nothing.
        let fenced = json!({"operationId":"fenced","objectId":"sibling","lineageClaimId":lineage(),"hostId":"host","newFence":1});
        assert_eq!(
            service
                .call(
                    host_context(&owner),
                    cancel_fence_request(&workspace, fenced)
                )
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let open = service.open(Some(&workspace)).unwrap();
        let recorded: bool = rusqlite::Connection::open(open.actor.database_path())
            .unwrap()
            .query_row(
                "SELECT cancelled_json IS NOT NULL FROM live_restore_fences WHERE operation_id='fenced'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!recorded);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// The boundary a release of the fixture's adopted activation stores:
    /// its adopted origin, with nothing applied after it.
    const RELEASED_BOUNDARY: &str = r#"{"terminalReceipt":null,"eventCount":0,"historyEvidenceDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}"#;

    fn release_request(workspace: &WorkspaceHandle, activation: &str) -> Request {
        Request {
            id: 97,
            method: "liveApplication.releaseActivation".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({"objectId":"document","lineageClaimId":lineage(),"activationId":activation,
                "restoreFenceGeneration":0,"acceptedThrough":5}),
        }
    }

    /// The document as the hosted replica holds it: departed from its scope
    /// or not, and parked or not.
    fn host_document(
        service: &EngineService,
        workspace: &WorkspaceHandle,
        departed: bool,
        parked: bool,
    ) {
        shape(
            service,
            workspace,
            &format!(
                "INSERT OR IGNORE INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms)
                   VALUES ('workspace','origin','epoch','stream',0);
                 INSERT OR IGNORE INTO hosted_replicas(workspace_id,scope_generation,created_at_ms) VALUES ('workspace',1,0);
                 INSERT OR REPLACE INTO hosted_documents(workspace_id,object_id,path,state,scope_generation)
                   VALUES ('workspace','document','document.md','{}',{})",
                if parked { "parked" } else { "ready" },
                if departed { 0 } else { 1 }
            ),
        );
    }

    fn rows(service: &EngineService, workspace: &WorkspaceHandle, table: &str) -> i64 {
        let open = service.open(Some(workspace)).unwrap();
        let store =
            dohc_engine_storage::EngineStore::open_read_only(open.actor.database_path()).unwrap();
        store
            .read_with(|conn| {
                conn.query_row(
                    &format!("SELECT count(*) FROM {table} WHERE object_id='document'"),
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap()
    }

    fn bindings(service: &EngineService, workspace: &WorkspaceHandle) -> i64 {
        rows(service, workspace, "live_device_application_bindings")
    }

    /// The document's recorded retirement intents.
    fn intents(service: &EngineService, workspace: &WorkspaceHandle) -> i64 {
        rows(service, workspace, "live_owner_retirements")
    }

    /// Release is only for the configured host, and only for a document that
    /// left the scope: until then it tears nothing down. An adopted activation
    /// then ends its runtime and waits to park, releases, and answers a
    /// duplicate from its stored release. After a reconnect, nothing registers
    /// for it, named or not.
    #[tokio::test]
    async fn an_adopted_release_waits_to_park_and_answers_its_replay() {
        let (_scratch, service, owner, workspace, document, _) = retirement_fixture(true).await;
        // The lineage's root adoption, which the adopted activation names.
        let (claim, binding) = (
            lineage(),
            serde_json::to_string(&unload_binding("document")).unwrap(),
        );
        shape(
            &service,
            &workspace,
            &format!(
                "INSERT INTO live_owner_adoptions VALUES ('unload-test','activation','workspace','main','document',
                    '{claim}','{binding}','moment','{claim}',0,0,0,'{claim}','{claim}',0,0,0,'null','{{}}',1,1)"
            ),
        );
        let before = teardown(&service, &owner, &workspace, document);
        let stranger = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        let release = |ctx| service.call(ctx, release_request(&workspace, "activation"));
        assert_eq!(
            release(host_context(&stranger)).await.unwrap_err().code,
            ErrorCode::SessionExpired
        );
        assert_eq!(
            release(host_context(&owner)).await.unwrap_err().code,
            ErrorCode::Conflict,
            "not hosted"
        );
        host_document(&service, &workspace, false, false);
        assert_eq!(
            release(host_context(&owner)).await.unwrap_err().code,
            ErrorCode::Conflict,
            "in scope"
        );
        assert_eq!(teardown(&service, &owner, &workspace, document), before);
        assert_eq!(
            intents(&service, &workspace),
            0,
            "a refused key records nothing"
        );
        host_document(&service, &workspace, true, false);
        assert_eq!(
            release(host_context(&owner)).await.unwrap().response.result,
            json!({"status":"pending","reason":"parking"})
        );
        assert_eq!(
            teardown(&service, &owner, &workspace, document),
            (false, None, before.2.clone(), true),
            "Phase A ended its runtime and kept its binding"
        );
        assert_eq!(intents(&service, &workspace), 1, "its intent was recorded");
        host_document(&service, &workspace, true, true);
        shape(
            &service,
            &workspace,
            &format!(
                "INSERT INTO live_accepted_checkpoints VALUES ('unload-test','workspace','main','document','{0}',0,0,
                    'null','{{}}','{0}','{0}','{1}',NULL,NULL)",
                lineage(),
                "e".repeat(64)
            ),
        );
        let boundary: Value = serde_json::from_str(RELEASED_BOUNDARY).unwrap();
        assert_eq!(
            release(host_context(&owner)).await.unwrap().response.result,
            json!({"status":"released","replayed":false,"boundary":boundary})
        );
        assert_eq!(bindings(&service, &workspace), 0, "its own binding goes");
        assert_eq!(intents(&service, &workspace), 0, "and so does its intent");
        assert_eq!(
            release(host_context(&owner)).await.unwrap().response.result,
            json!({"status":"released","replayed":true,"boundary":boundary})
        );
        let reconnected = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        service
            .provision_live_application(
                reconnected.handle(),
                LiveApplicationHostConfig {
                    workspace: workspace.clone(),
                    namespace: "unload-test".into(),
                    coordinate: ApplicationHostCoordinate {
                        host_id: "host".into(),
                        host_epoch: 1,
                        instance_id: "instance".into(),
                        connection_id: "reconnected".into(),
                    },
                    max_registrations: 4,
                },
            )
            .await
            .unwrap();
        // Only the configured connection names an activation; the collab
        // tests cover a named registration after a restart.
        host_document(&service, &workspace, true, false);
        assert_eq!(
            register_document(&service, &reconnected, &workspace, None)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// A never-adopted source releases once its document left the scope,
    /// before parking, ending its named binding; it never registers again.
    #[tokio::test]
    async fn a_never_adopted_release_ends_its_binding_before_parking() {
        let (_scratch, service, owner, workspace, document, _) = retirement_fixture(false).await;
        host_document(&service, &workspace, true, false);
        let released = service
            .call(
                host_context(&owner),
                release_request(&workspace, "activation"),
            )
            .await
            .unwrap()
            .response
            .result;
        assert_eq!(
            released,
            json!({"status":"released","replayed":false,"boundary":null})
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), document)
                .is_err()
        );
        assert_eq!(bindings(&service, &workspace), 0);
        assert_eq!(
            register_document(&service, &owner, &workspace, Some("activation"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// The retirement form of settle names a retirement instead of a
    /// registration, never both, only for the configured host. An invalid
    /// key tears nothing down, and no form opens a session.
    #[tokio::test]
    async fn the_retirement_form_of_settle_needs_no_registration() {
        let (_scratch, service, owner, workspace, document, _) = retirement_fixture(true).await;
        let before = teardown(&service, &owner, &workspace, document);
        let sessions = lock(&service.sessions).len();
        let settle = |params: Value| Request {
            id: 95,
            method: "liveApplication.settle".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: Some(30_000),
            idempotency_key: None,
            progress: false,
            params,
        };
        let key = |activation: &str| {
            json!({"objectId":"document","lineageClaimId":lineage(),"activationId":activation,
                "restoreFenceGeneration":0,"acceptedThrough":5})
        };
        let stranger = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        for (ctx, params, code) in [
            (
                host_context(&owner),
                json!({"registrationId":document,"retirement":key("activation"),"terminalReceipt":null}),
                ErrorCode::InvalidParams,
            ),
            (
                host_context(&owner),
                json!({"terminalReceipt":null}),
                ErrorCode::InvalidParams,
            ),
            (
                host_context(&stranger),
                json!({"retirement":key("activation"),"terminalReceipt":null}),
                ErrorCode::SessionExpired,
            ),
            (
                host_context(&owner),
                json!({"retirement":key("unknown"),"terminalReceipt":null}),
                ErrorCode::Conflict,
            ),
        ] {
            assert_eq!(
                service
                    .call(ctx, settle(params.clone()))
                    .await
                    .unwrap_err()
                    .code,
                code,
                "{params}"
            );
            assert_eq!(
                teardown(&service, &owner, &workspace, document),
                before,
                "{params}"
            );
        }
        // A valid key runs Phase A first; this fixture has no Y.Doc to settle.
        assert!(
            service
                .call(
                    host_context(&owner),
                    settle(json!({"retirement":key("activation"),"terminalReceipt":null}))
                )
                .await
                .is_err()
        );
        assert_eq!(
            teardown(&service, &owner, &workspace, document),
            (false, None, before.2, true)
        );
        assert!(
            lock(&service.sessions).len() < sessions,
            "it ended the activation's session and opened none"
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    /// An ordinary registration serves no activation, so its unload names none.
    #[tokio::test]
    async fn an_ordinary_unload_names_no_activation() {
        let (_scratch, service, owner, workspace, document, sibling) = unload_fixture().await;
        let unloaded = service
            .call(
                host_context(&owner),
                unload_naming(&workspace, "sibling", None),
            )
            .await
            .unwrap();
        assert_eq!(unloaded.response.result, json!({"status":"unloaded"}));
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), sibling)
                .is_err()
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&workspace), document)
                .is_ok()
        );
        service.workspace_close(Some(workspace)).await.unwrap();
    }
}
