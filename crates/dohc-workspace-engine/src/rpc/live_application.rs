use super::error::{map_runtime, workspace_unavailable};
use super::workspace::{OpenWorkspace, WorkspaceOpenMode};
use crate::{EngineService, lock};
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    AdmittedLiveUpdate, ApplicationHostCoordinate, ApplicationResult, BootstrapResult,
    LiveApplicationBootstrap, NativeRestoreFence,
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
#[derive(Clone)]
pub enum LiveApplicationInput {
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
    fn is_current(&self) -> bool {
        self.host.current(&self.host.connection)
            && !self.cancel.is_cancelled()
            && self
                .deadline
                .is_none_or(|deadline| Instant::now() < deadline)
    }
    fn with_current(&self, action: &mut dyn FnMut()) -> bool {
        let _fence = lock(&self.host.output_fence);
        if !self.is_current() {
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

fn map_application_read(error: dohc_engine_runtime::RuntimeError) -> WireError {
    match error {
        dohc_engine_runtime::RuntimeError::LiveApplication(
            dohc_engine_collab::live_update_application::ApplicationError::Interrupted,
        ) => workspace_unavailable(),
        other => map_runtime(other),
    }
}

fn read_owner_outbox(
    conn: &rusqlite::Connection,
    binding: &LiveObjectBinding,
) -> Result<Option<(String, i64, String)>, dohc_engine_storage::StorageError> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT outbox_id,pending_bytes,state FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3 AND lineage_claim_id=?4 AND restore_fence_generation=?5",
        rusqlite::params![binding.workspace_id,binding.main_version_id,binding.object_id,binding.lineage_claim_id,binding.restore_fence_generation],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
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
            _reservation: Arc::new(()),
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
            let store = dohc_engine_storage::EngineStore::open_read_only(&open.db_path)
                .map_err(|_| workspace_unavailable())?;
            let state = store.read_with(|conn| -> Result<Value,dohc_engine_storage::StorageError> {
                use rusqlite::OptionalExtension;
                let prior: Option<(String,i64,i64)> = conn.query_row("SELECT adoption_id,local_ydoc_sequence,terminal_cursor FROM live_owner_adoptions WHERE relay_database_namespace=?1 AND workspace_id=?2 AND main_version_id=?3 AND object_id=?4 AND lineage_claim_id=?5",
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
        let guard = Arc::new(ApplicationOutputGuard {
            registration: registration.clone(),
            cancel: ctx.cancel,
            deadline: ctx.deadline,
            _reservation: reservation.clone(),
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
            outcome = operation => outcome,
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("live settlement"));
            }
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
        let guard = Arc::new(RestoreFenceOutputGuard {
            host: host.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
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
        let outcome = tokio::select! {
            biased;
            outcome = operation => outcome,
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("native restore fence"));
            }
        };
        retirement.0 = None;
        let receipt = outcome
            .map_err(|_| WireError::new(ErrorCode::Internal, "live-application-interrupted"))?
            .map_err(map_runtime)?;
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
        check_interruption()?;
        if !guard.is_current() {
            check_interruption()?;
            return Err(workspace_unavailable());
        }
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
        let binding = params.binding.clone();
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

    fn fence_request(
        workspace: &WorkspaceHandle,
        binding: &LiveObjectBinding,
        namespace: &str,
    ) -> Request {
        Request {
            id: 81,
            method: "liveApplication.fenceRestore".into(),
            workspace: Some(workspace.clone()),
            deadline_ms: None,
            idempotency_key: None,
            params: json!({"operation":{"operationId":"restore-rpc","relayDatabaseNamespace":namespace,"oldBinding":binding,"hostId":"host","newFence":binding.restore_fence_generation+1,"origin":{"kind":"bootstrap","id":"bootstrap"},"terminal":null,"appliedSequence":0}}),
        }
    }

    #[tokio::test]
    async fn owner_state_reads_only_the_registered_restore_generation() {
        use dohc_engine_storage::{EngineStore, StorageError};
        let (_scratch, service, _owner, workspace, _registration, mut binding) = fixture().await;
        let open = service.open(Some(&WorkspaceHandle(workspace))).unwrap();
        let mut store = EngineStore::open(&open.db_path, 0).unwrap();
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
                    Some(("old".into(), 64, "quarantined".into()))
                );
                binding.restore_fence_generation = 1;
                assert_eq!(
                    read_owner_outbox(conn, &binding)?,
                    Some(("current".into(), 61, "active".into()))
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
        let (apply_request, input) = ingress.chunk(2, true, &[]).unwrap().unwrap();
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
            deadline_ms: None, idempotency_key: None, params: json!({"registrationId":registration,"deliveryId":"missing","updateDigest":"00".repeat(32)}) }));
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
            deadline_ms: None, idempotency_key: None, params: json!({"registrationId":registration,"deliveryId":"missing","updateDigest":"00".repeat(32)}) }).await;
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
        let request = if restore_fence {
            fence_request(&workspace, &binding, "cancel-test")
        } else {
            Request {
                id: 72,
                method: "liveApplication.settle".into(),
                workspace: Some(workspace.clone()),
                deadline_ms: None,
                idempotency_key: None,
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
            restore_fence || reservation_held,
            "actor work must retain its admission charge after RPC cancellation"
        );
        assert!(
            host_retired,
            "cancelled submitted work must retire the host before a retry"
        );
    }

    #[tokio::test]
    async fn settle_actor_cancel_keeps_exclusion_and_reservation_until_completion() {
        actor_interruption(false, false).await;
    }

    #[tokio::test]
    async fn fence_actor_cancel_keeps_exclusion_until_completion() {
        actor_interruption(false, true).await;
    }

    #[tokio::test]
    async fn fence_actor_deadline_keeps_exclusion_until_completion() {
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
        let bootstrap = if restore_fence {
            let mut upload = LiveApplicationIngress::new(service.clone(), config()).unwrap();
            upload.begin(Request {
                id: 73,
                method: "liveApplication.bootstrap".into(),
                workspace: Some(workspace.clone()),
                deadline_ms: None,
                idempotency_key: None,
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
            let (request, input) = upload.chunk(1, true, &baseline).unwrap().unwrap();
            let mut bootstrap_ctx = RequestContext::unbounded();
            bootstrap_ctx.connection = Some(owner.handle());
            let response = service
                .call_with_input(bootstrap_ctx, request, Some(input))
                .await
                .unwrap();
            assert_eq!(response.response.result["status"], "bootstrapped");
            assert!(response.output_guard.as_ref().unwrap().is_current());
            Some(response)
        } else {
            None
        };
        let cancel = ctx.cancel.clone();
        let request = if restore_fence {
            fence_request(&workspace, &binding, "completion-test")
        } else {
            Request {
                id: 74,
                method: "liveApplication.settle".into(),
                workspace: Some(workspace.clone()),
                deadline_ms: None,
                idempotency_key: None,
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
        // RPC unpolled until that operation finishes, then make cancellation ready.
        let serial =
            tokio::time::timeout(std::time::Duration::from_secs(5), open.session_ops.lock())
                .await
                .unwrap();
        drop(serial);
        let completed_wakes = wakes.0.load(Ordering::SeqCst);
        cancel.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while wakes.0.load(Ordering::SeqCst) == completed_wakes {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the cancellation bridge wakes the unpolled settlement RPC");
        assert_eq!(waiting.await.unwrap_err().code, ErrorCode::Cancelled);
        assert!(ingress.settlement_admission(4).unwrap().reserve().is_ok());
        if let Some(bootstrap) = bootstrap {
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
    async fn settle_completed_operation_survives_late_cancel() {
        completed_operation_survives_late_cancel(false).await;
    }

    #[tokio::test]
    async fn fence_completed_operation_survives_late_cancel() {
        completed_operation_survives_late_cancel(true).await;
    }

    #[tokio::test]
    async fn settle_actor_deadline_keeps_exclusion_and_reservation_until_completion() {
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
        let (request, input) = ingress.chunk(2, true, &[]).unwrap().unwrap();
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
}
