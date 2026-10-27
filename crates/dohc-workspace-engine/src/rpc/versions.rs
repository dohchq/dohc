use crate::EngineService;
use crate::SelfWriteSuppression;
use crate::capture_driver;
use crate::capture_sink;
use crate::events::EngineEvents;
use crate::events::emit_record_events;
use crate::lock;
use crate::rpc::error::map_runtime;
use crate::rpc::error::map_switch_reconcile_error;
use crate::rpc::error::workspace_unavailable;
use crate::rpc::history::MOMENTS_PAGE_BYTE_BUDGET;
use crate::rpc::reads::SINGLE_ROW_HARD_CAP_BYTES;
use crate::rpc::reads::byte_budget_cut_serialized;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::workspace::OpenWorkspace;
use crate::rpc::workspace::validate_workspace_param;
use crate::rpc::ydoc::YdocSession;
use crate::rpc::ydoc::YdocSessionView;
use dohc_engine_collab::ContentKind;
use dohc_engine_collab::DocKey;
use dohc_engine_domain::CreateNamedVersion;
use dohc_engine_domain::DomainError;
use dohc_engine_domain::VersionFileChangeStatus;
use dohc_engine_domain::VersionRecord;
use dohc_engine_domain::validate_addressable_plaintext_path;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::Request;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::CancellationToken;
use dohc_engine_runtime::NoFaults;
use dohc_engine_runtime::RuntimeError;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

struct WorkspaceBarriers {
    _capture: tokio::sync::OwnedMutexGuard<()>,
    _sessions: tokio::sync::OwnedMutexGuard<()>,
}

fn history_undo_result_json(result: &dohc_engine_runtime::HistoryUndoResult) -> Value {
    json!({
        "operationId": result.operation_id, "versionId": result.version_id,
        "momentCount": result.moments.len(), "compensationOperationId": result.compensation_operation_id,
        "deduped": result.deduped, "materialized": result.materialized, "notRestored": result.not_restored,
    })
}

pub(super) struct VersionFence {
    sessions: Arc<Mutex<HashMap<String, YdocSession>>>,
    leases: dohc_engine_collab::LeaseRegistry,
    self_writes: SelfWriteSuppression,
    events: EngineEvents,
    capture_apply_probe: Option<capture_driver::CaptureApplyProbe>,
}
pub(super) enum VersionFenceIntent {
    Undo {
        operation_id: String,
        request_id: String,
        author_json: Option<String>,
    },
    Fork {
        input: CreateNamedVersion,
    },
    Switch {
        target_version_id: String,
        now_ms: i64,
    },
}

pub(super) enum VersionFenceOutcome {
    UndoCommitted(dohc_engine_runtime::HistoryUndoResult),
    AlreadyActive,
    CreateReplay(VersionRecord),
    Committed(VersionRecord),
}

