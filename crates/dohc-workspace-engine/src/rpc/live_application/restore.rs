use super::*;
use crate::live_application_ingress::RestoreConfig;
use dohc_engine_collab::live_update_application::{
    NativeRestoreApplication, NativeRestorePreparation, NativeRestoreProposal,
};
use dohc_engine_protocol::transport::BlobEgress;
use serde::Serialize;
use std::io::Write;

#[doc(hidden)]
#[derive(Clone)]
pub struct RestoreInput {
    pub(crate) host: Arc<Host>,
    pub(crate) operation: RestoreOperation,
    pub(crate) config: RestoreConfig,
    pub(crate) reservation: Arc<dyn Send + Sync>,
}

#[derive(Clone)]
pub(crate) enum RestoreOperation {
    Prepare(NativeRestorePreparation),
    Apply(NativeRestoreApplication),
    Settle(NativeRestoreApplication),
}

impl RestoreOperation {
    fn preparation(&self) -> &NativeRestorePreparation {
        match self {
            Self::Prepare(input) => input,
            Self::Apply(input) | Self::Settle(input) => &input.preparation,
        }
    }
    fn method(&self) -> &str {
        match self {
            Self::Prepare(_) => "liveApplication.prepareRestore",
            Self::Apply(_) => "liveApplication.applyRestore",
            Self::Settle(_) => "liveApplication.settleRestore",
        }
    }
}

struct RestoreOutputGuard {
    fence: RestoreFenceOutputGuard,
    _reservation: Arc<dyn Send + Sync>,
}
impl std::fmt::Debug for RestoreOutputGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RestoreOutputGuard").finish_non_exhaustive()
    }
}
impl OutputGuard for RestoreOutputGuard {
    fn cancel_signal(&self) -> CancelSignal {
        self.fence.cancel_signal()
    }
    fn retirement_signal(&self) -> CancelSignal {
        self.fence.retirement_signal()
    }
    fn deadline(&self) -> Option<Instant> {
        self.fence.deadline()
    }
    fn is_current(&self) -> bool {
        self.fence.is_current()
    }
    fn with_current(&self, action: &mut dyn FnMut()) -> bool {
        self.fence.with_current(action)
    }
}

struct BoundedBytes {
    bytes: Vec<u8>,
    max: usize,
}
impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let length = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|length| *length <= self.max)
            .ok_or_else(|| std::io::Error::other("restore output limit"))?;
        self.bytes
            .try_reserve(length - self.bytes.len())
            .map_err(std::io::Error::other)?;
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn bounded_json(value: &impl Serialize, max: usize) -> Result<Vec<u8>, WireError> {
    let mut writer = BoundedBytes {
        bytes: Vec::new(),
        max,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| {
        WireError::new(
            ErrorCode::LimitExceeded,
            "native restore output exceeds configured budget",
        )
    })?;
    Ok(writer.bytes)
}
fn proposal_bytes(proposal: &NativeRestoreProposal, max: usize) -> Result<Vec<u8>, WireError> {
    let receipt = bounded_json(proposal.receipt(), max)?;
    let mut writer = BoundedBytes {
        bytes: Vec::new(),
        max,
    };
    let fields = [
        receipt.as_slice(),
        proposal.candidate_bytes(),
        proposal.frozen_state_bytes(),
        proposal.point_state_bytes(),
    ];
    for field in fields
        .into_iter()
        .chain(proposal.native_source_bytes().iter().map(Vec::as_slice))
    {
        let length = u32::try_from(field.len()).map_err(|_| {
            WireError::new(
                ErrorCode::LimitExceeded,
                "native restore field exceeds wire bound",
            )
        })?;
        writer
            .write_all(&length.to_le_bytes())
            .and_then(|()| writer.write_all(field))
            .map_err(|_| {
                WireError::new(
                    ErrorCode::LimitExceeded,
                    "native restore output exceeds configured budget",
                )
            })?;
    }
    Ok(writer.bytes)
}

impl EngineService {
    pub(crate) fn restore_host(
        &self,
        connection: &ConnectionHandle,
        workspace: Option<&WorkspaceHandle>,
    ) -> Result<Arc<Host>, WireError> {
        let workspace = workspace.ok_or_else(workspace_unavailable)?;
        let host = lock(&self.live_applications)
            .hosts
            .get(workspace)
            .cloned()
            .ok_or_else(workspace_unavailable)?;
        if !host.current(connection) || !Arc::ptr_eq(&self.open(Some(workspace))?, &host.open) {
            return Err(workspace_unavailable());
        }
        Ok(host)
    }

