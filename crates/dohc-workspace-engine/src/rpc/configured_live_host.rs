use crate::live_application_ingress::{
    LiveApplicationIngress, LiveApplicationIngressConfig, SettlementAdmission,
};
use crate::{EngineService, LiveApplicationHostConfig, lock};
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
    /// and its earlier store are open at once.
    recovery: Mutex<Vec<RecoveryStore>>,
}

/// One attached workspace, in attach order. An entry whose handle has no live
/// host is an attach that never finished; discovery omits it.
struct AttachedWorkspace {
    workspace_id: String,
    root: PathBuf,
    handle: WorkspaceHandle,
    ordinary: bool,
}

/// An earlier store of a workspace, open read-only. It has no workspace actor:
/// each page read opens the store read-only and closes it again.
struct RecoveryStore {
    workspace_id: String,
    root: PathBuf,
    handle: WorkspaceHandle,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryStoreParams {
    root: PathBuf,
    workspace_id: String,
}

/// Whether one root is the other or contains it.
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

/// Refuses a root that is not a store bound to it, or that holds versioned
/// state of another workspace, as a read-only workspace open does.
fn check_recovery_store(root: &Path, workspace_id: &str) -> Result<(), WireError> {
    use rusqlite::OptionalExtension;
    let unavailable = || invalid("recovery store unavailable");
    let token = crate::root_binding::read_root_binding(root)
        .map_err(|_| unavailable())?
        .ok_or_else(unavailable)?;
    let store = dohc_engine_storage::EngineStore::open_read_only(
        &root.join(".dohc").join("engine").join("engine.db"),
    )
    .map_err(|_| unavailable())?;
    let (bound, other) = store
        .read_with(|conn| {
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
            Ok::<_, rusqlite::Error>((bound, other))
        })
        .map_err(|_| unavailable())?;
    if bound.as_deref() != Some(token.as_str()) || other {
        return Err(invalid("recovery store belongs to another root or workspace"));
    }
    Ok(())
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
        mut config: ConfiguredLiveHostConfig,
    ) -> Result<(Arc<Self>, ConnectionOwner, LiveApplicationIngress), WireError> {
        let ingress_config = config.canonicalize_and_validate()?;
        let service = Arc::new(Self::new());
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
            recovery: Mutex::new(Vec::new()),
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
    /// workspace read-only, so its owner can copy the edits the host kept
    /// there. Nothing captures, relays, migrates, applies or settles in it,
    /// and its handle answers only `ydoc.ownerOutbox.readPending`. A workspace
    /// has at most one: opening its store again returns the same handle, and
    /// any other store of it is refused. So is a root that is attached or
    /// open for recovery, or that contains or sits inside one.
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
        if !params.root.is_absolute() {
            return Err(invalid("invalid recovery store"));
        }
        let root = std::fs::canonicalize(&params.root)
            .map_err(|_| invalid("recovery store unavailable"))?;
        if root.to_str().is_none() || !root.is_dir() {
            return Err(invalid("recovery store unavailable"));
        }
        let _membership = discovery.membership.lock().await;
        self.configured_host_caller(ctx)?;
        {
            let recovery = lock(&discovery.recovery);
            if let Some(entry) = recovery
                .iter()
                .find(|entry| entry.workspace_id == params.workspace_id)
            {
                // The same store again, as after an open whose reply was lost, keeps its handle.
                if entry.root == root {
                    return Ok(json!({"workspaceHandle": entry.handle}));
                }
                return Err(WireError::new(
                    ErrorCode::Conflict,
                    "a recovery store is already open for this workspace",
                ));
            }
            if recovery.iter().any(|entry| overlaps(&entry.root, &root))
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
        }
        let cancellation = super::request::OperationCancellation::new(ctx);
        let (checked_root, workspace_id) = (root.clone(), params.workspace_id.clone());
        let checking = tokio::task::spawn_blocking(move || {
            check_recovery_store(&checked_root, &workspace_id)
        });
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("liveApplication.openRecoveryStore"));
            }
            checked = checking => checked
                .map_err(|_| WireError::new(ErrorCode::Internal, "recovery store check failed"))??,
        }
        let sequence = self
            .next_handle
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let handle = WorkspaceHandle(format!("ws-{sequence:016x}"));
        lock(&discovery.recovery).push(RecoveryStore {
            workspace_id: params.workspace_id,
            root,
            handle: handle.clone(),
        });
        Ok(json!({"workspaceHandle": handle}))
    }

    /// `liveApplication.closeRecoveryStore`: end a recovery handle. A page
    /// read already running finishes on its own connection.
    pub(super) fn configured_close_recovery_store(
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
        let mut recovery = lock(&discovery.recovery);
        let open = recovery.len();
        recovery.retain(|entry| entry.handle != handle);
        if recovery.len() == open {
            return Err(super::error::workspace_unavailable());
        }
        Ok(json!({"closed": true}))
    }

    /// The workspace and engine database of the earlier store open for
    /// recovery under `handle`, if it is one.
    pub(super) fn recovery_store(
        &self,
        handle: Option<&WorkspaceHandle>,
    ) -> Option<(String, PathBuf)> {
        let handle = handle?;
        lock(&self.configured_live_host.get()?.recovery)
            .iter()
            .find(|entry| &entry.handle == handle)
            .map(|entry| {
                (
                    entry.workspace_id.clone(),
                    entry.root.join(".dohc").join("engine").join("engine.db"),
                )
            })
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
        if lock(&discovery.recovery)
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
            let db_path = opened.actor.database_path().to_path_buf();
            let workspace_id = workspace.workspace_id.clone();
            let limits = adoption.owner_outbox.clone();
            let mismatch = tokio::task::spawn_blocking(move || {
                let store = dohc_engine_storage::EngineStore::open_read_only(&db_path).map_err(|_|invalid("owner adoption budget read failed"))?;
                store.read_with(|conn|conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM live_owner_adoptions a JOIN ydoc_docs d
                     ON d.workspace_id=a.workspace_id AND d.version_id=a.main_version_id AND d.object_id=a.object_id
                     AND d.lineage_claim_id=a.lineage_claim_id WHERE a.workspace_id=?1 AND (a.max_pending_bytes>?2 OR a.max_pending_age_ms>?3))",
                    rusqlite::params![workspace_id,limits.max_pending_bytes,limits.max_pending_age_ms],|row|row.get::<_,bool>(0)))
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

    pub(super) fn configured_ordinary_namespace(
        &self,
        ctx: &RequestContext,
        request: &Request,
    ) -> Result<String, WireError> {
        if !self.configured_ordinary_request(ctx, request) {
            return Err(invalid("ordinary service connection unavailable"));
        }
        self.configured_live_host
            .get()
            .map(|host| host.namespace.clone())
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
        let (service, owner, _ingress) = EngineService::configured_live_host(config(&[]))
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
        let recover = |root: &Path, id: &str| {
            host_request(
                "liveApplication.openRecoveryStore",
                None,
                json!({"root": root, "workspaceId": id}),
            )
        };
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
            }
        }
        assert_eq!(outboxes[0], outboxes[1]);
        let outbox = outboxes[0].as_str();
        let recovery = handle_of(
            service
                .dispatch(ctx(), recover(earlier.path(), "workspace"))
                .await
                .unwrap()
                .response
                .result,
        );
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
        // A store of one workspace never opens as another's.
        assert_eq!(
            service
                .dispatch(ctx(), recover(earlier.path(), "other"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams
        );
        let again = handle_of(
            service
                .dispatch(ctx(), recover(earlier.path(), "workspace"))
                .await
                .unwrap()
                .response
                .result,
        );
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
}
