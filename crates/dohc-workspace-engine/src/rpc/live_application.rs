use super::error::{map_runtime, workspace_unavailable};
use super::workspace::{OpenWorkspace, WorkspaceOpenMode};
use crate::{EngineService, lock};
use dohc_engine_collab::DocKey;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, ApplicationHostCoordinate, ApplicationResult, BootstrapResult,
    LiveApplicationBootstrap, NativeRestoreFence, UnloadPending,
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

fn forwarded_owner_consent(
    sessions: &Mutex<HashMap<String, super::ydoc::YdocSession>>,
    workspace: Option<&WorkspaceHandle>, binding: &LiveObjectBinding, session_id: Option<&str>,
) -> Option<Arc<dohc_engine_collab::markdown_write_safety::MarkdownConversionConsent>> {
    lock(sessions).get(session_id?).filter(|session| {
        workspace == Some(&session.workspace)
            && session.key.workspace_id == binding.workspace_id
            && session.key.version_id == binding.main_version_id
            && session.key.object_id == binding.object_id
            && session.lineage_claim_id.as_deref() == Some(binding.lineage_claim_id.as_str())
            && session.restore_generation.unwrap_or(0) == binding.restore_fence_generation
    }).and_then(|session| session.conversion_consent.clone())
        .filter(|consent| !consent.is_consumed())
}

#[cfg(test)]
#[path = "markdown_owner_consent_tests.rs"]
mod markdown_owner_consent_tests;

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
}

pub(crate) struct Registration {
    host: Arc<Host>,
    handle: ActorLiveApplicationHandle,
    object_id: String,
    binding: LiveObjectBinding,
    retired: CancelSignal,
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

#[derive(Debug)]
struct RestoreFenceOutputGuard {
    host: Arc<Host>,
    cancel: CancelSignal,
    deadline: Option<Instant>,
}

impl OutputGuard for RestoreFenceOutputGuard {
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
        self.registration
            .host
            .current(&self.registration.host.connection)
            && !self.registration.retired.is_cancelled()
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

/// The binding's queue: its ID, pending bytes, state and granted Try again.
type OwnerOutboxRow = (String, i64, String, Option<String>);

fn read_owner_outbox(
    conn: &rusqlite::Connection,
    binding: &LiveObjectBinding,
) -> Result<Option<OwnerOutboxRow>, dohc_engine_storage::StorageError> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT outbox_id,pending_bytes,state,retry_delivery_id FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5",
        rusqlite::params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.restore_fence_generation],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .optional()
    .map_err(dohc_engine_storage::StorageError::persist_public)
}