    pub(crate) async fn live_application_restore(
        &self,
        ctx: RequestContext,
        request: Request,
        input: RestoreInput,
    ) -> Result<ServiceResponse, WireError> {
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let host = self.restore_host(connection, request.workspace.as_ref())?;
        let config = self.restore_config(connection)?;
        let operation = &input.operation.preparation().fence.operation;
        if request.method != input.operation.method()
            || request.idempotency_key.is_some()
            || !Arc::ptr_eq(&host, &input.host)
            || config.max_bytes != input.config.max_bytes
            || config.max_events != input.config.max_events
            || operation.relay_database_namespace != host.namespace
            || operation.host_id != host.coordinate.host_id
            || operation.old_binding.workspace_id != host.open.workspace_id
        {
            return Err(workspace_unavailable());
        }
        let cancellation = super::super::request::OperationCancellation::new(&ctx);
        let serial = tokio::select! {
            biased;
            ()=cancellation.token.cancelled()=>return Err(cancellation.interruption("native restore (queued)")),
            serial=Arc::clone(&host.open.session_ops).lock_owned()=>serial,
        };
        if !host.current(connection)
            || !Arc::ptr_eq(&self.open(request.workspace.as_ref())?, &host.open)
        {
            return Err(workspace_unavailable());
        }
        let guard = Arc::new(RestoreOutputGuard {
            fence: RestoreFenceOutputGuard {
                host: host.clone(),
                cancel: ctx.cancel.clone(),
                deadline: ctx.deadline,
            },
            _reservation: input.reservation.clone(),
        });
        if !guard.is_current() {
            return Err(cancellation.interruption("native restore"));
        }
        let now_ms = super::super::request::now_ms()?;
        let events = self.events.clone();
        let leases = self.leases.clone();
        let self_writes = self.self_writes.clone();
        let token = cancellation.token();
        let worker_host = host.clone();
        let mut retirement = RetireOnCancellation(Some(host));
        let operation = tokio::spawn(async move {
            let _serial = serial;
            let _reservation = input.reservation.clone();
            let host = worker_host;
            let max = input.config.max_bytes;
            let count = input.config.max_events;
            match input.operation {
                RestoreOperation::Prepare(preparation) => {
                    let proposal = host
                        .owner
                        .prepare_restore(
                            preparation,
                            host.coordinate.clone(),
                            max,
                            count,
                            Arc::new(NoFaults),
                            input.reservation,
                        )
                        .await
                        .map_err(map_runtime)?;
                    Ok(("prepared", proposal_bytes(&proposal, max)?))
                }
                RestoreOperation::Apply(application) => {
                    let workspace = host.open.workspace_id.clone();
                    let observer = Arc::new(
                        move |facts: &dohc_engine_domain::CollectionRecordApplyFacts| {
                            crate::events::emit_record_events(&events, &workspace, facts)
                        },
                    );
                    let receipt = host
                        .owner
                        .apply_restore_observed(
                            application,
                            host.coordinate.clone(),
                            max,
                            count,
                            now_ms,
                            Arc::new(NoFaults),
                            input.reservation,
                            Some(observer),
                        )
                        .await
                        .map_err(map_runtime)?;
                    Ok(("applied", bounded_json(&receipt, max)?))
                }
                RestoreOperation::Settle(application) => {
                    let binding = application.preparation.fence.operation.old_binding.clone();
                    let observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let reconcile_required = observed.clone();
                    let workspace = host.open.workspace_id.clone();
                    let path = binding.current_path.clone();
                    let reconcile_events = events.clone();
                    let observer = Arc::new(move |result: &dohc_engine_collab::live_update_application::LiveSettlementResult| {
                        reconcile_required.store(result.collection_reconcile_required, std::sync::atomic::Ordering::SeqCst);
                        events.emit(crate::CAPTURE_MOMENT_RECORDED_EVENT, json!({"workspaceId":workspace,"paths":[path],"appliedCount":1,"notOwnedCount":0}));
                    });
                    let outcome = host
                        .owner
                        .settle_restore_observed(
                            application,
                            host.coordinate.clone(),
                            max,
                            count,
                            host.open.root.clone(),
                            now_ms,
                            Arc::new(NoFaults),
                            token.clone(),
                            input.reservation,
                            Some(observer),
                        )
                        .await;
                    if observed.load(std::sync::atomic::Ordering::SeqCst) {
                        let paths = host
                            .open
                            .actor
                            .reconcile_collections(
                                host.open.workspace_id.clone(),
                                binding.main_version_id,
                                host.open.root.clone(),
                                leases,
                                Arc::new(self_writes.scoped(&host.open.root)),
                                now_ms,
                                Arc::new(NoFaults),
                                token,
                            )
                            .await
                            .map_err(map_runtime)?;
                        if !paths.is_empty() {
                            reconcile_events.emit(crate::CAPTURE_MOMENT_RECORDED_EVENT, json!({
                                "workspaceId":host.open.workspace_id,"appliedCount":paths.len(),"notOwnedCount":0,
                                "paths":paths.iter().take(32).collect::<Vec<_>>()
                            }));
                        }
                    }
                    let receipt = outcome.map_err(map_runtime)?;
                    Ok(("settled", bounded_json(&receipt, max)?))
                }
            }
        });
        let outcome = tokio::select! {
            biased;
            outcome=operation=>outcome,
            ()=cancellation.token.cancelled()=>return Err(cancellation.interruption("native restore")),
        };
        retirement.0 = None;
        let (status, bytes) = outcome
            .map_err(|_| WireError::new(ErrorCode::Internal, "native restore interrupted"))??;
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        let digest = dohc_engine_storage::hex_sha256(&bytes);
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!({"status":status,"streamId":request.id,"byteLength":bytes.len(),"digest":digest}),
            },
            blob_egress: Some(BlobEgress {
                stream_id: request.id,
                sha256: digest,
                bytes,
                cancel: ctx.cancel,
                deadline: ctx.deadline,
                byte_permit: None,
            }),
            output_guard: Some(guard),
        })
    }
}