#[allow(clippy::too_many_arguments)]
async fn settle_fence_session(
    sessions: &Arc<Mutex<HashMap<String, YdocSession>>>,
    self_writes: &SelfWriteSuppression,
    events: &EngineEvents,
    open: &OpenWorkspace,
    handle: &WorkspaceHandle,
    session_id: &str,
    token: &CancellationToken,
) -> Result<(), WireError> {
    let session = version_fence_session_view(sessions, handle, session_id)?;
    // Mirrors ydoc.close's default-settle rule: only an untouched
    // absent-lineage session (nothing to settle) skips the settling sweep.
    let settle = !(session.lineage_absent && session.first_update_pending);
    if settle {
        let first = settle_ydoc_session_for_version_fence(
            sessions,
            self_writes,
            events,
            open,
            session_id,
            &session,
            token,
        )
        .await;
        match first {
            Ok(()) => {}
            Err(error) if error.message == "ydoc-remote-updates-pending" => {
                let refreshed = version_fence_session_view(sessions, handle, session_id)?;
                settle_ydoc_session_for_version_fence(
                    sessions,
                    self_writes,
                    events,
                    open,
                    session_id,
                    &refreshed,
                    token,
                )
                .await?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn close_ydoc_session_for_version_fence(
    sessions: &Arc<Mutex<HashMap<String, YdocSession>>>,
    self_writes: &SelfWriteSuppression,
    events: &EngineEvents,
    open: &OpenWorkspace,
    handle: &WorkspaceHandle,
    session_id: &str,
    _summary: &str,
    token: &CancellationToken,
) -> Result<(), WireError> {
    settle_fence_session(
        sessions,
        self_writes,
        events,
        open,
        handle,
        session_id,
        token,
    )
    .await?;

    let session = version_fence_session_view(sessions, handle, session_id)?;
    let now = now_ms()?;
    let taken = lock(sessions).remove(session_id);
    let close = open
        .actor
        .ydoc_close_session_materialized(
            open.root.clone(),
            session.key,
            Arc::new(self_writes.scoped(&open.root)),
            now,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await;
    if matches!(
        close,
        Err(RuntimeError::Collab(_)) | Err(RuntimeError::Domain(_))
    ) && let Some(entry) = taken
    {
        lock(sessions).insert(session_id.to_owned(), entry);
    }
    let closed = close.map_err(map_runtime)?;
    // Post-commit: the close's drain committed these history rows.
    for facts in &closed.record_facts {
        emit_record_events(events, &open.workspace_id, facts);
    }
    Ok(())
}

fn version_fence_session_view(
    sessions: &Arc<Mutex<HashMap<String, YdocSession>>>,
    handle: &WorkspaceHandle,
    session_id: &str,
) -> Result<YdocSessionView, WireError> {
    let sessions = lock(sessions);
    let session = sessions
        .get(session_id)
        .filter(|session| session.workspace == *handle)
        .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "ydoc-session-not-found"))?;
    Ok(YdocSessionView {
        owner_draft: session.owner_draft.clone(),
        key: session.key.clone(),
        path: session.path.clone(),
        content_kind: session.content_kind,
        regime: session.regime,
        lineage_claim_id: session.lineage_claim_id.clone(),
        restore_generation: session.restore_generation,
        lineage_absent: session.lineage_absent,
        first_update_pending: session.first_update_pending,
        last_settled_sha: session.last_settled_sha.clone(),
        open_head_sha: session.open_head_sha.clone(),
        owner_seed_source: session.owner_seed_source.clone(),
    })
}

async fn settle_ydoc_session_for_version_fence(
    sessions: &Arc<Mutex<HashMap<String, YdocSession>>>,
    self_writes: &SelfWriteSuppression,
    events: &EngineEvents,
    open: &OpenWorkspace,
    session_id: &str,
    session: &YdocSessionView,
    token: &CancellationToken,
) -> Result<(), WireError> {
    let settled = open
        .actor
        .ydoc_settle(
            open.root.clone(),
            session.key.clone(),
            session.path.clone(),
            session.content_kind,
            session.lineage_claim_id.clone(),
            settle_preimage(&session.last_settled_sha, &session.open_head_sha),
            session_id.to_owned(),
            Arc::new(self_writes.scoped(&open.root)),
            now_ms()?,
            Arc::new(NoFaults),
            token.clone(),
            session.restore_generation,

            None,
        )
        .await
        .map_err(map_runtime)?;
    let settled = match settled {
        dohc_engine_runtime::YdocSettleOutcome::Settled(settlement) => *settlement,
        dohc_engine_runtime::YdocSettleOutcome::RemoteUpdatesPending { record_facts } => {
            // Post-commit; the fence's caller retries the settle.
            for facts in &record_facts {
                emit_record_events(events, &open.workspace_id, facts);
            }
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "ydoc-remote-updates-pending",
            ));
        }
    };
    if settled.collection_reconcile_required {
        open.request_collection_reconcile();
    }
    if let Some(session) = lock(sessions).get_mut(session_id) {
        session.last_settled_sha = Some(settled.sha256);
    }
    Ok(())
}

fn unsettled_fork_error(_content_kind: ContentKind) -> WireError {
    // Both kinds settle now (richdoc projection is full-fidelity since
    // R15-3), so an unsettled lineage refuses with one message.
    WireError::new(ErrorCode::InvalidParams, "ydoc-unsettled-close")
}

fn settle_preimage(
    last_settled_sha: &Option<String>,
    open_head_sha: &Option<String>,
) -> Option<String> {
    last_settled_sha.clone().or_else(|| open_head_sha.clone())
}

#[cfg(test)]
mod version_fence_preimage_tests {
    use super::settle_preimage;

    #[test]
    fn latest_settlement_outranks_the_open_head() {
        assert_eq!(
            settle_preimage(
                &Some("latest-settlement".to_owned()),
                &Some("original-open-head".to_owned())
            ),
            Some("latest-settlement".to_owned())
        );
        assert_eq!(
            settle_preimage(&None, &Some("original-open-head".to_owned())),
            Some("original-open-head".to_owned())
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionsCompareFilesParams {
    #[serde(default)]
    workspace_id: Option<String>,
    source_version_id: String,
    target_version_id: String,
    #[serde(default)]
    after_path: Option<String>,
    #[serde(default)]
    byte_budget: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionsListParams {
    #[serde(default)]
    after_version_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionsCreateNamedParams {
    workspace_id: String,
    name: String,
    from_version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkspaceOnlyParams {
    #[serde(default)]
    pub(crate) workspace_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionsSetActiveParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
}

pub(super) fn version_record_json(version: &VersionRecord) -> Value {
    let mut value = json!({
        "id": version.version_id,
        "workspaceId": version.workspace_id,
        "kind": version.kind.as_str(),
        "name": version.name,
        "createdAtMs": version.created_at_ms,
    });
    if let Some(fork_version_id) = &version.fork_version_id {
        let mut fork_point = json!({ "versionId": fork_version_id });
        if let Some(moment_id) = &version.fork_moment_id {
            fork_point["momentId"] = json!(moment_id);
        }
        value["forkPoint"] = fork_point;
    }
    value
}

impl EngineService {
    pub(super) fn version_fence(&self) -> VersionFence {
        VersionFence {
            sessions: self.sessions.clone(),
            leases: self.leases.clone(),
            self_writes: self.self_writes.clone(),
            events: self.events.clone(),
            capture_apply_probe: self.capture_apply_probe.clone(),
        }
    }
}
#[cfg(test)]
static CLOSE_WRITE_SESSION: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();
#[cfg(test)]
pub(super) fn mutate_close_write_session(id: String) {
    lock(CLOSE_WRITE_SESSION.get_or_init(Mutex::default)).insert(id);
}

impl VersionFence {
    pub(super) fn link_document_is_open(
        &self,
        handle: &WorkspaceHandle,
    ) -> dohc_engine_runtime::actor::DocumentIsOpen {
        let sessions = self.sessions.clone();
        let handle = handle.clone();
        Arc::new(move |key| {
            lock(&sessions)
                .values()
                .any(|s| s.workspace == handle && s.key == *key)
        })
    }

    pub(super) fn link_document_resync(
        &self,
        handle: &WorkspaceHandle,
    ) -> dohc_engine_runtime::actor::DocumentResync {
        let sessions = self.sessions.clone();
        let events = self.events.clone();
        let handle = handle.clone();
        std::sync::Arc::new(move |key| {
            let ids: Vec<_> = lock(&sessions)
                .iter()
                .filter(|(_, session)| session.workspace == handle && session.key == *key)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                events.emit(
                    "ydoc.remoteUpdate",
                    json!({"sessionId":id,"resyncRequired":true}),
                );
            }
        })
    }

    /// Acquire the capture and session barriers in the one per-workspace order
    /// used by version fencing and workspace teardown.
    async fn acquire_workspace_barriers(
        &self,
        open: &OpenWorkspace,
        cancellation: Option<&OperationCancellation>,
        operation: &str,
        pause_after_capture: bool,
    ) -> Result<WorkspaceBarriers, WireError> {
        if pause_after_capture && let Some(probe) = &self.capture_apply_probe {
            probe.observe_version_fence_wait_if_armed();
        }
        let capture = match cancellation {
            Some(cancellation) => {
                tokio::select! {
                    biased;
                    () = cancellation.token.cancelled() => {
                        return Err(cancellation.interruption(
                            &format!("{operation} (capture barrier)")
                        ));
                    }
                    barrier = Arc::clone(&open.capture_apply_gate).lock_owned() => barrier,
                }
            }
            None => Arc::clone(&open.capture_apply_gate).lock_owned().await,
        };

        if pause_after_capture && let Some(probe) = &self.capture_apply_probe {
            probe.pause_version_fence_if_armed().await;
        }

        let sessions = match cancellation {
            Some(cancellation) => {
                tokio::select! {
                    biased;
                    () = cancellation.token.cancelled() => {
                        return Err(cancellation.interruption(
                            &format!("{operation} (ydoc barrier)")
                        ));
                    }
                    serial = Arc::clone(&open.session_ops).lock_owned() => serial,
                }
            }
            None => Arc::clone(&open.session_ops).lock_owned().await,
        };
        Ok(WorkspaceBarriers {
            _capture: capture,
            _sessions: sessions,
        })
    }
}
impl EngineService {
    /// Acquire the ordering guard shared with `ydoc.open` before probing a
    /// path lease. The caller must retain the returned owned guard until its
    /// actor mutation has completed: check-without-lease -> mutation and
    /// probe -> lease -> authoritative re-read are mutually exclusive orders.
    pub(super) async fn mutation_session_guard(
        &self,
        open: &OpenWorkspace,
        cancellation: &OperationCancellation,
        operation: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, WireError> {
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                Err(cancellation.interruption(operation))
            }
            serial = Arc::clone(&open.session_ops).lock_owned() => Ok(serial),
        }
    }

    pub(super) async fn ensure_path_not_leased(
        &self,
        open: &OpenWorkspace,
        version_id: &str,
        path: &str,
    ) -> Result<(), WireError> {
        let canonical_path = validate_addressable_plaintext_path(path)
            .map_err(|error| map_runtime(RuntimeError::Domain(error)))?;
        open.actor
            .ensure_history_undo_path_available(
                open.workspace_id.clone(),
                version_id.to_owned(),
                canonical_path.clone(),
            )
            .await
            .map_err(map_runtime)?;
        let existing = match open
            .actor
            .resolve_path_object(
                open.workspace_id.clone(),
                version_id.to_owned(),
                canonical_path.clone(),
            )
            .await
        {
            Ok(existing) => existing,
            Err(RuntimeError::Domain(
                DomainError::WorkspaceNotFound | DomainError::VersionNotFound,
            )) => None,
            Err(error) => return Err(map_runtime(error)),
        };
        let object_id = existing.unwrap_or_else(|| {
            dohc_engine_domain::derive_capture_object_id(
                &open.workspace_id,
                version_id,
                &canonical_path,
            )
        });
        let key = DocKey::new(open.workspace_id.clone(), version_id.to_owned(), object_id)
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-input"))?;
        if self.leases.scoped(&open.root).is_held(&key) {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "ydoc-session-busy",
            ));
        }
        Ok(())
    }

    pub(super) async fn versions_create_named(
        &self,
        ctx: &RequestContext,
        request: Request,
    ) -> Result<Value, WireError> {
        let params: VersionsCreateNamedParams = parse(request.params)?;
        let handle = request
            .workspace
            .as_ref()
            .ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(handle))?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let new_version_id = self.generated_rpc_id(
            "version",
            request.id,
            request.idempotency_key.as_deref(),
            &params.name,
        );
        let cancellation = OperationCancellation::new(ctx);
        let input = CreateNamedVersion {
            workspace_id: open.workspace_id.clone(),
            new_version_id,
            name: params.name,
            from_version_id: params.from_version_id,
            now_ms: now_ms()?,
            request_id: request.idempotency_key,
        };
        // Reject missing sources, bad/taken names, duplicate ids, and
        // idempotency mismatches before the destructive session sweep and full
        // scan. An exact replay returns its original version without fencing.
        if let Some(version) = Self::read_under_ctx(
            &cancellation,
            "versions.createNamed (preflight)",
            open.actor
                .preflight_create_named_version(input.clone(), cancellation.token()),
        )
        .await?
        {
            return Ok(version_record_json(&version));
        }
        let fence = self
            .version_fence()
            .fence_version_snapshot(
                &cancellation,
                open,
                handle,
                "versions.createNamed",
                "Saved latest edits before creating a version",
                VersionFenceIntent::Fork {
                    input: input.clone(),
                },
            )
            .await?;
        match fence {
            VersionFenceOutcome::CreateReplay(version) => Ok(version_record_json(&version)),
            VersionFenceOutcome::AlreadyActive => {
                unreachable!("fork fences never return AlreadyActive");
            }
            VersionFenceOutcome::Committed(version) => Ok(version_record_json(&version)),
            VersionFenceOutcome::UndoCommitted(_) => unreachable!("version fences never undo"),
        }
    }

    pub(super) async fn history_undo(
        &self,
        ctx: &RequestContext,
        request: Request,
    ) -> Result<Value, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            operation_id: String,
            author: Option<Value>,
        }
        let params: Params = parse(request.params)?;
        let handle = request
            .workspace
            .as_ref()
            .ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(handle))?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "history.undo needs the workspace's owning handle",
            ));
        }
        let request_id = crate::rpc::request::required_idempotency_key(request.idempotency_key)?;
        let author_json = crate::rpc::request::validated_author(params.author.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let result = self
            .version_fence()
            .fence_version_snapshot(
                &cancellation,
                open,
                handle,
                "history.undo",
                "Undo settlement",
                VersionFenceIntent::Undo {
                    operation_id: params.operation_id,
                    request_id,
                    author_json,
                },
            )
            .await?;
        match result {
            VersionFenceOutcome::UndoCommitted(result) => Ok(history_undo_result_json(&result)),
            _ => unreachable!("Undo fence returns its own result"),
        }
    }
}
impl VersionFence {
    async fn resume_history_undo(
        &self,
        open: &Arc<OpenWorkspace>,
        result: dohc_engine_runtime::HistoryUndoResult,
    ) -> dohc_engine_runtime::HistoryUndoResult {
        if result.materialized {
            return result;
        }
        if !matches!(open.actor.active_version_id(open.workspace_id.clone()).await, Ok(version) if version == result.version_id)
        {
            return result;
        }
        let leases = self.leases.scoped(&open.root);
        let mut held = HashMap::new();
        for member in &result.moments {
            if held.contains_key(&member.object_id)
                || (member.operation == "write"
                    && lock(&self.sessions).values().any(|session| {
                        session.key.workspace_id == open.workspace_id
                            && session.key.version_id == result.version_id
                            && session.key.object_id == member.object_id
                    }))
            {
                continue;
            }
            let Ok(key) = DocKey::new(&open.workspace_id, &result.version_id, &member.object_id)
            else {
                return result;
            };
            let Ok(lease) = leases.acquire_internal(&key) else {
                // Keep the existing lease; pending jobs remain replayable.
                return result;
            };
            held.insert(member.object_id.clone(), lease);
        }
        let Ok(now) = now_ms() else {
            return result;
        };
        let pending = result.clone();
        let open = Arc::clone(open);
        let recorder = Arc::new(self.self_writes.scoped(&open.root));
        tokio::spawn(async move {
            open.actor
                .history_undo_place(
                    open.workspace_id.clone(),
                    pending,
                    open.root.clone(),
                    recorder,
                    now,
                    |members| {
                        for member in members {
                            held.remove(&member.object_id);
                        }
                    },
                )
                .await;
        });
        result
    }