impl EngineService {
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
                let prior: Option<(String,i64,i64)> = conn.query_row("SELECT adoption_id,local_ydoc_sequence,terminal_cursor FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5",
                    rusqlite::params![registration.host.namespace,b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(dohc_engine_storage::StorageError::persist_public)?;
                let (outbox_id,pending_bytes,outbox_state,retry_delivery_id) = read_owner_outbox(conn,b)?.map_or((None,0,None,None),|(id,bytes,state,retry)|(Some(id),bytes,Some(state),retry));
                if let Some((id,sequence,cursor)) = prior { return Ok(json!({"adoptionId":id,"expectedLocalSequence":sequence,"throughCursor":cursor,"outboxId":outbox_id,"pendingBytes":pending_bytes,"outboxState":outbox_state,"retryDeliveryId":retry_delivery_id})); }
                let sequence: i64 = conn.query_row("SELECT head_update_seq FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",rusqlite::params![b.workspace_id,b.main_version_id,b.object_id,b.lineage_claim_id],|r|r.get(0)).map_err(dohc_engine_storage::StorageError::persist_public)?;
                let identity = serde_json::to_vec(&(&registration.host.namespace,&b.workspace_id,&b.main_version_id,&b.object_id,&b.lineage_claim_id)).map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok(json!({"adoptionId":format!("owner-adoption-{}",dohc_engine_storage::hex_sha256(&identity)),"expectedLocalSequence":sequence,"throughCursor":Value::Null,"outboxId":outbox_id,"pendingBytes":pending_bytes,"outboxState":outbox_state,"retryDeliveryId":retry_delivery_id}))
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
        let guard = Arc::new(ApplicationOutputGuard {
            registration: registration.clone(),
            cancel: ctx.cancel,
            deadline: ctx.deadline,
            reservation: Mutex::new(Some(reservation.clone())),
        });
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
        Ok(ServiceResponse {
            response: Response {
                id: request_id,
                result: json!({"status":"adopted","adoption":result}),
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }
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
            #[serde(default)]
            owner_session_id: Option<String>,
        }
        if request.idempotency_key.is_some() || request.params.get("terminalReceipt").is_none() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-live-settlement",
            ));
        }
        require_caller_deadline(&request)?;
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
        let conversion_consent = forwarded_owner_consent(&self.sessions, request.workspace.as_ref(),
            &registration.binding, params.owner_session_id.as_deref());
        let (max_applications, reconstruction) = self.configured_settlement_admission(&ctx)?;
        let now_ms = super::request::now_ms()?;
        let token = cancellation.token();
        let guard = Arc::new(ApplicationOutputGuard {
            registration: registration.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            reservation: Mutex::new(Some(reconstruction.reservation.clone())),
        });
        let mut retirement = RetireOnCancellation(Some(host));
        let sessions = self.sessions.clone();
        let events = self.events.clone();
        let workspace = request.workspace.clone();
        let operation = tokio::spawn(async move {
            let _serial = serial;
            let result = registration
                .handle
                .settle_with_consent(
                    params.terminal_receipt,
                    max_applications,
                    registration.host.open.root.clone(),
                    now_ms,
                    Arc::new(NoFaults),
                    token,
                    reconstruction,
                    conversion_consent,
                )
                .await;
            if result.is_ok() {
                let binding = &registration.binding;
                for (id, session) in lock(&sessions).iter() {
                    if workspace.as_ref() == Some(&session.workspace)
                        && session.key.workspace_id == binding.workspace_id
                        && session.key.version_id == binding.main_version_id
                        && session.key.object_id == binding.object_id
                        && session.path == binding.current_path
                        && session.lineage_claim_id.as_deref() == Some(binding.lineage_claim_id.as_str()) {
                        events.emit("ydoc.remoteUpdate", json!({"sessionId":id,"resyncRequired":true}));
                    }
                }
            }
            result
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
        // The fence keeps the checkpoints of the binding it stops.
        let permit = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("native restore fence (queued)"));
            }
            permit = self.reconstruction_permit() => permit,
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
        let guard = Arc::new(RestoreFenceOutputGuard {
            host: host.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
        });
        let mut retirement = RetireOnCancellation(Some(host.clone()));
        let worker_host = host.clone();
        let operation = tokio::spawn(async move {
            let (_serial, _permit) = (serial, permit);
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
            // Nothing committed. The host publishes ordinary work, or waits for
            // a deferred update's dependency, and asks again.
            Err(dohc_engine_runtime::RuntimeError::LiveApplication(
                pending @ (dohc_engine_collab::live_update_application::ApplicationError::PublicationPending
                | dohc_engine_collab::live_update_application::ApplicationError::AcceptedStateIncomplete),
            )) => {
                let reason = match pending {
                    dohc_engine_collab::live_update_application::ApplicationError::PublicationPending => {
                        "publication-pending"
                    }
                    _ => "accepted-state-incomplete",
                };
                return Ok(ServiceResponse {
                    response: Response {
                        id: request.id,
                        result: json!({"status":"pending", "reason":reason}),
                    },
                    blob_egress: None,
                    output_guard: Some(guard),
                });
            }
            Err(dohc_engine_runtime::RuntimeError::LiveApplication(
                dohc_engine_collab::live_update_application::ApplicationError::RestoreRefused(
                    refusal,
                ),
            )) => {
                return Ok(ServiceResponse {
                    response: Response {
                        id: request.id,
                        result: json!({"status":"refused", "refusal":refusal}),
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
            .validate_binding(params.binding.clone())
            .await
            .map_err(map_runtime)?;
        if !host.current(connection) || !Arc::ptr_eq(&self.open(Some(&workspace))?, &host.open) {
            return Err(workspace_unavailable());
        }
        // A registration that moves a document keeps the checkpoints of the
        // binding it leaves.
        let permit = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("live registration (queued)"));
            }
            permit = self.reconstruction_permit() => permit,
        };
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
        let worker_host = host.clone();
        let handle = tokio::spawn(async move {
            let _permit = permit;
            worker_host
                .owner
                .register(
                    worker_host.namespace.clone(),
                    worker_host.coordinate.clone(),
                    params.binding,
                )
                .await
        })
        .await
        .map_err(|_| WireError::new(ErrorCode::Internal, "live-application-interrupted"))?
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
        }
        self.configured_host_caller(ctx)?;
        let params: Params = serde_json::from_value(params)
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-live-unload"))?;
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
        let mut keys: Vec<DocKey> = lock(&self.sessions)
            .values()
            .filter(|session| session.workspace == workspace && session.key.object_id == object_id)
            .map(|session| session.key.clone())
            .collect();
        for registration in lock(&self.live_applications).registrations.values() {
            if Arc::ptr_eq(&registration.host, &host) && registration.object_id == object_id {
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
            let pending = task_host
                .owner
                .unload(object_id.clone(), keys, root, now_ms)
                .await?;
            if pending.is_none() {
                {
                    let mut registry = lock(&registry);
                    let _fence = lock(&task_host.output_fence);
                    registry.registrations.retain(|_, registration| {
                        if Arc::ptr_eq(&registration.host, &task_host)
                            && registration.object_id == object_id
                        {
                            registration.retired.cancel();
                            false
                        } else {
                            true
                        }
                    });
                }
                lock(&sessions).retain(|_, session| {
                    session.workspace != workspace || session.key.object_id != object_id
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
            registration: input.registration.clone(),
            cancel: ctx.cancel,
            deadline: ctx.deadline,
            reservation: Mutex::new(Some(input.reservation.clone())),
        });
        // Keep the workspace fence until the writer is terminal if the RPC is cancelled.
        let mut retirement = RetireOnCancellation(Some(host.clone()));
        let claim_events = self.events.clone();
        let claim_workspace = host.open.workspace_id.clone();
        let max_applications = self.configured_settlement_limit();
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
                        max_applications,
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
            params: json!({"operation":{"point":{"journalCursor":0,"receiptDigest":binding.lineage_claim_id},"operationId":"restore-rpc","relayDatabaseNamespace":namespace,"oldBinding":binding,"hostId":"host","newFence":binding.restore_fence_generation+1,"origin":{"kind":"bootstrap","id":"bootstrap"},"terminal":null,"appliedSequence":0}}),
        }
    }

    #[tokio::test]
    async fn fence_returns_an_identified_pre_write_refusal_for_a_changed_binding() {
        let (_scratch, service, owner, workspace, _registration, binding) = fixture().await;
        let workspace = WorkspaceHandle(workspace);
        let open = service.open(Some(&workspace)).unwrap();
        let mut store =
            dohc_engine_storage::EngineStore::open(open.actor.database_path(), 0).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE live_device_application_bindings SET available=0",
                    [],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })
            .unwrap();
        let request = fence_request(&workspace, &binding, "relay-history");
        let expected = json!({"status":"refused", "refusal":{
            "operation":request.params["operation"], "reason":"binding-changed"
        }});
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let result = service.call(ctx, request).await.unwrap();
        assert_eq!(result.response.result, expected);
        assert!(result.output_guard.as_ref().unwrap().is_current());
        assert_eq!(store.table_row_count("live_restore_fences").unwrap(), 0);
        service.workspace_close(Some(workspace)).await.unwrap();
    }

    #[tokio::test]
    async fn owner_state_reads_only_the_registered_restore_generation() {
        use dohc_engine_storage::{EngineStore, StorageError};
        let (_scratch, service, _owner, workspace, _registration, mut binding) = fixture().await;
        let open = service.open(Some(&WorkspaceHandle(workspace))).unwrap();
        let mut store = EngineStore::open(open.actor.database_path(), 0).unwrap();
        store.write_with(&NoFaults, |tx| {
            for (id, generation, state, reason, bytes) in [
                ("old", 0, "quarantined", Some("restore-fenced"), 64),
                ("current", 1, "active", None, 61),
            ] {
                tx.execute(
                    "INSERT INTO owner_ydoc_outboxes(outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,oldest_entry_at_ms,next_sequence,quarantine_reason,created_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?5,?5,2,?9,?10,0,2,?11,0)",
                    rusqlite::params![id,binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.current_path,serde_json::to_string(&binding.selector_paths).unwrap(),generation,state,bytes,reason],
                ).unwrap();
            }
            Ok::<_, StorageError>(())
        }).unwrap();
        store
            .read_with(|conn| {
                assert_eq!(
                    read_owner_outbox(conn, &binding)?,
                    Some(("old".into(), 64, "quarantined".into(), None))
                );
                binding.restore_fence_generation = 1;
                assert_eq!(
                    read_owner_outbox(conn, &binding)?,
                    Some(("current".into(), 61, "active".into(), None))
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
        let guard = RestoreFenceOutputGuard {
            host: host.clone(),
            cancel: RequestContext::unbounded().cancel,
            deadline: None,
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
    async fn a_registration_waits_while_another_workspaces_rebuild_holds_the_permit() {
        let roots = [
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
        ];
        let configuration = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "permit-test",
            "host": {"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": [
                {"root":roots[0].path(),"workspaceId":"first","maxRegistrations":4},
                {"root":roots[1].path(),"workspaceId":"second","maxRegistrations":4}
            ],
            "ingress": {"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":1,"uploadDeadlineMs":30_000},
            "settlement": {"maxApplicationsPerSettlement":4}
        })).unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(configuration)
            .await
            .unwrap();
        let handle = |workspace_id: &str| {
            lock(&service.handles)
                .iter()
                .find(|(_, open)| open.workspace_id == workspace_id)
                .unwrap()
                .0
                .clone()
        };
        let (first, second) = (handle("first"), handle("second"));
        let mut bindings = Vec::new();
        for workspace in [&first, &second] {
            let open = service.open(Some(workspace)).unwrap();
            open.actor
                .ensure_main_version(
                    open.workspace_id.clone(),
                    0,
                    Arc::new(NoFaults),
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await
                .unwrap();
            bindings.push(LiveObjectBinding {
                workspace_id: open.workspace_id.clone(),
                main_version_id: "main".into(),
                object_id: "document".into(),
                lineage_claim_id: hex_sha256(&fixture_baseline().0),
                current_path: "document.md".into(),
                selector_paths: vec!["document.md".into()],
                restore_fence_generation: 0,
            });
        }
        // The second workspace's fence takes the permit and waits for its writer.
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let actor = service.open(Some(&second)).unwrap().actor.clone();
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
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let mut fencing = Box::pin(service.call(
            ctx.clone(),
            fence_request(&second, &bindings[1], "permit-test"),
        ));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(fencing.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        assert_eq!(service.reconstructions.available_permits(), 0);
        let mut registering = tokio::spawn({
            let (service, workspace) = (service.clone(), first.clone());
            let binding = bindings[0].clone();
            async move {
                service
                    .live_application_register(&ctx, Some(workspace), json!({"binding": binding}))
                    .await
            }
        });
        tokio::select! {
            () = service.reconstruction_waits.notified() => {}
            registered = &mut registering => {
                panic!("a registration ran while another workspace's rebuild held the permit: {registered:?}")
            }
        }
        assert!(!registering.is_finished());
        release_tx.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        let _ = fencing.await;
        registering
            .await
            .unwrap()
            .expect("the registration runs once the rebuild ends");
        assert_eq!(service.reconstructions.available_permits(), 1);
        for workspace in [first, second] {
            service.workspace_close(Some(workspace)).await.unwrap();
        }
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
            "ingress": {"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":1,"uploadDeadlineMs":30_000}
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
        let key = DocKey::new("workspace", "main", "document").unwrap();
        let lineage = hex_sha256(&Ydoc::wire().encode_full_state());
        let captured = dohc_engine_collab::live_update_application::ImportedOwnerActivation {
            activation_id: "activation".into(),
            source: dohc_engine_collab::live_update_application::ImportedOwnerSource {
                version: 1,
                reader_source: false,
                relay_database_namespace: "unload-test".into(),
                workspace_id: "workspace".into(),
                main_version_id: "main".into(),
                object_id: "document".into(),
                lineage_claim_id: lineage.clone(),
                current_path: "document.md".into(),
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
            },
            baseline_bytes: Vec::new(),
            full_state: Vec::new(),
            restore_generation: None,
        };
        let lease = service.leases.scoped(&open.root).acquire(&key).unwrap();
        let session = super::super::ydoc::YdocSession::imported_owner(
            workspace.clone(),
            key,
            &captured,
            lease,
        )
        .unwrap();
        lock(&service.sessions).insert("ydoc-unload-document".into(), session);
        (
            scratch,
            service,
            owner,
            workspace,
            registrations[0],
            registrations[1],
        )
    }

    fn unload_request(workspace: &WorkspaceHandle, object_id: &str) -> Request {
        Request {
            id: 96,
            method: "liveApplication.unloadDocument".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({"objectId": object_id}),
        }
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
}
