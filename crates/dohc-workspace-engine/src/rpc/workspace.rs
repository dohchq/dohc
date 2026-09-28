use crate::EngineService;
use crate::SelfWriteSuppression;
use crate::automation_recovery;
use crate::capture_driver;
use crate::lock;
use crate::root_binding;
use crate::rpc::automations::AUTOMATION_CLAIM_MAX_ATTEMPTS;
use crate::rpc::automations::AUTOMATION_CLAIM_REAP_IDLE_MS;
use crate::rpc::chats::dispatch::CHAT_DISPATCH_MAX_ATTEMPTS;
use crate::rpc::error::map_root_binding;
use crate::rpc::error::map_runtime;
use crate::rpc::error::workspace_unavailable;
use crate::rpc::relay::RelayOpenParams;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::validated_author;
use crate::rpc::ydoc::YdocSession;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::ProgressSink;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::ActorHandle;
use dohc_engine_runtime::FaultInjector;
#[cfg(test)]
use dohc_engine_runtime::LifecycleState;
use dohc_engine_runtime::NoFaults;
use dohc_engine_runtime::RelayConfiguration;
use dohc_engine_runtime::WorkspaceSupervisor;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub(super) const MAX_OPEN_HANDLES: usize = 64;

pub(crate) struct OpenWorkspace {
    pub(super) root: PathBuf,
    pub(super) db_path: PathBuf,
    pub(crate) workspace_id: String,
    pub(super) actor: ActorHandle,
    pub(super) mode: WorkspaceOpenMode,
    handle_kind: WorkspaceHandleKind,
    pub(super) relay: Option<RelayConfiguration>,
    /// The autonomous capture driver (files actor + watcher + reconcile
    /// loop), spawned only after the root binding succeeded. Shared so the
    /// teardown paths can take it exactly once.
    pub(super) capture: Arc<Mutex<Option<capture_driver::CaptureDriver>>>,
    automation_recovery: Arc<Mutex<Option<automation_recovery::AutomationRecovery>>>,
    /// Held by every capture reconcile+apply and by versions.setActive across
    /// its forced full scan plus switch transaction. This drains an in-flight
    /// apply and prevents a new one from resolving the destination version
    /// across the active-version boundary.
    pub(super) capture_apply_gate: capture_driver::ApplyGate,
    /// Serializes Y.Doc admission and versioned mutations for this workspace.
    /// Version fences retain this gate through their destructive continuation,
    /// without stalling editor traffic in unrelated open workspaces.
    pub(super) session_ops: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WorkspaceOpenMode {
    Full,
    ReadOnly,
}

enum WorkspaceHandleKind {
    Owner,
    ReadOnlyAttach { owner: WorkspaceHandle },
}

impl WorkspaceHandleKind {
    fn owns_binding(&self) -> bool {
        matches!(self, Self::Owner)
    }

    fn is_attached_to(&self, handle: &WorkspaceHandle) -> bool {
        matches!(self, Self::ReadOnlyAttach { owner } if owner == handle)
    }
}

impl OpenWorkspace {
    pub(super) fn is_local_owner(&self) -> bool {
        self.handle_kind.owns_binding() && self.mode == WorkspaceOpenMode::Full
    }

    fn read_only_attach(&self, owner: WorkspaceHandle) -> Self {
        Self {
            root: self.root.clone(),
            db_path: self.db_path.clone(),
            workspace_id: self.workspace_id.clone(),
            actor: self.actor.clone(),
            mode: WorkspaceOpenMode::ReadOnly,
            handle_kind: WorkspaceHandleKind::ReadOnlyAttach { owner },
            relay: self.relay.clone(),
            capture: Arc::clone(&self.capture),
            automation_recovery: Arc::clone(&self.automation_recovery),
            capture_apply_gate: Arc::clone(&self.capture_apply_gate),
            session_ops: Arc::clone(&self.session_ops),
        }
    }

    pub(super) fn request_collection_reconcile(&self) {
        if let Some(driver) = lock(&self.capture).as_ref() {
            driver.status().request_collection_reconcile();
        }
    }

    /// Signal the background tasks to stop without removing their handles. A version
    /// fence that already owns the apply gate can still finish against the
    /// driver; teardown takes the handle only after acquiring that gate.
    fn request_capture_shutdown(&self) {
        if let Some(recovery) = lock(&self.automation_recovery).as_ref() {
            recovery.request_shutdown();
        }
        if let Some(driver) = lock(&self.capture).as_ref() {
            driver.request_shutdown();
        }
    }

    /// Take and cancel the background tasks without an await point, so an
    /// aborted RPC future cannot leave them running. Return
    /// the join handles for callers that must await the full drain.
    fn begin_capture_shutdown(&self) -> [Option<tokio::task::JoinHandle<()>>; 2] {
        let capture = lock(&self.capture)
            .take()
            .and_then(capture_driver::CaptureDriver::begin_shutdown);
        let recovery = lock(&self.automation_recovery)
            .take()
            .and_then(automation_recovery::AutomationRecovery::begin_shutdown);
        [capture, recovery]
    }

    /// Cancel and await capture and automation recovery (idempotent).
    /// Strictly before the store-actor close: the driver may be mid-apply
    /// against the actor.
    pub(super) async fn shutdown_capture(&self) {
        for task in self.begin_capture_shutdown().into_iter().flatten() {
            let _ = task.await;
        }
    }
}

impl Drop for EngineService {
    fn drop(&mut self) {
        let open: Vec<(WorkspaceHandle, Arc<OpenWorkspace>)> = match self.handles.get_mut() {
            Ok(handles) => handles
                .drain()
                .filter(|(_, open)| open.handle_kind.owns_binding())
                .collect(),
            Err(poisoned) => poisoned
                .into_inner()
                .drain()
                .filter(|(_, open)| open.handle_kind.owns_binding())
                .collect(),
        };
        if open.is_empty() {
            return;
        }

        let sessions = Arc::clone(&self.sessions);
        let self_writes = self.self_writes.clone();
        let supervisor = self.supervisor;
        let cleanup = EngineServiceCleanup {
            open,
            sessions,
            self_writes,
            supervisor,
        };
        // The entered runtime may be in its final `block_on`; a task spawned
        // onto it can be discarded immediately after this Drop returns.
        // Teardown therefore always owns both its thread and runtime.
        let cleanup = Arc::new(Mutex::new(Some(cleanup)));
        let thread_cleanup = Arc::clone(&cleanup);
        if std::thread::Builder::new()
            .name("dohc-service-drop".to_owned())
            .spawn(move || {
                let Some(cleanup) = lock(&thread_cleanup).take() else {
                    return;
                };
                match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime.block_on(cleanup.run()),
                    Err(_) => cleanup.close_synchronously(),
                }
            })
            .is_err()
            && let Some(cleanup) = lock(&cleanup).take()
        {
            cleanup.close_synchronously();
        }
    }
}

struct EngineServiceCleanup {
    open: Vec<(WorkspaceHandle, Arc<OpenWorkspace>)>,
    sessions: Arc<Mutex<HashMap<String, YdocSession>>>,
    self_writes: SelfWriteSuppression,
    supervisor: &'static WorkspaceSupervisor,
}

impl EngineServiceCleanup {
    async fn run(self) {
        for (handle, workspace) in self.open {
            let _capture = Arc::clone(&workspace.capture_apply_gate).lock_owned().await;
            let _sessions = Arc::clone(&workspace.session_ops).lock_owned().await;
            lock(&self.sessions).retain(|_, session| session.workspace != handle);
            workspace.shutdown_capture().await;
            let closing_workspace = Arc::clone(&workspace);
            let supervisor = self.supervisor;
            let _ =
                tokio::task::spawn_blocking(move || supervisor.close(&closing_workspace.db_path))
                    .await;
            self.self_writes
                .scoped(&workspace.root)
                .clear_workspace(&workspace.workspace_id);
        }
    }

    fn close_synchronously(self) {
        for (handle, workspace) in self.open {
            lock(&self.sessions).retain(|_, session| session.workspace != handle);
            let _ = workspace.begin_capture_shutdown();
            let _ = self.supervisor.close(&workspace.db_path);
            self.self_writes
                .scoped(&workspace.root)
                .clear_workspace(&workspace.workspace_id);
        }
    }
}

/// Closes a just-opened store actor if `workspace_open` is dropped before the
/// handle reaches `handles` (a cancelled/deadline-expired open). Disarmed on
/// the success path, where the handle owns the actor. Open serialization stays
/// held until either transfer or `begin_close` installs the Closing marker.
struct OpenGuard {
    supervisor: &'static WorkspaceSupervisor,
    db_path: Option<PathBuf>,
    _open_serial: tokio::sync::OwnedMutexGuard<()>,
}

impl OpenGuard {
    fn disarm(mut self) {
        self.db_path = None;
    }
}

