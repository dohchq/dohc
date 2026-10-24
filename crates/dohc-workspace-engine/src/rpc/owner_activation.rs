use super::error::{map_runtime, workspace_unavailable};
use super::request::{OperationCancellation, parse};
use crate::{EngineService, lock};
use dohc_engine_collab::live_update_application::RetiredActivations;
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
    /// The activation the capture names, once it has.
    activation_id: Option<String>,
    /// The activations the workspace's host retired; an answer for one is withheld.
    retired: Option<RetiredActivations>,
    cancel: CancelSignal,
    deadline: Option<Instant>,
    reservation: std::sync::Mutex<Option<Arc<dyn Send + Sync>>>,
}
impl std::fmt::Debug for ActivationOutputGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActivationOutputGuard")
            .field("activation_id", &self.activation_id)
            .finish_non_exhaustive()
    }
}
impl OutputGuard for ActivationOutputGuard {
    fn is_current_ignoring_cancel(&self) -> bool {
        self.with_current(false, &mut || {})
    }
    /// The check and the output hold the retired set, as Phase A does to
    /// retire, so no output for the activation lands once it is retired.
    fn with_current(&self, cancellable: bool, action: &mut dyn FnMut()) -> bool {
        let mut output = || {
            if !self.connection.is_current()
                || (cancellable && self.cancel.is_cancelled())
                || self.deadline.is_some_and(|limit| Instant::now() >= limit)
            {
                return false;
            }
            action();
            true
        };
        match (&self.retired, &self.activation_id) {
            (Some(retired), Some(id)) => retired.unless_retired(id, output),
            _ => output(),
        }
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
    fn release(&self) {
        crate::lock(&self.reservation).take();
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
        // A session serving another activation is not this release's to close.
        if session.as_ref().is_some_and(|session| {
            session
                .activation_id
                .as_ref()
                .is_some_and(|tagged| *tagged != params.activation_id)
        }) {
            return Err(map_runtime(
                dohc_engine_collab::live_update_application::ApplicationError::Conflict.into(),
            ));
        }
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
        if !Arc::ptr_eq(&open, &current) {
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
        let workspace = request
            .workspace
            .clone()
            .ok_or_else(workspace_unavailable)?;
        let retired = lock(&self.live_applications).retired_activations(&workspace);
        let mut guard = ActivationOutputGuard {
            connection: connection.clone(),
            activation_id: None,
            retired: retired.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            reservation: std::sync::Mutex::new(Some(reservation.clone())),
        };
        let cancellation = OperationCancellation::new(&ctx);
        let open = self.open(Some(&workspace))?;
        let serial = tokio::select! {biased;
            ()=cancellation.token.cancelled()=>return Err(cancellation.interruption("ordinary activation capture")),
            serial=Arc::clone(&open.session_ops).lock_owned()=>serial,
        };
        // A retired activation never loads here again.
        let is_retired = |id: &str| retired.as_ref().is_some_and(|retired| retired.contains(id));
        if params.activation_id.as_deref().is_some_and(is_retired) {
            return Err(map_runtime(
                dohc_engine_collab::live_update_application::ApplicationError::Conflict.into(),
            ));
        }
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
            let held = open.actor.location();
            let workspace_id = open.workspace_id.clone();
            let path = params.path.clone();
            let namespace = namespace.clone();
            let activation_id = params.activation_id.clone();
            let key = tokio::task::spawn_blocking(move || {
                use rusqlite::OptionalExtension;
                let store = dohc_engine_storage::EngineStore::open_read_only(held.database_path()).map_err(|_|workspace_unavailable())?;
                // A resume finds its document through the activation it retained, so one
                // with no head, as once it parked, still answers whether it is ready.
                // One whose retirement began finds none, before it takes the lease.
                let object_id: Option<String> = store.read_with(|conn| match &activation_id {
                    Some(activation_id) => conn.query_row(
                        "SELECT object_id FROM ydoc_owner_activation_sources a WHERE activation_id=?1
                         AND relay_database_namespace=?2 AND workspace_id=?3 AND version_id='main'
                         AND NOT EXISTS(SELECT 1 FROM live_owner_retirements r
                           WHERE r.relay_database_namespace=?2 AND r.activation_id=a.activation_id)",
                        rusqlite::params![activation_id,namespace,workspace_id], |row|row.get(0)).optional(),
                    None => conn.query_row(
                        "SELECT s.object_id FROM snapshots s JOIN path_aliases p USING(workspace_id,version_id,object_id,path)
                         WHERE s.workspace_id=?1 AND s.version_id='main' AND s.path=?2 AND s.content_kind='text'",
                        rusqlite::params![workspace_id,path], |row|row.get(0)).optional(),
                }).map_err(|_|workspace_unavailable())?;
                let object_id = match object_id {
                    Some(object_id) => object_id,
                    // This store never held the activation, as after an identity change selected
                    // a new one, or its retirement began.
                    None if activation_id.is_some() => return Err(map_runtime(
                        dohc_engine_collab::live_update_application::ApplicationError::Conflict.into())),
                    None => return Err(workspace_unavailable()),
                };
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
        if is_retired(&captured.activation_id) {
            return Err(map_runtime(
                dohc_engine_collab::live_update_application::ApplicationError::Conflict.into(),
            ));
        }
        // The capture landed: install its session even for a cancelled
        // request. The writer withholds the answer once the guard lapses.
        if !connection.is_current() || !Arc::ptr_eq(&open, &self.open(Some(&workspace))?) {
            return Err(workspace_unavailable());
        }
        let session_id = if let Some(id) = existing {
            reuse_session(&mut lock(&self.sessions), &id, &captured, resuming)?;
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
            )
            .map_err(|error| map_runtime(dohc_engine_runtime::RuntimeError::Collab(error)))?;
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
        guard.activation_id = Some(captured.activation_id.clone());
        let result = json!({"status":"captured","activationId":captured.activation_id,"sessionId":session_id,
            "source":captured.source,"baselineByteLength":baseline_length,"streamId":request.id,"byteLength":bytes.len(),"digest":digest});
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result,
            },
            output_guard: Some(Arc::new(guard)),
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

/// A reused session serves a capture of its own lineage only. It takes the
/// capture's activation, and a resume's restore generation, after that check.
fn reuse_session(
    sessions: &mut std::collections::HashMap<String, super::ydoc::YdocSession>,
    id: &str,
    captured: &dohc_engine_collab::live_update_application::ImportedOwnerActivation,
    resuming: bool,
) -> Result<(), WireError> {
    let session = sessions.get_mut(id).ok_or_else(workspace_unavailable)?;
    if session.lineage_claim_id.as_deref() != Some(captured.source.lineage_claim_id.as_str()) {
        return Err(workspace_unavailable());
    }
    if resuming {
        session.restore_generation = captured.restore_generation;
    }
    session.activation_id = Some(captured.activation_id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_collab::DocKey;
    use dohc_engine_collab::live_update_application::{
        ImportedOwnerActivation, ImportedOwnerSource,
    };
    use dohc_engine_protocol::transport::RequestContext;

    /// Opus's round 1 note: a capture's answer carries its activation, and
    /// once a retirement tears that activation down the answer is withheld.
    /// An answer for another activation stays current.
    #[test]
    fn a_capture_answer_for_a_retired_activation_is_withheld() {
        let mut owner =
            dohc_engine_collab::live_update_application::ApplicationOwner::new("workspace".into())
                .unwrap();
        let retired = owner.retired_activations();
        let connection = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        let guard = |activation_id: &str| ActivationOutputGuard {
            connection: connection.handle(),
            activation_id: Some(activation_id.into()),
            retired: Some(retired.clone()),
            cancel: CancelSignal::new(),
            deadline: None,
            reservation: std::sync::Mutex::new(Some(Arc::new(()))),
        };
        let (retiring, other) = (guard("retiring"), guard("other"));
        assert!(retiring.is_current() && other.is_current());
        owner.retire_activation(
            &mut dohc_engine_collab::WriterDocCache::new(),
            "namespace",
            &dohc_engine_collab::live_update_application::ApplicationHostCoordinate {
                host_id: "host".into(),
                host_epoch: 1,
                instance_id: "instance".into(),
                connection_id: "connection".into(),
            },
            &DocKey::new("workspace", "main", "document").unwrap(),
            "retiring",
        );
        assert!(!retiring.is_current());
        assert!(other.is_current());
    }

    /// Sol's round 3a race: a capture write passes its check and pauses,
    /// then Phase A starts. The paused write holds the fence Phase A takes,
    /// so Phase A ends only after it, and no later write for the activation
    /// runs.
    #[test]
    fn phase_a_waits_for_a_capture_write_that_passed_its_check() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc::channel;
        let mut owner =
            dohc_engine_collab::live_update_application::ApplicationOwner::new("workspace".into())
                .unwrap();
        let retired = owner.retired_activations();
        let connection = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        let guard = Arc::new(ActivationOutputGuard {
            connection: connection.handle(),
            activation_id: Some("retiring".into()),
            retired: Some(retired.clone()),
            cancel: CancelSignal::new(),
            deadline: None,
            reservation: std::sync::Mutex::new(Some(Arc::new(()))),
        });
        let wrote = Arc::new(AtomicBool::new(false));
        let (entered, paused) = channel();
        let (resume, resumed) = channel::<()>();
        let writer = {
            let (guard, wrote) = (guard.clone(), wrote.clone());
            std::thread::spawn(move || {
                guard.with_current(true, &mut || {
                    entered.send(()).unwrap();
                    resumed.recv().unwrap();
                    wrote.store(true, Ordering::SeqCst);
                })
            })
        };
        paused.recv().unwrap();
        assert!(retired.fenced(), "the paused write holds the fence");
        let (started, starting) = channel();
        let phase_a = {
            let wrote = wrote.clone();
            std::thread::spawn(move || {
                started.send(()).unwrap();
                owner.retire_activation(
                    &mut dohc_engine_collab::WriterDocCache::new(),
                    "namespace",
                    &dohc_engine_collab::live_update_application::ApplicationHostCoordinate {
                        host_id: "host".into(),
                        host_epoch: 1,
                        instance_id: "instance".into(),
                        connection_id: "connection".into(),
                    },
                    &DocKey::new("workspace", "main", "document").unwrap(),
                    "retiring",
                );
                wrote.load(Ordering::SeqCst)
            })
        };
        starting.recv().unwrap();
        resume.send(()).unwrap();
        assert!(
            writer.join().unwrap(),
            "the write that passed its check lands"
        );
        assert!(phase_a.join().unwrap(), "Phase A ended after that write");
        let mut late = false;
        assert!(!guard.with_current(true, &mut || late = true));
        assert!(!late, "no write for the retired activation runs");
    }

    /// A capture naming an activation Phase A retired over RPC is refused
    /// before it looks the activation up or takes the document's lease, and
    /// opens no session. After a restart forgets Phase A, the intent it
    /// recorded refuses the capture the same way. One naming another
    /// activation goes on, here to the lease another session holds.
    #[tokio::test]
    async fn a_capture_naming_a_retired_activation_is_refused() {
        use dohc_engine_protocol::transport::EngineService as _;
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let configuration = json!({
            "version": 1, "relayNamespace": "capture-test",
            "host": {"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": [{"root":scratch.path(),"workspaceId":"workspace","maxRegistrations":4,
                "relay":{"baseUrl":"https://relay.invalid","bearerToken":"owner"}}],
            "ingress": {"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":1,"uploadDeadlineMs":30_000},
            "settlement": {"maxApplicationsPerSettlement":4},
            "sync":{"policy":{"maxClientVectorBytes":1024,"maxHostVectorBytes":4096,"maxOutputBytes":1_000_000,"maxReadBytes":10_000_000},"workingReserveBytes":16*1024*1024}
        });
        let key = DocKey::new("workspace", "main", "document").unwrap();
        let lineage = dohc_engine_storage::hex_sha256(b"lineage");
        let source = |activation: &str| ImportedOwnerActivation {
            activation_id: activation.into(),
            source: ImportedOwnerSource {
                version: 1,
                reader_source: false,
                relay_database_namespace: "capture-test".into(),
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
                full_state_digest: lineage.clone(),
                full_state_byte_length: 0,
                predecessor_activation_id: None,
            },
            baseline_bytes: Vec::new(),
            full_state: Vec::new(),
            restore_generation: None,
        };
        for restarted in [false, true] {
            let (service, owner, _ingress) = EngineService::configured_live_host(
                serde_json::from_value(configuration.clone()).unwrap(),
            )
            .await
            .unwrap();
            let workspace = lock(&service.handles).keys().next().unwrap().clone();
            let open = service.open(Some(&workspace)).unwrap();
            if !restarted {
                open.actor
                    .ensure_main_version(
                        "workspace".into(),
                        0,
                        Arc::new(dohc_engine_storage::NoFaults),
                        dohc_engine_runtime::CancellationToken::new(),
                    )
                    .await
                    .unwrap();
                let conn = rusqlite::Connection::open(open.actor.database_path()).unwrap();
                conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
                for activation in ["retiring", "other"] {
                    conn.execute(
                        "INSERT INTO ydoc_owner_activation_sources VALUES (?1,'capture-test','workspace','main','document',?2,'moment',?2,?2,?3)",
                        rusqlite::params![
                            activation,
                            lineage,
                            serde_json::to_string(&source(activation).source).unwrap()
                        ],
                    )
                    .unwrap();
                }
            }
            // Another activation's session holds the document's lease.
            let lease = service.leases.scoped(&open.root).acquire(&key).unwrap();
            let session = super::super::ydoc::YdocSession::imported_owner(
                workspace.clone(),
                key.clone(),
                &source("other"),
                lease,
            )
            .unwrap();
            lock(&service.sessions).insert("ydoc-other".into(), session);
            let ctx = || {
                let mut ctx = RequestContext::unbounded();
                ctx.connection = Some(owner.handle());
                ctx
            };
            let request = |method: &str, params: serde_json::Value| Request {
                id: 9,
                method: method.into(),
                workspace: Some(workspace.clone()),
                deadline_ms: None,
                idempotency_key: None,
                progress: false,
                params,
            };
            if !restarted {
                let reconciled = service
                    .call(
                        ctx(),
                        request(
                            "liveApplication.reconcileActivation",
                            json!({"objectId":"document","lineageClaimId":lineage,"activationId":"retiring",
                                "restoreFenceGeneration":0,"acceptedThrough":5,"afterReceipt":null,"maxApplications":4}),
                        ),
                    )
                    .await
                    .unwrap();
                assert_eq!(reconciled.response.result["status"], "reconciled");
            }
            let capture = |activation: &str| {
                service.call(
                    ctx(),
                    request(
                        "liveApplication.captureOwnerActivation",
                        json!({"path":"elsewhere.md","maxBytes":1_000_000,"activationId":activation}),
                    ),
                )
            };
            let sessions = || lock(&service.sessions).keys().cloned().collect::<Vec<_>>();
            assert_eq!(
                capture("retiring").await.unwrap_err().code,
                ErrorCode::Conflict,
                "restarted={restarted}"
            );
            assert_eq!(sessions(), ["ydoc-other"]);
            assert_eq!(
                capture("other").await.unwrap_err().code,
                ErrorCode::WorkspaceUnavailable,
                "it went on to the held lease, restarted={restarted}"
            );
            assert_eq!(sessions(), ["ydoc-other"]);
            service.workspace_close(Some(workspace)).await.unwrap();
        }
    }

    /// A release names the activation it ends. One naming another activation
    /// than the session serves closes nothing and removes no source. A
    /// capture of another lineage never retags a reused session.
    #[tokio::test]
    async fn a_release_for_another_activation_leaves_the_session_and_its_source() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let configuration = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "release-test",
            "host": {"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": [{"root":scratch.path(),"workspaceId":"workspace","maxRegistrations":4,
                "relay":{"baseUrl":"https://relay.invalid","bearerToken":"owner"}}],
            "ingress": {"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":1,"uploadDeadlineMs":30_000}
        }))
        .unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(configuration)
            .await
            .unwrap();
        let workspace = lock(&service.handles).keys().next().unwrap().clone();
        let open = service.open(Some(&workspace)).unwrap();
        let key = DocKey::new("workspace", "main", "document").unwrap();
        let lineage = dohc_engine_storage::hex_sha256(b"lineage");
        {
            let conn = rusqlite::Connection::open(open.actor.database_path()).unwrap();
            conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
            for activation in ["tagged", "requested"] {
                conn.execute(
                    "INSERT INTO ydoc_owner_activation_sources VALUES (?1,'release-test','workspace','main','document',?2,'moment',?2,?2,'{}')",
                    rusqlite::params![activation, lineage],
                )
                .unwrap();
            }
        }
        let source = ImportedOwnerSource {
            version: 1,
            reader_source: false,
            relay_database_namespace: "release-test".into(),
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
            predecessor_activation_id: None,
        };
        let captured = ImportedOwnerActivation {
            activation_id: "tagged".into(),
            source,
            baseline_bytes: Vec::new(),
            full_state: Vec::new(),
            restore_generation: None,
        };
        let lease = service.leases.scoped(&open.root).acquire(&key).unwrap();
        let session = super::super::ydoc::YdocSession::imported_owner(
            workspace.clone(),
            key.clone(),
            &captured,
            lease,
        )
        .unwrap();
        lock(&service.sessions).insert("ydoc-tagged".into(), session);
        let release = |activation: &str| {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            service.release_owner_activation(
                ctx,
                Request {
                    id: 7,
                    method: "liveApplication.releaseOwnerActivation".into(),
                    workspace: Some(workspace.clone()),
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params: json!({"activationId": activation, "sessionId": "ydoc-tagged"}),
                },
            )
        };
        let sources = || -> Vec<String> {
            let conn = rusqlite::Connection::open(open.actor.database_path()).unwrap();
            conn.prepare(
                "SELECT activation_id FROM ydoc_owner_activation_sources ORDER BY activation_id",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        assert!(release("requested").await.is_err());
        assert!(
            lock(&service.sessions).contains_key("ydoc-tagged"),
            "the tagged session stays"
        );
        assert_eq!(sources(), ["requested", "tagged"], "no source goes");
        release("tagged").await.unwrap();
        assert!(!lock(&service.sessions).contains_key("ydoc-tagged"));
        assert_eq!(sources(), ["requested"]);

        // A capture of another lineage leaves a reused session's tag alone.
        let lease = service.leases.scoped(&open.root).acquire(&key).unwrap();
        let session = super::super::ydoc::YdocSession::imported_owner(
            workspace.clone(),
            key,
            &captured,
            lease,
        )
        .unwrap();
        lock(&service.sessions).insert("ydoc-reused".into(), session);
        let tag = || lock(&service.sessions)["ydoc-reused"].activation_id.clone();
        let capture = |activation: &str, lineage: &str| ImportedOwnerActivation {
            activation_id: activation.into(),
            source: ImportedOwnerSource {
                lineage_claim_id: lineage.into(),
                ..captured.source.clone()
            },
            baseline_bytes: Vec::new(),
            full_state: Vec::new(),
            restore_generation: Some(4),
        };
        let other = dohc_engine_storage::hex_sha256(b"other lineage");
        for resuming in [false, true] {
            assert!(
                reuse_session(
                    &mut lock(&service.sessions),
                    "ydoc-reused",
                    &capture("mismatched", &other),
                    resuming
                )
                .is_err()
            );
            assert_eq!(tag().as_deref(), Some("tagged"), "resuming={resuming}");
            assert_eq!(
                lock(&service.sessions)["ydoc-reused"].restore_generation,
                None
            );
        }
        reuse_session(
            &mut lock(&service.sessions),
            "ydoc-reused",
            &capture("matched", &captured.source.lineage_claim_id),
            true,
        )
        .unwrap();
        assert_eq!(tag().as_deref(), Some("matched"));
        assert_eq!(
            lock(&service.sessions)["ydoc-reused"].restore_generation,
            Some(4)
        );
    }
}
