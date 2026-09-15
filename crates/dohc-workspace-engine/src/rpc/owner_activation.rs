use super::error::{map_runtime, workspace_unavailable};
use super::request::{OperationCancellation, parse};
use crate::{EngineService, lock};
use dohc_engine_protocol::cancel::CancelSignal;
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::transport::{
    BlobEgress, ConnectionHandle, OutputGuard, RequestContext, ServiceResponse,
};
use dohc_engine_protocol::wire::{Request, Response};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

struct ActivationOutputGuard {
    connection: ConnectionHandle,
    cancel: CancelSignal,
    deadline: Option<Instant>,
    _reservation: Arc<dyn Send + Sync>,
}
impl std::fmt::Debug for ActivationOutputGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActivationOutputGuard")
            .finish_non_exhaustive()
    }
}
impl OutputGuard for ActivationOutputGuard {
    fn is_current(&self) -> bool {
        self.connection.is_current()
            && !self.cancel.is_cancelled()
            && self.deadline.is_none_or(|limit| Instant::now() < limit)
    }
    fn cancel_signal(&self) -> CancelSignal {
        self.cancel.clone()
    }
    fn retirement_signal(&self) -> CancelSignal {
        self.connection.cancel_signal()
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
}

impl EngineService {
    pub(super) async fn release_owner_activation(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            activation_id: String,
            session_id: String,
        }
        let namespace = self.configured_ordinary_namespace(&ctx, &request)?;
        let params: Params = parse(request.params.clone())?;
        let workspace = request
            .workspace
            .as_ref()
            .ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(workspace))?;
        let cancellation = OperationCancellation::new(&ctx);
        let serial = tokio::select! {biased;
            ()=cancellation.token.cancelled()=>return Err(cancellation.interruption("ordinary activation release")),
            serial=Arc::clone(&open.session_ops).lock_owned()=>serial,
        };
        let session = if lock(&self.sessions).contains_key(&params.session_id) {
            Some(self.ydoc_session(Some(workspace), &params.session_id)?.1)
        } else {
            None
        };
        let had_session = session.is_some();
        let workspace_id = open.workspace_id.clone();
        let session_binding = session
            .map(|session| {
                let lineage = session.lineage_claim_id.ok_or_else(workspace_unavailable)?;
                Ok::<_, WireError>((session.key, lineage))
            })
            .transpose()?;
        let actor = open.actor.clone();
        let sessions = Arc::clone(&self.sessions);
        let session_id = params.session_id;
        let token = cancellation.token();
        tokio::spawn(async move {
            let _serial = serial;
            actor
                .release_imported_owner_activation(
                    namespace,
                    workspace_id,
                    params.activation_id,
                    session_binding,
                    token,
                )
                .await
                .map_err(map_runtime)?;
            if had_session {
                let removed = lock(&sessions)
                    .remove(&session_id)
                    .ok_or_else(workspace_unavailable)?;
                drop(removed);
            }
            Ok::<_, WireError>(())
        })
        .await
        .map_err(|_| workspace_unavailable())??;
        let current = self.open(Some(workspace))?;
        if !Arc::ptr_eq(&open, &current) || cancellation.token.is_cancelled() {
            return Err(workspace_unavailable());
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!({"released":true}),
            },
            blob_egress: None,
            output_guard: None,
        })
    }

    pub(super) async fn capture_owner_activation(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            path: String,
            max_bytes: usize,
            activation_id: Option<String>,
        }
        let namespace = self.configured_ordinary_namespace(&ctx, &request)?;
        let params: Params = parse(request.params.clone())?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        let (policy, admission) = self.sync_admission(connection)?;
        if params.max_bytes == 0
            || params.max_bytes > policy.max_read_bytes
            || params.max_bytes > policy.max_output_bytes
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "ordinary activation exceeds configured sync bounds",
            ));
        }
        let reservation = admission.reserve()?;
        let guard = Arc::new(ActivationOutputGuard {
            connection: connection.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            _reservation: reservation.clone(),
        });
        let workspace = request
            .workspace
            .clone()
            .ok_or_else(workspace_unavailable)?;
        let cancellation = OperationCancellation::new(&ctx);
        let open = self.open(Some(&workspace))?;
        let serial = tokio::select! {biased;
            ()=cancellation.token.cancelled()=>return Err(cancellation.interruption("ordinary activation capture")),
            serial=Arc::clone(&open.session_ops).lock_owned()=>serial,
        };
        let existing = lock(&self.sessions)
            .iter()
            .find(|(_, session)| {
                session.workspace == workspace
                    && session.key.version_id == "main"
                    && session.path == params.path
            })
            .map(|(id, _)| id.clone());
        let (key, lease) = if let Some(id) = &existing {
            let (_, session) = self.ydoc_session(Some(&workspace), id)?;
            if session.first_update_pending
                || session.content_kind != dohc_engine_collab::ContentKind::Richdoc
                || session.regime != dohc_engine_collab::Regime::Replicated
            {
                return Err(workspace_unavailable());
            }
            (session.key, None)
        } else {
            let db_path = open.db_path.clone();
            let workspace_id = open.workspace_id.clone();
            let path = params.path.clone();
            let key = tokio::task::spawn_blocking(move || {
                let store = dohc_engine_storage::EngineStore::open_read_only(&db_path).map_err(|_|workspace_unavailable())?;
                let object_id: String = store.read_with(|conn| conn.query_row(
                    "SELECT s.object_id FROM snapshots s JOIN path_aliases p USING(workspace_id,version_id,object_id,path)
                     WHERE s.workspace_id=?1 AND s.version_id='main' AND s.path=?2 AND s.content_kind='text'",
                    rusqlite::params![workspace_id,path], |row|row.get(0))).map_err(|_|workspace_unavailable())?;
                dohc_engine_collab::DocKey::new(workspace_id, "main", object_id).map_err(|_|workspace_unavailable())
            }).await.map_err(|_|workspace_unavailable())??;
            let lease = self
                .leases
                .scoped(&open.root)
                .acquire(&key)
                .map_err(|_| workspace_unavailable())?;
            (key, Some(lease))
        };
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        let resuming = params.activation_id.is_some();
        let actor = open.actor.clone();
        let token = cancellation.token();
        let capture_key = key.clone();
        let (captured, lease, serial) = tokio::spawn(async move {
            let result = actor
                .capture_imported_owner_activation(
                    namespace,
                    capture_key,
                    params.path,
                    params.max_bytes,
                    params.activation_id,
                    token,
                    reservation,
                )
                .await;
            (result, lease, serial)
        })
        .await
        .map_err(|_| {
            WireError::new(
                ErrorCode::Internal,
                "ordinary activation capture interrupted",
            )
        })?;
        let captured = captured.map_err(map_runtime)?;
        if !guard.is_current() || !Arc::ptr_eq(&open, &self.open(Some(&workspace))?) {
            return Err(workspace_unavailable());
        }
        let session_id = if let Some(id) = existing {
            if resuming {
                let mut sessions = lock(&self.sessions);
                let session = sessions.get_mut(&id).ok_or_else(workspace_unavailable)?;
                if session.lineage_claim_id.as_deref()
                    != Some(captured.source.lineage_claim_id.as_str())
                {
                    return Err(workspace_unavailable());
                }
                session.restore_generation = captured.restore_generation;
            }
            id
        } else {
            let sequence = self
                .next_session
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let id = format!("ydoc-{}-{sequence:016x}", self.session_epoch);
            let session = super::ydoc::YdocSession::imported_owner(
                workspace.clone(),
                key,
                &captured,
                lease.ok_or_else(workspace_unavailable)?,
            );
            lock(&self.sessions).insert(id.clone(), session);
            id
        };
        let (_, session) = self.ydoc_session(Some(&workspace), &session_id)?;
        if session.lineage_claim_id.as_deref() != Some(captured.source.lineage_claim_id.as_str()) {
            return Err(workspace_unavailable());
        }
        drop(serial);
        let baseline_length = captured.baseline_bytes.len();
        let mut bytes = captured.baseline_bytes;
        bytes.extend_from_slice(&captured.full_state);
        let digest = dohc_engine_storage::hex_sha256(&bytes);
        let result = json!({"status":"captured","activationId":captured.activation_id,"sessionId":session_id,
            "source":captured.source,"baselineByteLength":baseline_length,"streamId":request.id,"byteLength":bytes.len(),"digest":digest});
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result,
            },
            output_guard: Some(guard),
            blob_egress: Some(BlobEgress {
                stream_id: request.id,
                sha256: digest,
                bytes,
                cancel: ctx.cancel,
                deadline: ctx.deadline,
                byte_permit: None,
            }),
        })
    }
}
