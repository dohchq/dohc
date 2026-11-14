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
use crate::rpc::request::after_landing;
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

/// How long a landed step waits for the capture gate before it leaves its
/// Collections update to the next text write, push, or terminal page's commit.
const OWED_COLLECTIONS_GATE_WAIT: Duration = Duration::from_secs(2);

/// A `capture.hold`: the apply gate it holds, and when it ends unless the
/// holder renews it first.
pub(super) struct CaptureHold {
    pub(super) operation_id: Option<String>,
    pub(super) _guard: tokio::sync::OwnedMutexGuard<()>,
    pub(super) expires_at: tokio::time::Instant,
}

pub(super) type CaptureHolds = Arc<Mutex<HashMap<String, CaptureHold>>>;

pub(crate) struct OpenWorkspace {
    pub(super) root: PathBuf,
    pub(crate) workspace_id: String,
    pub(super) actor: ActorHandle,
    pub(super) durability: super::automations::DurabilityQueue,
    pub(super) mode: WorkspaceOpenMode,
    handle_kind: WorkspaceHandleKind,
    pub(super) relay: Option<RelayConfiguration>,
    /// The binding's capture policy, retained when its driver stops and inherited by read-only attachments.
    pub(super) capture_enabled: bool,
    pub(crate) observation: Arc<crate::file_observation::FileObservation>,
    /// The autonomous capture driver (files actor + watcher + reconcile
    /// loop), spawned only after the root binding succeeded. Shared so the
    /// teardown paths can take it exactly once.
    pub(super) capture: Arc<Mutex<Option<capture_driver::CaptureDriver>>>,
    /// The workspace opened without capture and asked to keep its Collections
    /// current itself, as a server's automation replica does.
    reconciles_collections: bool,
    projects_collections: bool,
    collection_projection:
        Arc<Mutex<Option<crate::collection_projection::CollectionProjectionWorker>>>,
    automation_recovery: Arc<Mutex<Option<automation_recovery::AutomationRecovery>>>,
    undo_recovery: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    markdown_recovery: Arc<Mutex<Option<super::markdown_recovery::MarkdownRecovery>>>,
    /// Held by every capture reconcile+apply and by versions.setActive across
    /// its forced full scan plus switch transaction. This drains an in-flight
    /// apply and prevents a new one from resolving the destination version
    /// across the active-version boundary.
    pub(super) capture_apply_gate: capture_driver::ApplyGate,
    /// The apply gate, held by `capture.hold` until `capture.release`, the
    /// end of an unrenewed lease, or the workspace closes, keyed by hold id.
    pub(super) capture_holds: CaptureHolds,
    /// Serializes Y.Doc admission and versioned mutations for this workspace.
    /// Version fences retain this gate through their destructive continuation,
    /// without stalling editor traffic in unrelated open workspaces.
    pub(super) session_ops: Arc<tokio::sync::Mutex<()>>,
    /// One fetched batch, bound to this open handle and replaced by the next fetch.
    pub(super) pending_pull: tokio::sync::Mutex<Option<super::relay::PendingPull>>,
    /// Pages taken by apply requests that close must release if they have not begun.
    pub(super) applying_pulls: Mutex<Vec<Arc<dohc_engine_sync::PreparedOrdinaryPull>>>,
    pub(super) pull_fetch_cancel: dohc_engine_protocol::cancel::CancelSignal,
    pub(super) pull_repair_retries: std::sync::atomic::AtomicUsize,
    /// How many pending cursors of each kind this handle has issued, counted
    /// under the pending-cursor lock. A commit that did not land restores its
    /// token only if no newer cursor of its kind was issued since.
    pub(super) cursors_issued: [std::sync::atomic::AtomicU64; 3],
    /// A landed step changed what this workspace's Collections hold and the
    /// update has not run yet. The next text write, push, or terminal page's
    /// commit runs it.
    pub(super) collections_owed: std::sync::atomic::AtomicBool,
    /// Pulls that may be placing a page, counted from under the capture gate
    /// before their first relay step until they are between pages, finish,
    /// or fail.
    pub(super) pulls_in_flight: std::sync::atomic::AtomicUsize,
    /// Closes whose session ended but whose file write did not land, by
    /// session id. A retried close reports them until the write lands.
    pub(super) unfinished_closes: super::ydoc::UnfinishedCloses,
    /// What this binding's last open that writes prepared in `.dohc/local`.
    /// On Windows it holds the folder until the binding closes.
    local_state: Mutex<Option<root_binding::LocalState>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WorkspaceOpenMode {
    Full,
    Passive,
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
    pub(super) fn projects_collections(&self) -> bool {
        self.projects_collections
    }
    pub(super) fn is_local_owner(&self) -> bool {
        self.handle_kind.owns_binding() && self.mode == WorkspaceOpenMode::Full
    }

    fn read_only_attach(&self, owner: WorkspaceHandle) -> Self {
        Self {
            root: self.root.clone(),
            workspace_id: self.workspace_id.clone(),
            actor: self.actor.clone(),
            durability: self.durability.clone(),
            mode: WorkspaceOpenMode::ReadOnly,
            handle_kind: WorkspaceHandleKind::ReadOnlyAttach { owner },
            relay: self.relay.clone(),
            capture_enabled: self.capture_enabled,
            observation: Arc::clone(&self.observation),
            capture: Arc::clone(&self.capture),
            reconciles_collections: self.reconciles_collections,
            projects_collections: self.projects_collections,
            collection_projection: Arc::clone(&self.collection_projection),
            automation_recovery: Arc::clone(&self.automation_recovery),
            undo_recovery: Arc::clone(&self.undo_recovery),
            markdown_recovery: Arc::clone(&self.markdown_recovery),
            capture_apply_gate: Arc::clone(&self.capture_apply_gate),
            capture_holds: Arc::clone(&self.capture_holds),
            session_ops: Arc::clone(&self.session_ops),
            pending_pull: Default::default(),
            applying_pulls: Default::default(),
            pull_fetch_cancel: Default::default(),
            pull_repair_retries: Default::default(),
            cursors_issued: Default::default(),
            collections_owed: Default::default(),
            pulls_in_flight: Default::default(),
            unfinished_closes: Default::default(),
            local_state: Mutex::new(None),
        }
    }

    /// A pull may place a page before an update started now would run.
    fn mid_pull(&self) -> bool {
        self.pulls_in_flight.load(Ordering::SeqCst) > 0
    }

    pub(super) fn request_collection_reconcile(&self) {
        if let Some(projection) = lock(&self.collection_projection).as_ref() {
            projection.request();
        }
        if let Some(driver) = lock(&self.capture).as_ref() {
            driver.status().request_collection_reconcile();
        }
    }

    /// Signal the background tasks to stop without removing their handles. A version
    /// fence that already owns the apply gate can still finish against the
    /// driver; teardown takes the handle only after acquiring that gate.
    fn request_capture_shutdown(&self) {
        if let Some(recovery) = lock(&self.markdown_recovery).as_ref() {
            recovery.request_shutdown();
        }
        self.observation.request_shutdown();
        if let Some(projection) = lock(&self.collection_projection).as_ref() {
            projection.request_shutdown();
        }
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
    fn begin_capture_shutdown(&self) -> [Option<tokio::task::JoinHandle<()>>; 6] {
        self.observation.request_shutdown();
        let projection = lock(&self.collection_projection)
            .take()
            .and_then(crate::collection_projection::CollectionProjectionWorker::begin_shutdown);
        let capture = lock(&self.capture)
            .take()
            .and_then(capture_driver::CaptureDriver::begin_shutdown);
        let recovery = lock(&self.automation_recovery)
            .take()
            .and_then(automation_recovery::AutomationRecovery::begin_shutdown);
        let undo = lock(&self.undo_recovery)
            .take()
            .inspect(|task| task.abort());
        [
            lock(&self.markdown_recovery)
                .take()
                .and_then(super::markdown_recovery::MarkdownRecovery::begin_shutdown),
            undo,
            capture,
            recovery,
            projection,
            self.observation.begin_shutdown(),
        ]
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

        for (_, workspace) in &open {
            workspace.observation.close_synchronously();
            // The open ends with the service, whatever task still holds the workspace.
            lock(&workspace.local_state).take();
            // Dropping this cancels the Markdown recovery pass without waiting for
            // the runtime that polls it. The pass keeps only a `Weak` between
            // steps, and its writes hold the gates the cleanup takes below.
            lock(&workspace.markdown_recovery).take();
            // Awaiting undo recovery would wait for that same runtime. An aborted
            // task never resumes, and its version fence holds those gates too.
            if let Some(undo) = lock(&workspace.undo_recovery).take() {
                undo.abort();
            }
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
            lock(&workspace.capture_holds).clear();
            let _capture = Arc::clone(&workspace.capture_apply_gate).lock_owned().await;
            let _sessions = Arc::clone(&workspace.session_ops).lock_owned().await;
            lock(&self.sessions).retain(|_, session| session.workspace != handle);
            workspace.shutdown_capture().await;
            let closing_workspace = Arc::clone(&workspace);
            let supervisor = self.supervisor;
            let _ = tokio::task::spawn_blocking(move || {
                supervisor.close_identity(closing_workspace.actor.identity())
            })
            .await;
            self.self_writes
                .scoped(&workspace.root)
                .clear_workspace(&workspace.workspace_id);
        }
    }

    fn close_synchronously(self) {
        for (handle, workspace) in self.open {
            lock(&self.sessions).retain(|_, session| session.workspace != handle);
            workspace.observation.close_synchronously();
            let _ = workspace.begin_capture_shutdown();
            let _ = self.supervisor.close_identity(workspace.actor.identity());
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
    /// The actor to close, by the identity its handle carries.
    identity: Option<dohc_engine_runtime::EngineDbIdentity>,
    observation: Option<Arc<crate::file_observation::FileObservation>>,
    _open_serial: tokio::sync::OwnedMutexGuard<()>,
}

impl OpenGuard {
    fn disarm(mut self) {
        self.identity = None;
        self.observation = None;
    }
}

impl Drop for OpenGuard {
    fn drop(&mut self) {
        let observation = self.observation.take();
        if let Some(observation) = &observation {
            observation.request_shutdown();
        }
        let identity = self.identity.take();
        if identity.is_none() && observation.is_none() {
            return;
        }
        let supervisor = self.supervisor;
        let closing =
            identity.and_then(|identity| supervisor.begin_close_identity(&identity).ok().flatten());
        // Detached + blocking: never run the actor join on a runtime worker
        // (the cancellation-safety contract). begin_close installed the
        // Closing marker synchronously, so an immediate reopen waits here.
        tokio::task::spawn_blocking(move || {
            if let Some(observation) = observation {
                observation.close_synchronously();
            }
            if let Some(closing) = closing {
                let _ = closing.finish();
            }
        });
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceOpenParams {
    root_dir: String,
    workspace_id: String,
    #[serde(default)]
    store_mode: Option<WorkspaceStoreMode>,
    #[serde(default)]
    capture_author: Option<Value>,
    #[serde(default)]
    recover_running_dispatches: Option<bool>,
    #[serde(default)]
    skip_startup_maintenance: bool,
    #[serde(default)]
    capture_mode: Option<WorkspaceCaptureMode>,
    /// With captureMode none: reconcile the workspace's Collections after
    /// the changes a capture pass would reconcile after.
    #[serde(default)]
    reconcile_collections: bool,
    #[serde(default)]
    project_collections: bool,
    #[serde(default)]
    relay: Option<RelayOpenParams>,
    /// The workspace has no ordinary sync configured, so an unfinished
    /// ordinary pull's applied pages become local truth before anything can
    /// reconcile them.
    #[serde(default)]
    abandon_ordinary_pull: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum WorkspaceStoreMode {
    Passive,
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

/// The open's handle and, for an open that writes, whether `.dohc/local` is
/// ready for this computer's state. The desktop writes there only when it is.
fn open_result(handle: &WorkspaceHandle, local_state_ready: Option<bool>) -> Value {
    let mut result = json!({ "workspace": handle });
    if let Some(ready) = local_state_ready {
        result["localStateReady"] = json!(ready);
    }
    result
}

fn bound_to_another_workspace() -> WireError {
    WireError::new(
        ErrorCode::InvalidParams,
        "workspace root is already bound to another workspace",
    )
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
    /// Whether this service keeps a workspace's Collections current itself:
    /// its owner opened it without capture and asked to, as a server's
    /// automation replica does, so no capture pass reconciles them.
    pub(super) fn reconciles_collections_itself(&self, open: &OpenWorkspace) -> bool {
        open.reconciles_collections && open.is_local_owner()
    }

    /// A change that can move the workspace's Collections landed. A workspace
    /// with capture asks its driver, whose next pass reconciles after it
    /// applies what it scanned. One that keeps its Collections itself
    /// reconciles now, under the gate a capture pass holds, and wakes the
    /// executors for committed claims. Workspaces that reconcile here have no
    /// capture driver. The request answers with what landed either way.
    pub(super) async fn collections_changed(&self, ctx: &RequestContext, open: &OpenWorkspace) {
        self.collections_landed(open);
        self.settle_owed_collections(ctx, open).await;
    }

    /// A landed step changed what the Collections hold. A workspace that
    /// keeps them itself owes the update until it runs; one with capture asks
    /// its driver.
    pub(super) fn collections_landed(&self, open: &OpenWorkspace) {
        if self.reconciles_collections_itself(open) {
            open.collections_owed.store(true, Ordering::SeqCst);
        } else {
            open.request_collection_reconcile();
        }
    }

    /// Run an owed Collections update after a landed step, which answers with
    /// what landed either way. A renewed `capture.hold` can keep the gate
    /// forever, so the wait for it is bounded. An update that cannot run now
    /// stays owed to the next text write, push, or terminal page's commit. The
    /// update reconciles the whole workspace, so whichever step runs it
    /// repairs every change still owed. Until an ordinary pull commits its
    /// terminal page it stays owed: dangling-link cleanup would remove a
    /// relation whose target a later page brings back. The store refuses the
    /// update while the pull's token stands. A pull counts itself under the
    /// gate before it places a page, so the check under the gate admits no
    /// update that a page could overtake.
    pub(super) async fn settle_owed_collections(&self, ctx: &RequestContext, open: &OpenWorkspace) {
        if !open.collections_owed.load(Ordering::SeqCst) || open.mid_pull() {
            return;
        }
        let Ok(apply) = tokio::time::timeout(
            OWED_COLLECTIONS_GATE_WAIT,
            Arc::clone(&open.capture_apply_gate).lock_owned(),
        )
        .await
        else {
            return;
        };
        // Another step took the update under the gate after this one landed,
        // or a pull started meanwhile.
        if open.mid_pull() || !open.collections_owed.swap(false, Ordering::SeqCst) {
            return;
        }
        let cancellation = OperationCancellation::new(&after_landing(ctx));
        if let Err(error) = self
            .reconcile_collections_under(apply, open, &cancellation)
            .await
        {
            open.collections_owed.store(true, Ordering::SeqCst);
            eprintln!("engine: Collections update deferred: {error:?}");
        }
    }

    /// Reconcile a workspace that keeps its Collections itself, holding the
    /// capture gate `_apply`.
    pub(super) async fn reconcile_collections_under(
        &self,
        _apply: tokio::sync::OwnedMutexGuard<()>,
        open: &OpenWorkspace,
        cancellation: &OperationCancellation,
    ) -> Result<(), WireError> {
        let version_id = match open
            .actor
            .active_version_id(open.workspace_id.clone())
            .await
        {
            Ok(version_id) => version_id,
            // A workspace with no version yet has no Collections.
            Err(dohc_engine_runtime::RuntimeError::Domain(
                dohc_engine_domain::DomainError::WorkspaceNotFound,
            )) => return Ok(()),
            Err(error) => return Err(map_runtime(error)),
        };
        let reconciliation = open
            .actor
            .reconcile_collections(
                open.workspace_id.clone(),
                version_id,
                open.root.clone(),
                self.leases.scoped(&open.root),
                Arc::new(self.self_writes.scoped(&open.root)),
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        if reconciliation.waits_for_pull {
            open.collections_owed.store(true, Ordering::SeqCst);
            return Ok(());
        }
        crate::events::emit_automation_claimed(
            &self.events,
            &open.workspace_id,
            &reconciliation.automation_claims,
        );
        if reconciliation.lease_held {
            return Err(WireError::new(
                ErrorCode::Overloaded,
                "collection reconciliation waits for a document lease",
            ));
        }
        Ok(())
    }

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
        if let Some(relay) = &params.relay {
            relay.validate_transport(self.replica_mode.is_some())?;
        }
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
        if (capture_enabled && (params.reconcile_collections || params.project_collections))
            || (params.project_collections && params.reconcile_collections)
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                if params.project_collections {
                    "projectCollections needs captureMode none and reconcileCollections false"
                } else {
                    "reconcileCollections needs captureMode none"
                },
            ));
        }
        let passive = params.store_mode.is_some();
        if passive
            && (capture_enabled
                || capture_author_supplied
                || params.skip_startup_maintenance
                || params.reconcile_collections
                || params.project_collections
                || params.recover_running_dispatches == Some(true)
                || self.configured_live_host.get().is_some()
                || self.ordinary_live_host.get().is_some())
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "passive store configuration is incompatible",
            ));
        }
        if params.abandon_ordinary_pull
            && (passive || params.skip_startup_maintenance || params.relay.is_some())
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "abandonOrdinaryPull needs a full owner open without relay",
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
        let requested_mode = if passive {
            WorkspaceOpenMode::Passive
        } else if params.skip_startup_maintenance {
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
                return Err(bound_to_another_workspace());
            }
            // A maintenance-free open is read intent, not a request for
            // ownership. Mint a non-owning token over the live binding so its
            // close cannot tear down the desktop's actor, capture, or relay.
            // Same workspace: short-circuit only on a live binding. A bound-but-
            // closed actor (its worker died) is stale — drop it and reopen fresh.
            if (open.mode == WorkspaceOpenMode::Passive) != passive {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "workspace root is already open in a different mode",
                ));
            }
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
                    return Ok(open_result(&attached_handle, None));
                }
                if open.mode != requested_mode {
                    return Err(WireError::new(
                        ErrorCode::InvalidParams,
                        "workspace root is already open in a different mode",
                    ));
                }
                if open.capture_enabled != capture_enabled
                    || open.reconciles_collections != params.reconcile_collections
                    || open.projects_collections() != params.project_collections
                {
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
                // Something outside dohc can remove `.dohc/local`, or put an
                // unmarked folder in its place, while the binding is open, so
                // this open prepares it again before it changes anything.
                let local_root = root.clone();
                let local_state = tokio::task::spawn_blocking(move || {
                    root_binding::prepare_local_state(&local_root)
                })
                .await
                .map_err(|_| WireError::new(ErrorCode::Internal, "workspace open task failed"))?
                .map_err(map_root_binding)?;
                let local_state_ready = local_state.ready;
                *lock(&open.local_state) = Some(local_state);
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
                if params.abandon_ordinary_pull
                    && Self::read_under_ctx(
                        &cancellation,
                        "workspace.open (abandon ordinary pull)",
                        open.actor
                            .abandon_ordinary_pull(params.workspace_id.clone()),
                    )
                    .await?
                {
                    // The update the pull held back can run now.
                    self.collections_changed(ctx, &open).await;
                }
                return Ok(open_result(&handle, Some(local_state_ready)));
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
            lock(&open.local_state).take();
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
        let actor_path = root.join(".dohc").join("engine").join("engine.db");
        let supervisor = self.supervisor;
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
            let (root_token, local_state) = match requested_mode {
                WorkspaceOpenMode::Full | WorkspaceOpenMode::Passive => {
                    let token = root_binding::write_new_root_binding(&binding_root)
                        .map_err(map_root_binding)?;
                    let local_state = root_binding::prepare_local_state(&binding_root)
                        .map_err(map_root_binding)?;
                    (token, Some(local_state))
                }
                WorkspaceOpenMode::ReadOnly => (
                    root_binding::read_root_binding(&binding_root)
                        .map_err(map_root_binding)?
                        .ok_or_else(|| {
                            map_root_binding(root_binding::RootBindingError::DatabaseMismatch)
                        })?,
                    None,
                ),
            };
            let opened = match requested_mode {
                WorkspaceOpenMode::Full => {
                    supervisor.open_root_bound(&actor_path, now_ms, &root_token, store_work)
                }
                WorkspaceOpenMode::Passive => {
                    supervisor.open_passive_root_bound(&actor_path, now_ms, &root_token, store_work)
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
                observation: None,
                identity: opened
                    .as_ref()
                    .ok()
                    .and_then(|open| open.created_actor.then(|| open.actor.identity().clone())),
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
            if open_guard.identity.is_some()
                && let Some(probe) = capture_apply_probe
            {
                probe.pause_open_install_if_armed();
            }
            Ok((opened, open_guard, local_state))
        });
        let (actor_open, open_guard, local_state) = tokio::select! {
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
        let local_state_ready = local_state.as_ref().map(|local| local.ready);
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
        if let Some(reader) = self.reader_resolver.get() {
            actor
                .configure_reader_resolver(reader.clone())
                .await
                .map_err(map_runtime)?;
        }
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
                let held = actor.location();
                let removed = supervisor.begin_close_identity(actor.identity());
                drop(actor);
                let closed = match removed {
                    Ok(Some(closing)) => {
                        matches!(
                            tokio::task::spawn_blocking(move || closing.finish()).await,
                            Ok(Ok(()))
                        )
                    }
                    Ok(None) => true,
                    Err(_) => false,
                };
                open_guard.disarm();
                // A delete that fails, or a close that left the store open,
                // leaves the store the next open refuses as a mismatch. The
                // refusal stands; the path says why.
                if !closed {
                    eprintln!(
                        "engine: kept the orphaned store {}: it did not close",
                        held.database_path().display()
                    );
                    return Err(map_root_binding(error));
                }
                for suffix in ["", "-wal", "-shm"] {
                    let mut path = held.database_path().to_path_buf().into_os_string();
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
        // Versioned state belongs to one workspace. Refuse any other before
        // recovery or capture can write to the store.
        if Self::read_under_ctx(
            &cancellation,
            "workspace.open (workspace identity)",
            actor.holds_other_workspace(params.workspace_id.clone()),
        )
        .await?
        {
            return Err(bound_to_another_workspace());
        }
        // Before startup maintenance, capture or a Collections worker can
        // reconcile against what the pull left. Capture reconciles once it
        // starts; a workspace that keeps its Collections itself owes it.
        let abandoned_pull = params.abandon_ordinary_pull
            && Self::read_under_ctx(
                &cancellation,
                "workspace.open (abandon ordinary pull)",
                actor.abandon_ordinary_pull(params.workspace_id.clone()),
            )
            .await?;
        if requested_mode == WorkspaceOpenMode::Passive {
            Self::read_under_ctx(
                &cancellation,
                "workspace.open (passive main version)",
                actor.ensure_main_version(
                    params.workspace_id.clone(),
                    now_ms,
                    Arc::new(NoFaults),
                    cancellation.token.clone(),
                ),
            )
            .await?;
        }
        let open_guard = if requested_mode == WorkspaceOpenMode::Full
            && let Some(config) = self.ordinary_live_host.get()
        {
            let budget_store = actor.location();
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
                    let store = dohc_engine_storage::EngineStore::open_read_only(
                        budget_store.database_path(),
                    )
                    .map_err(|error| {
                        map_runtime(dohc_engine_runtime::RuntimeError::Storage(error))
                    })?;
                    let mismatch: bool = store.read_with(|conn| conn.query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {} a JOIN ydoc_docs d ON d.workspace_id=a.workspace_id AND d.version_id=a.main_version_id AND d.object_id=a.object_id AND d.lineage_claim_id=a.lineage_claim_id WHERE a.workspace_id=?1 AND (a.max_pending_bytes>?2 OR a.max_pending_age_ms>?3))",
                        dohc_engine_collab::live_update_application::owner_activations::CURRENT_ACTIVATIONS),
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
        let mut open_guard = open_guard;
        let observation = crate::file_observation::FileObservation::new(
            self.events.clone(),
            params.workspace_id.clone(),
        );
        open_guard.observation = Some(Arc::clone(&observation));
        let observation_root = root.clone();
        #[cfg(test)]
        let observation_root = self
            .capture_apply_probe
            .as_ref()
            .and_then(|probe| probe.observation_root.clone())
            .unwrap_or(observation_root);
        if requested_mode != WorkspaceOpenMode::Passive {
            observation.start(observation_root).map_err(|_| {
                WireError::new(
                    ErrorCode::WorkspaceUnavailable,
                    "file-observation-unavailable",
                )
            })?;
        }
        let capture = if requested_mode != WorkspaceOpenMode::Full {
            None
        } else {
            // Mandatory readiness barrier: derived mention rows must exist before
            // this workspace can expose a mention read.
            Self::read_under_ctx(
                &cancellation,
                "workspace.open (mention backfill)",
                actor.chat_mentions_backfill(
                    params.workspace_id.clone(),
                    cancellation.token.clone(),
                ),
            )
            .await?;
            actor
                .recover_open_document_artifacts(
                    params.workspace_id.clone(),
                    self.leases.scoped(&root),
                )
                .await
                .map_err(map_runtime)?;
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
                    observation: Arc::clone(&observation),
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
            if !params.project_collections {
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
        let automation_recovery =
            if requested_mode == WorkspaceOpenMode::Full && !params.project_collections {
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
        let collection_projection = if params.project_collections {
            Some(
                crate::collection_projection::CollectionProjectionWorker::spawn(
                    actor.clone(),
                    params.workspace_id.clone(),
                    self.events.clone(),
                ),
            )
        } else {
            None
        };
        let session_ops = Arc::new(tokio::sync::Mutex::new(()));
        lock(&self.handles).insert(
            handle.clone(),
            Arc::new(OpenWorkspace {
                root,
                workspace_id: params.workspace_id,
                actor,
                durability: super::automations::DurabilityQueue::default(),
                mode: requested_mode,
                handle_kind: WorkspaceHandleKind::Owner,
                relay: params
                    .relay
                    .map(|configuration| configuration.configuration()),
                capture_enabled: requested_mode == WorkspaceOpenMode::Full && capture_enabled,
                capture: Arc::new(Mutex::new(capture)),
                observation,
                reconciles_collections: params.reconcile_collections,
                projects_collections: params.project_collections,
                collection_projection: Arc::new(Mutex::new(collection_projection)),
                automation_recovery: Arc::new(Mutex::new(automation_recovery)),
                undo_recovery: Arc::new(Mutex::new(None)),
                markdown_recovery: Arc::new(Mutex::new(None)),
                capture_apply_gate,
                capture_holds: CaptureHolds::default(),
                session_ops,
                pending_pull: Default::default(),
                applying_pulls: Default::default(),
                pull_fetch_cancel: Default::default(),
                pull_repair_retries: Default::default(),
                cursors_issued: Default::default(),
                collections_owed: Default::default(),
                pulls_in_flight: Default::default(),
                unfinished_closes: Default::default(),
                local_state: Mutex::new(local_state),
            }),
        );
        if requested_mode == WorkspaceOpenMode::Full {
            let open = self.open(Some(&handle))?;
            *lock(&open.markdown_recovery) =
                Some(super::markdown_recovery::MarkdownRecovery::spawn(
                    &open,
                    handle.clone(),
                    self.sessions.clone(),
                    self.leases.scoped(&open.root),
                    self.self_writes.scoped(&open.root),
                    self.events.clone(),
                ));
            let recovery = open.clone();
            let fence = self.version_fence();
            let recovery_handle = handle.clone();
            *lock(&open.undo_recovery) = Some(tokio::spawn(async move {
                let outcome = async {
                    let pending = recovery
                        .actor
                        .pending_history_undos(recovery.workspace_id.clone())
                        .await
                        .map_err(map_runtime)?;
                    for (operation_id, request_id, author_json) in pending {
                        let cancellation = OperationCancellation::new(&RequestContext::unbounded());
                        if let Err(error) = fence
                            .fence_version_snapshot(
                                &cancellation,
                                recovery.clone(),
                                &recovery_handle,
                                "history.undo",
                                "Undo settlement",
                                super::versions::VersionFenceIntent::Undo {
                                    operation_id,
                                    request_id,
                                    author_json,
                                },
                            )
                            .await
                        {
                            eprintln!("engine: Undo recovery will retry on open: {error:?}");
                        }
                    }
                    Ok::<_, WireError>(())
                }
                .await;
                if let Err(error) = outcome {
                    eprintln!("engine: Undo recovery will retry on open: {error:?}");
                }
            }));
        }
        open_guard.disarm();
        if abandoned_pull
            && let Ok(opened) = self.open(Some(&handle))
            && self.reconciles_collections_itself(&opened)
        {
            self.collections_changed(ctx, &opened).await;
        }
        Ok(open_result(&handle, local_state_ready))
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
            let closing = supervisor
                .begin_close_identity(open.actor.identity())
                .map_err(map_runtime)?;
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
        removed.pull_fetch_cancel.cancel();
        let closed = closing.is_some();
        // A hold whose caller went away must not keep teardown waiting.
        lock(&removed.capture_holds).clear();
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
        #[cfg(feature = "harness")]
        let probe = self.capture_apply_probe.clone();
        let close_task = tokio::spawn(async move {
            let pending = removed.pending_pull.lock().await.take();
            let applying = std::mem::take(&mut *lock(&removed.applying_pulls));
            #[cfg(feature = "harness")]
            let gate_wait = probe
                .as_ref()
                .map(capture_driver::CaptureApplyProbe::observe_close_gate_wait);
            let _capture = capture_gate.lock_owned().await;
            #[cfg(feature = "harness")]
            drop(gate_wait);
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
            if let Some(pending) = pending {
                let _ = Self::release_fetched_pull(&removed, &pending.page).await;
            }
            // Restore newer pages' previous tokens before releasing older pages.
            for page in applying.into_iter().rev() {
                let _ = Self::release_fetched_pull(&removed, &page).await;
            }
            let finished = tokio::task::spawn_blocking(move || match closing {
                Some(closing) => closing.finish(),
                None => Ok(()),
            })
            .await;
            // The open ends with the close, whatever task still holds the workspace.
            lock(&removed.local_state).take();
            finished
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
impl EngineService {
    /// Occupy a workspace's actor until the returned sender drops, so a test
    /// can stop a request before its actor work runs. The held write rolls back.
    pub(crate) async fn hold_actor(
        &self,
        workspace: &WorkspaceHandle,
    ) -> std::sync::mpsc::Sender<()> {
        use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
        struct Hold {
            held: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
            release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl FaultInjector for Hold {
            fn poll(&self, point: FaultPoint) -> FaultAction {
                if point != FaultPoint::StorageBeforePersist {
                    return FaultAction::Continue;
                }
                if let Some(held) = lock(&self.held).take() {
                    let _ = held.send(());
                    let _ = lock(&self.release).recv();
                }
                FaultAction::Crash
            }
        }
        let (held, entered) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let hold = Arc::new(Hold {
            held: std::sync::Mutex::new(Some(held)),
            release: std::sync::Mutex::new(released),
        });
        let actor = self
            .open(Some(workspace))
            .expect("open workspace")
            .actor
            .clone();
        tokio::spawn(async move {
            let _ = actor
                .ensure_main_version(
                    "actor-hold".into(),
                    0,
                    hold,
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await;
        });
        entered.await.expect("the actor is held");
        release
    }
}

#[cfg(test)]
#[path = "history_undo_recovery_tests.rs"]
mod history_undo_recovery_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::relay::IssuedCursor;
    use crate::rpc::relay::PendingCursor;
    use dohc_engine_domain::WriteText;
    use dohc_engine_runtime::FaultPoint;
    use dohc_engine_testkit::GateFaults;
    use dohc_engine_testkit::ScratchDir;
    use std::time::Duration;

    #[tokio::test]
    async fn passive_store_refuses_read_only_attach() {
        let scratch = ScratchDir::new().unwrap();
        let service = EngineService::new();
        let params = json!({"rootDir":scratch.path(), "workspaceId":"passive", "captureMode":"none", "storeMode":"passive"});
        let opened = service
            .workspace_open(&RequestContext::unbounded(), params)
            .await
            .unwrap();
        let handle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let attach = service.workspace_open(&RequestContext::unbounded(), json!({"rootDir":scratch.path(), "workspaceId":"passive", "skipStartupMaintenance":true})).await;
        service.workspace_close(Some(handle)).await.unwrap();
        assert!(
            attach.is_err(),
            "a passive binding must not expose raw history through an attach"
        );
    }

    #[tokio::test]
    async fn passive_store_refuses_owner_reopen_after_restart() {
        let scratch = ScratchDir::new().unwrap();
        let passive = json!({"rootDir":scratch.path(), "workspaceId":"passive", "captureMode":"none", "storeMode":"passive"});
        for _ in 0..2 {
            let service = EngineService::new();
            let opened = service
                .workspace_open(&RequestContext::unbounded(), passive.clone())
                .await
                .unwrap();
            service
                .workspace_close(Some(
                    serde_json::from_value(opened["workspace"].clone()).unwrap(),
                ))
                .await
                .unwrap();
        }
        let service = EngineService::new();
        let mut owner = passive;
        owner.as_object_mut().unwrap().remove("storeMode");
        let reopened = service
            .workspace_open(&RequestContext::unbounded(), owner.clone())
            .await;
        assert!(
            reopened.is_err(),
            "a passive root must keep its durable role"
        );
        owner["skipStartupMaintenance"] = json!(true);
        assert!(
            service
                .workspace_open(&RequestContext::unbounded(), owner)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn passive_store_refuses_existing_owner_root() {
        let scratch = ScratchDir::new().unwrap();
        let params = json!({"rootDir":scratch.path(), "workspaceId":"owner", "captureMode":"none"});
        let service = EngineService::new();
        let opened = service
            .workspace_open(&RequestContext::unbounded(), params.clone())
            .await
            .unwrap();
        service
            .workspace_close(Some(
                serde_json::from_value(opened["workspace"].clone()).unwrap(),
            ))
            .await
            .unwrap();
        let service = EngineService::new();
        let mut passive = params;
        passive["storeMode"] = json!("passive");
        assert!(
            service
                .workspace_open(&RequestContext::unbounded(), passive)
                .await
                .is_err(),
            "an owner root cannot become a passive store"
        );
    }

    #[tokio::test]
    async fn passive_store_refuses_combinations_and_write_methods() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let service = EngineService::new();
        let params = json!({"rootDir":scratch.path(), "workspaceId":"passive", "captureMode":"none", "storeMode":"passive"});
        for (name, value) in [
            ("reconcileCollections", json!(true)),
            ("projectCollections", json!(true)),
            ("skipStartupMaintenance", json!(true)),
            ("recoverRunningDispatches", json!(true)),
            ("publication", json!(true)),
            ("automations", json!(true)),
        ] {
            let mut invalid = params.clone();
            invalid[name] = value;
            assert_eq!(
                service
                    .workspace_open(&RequestContext::unbounded(), invalid)
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidParams,
                "{name}"
            );
        }
        let mut capture = params.clone();
        capture.as_object_mut().unwrap().remove("captureMode");
        assert_eq!(
            service
                .workspace_open(&RequestContext::unbounded(), capture)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams
        );
        let opened = service
            .workspace_open(&RequestContext::unbounded(), params)
            .await
            .unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        for method in [
            "sync.claim",
            "sync.push",
            "sync.resetClaimRefusal",
            "sync.dismissRefusal",
            "sync.materializePendingCursor",
            "sync.shareLogPush",
            "sync.shareViewPull",
            "sync.submitShareProposal",
            "sync.pushDirectWrites",
            "versions.ensureMain",
            "versions.createNamed",
            "versions.setActive",
            "versionedText.write",
            "versionedText.writeBlob",
            "versionedText.rename",
            "versionedText.delete",
            "versionedText.rollback",
            "versionedText.merge",
            "versionedBinary.write",
            "versionedBinary.writeBlob",
            "capture.hold",
            "capture.release",
            "capture.reconcile",
            "capture.updateAuthor",
            "ydoc.open",
            "ydoc.recordUpdate",
            "ydoc.settle",
            "ydoc.project",
            "secrets.write",
            "secrets.materialize",
            "secrets.recorded",
            "secrets.list",
            "secrets.moments.get",
            "automations.subscribe",
            "automations.claimNext",
            "automations.settle",
            "collections.create",
            "collections.reconcile",
            "datasets.execute",
            "apps.publish",
            "chats.sendMessage",
            "chats.dispatch.claimNext",
            "liveApplication.provisionOwner",
        ] {
            assert_eq!(
                service
                    .ensure_handle_allows_method(Some(&handle), method)
                    .unwrap_err()
                    .code,
                ErrorCode::Forbidden,
                "{method}"
            );
        }
        for method in [
            "sync.adoptJoinIdentity",
            "sync.fetchPull",
            "sync.applyPull",
            "sync.commitCursor",
            "versionedText.read",
            "workspace.close",
        ] {
            service
                .ensure_handle_allows_method(Some(&handle), method)
                .unwrap();
        }
        service.workspace_close(Some(handle)).await.unwrap();
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

    #[tokio::test]
    async fn workspace_opens_degraded_when_observation_cannot_start() {
        let scratch = ScratchDir::new().unwrap();
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let mut service = EngineService::with_supervisor(supervisor);
        // Exercise real watcher startup and read_dir failures without host ACLs.
        let unreadable_root = scratch.path().join("not-a-directory");
        std::fs::write(&unreadable_root, "observation cannot walk this root").unwrap();
        service.capture_apply_probe = Some(
            capture_driver::CaptureApplyProbe::with_observation_root(unreadable_root),
        );
        let mut ctx = RequestContext::unbounded();
        let deadline = Duration::from_secs(60);
        ctx.deadline = Some(std::time::Instant::now() + deadline);
        let opened = tokio::time::timeout(
            deadline,
            service.workspace_open(
                &ctx,
                json!({"rootDir": scratch.path(), "workspaceId": "unavailable-observation"}),
            ),
        )
        .await
        .expect("observation must never stall workspace.open")
        .unwrap();
        let handle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let workspace = service.open(Some(&handle)).unwrap();
        let status = lock(&workspace.capture)
            .as_ref()
            .unwrap()
            .status()
            .snapshot();
        assert!(status.degraded && !status.running && !status.terminal);
        assert!(!workspace.observation.changes_since(None).ready);
        assert!(workspace.capture_apply_gate.try_lock().is_ok());
        service.workspace_close(Some(handle)).await.unwrap();
        assert_eq!(supervisor.actor_count(), 0);
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

    #[tokio::test]
    async fn workspace_open_budget_cancellation_keeps_cleanup_ownership_through_worker_completion()
    {
        for deadline in [false, true] {
            let scratch = ScratchDir::new().unwrap();
            let supervisor: &'static WorkspaceSupervisor =
                Box::leak(Box::new(WorkspaceSupervisor::new()));
            let config=serde_json::from_value(json!({
                "ingress":{"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":2,"uploadDeadlineMs":30_000},
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

    /// A workspace folder whose ACL passes read and search to everyone must
    /// not pass them to the engine's folder or the store in it. A
    /// folder an earlier build left open to others is made private on the
    /// next open, and its store still opens.
    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn opening_a_workspace_keeps_its_engine_folder_private() {
        use std::os::unix::fs::PermissionsExt;
        let acl_lines = |path: &std::path::Path| {
            let listing = std::process::Command::new("/bin/ls")
                .arg("-led")
                .arg(path)
                .output()
                .expect("ls");
            assert!(listing.status.success());
            String::from_utf8(listing.stdout)
                .expect("listing")
                .lines()
                .count()
                - 1
        };
        let add_entry = |path: &std::path::Path| {
            let added = std::process::Command::new("/bin/chmod")
                .args([
                    "+a",
                    "group:everyone allow read,execute,file_inherit,directory_inherit",
                ])
                .arg(path)
                .status()
                .expect("chmod");
            assert!(added.success());
        };
        let mode = |path: &std::path::Path| {
            std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o7777
        };
        let scratch = ScratchDir::new().expect("scratch");
        add_entry(scratch.path());
        let service = EngineService::new();
        let open = || async {
            let opened = service
                .workspace_open(
                    &RequestContext::unbounded(),
                    open_params(scratch.path(), "private", json!({ "captureMode": "none" })),
                )
                .await
                .expect("open");
            serde_json::from_value::<WorkspaceHandle>(opened["workspace"].clone()).expect("handle")
        };
        let handle = open().await;
        let engine = scratch.path().join(".dohc/engine");
        assert!(engine.join("engine.db").is_file());
        let mut created = vec![scratch.path().join(".dohc"), engine.clone()];
        created.extend(
            std::fs::read_dir(&engine)
                .expect("engine folder")
                .map(|entry| entry.expect("entry").path()),
        );
        for path in &created {
            assert_eq!(acl_lines(path), 0, "{}", path.display());
        }
        service.workspace_close(Some(handle)).await.expect("close");

        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        add_entry(&engine);
        let handle = open().await;
        assert_eq!(mode(&engine), 0o700);
        assert_eq!(acl_lines(&engine), 0);
        service.workspace_close(Some(handle)).await.expect("close");
    }

    /// A workspace whose engine folder or store file dohc can't keep private
    /// is refused with what is there and where, which the desktop names to
    /// the person. Linux names the folder too.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_open_names_what_keeps_the_engine_folder_from_being_private() {
        let service = &EngineService::new();
        let open = |root: &std::path::Path| {
            let params = open_params(root, "private", json!({ "captureMode": "none" }));
            async move {
                service
                    .workspace_open(&RequestContext::unbounded(), params)
                    .await
            }
        };
        let elsewhere = ScratchDir::new().expect("scratch");

        let linked = ScratchDir::new().expect("scratch");
        std::fs::create_dir(linked.path().join(".dohc")).expect("dohc");
        std::os::unix::fs::symlink(elsewhere.path(), linked.path().join(".dohc/engine"))
            .expect("link");
        let refused = open(linked.path())
            .await
            .expect_err("a linked engine folder");
        assert_eq!(refused.code, ErrorCode::Internal);
        assert_eq!(
            refused.message,
            "engine-folder-not-private: link .dohc/engine"
        );
        assert_eq!(
            std::fs::read_dir(elsewhere.path()).expect("target").count(),
            0
        );

        // Linux refuses a store file that is a link, but does not name it.
        #[cfg(target_os = "macos")]
        {
            let journal = ScratchDir::new().expect("scratch");
            let opened = open(journal.path()).await.expect("open");
            let handle = serde_json::from_value::<WorkspaceHandle>(opened["workspace"].clone());
            let handle = handle.expect("handle");
            service.workspace_close(Some(handle)).await.expect("close");
            let wal = journal.path().join(".dohc/engine/engine.db-wal");
            let _ = std::fs::remove_file(&wal);
            std::os::unix::fs::symlink(elsewhere.path().join("wal"), &wal).expect("link");
            let refused = open(journal.path()).await.expect_err("a linked journal");
            assert_eq!(refused.code, ErrorCode::Internal);
            assert_eq!(
                refused.message,
                "engine-folder-not-private: link .dohc/engine/engine.db-wal"
            );
        }
    }

    /// On Windows, an open names a junction at `.dohc` or at the engine's
    /// folder, and makes nothing in the folder it names.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_open_names_a_link_that_keeps_the_engine_folder_from_being_private() {
        let service = &EngineService::new();
        let open = |root: &std::path::Path| {
            let params = open_params(root, "private", json!({ "captureMode": "none" }));
            async move {
                service
                    .workspace_open(&RequestContext::unbounded(), params)
                    .await
            }
        };
        let elsewhere = ScratchDir::new().expect("scratch");
        let junction = |at: std::path::PathBuf| {
            let status = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(at)
                .arg(elsewhere.path())
                .stdout(std::process::Stdio::null())
                .status()
                .expect("mklink");
            assert!(status.success());
        };

        let linked = ScratchDir::new().expect("scratch");
        junction(linked.path().join(".dohc"));
        let refused = open(linked.path()).await.expect_err("a linked .dohc");
        assert_eq!(refused.code, ErrorCode::Internal);
        assert_eq!(refused.message, "engine-folder-not-private: link .dohc");

        let linked = ScratchDir::new().expect("scratch");
        std::fs::create_dir(linked.path().join(".dohc")).expect("dohc");
        junction(linked.path().join(".dohc").join("engine"));
        let refused = open(linked.path())
            .await
            .expect_err("a linked engine folder");
        assert_eq!(refused.code, ErrorCode::Internal);
        assert_eq!(
            refused.message,
            "engine-folder-not-private: link .dohc/engine"
        );
        assert_eq!(
            std::fs::read_dir(elsewhere.path()).expect("target").count(),
            0
        );
    }

    /// A link or a file where `.dohc/local` goes is refused as the engine's
    /// own folder is, and what it names is left as it was.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_open_refuses_a_link_or_a_file_where_this_computers_folder_goes() {
        use std::os::unix::fs::PermissionsExt;
        let service = &EngineService::new();
        let open = |root: &std::path::Path| {
            let params = open_params(root, "local", json!({ "captureMode": "none" }));
            async move {
                service
                    .workspace_open(&RequestContext::unbounded(), params)
                    .await
            }
        };
        let elsewhere = ScratchDir::new().expect("scratch");
        std::fs::set_permissions(elsewhere.path(), std::fs::Permissions::from_mode(0o755))
            .expect("mode");
        let linked = ScratchDir::new().expect("scratch");
        std::fs::create_dir(linked.path().join(".dohc")).expect("dohc");
        std::os::unix::fs::symlink(elsewhere.path(), linked.path().join(".dohc/local"))
            .expect("link");
        let refused = open(linked.path()).await.expect_err("a linked folder");
        assert_eq!(refused.code, ErrorCode::Internal);
        assert_eq!(
            refused.message,
            "engine-folder-not-private: link .dohc/local"
        );
        let mode = std::fs::metadata(elsewhere.path())
            .expect("target")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(
            std::fs::read_dir(elsewhere.path()).expect("target").count(),
            0
        );
        #[cfg(target_os = "macos")]
        {
            let marked = std::process::Command::new("xattr")
                .args(["-s", "-p", "com.apple.fileprovider.ignore#P"])
                .arg(elsewhere.path())
                .output()
                .expect("xattr");
            assert!(!marked.status.success());
        }

        let squatted = ScratchDir::new().expect("scratch");
        std::fs::create_dir(squatted.path().join(".dohc")).expect("dohc");
        std::fs::write(squatted.path().join(".dohc/local"), "mine").expect("file");
        let refused = open(squatted.path()).await.expect_err("a file");
        assert_eq!(refused.code, ErrorCode::Internal);
        assert_eq!(
            refused.message,
            "engine-folder-not-private: not-folder .dohc/local"
        );
        assert_eq!(
            std::fs::read_to_string(squatted.path().join(".dohc/local")).expect("file"),
            "mine"
        );
    }

    fn open_params(root: &std::path::Path, workspace_id: &str, options: Value) -> Value {
        let mut params = json!({
            "rootDir": root.to_string_lossy(),
            "workspaceId": workspace_id,
        });
        let options = options.as_object().cloned().unwrap_or_default();
        params.as_object_mut().expect("params").extend(options);
        params
    }

    /// A root with versioned state keeps its workspace across close and
    /// restart. Another id is refused before recovery or capture writes, and
    /// the owner reopens.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_closed_root_refuses_another_workspace_before_it_writes() {
        let scratch = ScratchDir::new().expect("scratch");
        let root = scratch.path();
        let db_path = root.join(".dohc/engine/engine.db");
        let none = json!({ "captureMode": "none" });
        let read_only = json!({ "captureMode": "none", "skipStartupMaintenance": true });
        let persisted = || {
            dohc_engine_storage::EngineStore::open_read_only(&db_path)
                .expect("store")
                .read_with(|conn| {
                    let mut select = conn.prepare(
                        "SELECT workspace_id FROM versioned_workspaces ORDER BY workspace_id",
                    )?;
                    let ids = select
                        .query_map([], |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    let moments: i64 =
                        conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0))?;
                    Ok::<_, rusqlite::Error>((ids, moments))
                })
                .expect("persisted workspace")
        };
        // An empty open with capture off leaves no versioned state, so a
        // later capture can still prove a fresh import.
        let first: &'static WorkspaceSupervisor = Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(first);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                open_params(root, "owner", none.clone()),
            )
            .await
            .expect("first open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("handle");
        service.workspace_close(Some(handle)).await.expect("close");
        assert_eq!(persisted(), (Vec::new(), 0));

        // Once the owner has versioned state, the store belongs to it.
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                open_params(root, "owner", none.clone()),
            )
            .await
            .expect("owner reopens");
        let workspace = opened["workspace"].clone();
        service
            .versions_ensure_main(
                &RequestContext::unbounded(),
                Some(serde_json::from_value(workspace.clone()).expect("handle")),
                json!({}),
            )
            .await
            .expect("main version");
        service
            .workspace_close(Some(serde_json::from_value(workspace).expect("handle")))
            .await
            .expect("close");
        let owner_only = persisted();
        assert_eq!(owner_only.0, vec!["owner".to_owned()]);
        let refused = service
            .workspace_open(
                &RequestContext::unbounded(),
                open_params(root, "other", none.clone()),
            )
            .await
            .expect_err("a closed root keeps its workspace");
        assert_eq!(refused.code, ErrorCode::InvalidParams);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                open_params(root, "owner", none.clone()),
            )
            .await
            .expect("the refusal does not strand the actor");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("handle");
        service.workspace_close(Some(handle)).await.expect("close");
        assert_eq!(first.actor_count(), 0);

        // After a restart, capture and read-only opens are refused before they write.
        std::fs::write(root.join("note.md"), "captured only by its owner").expect("note");
        let restarted: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(restarted);
        for options in [json!({}), read_only.clone()] {
            let refused = service
                .workspace_open(
                    &RequestContext::unbounded(),
                    open_params(root, "other", options),
                )
                .await
                .expect_err("a restarted service keeps the root's workspace");
            assert_eq!(refused.code, ErrorCode::InvalidParams);
            assert_eq!(persisted(), owner_only);
        }
        for options in [read_only, none] {
            let opened = service
                .workspace_open(
                    &RequestContext::unbounded(),
                    open_params(root, "owner", options),
                )
                .await
                .expect("the owner reopens");
            let handle: WorkspaceHandle =
                serde_json::from_value(opened["workspace"].clone()).expect("handle");
            service.workspace_close(Some(handle)).await.expect("close");
        }
        assert_eq!(persisted(), owner_only);
        assert_eq!(restarted.actor_count(), 0);
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
        #[cfg(windows)]
        {
            assert!(
                std::fs::rename(
                    scratch.path().join(".dohc/local"),
                    scratch.path().join(".dohc/local-renamed"),
                )
                .is_err()
            );
        }

        lock(&service.pending_cursors).insert(
            "evicted-token".to_owned(),
            PendingCursor {
                handle: handle.clone(),
                workspace_id: "evicted-cursor-cleanup".to_owned(),
                materialization_paths: Vec::new(),
                materialized: false,
                reconcile_collections: false,
                departed_after: None,
                issue: 1,
                cursor: IssuedCursor::Relay(dohc_engine_sync::RelayCursor {
                    bootstrap_complete: true,
                    cursor: 7,
                    replication_epoch: "epoch".to_owned(),
                    stream_identity: "stream".to_owned(),
                    settlement_report_id: None,
                    ordinary_pull: None,
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
        assert!(
            lock(&retained.local_state).is_none(),
            "eviction must release the dead binding's local state"
        );
        #[cfg(windows)]
        {
            assert!(
                std::fs::rename(
                    scratch.path().join(".dohc/local"),
                    scratch.path().join(".dohc/local-renamed"),
                )
                .is_err()
            );
        }
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
        #[cfg(windows)]
        {
            std::fs::rename(
                scratch.path().join(".dohc/local"),
                scratch.path().join(".dohc/local-renamed"),
            )
            .expect("eviction releases local while the dead binding is retained");
        }
        drop(retained);
    }
}
