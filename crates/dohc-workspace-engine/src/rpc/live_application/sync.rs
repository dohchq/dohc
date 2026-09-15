use super::*;
use dohc_engine_collab::live_update_application::{AppliedPosition, AppliedSyncPolicy};
use dohc_engine_protocol::transport::BlobEgress;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SyncConfig {
    pub policy: AppliedSyncPolicy,
    pub working_reserve_bytes: usize,
}
impl SyncConfig {
    pub(crate) fn reservation_bytes(&self) -> Option<usize> {
        self.policy.validate().ok()?;
        if self.working_reserve_bytes == 0 {
            return None;
        }
        self.policy
            .max_client_vector_bytes
            .checked_mul(9)?
            .checked_add(self.policy.max_host_vector_bytes.checked_mul(10)?)?
            .checked_add(self.policy.max_read_bytes.checked_mul(2)?)?
            .checked_add(self.policy.max_output_bytes.checked_mul(2)?)?
            .checked_add(self.working_reserve_bytes)?
            .checked_add(643_576 * 2)
    }
}

impl EngineService {
    pub(crate) async fn live_application_applied_read(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            registration_id: u64,
            after: AppliedPosition,
        }
        let params: Params = serde_json::from_value(request.params.clone())
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid applied read"))?;
        params
            .after
            .validate()
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid applied position"))?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let registration = self.live_application_registration(
            connection,
            request.workspace.as_ref(),
            params.registration_id,
        )?;
        let (policy, admission) = self.sync_admission(connection)?;
        self.live_application_sync(
            ctx,
            request,
            registration,
            None,
            Some(params.after),
            policy,
            admission.reserve()?,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn live_application_sync(
        &self,
        ctx: RequestContext,
        request: Request,
        registration: Arc<Registration>,
        vector: Option<Vec<u8>>,
        after: Option<AppliedPosition>,
        policy: AppliedSyncPolicy,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<ServiceResponse, WireError> {
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        if !registration.host.current(connection)
            || !Arc::ptr_eq(
                &self.open(request.workspace.as_ref())?,
                &registration.host.open,
            )
        {
            return Err(workspace_unavailable());
        }
        let cancellation = super::super::request::OperationCancellation::new(&ctx);
        if ctx.cancel.is_cancelled() {
            return Err(cancellation.interruption("applied sync"));
        }
        if ctx.deadline.is_some_and(|end| Instant::now() >= end) {
            return Err(WireError::new(
                ErrorCode::DeadlineExceeded,
                "applied sync deadline elapsed",
            ));
        }
        let guard = Arc::new(ApplicationOutputGuard {
            registration: registration.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            _reservation: reservation.clone(),
        });
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        // Read-only actor requests serialize the cut themselves. No session-wide lock is held while queued.
        let operation = async {
            match (vector, after) {
                (Some(vector), None) => {
                    let cut = registration
                        .handle
                        .sync_open(vector, policy, cancellation.token.clone(), reservation)
                        .await
                        .map_err(map_application_read)?;
                    let vector_len = cut.host_vector.len();
                    let length = vector_len
                        .checked_add(cut.missing_state_update.len())
                        .filter(|n| *n <= policy.max_output_bytes)
                        .ok_or_else(|| {
                            WireError::new(ErrorCode::LimitExceeded, "sync output limit")
                        })?;
                    let mut bytes = Vec::new();
                    bytes.try_reserve_exact(length).map_err(|_| {
                        WireError::new(ErrorCode::Overloaded, "sync output allocation")
                    })?;
                    bytes.extend_from_slice(&cut.host_vector);
                    bytes.extend_from_slice(&cut.missing_state_update);
                    Ok((
                        json!({"status":"sync","binding":cut.binding,"position":cut.position,
                        "observedLocalYDocHeadSequence":cut.observed_local_ydoc_head_sequence,"hostVectorByteLength":vector_len}),
                        Some(bytes),
                    ))
                }
                (None, Some(after)) => {
                    match registration
                        .handle
                        .read_next_applied(
                            after.clone(),
                            policy,
                            cancellation.token.clone(),
                            reservation,
                        )
                        .await
                        .map_err(map_application_read)?
                    {
                        Some(update) => Ok((
                            json!({"status":"update","position":update.position,"ack":update.ack}),
                            Some(update.update_bytes),
                        )),
                        None => Ok((json!({"status":"empty","after":after}), None)),
                    }
                }
                _ => Err(workspace_unavailable()),
            }
        };
        let (mut result, bytes) = tokio::select! {biased;
            ()=cancellation.token.cancelled()=>return Err(cancellation.interruption("applied sync")),
            ()=registration.retired.cancelled()=>return Err(workspace_unavailable()),
            result=operation=>result?,
        };
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        let blob_egress = bytes.map(|bytes| {
            let digest = dohc_engine_storage::hex_sha256(&bytes);
            result["streamId"] = json!(request.id);
            result["byteLength"] = json!(bytes.len());
            result["digest"] = json!(digest);
            BlobEgress {
                stream_id: request.id,
                sha256: digest,
                bytes,
                cancel: ctx.cancel,
                deadline: ctx.deadline,
                byte_permit: None,
            }
        });
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result,
            },
            blob_egress,
            output_guard: Some(guard),
        })
    }
}
