use crate::live_application_ingress::{
    LiveApplicationIngress, LiveApplicationIngressConfig, SettlementAdmission,
};
use crate::{EngineService, LiveApplicationHostConfig, lock};
use dohc_engine_collab::HostedStoreIdentity;
use dohc_engine_collab::live_update_application::{ApplicationHostCoordinate, ApplicationOwner};
use dohc_engine_protocol::error::{ErrorCode, WireError};
use dohc_engine_protocol::limits::{MAX_WIRE_INTEGER, MIN_NEGOTIABLE_FRAME_BYTES, WireLimits};
use dohc_engine_protocol::transport::{ConnectionHandle, ConnectionOwner, RequestContext};
use dohc_engine_protocol::wire::{Envelope, Request, Response, WorkspaceHandle, encode_control};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// Operator configuration is bounded separately from runtime update admission.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfiguredLiveHostConfig {
    version: u32,
    relay_namespace: String,
    host: HostCoordinate,
    workspaces: Vec<WorkspaceConfig>,
    ingress: IngressConfig,
    settlement: Option<SettlementConfig>,
    restore: Option<crate::live_application_ingress::RestoreConfig>,
    sync: Option<super::live_application::sync::SyncConfig>,
    adoption: Option<ConfiguredOwnerAdoption>,
    recovery: Option<super::recovery_copies::RecoveryConfig>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConfiguredOwnerAdoption {
    pub max_bytes: usize,
    pub max_events: usize,
    pub owner_outbox: dohc_engine_collab::OwnerOutboxLimits,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettlementConfig {
    max_applications_per_settlement: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostCoordinate {
    host_id: String,
    host_epoch: i64,
    instance_id: String,
    connection_id: String,
}

impl HostCoordinate {
    fn coordinate(&self) -> ApplicationHostCoordinate {
        ApplicationHostCoordinate {
            host_id: self.host_id.clone(),
            host_epoch: self.host_epoch,
            instance_id: self.instance_id.clone(),
            connection_id: self.connection_id.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceConfig {
    root: PathBuf,
    workspace_id: String,
    max_registrations: usize,
    relay: Option<super::relay::RelayOpenParams>,
}

impl WorkspaceConfig {
    fn canonicalize(&mut self) -> Result<(), WireError> {
        if let Some(relay) = &self.relay {
            relay.validate_transport(false)?;
        }
        ApplicationOwner::new(self.workspace_id.clone())
            .map_err(|_| invalid("invalid live host workspace identity"))?;
        if !self.root.is_absolute() || self.max_registrations == 0 {
            return Err(invalid("invalid live host workspace configuration"));
        }
        self.root = std::fs::canonicalize(&self.root)
            .map_err(|_| invalid("live host workspace root unavailable"))?;
        if self.root.to_str().is_none() {
            return Err(invalid("live host workspace root must be UTF-8"));
        }
        if !self.root.is_dir() {
            return Err(invalid("live host workspace root unavailable"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IngressConfig {
    aggregate_bytes: usize,
    application_working_reserve_bytes: usize,
    max_uploads: usize,
    upload_deadline_ms: u64,
}

impl IngressConfig {
    pub(super) fn validate(&self) -> Result<LiveApplicationIngressConfig, WireError> {
        let upload_deadline = Duration::from_millis(self.upload_deadline_ms);
        if self.upload_deadline_ms > MAX_WIRE_INTEGER
            || Instant::now().checked_add(upload_deadline).is_none()
        {
            return Err(invalid("invalid live host upload deadline"));
        }
        Ok(LiveApplicationIngressConfig {
            aggregate_bytes: self.aggregate_bytes,
            application_working_reserve_bytes: self.application_working_reserve_bytes,
            max_uploads: self.max_uploads,
            upload_deadline,
        })
    }
}

fn invalid(message: &str) -> WireError {
    WireError::new(ErrorCode::InvalidParams, message)
}

impl ConfiguredLiveHostConfig {
    /// Read the complete operator configuration before starting any workspace.
    pub fn read(path: &Path) -> Result<Self, WireError> {
        if !path.is_absolute() {
            return Err(invalid("live host configuration path must be absolute"));
        }
        let file = std::fs::File::open(path).map_err(|error| {
            invalid(&format!(
                "live host configuration {}: {error}",
                path.display()
            ))
        })?;
        let mut bytes = Vec::new();
        file.take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                invalid(&format!(
                    "live host configuration {}: {error}",
                    path.display()
                ))
            })?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(invalid("live host configuration too large"));
        }
        serde_json::from_slice(&bytes).map_err(|error| {
            invalid(&format!(
                "live host configuration {}: {error}",
                path.display()
            ))
        })
    }

    fn canonicalize_and_validate(&mut self) -> Result<LiveApplicationIngressConfig, WireError> {
        // A host may start empty; the relay attaches workspaces as it enrolls them.
        if self.version != 1
            || self.relay_namespace.is_empty()
            || self.workspaces.len() > super::workspace::MAX_OPEN_HANDLES
        {
            return Err(invalid("invalid live host configuration"));
        }
        self.host
            .coordinate()
            .validate()
            .map_err(|_| invalid("invalid live host coordinate"))?;
        let mut roots = HashSet::new();
        let mut identities = HashSet::new();
        for workspace in &mut self.workspaces {
            workspace.canonicalize()?;
            if !roots.insert(workspace.root.clone())
                || !identities.insert(workspace.workspace_id.clone())
            {
                return Err(invalid(
                    "live host workspace roots and identities must be unique",
                ));
            }
        }
        let workspaces = self
            .workspaces
            .iter()
            .map(|workspace| sized_entry(&workspace.workspace_id))
            .collect();
        validate_discovery(
            &discovery_json(&self.relay_namespace, &self.host, workspaces),
            MAX_WIRE_INTEGER,
            MIN_NEGOTIABLE_FRAME_BYTES,
        )?;
        self.ingress.validate()
    }
}

pub(crate) struct Discovery {
    connection: ConnectionHandle,
    namespace: String,
    host: HostCoordinate,
    attached: Mutex<Vec<AttachedWorkspace>>,
    /// Serializes attach and detach. Other host methods do not wait on it.
    membership: tokio::sync::Mutex<()>,
    sync: Option<(
        dohc_engine_collab::live_update_application::AppliedSyncPolicy,
        SettlementAdmission,
    )>,
    settlement: Option<(usize, SettlementAdmission)>,
    restore: Option<crate::live_application_ingress::RestoreConfig>,
    adoption: Option<ConfiguredOwnerAdoption>,
    /// Earlier stores open for their owner's recovery copy, at most one per
    /// workspace. They stay out of `attached`, so a workspace's attached store
    /// and its earlier store are open at once. A close ends an entry once its
    /// preparation and page reads finished, even if its caller went away.
    recovery: Arc<Mutex<Vec<RecoveryStore>>>,
    /// Where earlier stores that need migrations are copied, when the host's
    /// operator configured it. Without it only a store this build fully
    /// migrated opens for recovery.
    copies: Option<Arc<super::recovery_copies::RecoveryCopies>>,
    /// One permit: preparations check and copy earlier stores one at a time,
    /// so together they never need more room or work than the largest.
    preparations: Arc<tokio::sync::Semaphore>,
}

/// One attached workspace, in attach order. An entry whose handle has no live
/// host is an attach that never finished; discovery omits it.
struct AttachedWorkspace {
    workspace_id: String,
    root: PathBuf,
    handle: WorkspaceHandle,
    ordinary: bool,
}

/// An earlier store of a workspace, open for recovery by its workspace
/// identity. It has no workspace actor. One worker prepares it: a store this
/// build fully migrated is read in place, and any other is copied and
/// migrated privately. Page reads then share the prepared store.
struct RecoveryStore {
    workspace_id: String,
    root: PathBuf,
    handle: WorkspaceHandle,
    identity: HostedStoreIdentity,
    /// The preparing worker and each page read hold it shared until they end,
    /// and a close takes it exclusively, so the entry, and the root it keeps
    /// from opening or attaching, outlasts all of them.
    reads: Arc<tokio::sync::RwLock<()>>,
    /// Set by a close, or once preparation runs out of time: the worker stops.
    cancel: Arc<Cancel>,
    prepared: Arc<Mutex<Preparation>>,
    /// Set once a close began. The handle then reads nothing.
    closing: bool,
}

/// Stops a preparation, waiting for its turn or running.
#[derive(Default)]
struct Cancel {
    /// Read by the store's statements.
    cancelled: Arc<AtomicBool>,
    woken: tokio::sync::Notify,
}

impl Cancel {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.woken.notify_waiters();
    }

    async fn cancelled(&self) {
        let woken = self.woken.notified();
        tokio::pin!(woken);
        woken.as_mut().enable();
        if !self.cancelled.load(Ordering::SeqCst) {
            woken.await;
        }
    }
}

/// How long a preparation may take on a host whose operator configured no
/// recovery copies: the longest a configured one may take.
const UNCONFIGURED_PREPARATION_DEADLINE: std::time::Duration =
    super::recovery_copies::MAX_PREPARATION_DEADLINE;

/// Where the preparation of a store open for recovery stands.
enum Preparation {
    Running,
    /// The store, and the copy folder it is in, if it is a copy.
    Ready {
        store: Arc<Mutex<dohc_engine_storage::PreparedRecovery>>,
        copy: Option<PathBuf>,
    },
    /// Every page read answers this refusal until the handle closes.
    Failed(WireError),
}

/// What a page read of a store open for recovery may do now.
pub(super) enum RecoveryPage {
    /// Its preparation still runs.
    Preparing,
    Read(RecoveryRead),
}

/// A page read of a prepared store. Its lease keeps the store open for
/// recovery until the read's worker drops it, after the store.
pub(super) struct RecoveryRead {
    pub(super) workspace_id: String,
    pub(super) identity: HostedStoreIdentity,
    pub(super) store: Arc<Mutex<dohc_engine_storage::PreparedRecovery>>,
    pub(super) _lease: tokio::sync::OwnedRwLockReadGuard<()>,
}

/// Preparations of a root wait here, in tests, until their gate opens. They
/// say when they start waiting for their turn and when they began.
#[cfg(test)]
struct PreparationGate {
    root: PathBuf,
    open: std::sync::mpsc::Receiver<()>,
    waiting: Option<tokio::sync::oneshot::Sender<()>>,
    began: Option<tokio::sync::oneshot::Sender<()>>,
}

#[cfg(test)]
static PREPARATION_GATES: Mutex<Vec<PreparationGate>> = Mutex::new(Vec::new());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryStoreParams {
    root: PathBuf,
    workspace_id: String,
    replication_epoch: String,
    stream_identity: String,
}

/// Whether one root is the other or contains it.
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

/// The handle of the workspace's recovery store when it is this store, open as
/// `identity` and not closing. Any other recovery store of the workspace is a
/// conflict.
fn open_recovery_handle(
    recovery: &[RecoveryStore],
    workspace_id: &str,
    root: &Path,
    identity: &HostedStoreIdentity,
) -> Result<Option<WorkspaceHandle>, WireError> {
    match recovery
        .iter()
        .find(|entry| entry.workspace_id == workspace_id)
    {
        Some(entry) if entry.root == root && &entry.identity == identity && !entry.closing => {
            Ok(Some(entry.handle.clone()))
        }
        Some(_) => Err(WireError::new(
            ErrorCode::Conflict,
            "a recovery store is already open for this workspace",
        )),
        None => Ok(None),
    }
}

/// Prepare the store at `root` for page reads as workspace `workspace_id`'s
/// store of `identity`. It is refused unless it is a store bound to `root`
/// that holds no versioned state of another workspace and holds `identity`
/// with a hosted replica, checked in the snapshot it is then read or copied
/// from. A store this build has not fully migrated is copied into a new
/// folder of `copies` and migrated there; the source is never changed. With
/// no `copies`, such a store is refused.
fn prepare_recovery(
    root: &Path,
    workspace_id: &str,
    identity: &HostedStoreIdentity,
    copies: Option<&super::recovery_copies::RecoveryCopies>,
    cancelled: &Arc<AtomicBool>,
) -> Preparation {
    use dohc_engine_storage::{RecoveryError, StorageError};
    use rusqlite::OptionalExtension;
    #[cfg(test)]
    {
        let gate = {
            let mut gates = lock(&PREPARATION_GATES);
            let found = gates.iter().position(|gate| gate.root == root);
            found.map(|index| gates.remove(index))
        };
        if let Some(mut gate) = gate {
            if let Some(began) = gate.began.take() {
                let _ = began.send(());
            }
            let _ = gate.open.recv();
        }
    }
    let (Ok(Some(token)), Ok(now_ms)) = (
        crate::root_binding::read_root_binding(root),
        super::request::now_ms(),
    ) else {
        return Preparation::Failed(invalid("recovery store unavailable"));
    };
    let mut copy = None;
    let prepared = dohc_engine_storage::open_for_recovery(
        &root.join(".dohc").join("engine").join("engine.db"),
        |conn| {
            let bound: Option<String> = conn
                .query_row(
                    "SELECT token FROM shadow_clone WHERE rowid_guard = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let other: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM versioned_workspaces WHERE workspace_id <> ?1)",
                rusqlite::params![workspace_id],
                |row| row.get(0),
            )?;
            Ok(bound.as_deref() == Some(token.as_str())
                && !other
                && identity.held_in(conn, workspace_id)?)
        },
        || {
            let folder = copies
                .ok_or_else(|| std::io::Error::other("recovery copies are not configured"))?
                .folder()?;
            copy = Some(folder.clone());
            Ok(folder)
        },
        &dohc_engine_storage::RealFreeSpace,
        cancelled,
        now_ms,
    );
    match prepared {
        Ok(store) => Preparation::Ready {
            store: Arc::new(Mutex::new(store)),
            copy,
        },
        Err(error) => {
            if let (Some(copy), Some(copies)) = (copy, copies) {
                copies.remove(copy);
            }
            Preparation::Failed(invalid(match error {
                RecoveryError::Refused => "recovery store belongs to another root or workspace",
                RecoveryError::Cancelled => "recovery-store-preparation-timed-out",
                RecoveryError::Storage(StorageError::MigratedByNewerBuild { .. }) => {
                    "recovery-store-needs-update"
                }
                RecoveryError::Storage(StorageError::DiskFull { .. }) => "recovery-store-disk-full",
                RecoveryError::Storage(StorageError::FileLocked) => "recovery-store-busy",
                _ => "recovery store unavailable",
            }))
        }
    }
}

/// The end of a store open for recovery whose close began: once its
/// preparation and page reads end, it closes, its copy goes, and its entry,
/// which kept its root reserved until then, goes last.
async fn end_recovery(
    recovery: Arc<Mutex<Vec<RecoveryStore>>>,
    copies: Option<Arc<super::recovery_copies::RecoveryCopies>>,
    (reads, prepared, handle): (
        Arc<tokio::sync::RwLock<()>>,
        Arc<Mutex<Preparation>>,
        WorkspaceHandle,
    ),
) {
    let _closed = reads.write_owned().await;
    let _ = tokio::task::spawn_blocking(move || close_prepared(&prepared, copies.as_deref())).await;
    lock(&recovery).retain(|entry| entry.handle != handle);
}

/// Close a prepared store, then remove its copy, if it has one.
fn close_prepared(
    prepared: &Mutex<Preparation>,
    copies: Option<&super::recovery_copies::RecoveryCopies>,
) {
    let ended = std::mem::replace(
        &mut *lock(prepared),
        Preparation::Failed(super::error::workspace_unavailable()),
    );
    if let Preparation::Ready { store, copy } = ended {
        drop(store);
        if let (Some(copy), Some(copies)) = (copy, copies) {
            copies.remove(copy);
        }
    }
}

impl Discovery {
    fn is_ordinary(&self, workspace: &WorkspaceHandle) -> bool {
        lock(&self.attached)
            .iter()
            .any(|entry| entry.ordinary && &entry.handle == workspace)
    }
}

impl EngineService {
    /// Provision a fresh daemon from operator-owned roots before accepting RPC.
    pub async fn configured_live_host(
        config: ConfiguredLiveHostConfig,
    ) -> Result<(Arc<Self>, ConnectionOwner, LiveApplicationIngress), WireError> {
        Self::new().configure_live_host(config).await
    }

    /// Provision operator-owned roots after configuring the service's reader.
    pub async fn configure_live_host(
        self,
        mut config: ConfiguredLiveHostConfig,
    ) -> Result<(Arc<Self>, ConnectionOwner, LiveApplicationIngress), WireError> {
        let ingress_config = config.canonicalize_and_validate()?;
        let service = Arc::new(self);
        let ingress = LiveApplicationIngress::new(service.clone(), ingress_config)?;
        if let Some(adoption) = &config.adoption {
            adoption
                .owner_outbox
                .validate()
                .map_err(super::error::map_owner_outbox)?;
            if adoption.owner_outbox.max_pending_bytes > MAX_WIRE_INTEGER as i64
                || adoption.owner_outbox.max_pending_age_ms > MAX_WIRE_INTEGER as i64
                || adoption.max_bytes == 0
                || adoption.max_events == 0
            {
                return Err(invalid("invalid configured owner adoption"));
            }
            ingress.validate_adoption_budget(adoption.max_bytes, adoption.max_events)?;
        }
        if let Some(config) = &config.restore {
            ingress.validate_restore_budget(config)?;
        }
        let sync = config
            .sync
            .map(|c| {
                ingress
                    .sync_admission(c)
                    .map(|admission| (c.policy, admission))
            })
            .transpose()?;
        let settlement = config
            .settlement
            .map(|config| {
                ingress
                    .settlement_admission(config.max_applications_per_settlement)
                    .map(|admission| (config.max_applications_per_settlement, admission))
            })
            .transpose()?;
        let copies = config
            .recovery
            .map(super::recovery_copies::RecoveryCopies::start)
            .transpose()?
            .map(Arc::new);
        let owner = ConnectionOwner::authenticated();
        let _ = service.configured_live_host.set(Discovery {
            connection: owner.handle(),
            namespace: config.relay_namespace,
            host: config.host,
            attached: Mutex::new(Vec::new()),
            membership: tokio::sync::Mutex::new(()),
            settlement,
            sync,
            restore: config.restore,
            adoption: config.adoption,
            recovery: Arc::new(Mutex::new(Vec::new())),
            copies,
            preparations: Arc::new(tokio::sync::Semaphore::new(1)),
        });
        let mut result = Ok(());
        for workspace in config.workspaces {
            if let Err(error) = service.attach_configured_workspace(workspace).await {
                result = Err(error);
                break;
            }
        }
        match result {
            Ok(()) => Ok((service, owner, ingress)),
            Err(error) => {
                owner.retire();
                let handles: Vec<_> = lock(&service.handles).keys().cloned().collect();
                for handle in handles {
                    let _ = service.workspace_close(Some(handle)).await;
                }
                Err(error)
            }
        }
    }

    /// The configured host, when its own connection is the caller.
    pub(super) fn configured_host_caller(
        &self,
        ctx: &RequestContext,
    ) -> Result<&Discovery, WireError> {
        let discovery = self
            .configured_live_host
            .get()
            .ok_or_else(|| WireError::new(ErrorCode::Forbidden, "live host is not configured"))?;
        if !discovery.connection.is_current()
            || !ctx
                .connection
                .as_ref()
                .is_some_and(|connection| discovery.connection.same_connection(connection))
        {
            return Err(WireError::new(
                ErrorCode::SessionExpired,
                "live host connection is not current",
            ));
        }
        Ok(discovery)
    }

    pub(super) async fn configured_attach_workspace(
        &self,
        ctx: &RequestContext,
        request: Request,
    ) -> Result<Value, WireError> {
        let discovery = self.configured_host_caller(ctx)?;
        if request.workspace.is_some() {
            return Err(invalid(
                "liveApplication.attachWorkspace takes no workspace",
            ));
        }
        let workspace: WorkspaceConfig = serde_json::from_value(request.params)
            .map_err(|_| invalid("invalid live host workspace configuration"))?;
        let _membership = discovery.membership.lock().await;
        self.configured_host_caller(ctx)?;
        self.attach_configured_workspace(workspace).await
    }

    /// `liveApplication.detachWorkspace`: close one attached workspace. Its
    /// registrations, sessions, and leases end with it; other workspaces keep
    /// theirs. Detach does not wait for pending delivery, settlement, or
    /// materialization. That work stays in the workspace store and resumes
    /// when the workspace is attached again.
    pub(super) async fn configured_detach_workspace(
        &self,
        ctx: &RequestContext,
        request: Request,
    ) -> Result<Value, WireError> {
        let discovery = self.configured_host_caller(ctx)?;
        if request
            .params
            .as_object()
            .is_none_or(|params| !params.is_empty())
        {
            return Err(invalid(
                "liveApplication.detachWorkspace requires empty params",
            ));
        }
        let handle = request
            .workspace
            .ok_or_else(super::error::workspace_unavailable)?;
        let _membership = discovery.membership.lock().await;
        self.configured_host_caller(ctx)?;
        if !lock(&discovery.attached)
            .iter()
            .any(|entry| entry.handle == handle)
        {
            return Err(super::error::workspace_unavailable());
        }
        // A detach dropped after close began leaves an entry without a host.
        // Discovery omits it and the next attach prunes it.
        self.workspace_close(Some(handle.clone())).await?;
        lock(&discovery.attached).retain(|entry| entry.handle != handle);
        Ok(json!({"detached": true}))
    }

    /// `liveApplication.openRecoveryStore`: open an earlier store of a
    /// workspace for reading, as the workspace identity the host created it
    /// for, so its owner can copy the edits the host kept there. Nothing
    /// captures, relays, applies or settles in it, and its handle answers
    /// only `ydoc.ownerOutbox.readPending`. The reply comes at once: a worker
    /// then waits for the daemon's one preparation at a time, checks the store
    /// and, if this build has not fully migrated it, copies and migrates it
    /// privately, all within the configured deadline. A host configured
    /// without recovery copies refuses a store that would need one.
    /// Until then each page read answers `preparing`, and after a refusal,
    /// the refusal. A workspace has at most one: opening its store again
    /// returns the same handle, whatever its preparation's state, and any
    /// other store of it is refused. So is a root that is attached or open
    /// for recovery, or that contains or sits inside one or the copies.
    pub(super) async fn configured_open_recovery_store(
        &self,
        ctx: &RequestContext,
        request: Request,
    ) -> Result<Value, WireError> {
        let discovery = self.configured_host_caller(ctx)?;
        if request.workspace.is_some() {
            return Err(invalid(
                "liveApplication.openRecoveryStore takes no workspace",
            ));
        }
        let params: RecoveryStoreParams = serde_json::from_value(request.params)
            .map_err(|_| invalid("invalid recovery store"))?;
        ApplicationOwner::new(params.workspace_id.clone())
            .map_err(|_| invalid("invalid recovery store workspace identity"))?;
        if !params.root.is_absolute()
            || params.replication_epoch.is_empty()
            || params.stream_identity.is_empty()
        {
            return Err(invalid("invalid recovery store"));
        }
        let root = std::fs::canonicalize(&params.root)
            .map_err(|_| invalid("recovery store unavailable"))?;
        if root.to_str().is_none() || !root.is_dir() {
            return Err(invalid("recovery store unavailable"));
        }
        let identity = HostedStoreIdentity {
            replication_epoch: params.replication_epoch,
            stream_identity: params.stream_identity,
        };
        let copies = discovery.copies.clone();
        // The same store again, as after an open whose reply was lost, keeps its handle.
        if let Some(handle) = open_recovery_handle(
            &lock(&discovery.recovery),
            &params.workspace_id,
            &root,
            &identity,
        )? {
            return Ok(json!({"workspaceHandle": handle}));
        }
        let _membership = discovery.membership.lock().await;
        self.configured_host_caller(ctx)?;
        let (handle, lease, cancel, prepared) = {
            let mut recovery = lock(&discovery.recovery);
            if let Some(handle) =
                open_recovery_handle(&recovery, &params.workspace_id, &root, &identity)?
            {
                return Ok(json!({"workspaceHandle": handle}));
            }
            if copies.as_ref().is_some_and(|copies| copies.overlaps(&root))
                || recovery.iter().any(|entry| overlaps(&entry.root, &root))
                || lock(&self.handles)
                    .values()
                    .any(|open| overlaps(&open.root, &root))
            {
                return Err(invalid("recovery store root is already open"));
            }
            if recovery.len() >= super::workspace::MAX_OPEN_HANDLES {
                return Err(WireError::new(
                    ErrorCode::Overloaded,
                    "recovery store limit reached",
                ));
            }
            let sequence = self.next_handle.fetch_add(1, Ordering::Relaxed);
            let handle = WorkspaceHandle(format!("ws-{sequence:016x}"));
            let reads = Arc::<tokio::sync::RwLock<()>>::default();
            let lease = reads
                .clone()
                .try_read_owned()
                .map_err(|_| WireError::new(ErrorCode::Internal, "recovery store lease"))?;
            let (cancel, prepared) = (
                Arc::<Cancel>::default(),
                Arc::new(Mutex::new(Preparation::Running)),
            );
            recovery.push(RecoveryStore {
                workspace_id: params.workspace_id.clone(),
                root: root.clone(),
                handle: handle.clone(),
                identity: identity.clone(),
                reads,
                cancel: cancel.clone(),
                prepared: prepared.clone(),
                closing: false,
            });
            (handle, lease, cancel, prepared)
        };
        // The worker owns the source's lease until it recorded its outcome,
        // so a close waits for it, and the root stays reserved meanwhile.
        // Membership operations do not wait on it. Its deadline covers its
        // wait for the daemon's preparation permit, so every preparation ends
        // within the deadline of its open.
        let deadline = tokio::spawn({
            let cancel = cancel.clone();
            let wait = copies
                .as_ref()
                .map_or(UNCONFIGURED_PREPARATION_DEADLINE, |copies| copies.deadline);
            async move {
                tokio::time::sleep(wait).await;
                cancel.cancel();
            }
        });
        let preparations = discovery.preparations.clone();
        tokio::spawn(async move {
            #[cfg(test)]
            if let Some(waiting) = lock(&PREPARATION_GATES)
                .iter_mut()
                .find(|gate| gate.root == root)
                .and_then(|gate| gate.waiting.take())
            {
                let _ = waiting.send(());
            }
            let permit = tokio::select! {
                biased;
                () = cancel.cancelled() => None,
                permit = preparations.acquire_owned() => permit.ok(),
            };
            let outcome = match permit {
                Some(permit) => tokio::task::spawn_blocking(move || {
                    let outcome = prepare_recovery(
                        &root,
                        &params.workspace_id,
                        &identity,
                        copies.as_deref(),
                        &cancel.cancelled,
                    );
                    drop(permit);
                    outcome
                })
                .await
                .unwrap_or_else(|_| Preparation::Failed(invalid("recovery store unavailable"))),
                None => Preparation::Failed(invalid("recovery-store-preparation-timed-out")),
            };
            deadline.abort();
            *lock(&prepared) = outcome;
            drop(lease);
        });
        Ok(json!({"workspaceHandle": handle}))
    }

    /// `liveApplication.closeRecoveryStore`: end a recovery handle. It reads
    /// nothing from then on, a preparation still running stops, and its root
    /// stays unavailable to open or attach until that preparation and every
    /// page read through it finished. The store then closes and its copy goes.
    /// The reply waits for all of it, so its caller may then remove the store.
    /// A close whose caller goes away still ends the handle.
    pub(super) async fn configured_close_recovery_store(
        &self,
        ctx: &RequestContext,
        request: Request,
    ) -> Result<Value, WireError> {
        let discovery = self.configured_host_caller(ctx)?;
        if request
            .params
            .as_object()
            .is_none_or(|params| !params.is_empty())
        {
            return Err(invalid(
                "liveApplication.closeRecoveryStore requires empty params",
            ));
        }
        let handle = request
            .workspace
            .ok_or_else(super::error::workspace_unavailable)?;
        let ending = {
            let mut recovery = lock(&discovery.recovery);
            let entry = recovery
                .iter_mut()
                .find(|entry| entry.handle == handle)
                .ok_or_else(super::error::workspace_unavailable)?;
            entry.closing = true;
            entry.cancel.cancel();
            (entry.reads.clone(), entry.prepared.clone(), handle)
        };
        let (recovery, copies) = (discovery.recovery.clone(), discovery.copies.clone());
        tokio::spawn(end_recovery(recovery, copies, ending))
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "recovery store close failed"))?;
        Ok(json!({"closed": true}))
    }

    /// Close every store open for recovery, as the daemon stops, then remove
    /// this daemon's copy folder.
    pub async fn close_recovery_stores(&self) {
        let Some(discovery) = self.configured_live_host.get() else {
            return;
        };
        let ending: Vec<_> = lock(&discovery.recovery)
            .iter_mut()
            .map(|entry| {
                entry.closing = true;
                entry.cancel.cancel();
                (
                    entry.reads.clone(),
                    entry.prepared.clone(),
                    entry.handle.clone(),
                )
            })
            .collect();
        for ending in ending {
            end_recovery(discovery.recovery.clone(), discovery.copies.clone(), ending).await;
        }
        if let Some(copies) = discovery.copies.clone() {
            let _ = tokio::task::spawn_blocking(move || copies.shutdown()).await;
        }
    }

    /// Whether `handle` is a recovery store's, closing or not.
    pub(super) fn is_recovery_handle(&self, handle: Option<&WorkspaceHandle>) -> bool {
        let (Some(handle), Some(discovery)) = (handle, self.configured_live_host.get()) else {
            return false;
        };
        lock(&discovery.recovery)
            .iter()
            .any(|entry| &entry.handle == handle)
    }

    /// A page read of the earlier store open for recovery under `handle`, if
    /// it is one: with its lease once it is prepared, or its refusal. A
    /// closing handle reads nothing.
    pub(super) fn recovery_read(
        &self,
        handle: Option<&WorkspaceHandle>,
    ) -> Option<Result<RecoveryPage, WireError>> {
        let handle = handle?;
        let recovery = lock(&self.configured_live_host.get()?.recovery);
        let entry = recovery.iter().find(|entry| &entry.handle == handle)?;
        // A close sets `closing` under this lock before it waits for the
        // leases, so no read starts after it.
        if entry.closing {
            return Some(Err(super::error::workspace_unavailable()));
        }
        let store = match &*lock(&entry.prepared) {
            Preparation::Running => return Some(Ok(RecoveryPage::Preparing)),
            Preparation::Failed(refusal) => return Some(Err(refusal.clone())),
            Preparation::Ready { store, .. } => store.clone(),
        };
        Some(
            entry
                .reads
                .clone()
                .try_read_owned()
                .map(|lease| {
                    RecoveryPage::Read(RecoveryRead {
                        workspace_id: entry.workspace_id.clone(),
                        identity: entry.identity.clone(),
                        store,
                        _lease: lease,
                    })
                })
                .map_err(|_| super::error::workspace_unavailable()),
        )
    }

    /// Open, provision, and list one workspace. Callers serialize membership.
    async fn attach_configured_workspace(
        &self,
        mut workspace: WorkspaceConfig,
    ) -> Result<Value, WireError> {
        let discovery = self
            .configured_live_host
            .get()
            .ok_or_else(|| WireError::new(ErrorCode::Forbidden, "live host is not configured"))?;
        workspace.canonicalize()?;
        if discovery
            .copies
            .as_ref()
            .is_some_and(|copies| copies.overlaps(&workspace.root))
            || lock(&discovery.recovery)
                .iter()
                .any(|entry| overlaps(&entry.root, &workspace.root))
        {
            return Err(invalid("live host workspace root is open for recovery"));
        }
        let unfinished = {
            let mut attached = lock(&discovery.attached);
            {
                let handles = lock(&self.handles);
                attached.retain(|entry| handles.contains_key(&entry.handle));
            }
            let registry = lock(&self.live_applications);
            let mut unfinished = Vec::new();
            let mut listed = Vec::new();
            for entry in attached.iter() {
                if entry.root == workspace.root || entry.workspace_id == workspace.workspace_id {
                    if registry.has_host(&entry.handle) {
                        return Err(invalid(
                            "live host workspace roots and identities must be unique",
                        ));
                    }
                    unfinished.push(entry.handle.clone());
                } else if entry.root.starts_with(&workspace.root)
                    || workspace.root.starts_with(&entry.root)
                {
                    // Capture and the engine store would cover another workspace's files.
                    return Err(invalid(
                        "live host workspace roots must not contain one another",
                    ));
                } else {
                    listed.push(sized_entry(&entry.workspace_id));
                }
            }
            listed.push(sized_entry(&workspace.workspace_id));
            // The smallest supported negotiated frame must hold readiness.
            validate_discovery(
                &discovery_json(&discovery.namespace, &discovery.host, listed),
                MAX_WIRE_INTEGER,
                MIN_NEGOTIABLE_FRAME_BYTES,
            )?;
            unfinished
        };
        // An attach dropped before provisioning left its workspace open.
        for handle in unfinished {
            self.workspace_close(Some(handle.clone())).await?;
            lock(&discovery.attached).retain(|entry| entry.handle != handle);
        }
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(discovery.connection.clone());
        let opened = self
            .workspace_open(
                &ctx,
                json!({
                    "rootDir": workspace.root, "workspaceId": workspace.workspace_id,
                    "captureMode": "none", "relay": workspace.relay
                }),
            )
            .await?;
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).map_err(|_| {
                WireError::new(ErrorCode::Internal, "workspace open returned no handle")
            })?;
        lock(&discovery.attached).push(AttachedWorkspace {
            workspace_id: workspace.workspace_id.clone(),
            root: workspace.root.clone(),
            handle: handle.clone(),
            ordinary: workspace.relay.is_some(),
        });
        if let Err(error) = self
            .provision_configured_workspace(discovery, &ctx, &workspace, &handle)
            .await
        {
            if self.workspace_close(Some(handle.clone())).await.is_ok() {
                lock(&discovery.attached).retain(|entry| entry.handle != handle);
            }
            return Err(error);
        }
        Ok(json!({"workspaceId": workspace.workspace_id, "workspaceHandle": handle}))
    }

    async fn provision_configured_workspace(
        &self,
        discovery: &Discovery,
        ctx: &RequestContext,
        workspace: &WorkspaceConfig,
        handle: &WorkspaceHandle,
    ) -> Result<(), WireError> {
        if workspace.relay.is_some() {
            self.versions_ensure_main(
                ctx,
                Some(handle.clone()),
                json!({"workspaceId": workspace.workspace_id}),
            )
            .await?;
        }
        if let Some(adoption) = &discovery.adoption {
            let opened = self.open(Some(handle))?;
            let held = opened.actor.location();
            let workspace_id = workspace.workspace_id.clone();
            let limits = adoption.owner_outbox.clone();
            let mismatch = tokio::task::spawn_blocking(move || {
                let store = dohc_engine_storage::EngineStore::open_read_only(held.database_path()).map_err(|_|invalid("owner adoption budget read failed"))?;
                store.read_with(|conn| dohc_engine_collab::live_update_application::owner_activations::retained_limits_exceed(
                    conn,&workspace_id,limits.max_pending_bytes,limits.max_pending_age_ms))
                    .map_err(|_|invalid("owner adoption budget read failed"))
            }).await.map_err(|_|invalid("owner adoption budget read interrupted"))??;
            if mismatch {
                return Err(invalid(
                    "configured owner outbox budget is smaller than retained adoption",
                ));
            }
        }
        self.provision_live_application(
            discovery.connection.clone(),
            LiveApplicationHostConfig {
                workspace: handle.clone(),
                namespace: discovery.namespace.clone(),
                coordinate: discovery.host.coordinate(),
                max_registrations: workspace.max_registrations,
            },
        )
        .await
    }

    /// Discovery lists attached workspaces whose live host is installed.
    fn configured_discovery(&self, discovery: &Discovery) -> Value {
        let attached = lock(&discovery.attached);
        let registry = lock(&self.live_applications);
        let workspaces = attached
            .iter()
            .filter(|entry| registry.has_host(&entry.handle))
            .map(
                |entry| json!({"workspaceId": entry.workspace_id, "workspaceHandle": entry.handle}),
            )
            .collect();
        discovery_json(&discovery.namespace, &discovery.host, workspaces)
    }

    /// The relay namespace the configured host serves, if one is configured.
    /// With one, only its own connection reaches the ordinary methods.
    pub(super) fn configured_relay_namespace(&self) -> Option<String> {
        self.configured_live_host
            .get()
            .map(|host| host.namespace.clone())
    }

    pub(super) fn configured_ordinary_namespace(
        &self,
        ctx: &RequestContext,
        request: &Request,
    ) -> Result<String, WireError> {
        if !self.configured_ordinary_request(ctx, request) {
            return Err(invalid("ordinary service connection unavailable"));
        }
        self.configured_relay_namespace()
            .ok_or_else(|| invalid("ordinary service namespace unavailable"))
    }

    pub(crate) fn owner_adoption_config(
        &self,
        connection: &ConnectionHandle,
        workspace: Option<&WorkspaceHandle>,
    ) -> Result<ConfiguredOwnerAdoption, WireError> {
        if let Some(host) = self.ordinary_live_host.get() {
            if !host.connection.same_connection(connection) || !connection.is_current() {
                return Err(invalid("owner adoption connection retired"));
            }
            return Ok(ConfiguredOwnerAdoption {
                max_bytes: host.max_adoption_bytes,
                max_events: host.max_adoption_events,
                owner_outbox: host.owner_outbox.clone(),
            });
        }
        let host = self
            .configured_live_host
            .get()
            .ok_or_else(|| invalid("owner adoption not configured"))?;
        if !host.connection.same_connection(connection)
            || !connection.is_current()
            || !workspace.is_some_and(|workspace| host.is_ordinary(workspace))
        {
            return Err(invalid("owner adoption connection retired"));
        }
        host.adoption
            .clone()
            .ok_or_else(|| invalid("owner adoption not configured"))
    }

    pub(super) fn configured_ordinary_request(
        &self,
        ctx: &RequestContext,
        request: &Request,
    ) -> bool {
        self.configured_live_host.get().is_some_and(|host| {
            host.connection.is_current()
                && lock(&self.live_applications).hosts_current(&host.connection)
                && ctx
                    .connection
                    .as_ref()
                    .is_some_and(|connection| host.connection.same_connection(connection))
                && request
                    .workspace
                    .as_ref()
                    .is_some_and(|handle| host.is_ordinary(handle))
        })
    }

    /// The configured host's own current connection is the caller, and
    /// `workspace` is one of the ordinary workspaces it attached. A handler
    /// checks this again after each wait, since either can end meanwhile.
    pub(super) fn configured_ordinary_workspace(
        &self,
        ctx: &RequestContext,
        workspace: &WorkspaceHandle,
    ) -> Result<(), WireError> {
        let discovery = self.configured_host_caller(ctx)?;
        if !lock(&self.live_applications).hosts_current(&discovery.connection) {
            return Err(WireError::new(
                ErrorCode::SessionExpired,
                "live host connection is not current",
            ));
        }
        if !discovery.is_ordinary(workspace) {
            return Err(super::error::workspace_unavailable());
        }
        Ok(())
    }

    pub(super) fn configured_live_hosts(
        &self,
        ctx: &RequestContext,
        request: &Request,
    ) -> Result<Value, WireError> {
        if request.workspace.is_some()
            || request
                .params
                .as_object()
                .is_none_or(|params| !params.is_empty())
        {
            return Err(invalid(
                "liveApplication.hosts requires empty params and no workspace",
            ));
        }
        let discovery = self
            .configured_live_host
            .get()
            .ok_or_else(|| WireError::new(ErrorCode::Forbidden, "live host is not configured"))?;
        if !discovery.connection.is_current()
            || !lock(&self.live_applications).hosts_current(&discovery.connection)
            || !ctx
                .connection
                .as_ref()
                .is_some_and(|connection| discovery.connection.same_connection(connection))
        {
            return Err(WireError::new(
                ErrorCode::SessionExpired,
                "live host connection is not current",
            ));
        }
        let result = self.configured_discovery(discovery);
        validate_discovery(&result, request.id, ctx.max_frame_bytes)?;
        Ok(result)
    }

    /// The namespace and budgets one retirement step runs under, from the
    /// host's own configuration. A page holds what one settlement may cover.
    pub(super) fn configured_retirement_scope(
        &self,
        ctx: &RequestContext,
        max_applications: usize,
    ) -> Result<dohc_engine_runtime::actor::OwnedRetirementScope, WireError> {
        let discovery = self.configured_host_caller(ctx)?;
        let (max, _) = discovery.settlement.as_ref().ok_or_else(|| {
            WireError::new(ErrorCode::Forbidden, "live settlement is not configured")
        })?;
        if !(1..=*max).contains(&max_applications) {
            return Err(invalid("invalid-live-reconciliation"));
        }
        Ok(dohc_engine_runtime::actor::OwnedRetirementScope {
            namespace: discovery.namespace.clone(),
            max_deliveries: *max,
            max_applications,
        })
    }

    pub(super) fn configured_settlement_admission(
        &self,
        ctx: &RequestContext,
    ) -> Result<
        (
            usize,
            dohc_engine_collab::live_update_application::AdmittedNativeHistoryReconstruction,
        ),
        WireError,
    > {
        if let Some(host) = self.ordinary_live_host.get() {
            if !host.connection.is_current()
                || !ctx
                    .connection
                    .as_ref()
                    .is_some_and(|connection| host.connection.same_connection(connection))
            {
                return Err(WireError::new(
                    ErrorCode::SessionExpired,
                    "ordinary live host connection is not current",
                ));
            }
            return Ok((
                host.settlement.0,
                host.settlement.1.reserve_reconstruction()?,
            ));
        }
        let discovery = self
            .configured_live_host
            .get()
            .ok_or_else(|| WireError::new(ErrorCode::Forbidden, "live host is not configured"))?;
        if !discovery.connection.is_current()
            || !lock(&self.live_applications).hosts_current(&discovery.connection)
            || !ctx
                .connection
                .as_ref()
                .is_some_and(|connection| discovery.connection.same_connection(connection))
        {
            return Err(WireError::new(
                ErrorCode::SessionExpired,
                "live host connection is not current",
            ));
        }
        let (max, admission) = discovery.settlement.as_ref().ok_or_else(|| {
            WireError::new(ErrorCode::Forbidden, "live settlement is not configured")
        })?;
        Ok((*max, admission.reserve_reconstruction()?))
    }

    pub(super) fn relay_sync_admission(
        &self,
    ) -> Option<(
        dohc_engine_collab::live_update_application::AppliedSyncPolicy,
        SettlementAdmission,
    )> {
        self.ordinary_live_host
            .get()
            .and_then(|host| host.sync.as_ref())
            .or_else(|| {
                self.configured_live_host
                    .get()
                    .and_then(|host| host.sync.as_ref())
            })
            .cloned()
    }

    pub(crate) fn sync_admission(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<
        (
            dohc_engine_collab::live_update_application::AppliedSyncPolicy,
            SettlementAdmission,
        ),
        WireError,
    > {
        let owner = if let Some(host) = self.ordinary_live_host.get() {
            &host.connection
        } else if let Some(host) = self.configured_live_host.get() {
            &host.connection
        } else {
            return Err(invalid("applied sync is not provisioned"));
        };
        if !owner.same_connection(connection) || !owner.is_current() {
            return Err(invalid("applied sync connection retired"));
        }
        self.relay_sync_admission()
            .ok_or_else(|| invalid("applied sync is not provisioned"))
    }

    pub(crate) fn restore_config(
        &self,
        connection: &ConnectionHandle,
    ) -> Result<crate::live_application_ingress::RestoreConfig, WireError> {
        let (expected, config) = if let Some(host) = self.ordinary_live_host.get() {
            (&host.connection, &host.restore)
        } else {
            let host = self
                .configured_live_host
                .get()
                .ok_or_else(|| invalid("restore host not configured"))?;
            (&host.connection, &host.restore)
        };
        if !expected.is_current() || !expected.same_connection(connection) {
            return Err(invalid("restore connection retired"));
        }
        config
            .clone()
            .ok_or_else(|| invalid("restore not configured"))
    }
}

fn discovery_json(namespace: &str, host: &HostCoordinate, workspaces: Vec<Value>) -> Value {
    json!({"relayNamespace": namespace, "host": host, "workspaces": workspaces})
}

/// A discovery entry with the widest handle, for sizing before a workspace opens.
fn sized_entry(workspace_id: &str) -> Value {
    json!({"workspaceId": workspace_id, "workspaceHandle": "ws-ffffffffffffffff"})
}

fn validate_discovery(result: &Value, id: u64, max_frame_bytes: u32) -> Result<(), WireError> {
    encode_control(
        &Envelope::Response(Response {
            id,
            result: result.clone(),
        }),
        &WireLimits {
            max_frame_bytes,
            ..WireLimits::default()
        },
    )
    .map_err(|_| {
        WireError::new(
            ErrorCode::LimitExceeded,
            "live host discovery exceeds wire limits",
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(roots: &[(&Path, &str)]) -> ConfiguredLiveHostConfig {
        serde_json::from_value(json!({
            "version":1,"relayNamespace":"relay", "host":{"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces": roots.iter().map(|(root,id)| json!({"root":root,"workspaceId":id,"maxRegistrations":4})).collect::<Vec<_>>(),
            "ingress":{"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":8*1024*1024,"maxUploads":2,"uploadDeadlineMs":30_000}
        })).unwrap()
    }

    #[test]
    fn configured_host_refuses_socket_transport_and_requires_base_url() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        for relay in [
            json!({"socketPath":"/private/relay.sock","bearerToken":"lease"}),
            json!({"baseUrl":"https://relay.test","socketPath":"/private/relay.sock","bearerToken":"lease"}),
            json!({"bearerToken":"owner"}),
        ] {
            let mut configured = config(&[(root.path(), "workspace")]);
            configured.workspaces[0].relay = Some(serde_json::from_value(relay).unwrap());
            assert!(configured.canonicalize_and_validate().is_err());
        }
    }

    async fn close(service: &EngineService) {
        let handles: Vec<_> = lock(&service.handles).keys().cloned().collect();
        for handle in handles {
            service.workspace_close(Some(handle)).await.unwrap();
        }
    }

    fn handle(service: &EngineService, index: usize) -> WorkspaceHandle {
        let discovery = service.configured_live_host.get().unwrap();
        serde_json::from_value(
            service.configured_discovery(discovery)["workspaces"][index]["workspaceHandle"].clone(),
        )
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn configured_host_reader_settles_an_imported_note_opened_at_startup() {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        use dohc_engine_collab::{ContentKind, DocKey, Ydoc};
        use dohc_engine_domain::{VersionedTextStore, WriteText};
        use dohc_engine_storage::{EngineStore, NoFaults, StorageError, hex_sha256};
        use dohc_engine_testkit::{ScratchDir, engine_db_path};
        use yrs::{Map, ReadTxn, Transact, updates::decoder::Decode};

        let scratch = ScratchDir::new().unwrap();
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        crate::root_binding::write_root_binding(scratch.path(), token).unwrap();
        let source = "Imported note\n";
        let imported = Ydoc::wire();
        imported
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, source)
            .unwrap();
        let wire = yrs::Doc::new();
        wire.transact_mut()
            .apply_update(yrs::Update::decode_v1(&imported.encode_full_state()).unwrap())
            .unwrap();
        wire.get_or_insert_map("meta")
            .remove(&mut wire.transact_mut(), "dohcLineageEpoch");
        wire.get_or_insert_map("meta").insert(
            &mut wire.transact_mut(),
            "dohcMarkdownSourceReader",
            1,
        );
        let key = DocKey::new("w", "main", "note").unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let mut store = EngineStore::open(&db, 1).unwrap();
        store.bind_root_token(token, &NoFaults).unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute_batch(
                    "INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                     VALUES('w','origin','epoch','stream',1);\
                     INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) \
                     VALUES('w','origin',0);",
                )
                .map_err(StorageError::persist_public)
            })
            .unwrap();
        VersionedTextStore::new(&mut store)
            .ensure_main_version("w", "main", 1, &NoFaults)
            .unwrap();
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "w".into(),
                    version_id: "main".into(),
                    object_id: "note".into(),
                    path: "note.md".into(),
                    text: source.into(),
                    moment_id: "source".into(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &wire
                .transact()
                .encode_state_as_update_v1(&yrs::StateVector::default()),
            &NoFaults,
            3,
        )
        .unwrap();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET path='note.md'", [])
                    .map_err(StorageError::persist_public)
            })
            .unwrap();
        let doc = dohc_engine_collab::load_persisted(&store, &key)
            .unwrap()
            .unwrap()
            .doc;
        assert!(doc.has_reader_source());
        let original_projection = doc.markdown_source_reference().unwrap().projection_sha256;
        let update = doc.richdoc_append_paragraph("Safe edit after configured startup");
        let expected = doc.project(ContentKind::Richdoc).unwrap().content;
        drop(store);
        std::fs::write(scratch.path().join("note.md"), source).unwrap();

        let reader_files = ScratchDir::new().unwrap();
        let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
        let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
        assert!(output.status.success());
        let mut runtime: Value = serde_json::from_slice(&output.stdout).unwrap();
        let node = PathBuf::from(
            runtime
                .as_object_mut()
                .unwrap()
                .remove("path")
                .unwrap()
                .as_str()
                .unwrap(),
        );
        runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
        let mut manifest = json!({
            "version":1,"runtime":runtime,"buildSha256":"test",
            "parentCwd":std::env::current_dir().unwrap()
        });
        let script = include_str!("../../../dohc-engine-reader/src/fake.cjs")
            .replace("MANIFEST", &manifest.to_string())
            .replace("MODE", "\"normal\"")
            .replace(
                "function answer(r) {",
                "function answer(r) {\n\
                 if (r.method === 'check-markdown-witness') return control({id:r.id,\
                 kind:'witness-checked',sourceSha256:r.sourceSha256,\
                 projectionSha256:r.projectionSha256,keepsMeaning:true});",
            )
            .replace(
                "const fault = r.currentPath;",
                "const fault = r.method === 'construct' ? 'note.md' : 'expired';",
            )
            .replace(
                "projectionSha256:hash('projection')",
                &format!(
                    "projectionSha256:r.method === 'construct' ? {original_projection:?} : {:?}",
                    hex_sha256(expected.as_bytes())
                ),
            );
        let bundle = reader_files.path().join("reader.cjs");
        std::fs::write(&bundle, &script).unwrap();
        manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
        manifest["sources"] = json!([]);
        let manifest_path = reader_files.path().join("manifest.json");
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        let service = EngineService::new();
        service.configure_reader(dohc_engine_reader::Config {
            node,
            bundle,
            manifest: manifest_path,
        });
        let (service, owner, _ingress) = service
            .configure_live_host(config(&[(scratch.path(), "w")]))
            .await
            .unwrap();
        let workspace = handle(&service, 0);
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let (session, initial) = service
            .ydoc_open(
                &ctx,
                Some(workspace.clone()),
                json!({"versionId":"main","path":"note.md","contentKind":"richdoc"}),
                1,
            )
            .await
            .unwrap();
        let initial_doc = Ydoc::wire();
        initial_doc.apply(&initial.bytes).unwrap();
        assert!(initial_doc.has_reader_source());
        drop(initial);
        service
            .ydoc_record_update(
                &ctx,
                Some(workspace.clone()),
                None,
                json!({
                    "sessionId":session["sessionId"],"updateBase64":STANDARD.encode(update),
                    "expectedLineageClaimId":session["lineageClaimId"],"actorOriginId":"editor",
                    "attribution":{"actorKind":"agent","onBehalfOf":"person","depth":0}
                }),
            )
            .await
            .unwrap();
        let settled = service
            .ydoc_settle(
                &ctx,
                Some(workspace),
                json!({"sessionId":session["sessionId"]}),
            )
            .await
            .unwrap();
        assert_eq!(settled["content"], expected);
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("note.md")).unwrap(),
            expected
        );
        assert!(service.reader.get().unwrap().dispatch_count() > 0);
        close(&service).await;
    }

    #[tokio::test]
    async fn configured_relay_publication_uses_the_sync_budget_and_reservation() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let mut configured = config(&[(scratch.path(), "workspace")]);
        configured.workspaces[0].relay = Some(
            serde_json::from_value(json!({
                "baseUrl":"https://relay.invalid", "bearerToken":"owner"
            }))
            .unwrap(),
        );
        configured.sync = Some(
            serde_json::from_value(json!({
                "policy":{"maxClientVectorBytes":100_000,"maxHostVectorBytes":100_000,
                    "maxOutputBytes":1_000_000,"maxReadBytes":4_000_000},
                "workingReserveBytes":4_000_000
            }))
            .unwrap(),
        );
        let (service, owner, _ingress) = EngineService::configured_live_host(configured)
            .await
            .unwrap();
        assert!(service.ordinary_live_host.get().is_none());
        let (policy, admission) = service.relay_sync_admission().unwrap();
        assert_eq!(policy.max_read_bytes, 4_000_000);
        assert_eq!(
            service
                .sync_admission(&owner.handle())
                .unwrap()
                .0
                .max_read_bytes,
            policy.max_read_bytes
        );
        let handle = handle(&service, 0);
        let mut reservations = Vec::new();
        loop {
            match admission.reserve() {
                Ok(reservation) => reservations.push(reservation),
                Err(error) => {
                    assert_eq!(error.code, ErrorCode::Overloaded);
                    break;
                }
            }
            assert!(reservations.len() < 100, "the aggregate budget is bounded");
        }
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let refused = service
            .sync_push(&ctx, Some(handle), json!({"workspaceId":"workspace"}))
            .await
            .unwrap_err();
        assert_eq!(refused.code, ErrorCode::Overloaded);
        drop(reservations);
        assert!(admission.reserve().is_ok());
        let other = ConnectionOwner::authenticated();
        assert!(service.sync_admission(&other.handle()).is_err());
        owner.retire();
        assert!(service.sync_admission(&owner.handle()).is_err());
        close(&service).await;
        assert!(EngineService::new().relay_sync_admission().is_none());
    }

    #[tokio::test]
    async fn cold_ordinary_workspace_has_main_before_discovery_and_preserves_it_on_restart() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        assert!(!scratch.path().join(".dohc/engine/engine.db").exists());
        let mut first_main = None;
        for _ in 0..2 {
            let mut config = config(&[(scratch.path(), "workspace")]);
            config.workspaces[0].relay = Some(
                serde_json::from_value(
                    json!({"baseUrl":"https://relay.invalid","bearerToken":"owner"}),
                )
                .unwrap(),
            );
            let (service, owner, _ingress) =
                EngineService::configured_live_host(config).await.unwrap();
            let handle = handle(&service, 0);
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            let main = service
                .versions_active(&ctx, Some(handle), json!({"workspaceId":"workspace"}))
                .await
                .unwrap();
            assert_eq!(main["id"], "main");
            if let Some(first) = &first_main {
                assert_eq!(&main, first);
            } else {
                first_main = Some(main);
            }
            close(&service).await;
        }
    }

    #[tokio::test]
    async fn owner_adoption_is_limited_to_the_configured_connection_and_attached_workspace() {
        let attached = dohc_engine_testkit::ScratchDir::new().unwrap();
        let private = dohc_engine_testkit::ScratchDir::new().unwrap();
        let mut config = config(&[(attached.path(), "attached"), (private.path(), "private")]);
        config.workspaces[0].relay = Some(
            serde_json::from_value(
                json!({"baseUrl":"https://relay.invalid","bearerToken":"owner"}),
            )
            .unwrap(),
        );
        config.adoption = Some(ConfiguredOwnerAdoption {
            max_bytes: 1_000_000,
            max_events: 10,
            owner_outbox: dohc_engine_collab::OwnerOutboxLimits {
                max_pending_bytes: 1_000_000,
                max_pending_age_ms: 60_000,
            },
        });
        let (service, owner, _ingress) = EngineService::configured_live_host(config).await.unwrap();
        let (attached, private) = (handle(&service, 0), handle(&service, 1));
        assert!(
            service
                .owner_adoption_config(&owner.handle(), Some(&attached))
                .is_ok()
        );
        assert!(
            service
                .owner_adoption_config(&owner.handle(), Some(&private))
                .is_err()
        );
        let other = ConnectionOwner::authenticated();
        assert!(
            service
                .owner_adoption_config(&other.handle(), Some(&attached))
                .is_err()
        );
        owner.retire();
        assert!(
            service
                .owner_adoption_config(&owner.handle(), Some(&attached))
                .is_err()
        );
        close(&service).await;
    }

    #[tokio::test]
    async fn settlement_requires_an_explicit_valid_operator_budget() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let (service, owner, _ingress) =
            EngineService::configured_live_host(config(&[(scratch.path(), "workspace")]))
                .await
                .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        assert!(matches!(
            service.configured_settlement_admission(&ctx),
            Err(WireError {
                code: ErrorCode::Forbidden,
                ..
            })
        ));
        close(&service).await;
        for max in [0, usize::MAX] {
            let root = dohc_engine_testkit::ScratchDir::new().unwrap();
            let mut invalid = config(&[(root.path(), "workspace")]);
            invalid.settlement = Some(SettlementConfig {
                max_applications_per_settlement: max,
            });
            assert!(EngineService::configured_live_host(invalid).await.is_err());
            assert!(!root.path().join(".dohc/engine/engine.db").exists());
        }
    }

    #[tokio::test]
    async fn configured_startup_cleans_partial_failure_and_discovery_fences_connection() {
        let held = dohc_engine_testkit::ScratchDir::new().unwrap();
        let first = dohc_engine_testkit::ScratchDir::new().unwrap();
        let (service, owner, _ingress) =
            EngineService::configured_live_host(config(&[(held.path(), "held")]))
                .await
                .unwrap();
        assert!(
            EngineService::configured_live_host(config(&[
                (first.path(), "first"),
                (held.path(), "held")
            ]))
            .await
            .is_err()
        );
        let (reopened, reopened_owner, _ingress) =
            EngineService::configured_live_host(config(&[(first.path(), "first")]))
                .await
                .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let mut request = Request {
            id: 1,
            method: "liveApplication.hosts".into(),
            workspace: None,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({}),
        };
        assert!(service.configured_live_hosts(&ctx, &request).is_ok());
        request.workspace = Some(WorkspaceHandle("ignored".into()));
        assert_eq!(
            service
                .configured_live_hosts(&ctx, &request)
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams
        );
        request.workspace = None;
        ctx.max_frame_bytes = 20;
        assert_eq!(
            service
                .configured_live_hosts(&ctx, &request)
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        ctx.max_frame_bytes = WireLimits::default().max_frame_bytes;
        ctx.connection = Some(reopened_owner.handle());
        assert_eq!(
            service
                .configured_live_hosts(&ctx, &request)
                .unwrap_err()
                .code,
            ErrorCode::SessionExpired
        );
        ctx.connection = Some(owner.handle());
        owner.retire();
        assert_eq!(
            service
                .configured_live_hosts(&ctx, &request)
                .unwrap_err()
                .code,
            ErrorCode::SessionExpired
        );
        close(&service).await;
        close(&reopened).await;
    }

    fn host_request(method: &str, workspace: Option<WorkspaceHandle>, params: Value) -> Request {
        Request {
            id: 1,
            method: method.into(),
            workspace,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params,
        }
    }

    #[tokio::test]
    async fn empty_host_attaches_and_detaches_while_a_sibling_keeps_registrations() {
        let first = dohc_engine_testkit::ScratchDir::new().unwrap();
        let second = dohc_engine_testkit::ScratchDir::new().unwrap();
        let unused = dohc_engine_testkit::ScratchDir::new().unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(config(&[]))
            .await
            .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let hosts = |ctx: &RequestContext| {
            service
                .configured_live_hosts(ctx, &host_request("liveApplication.hosts", None, json!({})))
                .unwrap()
        };
        assert_eq!(hosts(&ctx)["workspaces"], json!([]));
        let attach = |root: &Path, id: &str| {
            host_request(
                "liveApplication.attachWorkspace",
                None,
                json!({"root": root, "workspaceId": id, "maxRegistrations": 4}),
            )
        };
        let detach = |handle: &WorkspaceHandle| {
            host_request(
                "liveApplication.detachWorkspace",
                Some(handle.clone()),
                json!({}),
            )
        };
        let mut handles = Vec::new();
        let mut registrations = Vec::new();
        for (root, id) in [(first.path(), "first"), (second.path(), "second")] {
            let attached = service
                .configured_attach_workspace(&ctx, attach(root, id))
                .await
                .unwrap();
            assert_eq!(attached["workspaceId"], id);
            let handle: WorkspaceHandle =
                serde_json::from_value(attached["workspaceHandle"].clone()).unwrap();
            let open = service.open(Some(&handle)).unwrap();
            open.actor
                .ensure_main_version(
                    id.into(),
                    0,
                    Arc::new(dohc_engine_storage::NoFaults),
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await
                .unwrap();
            let binding = json!({"workspaceId":id,"mainVersionId":"main","objectId":"document",
                "lineageClaimId":dohc_engine_storage::hex_sha256(&dohc_engine_collab::Ydoc::wire().encode_full_state()),
                "currentPath":"document.md","selectorPaths":["document.md"],"restoreFenceGeneration":0});
            let registered = service
                .live_application_register(&ctx, Some(handle.clone()), json!({"binding": binding}))
                .await
                .unwrap();
            registrations.push(registered["registrationId"].as_u64().unwrap());
            handles.push(handle);
        }
        let ids = |listed: Value| -> Vec<Value> {
            listed["workspaces"]
                .as_array()
                .unwrap()
                .iter()
                .map(|workspace| workspace["workspaceId"].clone())
                .collect()
        };
        assert_eq!(ids(hosts(&ctx)), [json!("first"), json!("second")]);
        for duplicate in [
            attach(first.path(), "other"),
            attach(unused.path(), "first"),
        ] {
            assert_eq!(
                service
                    .configured_attach_workspace(&ctx, duplicate)
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidParams
            );
        }
        let stranger = ConnectionOwner::authenticated();
        let mut foreign = RequestContext::unbounded();
        foreign.connection = Some(stranger.handle());
        assert_eq!(
            service
                .configured_attach_workspace(&foreign, attach(unused.path(), "unused"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::SessionExpired
        );
        assert_eq!(
            service
                .configured_detach_workspace(&foreign, detach(&handles[0]))
                .await
                .unwrap_err()
                .code,
            ErrorCode::SessionExpired
        );
        assert!(!unused.path().join(".dohc").exists());

        assert_eq!(
            service
                .configured_detach_workspace(&ctx, detach(&handles[1]))
                .await
                .unwrap(),
            json!({"detached": true})
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&handles[0]), registrations[0])
                .is_ok()
        );
        assert!(
            service
                .live_application_registration(&owner.handle(), Some(&handles[1]), registrations[1])
                .is_err()
        );
        assert_eq!(ids(hosts(&ctx)), [json!("first")]);
        let unavailable = crate::rpc::error::workspace_unavailable().code;
        assert_eq!(
            service
                .configured_detach_workspace(&ctx, detach(&handles[1]))
                .await
                .unwrap_err()
                .code,
            unavailable
        );
        // The released root attaches again with a fresh handle.
        let again = service
            .configured_attach_workspace(&ctx, attach(second.path(), "second"))
            .await
            .unwrap();
        let again: WorkspaceHandle =
            serde_json::from_value(again["workspaceHandle"].clone()).unwrap();
        assert_ne!(again, handles[1]);
        assert_eq!(ids(hosts(&ctx)), [json!("first"), json!("second")]);
        for handle in [handles[0].clone(), again] {
            service
                .configured_detach_workspace(&ctx, detach(&handle))
                .await
                .unwrap();
        }
        assert_eq!(hosts(&ctx)["workspaces"], json!([]));
        assert!(lock(&service.handles).is_empty());
    }

    #[tokio::test]
    async fn attach_refuses_a_root_inside_or_around_an_attached_root() {
        let tree = dohc_engine_testkit::ScratchDir::new().unwrap();
        let attached = tree.path().join("attached");
        let nested = attached.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(config(&[]))
            .await
            .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let attach = |root: &Path, id: &str| {
            host_request(
                "liveApplication.attachWorkspace",
                None,
                json!({"root": root, "workspaceId": id, "maxRegistrations": 4}),
            )
        };
        let opened = service
            .configured_attach_workspace(&ctx, attach(attached.as_path(), "attached"))
            .await
            .unwrap();
        for (root, id) in [(nested.as_path(), "descendant"), (tree.path(), "ancestor")] {
            assert_eq!(
                service
                    .configured_attach_workspace(&ctx, attach(root, id))
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidParams,
                "{id}"
            );
            assert!(!root.join(".dohc").exists(), "{id}");
        }
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspaceHandle"].clone()).unwrap();
        service
            .configured_detach_workspace(
                &ctx,
                host_request("liveApplication.detachWorkspace", Some(handle), json!({})),
            )
            .await
            .unwrap();
        assert!(lock(&service.handles).is_empty());
    }

    /// A queue of the shared binding with `update` as its one entry.
    fn append(workspace_id: &str, update: &[u8]) -> Value {
        use base64::Engine as _;
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../packages/live-session-contract/src/liveObjectBinding.vectors.json"
        ))
        .unwrap();
        let mut binding = vectors["accepted"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == "canonical-binding")
            .unwrap()["input"]
            .clone();
        binding["workspaceId"] = json!(workspace_id);
        json!({
            "binding": binding,
            "baseUpdateBase64": base64::engine::general_purpose::STANDARD.encode(b"base"),
            "appendKey": "recovery",
            "updateBase64": base64::engine::general_purpose::STANDARD.encode(update),
            "limits": {"maxPendingBytes": 1_000, "maxPendingAgeMs": 60_000}
        })
    }

    /// The engine database of the store at `root`.
    fn database(root: &Path) -> PathBuf {
        root.join(".dohc").join("engine").join("engine.db")
    }

    /// An empty host that copies earlier stores under `root`.
    fn recovering(root: &Path) -> ConfiguredLiveHostConfig {
        let mut configured = config(&[]);
        configured.recovery = Some(
            serde_json::from_value(json!({"root": root, "preparationDeadlineMs": 60_000})).unwrap(),
        );
        configured
    }

    /// Waits until the preparation of the store open for recovery under
    /// `handle` ended, as its worker's lease does.
    async fn prepared(service: &EngineService, handle: &WorkspaceHandle) {
        let reads = lock(&service.configured_live_host.get().unwrap().recovery)
            .iter()
            .find(|entry| &entry.handle == handle)
            .map(|entry| entry.reads.clone())
            .unwrap();
        drop(reads.write().await);
    }

    /// Opens the store for recovery, waits for its preparation, and returns
    /// its handle.
    async fn open_prepared(
        service: &EngineService,
        ctx: RequestContext,
        request: Request,
    ) -> Result<WorkspaceHandle, WireError> {
        let opened = service.dispatch(ctx, request).await?.response.result;
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspaceHandle"].clone()).unwrap();
        prepared(service, &handle).await;
        Ok(handle)
    }

    /// The first page of the queue `outbox_id` through `handle`, or its refusal.
    async fn first_page(
        service: &EngineService,
        ctx: RequestContext,
        handle: &WorkspaceHandle,
        outbox_id: &str,
    ) -> Result<Value, WireError> {
        Ok(service
            .dispatch(
                ctx,
                host_request(
                    "ydoc.ownerOutbox.readPending",
                    Some(handle.clone()),
                    json!({"outboxId": outbox_id}),
                ),
            )
            .await?
            .response
            .result)
    }

    fn close_request(handle: &WorkspaceHandle) -> Request {
        host_request(
            "liveApplication.closeRecoveryStore",
            Some(handle.clone()),
            json!({}),
        )
    }

    /// Records `epoch` as the hosted workspace identity of the detached store
    /// at `root`, as creating its hosted replica does.
    fn host_identity(root: &Path, epoch: &str) {
        rusqlite::Connection::open(database(root))
            .unwrap()
            .execute_batch(&format!(
                "INSERT INTO sync_identity \
                 (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) \
                 VALUES ('workspace','service-host:host','{epoch}','stream',1) \
                 ON CONFLICT(workspace_id) DO UPDATE SET \
                 replication_epoch=excluded.replication_epoch, \
                 stream_identity=excluded.stream_identity; \
                 INSERT OR IGNORE INTO hosted_replicas (workspace_id,created_at_ms) \
                 VALUES ('workspace',1);"
            ))
            .unwrap();
    }

    /// Opens the store at `root` for recovery as workspace `id`'s store of `epoch`.
    fn recover(root: &Path, id: &str, epoch: &str) -> Request {
        host_request(
            "liveApplication.openRecoveryStore",
            None,
            json!({"root": root, "workspaceId": id, "replicationEpoch": epoch,
                "streamIdentity": "stream"}),
        )
    }

    /// The queued update bytes, read page by page through dispatch.
    async fn queued(
        service: &EngineService,
        ctx: impl Fn() -> RequestContext,
        handle: &WorkspaceHandle,
        outbox_id: &str,
    ) -> Result<Vec<u8>, WireError> {
        use base64::Engine as _;
        let (mut cursor, mut update) = (Value::Null, Vec::new());
        for _ in 0..16 {
            let page = service
                .dispatch(
                    ctx(),
                    host_request(
                        "ydoc.ownerOutbox.readPending",
                        Some(handle.clone()),
                        json!({"outboxId": outbox_id, "cursor": cursor}),
                    ),
                )
                .await?
                .response
                .result;
            assert_eq!(page["kind"], "page");
            if page["part"] == "update" {
                update.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(page["bytesBase64"].as_str().unwrap())
                        .unwrap(),
                );
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                return Ok(update);
            }
        }
        panic!("the queue did not end");
    }

    #[tokio::test]
    async fn an_earlier_store_opens_read_only_for_recovery_beside_the_attached_store() {
        let earlier = dohc_engine_testkit::ScratchDir::new().unwrap();
        let current = dohc_engine_testkit::ScratchDir::new().unwrap();
        let copies = dohc_engine_testkit::ScratchDir::new().unwrap();
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let ctx = || {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            ctx
        };
        let attach = |root: &Path| {
            host_request(
                "liveApplication.attachWorkspace",
                None,
                json!({"root": root, "workspaceId": "workspace", "maxRegistrations": 4,
                    "relay": {"baseUrl": "https://relay.invalid", "bearerToken": "owner"}}),
            )
        };
        let recover = |root: &Path, id: &str| recover(root, id, "earlier");
        let handle_of = |value: Value| -> WorkspaceHandle {
            serde_json::from_value(value["workspaceHandle"].clone()).unwrap()
        };
        // An identity change leaves the first store behind, and the second
        // holds a queue with the same ID and other edits.
        let mut outboxes = Vec::new();
        let mut attached = Vec::new();
        for (root, update) in [(earlier.path(), b"earlier"), (current.path(), b"current")] {
            let handle = handle_of(
                service
                    .configured_attach_workspace(&ctx(), attach(root))
                    .await
                    .unwrap(),
            );
            let appended = service
                .owner_ydoc_outbox_append(&ctx(), Some(handle.clone()), append("workspace", update))
                .await
                .unwrap();
            outboxes.push(appended["outboxId"].as_str().unwrap().to_owned());
            attached.push(handle);
            if root == earlier.path() {
                service
                    .configured_detach_workspace(
                        &ctx(),
                        host_request(
                            "liveApplication.detachWorkspace",
                            Some(attached[0].clone()),
                            json!({}),
                        ),
                    )
                    .await
                    .unwrap();
                host_identity(root, "earlier");
            }
        }
        assert_eq!(outboxes[0], outboxes[1]);
        let outbox = outboxes[0].as_str();
        // The earlier store reads only as the identity it holds.
        let refused = open_prepared(
            &service,
            ctx(),
            self::recover(earlier.path(), "workspace", "later"),
        )
        .await
        .unwrap();
        for _ in 0..2 {
            assert_eq!(
                first_page(&service, ctx(), &refused, outbox)
                    .await
                    .unwrap_err()
                    .message,
                "recovery store belongs to another root or workspace"
            );
        }
        service
            .dispatch(ctx(), close_request(&refused))
            .await
            .unwrap();
        let recovery = open_prepared(&service, ctx(), recover(earlier.path(), "workspace"))
            .await
            .unwrap();
        // A store this build fully migrated is read in place.
        let daemon = service
            .configured_live_host
            .get()
            .unwrap()
            .copies
            .clone()
            .unwrap();
        assert_eq!(std::fs::read_dir(daemon.daemon()).unwrap().count(), 0);
        assert_eq!(
            queued(&service, ctx, &recovery, outbox).await.unwrap(),
            b"earlier"
        );
        assert_eq!(
            queued(&service, ctx, &attached[1], outbox).await.unwrap(),
            b"current"
        );
        // One recovery store per workspace, and none on a root already open.
        assert_eq!(
            handle_of(
                service
                    .dispatch(ctx(), recover(earlier.path(), "workspace"))
                    .await
                    .unwrap()
                    .response
                    .result,
            ),
            recovery
        );
        for (root, id, code) in [
            (current.path(), "workspace", ErrorCode::Conflict),
            (current.path(), "other", ErrorCode::InvalidParams),
            (earlier.path(), "other", ErrorCode::InvalidParams),
        ] {
            assert_eq!(
                service
                    .dispatch(ctx(), recover(root, id))
                    .await
                    .unwrap_err()
                    .code,
                code,
                "{id}"
            );
        }
        assert_eq!(
            service
                .configured_attach_workspace(&ctx(), attach(earlier.path()))
                .await
                .unwrap_err()
                .message,
            "live host workspace root is open for recovery"
        );
        // The handle answers nothing but page reads, and only to the host's connection.
        for method in [
            "ydoc.ownerOutbox.retry",
            "ydoc.ownerOutbox.quarantine",
            "ydoc.ownerOutbox.acknowledge",
            "liveApplication.detachWorkspace",
            "versionedText.read",
        ] {
            assert_eq!(
                service
                    .dispatch(
                        ctx(),
                        host_request(method, Some(recovery.clone()), json!({"outboxId": outbox})),
                    )
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::Forbidden,
                "{method}"
            );
        }
        let stranger = ConnectionOwner::authenticated();
        let foreign = || {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(stranger.handle());
            ctx
        };
        assert_eq!(
            queued(&service, foreign, &recovery, outbox)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Forbidden
        );
        assert_eq!(
            service
                .dispatch(foreign(), recover(earlier.path(), "other"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::SessionExpired
        );
        // Closed, the handle reads nothing; the store opens again with a new one.
        let close = |handle: &WorkspaceHandle| {
            host_request(
                "liveApplication.closeRecoveryStore",
                Some(handle.clone()),
                json!({}),
            )
        };
        assert_eq!(
            service
                .dispatch(ctx(), close(&recovery))
                .await
                .unwrap()
                .response
                .result,
            json!({"closed": true})
        );
        assert!(queued(&service, ctx, &recovery, outbox).await.is_err());
        assert_eq!(
            service
                .dispatch(ctx(), close(&recovery))
                .await
                .unwrap_err()
                .code,
            crate::rpc::error::workspace_unavailable().code
        );
        // A store of one workspace never reads as another's.
        let other = open_prepared(&service, ctx(), recover(earlier.path(), "other"))
            .await
            .unwrap();
        assert_eq!(
            first_page(&service, ctx(), &other, outbox)
                .await
                .unwrap_err()
                .message,
            "recovery store belongs to another root or workspace"
        );
        service.dispatch(ctx(), close(&other)).await.unwrap();
        let again = open_prepared(&service, ctx(), recover(earlier.path(), "workspace"))
            .await
            .unwrap();
        assert_ne!(again, recovery);
        assert_eq!(
            queued(&service, ctx, &again, outbox).await.unwrap(),
            b"earlier"
        );
        service.dispatch(ctx(), close(&again)).await.unwrap();
        service
            .configured_detach_workspace(
                &ctx(),
                host_request(
                    "liveApplication.detachWorkspace",
                    Some(attached[1].clone()),
                    json!({}),
                ),
            )
            .await
            .unwrap();
        assert!(lock(&service.handles).is_empty());
    }

    #[tokio::test]
    async fn an_earlier_stores_frozen_queue_without_its_recovery_checkpoint_refuses_the_copy() {
        let earlier = dohc_engine_testkit::ScratchDir::new().unwrap();
        let copies = dohc_engine_testkit::ScratchDir::new().unwrap();
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let ctx = || {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            ctx
        };
        let attached = service
            .configured_attach_workspace(
                &ctx(),
                host_request(
                    "liveApplication.attachWorkspace",
                    None,
                    json!({"root": earlier.path(), "workspaceId": "workspace", "maxRegistrations": 4,
                        "relay": {"baseUrl": "https://relay.invalid", "bearerToken": "owner"}}),
                ),
            )
            .await
            .unwrap();
        let handle: WorkspaceHandle =
            serde_json::from_value(attached["workspaceHandle"].clone()).unwrap();
        let appended = service
            .owner_ydoc_outbox_append(&ctx(), Some(handle.clone()), append("workspace", b"seed"))
            .await
            .unwrap();
        let outbox = appended["outboxId"].as_str().unwrap().to_owned();
        service
            .configured_detach_workspace(
                &ctx(),
                host_request("liveApplication.detachWorkspace", Some(handle), json!({})),
            )
            .await
            .unwrap();
        host_identity(earlier.path(), "earlier");
        // Its owner's adoption seed was refused for good while its document's
        // binding stayed on the queue's generation, and no read built the
        // recovery checkpoint of that generation's last applied cursor.
        let frozen = rusqlite::Connection::open(database(earlier.path())).unwrap();
        frozen
            .execute_batch(
                "UPDATE owner_ydoc_outboxes SET state='quarantined',quarantine_reason='invalid-update'; \
                 UPDATE owner_ydoc_outbox_entries SET native_source_json='{\"origin\":{\"kind\":\"adoptionSeed\"}}'; \
                 INSERT INTO live_device_application_bindings SELECT 'namespace',workspace_id,main_version_id,object_id,\
                 lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,'host',1,'instance','connection',0 \
                 FROM owner_ydoc_outboxes;",
            )
            .unwrap();
        drop(frozen);
        // The earlier store has no writer to build it, so the copy is refused
        // instead of answering a change it can never finish.
        let recovery = open_prepared(
            &service,
            ctx(),
            recover(earlier.path(), "workspace", "earlier"),
        )
        .await
        .unwrap();
        for _ in 0..2 {
            let refused = first_page(&service, ctx(), &recovery, &outbox)
                .await
                .unwrap_err();
            assert_eq!(
                (refused.code, refused.message.as_str()),
                (
                    ErrorCode::InvalidParams,
                    "owner-outbox-recovery-checkpoint-unavailable"
                )
            );
        }
        service
            .dispatch(ctx(), close_request(&recovery))
            .await
            .unwrap();
    }

    /// Attaches the store at `root` as `workspace`, then detaches it.
    async fn detached_store(service: &EngineService, ctx: &RequestContext, root: &Path) {
        let attached = service
            .configured_attach_workspace(
                ctx,
                host_request(
                    "liveApplication.attachWorkspace",
                    None,
                    json!({"root": root, "workspaceId": "workspace", "maxRegistrations": 4}),
                ),
            )
            .await
            .unwrap();
        service
            .configured_detach_workspace(
                ctx,
                host_request(
                    "liveApplication.detachWorkspace",
                    Some(serde_json::from_value(attached["workspaceHandle"].clone()).unwrap()),
                    json!({}),
                ),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_store_reads_for_recovery_only_as_the_identity_it_holds() {
        let store = dohc_engine_testkit::ScratchDir::new().unwrap();
        let copies = dohc_engine_testkit::ScratchDir::new().unwrap();
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        detached_store(&service, &ctx, store.path()).await;
        host_identity(store.path(), "epoch");
        // With no versioned state, only its identity says whose store it is.
        rusqlite::Connection::open(database(store.path()))
            .unwrap()
            .execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM versioned_workspaces;")
            .unwrap();
        for (id, epoch) in [("workspace", "later"), ("other", "epoch")] {
            let handle = open_prepared(&service, ctx.clone(), recover(store.path(), id, epoch))
                .await
                .unwrap();
            assert_eq!(
                first_page(&service, ctx.clone(), &handle, "outbox")
                    .await
                    .unwrap_err()
                    .message,
                "recovery store belongs to another root or workspace",
                "{id} {epoch}"
            );
            service
                .dispatch(ctx.clone(), close_request(&handle))
                .await
                .unwrap();
        }
        assert!(lock(&service.handles).is_empty());
    }

    /// Every file of the store at `root` with the digest of its bytes,
    /// sidecars and root marker included.
    fn store_files(root: &Path) -> Vec<(std::ffi::OsString, String)> {
        let mut files: Vec<_> = std::fs::read_dir(root.join(".dohc").join("engine"))
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                let bytes = std::fs::read(entry.path()).unwrap();
                (entry.file_name(), dohc_engine_storage::hex_sha256(&bytes))
            })
            .collect();
        files.sort();
        files
    }

    /// Makes `earlier` the store an older build, which lacked this build's
    /// last migration, would hold with the rows of the queues, blobs, root
    /// binding and hosted identity of the detached store at `reference`. Its
    /// schema comes from the genuine migration prefix.
    fn earlier_copy_of(reference: &Path, earlier: &Path) {
        older_copy_of(reference, earlier, 1);
    }

    /// The same, from a build that lacked this build's last `missing` migrations.
    fn older_copy_of(reference: &Path, earlier: &Path, missing: usize) {
        let token = crate::root_binding::read_root_binding(reference)
            .unwrap()
            .unwrap();
        crate::root_binding::write_root_binding(earlier, &token).unwrap();
        dohc_engine_storage::recovery::create_earlier_store_for_test(&database(earlier), missing)
            .unwrap();
        let conn = rusqlite::Connection::open(database(earlier)).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        conn.execute(
            "ATTACH DATABASE ?1 AS reference",
            [database(reference).to_str().unwrap()],
        )
        .unwrap();
        // Entries before their queues, so no count trigger finds a queue to change.
        for table in [
            "binary_blobs",
            "sync_identity",
            "hosted_replicas",
            "shadow_clone",
            "owner_ydoc_outbox_entries",
            "owner_ydoc_outboxes",
        ] {
            let columns = conn
                .prepare(&format!(
                    "SELECT name FROM pragma_table_info('{table}', 'main')"
                ))
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join(",");
            conn.execute_batch(&format!(
                "INSERT INTO main.{table} ({columns}) SELECT {columns} FROM reference.{table}"
            ))
            .unwrap();
        }
        conn.execute_batch("DETACH DATABASE reference").unwrap();
    }

    /// Every page of the queue `outbox_id` through `handle`, then its
    /// checkpoint's when its header names one.
    async fn package(
        service: &EngineService,
        ctx: impl Fn() -> RequestContext,
        handle: &WorkspaceHandle,
        outbox_id: &str,
    ) -> Vec<Value> {
        use base64::Engine as _;
        let read = |cursor: Value| {
            service.dispatch(
                ctx(),
                host_request(
                    "ydoc.ownerOutbox.readPending",
                    Some(handle.clone()),
                    json!({"outboxId": outbox_id, "cursor": cursor}),
                ),
            )
        };
        let (mut pages, mut cursor) = (Vec::new(), Value::Null);
        loop {
            let page = read(cursor).await.unwrap().response.result;
            assert_eq!(page["kind"], "page");
            cursor = page["nextCursor"].clone();
            pages.push(page);
            if cursor.is_null() {
                break;
            }
        }
        let header: Value = serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(pages[0]["bytesBase64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        if !header["checkpointDigest"].is_null() {
            let checkpoint = json!({"snapshot": pages[0]["snapshot"], "part": "checkpoint",
                "sequence": 0, "offset": 0});
            pages.push(read(checkpoint).await.unwrap().response.result);
        }
        pages
    }

    /// Makes the store at `root` one where a daemon refused the owner's edits
    /// and then detached it. Returns the refused queue.
    async fn refused_store(root: &Path) -> String {
        let (service, owner, _ingress) = EngineService::configured_live_host(config(&[]))
            .await
            .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let attached: WorkspaceHandle = serde_json::from_value(
            service
                .configured_attach_workspace(
                    &ctx,
                    host_request(
                        "liveApplication.attachWorkspace",
                        None,
                        json!({"root": root, "workspaceId": "workspace",
                            "maxRegistrations": 4, "relay": {"baseUrl": "https://relay.invalid",
                            "bearerToken": "owner"}}),
                    ),
                )
                .await
                .unwrap()["workspaceHandle"]
                .clone(),
        )
        .unwrap();
        let appended = service
            .owner_ydoc_outbox_append(
                &ctx,
                Some(attached.clone()),
                append("workspace", b"refused edits"),
            )
            .await
            .unwrap();
        let outbox = appended["outboxId"].as_str().unwrap().to_owned();
        service
            .owner_ydoc_outbox_quarantine(
                &ctx,
                Some(attached.clone()),
                json!({"outboxId": outbox, "reason": "invalid-update"}),
            )
            .await
            .unwrap();
        service
            .configured_detach_workspace(
                &ctx,
                host_request("liveApplication.detachWorkspace", Some(attached), json!({})),
            )
            .await
            .unwrap();
        outbox
    }

    #[tokio::test]
    async fn an_earlier_store_of_an_older_build_is_copied_migrated_and_read_whole() {
        let reference = dohc_engine_testkit::ScratchDir::new().unwrap();
        let earlier = dohc_engine_testkit::ScratchDir::new().unwrap();
        let copies = dohc_engine_testkit::ScratchDir::new().unwrap();
        // A daemon refused the owner's edits, then the workspace's identity changed.
        let outbox = refused_store(reference.path()).await;
        host_identity(reference.path(), "earlier");
        earlier_copy_of(reference.path(), earlier.path());
        assert!(matches!(
            dohc_engine_storage::EngineStore::open_read_only(&database(earlier.path())),
            Err(dohc_engine_storage::StorageError::MigrationPending)
        ));
        // That read left empty sidecars; the store the older build left has none.
        for sidecar in ["engine.db-wal", "engine.db-shm"] {
            let path = database(earlier.path()).with_file_name(sidecar);
            if path.exists() {
                std::fs::remove_file(path).unwrap();
            }
        }
        let before = store_files(earlier.path());
        // A restarted daemon reads both: the current one in place, the older one from a copy.
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let ctx = || {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            ctx
        };
        let daemon = service
            .configured_live_host
            .get()
            .unwrap()
            .copies
            .clone()
            .unwrap();
        let read = |root: PathBuf| {
            let (service, daemon, outbox) = (&service, daemon.clone(), outbox.clone());
            async move {
                let handle = open_prepared(service, ctx(), recover(&root, "workspace", "earlier"))
                    .await
                    .unwrap();
                let copied = std::fs::read_dir(daemon.daemon()).unwrap().count();
                let pages = package(service, ctx, &handle, &outbox).await;
                service
                    .dispatch(ctx(), close_request(&handle))
                    .await
                    .unwrap();
                (pages, copied)
            }
        };
        let (expected, copied) = read(reference.path().to_path_buf()).await;
        assert_eq!(copied, 0);
        let (recovered, copied) = read(earlier.path().to_path_buf()).await;
        assert_eq!(copied, 1);
        assert_eq!(recovered, expected);
        assert_eq!(
            recovered
                .iter()
                .map(|page| page["part"].clone())
                .collect::<Vec<_>>(),
            [
                json!("header"),
                json!("base"),
                json!("entryHeader"),
                json!("update")
            ]
        );
        use base64::Engine as _;
        let header: Value = serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(recovered[0]["bytesBase64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(header["state"], "quarantined");
        assert_eq!(header["quarantineReason"], "invalid-update");
        assert_eq!(header["pendingEntryCount"], 1);
        let update = base64::engine::general_purpose::STANDARD
            .decode(recovered[3]["bytesBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(update, b"refused edits");
        assert_eq!(
            recovered[3]["digest"],
            dohc_engine_storage::hex_sha256(b"refused edits")
        );
        // The copy went with its close, and the earlier store is as it was.
        assert_eq!(std::fs::read_dir(daemon.daemon()).unwrap().count(), 0);
        assert_eq!(store_files(earlier.path()), before);
        service.close_recovery_stores().await;
        assert!(!daemon.daemon().exists());
        assert_eq!(
            std::fs::read_dir(copies.path().join(".recovery"))
                .unwrap()
                .count(),
            0
        );
    }

    /// The detached store at `root`, with `epoch` its hosted identity, as an
    /// older build left it. `reference` holds the current store it came from.
    async fn earlier_store(
        service: &EngineService,
        ctx: &RequestContext,
        reference: &Path,
        root: &Path,
    ) {
        detached_store(service, ctx, reference).await;
        host_identity(reference, "epoch");
        earlier_copy_of(reference, root);
    }

    #[tokio::test]
    async fn a_preparing_store_keeps_its_root_while_membership_continues_and_ends_with_its_close() {
        let (reference, store, sibling, copies) = (
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
        );
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        earlier_store(&service, &ctx, reference.path(), store.path()).await;
        let before = store_files(store.path());
        let daemon = service
            .configured_live_host
            .get()
            .unwrap()
            .copies
            .clone()
            .unwrap();
        for ending in ["close", "shutdown"] {
            // The worker waits at its gate, before it opens the store.
            let (open_gate, gate) = std::sync::mpsc::channel();
            lock(&PREPARATION_GATES).push(PreparationGate {
                root: std::fs::canonicalize(store.path()).unwrap(),
                open: gate,
                waiting: None,
                began: None,
            });
            let opened = service
                .dispatch(ctx.clone(), recover(store.path(), "workspace", "epoch"))
                .await
                .unwrap()
                .response
                .result;
            let handle: WorkspaceHandle =
                serde_json::from_value(opened["workspaceHandle"].clone()).unwrap();
            assert_eq!(
                first_page(&service, ctx.clone(), &handle, "outbox")
                    .await
                    .unwrap(),
                json!({"kind": "preparing"})
            );
            // An open whose reply was lost finds the same preparation.
            assert_eq!(
                service
                    .dispatch(ctx.clone(), recover(store.path(), "workspace", "epoch"))
                    .await
                    .unwrap()
                    .response
                    .result,
                opened
            );
            assert_eq!(
                service
                    .configured_attach_workspace(
                        &ctx,
                        host_request(
                            "liveApplication.attachWorkspace",
                            None,
                            json!({"root": store.path(), "workspaceId": "workspace", "maxRegistrations": 4}),
                        ),
                    )
                    .await
                    .unwrap_err()
                    .message,
                "live host workspace root is open for recovery"
            );
            // Membership does not wait on the preparation.
            detached_store(&service, &ctx, sibling.path()).await;
            let ended = async {
                if ending == "close" {
                    service
                        .dispatch(ctx.clone(), close_request(&handle))
                        .await
                        .unwrap();
                } else {
                    service.close_recovery_stores().await;
                }
            };
            tokio::pin!(ended);
            tokio::select! {
                biased;
                () = &mut ended => panic!("the {ending} ended while its preparation ran"),
                () = std::future::ready(()) => {}
            }
            assert!(service.is_recovery_handle(Some(&handle)), "{ending}");
            open_gate.send(()).unwrap();
            ended.await;
            assert!(!service.is_recovery_handle(Some(&handle)), "{ending}");
            assert_eq!(store_files(store.path()), before, "{ending}");
        }
        assert!(!daemon.daemon().exists());
    }

    #[tokio::test]
    async fn a_failed_preparation_refuses_its_reads_and_removes_its_copy() {
        let (reference, store, copies) = (
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
        );
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        earlier_store(&service, &ctx, reference.path(), store.path()).await;
        // The migration this build adds then fails on the copy.
        rusqlite::Connection::open(database(store.path()))
            .unwrap()
            .execute_batch("CREATE TABLE replication_log_conflict_resolution (planted INTEGER)")
            .unwrap();
        let before = store_files(store.path());
        let handle = open_prepared(
            &service,
            ctx.clone(),
            recover(store.path(), "workspace", "epoch"),
        )
        .await
        .unwrap();
        assert_eq!(
            first_page(&service, ctx.clone(), &handle, "outbox")
                .await
                .unwrap_err()
                .message,
            "recovery store unavailable"
        );
        let daemon = service
            .configured_live_host
            .get()
            .unwrap()
            .copies
            .clone()
            .unwrap();
        assert_eq!(std::fs::read_dir(daemon.daemon()).unwrap().count(), 0);
        assert_eq!(store_files(store.path()), before);
        service
            .dispatch(ctx.clone(), close_request(&handle))
            .await
            .unwrap();
    }

    /// One preparation at a time per daemon: another workspace's store waits
    /// for the running one to end, and a close of the waiting one frees its
    /// root at once, without its preparation ever beginning.
    #[tokio::test]
    async fn preparations_take_turns_across_workspaces_and_a_closed_waiter_frees_its_root() {
        let (reference, store, other, copies) = (
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
        );
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        earlier_store(&service, &ctx, reference.path(), store.path()).await;
        let gate = |root: &Path| {
            let (open, gate) = std::sync::mpsc::channel();
            let (waiting, waits) = tokio::sync::oneshot::channel();
            let (began, beginning) = tokio::sync::oneshot::channel();
            lock(&PREPARATION_GATES).push(PreparationGate {
                root: std::fs::canonicalize(root).unwrap(),
                open: gate,
                waiting: Some(waiting),
                began: Some(began),
            });
            (open, waits, beginning)
        };
        let open = |root: &Path, id: &str| {
            let request = recover(root, id, "epoch");
            let service = service.clone();
            let ctx = ctx.clone();
            async move {
                let opened = service
                    .dispatch(ctx, request)
                    .await
                    .unwrap()
                    .response
                    .result;
                serde_json::from_value::<WorkspaceHandle>(opened["workspaceHandle"].clone())
                    .unwrap()
            }
        };
        // The first store's preparation holds the daemon's permit at its gate.
        let (open_first, _, first_began) = gate(store.path());
        let first = open(store.path(), "workspace").await;
        first_began.await.unwrap();
        // The second's worker reached its turn: it waits there, or with no
        // permit to wait for, it is already on its way to its gate.
        let (_open_second, second_waits, second_began) = gate(other.path());
        let second = open(other.path(), "other").await;
        second_waits.await.unwrap();
        assert_eq!(
            first_page(&service, ctx.clone(), &second, "outbox")
                .await
                .unwrap(),
            json!({"kind": "preparing"})
        );
        tokio::select! {
            biased;
            _ = second_began => panic!("two preparations ran at once"),
            closed = service.dispatch(ctx.clone(), close_request(&second)) => {
                closed.unwrap();
            }
        }
        assert!(!service.is_recovery_handle(Some(&second)));
        let other_root = std::fs::canonicalize(other.path()).unwrap();
        assert!(
            lock(&PREPARATION_GATES)
                .iter()
                .any(|gate| gate.root == other_root)
        );
        lock(&PREPARATION_GATES).retain(|gate| gate.root != other_root);
        assert!(service.is_recovery_handle(Some(&first)));
        open_first.send(()).unwrap();
        prepared(&service, &first).await;
        assert!(matches!(
            service.recovery_read(Some(&first)),
            Some(Ok(RecoveryPage::Read(_)))
        ));
        service
            .dispatch(ctx.clone(), close_request(&first))
            .await
            .unwrap();
    }

    /// A host whose operator configured no recovery copies still reads a
    /// store this build fully migrated, in place, and refuses one that would
    /// need a copy with the reason a server check covers.
    #[tokio::test]
    async fn a_host_without_recovery_copies_reads_a_current_store_and_refuses_an_older_one() {
        let (current, earlier) = (
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
        );
        let outbox = refused_store(current.path()).await;
        host_identity(current.path(), "epoch");
        let (service, owner, _ingress) = EngineService::configured_live_host(config(&[]))
            .await
            .unwrap();
        let ctx = || {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(owner.handle());
            ctx
        };
        let handle = open_prepared(
            &service,
            ctx(),
            recover(current.path(), "workspace", "epoch"),
        )
        .await
        .unwrap();
        assert_eq!(
            queued(&service, ctx, &handle, &outbox).await.unwrap(),
            b"refused edits"
        );
        service
            .dispatch(ctx(), close_request(&handle))
            .await
            .unwrap();
        earlier_copy_of(current.path(), earlier.path());
        let handle = open_prepared(
            &service,
            ctx(),
            recover(earlier.path(), "workspace", "epoch"),
        )
        .await
        .unwrap();
        assert_eq!(
            first_page(&service, ctx(), &handle, &outbox)
                .await
                .unwrap_err()
                .message,
            "recovery store unavailable"
        );
        service
            .dispatch(ctx(), close_request(&handle))
            .await
            .unwrap();
    }

    /// Every root is compared canonical, so a verbatim `\\?\` spelling or
    /// another case names the same folder.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_root_spelled_another_way_still_overlaps() {
        let (store, attached, copies) = (
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
        );
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let spellings = |path: &Path| {
            let plain = path.display().to_string();
            let plain = plain.strip_prefix(r"\\?\").unwrap_or(&plain).to_owned();
            [
                PathBuf::from(format!(r"\\?\{plain}")),
                PathBuf::from(plain.to_uppercase()),
            ]
        };
        let attach = |root: &Path, id: &str| {
            host_request(
                "liveApplication.attachWorkspace",
                None,
                json!({"root": root, "workspaceId": id, "maxRegistrations": 4}),
            )
        };
        let kept: WorkspaceHandle = serde_json::from_value(
            service
                .configured_attach_workspace(&ctx, attach(attached.path(), "other"))
                .await
                .unwrap()["workspaceHandle"]
                .clone(),
        )
        .unwrap();
        detached_store(&service, &ctx, store.path()).await;
        host_identity(store.path(), "epoch");
        let handle = open_prepared(
            &service,
            ctx.clone(),
            recover(store.path(), "workspace", "epoch"),
        )
        .await
        .unwrap();
        for root in spellings(attached.path())
            .into_iter()
            .chain(spellings(&copies.path().join(".recovery")))
        {
            assert_eq!(
                service
                    .dispatch(ctx.clone(), recover(&root, "other", "epoch"))
                    .await
                    .unwrap_err()
                    .message,
                "recovery store root is already open",
                "{}",
                root.display()
            );
        }
        for root in spellings(store.path()) {
            assert_eq!(
                service
                    .configured_attach_workspace(&ctx, attach(&root, "workspace"))
                    .await
                    .unwrap_err()
                    .message,
                "live host workspace root is open for recovery",
                "{}",
                root.display()
            );
        }
        service
            .dispatch(ctx.clone(), close_request(&handle))
            .await
            .unwrap();
        service
            .configured_detach_workspace(
                &ctx,
                host_request("liveApplication.detachWorkspace", Some(kept), json!({})),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_start_removes_only_the_copies_of_daemons_that_are_gone() {
        let copies = dohc_engine_testkit::ScratchDir::new().unwrap();
        let base = copies.path().join(".recovery");
        std::fs::create_dir(&base).unwrap();
        let (gone, unlocked, running) = ("a".repeat(32), "b".repeat(32), "c".repeat(32));
        for name in [&gone, &unlocked, &running] {
            std::fs::create_dir_all(base.join(name).join("copy")).unwrap();
            std::fs::write(base.join(name).join("copy").join("engine.db"), b"copy").unwrap();
        }
        std::fs::write(base.join(format!("{unlocked}.lock")), b"").unwrap();
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(base.join(format!("{running}.lock")))
            .unwrap();
        fs4::FileExt::try_lock(&held).unwrap();
        let (service, _owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        assert!(!base.join(&gone).exists());
        assert!(!base.join(&unlocked).exists());
        assert!(!base.join(format!("{unlocked}.lock")).exists());
        assert!(base.join(&running).join("copy").join("engine.db").exists());
        service.close_recovery_stores().await;
        drop(held);
    }

    /// Prepares an earlier store of `RECOVERY_LARGE_STORE_MB` megabytes, from
    /// a build 10 migrations behind, and prints how long it took and how much
    /// its copy folder held at its peak, sampled while it ran.
    #[tokio::test]
    #[ignore = "measures a large store; run by hand"]
    async fn a_large_earlier_store_prepares_within_its_deadline() {
        let megabytes: usize = std::env::var("RECOVERY_LARGE_STORE_MB")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(512);
        let (reference, store, sibling, copies) = (
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
            dohc_engine_testkit::ScratchDir::new().unwrap(),
        );
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        detached_store(&service, &ctx, reference.path()).await;
        host_identity(reference.path(), "epoch");
        older_copy_of(reference.path(), store.path(), 10);
        let daemon = service
            .configured_live_host
            .get()
            .unwrap()
            .copies
            .clone()
            .unwrap();
        // Samples every file under the daemon's copy folder until stopped.
        let sampling = Arc::new(AtomicBool::new(false));
        let sampler = std::thread::spawn({
            let (sampling, folder) = (sampling.clone(), daemon.daemon().to_path_buf());
            move || {
                fn size(path: &Path) -> u64 {
                    std::fs::read_dir(path).map_or(0, |entries| {
                        entries
                            .flatten()
                            .map(|entry| match entry.file_type() {
                                Ok(kind) if kind.is_dir() => size(&entry.path()),
                                _ => entry.metadata().map_or(0, |metadata| metadata.len()),
                            })
                            .sum()
                    })
                }
                let mut peak = 0;
                while !sampling.load(Ordering::Relaxed) {
                    peak = peak.max(size(&folder));
                    std::thread::sleep(Duration::from_millis(10));
                }
                peak
            }
        });
        {
            let conn = rusqlite::Connection::open(database(store.path())).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            let mut chunk = vec![0_u8; 1024 * 1024];
            for index in 0..megabytes {
                chunk[..8].copy_from_slice(&(index as u64).to_le_bytes());
                dohc_engine_storage::put_binary_blob(&tx, &chunk).unwrap();
            }
            tx.commit().unwrap();
        }
        let source_bytes = std::fs::metadata(database(store.path())).unwrap().len();
        let started = Instant::now();
        let opened = service
            .dispatch(ctx.clone(), recover(store.path(), "workspace", "epoch"))
            .await
            .unwrap()
            .response
            .result;
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspaceHandle"].clone()).unwrap();
        let attach_started = Instant::now();
        detached_store(&service, &ctx, sibling.path()).await;
        let attached_in = attach_started.elapsed();
        let preparing_after_attach = first_page(&service, ctx.clone(), &handle, "outbox")
            .await
            .is_ok_and(|page| page["kind"] == "preparing");
        prepared(&service, &handle).await;
        let prepared_in = started.elapsed();
        assert!(matches!(
            service.recovery_read(Some(&handle)),
            Some(Ok(RecoveryPage::Read(_)))
        ));
        sampling.store(true, Ordering::Relaxed);
        let peak = sampler.join().unwrap();
        println!(
            "recovery preparation: source {source_bytes} bytes, 10 migrations behind, prepared in \
             {prepared_in:?}, copy folder at most {peak} bytes; an unrelated attach and detach \
             took {attached_in:?} (still preparing after it: {preparing_after_attach})"
        );
        service
            .dispatch(ctx.clone(), close_request(&handle))
            .await
            .unwrap();
        assert!(prepared_in < daemon.deadline);
    }

    #[tokio::test]
    async fn a_closed_recovery_store_keeps_its_root_until_its_reads_end() {
        let store = dohc_engine_testkit::ScratchDir::new().unwrap();
        let copies = dohc_engine_testkit::ScratchDir::new().unwrap();
        let (service, owner, _ingress) =
            EngineService::configured_live_host(recovering(copies.path()))
                .await
                .unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        detached_store(&service, &ctx, store.path()).await;
        host_identity(store.path(), "epoch");
        let recovery = open_prepared(
            &service,
            ctx.clone(),
            recover(store.path(), "workspace", "epoch"),
        )
        .await
        .unwrap();
        // A read whose request was cancelled before its worker read the
        // store: the worker still holds the read's lease.
        let Some(Ok(RecoveryPage::Read(worker))) = service.recovery_read(Some(&recovery)) else {
            panic!("a prepared store reads");
        };
        let closing = service.dispatch(
            ctx.clone(),
            host_request(
                "liveApplication.closeRecoveryStore",
                Some(recovery.clone()),
                json!({}),
            ),
        );
        tokio::pin!(closing);
        tokio::select! {
            biased;
            _ = &mut closing => panic!("the close ended while a read held its lease"),
            () = std::future::ready(()) => {}
        }
        // Closing, the handle reads nothing, and the root neither opens nor attaches.
        assert!(service.recovery_read(Some(&recovery)).unwrap().is_err());
        assert_eq!(
            service
                .dispatch(ctx.clone(), recover(store.path(), "workspace", "epoch"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        let attach = || {
            host_request(
                "liveApplication.attachWorkspace",
                None,
                json!({"root": store.path(), "workspaceId": "workspace", "maxRegistrations": 4}),
            )
        };
        assert_eq!(
            service
                .configured_attach_workspace(&ctx, attach())
                .await
                .unwrap_err()
                .message,
            "live host workspace root is open for recovery"
        );
        // Once the worker ends, the close answers and the root attaches.
        drop(worker);
        assert_eq!(
            closing.await.unwrap().response.result,
            json!({"closed": true})
        );
        assert!(!service.is_recovery_handle(Some(&recovery)));
        let attached = service
            .configured_attach_workspace(&ctx, attach())
            .await
            .unwrap();
        service
            .configured_detach_workspace(
                &ctx,
                host_request(
                    "liveApplication.detachWorkspace",
                    Some(serde_json::from_value(attached["workspaceHandle"].clone()).unwrap()),
                    json!({}),
                ),
            )
            .await
            .unwrap();
        assert!(lock(&service.handles).is_empty());
    }
}