    /// Freeze the active workspace snapshot before a version fork or switch.
    ///
    /// Lock order is per-workspace capture gate first, then that workspace's
    /// Y.Doc/session mutation gate — the same helper used by workspace.close.
    /// Once both are held, no capture apply or session admission can straddle
    /// the session sweep, forced reconcile, and version transaction. After the
    /// fenced preflight, fork and switch continue in an owned task. Undo runs
    /// inline on the request cancellation token and stops between committed turns.
    pub(super) async fn fence_version_snapshot(
        &self,
        cancellation: &OperationCancellation,
        open: Arc<OpenWorkspace>,
        handle: &WorkspaceHandle,
        operation: &str,
        settle_summary: &str,
        intent: VersionFenceIntent,
    ) -> Result<VersionFenceOutcome, WireError> {
        let barriers = self
            .acquire_workspace_barriers(&open, Some(cancellation), operation, true)
            .await?;

        let (reconcile_version_id, fork_source_version_id) = match &intent {
            VersionFenceIntent::Undo {
                operation_id,
                request_id,
                author_json,
            } => {
                if let Some(replay) = EngineService::read_under_ctx(
                    cancellation,
                    "history.undo (fenced availability)",
                    open.actor.preflight_history_undo(
                        open.workspace_id.clone(),
                        operation_id.clone(),
                        request_id.clone(),
                        author_json.clone(),
                    ),
                )
                .await?
                {
                    return Ok(VersionFenceOutcome::UndoCommitted(
                        self.resume_history_undo(&open, replay).await,
                    ));
                }
                (
                    EngineService::read_under_ctx(
                        cancellation,
                        "history.undo (active version)",
                        open.actor.active_version(open.workspace_id.clone()),
                    )
                    .await?
                    .version_id,
                    None,
                )
            }
            VersionFenceIntent::Fork { input } => {
                // The preflight is intentionally repeated while the fence is
                // held: a competing create may have won between the cheap
                // outer check and acquisition. Reject or replay before any
                // session is closed.
                if let Some(version) = EngineService::read_under_ctx(
                    cancellation,
                    "versions.createNamed (fenced preflight)",
                    open.actor
                        .preflight_create_named_version(input.clone(), cancellation.token()),
                )
                .await?
                {
                    return Ok(VersionFenceOutcome::CreateReplay(version));
                }
                let active = EngineService::read_under_ctx(
                    cancellation,
                    "versions.createNamed (active version)",
                    open.actor.active_version(open.workspace_id.clone()),
                )
                .await?;
                (active.version_id, Some(input.from_version_id.clone()))
            }
            VersionFenceIntent::Switch {
                target_version_id, ..
            } => {
                let active = EngineService::read_under_ctx(
                    cancellation,
                    "versions.setActive (fenced active recheck)",
                    open.actor.active_version(open.workspace_id.clone()),
                )
                .await?;
                if active.version_id == *target_version_id {
                    return Ok(VersionFenceOutcome::AlreadyActive);
                }
                (active.version_id, None)
            }
        };

        let undo_group = if let VersionFenceIntent::Undo { operation_id, .. } = &intent {
            Some(
                EngineService::read_under_ctx(
                    cancellation,
                    "history.undo (scope)",
                    open.actor
                        .history_operation(open.workspace_id.clone(), operation_id.clone()),
                )
                .await?
                .moments,
            )
        } else {
            None
        };
        let undo_writes = if let VersionFenceIntent::Undo { operation_id, .. } = &intent {
            EngineService::read_under_ctx(
                cancellation,
                "history.undo (open writes)",
                open.actor
                    .history_undo_open_writes(open.workspace_id.clone(), operation_id.clone()),
            )
            .await?
        } else {
            std::collections::HashSet::new()
        };
        let resync = self.link_document_resync(handle);
        let is_open = self.link_document_is_open(handle);
        let undo_objects = undo_group.as_ref().map(|members| {
            members
                .iter()
                .map(|m| m.object_id.clone())
                .collect::<std::collections::HashSet<_>>()
        });
        let undo_paths = undo_group.as_ref().map(|members| {
            members
                .iter()
                .flat_map(|m| std::iter::once(m.path.clone()).chain(m.before_path.clone()))
                .collect::<std::collections::HashSet<_>>()
        });
        let session_views: Vec<(String, DocKey, ContentKind)> = lock(&self.sessions)
            .iter()
            .filter(|(_, session)| {
                session.workspace == *handle
                    && session.key.version_id == reconcile_version_id
                    && undo_objects.as_ref().is_none_or(|objects| {
                        objects.contains(&session.key.object_id)
                            || undo_paths
                                .as_ref()
                                .is_some_and(|paths| paths.contains(&session.path))
                    })
            })
            .map(|(session_id, session)| {
                (
                    session_id.clone(),
                    session.key.clone(),
                    session.content_kind,
                )
            })
            .collect();
        let session_ids: Vec<String> = session_views
            .iter()
            .map(|(session_id, _, _)| session_id.clone())
            .collect();

        if let Some(source_version_id) = fork_source_version_id.as_ref()
            && let Some(content_kind) = EngineService::read_under_ctx(
                cancellation,
                "versions.createNamed (source ydoc preflight)",
                open.actor.ydoc_version_unsettled_content_kind(
                    open.workspace_id.clone(),
                    source_version_id.clone(),
                    if source_version_id == &reconcile_version_id {
                        session_views
                            .iter()
                            .map(|(_, key, _)| key.object_id.clone())
                            .collect()
                    } else {
                        Vec::new()
                    },
                    cancellation.token(),
                ),
            )
            .await?
        {
            return Err(unsettled_fork_error(content_kind));
        }

        let (capture_status, capture_author_json) = lock(&open.capture)
            .as_ref()
            .map(|driver| (Arc::clone(driver.status()), driver.author_json()))
            .ok_or_else(|| {
                WireError::new(
                    ErrorCode::WorkspaceUnavailable,
                    "capture driver unavailable",
                )
            })?;
        let handle = handle.clone();
        let sessions = Arc::clone(&self.sessions);
        let leases = self.leases.clone();
        let self_writes = self.self_writes.clone();
        let events = self.events.clone();
        let detached_operation = operation.to_owned();
        let settle_summary = settle_summary.to_owned();
        // The fence's forced reconcile is a capture pass (TS parity:
        // `version-switch-${id}` / `version-create-${id}`): its moments carry
        // the fence's own summary and one correlation id so the pre-switch
        // "nothing is ever lost" capture groups in history instead of
        // rendering as unrelated per-file rows.
        let reconcile_provenance = capture_sink::CaptureProvenance {
            summary: Some(settle_summary.clone()),
            correlation_id: Some(capture_driver::pass_correlation_id(match &intent {
                VersionFenceIntent::Fork { .. } => "version-create",
                VersionFenceIntent::Switch { .. } => "version-switch",
                VersionFenceIntent::Undo { .. } => "history-undo",
            })),
        };
        let probe = self.capture_apply_probe.clone();
        let undo = matches!(&intent, VersionFenceIntent::Undo { .. });
        let request_token = cancellation.token();
        let fence = async move {
            let _barriers = barriers;
            let token = if undo {
                request_token
            } else {
                CancellationToken::new()
            };
            for session_id in session_ids {
                let view = version_fence_session_view(&sessions, &handle, &session_id)?;
                let keep_write = undo && undo_writes.contains(&view.key.object_id);
                #[cfg(test)]
                let keep_write = keep_write
                    && !lock(CLOSE_WRITE_SESSION.get_or_init(Mutex::default)).remove(&session_id);
                if keep_write {
                    settle_fence_session(
                        &sessions,
                        &self_writes,
                        &events,
                        &open,
                        &handle,
                        &session_id,
                        &token,
                    )
                    .await?;
                } else {
                    close_ydoc_session_for_version_fence(
                        &sessions,
                        &self_writes,
                        &events,
                        &open,
                        &handle,
                        &session_id,
                        &settle_summary,
                        &token,
                    )
                    .await?;
                }
            }

            if let VersionFenceIntent::Fork { input } = &intent
                && let Some(content_kind) = open
                    .actor
                    .ydoc_version_unsettled_content_kind(
                        open.workspace_id.clone(),
                        input.from_version_id.clone(),
                        Vec::new(),
                        token.clone(),
                    )
                    .await
                    .map_err(map_runtime)?
            {
                return Err(unsettled_fork_error(content_kind));
            }

            let mut unpublished = std::collections::HashSet::new();
            if let VersionFenceIntent::Undo { operation_id, .. } = &intent {
                let (preimages, jobs) = open
                    .actor
                    .history_undo_pending_publication(
                        open.workspace_id.clone(),
                        operation_id.clone(),
                        open.root.clone(),
                        token.clone(),
                    )
                    .await
                    .map_err(map_runtime)?;
                unpublished.extend(preimages.into_keys());
                for jobs in jobs.chunks(16) {
                    if token.is_cancelled() {
                        return Err(map_runtime(dohc_engine_runtime::RuntimeError::Cancelled));
                    }
                    open.actor
                        .materialize_replay_selected_for_fence(
                            open.root.clone(),
                            open.workspace_id.clone(),
                            Arc::new(self_writes.scoped(&open.root)),
                            jobs.to_vec(),
                            now_ms()?,
                        )
                        .await
                        .map_err(map_runtime)?;
                }
            } else {
                open.actor
                    .materialize_replay_pending_for_fence(
                        open.root.clone(),
                        open.workspace_id.clone(),
                        Arc::new(self_writes.scoped(&open.root)),
                        now_ms()?,
                    )
                    .await
                    .map_err(map_runtime)?;
            }

            if let Some(probe) = &probe {
                probe.record_version_scan();
            }
            let capture_leases = leases.scoped(&open.root);
            let reconcile = capture_driver::reconcile_full_for_switch(
                &open.root,
                &open.actor,
                &open.workspace_id,
                &capture_leases,
                &capture_status,
                &self_writes.scoped(&open.root),
                capture_author_json,
                match &intent {
                    VersionFenceIntent::Undo { operation_id, .. } => {
                        Some((operation_id.as_str(), &unpublished))
                    }
                    _ => None,
                },
                reconcile_provenance,
                events.clone(),
                token.clone(),
            )
            .await;

            if !matches!(reconcile, Ok(false))
                && !matches!(&intent, VersionFenceIntent::Undo { .. })
            {
                let capture = lock(&open.capture);
                let driver = capture.as_ref().ok_or_else(|| {
                    WireError::new(
                        ErrorCode::WorkspaceUnavailable,
                        "capture driver unavailable",
                    )
                })?;
                driver.request_manifest_refresh();
            }
            reconcile.map_err(|error| map_switch_reconcile_error(error, &detached_operation))?;

            if let Some(probe) = &probe {
                probe.pause_version_commit_if_armed().await;
            }

            let version = match intent {
                VersionFenceIntent::Undo {
                    operation_id,
                    request_id,
                    author_json,
                } => {
                    let mut undo_leases = undo_objects
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|object| {
                            !lock(&sessions).values().any(|s| {
                                s.workspace == handle
                                    && s.key.object_id == *object
                                    && s.key.version_id == reconcile_version_id
                            })
                        })
                        .map(|object| {
                            let key =
                                DocKey::new(&open.workspace_id, &reconcile_version_id, &object)
                                    .map_err(|e| map_runtime(e.into()))?;
                            capture_leases
                                .acquire_internal(&key)
                                .map(|lease| (object, lease))
                                .map_err(|e| map_runtime(e.into()))
                        })
                        .collect::<Result<std::collections::HashMap<_, _>, WireError>>()?;
                    let placement_now = now_ms()?;
                    drop(_barriers);
                    let result = Box::pin(open.actor.history_undo_in_turns(
                        open.workspace_id.clone(),
                        operation_id,
                        request_id,
                        author_json,
                        open.root.clone(),
                        Arc::new(NoFaults),
                        placement_now,
                        [open.capture_apply_gate.clone(), open.session_ops.clone()],
                        Arc::new(self_writes.scoped(&open.root)),
                        Some((is_open, resync)),
                        token,
                    ))
                    .await
                    .map_err(map_runtime)?;
                    let pending = result.clone();
                    tokio::spawn(async move {
                        if let Some(probe) = &probe {
                            probe.pause_undo_placement_if_armed().await;
                        }
                        let _placed = open
                            .actor
                            .history_undo_place(
                                open.workspace_id.clone(),
                                pending,
                                open.root.clone(),
                                Arc::new(self_writes.scoped(&open.root)),
                                placement_now,
                                |members| {
                                    for member in members {
                                        undo_leases.remove(&member.object_id);
                                    }
                                },
                            )
                            .await;
                        // Placement receipts and watcher events update the existing manifest.
                        // Rebuilding it here would rehash unrelated files on the next Undo.
                    });
                    return Ok(VersionFenceOutcome::UndoCommitted(result));
                }
                VersionFenceIntent::Fork { input } => open
                    .actor
                    .create_named_version(input, Arc::new(NoFaults), token)
                    .await
                    .map_err(map_runtime)?,
                VersionFenceIntent::Switch {
                    target_version_id,
                    now_ms: switch_now_ms,
                } => {
                    let version = open
                        .actor
                        .set_active_version(
                            dohc_engine_runtime::ActiveVersionSwitch {
                                workspace_id: open.workspace_id.clone(),
                                version_id: target_version_id,
                                root_dir: open.root.clone(),
                                self_writes: Arc::new(self_writes.scoped(&open.root)),
                                now_ms: switch_now_ms,
                            },
                            Arc::new(NoFaults),
                            token.clone(),
                        )
                        .await
                        .map_err(map_runtime)?;
                    match open
                        .actor
                        .reconcile_collections(
                            open.workspace_id.clone(),
                            version.version_id.clone(),
                            open.root.clone(),
                            capture_leases.clone(),
                            Arc::new(self_writes.scoped(&open.root)),
                            now_ms()?,
                            Arc::new(NoFaults),
                            token,
                        )
                        .await
                    {
                        Ok(reconciliation) => {
                            if reconciliation.lease_held {
                                capture_status.request_collection_reconcile();
                            }
                        }
                        Err(error) => {
                            // The switch is durable. The capture driver already retries
                            // collection reconciliation on its next pass.
                            capture_status.request_collection_reconcile();
                            capture_status.mark_degraded();
                            eprintln!(
                                "engine: version switch committed but collection reconciliation \
                             failed; capture will retry: {error}"
                            );
                        }
                    }
                    version
                }
            };
            Ok(VersionFenceOutcome::Committed(version))
        };
        if undo {
            // Fork and switch share this future type with the inline Undo continuation.
            return Box::pin(fence).await;
        }
        // Version switches finish even if their request leaves.
        tokio::spawn(fence)
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "version fence task failed"))?
    }
}
impl EngineService {
    pub(super) async fn versions_compare_files(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionsCompareFilesParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "versions.compareFiles",
            open.actor.compare_version_files_page(
                open.workspace_id.clone(),
                params.source_version_id,
                params.target_version_id,
                params.after_path,
                200,
            ),
        )
        .await?;
        let entries: Vec<Value> = page
            .entries
            .iter()
            .map(|change| {
                let status = match change.status {
                    VersionFileChangeStatus::Added => "added",
                    VersionFileChangeStatus::Modified => "modified",
                    VersionFileChangeStatus::Deleted => "deleted",
                };
                if change.binary {
                    json!({ "path": change.path, "status": status, "binary": true })
                } else {
                    json!({ "path": change.path, "status": status })
                }
            })
            .collect();
        let budget = params
            .byte_budget
            .unwrap_or(MOMENTS_PAGE_BYTE_BUDGET)
            .clamp(1, SINGLE_ROW_HARD_CAP_BYTES);
        let included = byte_budget_cut_serialized(&entries, budget);
        if included == 0 && !entries.is_empty() {
            return Err(WireError::new(ErrorCode::InvalidParams, "invalid-input"));
        }
        let byte_truncated = included < entries.len();
        let next_cursor = if byte_truncated {
            entries[included - 1]["path"].as_str().map(str::to_owned)
        } else {
            page.next_after_path
        };
        Ok(json!({
            "entries": entries[..included].to_vec(),
            "nextCursor": next_cursor,
        }))
    }

    pub(super) async fn versions_active(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: WorkspaceOnlyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let version = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("versions.active"));
            }
            result = open.actor.active_version(open.workspace_id.clone()) => match result {
                Ok(version) => version,
                Err(RuntimeError::Domain(DomainError::WorkspaceNotFound)) => return Ok(Value::Null),
                Err(error) => return Err(map_runtime(error)),
            },
        };
        Ok(version_record_json(&version))
    }

    pub(super) async fn versions_ensure_main(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: WorkspaceOnlyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let version = open
            .actor
            .ensure_main_version(
                open.workspace_id.clone(),
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(version_record_json(&version))
    }

    pub(super) async fn versions_set_active(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionsSetActiveParams = parse(params)?;
        if params.version_id.is_empty() || params.version_id.trim() != params.version_id {
            return Err(WireError::new(ErrorCode::InvalidParams, "invalid-version"));
        }
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(&handle))?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        // Oracle ordering: reject an unknown target, and return a true no-op
        // for the already-active version, before disturbing live sessions.
        let versions = Self::read_under_ctx(
            &cancellation,
            "versions.setActive (target validation)",
            open.actor.list_versions(open.workspace_id.clone()),
        )
        .await?;
        let target = versions
            .into_iter()
            .find(|version| version.version_id == params.version_id)
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "version-not-found"))?;
        let active = Self::read_under_ctx(
            &cancellation,
            "versions.setActive (active version)",
            open.actor.active_version(open.workspace_id.clone()),
        )
        .await?;
        if active.version_id == target.version_id {
            return Ok(version_record_json(&target));
        }

        let fence = self
            .version_fence()
            .fence_version_snapshot(
                &cancellation,
                open,
                &handle,
                "versions.setActive",
                "Saved latest edits before switching versions",
                VersionFenceIntent::Switch {
                    target_version_id: target.version_id.clone(),
                    now_ms: now_ms()?,
                },
            )
            .await?;
        match fence {
            VersionFenceOutcome::AlreadyActive => Ok(version_record_json(&target)),
            VersionFenceOutcome::CreateReplay(_) => {
                unreachable!("switch fences never return CreateReplay");
            }
            VersionFenceOutcome::Committed(version) => Ok(version_record_json(&version)),
            VersionFenceOutcome::UndoCommitted(_) => unreachable!("version fences never undo"),
        }
    }

    pub(super) async fn versions_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionsListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let mut versions = Self::read_under_ctx(
            &cancellation,
            "versions.list",
            open.actor.list_versions(open.workspace_id.clone()),
        )
        .await?;
        // Keyset resume over the domain's stable ordering: the composite
        // sort key makes a SQL cursor awkward, and version counts are
        // small — resuming positionally over the loaded ordered vector is
        // exact (the id either exists at one position or the cursor is
        // stale and reads from the start).
        if let Some(after) = params.after_version_id.as_deref() {
            if let Some(position) = versions
                .iter()
                .position(|version| version.version_id == after)
            {
                versions.drain(..=position);
            }
        }
        // Versions are few in practice, but the frame limit does not care
        // about practice: same measured budget + honest truncated flag as
        // every other list family.
        let row_values: Vec<Value> = versions
            .iter()
            .map(|version| {
                json!({
                    "versionId": version.version_id,
                    "kind": version.kind.as_str(),
                    "name": version.name,
                    "createdAtMs": version.created_at_ms,
                    "forkVersionId": version.fork_version_id,
                    "forkMomentId": version.fork_moment_id,
                })
            })
            .collect();
        let included = byte_budget_cut_serialized(&row_values, MOMENTS_PAGE_BYTE_BUDGET);
        if included == 0 && !row_values.is_empty() {
            return Err(WireError::new(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let truncated = included < row_values.len();
        let next_after_version_id = truncated
            .then(|| versions[..included].last().map(|v| v.version_id.clone()))
            .flatten();
        Ok(json!({
            "versions": row_values[..included].to_vec(),
            "nextAfterVersionId": next_after_version_id,
        }))
    }
}

#[cfg(test)]
mod tests {
    use crate::EngineService;
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_protocol::wire::Request;
    use dohc_engine_protocol::wire::WorkspaceHandle;
    use dohc_engine_runtime::WorkspaceSupervisor;
    use dohc_engine_testkit::ScratchDir;
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn history_operation_replies_before_placement() {
        undo_placement_proof(0).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn history_operation_restored_path_is_leased_during_final_placement() {
        undo_placement_proof(1).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn history_operation_retry_held_after_immediate_rename_placement() {
        undo_placement_proof(2).await;
    }

    async fn placement_gate_available(gate: &tokio::sync::Mutex<()>) -> bool {
        tokio::time::timeout(Duration::from_secs(10), async {
            drop(gate.lock().await);
        })
        .await
        .is_ok()
    }

    #[tokio::test]
    async fn placement_gate_probe_waits_for_transient_contention() {
        let gate = tokio::sync::Mutex::new(());
        let held = gate.lock().await;
        assert!(gate.try_lock().is_err());
        // Poll the probe while an unrelated mutation holds the gate, then release it.
        let (available, ()) = tokio::join!(
            biased;
            placement_gate_available(&gate),
            async { drop(held) },
        );
        assert!(
            available,
            "the probe must wait for transient gate contention"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn placement_gate_probe_refuses_persistent_contention() {
        let gate = tokio::sync::Mutex::new(());
        let held = gate.lock().await;
        assert!(
            !placement_gate_available(&gate).await,
            "the probe must refuse a gate held throughout the call"
        );
        drop(held);
    }

    async fn undo_placement_proof(mode: u8) {
        use dohc_engine_domain::{RenameTextFile, VersionedTextStore, WriteText};
        use dohc_engine_storage::{EngineStore, NoFaults};
        let scratch = ScratchDir::new().unwrap();
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
        let mut store =
            EngineStore::open(&dohc_engine_testkit::engine_db_path(&scratch).unwrap(), 1).unwrap();
        store.bind_root_token(token, &NoFaults).unwrap();
        let mut domain = VersionedTextStore::new(&mut store);
        domain
            .ensure_main_version("undo-placement", "main", 1, &NoFaults)
            .unwrap();
        domain
            .write_text(
                &WriteText {
                    workspace_id: "undo-placement".into(),
                    version_id: "main".into(),
                    object_id: "one".into(),
                    path: "old.md".into(),
                    text: "Content".into(),
                    moment_id: "seed".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                },
                &NoFaults,
            )
            .unwrap();
        domain
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: "undo-placement".into(),
                    version_id: "main".into(),
                    from_path: "old.md".into(),
                    to_path: "new.md".into(),
                    moment_id: "move".into(),
                    request_id: None,
                    metadata_origin: "api".into(),
                    metadata_summary: None,
                    metadata_correlation_id: Some("dohc-operation:move".into()),
                    author_json: None,
                    now_ms: 3,
                },
                &NoFaults,
            )
            .unwrap();
        if mode == 2 {
            domain
                .write_text(
                    &WriteText {
                        workspace_id: "undo-placement".into(),
                        version_id: "main".into(),
                        object_id: "held".into(),
                        path: "held.txt".into(),
                        text: "Before".into(),
                        moment_id: "held-seed".into(),
                        request_id: None,
                        metadata_origin: "api".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 4,
                    },
                    &NoFaults,
                )
                .unwrap();
            std::fs::write(scratch.path().join("held.txt"), "Held outside").unwrap();
            store
                .write_with(&NoFaults, |tx| {
                    dohc_engine_storage::capture_file_holds::record_in(
                        tx,
                        &dohc_engine_storage::capture_file_holds::CaptureFileHold {
                            workspace_id: "undo-placement".into(),
                            source_version_id: "main".into(),
                            object_id: "held".into(),
                            path: "held.txt".into(),
                            observed_sha256: dohc_engine_storage::hex_sha256(b"Held outside"),
                            observed_size: 12,
                            reason: dohc_engine_storage::capture_file_holds::NOT_REPRESENTABLE
                                .into(),
                            observed_at_ms: 4,
                            attempt_count: 1,
                            retry_requested: false,
                        },
                    )
                })
                .unwrap();
        }
        std::fs::write(scratch.path().join("new.md"), "Content").unwrap();
        drop(store);
        let probe = crate::capture_driver::CaptureApplyProbe::default();
        let service = Arc::new(EngineService::with_capture_apply_probe_for_harness(
            probe.clone(),
        ));
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir":scratch.path().to_string_lossy(),"workspaceId":"undo-placement"
                }),
            )
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let open = service.open(Some(&handle)).unwrap();
        let refreshes = probe.manifest_refresh_count();
        probe.pause_next_undo_placement();
        let undo_service = Arc::clone(&service);
        let undo_handle = handle.clone();
        let mut undo = tokio::spawn(async move {
            undo_service
                .history_undo(
                    &RequestContext::unbounded(),
                    Request {
                        id: 100,
                        method: "history.undo".into(),
                        workspace: Some(undo_handle),
                        deadline_ms: None,
                        idempotency_key: Some("undo".into()),
                        progress: false,
                        params: json!({"operationId":"dohc-operation:move"}),
                    },
                )
                .await
        });
        tokio::time::timeout(
            Duration::from_secs(10),
            probe.wait_until_undo_placement_paused(),
        )
        .await
        .unwrap();
        if mode == 1 {
            let admission = service
                .ensure_path_not_leased(&open, "main", "old.md")
                .await;
            if admission.is_ok() {
                probe.release_undo_placement();
                let _ = undo.await;
                service.workspace_close(Some(handle)).await.unwrap();
                panic!("the restored object must stay leased until final placement");
            }
        }
        let reply = tokio::time::timeout(Duration::from_secs(2), &mut undo).await;
        if reply.is_err() {
            probe.release_undo_placement();
            let _ = undo.await;
            service.workspace_close(Some(handle)).await.unwrap();
            panic!("Undo reply must arrive before paused placement finishes");
        }
        let result = reply.unwrap().unwrap().unwrap();
        assert_eq!(result["materialized"], false);
        assert!(scratch.path().join("old.md").exists());
        assert!(!scratch.path().join("new.md").exists());
        if mode == 2 {
            let replay = open
                .actor
                .preflight_history_undo(
                    "undo-placement".into(),
                    "dohc-operation:move".into(),
                    "undo".into(),
                    None,
                )
                .await
                .unwrap()
                .unwrap();
            let member = &replay.moments[0];
            assert!(scratch.path().join("old.md").exists());
            assert!(!scratch.path().join("new.md").exists());
            let retried = service
                .capture_retry_held(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    json!({"path":"held.txt"}),
                )
                .await
                .unwrap();
            assert_eq!(retried["retried"], true);
            assert!(probe.manifest_refresh_count() > refreshes);
            assert_eq!(
                std::fs::read_to_string(scratch.path().join("old.md")).unwrap(),
                "Content"
            );
            assert!(!scratch.path().join("new.md").exists());
            let pending = open
                .actor
                .preflight_history_undo(
                    "undo-placement".into(),
                    "dohc-operation:move".into(),
                    "undo".into(),
                    None,
                )
                .await
                .unwrap()
                .unwrap();
            assert!(
                pending.materialized,
                "the rename was placed before the reply"
            );
            assert_eq!(pending.moments[0].moment_id, member.moment_id);
            assert_eq!(
                open.actor
                    .resolve_path_object("undo-placement".into(), "main".into(), "old.md".into())
                    .await
                    .unwrap(),
                Some("one".into())
            );
            assert_eq!(
                open.actor
                    .resolve_path_object("undo-placement".into(), "main".into(), "new.md".into())
                    .await
                    .unwrap(),
                None
            );
        }
        // Placement stays paused until both probes finish; it cannot release a held gate to pass.
        let sessions_available = placement_gate_available(&open.session_ops).await;
        let capture_available = placement_gate_available(&open.capture_apply_gate).await;
        if !sessions_available || !capture_available {
            probe.release_undo_placement();
            let _ = service.workspace_close(Some(handle.clone())).await;
        }
        assert!(
            sessions_available,
            "session mutations must resume before file placement"
        );
        assert!(
            capture_available,
            "capture must resume for unrelated paths before file placement"
        );
        let protected_key =
            dohc_engine_collab::DocKey::new("undo-placement", "main", "one").unwrap();
        let affected_protected = service.leases.scoped(&open.root).is_held(&protected_key);
        let retry = tokio::time::timeout(
            Duration::from_secs(20),
            service.history_undo(
                &RequestContext::unbounded(),
                Request {
                    id: 101,
                    method: "history.undo".into(),
                    workspace: Some(handle.clone()),
                    deadline_ms: None,
                    idempotency_key: Some("undo".into()),
                    progress: false,
                    params: json!({"operationId":"dohc-operation:move"}),
                },
            ),
        )
        .await;
        let committed = open
            .actor
            .active_version(open.workspace_id.clone())
            .await
            .unwrap();
        assert_eq!(committed.version_id, "main");
        probe.release_undo_placement();
        tokio::time::timeout(Duration::from_secs(10), async {
            while service.leases.scoped(&open.root).is_held(&protected_key) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        service.workspace_close(Some(handle)).await.unwrap();
        let retry = retry
            .expect("committed retry must not wait for placement")
            .expect("committed retry must not reconcile again");
        assert_eq!(retry["deduped"], true);
        assert_eq!(retry["materialized"], true);
        assert_eq!(
            retry["compensationOperationId"],
            result["compensationOperationId"]
        );
        assert_eq!(result["materialized"], false);
        assert!(
            affected_protected,
            "the pending object must remain protected"
        );
        assert!(
            !service.leases.scoped(&open.root).is_held(&protected_key),
            "placed objects must release their leases"
        );
        if mode != 2 {
            assert_eq!(
                probe.manifest_refresh_count(),
                refreshes,
                "Undo must keep the workspace manifest"
            );
        }
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("old.md")).unwrap(),
            "Content"
        );
        assert!(!scratch.path().join("new.md").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mutation_write_waits_for_session_ops_before_lease_check_and_commit() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "mutation-session-serial"
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        let open = service.open(Some(&handle)).expect("open workspace");
        let held = Arc::clone(&open.session_ops).lock_owned().await;
        let writing_service = Arc::clone(&service);
        let writing_handle = handle.clone();
        let mut writing = tokio::spawn(async move {
            let ctx = RequestContext::unbounded();
            let request = Request {
                id: 1,
                method: "versionedText.write".to_owned(),
                workspace: Some(writing_handle),
                deadline_ms: None,
                idempotency_key: Some("mutation-session-serial-write".to_owned()),
                progress: false,
                params: json!({
                    "versionId": "main",
                    "path": "serialized.md",
                    "text": "must wait",
                    "origin": "api"
                }),
            };
            writing_service.versioned_text_write(&ctx, request).await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut writing)
                .await
                .is_err(),
            "the write path must block behind the same guard held by ydoc.open"
        );

        drop(held);
        tokio::time::timeout(Duration::from_secs(10), writing)
            .await
            .expect("write completed after guard release")
            .expect("write task")
            .expect("versioned text write");
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
    }
}

#[cfg(test)]
#[path = "link_rewrite_rpc_tests.rs"]
mod link_rewrite_rpc_tests;