impl Drop for OpenGuard {
    fn drop(&mut self) {
        let Some(db_path) = self.db_path.take() else {
            return;
        };
        let supervisor = self.supervisor;
        let Ok(Some(closing)) = supervisor.begin_close(&db_path) else {
            return;
        };
        // Detached + blocking: never run the actor join on a runtime worker
        // (the cancellation-safety contract). begin_close installed the
        // Closing marker synchronously, so an immediate reopen waits here.
        tokio::task::spawn_blocking(move || {
            let _ = closing.finish();
        });
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceOpenParams {
    root_dir: String,
    workspace_id: String,
    #[serde(default)]
    capture_author: Option<Value>,
    #[serde(default)]
    recover_running_dispatches: Option<bool>,
    #[serde(default)]
    skip_startup_maintenance: bool,
    #[serde(default)]
    capture_mode: Option<WorkspaceCaptureMode>,
    #[serde(default)]
    relay: Option<RelayOpenParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum WorkspaceCaptureMode {
    None,
}

pub(super) fn validate_workspace_param(
    candidate: Option<&str>,
    resolved: &str,
) -> Result<(), WireError> {
    if candidate.is_some_and(|candidate| candidate != resolved) {
        return Err(WireError::new(
            ErrorCode::InvalidParams,
            "invalid-workspace",
        ));
    }
    Ok(())
}

pub(super) fn enforce_workspace(open: &OpenWorkspace, workspace_id: &str) -> Result<(), WireError> {
    if open.workspace_id == workspace_id {
        Ok(())
    } else {
        Err(WireError::new(
            ErrorCode::InvalidParams,
            "workspace scope mismatch",
        ))
    }
}

/// How often an open that asked for progress reads its counters: well under
/// any silence a caller would tolerate, and each read is a few atomic loads.
const OPEN_PROGRESS_POLL: Duration = Duration::from_millis(500);

/// What an open has done so far, from counters its work already keeps: the
/// store's SQLite work while it opens and migrates and then while this open
/// runs, each command its actor serves (the capture baseline's batches among
/// them), and each job the startup replay takes on; the files the capture
/// scan has hashed; and the open's own steps between them. The actor holds
/// the store counter weakly, so dropping this ends its counting on every
/// path out of the open.
struct OpenWork {
    /// Present only when the open reports progress, so an open that does not
    /// ask pays for no counting in the store or its actor.
    store: Option<Arc<AtomicU64>>,
    steps: AtomicU64,
    scan: OnceLock<capture_driver::ScanGauge>,
}

impl OpenWork {
    fn new(counting: bool) -> Self {
        OpenWork {
            store: counting.then(|| Arc::new(AtomicU64::new(0))),
            steps: AtomicU64::new(0),
            scan: OnceLock::new(),
        }
    }

    fn step(&self) {
        self.steps.fetch_add(1, Ordering::Relaxed);
    }

    /// Movement is what counts, not the value: a restarted files layer starts
    /// its scan count again.
    fn total(&self) -> u64 {
        let store = self
            .store
            .as_ref()
            .map_or(0, |store| store.load(Ordering::Relaxed));
        let scan = self.scan.get().map_or(0, capture_driver::ScanGauge::hashed);
        store
            .wrapping_add(self.steps.load(Ordering::Relaxed))
            .wrapping_add(scan)
    }
}

/// Run `work` to its end, reporting progress on each poll that finds `done`
/// moved since the last. A poll that finds nothing new reports nothing, so a
/// caller can tell a stuck request from a slow one.
async fn report_while<T>(
    progress: &ProgressSink,
    done: impl Fn() -> u64,
    work: impl Future<Output = T>,
) -> T {
    tokio::pin!(work);
    let mut polls = tokio::time::interval(OPEN_PROGRESS_POLL);
    polls.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut seen = done();
    loop {
        tokio::select! {
            biased;
            output = &mut work => return output,
            _ = polls.tick() => {
                let now = done();
                if now != seen {
                    seen = now;
                    progress.report();
                }
            }
        }
    }
}

#[cfg(test)]
const BINDING_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

impl EngineService {
    /// Tear down every open workspace's capture driver (watcher joined,
    /// files actor closed). Called at daemon shutdown after the transport's
    /// workspace close hook: store actors are already gone by then, so any
    /// in-flight capture write fails contained (never acked — the next
    /// daemon start re-offers it from the dirty baseline), and this drain
    /// joins the watcher/files threads so the process exits clean.
    pub async fn shutdown_all_capture(&self) {
        let open: Vec<Arc<OpenWorkspace>> = lock(&self.handles)
            .values()
            .filter(|open| open.handle_kind.owns_binding())
            .cloned()
            .collect();
        for workspace in open {
            workspace.shutdown_capture().await;
        }
    }

    pub(super) async fn workspace_open(
        &self,
        ctx: &RequestContext,
        params: Value,
    ) -> Result<Value, WireError> {
        let work = OpenWork::new(ctx.progress.is_active());
        let open = self.open_workspace(ctx, params, &work);
        if !ctx.progress.is_active() {
            return open.await;
        }
        report_while(&ctx.progress, || work.total(), open).await
    }

    async fn open_workspace(
        &self,
        ctx: &RequestContext,
        params: Value,
        work: &OpenWork,
    ) -> Result<Value, WireError> {
        let capture_author_supplied = params
            .as_object()
            .is_some_and(|object| object.contains_key("captureAuthor"));
        let params: WorkspaceOpenParams = parse(params)?;
        let capture_author_json = if capture_author_supplied {
            Some(validated_author(params.capture_author.as_ref())?)
        } else {
            None
        };
        let capture_enabled = params.capture_mode.is_none();
        if !capture_enabled && capture_author_supplied {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "captureAuthor is unavailable when captureMode is none",
            ));
        }
        let cancellation = OperationCancellation::new(ctx);
        let _open_serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("workspace open (queued)"));
            }
            serial = Arc::clone(&self.open_lock).lock_owned() => serial,
        };
        // Waiting for the lock is not this open's progress; holding it is.
        work.step();
        let root = root_binding::canonical_root(PathBuf::from(&params.root_dir).as_path())
            .map_err(map_root_binding)?;
        let requested_mode = if params.skip_startup_maintenance {
            WorkspaceOpenMode::ReadOnly
        } else {
            WorkspaceOpenMode::Full
        };
        let existing = {
            let guard = lock(&self.handles);
            guard
                .iter()
                .find(|(_, open)| open.root == root && open.handle_kind.owns_binding())
                .map(|(handle, open)| (handle.clone(), Arc::clone(open)))
        };
        if let Some((handle, open)) = existing {
            // The root's logical binding to a workspace id holds regardless of
            // actor liveness: a different workspace id is always rejected.
            if open.workspace_id != params.workspace_id {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "workspace root is already bound to another workspace",
                ));
            }
            // A maintenance-free open is read intent, not a request for
            // ownership. Mint a non-owning token over the live binding so its
            // close cannot tear down the desktop's actor, capture, or relay.
            // Same workspace: short-circuit only on a live binding. A bound-but-
            // closed actor (its worker died) is stale — drop it and reopen fresh.
            if !open.actor.lifecycle().needs_reopen() {
                if requested_mode == WorkspaceOpenMode::ReadOnly {
                    // Caller-supplied relay params and captureAuthor are
                    // deliberately ignored here: the attachment rides the
                    // OWNER's binding, and read-only handles cannot reach
                    // sync/relay/capture methods anyway.
                    let sequence = self
                        .next_handle
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let attached_handle = WorkspaceHandle(format!("ws-{sequence:016x}"));
                    let attached = Arc::new(open.read_only_attach(handle));
                    {
                        let mut handles = lock(&self.handles);
                        if handles.len() >= MAX_OPEN_HANDLES {
                            return Err(WireError::new(
                                ErrorCode::Overloaded,
                                "workspace handle limit reached",
                            ));
                        }
                        handles.insert(attached_handle.clone(), attached);
                    }
                    return Ok(json!({ "workspace": attached_handle }));
                }
                if open.mode != requested_mode {
                    return Err(WireError::new(
                        ErrorCode::InvalidParams,
                        "workspace root is already open in a different mode",
                    ));
                }
                if lock(&open.capture).is_some() != capture_enabled {
                    return Err(WireError::new(
                        ErrorCode::InvalidParams,
                        "workspace capture configuration mismatch",
                    ));
                }
                if open.relay != params.relay.as_ref().map(RelayOpenParams::configuration) {
                    return Err(WireError::new(
                        ErrorCode::InvalidParams,
                        "workspace relay configuration mismatch",
                    ));
                }
                if let Some(author_json) = capture_author_json.clone() {
                    let _apply = tokio::select! {
                        biased;
                        () = cancellation.token.cancelled() => {
                            return Err(cancellation.interruption(
                                "workspace open (capture author)"
                            ));
                        }
                        guard = Arc::clone(&open.capture_apply_gate).lock_owned() => guard,
                    };
                    let capture = lock(&open.capture);
                    let driver = capture.as_ref().ok_or_else(|| {
                        WireError::new(
                            ErrorCode::WorkspaceUnavailable,
                            "capture driver unavailable",
                        )
                    })?;
                    driver.set_author_json(author_json);
                }
                return Ok(json!({ "workspace": handle }));
            }
            lock(&self.handles).remove(&handle);
            lock(&self.live_applications).retire_workspace(&open);
            let attached_handles = {
                let mut handles = lock(&self.handles);
                let attached: Vec<WorkspaceHandle> = handles
                    .iter()
                    .filter(|(_, open)| open.handle_kind.is_attached_to(&handle))
                    .map(|(attached, _)| attached.clone())
                    .collect();
                for attached in &attached {
                    handles.remove(attached);
                }
                attached
            };
            // The normal close path drops pending cursors with the handle;
            // eviction dropped the handle and the sessions but left them.
            // Handles are minted from a monotonic counter, so the orphans were
            // never CONSUMABLE — every reopen gets a new handle and
            // consume_pending_cursor matches on it — they simply accumulated
            // in the map for the life of the process, one per issued cursor
            // per evicted binding, with nothing able to remove them.
            lock(&self.pending_cursors).retain(|_, pending| {
                pending.handle != handle && !attached_handles.contains(&pending.handle)
            });
            lock(&self.sessions).retain(|_, session| {
                session.workspace != handle && !attached_handles.contains(&session.workspace)
            });
            // The evicted binding's files layer must not outlive it. Clear
            // suppression only after the shutdown drain — an in-flight
            // reconcile apply still consults the registry.
            open.shutdown_capture().await;
            self.self_writes
                .scoped(&open.root)
                .clear_workspace(&open.workspace_id);
        }
        if lock(&self.handles).len() >= MAX_OPEN_HANDLES {
            return Err(WireError::new(
                ErrorCode::Overloaded,
                "workspace handle limit reached",
            ));
        }
        let db_path = root.join(".dohc").join("engine").join("engine.db");
        let supervisor = self.supervisor;
        let actor_path = db_path.clone();
        let now_ms = now_ms()?;
        let capture_apply_probe = self.capture_apply_probe.clone();
        #[cfg(test)]
        let bind_root_faults: Arc<dyn FaultInjector> = self
            .bind_root_faults
            .clone()
            .unwrap_or_else(|| Arc::new(NoFaults));
        #[cfg(not(test))]
        let bind_root_faults: Arc<dyn FaultInjector> = Arc::new(NoFaults);
        let binding_root = root.clone();
        let store_work = work.store.clone();
        let mut opening = tokio::task::spawn_blocking(move || {
            // The marker precedes database creation. A crash leaves either a marker
            // and no schema, or a schema already bound to that marker.
            let root_token = match requested_mode {
                WorkspaceOpenMode::Full => {
                    root_binding::write_new_root_binding(&binding_root).map_err(map_root_binding)?
                }
                WorkspaceOpenMode::ReadOnly => root_binding::read_root_binding(&binding_root)
                    .map_err(map_root_binding)?
                    .ok_or_else(|| {
                        map_root_binding(root_binding::RootBindingError::DatabaseMismatch)
                    })?,
            };
            let opened = match requested_mode {
                WorkspaceOpenMode::Full => {
                    supervisor.open_root_bound(&actor_path, now_ms, &root_token, store_work)
                }
                WorkspaceOpenMode::ReadOnly => {
                    supervisor.open_read_only_counting(&actor_path, store_work)
                }
            };
            // Establish cleanup ownership inside the blocking task that creates
            // the actor. If the awaiting request is cancelled, Tokio drops this
            // task's unobserved output and the guard closes the actor. The guard
            // also retains open serialization until cleanup installs Closing.
            let open_guard = OpenGuard {
                supervisor,
                db_path: opened
                    .as_ref()
                    .ok()
                    .and_then(|open| open.created_actor.then_some(actor_path)),
                _open_serial,
            };
            // Verify the committed binding before exposing the actor. The initial
            // token is part of schema creation; existing stores are never adopted.
            let opened = opened.map(|open| {
                if !open.created_actor {
                    return (open, Ok(()));
                }
                let bound = match tokio::runtime::Handle::current()
                    .block_on(open.actor.bind_root(root_token, bind_root_faults))
                {
                    Ok(true) => Ok(()),
                    Ok(false) => Err(root_binding::RootBindingError::DatabaseMismatch),
                    Err(error) => {
                        eprintln!("engine: root binding stamp failed: {error}");
                        Err(root_binding::RootBindingError::Unstamped)
                    }
                };
                (open, bound)
            });
            if open_guard.db_path.is_some()
                && let Some(probe) = capture_apply_probe
            {
                probe.pause_open_install_if_armed();
            }
            Ok((opened, open_guard))
        });
        let (actor_open, open_guard) = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                // Dropping the join handle detaches the blocking task. Its
                // OpenGuard output is then discarded when startup returns,
                // which installs Closing before releasing open serialization.
                return Err(cancellation.interruption("workspace open (actor startup)"));
            }
            opened = &mut opening => {
                opened.map_err(|_| WireError::new(ErrorCode::Internal, "workspace open task failed"))??
            }
        };
        let (actor_open, bound) = actor_open.map_err(map_runtime)?;
        // The supervisor deduplicates by physical engine.db identity, including
        // root aliases and hard links. EngineService state (capture driver,
        // session registry, and version barriers) deliberately has one owner:
        // attaching a second service to the shared actor would split those
        // barriers and make version switches unsafe. Production constructs one
        // service, and repeated opens on that service returned above; reject
        // every remaining cross-service/aliased attachment explicitly.
        if !actor_open.created_actor {
            return Err(WireError::new(
                ErrorCode::WorkspaceUnavailable,
                "workspace database is already attached",
            ));
        }
        let actor = actor_open.actor;
        // Chat writes and relay passes announce the Group automation claims
        // they commit through the actor, whichever request or pass made them.
        let claim_events = self.events.clone();
        let claim_workspace_id = params.workspace_id.clone();
        actor.listen_for_automation_claims(Arc::new(move |claims| {
            crate::events::emit_automation_claimed(&claim_events, &claim_workspace_id, claims);
        }));
        if let Err(error) = bound {
            if actor_open.store_freshly_created {
                // The guard's close finishes on a blocking task; the delete
                // has to wait for it, or SQLite still holds the file.
                drop(actor);
                let removed = supervisor.begin_close(&db_path);
                if let Ok(Some(closing)) = removed {
                    let _ = tokio::task::spawn_blocking(move || closing.finish()).await;
                }
                open_guard.disarm();
                // A delete that fails leaves the store the next open refuses
                // as a mismatch. The refusal stands; the path says why.
                for suffix in ["", "-wal", "-shm"] {
                    let mut path = db_path.clone().into_os_string();
                    path.push(suffix);
                    let path = std::path::PathBuf::from(path);
                    if let Err(error) = std::fs::remove_file(&path)
                        && error.kind() != std::io::ErrorKind::NotFound
                    {
                        eprintln!(
                            "engine: could not delete the orphaned store file {}: {error}",
                            path.display()
                        );
                    }
                }
            }
            return Err(map_root_binding(error));
        }
        let open_guard = if requested_mode == WorkspaceOpenMode::Full
            && let Some(config) = self.ordinary_live_host.get()
        {
            let budget_db_path = db_path.clone();
            let budget_workspace_id = params.workspace_id.clone();
            let owner_outbox = config.owner_outbox.clone();
            let budget_probe = self.capture_apply_probe.clone();
            let mut reading_budget = tokio::task::spawn_blocking(move || {
                // This task keeps cleanup and open serialization after caller cancellation,
                // until the reader drops and OpenGuard installs the Closing marker.
                if let Some(probe) = budget_probe {
                    probe.pause_open_budget_if_armed();
                }
                let result = (|| {
                    let store = dohc_engine_storage::EngineStore::open_read_only(&budget_db_path)
                        .map_err(|error| {
                        map_runtime(dohc_engine_runtime::RuntimeError::Storage(error))
                    })?;
                    let mismatch: bool = store.read_with(|conn| conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM live_owner_adoptions a JOIN ydoc_docs d ON d.workspace_id=a.workspace_id AND d.version_id=a.main_version_id AND d.object_id=a.object_id AND d.lineage_claim_id=a.lineage_claim_id WHERE a.workspace_id=?1 AND (a.max_pending_bytes>?2 OR a.max_pending_age_ms>?3))",
                    rusqlite::params![budget_workspace_id,owner_outbox.max_pending_bytes,owner_outbox.max_pending_age_ms],|row|row.get(0)
                )).map_err(|_| WireError::new(ErrorCode::Internal,"owner-outbox-budget-read-failed"))?;
                    Ok::<_, WireError>(mismatch)
                })();
                (result, open_guard)
            });
            let (mismatch, open_guard) = tokio::select! {
                biased;
                () = cancellation.token.cancelled() => return Err(cancellation.interruption("workspace open (owner outbox budget)")),
                result = &mut reading_budget => result.map_err(|_| WireError::new(ErrorCode::Internal,"owner-outbox-budget-worker-failed"))?,
            };
            if mismatch? {
                return Err(WireError::new(
                    ErrorCode::Conflict,
                    "owner-outbox-configured-budget-mismatch",
                ));
            }
            open_guard
        } else {
            open_guard
        };
        work.step();
        let sequence = self
            .next_handle
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let handle = WorkspaceHandle(format!("ws-{sequence:016x}"));
        let capture_apply_gate = Arc::new(tokio::sync::Mutex::new(()));
        let capture = if requested_mode == WorkspaceOpenMode::ReadOnly {
            None
        } else {
            // Mandatory readiness barrier: derived mention rows must exist before
            // this workspace can expose a mention read or advance the dispatch
            // scan cursor past an older `@agent` message.
            Self::read_under_ctx(
                &cancellation,
                "workspace.open (mention backfill)",
                actor.chat_mentions_backfill(
                    params.workspace_id.clone(),
                    cancellation.token.clone(),
                ),
            )
            .await?;
            // Startup replay before the files layer exists: jobs left pending by
            // a crash, a transient settle failure, or a pulled replication apply
            // land on disk while nothing is watching (no suppression window),
            // and the baseline reconcile below then scans the POST-replay disk.
            actor
                .materialize_replay_pending_counting(
                    root.clone(),
                    params.workspace_id.clone(),
                    now_ms,
                    work.store.clone(),
                )
                .await
                .map_err(map_runtime)?;
            // The files layer spawns only here, after the root binding
            // succeeded, so an unbound or mismatched root can never grow a
            // watcher or files actor.
            let capture = capture_enabled.then(|| {
                capture_driver::CaptureDriver::spawn(capture_driver::CaptureDriverSpawnParams {
                    root: root.clone(),
                    actor: actor.clone(),
                    workspace_id: params.workspace_id.clone(),
                    leases: self.leases.scoped(&root),
                    self_writes: self.self_writes.scoped(&root),
                    apply_gate: Arc::clone(&capture_apply_gate),
                    store_freshly_created: actor_open.store_freshly_created,
                    initial_author_json: capture_author_json.flatten(),
                    events: self.events.clone(),
                    apply_probe: self.capture_apply_probe.clone(),
                })
            });
            if let Some(capture) = &capture {
                let _ = work.scan.set(capture.scan_gauge());
            }
            // STARTUP ORDERING BARRIER: existing stores and uncertain scans
            // apply the closed-period baseline before the handle is handed
            // out. A proven fresh, all-Added import may return earlier; Added
            // capture never claims a foreign head, so a caller's first write
            // wins while the bounded import finishes behind the handle.
            //
            // Cancellation: nothing owns the store actor yet (the handle is
            // inserted below), so an abort here would leak it. The `open_guard`
            // armed above the startup replay closes the actor on an early drop
            // and is disarmed once the handle is inserted; `CaptureDriver`'s own
            // Drop cancels the files layer.
            // Desktop rebinds opt out because their runner processes outlive the daemon.
            if actor_open.created_actor && params.recover_running_dispatches.unwrap_or(true) {
                // Cancellation-aware like every other actor wait in this flow:
                // a caller abort stops waiting promptly (the actor still finishes
                // the reclaim it already accepted — it is idempotent on the next
                // open) and the open_guard above closes the actor on early drop.
                Self::read_under_ctx(
                    &cancellation,
                    "workspace.open (dispatch reclaim)",
                    actor.chat_dispatch_reclaim_running(
                        params.workspace_id.clone(),
                        CHAT_DISPATCH_MAX_ATTEMPTS,
                        now_ms,
                    ),
                )
                .await?;
            }
            // The automation claim reaper (ADR 0008: a claim left by a closed
            // device fires on next launch). Every open that reaches this
            // point created the actor (a non-creating open returned above),
            // so a desktop that died mid-run reaps its stale claim on its
            // next open. The idle bound protects a handler a still-alive
            // desktop is running, whose run settles inside the shorter
            // per-run deadline.
            {
                Self::read_under_ctx(
                    &cancellation,
                    "workspace.open (automation reclaim)",
                    actor.automation_reclaim_running(
                        params.workspace_id.clone(),
                        None,
                        AUTOMATION_CLAIM_MAX_ATTEMPTS,
                        now_ms - AUTOMATION_CLAIM_REAP_IDLE_MS,
                        now_ms,
                        Arc::new(NoFaults),
                        cancellation.token(),
                    ),
                )
                .await?;
            }
            if let Some(capture) = &capture {
                capture.wait_for_open_ready().await;
            }
            capture
        };
        let automation_recovery = if requested_mode == WorkspaceOpenMode::Full {
            let attempts = Self::read_under_ctx(
                &cancellation,
                "workspace.open (automation recovery snapshot)",
                actor.automation_running_attempts(params.workspace_id.clone()),
            )
            .await?;
            (!attempts.is_empty()).then(|| {
                automation_recovery::AutomationRecovery::spawn(
                    actor.clone(),
                    params.workspace_id.clone(),
                    attempts,
                    self.events.clone(),
                )
            })
        } else {
            None
        };
        lock(&self.handles).insert(
            handle.clone(),
            Arc::new(OpenWorkspace {
                root,
                db_path,
                workspace_id: params.workspace_id,
                actor,
                mode: requested_mode,
                handle_kind: WorkspaceHandleKind::Owner,
                relay: params
                    .relay
                    .map(|configuration| configuration.configuration()),
                capture: Arc::new(Mutex::new(capture)),
                automation_recovery: Arc::new(Mutex::new(automation_recovery)),
                capture_apply_gate,
                session_ops: Arc::new(tokio::sync::Mutex::new(())),
            }),
        );
        open_guard.disarm();
        Ok(json!({ "workspace": handle }))
    }

    pub(super) async fn workspace_close(
        &self,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let supervisor = self.supervisor;
        // Revalidate and claim teardown under the same serial lock as open.
        // After this await there is no cancellable point until a detached task
        // owns every remaining step.
        let (closing, removed, attached_handles) = {
            let _serial = self.open_lock.lock().await;
            let open = self.open(Some(&handle))?;
            if !open.handle_kind.owns_binding() {
                let removed = lock(&self.handles).remove(&handle).is_some();
                lock(&self.pending_cursors).retain(|_, pending| pending.handle != handle);
                lock(&self.sessions).retain(|_, session| session.workspace != handle);
                return Ok(json!({ "closed": false, "attachmentClosed": removed }));
            }
            // Install the GLOBAL Closing marker before removing the handle, so a
            // workspace_open on another EngineService (which does not take this
            // service's open_lock) observes Closing at supervisor.open and waits
            // for a fresh actor instead of the one being torn down.
            let closing = supervisor.begin_close(&open.db_path).map_err(map_runtime)?;
            let (removed, attached_handles) = {
                let mut handles = lock(&self.handles);
                let removed = handles.remove(&handle);
                let attached: Vec<WorkspaceHandle> = handles
                    .iter()
                    .filter(|(_, open)| open.handle_kind.is_attached_to(&handle))
                    .map(|(attached, _)| attached.clone())
                    .collect();
                for attached in &attached {
                    handles.remove(attached);
                }
                (removed, attached)
            };
            lock(&self.live_applications).retire_workspace(&open);
            lock(&self.pending_cursors).retain(|_, pending| {
                pending.handle != handle && !attached_handles.contains(&pending.handle)
            });
            (closing, removed, attached_handles)
        };
        let removed = removed.ok_or_else(workspace_unavailable)?;
        let closed = closing.is_some();
        let capture_gate = Arc::clone(&removed.capture_apply_gate);
        let session_gate = Arc::clone(&removed.session_ops);
        let sessions = Arc::clone(&self.sessions);
        // Suppression entries clear after the capture drain: an in-flight
        // reconcile apply still consults the registry, and clearing first
        // would let it re-ingest the daemon's own just-settled file as a
        // capture write (provenance flip) during teardown.
        let clear_suppression = (
            self.self_writes.scoped(&removed.root),
            removed.workspace_id.clone(),
        );
        // Signal cancellation without taking the driver. A paused fresh import
        // releases the capture gate promptly, while a version fence that already
        // owns the gate can still read the driver and finish. Cancellation is
        // idempotent when the detached task takes the driver below.
        removed.request_capture_shutdown();
        let probe = self.capture_apply_probe.clone();
        let close_task = tokio::spawn(async move {
            if let Some(probe) = &probe {
                probe.observe_gate_wait_if_armed();
            }
            let _capture = capture_gate.lock_owned().await;
            let capture_drain = removed.begin_capture_shutdown();
            let _session = session_gate.lock_owned().await;
            // Session rows stay present until in-flight session work drains,
            // then their lease guards are released.
            lock(&sessions).retain(|_, session| {
                session.workspace != handle && !attached_handles.contains(&session.workspace)
            });
            for drain in capture_drain.into_iter().flatten() {
                let _ = drain.await;
            }
            clear_suppression.0.clear_workspace(&clear_suppression.1);
            tokio::task::spawn_blocking(move || match closing {
                Some(closing) => closing.finish(),
                None => Ok(()),
            })
            .await
        });
        close_task
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "workspace close task failed"))?
            .map_err(|_| WireError::new(ErrorCode::Internal, "workspace close task failed"))?
            .map_err(map_runtime)?;
        Ok(json!({ "closed": closed }))
    }

    pub(super) fn open(
        &self,
        handle: Option<&WorkspaceHandle>,
    ) -> Result<Arc<OpenWorkspace>, WireError> {
        let handle = handle.ok_or_else(workspace_unavailable)?;
        lock(&self.handles)
            .get(handle)
            .cloned()
            .ok_or_else(workspace_unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::relay::IssuedCursor;
    use crate::rpc::relay::PendingCursor;
    use dohc_engine_domain::WriteText;
    use dohc_engine_runtime::FaultPoint;
    use dohc_engine_testkit::GateFaults;
    use dohc_engine_testkit::ScratchDir;
    use dohc_engine_testkit::ScriptedFaults;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_open_access_keeps_one_handle_until_rebind() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "shared-open-access",
            "captureMode": "none",
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), params.clone())
            .await
            .expect("initial open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("handle");
        let first = service.open(Some(&handle)).expect("first access");
        let second = service.open(Some(&handle)).expect("second access");
        assert!(Arc::ptr_eq(&first, &second));
        let repeated = service
            .workspace_open(&RequestContext::unbounded(), params.clone())
            .await
            .expect("repeat open");
        assert_eq!(opened, repeated);
        assert!(Arc::ptr_eq(
            &first,
            &service.open(Some(&handle)).expect("repeated access"),
        ));

        let mut other_identity = params.clone();
        other_identity["workspaceId"] = json!("another-workspace");
        let refused = service
            .workspace_open(&RequestContext::unbounded(), other_identity)
            .await
            .expect_err("a shared handle cannot change root identity");
        assert_eq!(refused.code, ErrorCode::InvalidParams);

        service
            .workspace_close(Some(handle.clone()))
            .await
            .expect("close");
        assert!(service.open(Some(&handle)).is_err());
        assert_eq!(first.actor.lifecycle(), LifecycleState::Closed);
        let reopened = service
            .workspace_open(&RequestContext::unbounded(), params)
            .await
            .expect("rebind while old accesses remain");
        let rebound: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).expect("rebound handle");
        let next = service.open(Some(&rebound)).expect("rebound access");
        assert_ne!(handle, rebound);
        assert!(!Arc::ptr_eq(&first, &next));
        assert_eq!(first.root, next.root);
        assert_eq!(first.workspace_id, next.workspace_id);
        assert_eq!(next.actor.lifecycle(), LifecycleState::Ready);
        service
            .workspace_close(Some(rebound))
            .await
            .expect("final close");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retained_read_attachment_shares_capture_without_owning_shutdown() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "shared-attachment-capture",
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), params.clone())
            .await
            .expect("owner open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("owner handle");
        let owner = service.open(Some(&handle)).expect("owner access");
        let mut attach_params = params;
        attach_params["skipStartupMaintenance"] = json!(true);
        let attached = service
            .workspace_open(&RequestContext::unbounded(), attach_params.clone())
            .await
            .expect("read attach");
        let attached_handle: WorkspaceHandle =
            serde_json::from_value(attached["workspace"].clone()).expect("attached handle");
        let retained = service
            .open(Some(&attached_handle))
            .expect("attached access");
        assert!(!Arc::ptr_eq(&owner, &retained));
        assert_eq!(owner.mode, WorkspaceOpenMode::Full);
        assert_eq!(retained.mode, WorkspaceOpenMode::ReadOnly);
        assert!(retained.handle_kind.is_attached_to(&handle));
        assert!(Arc::ptr_eq(&owner.capture, &retained.capture));
        assert!(Arc::ptr_eq(
            &owner.automation_recovery,
            &retained.automation_recovery
        ));
        assert!(Arc::ptr_eq(
            &owner.capture_apply_gate,
            &retained.capture_apply_gate
        ));
        assert!(Arc::ptr_eq(&owner.session_ops, &retained.session_ops));
        assert!(lock(&owner.capture).is_some());
        assert_eq!(
            service
                .workspace_close(Some(attached_handle.clone()))
                .await
                .expect("attach close"),
            json!({ "closed": false, "attachmentClosed": true }),
        );
        assert!(service.open(Some(&attached_handle)).is_err());
        assert_eq!(owner.actor.lifecycle(), LifecycleState::Ready);
        assert!(lock(&retained.capture).is_some());

        let attached = service
            .workspace_open(&RequestContext::unbounded(), attach_params)
            .await
            .expect("second read attach");
        let attached_handle: WorkspaceHandle =
            serde_json::from_value(attached["workspace"].clone()).expect("second attached handle");
        let second = service
            .open(Some(&attached_handle))
            .expect("second attached access");
        service
            .workspace_close(Some(handle))
            .await
            .expect("owner close");
        assert!(service.open(Some(&attached_handle)).is_err());
        assert_eq!(retained.actor.lifecycle(), LifecycleState::Closed);
        assert!(lock(&owner.capture).is_none());
        assert!(lock(&second.capture).is_none());
        assert!(
            retained
                .begin_capture_shutdown()
                .into_iter()
                .all(|task| task.is_none())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn service_drop_closes_capture_with_retained_shared_access() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "shared-access-service-drop",
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("handle");
        let retained = service.open(Some(&handle)).expect("retained access");
        assert!(lock(&retained.capture).is_some());
        drop(service);
        tokio::time::timeout(Duration::from_secs(10), async {
            while retained.actor.lifecycle() != LifecycleState::Closed {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("service cleanup closes the actor without waiting for Arc release");
        assert!(lock(&retained.capture).is_none());
        assert!(
            retained
                .begin_capture_shutdown()
                .into_iter()
                .all(|task| task.is_none())
        );
    }

    /// #874 repro shape: a July-era `engine.db` — user tables, `user_version`
    /// still 0 — sitting in a real workspace root. `workspace.open` must
    /// surface the real fence's classification (`foreign-database`) on the
    /// wire, driven through the storage layer rather than a fabricated error
    /// value, so the desktop's recovery surface has a code to match.
    ///
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn opening_a_workspace_over_a_foreign_engine_db_names_the_refusal() {
        let scratch = ScratchDir::new().expect("scratch");
        let engine_dir = scratch.path().join(".dohc").join("engine");
        std::fs::create_dir_all(&engine_dir).expect("engine dir");
        {
            let conn =
                rusqlite::Connection::open(engine_dir.join("engine.db")).expect("fabricate db");
            conn.execute_batch("CREATE TABLE notes (body TEXT);")
                .expect("user table");
        }
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let refused = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "foreign-store-repro",
                }),
            )
            .await
            .expect_err("the fence must refuse a foreign database");
        assert_eq!(refused.code, ErrorCode::Internal);
        assert_eq!(refused.message, "foreign-database");
    }

    /// A store whose ledger disagrees with this build's migrations is refused
    /// under its own name, so the desktop can offer the move-aside rebuild
    /// instead of a generic failure.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn opening_a_store_whose_ledger_disagrees_with_this_build_names_the_refusal() {
        let scratch = ScratchDir::new().expect("scratch");
        let engine_dir = scratch.path().join(".dohc").join("engine");
        std::fs::create_dir_all(&engine_dir).expect("engine dir");
        let db_path = engine_dir.join("engine.db");
        drop(dohc_engine_storage::EngineStore::open(&db_path, 1).expect("fresh store"));
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open ledger");
            conn.execute(
                "UPDATE engine_migrations SET checksum = ?1 WHERE ordinal = 0",
                ["0".repeat(64)],
            )
            .expect("tamper ledger");
        }
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let refused = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "ledger-mismatch-repro",
                }),
            )
            .await
            .expect_err("the ledger fence must refuse a store from another build");
        assert_eq!(refused.code, ErrorCode::Internal);
        assert!(
            refused.message.starts_with("migration-failed: "),
            "{}",
            refused.message
        );
        // The cause names the migration and both checksums: the store's
        // recorded one (tampered to zeros here) and this build's.
        assert!(
            refused.message.contains("migration 0 (v2-baseline)"),
            "{}",
            refused.message
        );
        assert!(
            refused.message.contains("the store recorded 000000000000"),
            "{}",
            refused.message
        );
        assert!(
            refused.message.contains("this build defines "),
            "{}",
            refused.message
        );
    }

    /// A store a newer build migrated is refused under its own name, so the
    /// desktop stops the workspace and asks for an update instead of offering
    /// a rebuild.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn opening_a_store_a_newer_build_migrated_names_the_refusal() {
        let scratch = ScratchDir::new().expect("scratch");
        let engine_dir = scratch.path().join(".dohc").join("engine");
        std::fs::create_dir_all(&engine_dir).expect("engine dir");
        let db_path = engine_dir.join("engine.db");
        drop(dohc_engine_storage::EngineStore::open(&db_path, 1).expect("fresh store"));
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open ledger");
            conn.execute(
                "INSERT INTO engine_migrations \
                 (ordinal, id, checksum, engine_build, protocol_version, \
                  transactional, started_at, completed_at, integrity_ok) \
                 SELECT MAX(ordinal) + 1, 'from-a-newer-build', 'newer', 'newer', 1, 1, 2, 2, 1 \
                 FROM engine_migrations",
                [],
            )
            .expect("a newer build's ledger row");
        }
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let refused = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "newer-build-repro",
                }),
            )
            .await
            .expect_err("the fence must refuse a store a newer build migrated");
        assert_eq!(refused.code, ErrorCode::Internal);
        assert!(
            refused
                .message
                .starts_with("migrated-by-newer-build: a newer build ran migration "),
            "{}",
            refused.message
        );
        assert!(
            refused
                .message
                .ends_with(" (from-a-newer-build), which this build does not define"),
            "{}",
            refused.message
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspace_rebind_preserves_a_runner_owned_by_the_desktop() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let first_service = EngineService::with_supervisor(supervisor);
        let workspace_id = "desktop-runner-survives-daemon";
        let opened = first_service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            )
            .await
            .expect("initial workspace open");
        let first_handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        first_service
            .chats_dispatch_enqueue(
                &RequestContext::unbounded(),
                Some(first_handle.clone()),
                json!({
                    "triggerMessageId": "trigger-survives",
                    "threadId": "thread-survives",
                    "nowMs": 10,
                }),
            )
            .await
            .expect("enqueue dispatch");
        let claim = first_service
            .chats_dispatch_claim_next_pending(
                &RequestContext::unbounded(),
                Some(first_handle.clone()),
                json!({
                    "runId": "run-survives",
                    "command": "agent",
                    "nowMs": 20,
                }),
            )
            .await
            .expect("claim dispatch");
        assert_eq!(claim["run"]["runId"], json!("run-survives"));

        first_service
            .workspace_close(Some(first_handle))
            .await
            .expect("simulate old daemon teardown");

        let rebound_service = EngineService::with_supervisor(supervisor);
        let rebound = rebound_service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                    "recoverRunningDispatches": false,
                }),
            )
            .await
            .expect("desktop rebind");
        let rebound_handle: WorkspaceHandle =
            serde_json::from_value(rebound["workspace"].clone()).expect("rebound handle");
        let open_runs = rebound_service
            .chats_dispatch_open_runs(
                &RequestContext::unbounded(),
                Some(rebound_handle.clone()),
                json!({}),
            )
            .await
            .expect("list open runs");
        assert_eq!(
            open_runs["claims"][0]["run"]["runId"],
            json!("run-survives")
        );

        rebound_service
            .chats_dispatch_complete(
                &RequestContext::unbounded(),
                Some(rebound_handle.clone()),
                json!({ "runId": "run-survives", "exitCode": 0, "nowMs": 30 }),
            )
            .await
            .expect("surviving runner completes");
        let pending = rebound_service
            .chats_dispatch_list_pending(
                &RequestContext::unbounded(),
                Some(rebound_handle.clone()),
                json!({}),
            )
            .await
            .expect("list pending dispatches");
        assert_eq!(pending["dispatches"], json!([]));

        rebound_service
            .workspace_close(Some(rebound_handle))
            .await
            .expect("workspace close");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn automation_recovery_follows_full_workspace_lifetime_without_requiring_capture() {
        let scratch = ScratchDir::new().expect("scratch");
        root_binding::write_root_binding(scratch.path(), BINDING_TOKEN).expect("root binding");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let db_path = scratch.path().join(".dohc/engine/engine.db");
        let mut store = dohc_engine_storage::EngineStore::open(&db_path, 1).expect("fixture store");
        store
            .bind_root_token(BINDING_TOKEN, &NoFaults)
            .expect("bind root token");
        drop(store);
        for (capture_enabled, read_only, seed_claim) in [
            (false, false, true),
            (false, true, true),
            (true, false, true),
            (false, false, false),
        ] {
            let conn = rusqlite::Connection::open(&db_path).expect("seed connection");
            conn.execute("DELETE FROM automation_claims", [])
                .expect("reset claims");
            if seed_claim {
                conn.execute(
                    "INSERT INTO automation_claims \
                     (workspace_id,claim_id,automation_id,trigger_history_id,record_id,collection_path, \
                      depth,state,attempts,created_at_ms,updated_at_ms) \
                     VALUES ('automation-recovery-lifetime','interrupted','automation',1,'record','tasks', \
                             0,'running',2,?1,?1)",
                    [now_ms().expect("current time")],
                ).expect("seed interrupted claim");
            }
            drop(conn);
            let mut params = json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": "automation-recovery-lifetime",
                "recoverRunningDispatches": false,
                "skipStartupMaintenance": read_only,
            });
            if !capture_enabled {
                params["captureMode"] = json!("none");
            }
            let opened = service
                .workspace_open(&RequestContext::unbounded(), params)
                .await
                .expect("open workspace");
            let handle: WorkspaceHandle =
                serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
            let open = service.open(Some(&handle)).expect("open state");
            assert_eq!(lock(&open.capture).is_some(), capture_enabled);
            assert_eq!(
                lock(&open.automation_recovery).is_some(),
                seed_claim && !read_only
            );

            // The synchronous cleanup fallback has no Tokio runtime. Taking
            // both tasks must cancel them there without spawning a join task.
            let tasks = std::thread::spawn(move || open.begin_capture_shutdown())
                .join()
                .expect("background cancellation needs no runtime");
            assert_eq!(
                tasks.iter().flatten().count(),
                usize::from(capture_enabled) + usize::from(seed_claim && !read_only),
            );
            for task in tasks.into_iter().flatten() {
                task.await
                    .expect("background task joins after cancellation");
            }
            let open = service.open(Some(&handle)).expect("binding still open");
            assert!(lock(&open.capture).is_none());
            assert!(lock(&open.automation_recovery).is_none());
            service
                .workspace_close(Some(handle))
                .await
                .expect("close workspace after drain");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn maintenance_free_open_does_not_apply_pending_migrations() {
        let scratch = ScratchDir::new().expect("scratch");
        root_binding::write_root_binding(scratch.path(), BINDING_TOKEN).expect("root binding");
        let db_path = scratch.path().join(".dohc/engine/engine.db");
        std::fs::create_dir_all(db_path.parent().expect("engine parent"))
            .expect("engine directory");
        let mut store = dohc_engine_storage::EngineStore::open(&db_path, 1).expect("fixture store");
        assert!(
            store
                .bind_root_token(BINDING_TOKEN, &NoFaults)
                .expect("bind root token")
        );
        drop(store);

        // A store whose ledger lacks the baseline row needs the migration
        // runner. A maintenance-free open must refuse it, not repair it.
        let conn = rusqlite::Connection::open(&db_path).expect("fixture connection");
        conn.execute("DELETE FROM engine_migrations", [])
            .expect("remove the baseline ledger row");
        drop(conn);

        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "read-only-pending-migration",
                    "recoverRunningDispatches": false,
                    "skipStartupMaintenance": true,
                }),
            )
            .await;
        assert!(
            opened.is_err(),
            "a maintenance-free open must refuse a store that needs migration"
        );

        let conn = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("read migration ledger");
        let present: i64 = conn
            .query_row("SELECT COUNT(*) FROM engine_migrations", [], |row| {
                row.get(0)
            })
            .expect("migration count");
        assert_eq!(
            present, 0,
            "a maintenance-free read must not apply a pending migration"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn maintenance_free_handle_is_not_reused_for_full_open() {
        let scratch = ScratchDir::new().expect("scratch");
        root_binding::write_root_binding(scratch.path(), BINDING_TOKEN).expect("root binding");
        let db_path = scratch.path().join(".dohc/engine/engine.db");
        std::fs::create_dir_all(db_path.parent().expect("engine parent"))
            .expect("engine directory");
        let mut store = dohc_engine_storage::EngineStore::open(&db_path, 1).expect("fixture store");
        assert!(
            store
                .bind_root_token(BINDING_TOKEN, &NoFaults)
                .expect("bind root token")
        );
        drop(store);

        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "open-mode-compatibility",
        });
        let read_only = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "open-mode-compatibility",
                    "skipStartupMaintenance": true,
                }),
            )
            .await
            .expect("maintenance-free open");
        let read_only_handle: WorkspaceHandle =
            serde_json::from_value(read_only["workspace"].clone()).expect("workspace handle");

        let incompatible = service
            .workspace_open(&RequestContext::unbounded(), params.clone())
            .await;
        assert!(
            matches!(
                incompatible,
                Err(WireError {
                    code: ErrorCode::InvalidParams,
                    ..
                })
            ),
            "a full open must not reuse a maintenance-free handle"
        );

        service
            .workspace_close(Some(read_only_handle))
            .await
            .expect("close maintenance-free handle");
        let full = service
            .workspace_open(&RequestContext::unbounded(), params)
            .await
            .expect("full open after maintenance-free close");
        let full_handle: WorkspaceHandle =
            serde_json::from_value(full["workspace"].clone()).expect("full workspace handle");
        assert!(
            lock(&service.handles)
                .get(&full_handle)
                .is_some_and(|open| lock(&open.capture).is_some()),
            "the subsequent full open must run startup and own capture"
        );
        service
            .workspace_close(Some(full_handle))
            .await
            .expect("close full handle");
    }

    #[tokio::test]
    async fn cancelled_workspace_open_does_not_wait_for_open_lock() {
        let service = Arc::new(EngineService::new());
        let held = service.open_lock.lock().await;
        let ctx = RequestContext::unbounded();
        let cancel = ctx.cancel.clone();
        let queued_service = Arc::clone(&service);
        let queued = tokio::spawn(async move {
            queued_service
                .workspace_open(
                    &ctx,
                    json!({
                        "rootDir": std::env::temp_dir().join("dohc-r14-cancelled-open"),
                        "workspaceId": "cancelled-open"
                    }),
                )
                .await
        });

        tokio::task::yield_now().await;
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_millis(250), queued)
            .await
            .expect("cancelled open resolved promptly")
            .expect("queued task completed")
            .expect_err("cancelled queued open must fail");
        assert_eq!(result.code, ErrorCode::Cancelled);
        drop(held);
    }

    #[tokio::test]
    async fn check_move_cancellation_and_deadline_return_while_actor_query_is_queued() {
        use dohc_engine_protocol::transport::EngineService as _;
        for deadline in [false, true] {
            let scratch = ScratchDir::new().unwrap();
            let service = EngineService::new();
            let opened = service.workspace_open(&RequestContext::unbounded(),json!({
                "rootDir":scratch.path(),"workspaceId":"cancelled-check-move","captureMode":"none"
            })).await.unwrap();
            let handle: WorkspaceHandle =
                serde_json::from_value(opened["workspace"].clone()).unwrap();
            let actor = service.open(Some(&handle)).unwrap().actor.clone();
            let gate = GateFaults::at(FaultPoint::StorageBeforePersist);
            let faults: Arc<dyn FaultInjector> = gate.clone();
            let held = tokio::spawn(async move {
                actor
                    .versioned_text_write(
                        WriteText {
                            workspace_id: "cancelled-check-move".into(),
                            version_id: "main".into(),
                            object_id: "object".into(),
                            path: "held.md".into(),
                            text: "held".into(),
                            moment_id: "held".into(),
                            metadata_origin: "test".into(),
                            metadata_summary: None,
                            metadata_correlation_id: None,
                            author_json: None,
                            now_ms: 1,
                            request_id: None,
                        },
                        faults,
                        dohc_engine_runtime::CancellationToken::new(),
                    )
                    .await
            });
            let wait = gate.clone();
            tokio::task::spawn_blocking(move || wait.wait_until_reached())
                .await
                .unwrap();
            let mut ctx = RequestContext::unbounded();
            if deadline {
                tokio::time::pause();
                ctx.deadline =
                    Some(tokio::time::Instant::now().into_std() + Duration::from_secs(60));
            }
            let cancel = ctx.cancel.clone();
            let mut checking = Box::pin(service.call(
                ctx,
                dohc_engine_protocol::wire::Request {
                    id: 71,
                    method: "versionedText.checkMove".into(),
                    workspace: Some(handle.clone()),
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params: json!({"versionId":"main","path":"held.md"}),
                },
            ));
            std::future::poll_fn(|cx| {
                assert!(std::future::Future::poll(checking.as_mut(), cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            if deadline {
                tokio::time::advance(Duration::from_secs(61)).await;
            } else {
                cancel.cancel();
            }
            let result = tokio::time::timeout(Duration::from_millis(250), checking.as_mut()).await;
            let actor_still_held = !held.is_finished();
            if deadline {
                tokio::time::resume();
            }
            gate.release();
            held.await.unwrap().unwrap();
            drop(checking);
            service.workspace_close(Some(handle)).await.unwrap();
            assert!(
                actor_still_held,
                "the actor query cannot finish before cancellation"
            );
            assert_eq!(
                result
                    .expect("cancelled checkMove returns before actor release")
                    .unwrap_err()
                    .code,
                if deadline {
                    ErrorCode::DeadlineExceeded
                } else {
                    ErrorCode::Cancelled
                }
            );
        }
    }

    #[tokio::test]
    async fn workspace_open_budget_cancellation_keeps_cleanup_ownership_through_worker_completion()
    {
        for deadline in [false, true] {
            let scratch = ScratchDir::new().unwrap();
            let supervisor: &'static WorkspaceSupervisor =
                Box::leak(Box::new(WorkspaceSupervisor::new()));
            let config=serde_json::from_value(json!({
                "ingress":{"aggregateBytes":400_000_000,"applicationWorkingReserveBytes":1_000_000,"maxUploads":2,"uploadDeadlineMs":30_000},
                "maxRegistrations":4,"maxAdoptionBytes":1_000_000,"maxAdoptionEvents":100,"maxApplicationsPerSettlement":100,
                "ownerOutbox":{"maxPendingBytes":1_000_000,"maxPendingAgeMs":60_000}
            })).unwrap();
            let probe = capture_driver::CaptureApplyProbe::default();
            probe.pause_next_open_budget();
            let mut service = EngineService::with_supervisor(supervisor);
            service.capture_apply_probe = Some(probe.clone());
            let (service, _owner, ingress) = service.configure_ordinary_live_host(config).unwrap();
            drop(ingress);
            let params = json!({"rootDir":scratch.path(),"workspaceId":"cancelled-open-budget","captureMode":"none"});
            let mut ctx = RequestContext::unbounded();
            if deadline {
                ctx.deadline = Some(std::time::Instant::now() + Duration::from_secs(60));
            }
            let cancel = ctx.cancel.clone();
            let opening_service = service.clone();
            let opening_params = params.clone();
            let mut opening =
                tokio::spawn(
                    async move { opening_service.workspace_open(&ctx, opening_params).await },
                );
            probe.wait_until_open_budget_paused().await;
            assert_eq!(supervisor.actor_count(), 1);
            assert!(lock(&service.handles).is_empty());
            if deadline {
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(61)).await;
            } else {
                cancel.cancel();
            }
            let cancelled = tokio::time::timeout(Duration::from_millis(250), &mut opening).await;
            let retained = service.open_lock.try_lock().is_err();
            if deadline {
                tokio::time::resume();
            }
            let reopening_service = service.clone();
            let reopening = tokio::spawn(async move {
                reopening_service
                    .workspace_open(&RequestContext::unbounded(), params)
                    .await
            });
            probe.release_open_budget();
            if cancelled.is_err() {
                opening.abort();
                let _ = opening.await;
            }
            let reopened = reopening.await.unwrap().unwrap();
            let handle = serde_json::from_value(reopened["workspace"].clone()).unwrap();
            service.workspace_close(Some(handle)).await.unwrap();
            assert_eq!(supervisor.actor_count(), 0);
            assert!(
                retained,
                "budget worker owns open serialization until it installs Closing"
            );
            assert_eq!(
                cancelled
                    .expect("cancelled budget read returns before worker release")
                    .unwrap()
                    .unwrap_err()
                    .code,
                if deadline {
                    ErrorCode::DeadlineExceeded
                } else {
                    ErrorCode::Cancelled
                }
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn initial_root_binding_reopens_after_marker_or_schema_commit() {
        for schema_committed in [false, true] {
            let scratch = ScratchDir::new().expect("scratch");
            let token = root_binding::write_new_root_binding(scratch.path()).unwrap();
            let db_path = scratch.path().join(".dohc/engine/engine.db");
            if schema_committed {
                // Stop at the real actor-open boundary, before RPC bind_root.
                let interrupted = WorkspaceSupervisor::new();
                let opened = interrupted
                    .open_root_bound(&db_path, 1, &token, None)
                    .unwrap();
                assert!(opened.store_freshly_created);
                drop(opened);
                interrupted.close(&db_path).unwrap();
            }
            let supervisor: &'static WorkspaceSupervisor =
                Box::leak(Box::new(WorkspaceSupervisor::new()));
            let service = EngineService::with_supervisor(supervisor);
            service
                .workspace_open(
                    &RequestContext::unbounded(),
                    json!({
                        "rootDir": scratch.path().to_string_lossy(),
                        "workspaceId": "initialization-recovery",
                        "captureMode": "none"
                    }),
                )
                .await
                .expect("interrupted initialization must reopen");
            assert_eq!(
                root_binding::read_root_binding(scratch.path()).unwrap(),
                Some(token)
            );
            supervisor.close(&db_path).unwrap();
        }
    }

    /// A fresh store whose root-binding stamp fails is deleted with the
    /// refusal, so the next open mints again instead of finding an engine.db
    /// that never recorded the marker and refusing it as a mismatch.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fresh_store_whose_stamp_fails_is_deleted_and_the_next_open_binds() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let mut service = EngineService::with_supervisor(supervisor);
        // One-shot: the first stamp's transaction rolls back as a
        // `PersistFailed`; the second open's stamp commits.
        service.bind_root_faults = Some(ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist));
        let params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "stamp-fails",
            "captureMode": "none"
        });
        let db_path = scratch.path().join(".dohc/engine/engine.db");

        let refused = service
            .workspace_open(&RequestContext::unbounded(), params.clone())
            .await
            .expect_err("a stamp that fails refuses the open");
        assert_eq!(refused.code, ErrorCode::InvalidParams);
        assert_eq!(
            refused.message,
            "engine database could not record its root binding"
        );
        assert!(!db_path.exists(), "the unstamped store is deleted");
        assert!(
            root_binding::read_root_binding(scratch.path())
                .expect("read")
                .is_some(),
            "the marker the open minted stays"
        );

        let opened = service
            .workspace_open(&RequestContext::unbounded(), params)
            .await
            .expect("the next open binds the fresh store to the marker");
        let _handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        assert!(db_path.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn progress_is_reported_on_each_poll_that_finds_the_work_moved() {
        let done = AtomicU64::new(0);
        let reports = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = Arc::clone(&reports);
        let sink = ProgressSink::new(1, move |message| {
            count.fetch_add(1, Ordering::SeqCst);
            drop(message);
        });
        let work = async {
            // Between polls, so each poll finds exactly one step.
            tokio::time::sleep(OPEN_PROGRESS_POLL / 2).await;
            for _ in 0..3 {
                done.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(OPEN_PROGRESS_POLL).await;
            }
            // A stall: the polls find nothing new and report nothing.
            tokio::time::sleep(OPEN_PROGRESS_POLL * 10).await;
            "opened"
        };
        let opened = report_while(&sink, || done.load(Ordering::Relaxed), work).await;
        assert_eq!(opened, "opened");
        assert_eq!(reports.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_open_that_asked_reports_its_store_work_while_it_is_still_open() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let probe = capture_driver::CaptureApplyProbe::default();
        probe.pause_next_open_install();
        let mut service = EngineService::with_supervisor(supervisor);
        service.capture_apply_probe = Some(probe.clone());
        let service = Arc::new(service);
        let (reported, mut reports) = tokio::sync::mpsc::unbounded_channel();
        let ctx = RequestContext::unbounded().with_progress(ProgressSink::new(5, move |message| {
            let _ = reported.send(message.id());
        }));
        let params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "progress-open",
            "captureMode": "none"
        });
        let opening_service = Arc::clone(&service);
        let opening =
            tokio::spawn(async move { opening_service.workspace_open(&ctx, params).await });
        // The store has opened and migrated; the open holds before it installs.
        probe.wait_until_open_install_paused().await;
        let id = tokio::time::timeout(OPEN_PROGRESS_POLL * 120, reports.recv())
            .await
            .expect("a poll reports the store work")
            .expect("the sink is still open");
        assert_eq!(id, 5);
        probe.release_open_install();
        let opened = opening
            .await
            .expect("open task")
            .expect("workspace.open succeeds");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_workspace_open_releases_actor_before_immediate_reopen() {
        let scratch = ScratchDir::new().expect("scratch");
        root_binding::write_root_binding(scratch.path(), BINDING_TOKEN).expect("root binding");
        let db_path = scratch.path().join(".dohc/engine/engine.db");
        let mut store = dohc_engine_storage::EngineStore::open(&db_path, 1).expect("fixture store");
        assert!(
            store
                .bind_root_token(BINDING_TOKEN, &NoFaults)
                .expect("bind root token")
        );
        drop(store);
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let probe = capture_driver::CaptureApplyProbe::default();
        probe.pause_next_open_install();
        let mut service = EngineService::with_supervisor(supervisor);
        service.capture_apply_probe = Some(probe.clone());
        let service = Arc::new(service);
        let params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "cancelled-open-reopen",
            "captureMode": "none"
        });

        let opening_context = RequestContext::unbounded();
        let cancel_opening = opening_context.cancel.clone();
        let opening_service = Arc::clone(&service);
        let opening_params = params.clone();
        let opening = tokio::spawn(async move {
            opening_service
                .workspace_open(&opening_context, opening_params)
                .await
        });
        probe.wait_until_open_install_paused().await;
        assert_eq!(supervisor.actor_count(), 1, "the supervisor actor exists");
        assert!(
            lock(&service.handles).is_empty(),
            "the service handle is not installed yet"
        );

        cancel_opening.cancel();
        let cancelled_open = tokio::time::timeout(Duration::from_millis(250), opening).await;
        let cleanup_retains_serialization = service.open_lock.try_lock().is_err();
        let reopening_service = Arc::clone(&service);
        let reopening = tokio::spawn(async move {
            reopening_service
                .workspace_open(&RequestContext::unbounded(), params)
                .await
        });
        probe.release_open_install();
        let cancelled_open = cancelled_open
            .expect("cancelled workspace.open resolved promptly")
            .expect("workspace.open task completed")
            .expect_err("cancelled workspace.open must fail");
        assert_eq!(cancelled_open.code, ErrorCode::Cancelled);
        assert!(
            cleanup_retains_serialization,
            "cancelled open must retain serialization until cleanup starts"
        );

        let reopened = reopening
            .await
            .expect("reopen task completed")
            .expect("immediate workspace reopen");
        let handle: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).expect("workspace handle");
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
        assert_eq!(supervisor.actor_count(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_workspace_close_keeps_reopen_serialized_until_actor_is_closed() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let baseline = supervisor.actor_count();
        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "cancelled-close",
            "captureMode": "none"
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("initial workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        let actor = lock(&service.handles)
            .get(&handle)
            .expect("open workspace")
            .actor
            .clone();

        let gate = GateFaults::at(FaultPoint::StorageBeforePersist);
        let gate_faults: Arc<dyn FaultInjector> = gate.clone();
        let held_write = tokio::spawn(async move {
            actor
                .versioned_text_write(
                    WriteText {
                        workspace_id: "cancelled-close".to_owned(),
                        version_id: "main".to_owned(),
                        object_id: "object-held".to_owned(),
                        path: "held.md".to_owned(),
                        text: "held".to_owned(),
                        moment_id: "moment-held".to_owned(),
                        metadata_origin: "user".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 1,
                        request_id: None,
                    },
                    gate_faults,
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await
        });
        let gate_wait = gate.clone();
        tokio::task::spawn_blocking(move || gate_wait.wait_until_reached())
            .await
            .expect("gate wait task");

        let closing_service = Arc::clone(&service);
        let closing_handle = handle.clone();
        let closing =
            tokio::spawn(
                async move { closing_service.workspace_close(Some(closing_handle)).await },
            );
        tokio::time::timeout(Duration::from_secs(10), async {
            while lock(&service.handles).contains_key(&handle) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("close removed the handle within the deadline");
        closing.abort();
        assert!(
            closing
                .await
                .expect_err("close request was cancelled")
                .is_cancelled()
        );

        let reopening_service = Arc::clone(&service);
        let mut reopening = tokio::spawn(async move {
            reopening_service
                .workspace_open(&RequestContext::unbounded(), open_params)
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut reopening)
                .await
                .is_err(),
            "reopen must wait for the detached close"
        );
        gate.release();
        held_write
            .await
            .expect("held write task")
            .expect("held write");

        let reopened = tokio::time::timeout(Duration::from_secs(10), reopening)
            .await
            .expect("reopen completed within the deadline")
            .expect("reopen task")
            .expect("workspace reopen");
        let reopened_handle: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).expect("reopened handle");
        let reopened_actor = lock(&service.handles)
            .get(&reopened_handle)
            .expect("reopened workspace")
            .actor
            .clone();
        assert_eq!(reopened_actor.lifecycle(), LifecycleState::Ready);
        assert_eq!(supervisor.actor_count(), baseline + 1);

        service
            .workspace_close(Some(reopened_handle))
            .await
            .expect("final workspace close");
        assert_eq!(supervisor.actor_count(), baseline);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn aborted_workspace_close_cannot_retain_a_cancelled_capture_driver() {
        let scratch = ScratchDir::new().expect("scratch");
        std::fs::write(scratch.path().join("seed.md"), "captured before close").expect("seed file");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "cancelled-capture-close"
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("initial workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        let held_sessions = {
            let open = lock(&service.handles)
                .get(&handle)
                .expect("open workspace")
                .clone();
            Arc::clone(&open.session_ops).lock_owned().await
        };

        let closing_service = Arc::clone(&service);
        let closing_handle = handle.clone();
        let closing =
            tokio::spawn(
                async move { closing_service.workspace_close(Some(closing_handle)).await },
            );
        tokio::time::timeout(Duration::from_secs(10), async {
            while lock(&service.handles).contains_key(&handle) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("close must own and remove the handle before waiting on sessions");

        closing.abort();
        assert!(
            closing
                .await
                .expect_err("close RPC was cancelled")
                .is_cancelled()
        );
        let stale = service
            .capture_flush(&RequestContext::unbounded(), Some(handle.clone()))
            .await
            .expect_err("an owned close must not retain a live handle");
        assert_eq!(stale.code, ErrorCode::WorkspaceUnavailable);

        let reopening_service = Arc::clone(&service);
        let mut reopening = tokio::spawn(async move {
            reopening_service
                .workspace_open(&RequestContext::unbounded(), open_params)
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut reopening)
                .await
                .is_err(),
            "the detached close must retain the global Closing marker"
        );
        drop(held_sessions);

        let reopened = tokio::time::timeout(Duration::from_secs(10), reopening)
            .await
            .expect("reopen completed after the session barrier released")
            .expect("reopen task")
            .expect("workspace reopen");
        let reopened_handle: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).expect("reopened handle");
        let flush = service
            .capture_flush(&RequestContext::unbounded(), Some(reopened_handle.clone()))
            .await
            .expect("reopened capture flush");
        assert_eq!(flush["settled"], json!(true));
        service
            .history_page(
                &RequestContext::unbounded(),
                Some(reopened_handle.clone()),
                json!({ "workspaceId": "cancelled-capture-close" }),
            )
            .await
            .expect("reopened history read");
        service
            .workspace_close(Some(reopened_handle))
            .await
            .expect("final workspace close");
    }

    #[tokio::test]
    async fn two_services_share_close_reopen_serialization_for_one_root() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service_a = Arc::new(EngineService::with_supervisor(supervisor));
        let service_b = Arc::new(EngineService::with_supervisor(supervisor));
        let baseline = supervisor.actor_count();
        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "two-services"
        });
        let opened = service_a
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("service A workspace open");
        let handle_a: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("service A handle");

        let closing_service = Arc::clone(&service_a);
        let closing =
            tokio::spawn(async move { closing_service.workspace_close(Some(handle_a)).await });
        tokio::time::timeout(Duration::from_secs(10), async {
            while !lock(&service_a.handles).is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("service A close removed its handle");
        let opening_service = Arc::clone(&service_b);
        let opening = tokio::spawn(async move {
            opening_service
                .workspace_open(&RequestContext::unbounded(), open_params)
                .await
        });

        tokio::time::timeout(Duration::from_secs(10), closing)
            .await
            .expect("service A close completed within the deadline")
            .expect("service A close task")
            .expect("service A close");
        let reopened = tokio::time::timeout(Duration::from_secs(10), opening)
            .await
            .expect("service B open completed within the deadline")
            .expect("service B open task")
            .expect("service B reopen");
        let handle_b: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).expect("service B handle");
        let actor_b = lock(&service_b.handles)
            .get(&handle_b)
            .expect("service B workspace")
            .actor
            .clone();
        assert_eq!(actor_b.lifecycle(), LifecycleState::Ready);
        assert_eq!(supervisor.actor_count(), baseline + 1);

        service_b
            .workspace_close(Some(handle_b))
            .await
            .expect("service B close");
        assert_eq!(supervisor.actor_count(), baseline);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capture_driver_status_tracks_the_workspace_lifecycle() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "driver-status"
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        let status = {
            let guard = lock(&service.handles);
            let open = guard.get(&handle).expect("open workspace");
            let capture = lock(&open.capture);
            Arc::clone(capture.as_ref().expect("driver present").status())
        };
        // The files layer comes up shortly after open (watcher attach +
        // baseline reconcile) and must not be degraded on the happy path.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !status.running() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "driver never reported running"
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(!status.degraded(), "happy path must not be degraded");

        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
        // Close drains the driver fully: running flips off.
        assert!(!status.running(), "driver reports stopped after close");
    }

    #[tokio::test]
    async fn interleaved_workspace_reopens_return_live_actors_without_leaks() {
        let scratch = ScratchDir::new().expect("scratch");
        // Isolated supervisor so the actor-count baseline can't race other tests
        // sharing the process-global one.
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let baseline = service.supervisor.actor_count();
        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "open-close-race"
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("initial workspace open");
        let mut handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        for _ in 0..128 {
            let closing_service = Arc::clone(&service);
            let closing_handle = handle.clone();
            let closing =
                tokio::spawn(
                    async move { closing_service.workspace_close(Some(closing_handle)).await },
                );
            tokio::time::timeout(Duration::from_secs(10), async {
                while lock(&service.handles).contains_key(&handle) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("close removed the handle within the deadline");

            let opening_service = Arc::clone(&service);
            let iteration_params = open_params.clone();
            let opening = tokio::spawn(async move {
                opening_service
                    .workspace_open(&RequestContext::unbounded(), iteration_params)
                    .await
            });
            closing
                .await
                .expect("close task completed")
                .expect("workspace close");
            let reopened = opening
                .await
                .expect("open task completed")
                .expect("workspace reopen");
            handle = serde_json::from_value(reopened["workspace"].clone())
                .expect("reopened workspace handle");
            service
                .conflicts_list(
                    &RequestContext::unbounded(),
                    1,
                    Some(handle.clone()),
                    json!({}),
                )
                .await
                .expect("reopened actor is live");
        }

        service
            .workspace_close(Some(handle))
            .await
            .expect("final workspace close");
        assert_eq!(service.supervisor.actor_count(), baseline);
    }

    /// A workspace whose actor died is evicted and rebound by the next open,
    /// never closed. That path dropped the handle and the sessions but left
    /// the handle's pending cursors in the map, where nothing could ever
    /// remove them: `consume_pending_cursor` matches on the handle, and every
    /// rebind mints a new one from a monotonic counter. Each evicted binding
    /// therefore stranded one entry per issued cursor for the life of the
    /// process. The normal close path has always dropped them.
    #[tokio::test]
    async fn evicting_a_dead_binding_drops_its_pending_cursors() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let open_params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "evicted-cursor-cleanup"
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), open_params.clone())
            .await
            .expect("initial workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        let retained = service.open(Some(&handle)).expect("retained dead binding");

        lock(&service.pending_cursors).insert(
            "evicted-token".to_owned(),
            PendingCursor {
                handle: handle.clone(),
                workspace_id: "evicted-cursor-cleanup".to_owned(),
                materialization_paths: Vec::new(),
                materialized: false,
                cursor: IssuedCursor::Relay(dohc_engine_sync::RelayCursor {
                    bootstrap_complete: true,
                    cursor: 7,
                    replication_epoch: "epoch".to_owned(),
                    stream_identity: "stream".to_owned(),
                    refusal_report_id: None,
                    settlement_report_id: None,
                }),
            },
        );

        // Kill the actor underneath the live handle. The next open finds a
        // bound-but-Closed actor and takes the eviction path rather than the
        // short-circuit or the close path.
        let db_path = scratch
            .path()
            .join(".dohc")
            .join("engine")
            .join("engine.db");
        let closing_path = db_path.clone();
        let _closed = tokio::task::spawn_blocking(move || supervisor.close(&closing_path))
            .await
            .expect("actor close task");

        let reopened = service
            .workspace_open(&RequestContext::unbounded(), open_params)
            .await
            .expect("workspace reopen after the actor died");
        let rebound: WorkspaceHandle =
            serde_json::from_value(reopened["workspace"].clone()).expect("rebound handle");
        assert_ne!(rebound, handle, "eviction must mint a fresh handle");
        let next = service.open(Some(&rebound)).expect("rebound access");
        assert!(!Arc::ptr_eq(&retained, &next));
        assert_eq!(retained.actor.lifecycle(), LifecycleState::Closed);
        assert!(lock(&retained.capture).is_none());
        assert!(lock(&next.capture).is_some());
        assert!(!Arc::ptr_eq(&retained.capture, &next.capture));

        assert!(
            lock(&service.pending_cursors).is_empty(),
            "eviction must drop the dead binding's pending cursors"
        );

        service
            .workspace_close(Some(rebound))
            .await
            .expect("final workspace close");
    }
}
