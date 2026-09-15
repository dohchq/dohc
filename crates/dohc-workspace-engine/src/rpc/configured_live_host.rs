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
use std::sync::Arc;
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
        if self.version != 1
            || self.relay_namespace.is_empty()
            || self.workspaces.is_empty()
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
            ApplicationOwner::new(workspace.workspace_id.clone())
                .map_err(|_| invalid("invalid live host workspace identity"))?;
            if !workspace.root.is_absolute() || workspace.max_registrations == 0 {
                return Err(invalid("invalid live host workspace configuration"));
            }
            workspace.root = std::fs::canonicalize(&workspace.root)
                .map_err(|_| invalid("live host workspace root unavailable"))?;
            if workspace.root.to_str().is_none() {
                return Err(invalid("live host workspace root must be UTF-8"));
            }
            if !workspace.root.is_dir()
                || !roots.insert(workspace.root.clone())
                || !identities.insert(workspace.workspace_id.clone())
            {
                return Err(invalid(
                    "live host workspace roots and identities must be unique",
                ));
            }
        }
        let workspaces: Vec<_> = self.workspaces.iter().map(|workspace|
            json!({"workspaceId": workspace.workspace_id, "workspaceHandle": "ws-ffffffffffffffff"})
        ).collect();
        validate_discovery(
            &discovery(&self.relay_namespace, &self.host, workspaces),
            MAX_WIRE_INTEGER,
            MIN_NEGOTIABLE_FRAME_BYTES,
        )?;
        self.ingress.validate()
    }
}

pub(crate) struct Discovery {
    connection: ConnectionHandle,
    ordinary_workspaces: HashSet<WorkspaceHandle>,
    sync: Option<(
        dohc_engine_collab::live_update_application::AppliedSyncPolicy,
        SettlementAdmission,
    )>,
    result: Value,
    settlement: Option<(usize, SettlementAdmission)>,
    restore: Option<crate::live_application_ingress::RestoreConfig>,
    adoption: Option<ConfiguredOwnerAdoption>,
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
                || !config
                    .workspaces
                    .iter()
                    .any(|workspace| workspace.relay.is_some())
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
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let mut workspaces = Vec::new();
        let mut ordinary_workspaces = HashSet::new();
        let result = async {
            for workspace in &config.workspaces {
                let opened = service.workspace_open(&ctx, json!({
                    "rootDir": workspace.root, "workspaceId": workspace.workspace_id, "captureMode": "none",
                    "relay": workspace.relay
                })).await?;
                let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone())
                    .map_err(|_| WireError::new(ErrorCode::Internal, "workspace open returned no handle"))?;
                if workspace.relay.is_some() {
                    service.versions_ensure_main(
                        &ctx,
                        Some(handle.clone()),
                        json!({"workspaceId": workspace.workspace_id}),
                    ).await?;
                    ordinary_workspaces.insert(handle.clone());
                }
                if let Some(adoption) = &config.adoption {
                    let opened = service.open(Some(&handle))?;
                    let db_path = opened.db_path.clone();
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
                    if mismatch { return Err(invalid("configured owner outbox budget is smaller than retained adoption")); }
                }
                service.provision_live_application(owner.handle(), LiveApplicationHostConfig {
                    workspace: handle.clone(), namespace: config.relay_namespace.clone(),
                    coordinate: config.host.coordinate(), max_registrations: workspace.max_registrations,
                }).await?;
                workspaces.push(json!({"workspaceId": workspace.workspace_id, "workspaceHandle": handle}));
            }
            let result = discovery(&config.relay_namespace, &config.host, workspaces);
            // The smallest supported negotiated frame must hold readiness.
            validate_discovery(&result, MAX_WIRE_INTEGER, MIN_NEGOTIABLE_FRAME_BYTES)?;
            Ok::<_, WireError>(result)
        }.await;
        match result {
            Ok(result) => {
                let _ = service.configured_live_host.set(Discovery {
                    connection: owner.handle(),
                    ordinary_workspaces,
                    result,
                    settlement,
                    sync,
                    restore: config.restore,
                    adoption: config.adoption,
                });
                Ok((service, owner, ingress))
            }
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
            .and_then(|host| host.result["relayNamespace"].as_str())
            .map(str::to_owned)
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
            || !workspace.is_some_and(|workspace| host.ordinary_workspaces.contains(workspace))
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
                    .is_some_and(|handle| host.ordinary_workspaces.contains(handle))
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
        validate_discovery(&discovery.result, request.id, ctx.max_frame_bytes)?;
        Ok(discovery.result.clone())
    }

    pub(super) fn configured_settlement_admission(
        &self,
        ctx: &RequestContext,
    ) -> Result<(usize, Arc<dyn Send + Sync>), WireError> {
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
            return Ok((host.settlement.0, host.settlement.1.reserve()?));
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
        Ok((*max, admission.reserve()?))
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

fn discovery(namespace: &str, host: &HostCoordinate, workspaces: Vec<Value>) -> Value {
    json!({"relayNamespace": namespace, "host": host, "workspaces": workspaces})
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
            "ingress":{"aggregateBytes":400_000_000,"applicationWorkingReserveBytes":1_000_000,"maxUploads":2,"uploadDeadlineMs":30_000}
        })).unwrap()
    }

    async fn close(service: &EngineService) {
        let handles: Vec<_> = lock(&service.handles).keys().cloned().collect();
        for handle in handles {
            service.workspace_close(Some(handle)).await.unwrap();
        }
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
        let handle: WorkspaceHandle = serde_json::from_value(
            service.configured_live_host.get().unwrap().result["workspaces"][0]["workspaceHandle"]
                .clone(),
        )
        .unwrap();
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
            let discovery = service.configured_live_host.get().unwrap();
            let handle: WorkspaceHandle = serde_json::from_value(
                discovery.result["workspaces"][0]["workspaceHandle"].clone(),
            )
            .unwrap();
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
        let discovery = service.configured_live_host.get().unwrap();
        let attached: WorkspaceHandle =
            serde_json::from_value(discovery.result["workspaces"][0]["workspaceHandle"].clone())
                .unwrap();
        let private: WorkspaceHandle =
            serde_json::from_value(discovery.result["workspaces"][1]["workspaceHandle"].clone())
                .unwrap();
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
}
